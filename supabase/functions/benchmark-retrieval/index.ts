// benchmark-retrieval — benchmark-only Jina retrieval mirror.
//
// Benchmark-only Edge Function (NOT deployed in Step 3). This is the isolated
// counterpart of /query-chunks for the Jina benchmark experiment:
//
//   Jina query embedding (retrieval.query)
//     -> benchmark_match_chunks (Jina dense partition + same lexical branch)
//     -> locked fusion (RRF-60 only) -> candidate pool
//     -> Step 2 no-rerank OR jina-reranker-v3.5 -> top 8 evidence
//
// It never reads production vectors, never calls the production match_chunks
// RPC, never imports /ask or /query-chunks, and never calls Voyage. Scope
// resolution mirrors query-chunks exactly (membership, notebook sources,
// validated direct lists, conversation temporaries, unscoped persistent
// exclusion). Fusion is locked to RRF — the production default — so the
// experiment has no fusion variable.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, corsPreflight } from "../_shared/cors.ts";
import {
  BENCHMARK_JINA_EMBED_API_KEY_ENV,
  BENCHMARK_JINA_EMBED_MODEL,
  BENCHMARK_JINA_TASK_QUERY,
  callBenchmarkJinaEmbed,
  parseBenchmarkJinaEmbedResponse,
} from "../_shared/benchmark-jina-embed.ts";
import {
  BENCHMARK_CANDIDATE_CAP,
  BENCHMARK_DENSE_N,
  BENCHMARK_LEX_N,
  applyBenchmarkRetrievalMode,
  benchmarkRankFused,
  benchmarkRrfFuse,
  resolveBenchmarkScope,
  toBenchmarkRerankPool,
  type BenchmarkRetrievalRow,
} from "../_shared/benchmark-retrieval.ts";
import {
  BENCHMARK_FINAL_K,
  BENCHMARK_RERANK_API_KEY_ENV,
  callBenchmarkRerank,
  parseBenchmarkRerankResponse,
  type BenchmarkRerankRunner,
} from "../_shared/benchmark-rerank.ts";

const BENCHMARK_PROVIDER = "jina";
const BENCHMARK_RERANK_NONE = "none";
const BENCHMARK_RERANK_JINA = "jina-reranker-v3.5";
const BENCHMARK_RRF_K = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BenchmarkRerankMode = typeof BENCHMARK_RERANK_NONE | typeof BENCHMARK_RERANK_JINA | "both";

// deno-lint-ignore no-explicit-any
type Db = any;

export async function buildBenchmarkEvidence(input: {
  db: Db;
  tenantId: string;
  query: string;
  notebookId: string | null;
  conversationId: string | null;
  requestedDocIds: string[] | null;
  denseN: number;
  lexN: number;
  finalK: number;
  provider: string;
  model: string;
  benchmarkRunId: string;
  rerank: BenchmarkRerankMode;
  embedApiKey: string;
  rerankApiKey: string;
  nowIso: string;
}): Promise<
  | {
    ok: true;
    evidence: Array<BenchmarkRetrievalRow & { fused_rank: number; fused_score: number; rerank_score: number | null }>;
    citations: Array<{ n: number; chunk_id: string; document_id: string; file_name: string; page: number | null }>;
    evidenceReranked: Array<BenchmarkRetrievalRow & { fused_rank: number; fused_score: number; rerank_score: number | null }> | null;
    citationsReranked: Array<{ n: number; chunk_id: string; document_id: string; file_name: string; page: number | null }> | null;
    denseCount: number;
    lexicalCount: number;
    queryTokens: number | null;
    usageTokens: number | null;
    embedMs: number;
    retrievalMs: number;
    fusionMs: number;
    rerankMs: number;
  }
  | { ok: false; error: string; status: number }
