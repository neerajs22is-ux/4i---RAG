// query-chunks — Phase 3B.1 production hybrid retrieval vertical slice.
//
// query → server-side Jina v5-text-small query embedding (task
// "retrieval.query") → match_chunks RPC (tenant-filtered dense + FTS
// candidates, one round trip) → deterministic fusion (RRF default) →
// second-stage rerank over the fused candidate pool → bounded evidence with
// provenance.
//
// Recall-first: no relevance threshold inside retrieval; the generation gate
// owns the cut. No LLM, no planner. Metadata-only logs; never
// keys, content, or vectors.
//
// UNCALIBRATED starting constants (flagged): candidate counts, fusion
// default, and final evidence size await the gold-corpus calibration task.
// Nothing here inherits old MiniLM-era retrieval values.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, corsPreflight } from "../_shared/cors.ts";
import { callReranker, mapRerankedPool, parseRerankResponse, RERANK_API_KEY_ENV } from "../_shared/rerank.ts";
import { planRerank, resolveRankedOrder } from "../_shared/rerank-policy.ts";
import { unionDocIds } from "../_shared/temp-scope.ts";
import { embeddingTelemetry, rerankTelemetry } from "../_shared/usage-telemetry.ts";

const JINA_MODEL = "jina-embeddings-v5-text-small";
const JINA_DIMENSIONS = 1024;
const JINA_TASK_QUERY = "retrieval.query";
const JINA_ENDPOINT = "https://api.jina.ai/v1/embeddings";

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
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders(req) },
    });
  const preflight = corsPreflight(req);
  if (preflight) return preflight;
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

  // B2 — resolve the allowed document set SERVER-SIDE. The caller may name a
  // notebook (resolved here) or an explicit document list (validated here);
  // omitting both keeps the previous unscoped behaviour.
  //
  // Temporary chat files resolve through the conversation: ready + unexpired
  // documents bound to it, same tenant. Retrieval-time expiry filtering is the
  // access boundary for temporary data — cleanup is hygiene only.
  const notebookId = body.notebook_id != null ? String(body.notebook_id) : null;
  if (notebookId !== null && !UUID_RE.test(notebookId)) {
    return json(400, { ok: false, error: "invalid notebook_id" });
  }
  const conversationId = body.conversation_id != null ? String(body.conversation_id) : null;
  if (conversationId !== null && !UUID_RE.test(conversationId)) {
    return json(400, { ok: false, error: "invalid conversation_id" });
  }
  let requestedDocIds: string[] | null = null;
  if (body.document_ids != null) {
    const raw = body.document_ids;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200 ||
        !raw.every((x) => typeof x === "string" && UUID_RE.test(x))) {
      return json(400, { ok: false, error: "invalid document_ids" });
    }
    requestedDocIds = raw as string[];
  }
  if (notebookId && requestedDocIds) {
    return json(400, { ok: false, error: "provide notebook_id or document_ids, not both" });
  }
  if (conversationId) {
    const { data: conv } = await db.from("conversations")
      .select("id").eq("id", conversationId).eq("tenant_id", tenantId).limit(1);
    if (!conv || conv.length === 0) return json(404, { ok: false, error: "conversation not found" });
  }

  let allowedDocIds: string[] | null = null; // null = unscoped (legacy behaviour)
  let scopeEmpty = false;
  if (notebookId) {
    const { data: nb } = await db.from("notebooks")
      .select("id").eq("id", notebookId).eq("tenant_id", tenantId).limit(1);
    if (!nb || nb.length === 0) return json(404, { ok: false, error: "notebook not found" });
    const { data: srcRows, error: srcErr } = await db.from("notebook_sources")
      .select("document_id")
      .eq("notebook_id", notebookId).eq("tenant_id", tenantId).eq("selected", true);
    if (srcErr) return json(500, { ok: false, error: srcErr.message });
    const candidates = [...new Set((srcRows ?? []).map((r: { document_id: string }) => r.document_id))];
    if (candidates.length > 0) {
      const { data: live, error: liveErr } = await db.from("documents")
        .select("id").eq("tenant_id", tenantId).in("id", candidates).is("archived_at", null);
      if (liveErr) return json(500, { ok: false, error: liveErr.message });
      allowedDocIds = (live ?? []).map((r: { id: string }) => r.id);
    }
    scopeEmpty = !allowedDocIds || allowedDocIds.length === 0;
  } else if (requestedDocIds) {
    // Direct document lists are validated, never trusted: same tenant,
    // non-archived, and — closing the expired-temporary replay path — not
    // expired. An expired temporary document fails closed here even if its
    // row and object still exist and cleanup has not run. Expiry is filtered
    // in code (not in the query) so the check cannot silently mis-parse.
    const nowIso = new Date().toISOString();
    const { data: owned, error: ownErr } = await db.from("documents")
      .select("id, expires_at").eq("tenant_id", tenantId).in("id", requestedDocIds).is("archived_at", null);
    if (ownErr) return json(500, { ok: false, error: ownErr.message });
    const ownedIds = new Set(
      ((owned ?? []) as Array<{ id: string; expires_at: string | null }>)
        .filter((r) => r.expires_at === null || r.expires_at > nowIso)
        .map((r) => r.id),
    );
    if (requestedDocIds.some((id) => !ownedIds.has(id))) {
      return json(400, { ok: false, error: "document_ids must belong to this tenant, not be archived, and not be expired" });
    }
    allowedDocIds = requestedDocIds;
  }

  // Temporary conversation scope, resolved server-side from the validated
  // conversation id. Ready + unexpired only; persistent rows (NULL
  // conversation_id) can never match. Unions with any persistent scope above;
  // with no other scope it becomes the allowed set (cases B/E); with neither
  // it stays null and behaviour below is byte-identical to unscoped (case D).
  let tempDocIds: string[] = [];
  if (conversationId) {
    const nowIso = new Date().toISOString();
    const { data: tempRows, error: tempErr } = await db.from("documents")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("conversation_id", conversationId)
      .eq("status", "ready")
      .is("archived_at", null)
      .gt("expires_at", nowIso);
    if (tempErr) return json(500, { ok: false, error: tempErr.message });
    tempDocIds = [...new Set((tempRows ?? []).map((r: { id: string }) => r.id))];
  }
  if (allowedDocIds !== null) {
    allowedDocIds = unionDocIds(allowedDocIds, tempDocIds);
  } else if (tempDocIds.length > 0) {
    allowedDocIds = tempDocIds;
  }

  if (allowedDocIds === null) {
    // Unscoped retrieval must never surface another conversation's temporary
    // chunks (cross-conversation isolation): when temporary rows exist for
    // this tenant, resolve the persistent set explicitly instead of the
    // legacy NULL path. With no temporary rows the NULL path — and its exact
    // behaviour — is preserved. The explicit list covers every persistent
    // document (any status, including archived: the legacy path never filtered
    // those), so results are identical except for the excluded temporaries.
    const { data: tempProbe, error: tempProbeErr } = await db.from("documents")
      .select("id").eq("tenant_id", tenantId).not("expires_at", "is", null).limit(1);
    if (tempProbeErr) return json(500, { ok: false, error: tempProbeErr.message });
    if (tempProbe && tempProbe.length > 0) {
      const { data: persistent, error: persistentErr } = await db.from("documents")
        .select("id").eq("tenant_id", tenantId).is("expires_at", null);
      if (persistentErr) return json(500, { ok: false, error: persistentErr.message });
      allowedDocIds = ((persistent ?? []) as Array<{ id: string }>).map((r) => r.id);
    }
  }

  // Empty scope: deterministic empty result, no provider call, no query embed.
  if (scopeEmpty && tempDocIds.length === 0) {
    const totalMs = Math.round(performance.now() - t0);
    console.log(JSON.stringify({
      fn: "query-chunks", caller, tenant_id: tenantId, scope: "notebook",
      notebook_id: notebookId, allowed_documents: 0, evidence: 0, total_ms: totalMs,
    }));
    return json(200, {
      ok: true, model: JINA_MODEL, fusion: String(body.fusion ?? FUSION_DEFAULT).toLowerCase(),
      query_tokens: 0, candidates: { dense: 0, lexical: 0 }, evidence: [],
      reranked: false,
      // No candidates existed because no scope resolved; no provider call was
      // reachable. Recorded as calculated zeros for a consistent shape.
      rerank: { fused_candidates: 0, ...rerankTelemetry({
        attempted: false, skipped: true, skipReason: "scope-empty",
        inputChars: 0, providerTokens: null, latencyMs: 0,
      }) },
      embedding: embeddingTelemetry({ calls: 0, inputChars: 0, providerTokens: null, latencyMs: 0 }),
      scope: { notebook_id: notebookId, document_count: 0, reason: "no-selected-sources" },
      timings: { embed_ms: 0, retrieval_ms: 0, rerank_ms: 0, total_ms: totalMs },
    });
  }

  const apiKey = Deno.env.get("JINA_API_KEY") ?? "";
  if (!apiKey) return json(500, { ok: false, error: "JINA_API_KEY not configured" });

  // 1. Server-side query embedding (task "retrieval.query" per contract).
  const tE0 = performance.now();
  let qvec: number[];
  let queryTokens = 0;
  try {
    const r = await fetch(JINA_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: [query],
        model: JINA_MODEL,
        task: JINA_TASK_QUERY,
        dimensions: JINA_DIMENSIONS,
        normalized: true,
        embedding_type: "float",
      }),
    });
    if (!r.ok) return json(502, { ok: false, error: `query embed status ${r.status}` });
    const parsed = await r.json() as {
      data?: Array<{ embedding?: number[]; index?: unknown }>; model?: unknown; usage?: { total_tokens?: number };
    };
    const responseModel = (parsed as { model?: unknown } | null)?.model;
    if (responseModel !== undefined && responseModel !== JINA_MODEL) {
      return json(502, { ok: false, error: "query embed model mismatch" });
    }
    const first = (parsed?.data ?? [])[0]?.embedding ?? [];
    qvec = first;
    if (qvec.length !== JINA_DIMENSIONS || !qvec.every((v) => Number.isFinite(v))) {
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
    p_document_ids: allowedDocIds,
  });
  if (rpcErr) return json(500, { ok: false, error: rpcErr.message });
  const retrievalMs = Math.round(performance.now() - tR0);
  const cands = (rows ?? []) as Candidate[];

  // 3. Deterministic fusion in Edge; tie-break chunk_id for stable order.
  // The full fused pool (not just the final cut) feeds the reranker below.
  const fused = fusion === "rrf" ? rrfFuse(cands) : blendFuse(cands, BLEND_DENSE_WEIGHT);
  const pool = [...fused.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (b.fused - a.fused) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e, i) => ({ ...e, rrfRank: i + 1 }));
  const denseCount = cands.filter((c) => c.channel === "dense").length;
  const lexCount = cands.filter((c) => c.channel === "lexical").length;

  // 4. Second-stage rerank over the fused candidate pool. H2A guard: when the
  // pool already fits inside finalK there is nothing to cut down, so the
  // provider call is skipped entirely and the fused order is preserved
  // (rerank-policy). A reranker failure still degrades to fused order instead
  // of failing retrieval, so a reranker outage never takes down question
  // answering. FINAL_K and the fusion shape are unchanged.
  const tRr0 = performance.now();
  const rerankPlan = planRerank(pool.length, finalK);
  let ordered = pool;
  let reranked = false;
  const rerankAttempted = rerankPlan.kind === "run";
  const rerankSkipped = rerankPlan.kind === "skip";
  const rerankSkipReason = rerankPlan.kind === "skip" ? rerankPlan.reason : null;
  let rerankProviderTokens: number | null = null;
  let rerankInputChars = 0;
  if (rerankPlan.kind === "run") {
    const rerankDocuments = pool.map((e) => e.row.content);
    rerankInputChars = rerankDocuments.reduce((sum, text) => sum + text.length, 0);
    const rerankCall = await callReranker({
      apiKey,
      query,
      documents: rerankDocuments,
      topN: Math.min(finalK, pool.length),
      maxCandidates: CANDIDATE_CAP,
    });
    if (rerankCall.ok) {
      const parsed = parseRerankResponse(rerankCall.payload, pool.length, Math.min(finalK, pool.length));
      if (parsed.ok) {
        rerankProviderTokens = parsed.usageTokens;
        const mapped = mapRerankedPool(pool, parsed.ranked);
        const resolved = resolveRankedOrder(pool, mapped);
        ordered = resolved.ordered;
        reranked = resolved.reranked;
      } else {
        console.log(JSON.stringify({ fn: "query-chunks", path: "rerank-invalid", error: parsed.error }));
      }
    } else {
      console.log(JSON.stringify({
        fn: "query-chunks", path: "rerank-failed", kind: rerankCall.kind, status: rerankCall.status,
      }));
    }
  }
  const rerankMs = Math.round(performance.now() - tRr0);
  const ranked = ordered.slice(0, finalK);

  const evidence = ranked.map((e) => ({
    fused_rank: e.rrfRank,
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
    scope: notebookId ? "notebook" : allowedDocIds ? "documents" : "unscoped",
    allowed_documents: allowedDocIds ? allowedDocIds.length : null,
    dense_candidates: denseCount, lex_candidates: lexCount,
    fused_candidates: pool.length,
    rerank_attempted: rerankAttempted, rerank_skipped: rerankSkipped,
    rerank_skip_reason: rerankSkipReason,
    evidence: evidence.length, query_tokens: queryTokens, reranked, total_ms: totalMs,
  }));
  return json(200, {
    ok: true,
    model: JINA_MODEL,
    fusion,
    query_tokens: queryTokens,
    candidates: { dense: denseCount, lexical: lexCount },
    evidence,
    reranked,
    // H2A decision + H2B accounting: the deterministic rerank decision and
    // its cost together (tokens measured when Jina returns usage, otherwise a
    // clearly labeled chars/4 estimate; a skipped call is a calculated zero).
    rerank: {
      fused_candidates: pool.length,
      ...rerankTelemetry({
        attempted: rerankAttempted,
        skipped: rerankSkipped,
        skipReason: rerankSkipReason,
        inputChars: rerankInputChars,
        providerTokens: rerankProviderTokens,
        latencyMs: rerankMs,
      }),
    },
    // H2B accounting: the single query-embedding call.
    embedding: embeddingTelemetry({
      calls: 1,
      inputChars: query.length,
      providerTokens: queryTokens > 0 ? queryTokens : null,
      latencyMs: embedMs,
    }),
    scope: notebookId
      ? { notebook_id: notebookId, document_count: allowedDocIds?.length ?? 0 }
      : { notebook_id: null, document_count: allowedDocIds ? allowedDocIds.length : null },
    timings: { embed_ms: embedMs, retrieval_ms: retrievalMs, rerank_ms: rerankMs, total_ms: totalMs },
  });
});
