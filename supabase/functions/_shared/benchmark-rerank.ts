// benchmark-rerank.ts — benchmark-only reranking contract and Jina v3.5 adapter.
//
// This module is intentionally isolated from production ingestion, retrieval,
// persistence, and Voyage configuration. It performs no database I/O, never
// calls /ask or /query-chunks, never reads chunks.embedding, and never calls
// Voyage. The only network boundary is an injected Jina rerank transport, used
// only when benchmark callers explicitly select rerank mode.
//
// The reranker receives question + chunk text only. Fusion scores, vector
// values, and production identity beyond chunk/document/page provenance are
// never sent as semantic input. Rerank results preserve the original benchmark
// candidate rows; positional citation numbers are regenerated afterward.
// The adapter resolves the single operator-provisioned JINA_API_KEY secret at
// runtime, shared with the benchmark embedding adapter by explicit operator
// decision; adapter code itself stays provider-specific.

export const BENCHMARK_RETRIEVAL = {
  dense: 20,
  lexical: 20,
  candidateCap: 50,
  fusion: "rrf",
  rrfK: 60,
  finalK: 8,
} as const;

export const BENCHMARK_FINAL_K = 8;
export const BENCHMARK_RERANK_MODEL = "jina-reranker-v3.5";
export const BENCHMARK_RERANK_ENDPOINT = "https://api.jina.ai/v1/rerank";
// Single operator-provisioned Jina key for benchmark reranking and embeddings.
// The adapters stay provider-specific; only the secret name is shared.
export const BENCHMARK_RERANK_API_KEY_ENV = "JINA_API_KEY";
export const BENCHMARK_RERANK_TIMEOUT_MS = 60_000;
export const BENCHMARK_MAX_RERANK_CANDIDATES = BENCHMARK_RETRIEVAL.candidateCap;

export type BenchmarkVectorSpace = {
  provider: string;
  model: string;
  dimensions: number;
};

export type BenchmarkCandidate = {
  /** Stable input position for this benchmark call, not a score. */
  poolIndex: number;
  chunk_id: string;
  document_id: string;
  tenant_id: string;
  file_name: string;
  page: number | null;
  content: string;
  fused_score?: number | null;
  fused_rank?: number | null;
  dense_score?: number | null;
  dense_rank?: number | null;
  lex_score?: number | null;
  lex_rank?: number | null;
};

export type BenchmarkCandidatePool = {
  question: string;
  tenantId: string;
  vectorSpace: BenchmarkVectorSpace;
  candidates: BenchmarkCandidate[];
};

export type BenchmarkRerankRequest = {
  model: typeof BENCHMARK_RERANK_MODEL;
  query: string;
  documents: string[];
  top_n: number;
  return_documents: false;
  /** Candidate poolIndex values in request-document order. */
  requestOrder: number[];
  candidateCount: number;
};

export type BenchmarkRerankParsed = {
  model: typeof BENCHMARK_RERANK_MODEL;
  usageTokens: number | null;
  ranked: Array<{
    /** Position in the request documents array. */
    inputIndex: number;
    relevanceScore: number;
  }>;
};

export type BenchmarkEvidence = {
  evidenceOrder: number;
  poolIndex: number;
  relevanceScore: number | null;
  chunk_id: string;
  document_id: string;
  tenant_id: string;
  file_name: string;
  page: number | null;
  content: string;
  fused_score?: number | null;
  fused_rank?: number | null;
  dense_score?: number | null;
  dense_rank?: number | null;
  lex_score?: number | null;
  lex_rank?: number | null;
};

