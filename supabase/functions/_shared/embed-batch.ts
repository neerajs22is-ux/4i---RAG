// Batched embedding helpers (B1).
//
// Jina accepts an array of inputs per request. Batching raises ingestion
// throughput without touching the model, the dimensions, the input task, the
// stored vector or the chunking — it only changes how many chunks travel in
// one request. Both functions are pure so they can be unit tested without a
// provider call.
//
// Provider envelope (api.jina.ai, jina-embeddings-v5-text-small): task-selected
// embeddings with an OpenAI-style data/index/usage envelope. The application
// budget is far tighter than the provider envelope, so the caller passes
// explicit per-request budgets.

export const EMBED_MODEL = "jina-embeddings-v5-text-small";
export const EMBED_DIMENSIONS = 1024;
export const EMBED_TASK_DOCUMENT = "retrieval.passage";
export const EMBED_TASK_QUERY = "retrieval.query";
export const EMBED_NORMALIZED = true;

export type EmbedCandidate = { chunk_id: string; content: string };

export type BatchBudgets = {
  /** Maximum chunks in one request. */
  maxChunks: number;
  /** Maximum total characters in one request (token proxy; ~4 chars/token). */
  maxChars: number;
  /** Maximum requests per invocation. */
  maxBatches: number;
};

/**
 * Split ordered candidates into bounded batches.
 *
 * Guarantees:
 *  - order is preserved;
 *  - no candidate is dropped;
 *  - a candidate larger than `maxChars` still forms its own batch (progress is
 *    never blocked by one oversized row) — the provider's own context limit
 *    remains the backstop for genuinely broken content.
 */
export function planBatches(
  candidates: EmbedCandidate[],
  budgets: BatchBudgets,
): EmbedCandidate[][] {
  const batches: EmbedCandidate[][] = [];
  let rows: EmbedCandidate[] = [];
  let chars = 0;

  const flush = () => {
    if (rows.length > 0) {
      batches.push(rows);
      rows = [];
      chars = 0;
    }
  };

  for (const candidate of candidates) {
    const length = candidate.content.length;
    if (
      rows.length > 0 &&
      (rows.length >= budgets.maxChunks || chars + length > budgets.maxChars)
    ) {
      flush();
    }
    rows.push(candidate);
    chars += length;
  }
  flush();

  return batches.slice(0, budgets.maxBatches);
}

export type BatchParseResult =
  | { ok: true; vectors: number[][]; tokens: number }
  | { ok: false; reason: string };

/**
 * Conservative token estimate for one planned batch.
 *
 * Uses the same ~4 chars/token proxy the batch planner budgets with, plus a
 * small per-input allowance for the request envelope. This is a pacing guard,
 * not billing telemetry: it only ever *skips* a request within a tick (the
 * chunks stay NULL and the next tick retries them), so over-estimating is
 * safe and under-estimating is bounded by the provider's own 429 handling.
 */
export function estimateBatchTokens(contents: string[]): number {
  let total = 10 * contents.length;
  for (const content of contents) total += Math.ceil(content.length / 4);
  return total;
}

/**
 * Whether sending one more batch this tick would exceed the tick's own token
 * budget. Equality is allowed (the budget is a ceiling, not a tripwire).
 */
export function exceedsTokenBudget(
  usedTokens: number,
  batchContents: string[],
  budgetTokens: number,
): boolean {
  return usedTokens + estimateBatchTokens(batchContents) > budgetTokens;
}/**
 * Validate a Jina embeddings response for one batch and map it back to the
 * request order.
 *
 * Strict by design: unless every entry is present, correctly indexed and a
 * finite 1024-dimension vector, the whole batch is rejected and the caller must
 * persist **none** of it. A malformed response can therefore never mark a chunk
 * as embedded; the chunks stay NULL and the next tick retries them.
 */
export function parseBatchResponse(
  raw: unknown,
  expectedCount: number,
): BatchParseResult {
  const parsed = raw as
    | {
        data?: Array<{ embedding?: unknown; index?: unknown }>;
        model?: string;
        usage?: { total_tokens?: number };
      }
    | null;

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "malformed response body (fatal)" };
  }
  if ("model" in parsed && parsed.model !== undefined && parsed.model !== EMBED_MODEL) {
    return { ok: false, reason: "model mismatch (fatal)" };
  }

  const data = Array.isArray(parsed.data) ? parsed.data : null;
  if (!data) return { ok: false, reason: "missing data array (fatal)" };
  if (data.length !== expectedCount) {
    return {
      ok: false,
      reason: `response count ${data.length} != requested ${expectedCount} (fatal)`,
    };
  }

  // Entries carry their request index; fall back to positional order only when
  // the provider omits it entirely.
  const indicesPresent = data.some(
    (entry) => typeof entry?.index === "number",
  );

  const vectors: number[][] = new Array(expectedCount);
  for (let position = 0; position < data.length; position++) {
    const entry = data[position];
    const index = indicesPresent ? entry?.index : position;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expectedCount ||
      vectors[index] !== undefined
    ) {
      return { ok: false, reason: "unusable index mapping (fatal)" };
    }
    const vector = entry?.embedding;
    if (
      !Array.isArray(vector) ||
      vector.length !== EMBED_DIMENSIONS ||
      !vector.every((value) => Number.isFinite(value))
    ) {
      return {
        ok: false,
        reason: `invalid vector at index ${index} (fatal)`,
      };
    }
    vectors[index] = vector as number[];
  }

  if (vectors.some((vector) => !vector)) {
    return { ok: false, reason: "incomplete index mapping (fatal)" };
  }

  return { ok: true, vectors, tokens: parsed.usage?.total_tokens ?? 0 };
}
