// benchmark-jina-embed.ts — benchmark-only Jina embedding adapter.
//
// Benchmark-only. This module never touches the database, never calls Voyage,
// never calls /ask or /query-chunks, and never writes chunks.embedding. The
// only network boundary is an injected Jina embeddings transport, used only by
// explicitly benchmark-scoped callers.
//
// Locked benchmark embedding configuration:
//   model:      jina-embeddings-v5-text-small
//   dimensions: 1024 (matches the existing vector(1024) column type)
//   documents:  task "retrieval.passage"
//   queries:    task "retrieval.query"
//   normalized: true (unit length, per the Jina cosine-similarity contract)
//
// Jina embedding configuration is adapter-specific; both benchmark adapters
// resolve the single operator-provisioned JINA_API_KEY secret at runtime.
// Nothing here is shared with production.

export const BENCHMARK_JINA_EMBED_MODEL = "jina-embeddings-v5-text-small";
export const BENCHMARK_JINA_EMBED_ENDPOINT = "https://api.jina.ai/v1/embeddings";
// Single operator-provisioned Jina key for benchmark embeddings and reranking.
// The adapters stay provider-specific; only the secret name is shared.
export const BENCHMARK_JINA_EMBED_API_KEY_ENV = "JINA_API_KEY";
export const BENCHMARK_JINA_EMBED_DIMENSIONS = 1024;
export const BENCHMARK_JINA_EMBED_TIMEOUT_MS = 60_000;

export const BENCHMARK_JINA_TASK_PASSAGE = "retrieval.passage";
export const BENCHMARK_JINA_TASK_QUERY = "retrieval.query";

export type BenchmarkJinaEmbedTask =
  | typeof BENCHMARK_JINA_TASK_PASSAGE
  | typeof BENCHMARK_JINA_TASK_QUERY;

// Conservative benchmark batch envelope. This is not a copy of Voyage's
// 12-chunk budget: Jina has no hard synchronous item limit and a 32K-token
// per-input context, while our chunks are ~1,000 chars. Thirty-two inputs per
// request keeps each request around ~8K tokens — comfortably inside benchmark
// token accounting while remaining easy to validate whole-batch.
export const BENCHMARK_JINA_BATCH_DEFAULTS = {
  maxInputs: 32,
  maxChars: 32_000,
} as const;

export type BenchmarkJinaEmbedRequest = {
  model: typeof BENCHMARK_JINA_EMBED_MODEL;
  task: BenchmarkJinaEmbedTask;
  dimensions: typeof BENCHMARK_JINA_EMBED_DIMENSIONS;
  normalized: true;
  embedding_type: "float";
  input: string[];
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildBenchmarkJinaEmbedRequest(input: {
  task: BenchmarkJinaEmbedTask;
  inputs: string[];
}): { ok: true; request: BenchmarkJinaEmbedRequest } | { ok: false; error: string } {
  if (input.task !== BENCHMARK_JINA_TASK_PASSAGE && input.task !== BENCHMARK_JINA_TASK_QUERY) {
    return { ok: false, error: "task must be retrieval.passage or retrieval.query" };
  }
  if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
    return { ok: false, error: "inputs must be a non-empty array" };
  }
  if (!input.inputs.every(isNonEmptyString)) {
    return { ok: false, error: "every input must be a non-empty string" };
  }
  return {
    ok: true,
    request: {
      model: BENCHMARK_JINA_EMBED_MODEL,
      task: input.task,
      dimensions: BENCHMARK_JINA_EMBED_DIMENSIONS,
      normalized: true,
      embedding_type: "float",
      input: [...input.inputs],
    },
  };
}

/**
 * Split ordered inputs into bounded batches without dropping or reordering.
 * An oversized input forms its own batch so one long chunk never blocks the
 * rest; the provider's own context limit remains the backstop.
 */
export function planBenchmarkJinaBatches(
  inputs: string[],
  budgets: { maxInputs: number; maxChars: number } = { ...BENCHMARK_JINA_BATCH_DEFAULTS },
): string[][] {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const batches: string[][] = [];
  let rows: string[] = [];
  let chars = 0;
  const flush = () => {
    if (rows.length > 0) {
      batches.push(rows);
      rows = [];
      chars = 0;
    }
  };
  for (const input of inputs) {
    const length = typeof input === "string" ? input.length : 0;
    if (rows.length > 0 && (rows.length >= budgets.maxInputs || chars + length > budgets.maxChars)) {
      flush();
    }
    rows.push(input);
    chars += length;
  }
  flush();
  return batches;
}

export type BenchmarkJinaEmbedParsed = {
  model: typeof BENCHMARK_JINA_EMBED_MODEL;
  vectors: number[][];
  /** Provider-reported total tokens when present; never guessed. */
  tokens: number | null;
};

type EmbedParseResult =
  | { ok: true; parsed: BenchmarkJinaEmbedParsed }
  | { ok: false; error: string };