export type BenchmarkCitation = {
  n: number;
  chunk_id: string;
  document_id: string;
  file_name: string;
  page: number | null;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vectorSpaceKey(space: BenchmarkVectorSpace): string {
  return `${space.provider}\u0000${space.model}\u0000${String(space.dimensions)}`;
}

type PoolValidation =
  | { ok: true; topN: number; expectedCount: number }
  | { ok: false; error: string };

function validateBenchmarkPool(
  pool: BenchmarkCandidatePool,
  topN: number,
): PoolValidation {
  if (!isRecord(pool as unknown)) return { ok: false, error: "candidate pool must be an object" };
  if (!isNonEmptyString(pool.question)) return { ok: false, error: "question must be a non-empty string" };
  if (pool.question.length > 1000) return { ok: false, error: "question exceeds the benchmark input bound" };
  if (!isNonEmptyString(pool.tenantId)) return { ok: false, error: "tenantId must be a non-empty string" };
  if (!isRecord(pool.vectorSpace as unknown)) {
    return { ok: false, error: "vectorSpace must be an object" };
  }
  if (
    !isNonEmptyString(pool.vectorSpace.provider) ||
    !isNonEmptyString(pool.vectorSpace.model) ||
    typeof pool.vectorSpace.dimensions !== "number" ||
    !Number.isInteger(pool.vectorSpace.dimensions) ||
    pool.vectorSpace.dimensions < 0
  ) {
    return { ok: false, error: "vectorSpace must name one provider, model, and integer dimensions" };
  }
  if (!Array.isArray(pool.candidates) || pool.candidates.length === 0) {
    return { ok: false, error: "candidates must be a non-empty array" };
  }
  if (pool.candidates.length > BENCHMARK_MAX_RERANK_CANDIDATES) {
    return {
      ok: false,
      error: `candidate pool exceeds the locked candidate cap of ${BENCHMARK_MAX_RERANK_CANDIDATES}`,
    };
  }
  if (!Number.isInteger(topN) || topN < 1 || topN > BENCHMARK_FINAL_K) {
    return { ok: false, error: `topN must be an integer from 1 to ${BENCHMARK_FINAL_K}` };
  }

  const expectedKey = vectorSpaceKey(pool.vectorSpace);
  const seenPoolIndexes = new Set<number>();
  for (const candidate of pool.candidates) {
    if (!isRecord(candidate as unknown)) return { ok: false, error: "candidate must be an object" };
    if (
      typeof candidate.poolIndex !== "number" ||
      !Number.isInteger(candidate.poolIndex) ||
      candidate.poolIndex < 0
    ) {
      return { ok: false, error: "candidate poolIndex must be a non-negative integer" };
    }
    if (seenPoolIndexes.has(candidate.poolIndex)) {
      return { ok: false, error: "candidate poolIndex values must be unique" };
    }
    seenPoolIndexes.add(candidate.poolIndex);
    if (
      !isNonEmptyString(candidate.chunk_id) ||
      !isNonEmptyString(candidate.document_id) ||
      !isNonEmptyString(candidate.tenant_id) ||
      !isNonEmptyString(candidate.file_name) ||
      !isNonEmptyString(candidate.content)
    ) {
      return { ok: false, error: "candidate provenance and content must be non-empty strings" };
    }
    if (candidate.tenant_id !== pool.tenantId) {
      return { ok: false, error: "all candidates must belong to the pool tenant" };
    }
    if (candidate.page !== null && (typeof candidate.page !== "number" || !Number.isInteger(candidate.page))) {
      return { ok: false, error: "candidate page must be null or an integer" };
    }
    void expectedKey;
  }

  return { ok: true, topN, expectedCount: Math.min(topN, pool.candidates.length) };
}

export function buildBenchmarkRerankRequest(
  pool: BenchmarkCandidatePool,
  topN: number = BENCHMARK_FINAL_K,
):
  | { ok: true; request: BenchmarkRerankRequest }
  | { ok: false; error: string } {
  const validation = validateBenchmarkPool(pool, topN);
  if (!validation.ok) return validation;

  return {
    ok: true,
    request: {
      model: BENCHMARK_RERANK_MODEL,
      query: pool.question,
      documents: pool.candidates.map((candidate) => candidate.content),
      top_n: validation.expectedCount,
      return_documents: false,
      requestOrder: pool.candidates.map((candidate) => candidate.poolIndex),
      candidateCount: pool.candidates.length,
    },
  };
}

type RerankParseResult =
  | { ok: true; parsed: BenchmarkRerankParsed }
  | { ok: false; error: string };

export function parseBenchmarkRerankResponse(
  raw: unknown,
  candidateCount: number,
  topN: number = BENCHMARK_FINAL_K,
): RerankParseResult {
  if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > BENCHMARK_MAX_RERANK_CANDIDATES) {
    return { ok: false, error: "candidateCount is outside the benchmark pool bounds" };
  }
  if (!Number.isInteger(topN) || topN < 1 || topN > BENCHMARK_FINAL_K) {
    return { ok: false, error: `topN must be an integer from 1 to ${BENCHMARK_FINAL_K}` };
  }
  if (!isRecord(raw)) return { ok: false, error: "rerank response must be an object" };
  if (raw["model"] !== BENCHMARK_RERANK_MODEL) {
    return { ok: false, error: "rerank response is for an unexpected model" };
  }
  if (!Array.isArray(raw["results"])) return { ok: false, error: "rerank response is missing results" };

  const expectedCount = Math.min(topN, candidateCount);
  const rows = raw["results"] as unknown[];
  if (rows.length !== expectedCount) {
    return {
      ok: false,
      error: `rerank result count ${rows.length} does not match expected count ${expectedCount}`,
    };
  }

  const seen = new Set<number>();
  const ranked: BenchmarkRerankParsed["ranked"] = [];
  for (const row of rows) {
    if (!isRecord(row)) return { ok: false, error: "rerank result must be an object" };
    const index = row["index"];
    const score = row["relevance_score"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= candidateCount) {
      return { ok: false, error: "rerank result index is outside the request-document range" };
    }
    if (seen.has(index)) return { ok: false, error: "rerank result indexes must be unique" };
    seen.add(index);
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return { ok: false, error: "rerank relevance_score must be a finite number" };
    }
    if ("document" in row && typeof row["document"] !== "string") {
      return { ok: false, error: "returned document text must be a string when present" };
    }
    ranked.push({ inputIndex: index, relevanceScore: score });
  }

  let usageTokens: number | null = null;
  if (isRecord(raw["usage"]) && typeof raw["usage"]["total_tokens"] === "number") {
    usageTokens = Number.isFinite(raw["usage"]["total_tokens"])
      ? (raw["usage"]["total_tokens"] as number)
      : null;
  }

  return { ok: true, parsed: { model: BENCHMARK_RERANK_MODEL, usageTokens, ranked } };
}

