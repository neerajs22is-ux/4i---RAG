// query-chunks — Phase 3B.1 production hybrid retrieval vertical slice.
//
// query → server-side Voyage voyage-4 query embedding (input_type "query")
// → match_chunks RPC (tenant-filtered dense + FTS candidates, one round trip)
// → deterministic fusion (RRF default) → bounded evidence with provenance.
//
// Recall-first: no relevance threshold inside retrieval; the generation gate
// owns the cut. No reranker, no LLM, no planner. Metadata-only logs; never
// keys, content, or vectors.
//
// UNCALIBRATED starting constants (flagged): candidate counts, fusion
// default, and final evidence size await the gold-corpus calibration task.
// Nothing here inherits old MiniLM-era retrieval values.

import { createClient } from "jsr:@supabase/supabase-js@2";

const VOYAGE_MODEL = "voyage-4";
const VOYAGE_DIMENSIONS = 1024;
const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

// UNCALIBRATED — lock in the calibration task. Structural starting points
// only (candidate depth + fusion shape), never tuned values.
const DENSE_N_DEFAULT = 20;
const LEX_N_DEFAULT = 20;
const CANDIDATE_CAP = 50;
const FINAL_K_DEFAULT = 8;
const FINAL_K_CAP = 20;
const FUSION_DEFAULT = "rrf";
const RRF_K = 60;
const BLEND_DENSE_WEIGHT = 0.5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Candidate = {
  chunk_id: string; document_id: string; tenant_id: string;
  file_name: string; page: number; content: string;
  dense_score: number | null; dense_rank: number | null;
  lex_score: number | null; lex_rank: number | null;
  channel: string;
};

