// rerank.ts — production second-stage reranking over the fused candidate pool.
//
// Jina jina-reranker-v3.5 via the shared JINA_API_KEY secret. The reranker
// receives question + candidate chunk text only — never scores, vectors, or
// tenant identity beyond what retrieval already resolved. Results map back to
// the input pool by request-document index, preserving every provenance field;
// positional citation numbering is rebuilt downstream from the returned order.
//
// Single attempt per call with explicit timeout/429 handling; the query-chunks
// caller falls back to RRF order when reranking fails, so a reranker outage
// degrades ranking instead of failing retrieval.

export const RERANK_MODEL = "jina-reranker-v3.5";
export const RERANK_ENDPOINT = "https://api.jina.ai/v1/rerank";
export const RERANK_API_KEY_ENV = "JINA_API_KEY";
export const RERANK_TIMEOUT_MS = 30_000;

export type RerankRequest = {
  model: typeof RERANK_MODEL;
  query: string;
  documents: string[];
  top_n: number;
  return_documents: false;
};

export type RerankedHit = {
  /** Position in the request documents array. */
  inputIndex: number;
  relevanceScore: number;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildRerankRequest(input: {
  query: string;
  documents: string[];
  topN: number;
  maxCandidates: number;
}):
  | { ok: true; request: RerankRequest }
  | { ok: false; error: string } {
  if (!isNonEmptyString(input.query) || input.query.length > 1000) {
    return { ok: false, error: "query must be a non-empty string within the input bound" };
  }
  if (!Array.isArray(input.documents) || input.documents.length === 0 ||
      input.documents.length > input.maxCandidates ||
      !input.documents.every(isNonEmptyString)) {
    return { ok: false, error: "documents must be a non-empty array within the candidate cap" };
  }
  if (!Number.isInteger(input.topN) || input.topN < 1 || input.topN > input.documents.length) {
    return { ok: false, error: "topN must select 1..N of the supplied candidates" };
  }
  return {
    ok: true,
    request: {
      model: RERANK_MODEL,
      query: input.query,
      documents: [...input.documents],
      top_n: input.topN,
      return_documents: false,
    },
  };
}

export function parseRerankResponse(
  raw: unknown,
  candidateCount: number,
  topN: number,
):
  | { ok: true; ranked: RerankedHit[]; usageTokens: number | null }
  | { ok: false; error: string } {
  if (!Number.isInteger(candidateCount) || candidateCount < 1) {
    return { ok: false, error: "candidateCount must be a positive integer" };
  }
  if (!Number.isInteger(topN) || topN < 1 || topN > candidateCount) {
    return { ok: false, error: "topN must select 1..N of the supplied candidates" };
  }
  if (!isRecord(raw)) return { ok: false, error: "rerank response must be an object" };
  if (raw["model"] !== RERANK_MODEL) {
    return { ok: false, error: "rerank response is for an unexpected model" };
  }
  if (!Array.isArray(raw["results"])) return { ok: false, error: "rerank response is missing results" };
  const rows = raw["results"] as unknown[];
  if (rows.length !== topN) {
    return { ok: false, error: `rerank result count ${rows.length} does not match topN ${topN}` };
  }
  const seen = new Set<number>();
  const ranked: RerankedHit[] = [];
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
    ranked.push({ inputIndex: index, relevanceScore: score });
  }
  let usageTokens: number | null = null;
  if (isRecord(raw["usage"]) && typeof raw["usage"]["total_tokens"] === "number") {
    usageTokens = Number.isFinite(raw["usage"]["total_tokens"])
      ? (raw["usage"]["total_tokens"] as number)
      : null;
  }
  return { ok: true, ranked, usageTokens };
}

export type RerankTransport = typeof fetch;

/**
 * Map validated rerank results back onto the candidate pool in reranked order.
 * Returns null on any structural mismatch so the caller falls back to RRF
 * order instead of emitting misattributed evidence.
 */
export function mapRerankedPool<T>(
  pool: T[],
  ranked: Array<{ inputIndex: number }>,
): T[] | null {
  if (ranked.length === 0 || ranked.length > pool.length) return null;
  const seen = new Set<number>();
  const out: T[] = [];
  for (const r of ranked) {
    if (r.inputIndex < 0 || r.inputIndex >= pool.length || seen.has(r.inputIndex)) {
      return null;
    }
    seen.add(r.inputIndex);
    out.push(pool[r.inputIndex]);
  }
  return out;
}
export type RerankCall =
  | { ok: true; status: number; payload: unknown; latencyMs: number }
  | {
    ok: false;
    kind: "config" | "timeout" | "transport" | "rate_limited" | "unauthorized" | "forbidden" | "bad_request" | "server";
    status: number | null;
    detail: string;
    latencyMs: number;
  };

export async function callReranker(input: {
  fetchFn?: RerankTransport;
  apiKey: string;
  query: string;
  documents: string[];
  topN: number;
  maxCandidates: number;
  timeoutMs?: number;
}): Promise<RerankCall> {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = input.timeoutMs ?? RERANK_TIMEOUT_MS;
  const started = performance.now();

  const built = buildRerankRequest({
    query: input.query,
    documents: input.documents,
    topN: input.topN,
    maxCandidates: input.maxCandidates,
  });
  if (!built.ok) {
    return { ok: false, kind: "config", status: null, detail: built.error, latencyMs: 0 };
  }
  if (!isNonEmptyString(input.apiKey)) {
    return { ok: false, kind: "config", status: null, detail: "missing rerank API key", latencyMs: 0 };
  }

  let response: Response;
  try {
    response = await fetchFn(RERANK_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(built.request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      ok: false,
      kind: name === "AbortError" ? "timeout" : "transport",
      status: null,
      detail: name === "AbortError" ? "rerank timed out" : "rerank transport failed",
      latencyMs: Math.round(performance.now() - started),
    };
  }

  const latencyMs = Math.round(performance.now() - started);
  if (response.status === 429) {
    return { ok: false, kind: "rate_limited", status: 429, detail: "rerank rate limited", latencyMs };
  }
  if (response.status === 401) {
    return { ok: false, kind: "unauthorized", status: 401, detail: "rerank credentials rejected", latencyMs };
  }
  if (response.status === 403) {
    return { ok: false, kind: "forbidden", status: 403, detail: "rerank access forbidden", latencyMs };
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return { ok: false, kind: "bad_request", status: response.status, detail: "rerank request rejected", latencyMs };
  }
  if (!response.ok) {
    return { ok: false, kind: "server", status: response.status, detail: "rerank provider error", latencyMs };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, kind: "server", status: response.status, detail: "rerank response is not JSON", latencyMs };
  }
  return { ok: true, status: response.status, payload, latencyMs };
}