export function parseBenchmarkJinaEmbedResponse(
  raw: unknown,
  expectedCount: number,
): EmbedParseResult {
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    return { ok: false, error: "expectedCount must be a positive integer" };
  }
  if (!isRecord(raw)) return { ok: false, error: "embedding response must be an object" };
  // Model identity is enforced when the provider returns it; absence is not
  // treated as a match and not treated as a failure either, because the
  // audited synchronous-response excerpts did not fully pin the envelope.
  if ("model" in raw && raw["model"] !== undefined && raw["model"] !== BENCHMARK_JINA_EMBED_MODEL) {
    return { ok: false, error: "embedding response is for an unexpected model" };
  }
  if (!Array.isArray(raw["data"])) return { ok: false, error: "embedding response is missing data" };
  const data = raw["data"] as unknown[];
  if (data.length !== expectedCount) {
    return {
      ok: false,
      error: `embedding count ${data.length} does not match requested count ${expectedCount}`,
    };
  }

  const vectors: number[][] = new Array(expectedCount);
  for (let position = 0; position < data.length; position++) {
    const entry = data[position];
    if (!isRecord(entry)) return { ok: false, error: "embedding entry must be an object" };
    // Index mapping follows the request order; an explicit index is honored
    // only when it is a valid, unique position.
    let index = position;
    if ("index" in entry && entry["index"] !== undefined) {
      if (typeof entry["index"] !== "number" || !Number.isInteger(entry["index"])) {
        return { ok: false, error: "embedding index must be an integer when present" };
      }
      index = entry["index"] as number;
    }
    if (index < 0 || index >= expectedCount || vectors[index] !== undefined) {
      return { ok: false, error: "unusable index mapping" };
    }
    const vector = (entry as { embedding?: unknown })["embedding"];
    if (
      !Array.isArray(vector) ||
      vector.length !== BENCHMARK_JINA_EMBED_DIMENSIONS ||
      !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      return { ok: false, error: "embedding must be 1024 finite numbers" };
    }
    vectors[index] = vector as number[];
  }
  if (vectors.some((vector) => !vector)) {
    return { ok: false, error: "incomplete index mapping" };
  }

  let tokens: number | null = null;
  if (isRecord(raw["usage"]) && typeof raw["usage"]["total_tokens"] === "number") {
    tokens = Number.isFinite(raw["usage"]["total_tokens"])
      ? (raw["usage"]["total_tokens"] as number)
      : null;
  }
  return { ok: true, parsed: { model: BENCHMARK_JINA_EMBED_MODEL, vectors, tokens } };
}

export type BenchmarkJinaEmbedTransport = typeof fetch;

export type BenchmarkJinaEmbedCall =
  | { ok: true; status: number; payload: unknown; latencyMs: number }
  | {
    ok: false;
    kind: "config" | "timeout" | "transport" | "rate_limited" | "unauthorized" | "forbidden" | "bad_request" | "server";
    status: number | null;
    detail: string;
    latencyMs: number;
  };

export async function callBenchmarkJinaEmbed(input: {
  fetchFn?: BenchmarkJinaEmbedTransport;
  apiKey: string;
  task: BenchmarkJinaEmbedTask;
  inputs: string[];
  timeoutMs?: number;
}): Promise<BenchmarkJinaEmbedCall> {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = input.timeoutMs ?? BENCHMARK_JINA_EMBED_TIMEOUT_MS;
  const started = performance.now();

  const built = buildBenchmarkJinaEmbedRequest({ task: input.task, inputs: input.inputs });
  if (!built.ok) {
    return { ok: false, kind: "config", status: null, detail: built.error, latencyMs: 0 };
  }
  if (!isNonEmptyString(input.apiKey)) {
    return { ok: false, kind: "config", status: null, detail: "missing benchmark embedding API key", latencyMs: 0 };
  }

  let response: Response;
  try {
    response = await fetchFn(BENCHMARK_JINA_EMBED_ENDPOINT, {
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
      detail: name === "AbortError" ? "benchmark embedding timed out" : "benchmark embedding transport failed",
      latencyMs: Math.round(performance.now() - started),
    };
  }

  const latencyMs = Math.round(performance.now() - started);
  if (response.status === 429) {
    // Benchmark use records quota failures instead of retrying into them.
    return { ok: false, kind: "rate_limited", status: 429, detail: "benchmark embedding rate limited", latencyMs };
  }
  if (response.status === 401) {
    return { ok: false, kind: "unauthorized", status: 401, detail: "benchmark embedding credentials rejected", latencyMs };
  }
  if (response.status === 403) {
    return { ok: false, kind: "forbidden", status: 403, detail: "benchmark embedding access forbidden", latencyMs };
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return { ok: false, kind: "bad_request", status: response.status, detail: "benchmark embedding request rejected", latencyMs };
  }
  if (!response.ok) {
    return { ok: false, kind: "server", status: response.status, detail: "benchmark embedding provider error", latencyMs };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, kind: "server", status: response.status, detail: "benchmark embedding response is not JSON", latencyMs };
  }
  return { ok: true, status: response.status, payload, latencyMs };
}