function numOrNull(v: unknown): number | null {
  // PostgREST numeric serialization varies (number vs numeric string) across
  // types/versions; coerce once at the boundary so fusion math and the
  // provenance payload are always real numbers or null.
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

type NormRow = {
  chunk_id: string; document_id: string; tenant_id: string;
  file_name: string; page: number; content: string;
  dense_score: number | null; dense_rank: number | null;
  lex_score: number | null; lex_rank: number | null;
};

function normalizeRow(r: Candidate): NormRow {
  return {
    chunk_id: r.chunk_id, document_id: r.document_id, tenant_id: r.tenant_id,
    file_name: r.file_name, page: r.page, content: r.content,
    dense_score: numOrNull(r.dense_score), dense_rank: numOrNull(r.dense_rank),
    lex_score: numOrNull(r.lex_score), lex_rank: numOrNull(r.lex_rank),
  };
}

function mergeInto(
  byId: Map<string, { row: NormRow; fused: number }>,
  r: NormRow,
  add: number,
): void {
  let e = byId.get(r.chunk_id);
  if (!e) {
    e = {
      row: {
        chunk_id: r.chunk_id, document_id: r.document_id, tenant_id: r.tenant_id,
        file_name: r.file_name, page: r.page, content: r.content,
        dense_score: null, dense_rank: null, lex_score: null, lex_rank: null,
      },
      fused: 0,
    };
    byId.set(r.chunk_id, e);
  }
  // A chunk appearing in both channels keeps BOTH channel signals, so the
  // provenance payload is complete regardless of arrival order.
  if (r.dense_rank != null) { e.row.dense_score = r.dense_score; e.row.dense_rank = r.dense_rank; }
  if (r.lex_rank != null) { e.row.lex_score = r.lex_score; e.row.lex_rank = r.lex_rank; }
  e.fused += add;
}

function rrfFuse(rows: Candidate[]): Map<string, { row: NormRow; fused: number }> {
  const byId = new Map<string, { row: NormRow; fused: number }>();
  for (const raw of rows) {
    const r = normalizeRow(raw);
    if (r.dense_rank != null) mergeInto(byId, r, 1 / (RRF_K + r.dense_rank));
    if (r.lex_rank != null) mergeInto(byId, r, 1 / (RRF_K + r.lex_rank));
  }
  return byId;
}

function blendFuse(rows: Candidate[], w: number): Map<string, { row: NormRow; fused: number }> {
  const dense = new Map<string, number>();
  const lex = new Map<string, number>();
  const first = new Map<string, NormRow>();
  for (const raw of rows) {
    const r = normalizeRow(raw);
    if (!first.has(r.chunk_id)) {
      first.set(r.chunk_id, {
        chunk_id: r.chunk_id, document_id: r.document_id, tenant_id: r.tenant_id,
        file_name: r.file_name, page: r.page, content: r.content,
        dense_score: null, dense_rank: null, lex_score: null, lex_rank: null,
      });
    }
    const kept = first.get(r.chunk_id)!;
    if (r.dense_rank != null) {
      dense.set(r.chunk_id, r.dense_score ?? 0);
      kept.dense_score = r.dense_score;
      kept.dense_rank = r.dense_rank;
    }
    if (r.lex_rank != null) {
      lex.set(r.chunk_id, r.lex_score ?? 0);
      kept.lex_score = r.lex_score;
      kept.lex_rank = r.lex_rank;
    }
  }
  const norm = (m: Map<string, number>): Map<string, number> => {
    const out = new Map<string, number>();
    if (!m.size) return out;
    const vals = [...m.values()];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    if (hi <= lo) {
      for (const k of m.keys()) out.set(k, 1.0);
      return out;
    }
    for (const [k, v] of m) out.set(k, (v - lo) / (hi - lo));
    return out;
  };
  const dn = norm(dense);
  const ln = norm(lex);
  const byId = new Map<string, { row: Candidate; fused: number }>();
  for (const [id, row] of first) {
    byId.set(id, {
      row,
      fused: w * (dn.get(id) ?? 0) + (1 - w) * (ln.get(id) ?? 0),
    });
  }
  return byId;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const t0 = performance.now();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { ok: false, error: "missing bearer token" });
  const db = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );
  const { data: udata, error: uerr } = await db.auth.getUser(jwt);
  if (uerr || !udata?.user) return json(401, { ok: false, error: "invalid token" });
  const caller = udata.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  const tenantId = String(body.tenant_id ?? "");
  const query = String(body.query ?? "").trim();
  if (!UUID_RE.test(tenantId)) return json(400, { ok: false, error: "invalid tenant_id" });
  if (!query || query.length > 1000) return json(400, { ok: false, error: "invalid query" });
  const denseN = Math.min(CANDIDATE_CAP, Math.max(1, Number(body.dense_n ?? DENSE_N_DEFAULT) || DENSE_N_DEFAULT));
  const lexN = Math.min(CANDIDATE_CAP, Math.max(1, Number(body.lex_n ?? LEX_N_DEFAULT) || LEX_N_DEFAULT));
  const finalK = Math.min(FINAL_K_CAP, Math.max(1, Number(body.final_k ?? FINAL_K_DEFAULT) || FINAL_K_DEFAULT));
  const fusion = String(body.fusion ?? FUSION_DEFAULT).toLowerCase();
  if (fusion !== "rrf" && fusion !== "weighted") {
    return json(400, { ok: false, error: "fusion must be rrf|weighted" });
  }

  const { data: mem } = await db.from("memberships")
    .select("tenant_id").eq("tenant_id", tenantId).eq("user_id", caller).limit(1);
  if (!mem || mem.length === 0) return json(403, { ok: false, error: "not a member of this tenant" });

  const apiKey = Deno.env.get("VOYAGE_API_KEY") ?? "";
  if (!apiKey) return json(500, { ok: false, error: "VOYAGE_API_KEY not configured" });

  // 1. Server-side query embedding (input_type "query" per contract).
  const tE0 = performance.now();
  let qvec: number[];
  let queryTokens = 0;
  try {
    const r = await fetch(VOYAGE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: [query],
        model: VOYAGE_MODEL,
        input_type: "query",
        output_dimension: VOYAGE_DIMENSIONS,
      }),
    });
    if (!r.ok) return json(502, { ok: false, error: `query embed status ${r.status}` });
    const parsed = await r.json() as {
      data?: Array<{ embedding?: number[] }>; model?: string; usage?: { total_tokens?: number };
    };
    if (parsed.model !== VOYAGE_MODEL) {
      return json(502, { ok: false, error: "query embed model mismatch" });
    }
    qvec = parsed.data?.[0]?.embedding ?? [];
    if (qvec.length !== VOYAGE_DIMENSIONS || !qvec.every((v) => Number.isFinite(v))) {
      return json(502, { ok: false, error: "invalid query vector" });
    }
    queryTokens = parsed.usage?.total_tokens ?? 0;
  } catch (e) {
    return json(502, { ok: false, error: `query embed failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
  }
  const embedMs = Math.round(performance.now() - tE0);

  // 2. One RPC round trip for both candidate channels (RLS applies to caller).
  const tR0 = performance.now();
  const vecLiteral = `[${qvec.join(",")}]`;
  const { data: rows, error: rpcErr } = await db.rpc("match_chunks", {
    p_tenant_id: tenantId,
    p_query_vector: vecLiteral,
    p_query_text: query,
    p_dense_n: denseN,
    p_lex_n: lexN,
  });
  if (rpcErr) return json(500, { ok: false, error: rpcErr.message });
  const retrievalMs = Math.round(performance.now() - tR0);
  const cands = (rows ?? []) as Candidate[];

  // 3. Deterministic fusion in Edge; tie-break chunk_id for stable order.
  const fused = fusion === "rrf" ? rrfFuse(cands) : blendFuse(cands, BLEND_DENSE_WEIGHT);
  const ranked = [...fused.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (b.fused - a.fused) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, finalK);
  const denseCount = cands.filter((c) => c.channel === "dense").length;
  const lexCount = cands.filter((c) => c.channel === "lexical").length;

  const evidence = ranked.map((e, i) => ({
    fused_rank: i + 1,
    fused_score: e.fused,
    chunk_id: e.row.chunk_id,
    document_id: e.row.document_id,
    tenant_id: e.row.tenant_id,
    file_name: e.row.file_name,
    page: e.row.page,
    content: e.row.content,
    dense_score: e.row.dense_score,
    dense_rank: e.row.dense_rank,
    lex_score: e.row.lex_score,
    lex_rank: e.row.lex_rank,
  }));
  const totalMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify({
    fn: "query-chunks", caller, tenant_id: tenantId, fusion,
    dense_candidates: denseCount, lex_candidates: lexCount,
    evidence: evidence.length, query_tokens: queryTokens, total_ms: totalMs,
  }));
  return json(200, {
    ok: true,
    model: VOYAGE_MODEL,
    fusion,
    query_tokens: queryTokens,
    candidates: { dense: denseCount, lexical: lexCount },
    evidence,
    timings: { embed_ms: embedMs, retrieval_ms: retrievalMs, total_ms: totalMs },
  });
});