export type BenchmarkRerankTransport = typeof fetch;

export type BenchmarkRerankCall =
  | { ok: true; status: number; payload: unknown; latencyMs: number }
  | {
    ok: false;
    kind: "config" | "timeout" | "transport" | "rate_limited" | "unauthorized" | "forbidden" | "bad_request" | "server";
    status: number | null;
    detail: string;
    latencyMs: number;
  };

export async function callBenchmarkRerank(input: {
  fetchFn?: BenchmarkRerankTransport;
  apiKey: string;
  query: string;
  documents: string[];
  topN?: number;
  timeoutMs?: number;
}): Promise<BenchmarkRerankCall> {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = input.timeoutMs ?? BENCHMARK_RERANK_TIMEOUT_MS;
  const topN = input.topN ?? BENCHMARK_FINAL_K;
  const started = performance.now();

  if (!isNonEmptyString(input.apiKey)) {
    return { ok: false, kind: "config", status: null, detail: "missing benchmark rerank API key", latencyMs: 0 };
  }
  if (!isNonEmptyString(input.query) || input.query.length > 1000) {
    return { ok: false, kind: "config", status: null, detail: "invalid benchmark rerank query", latencyMs: 0 };
  }
  if (!Array.isArray(input.documents) || input.documents.length === 0 ||
    input.documents.length > BENCHMARK_MAX_RERANK_CANDIDATES ||
    !input.documents.every(isNonEmptyString)) {
    return { ok: false, kind: "config", status: null, detail: "invalid benchmark rerank documents", latencyMs: 0 };
  }
  if (!Number.isInteger(topN) || topN < 1 || topN > BENCHMARK_FINAL_K) {
    return { ok: false, kind: "config", status: null, detail: `topN must be an integer from 1 to ${BENCHMARK_FINAL_K}`, latencyMs: 0 };
  }

  let response: Response;
  try {
    response = await fetchFn(BENCHMARK_RERANK_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: BENCHMARK_RERANK_MODEL,
        query: input.query,
        documents: input.documents,
        top_n: Math.min(topN, input.documents.length),
        return_documents: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      ok: false,
      kind: name === "AbortError" ? "timeout" : "transport",
      status: null,
      detail: name === "AbortError" ? "benchmark rerank timed out" : "benchmark rerank transport failed",
      latencyMs: Math.round(performance.now() - started),
    };
  }

  const latencyMs = Math.round(performance.now() - started);
  if (response.status === 429) {
    // Benchmark use does not retry quota failures; the caller records the
    // failure instead of hammering a limited key.
    return { ok: false, kind: "rate_limited", status: 429, detail: "benchmark rerank rate limited", latencyMs };
  }
  if (response.status === 401) {
    return { ok: false, kind: "unauthorized", status: 401, detail: "benchmark rerank credentials rejected", latencyMs };
  }
  if (response.status === 403) {
    return { ok: false, kind: "forbidden", status: 403, detail: "benchmark rerank access forbidden", latencyMs };
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return { ok: false, kind: "bad_request", status: response.status, detail: "benchmark rerank request rejected", latencyMs };
  }
  if (!response.ok) {
    return { ok: false, kind: "server", status: response.status, detail: "benchmark rerank provider error", latencyMs };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, kind: "server", status: response.status, detail: "benchmark rerank response is not JSON", latencyMs };
  }
  return { ok: true, status: response.status, payload, latencyMs };
}