> {
  const { db } = input;

  // Scope resolution mirrors query-chunks: notebook sources (selected + live),
  // validated direct lists (same tenant, non-archived, unexpired), and the
  // conversation temporary union. Emptiness is decided by the shared resolver.
  let notebookDocIds: string[] | null = null;
  if (input.notebookId) {
    const { data: nb } = await db.from("notebooks")
      .select("id").eq("id", input.notebookId).eq("tenant_id", input.tenantId).limit(1);
    if (!nb || nb.length === 0) return { ok: false, error: "notebook not found", status: 404 };
    const { data: srcRows, error: srcErr } = await db.from("notebook_sources")
      .select("document_id")
      .eq("notebook_id", input.notebookId).eq("tenant_id", input.tenantId).eq("selected", true);
    if (srcErr) return { ok: false, error: srcErr.message, status: 500 };
    const candidates = [...new Set(((srcRows ?? []) as Array<{ document_id: string }>).map((r) => r.document_id))];
    if (candidates.length > 0) {
      const { data: live, error: liveErr } = await db.from("documents")
        .select("id").eq("tenant_id", input.tenantId).in("id", candidates).is("archived_at", null);
      if (liveErr) return { ok: false, error: liveErr.message, status: 500 };
      notebookDocIds = ((live ?? []) as Array<{ id: string }>).map((r) => r.id);
    }
  }

  let validatedDocIds: string[] | null = null;
  if (input.requestedDocIds) {
    const { data: owned, error: ownErr } = await db.from("documents")
      .select("id, expires_at").eq("tenant_id", input.tenantId).in("id", input.requestedDocIds).is("archived_at", null);
    if (ownErr) return { ok: false, error: ownErr.message, status: 500 };
    const ownedIds = new Set(
      ((owned ?? []) as Array<{ id: string; expires_at: string | null }>)
        .filter((r) => r.expires_at === null || r.expires_at > input.nowIso)
        .map((r) => r.id),
    );
    if (input.requestedDocIds.some((id) => !ownedIds.has(id))) {
      return { ok: false, error: "document_ids must belong to this tenant, not be archived, and not be expired", status: 400 };
    }
    validatedDocIds = input.requestedDocIds;
  }

  let tempDocIds: string[] = [];
  if (input.conversationId) {
    const { data: conv } = await db.from("conversations")
      .select("id").eq("id", input.conversationId).eq("tenant_id", input.tenantId).limit(1);
    if (!conv || conv.length === 0) return { ok: false, error: "conversation not found", status: 404 };
    const { data: tempRows, error: tempErr } = await db.from("documents")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .eq("conversation_id", input.conversationId)
      .eq("status", "ready")
      .is("archived_at", null)
      .gt("expires_at", input.nowIso);
    if (tempErr) return { ok: false, error: tempErr.message, status: 500 };
    tempDocIds = [...new Set(((tempRows ?? []) as Array<{ id: string }>).map((r) => r.id))];
  }

  let unscopedPersistentIds: string[] | null = null;
  if (notebookDocIds === null && validatedDocIds === null && tempDocIds.length === 0) {
    const { data: tempProbe, error: tempProbeErr } = await db.from("documents")
      .select("id").eq("tenant_id", input.tenantId).not("expires_at", "is", null).limit(1);
    if (tempProbeErr) return { ok: false, error: tempProbeErr.message, status: 500 };
    if (tempProbe && tempProbe.length > 0) {
      const { data: persistent, error: persistentErr } = await db.from("documents")
        .select("id").eq("tenant_id", input.tenantId).is("expires_at", null);
      if (persistentErr) return { ok: false, error: persistentErr.message, status: 500 };
      unscopedPersistentIds = ((persistent ?? []) as Array<{ id: string }>).map((r) => r.id);
    }
  }

  const scope = resolveBenchmarkScope({
    notebookRequested: input.notebookId !== null,
    notebookDocIds,
    tempDocIds,
    unscopedPersistentIds,
    validatedDocIds,
  });
  const allowedDocIds = scope.allowedDocIds;

  if (scope.scopeEmpty && scope.tempDocIds.length === 0) {
    return {
      ok: true, evidence: [], citations: [], denseCount: 0, lexicalCount: 0,
      queryTokens: 0, usageTokens: null, embedMs: 0, retrievalMs: 0, fusionMs: 0, rerankMs: 0,
    };
  }

  // 1. Benchmark query embedding (Jina retrieval.query). No Voyage fallback.
  const tE0 = performance.now();
  const embedCall = await callBenchmarkJinaEmbed({
    apiKey: input.embedApiKey,
    task: BENCHMARK_JINA_TASK_QUERY,
    inputs: [input.query],
  });
  const embedMs = Math.round(performance.now() - tE0);
  if (!embedCall.ok) {
    const status = embedCall.kind === "rate_limited" ? 429
      : embedCall.status ?? 502;
    return { ok: false, error: `benchmark query embed failed: ${embedCall.detail}`, status };
  }
  const parsedQuery = parseBenchmarkJinaEmbedResponse(embedCall.payload, 1);
  if (!parsedQuery.ok) {
    return { ok: false, error: `benchmark query embed invalid: ${parsedQuery.error}`, status: 502 };
  }
  const qvec = parsedQuery.parsed.vectors[0];
  const queryTokens = parsedQuery.parsed.tokens;

  // 2. Benchmark mirror RPC — never the production match_chunks.
  const tR0 = performance.now();
  const vecLiteral = `[${qvec.join(",")}]`;
  const { data: rows, error: rpcErr } = await db.rpc("benchmark_match_chunks", {
    p_tenant_id: input.tenantId,
    p_query_vector: vecLiteral,
    p_query_text: input.query,
    p_provider: input.provider,
    p_model: input.model,
    p_benchmark_run_id: input.benchmarkRunId,
    p_dense_n: input.denseN,
    p_lex_n: input.lexN,
    p_document_ids: allowedDocIds,
  });
  if (rpcErr) return { ok: false, error: rpcErr.message, status: 500 };
  const retrievalMs = Math.round(performance.now() - tR0);

  const cands = (rows ?? []) as BenchmarkRetrievalRow[];
  const tF0 = performance.now();
  const fused = benchmarkRrfFuse(cands);
  const ranked = benchmarkRankFused(fused);
  const fusionMs = Math.round(performance.now() - tF0);
  const denseCount = cands.filter((c) => c.channel === "dense").length;
  const lexicalCount = cands.filter((c) => c.channel === "lexical").length;

  // 3. Same candidate pool enters both benchmark modes. With rerank "both",
  // A (no-rerank) and B (reranked) are derived from one pool, one query
  // embedding and one RPC round trip, so the experimental comparison is exact.
  const pool = toBenchmarkRerankPool({
    question: input.query,
    tenantId: input.tenantId,
    vectorSpace: { provider: input.provider, model: input.model, dimensions: 1024 },
    ranked,
  });

  let rerankRunner: BenchmarkRerankRunner | undefined;
  const tRr0 = performance.now();
  if (input.rerank !== BENCHMARK_RERANK_NONE) {
    const rerankApiKey = input.rerankApiKey;
    rerankRunner = async (request) => {
      const call = await callBenchmarkRerank({
        apiKey: rerankApiKey,
        query: request.query,
        documents: request.documents,
        topN: request.top_n,
      });
      if (!call.ok) return { ok: false, error: `benchmark rerank failed: ${call.detail}` };
      const parsed = parseBenchmarkRerankResponse(call.payload, request.candidateCount, request.top_n);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, parsed: parsed.parsed };
    };
  }
  const modes: Array<"no-rerank" | "rerank"> =
    input.rerank === "both" ? ["no-rerank", "rerank"] : [input.rerank === BENCHMARK_RERANK_JINA ? "rerank" : "no-rerank"];
  const byMode: Record<string, {
    evidence: Array<BenchmarkRetrievalRow & { fused_rank: number; fused_score: number; rerank_score: number | null }>;
    citations: Array<{ n: number; chunk_id: string; document_id: string; file_name: string; page: number | null }>;
    usageTokens: number | null;
  }> = {};
  for (const mode of modes) {
    const outcome = await applyBenchmarkRetrievalMode({
      pool,
      mode,
      topN: input.finalK,
      rerank: rerankRunner,
      denseCount,
      lexicalCount,
    });
    const rerankMs = Math.round(performance.now() - tRr0);
    if (!outcome.ok) return { ok: false, error: outcome.error, status: 502 };
    byMode[mode] = {
      evidence: outcome.evidence.map((e) => ({
        fused_rank: e.evidenceOrder,
        fused_score: e.fused_score ?? 0,
        chunk_id: e.chunk_id,
        document_id: e.document_id,
        tenant_id: e.tenant_id,
        file_name: e.file_name,
        page: e.page,
        content: e.content,
        dense_score: e.dense_score,
        dense_rank: e.dense_rank,
        lex_score: e.lex_score,
        lex_rank: e.lex_rank,
        rerank_score: e.relevanceScore,
      })),
      citations: outcome.citations,
      usageTokens: outcome.usageTokens,
    };
    void rerankMs;
  }
  const rerankMs = Math.round(performance.now() - tRr0);
  const primary = byMode[modes[0]];

  return {
    ok: true,
    evidence: primary.evidence,
    citations: primary.citations,
    evidenceReranked: byMode["rerank"]?.evidence ?? null,
    citationsReranked: byMode["rerank"]?.citations ?? null,
    denseCount,
    lexicalCount,
    queryTokens,
    usageTokens: primary.usageTokens,
    embedMs,
    retrievalMs,
    fusionMs,
    rerankMs,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const t0 = performance.now();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(req) } });
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
  const denseN = Math.min(BENCHMARK_CANDIDATE_CAP, Math.max(1, Number(body.dense_n ?? BENCHMARK_DENSE_N) || BENCHMARK_DENSE_N));
  const lexN = Math.min(BENCHMARK_CANDIDATE_CAP, Math.max(1, Number(body.lex_n ?? BENCHMARK_LEX_N) || BENCHMARK_LEX_N));
  const finalK = Math.min(BENCHMARK_FINAL_K, Math.max(1, Number(body.final_k ?? BENCHMARK_FINAL_K) || BENCHMARK_FINAL_K));
  const fusion = String(body.fusion ?? "rrf").toLowerCase();
  if (fusion !== "rrf") return json(400, { ok: false, error: "benchmark fusion is locked to rrf" });
  const provider = String(body.provider ?? "");
  const model = String(body.model ?? "");
  const benchmarkRunId = String(body.benchmark_run_id ?? "");
  if (provider !== BENCHMARK_PROVIDER) {
    return json(400, { ok: false, error: "benchmark provider must be jina" });
  }
  if (model !== BENCHMARK_JINA_EMBED_MODEL) {
    return json(400, { ok: false, error: "benchmark model must be jina-embeddings-v5-text-small" });
  }
  if (!benchmarkRunId) return json(400, { ok: false, error: "benchmark_run_id is required" });
  const rerank = String(body.rerank ?? BENCHMARK_RERANK_NONE);
  if (rerank !== BENCHMARK_RERANK_NONE && rerank !== BENCHMARK_RERANK_JINA && rerank !== "both") {
    return json(400, { ok: false, error: "rerank must be none, jina-reranker-v3.5, or both" });
  }

  const { data: mem } = await db.from("memberships")
    .select("tenant_id").eq("tenant_id", tenantId).eq("user_id", caller).limit(1);
  if (!mem || mem.length === 0) return json(403, { ok: false, error: "not a member of this tenant" });

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

  const result = await buildBenchmarkEvidence({
    db,
    tenantId,
    query,
    notebookId,
    conversationId,
    requestedDocIds,
    denseN,
    lexN,
    finalK,
    provider,
    model,
    benchmarkRunId,
    rerank: rerank as BenchmarkRerankMode,
    embedApiKey: Deno.env.get(BENCHMARK_JINA_EMBED_API_KEY_ENV) ?? "",
    rerankApiKey: Deno.env.get(BENCHMARK_RERANK_API_KEY_ENV) ?? "",
    nowIso: new Date().toISOString(),
  });
  const totalMs = Math.round(performance.now() - t0);
  if (!result.ok) {
    const status = result.status >= 400 && result.status < 600 ? result.status : 502;
    return json(status, { ok: false, error: result.error });
  }
  console.log(JSON.stringify({
    fn: "benchmark-retrieval", caller, tenant_id: tenantId, rerank,
    provider, model, benchmark_run_id: benchmarkRunId,
    dense_candidates: result.denseCount, lexical_candidates: result.lexicalCount,
    evidence: result.evidence.length, total_ms: totalMs,
  }));
  return json(200, {
    ok: true,
    provider,
    model,
    reranker: rerank === BENCHMARK_RERANK_NONE
      ? "none"
      : rerank === "both"
        ? ["none", BENCHMARK_RERANK_JINA]
        : BENCHMARK_RERANK_JINA,
    retrieval_mode: "benchmark",
    benchmark_run_id: benchmarkRunId,
    fusion: "rrf",
    dense_n: denseN,
    lex_n: lexN,
    candidate_cap: BENCHMARK_CANDIDATE_CAP,
    rrf_k: BENCHMARK_RRF_K,
    final_k: finalK,
    query_tokens: result.queryTokens,
    rerank_usage_tokens: result.usageTokens,
    candidates: { dense: result.denseCount, lexical: result.lexicalCount },
    evidence: result.evidence,
    citations: result.citations,
    ...(result.evidenceReranked ? {
      evidence_reranked: result.evidenceReranked,
      citations_reranked: result.citationsReranked,
    } : {}),
    timings: { embed_ms: result.embedMs, retrieval_ms: result.retrievalMs, fusion_ms: result.fusionMs, rerank_ms: result.rerankMs, total_ms: totalMs },
  });
});