export type BenchmarkMode = "no-rerank" | "rerank";
export type BenchmarkRerankRunner = (
  request: BenchmarkRerankRequest,
) => Promise<{ ok: true; parsed: BenchmarkRerankParsed } | { ok: false; error: string }>;

export type BenchmarkModeResult =
  | {
    ok: true;
    mode: BenchmarkMode;
    evidence: BenchmarkEvidence[];
    request: BenchmarkRerankRequest | null;
    usageTokens: number | null;
  }
  | { ok: false; mode: BenchmarkMode; error: string };

function toEvidence(
  candidate: BenchmarkCandidate,
  evidenceOrder: number,
  relevanceScore: number | null,
): BenchmarkEvidence {
  return {
    evidenceOrder,
    poolIndex: candidate.poolIndex,
    relevanceScore,
    chunk_id: candidate.chunk_id,
    document_id: candidate.document_id,
    tenant_id: candidate.tenant_id,
    file_name: candidate.file_name,
    page: candidate.page,
    content: candidate.content,
    fused_score: candidate.fused_score ?? null,
    fused_rank: candidate.fused_rank ?? null,
    dense_score: candidate.dense_score ?? null,
    dense_rank: candidate.dense_rank ?? null,
    lex_score: candidate.lex_score ?? null,
    lex_rank: candidate.lex_rank ?? null,
  };
}

export async function applyBenchmarkRerankMode(input: {
  pool: BenchmarkCandidatePool;
  mode: BenchmarkMode;
  topN?: number;
  rerank?: BenchmarkRerankRunner;
}): Promise<BenchmarkModeResult> {
  const topN = input.topN ?? BENCHMARK_FINAL_K;
  const validation = validateBenchmarkPool(input.pool, topN);
  if (!validation.ok) return { ok: false, mode: input.mode, error: validation.error };
  const expectedCount = validation.expectedCount;

  if (input.mode === "no-rerank") {
    return {
      ok: true,
      mode: input.mode,
      evidence: input.pool.candidates.slice(0, expectedCount).map((candidate, order) =>
        toEvidence(candidate, order + 1, null)
      ),
      request: null,
      usageTokens: null,
    };
  }

  if (!input.rerank) return { ok: false, mode: input.mode, error: "rerank mode requires a rerank runner" };
  const built = buildBenchmarkRerankRequest(input.pool, topN);
  if (!built.ok) return { ok: false, mode: input.mode, error: built.error };
  const outcome = await input.rerank(built.request);
  if (!outcome.ok) return { ok: false, mode: input.mode, error: outcome.error };

  if (outcome.parsed.ranked.length !== expectedCount) {
    return {
      ok: false,
      mode: input.mode,
      error: `reranked evidence count ${outcome.parsed.ranked.length} does not match expected count ${expectedCount}`,
    };
  }

  const evidence = outcome.parsed.ranked.map((ranked, order) => {
    const candidate = input.pool.candidates[ranked.inputIndex];
    if (!candidate) {
      throw new Error("reranked index is outside the benchmark candidate pool");
    }
    return toEvidence(candidate, order + 1, ranked.relevanceScore);
  });

  return { ok: true, mode: input.mode, evidence, request: built.request, usageTokens: outcome.parsed.usageTokens };
}

export function renumberBenchmarkCitations(evidence: BenchmarkEvidence[]): BenchmarkCitation[] {
  return evidence.map((item, order) => ({
    n: order + 1,
    chunk_id: item.chunk_id,
    document_id: item.document_id,
    file_name: item.file_name,
    page: item.page,
  }));
}
