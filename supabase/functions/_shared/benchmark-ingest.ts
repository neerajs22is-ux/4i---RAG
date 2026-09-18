// benchmark-ingest.ts — benchmark-only passage-embedding population.
//
// Benchmark-only. This module reads chunk content supplied by the caller
// (the Edge handler loads it through caller-JWT RLS reads), embeds it with
// Jina (retrieval.passage) through an injected batch runner, and writes ONLY
// to public.benchmark_embeddings through an injected writer. It never reads
// production vectors, never writes chunks/documents/jobs/conversations, never
// calls Voyage or any production endpoint.
//
// Writes are all-or-nothing per call: every batch is embedded and validated
// first, and rows are inserted exactly once afterward. A batch failure leaves
// zero rows behind.

import {
  BENCHMARK_JINA_BATCH_DEFAULTS,
  BENCHMARK_JINA_EMBED_MODEL,
  BENCHMARK_JINA_TASK_PASSAGE,
  buildBenchmarkJinaEmbedRequest,
  planBenchmarkJinaBatches,
} from "./benchmark-jina-embed.ts";

export const BENCHMARK_INGEST_MAX_CHUNKS = 64;
export const BENCHMARK_INGEST_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BENCHMARK_INGEST_DIMENSIONS = 1024;

export type BenchmarkIngestChunk = {
  chunk_id: string;
  content: string;
};

export type BenchmarkIngestRow = {
  tenant_id: string;
  chunk_id: string;
  provider: "jina";
  model: typeof BENCHMARK_JINA_EMBED_MODEL;
  dimensions: typeof BENCHMARK_INGEST_DIMENSIONS;
  embedding: number[];
  benchmark_run_id: string;
};

export type BenchmarkIngestEmbedBatch = (inputs: string[]) => Promise<{
  vectors: number[][];
  tokens: number | null;
}>;

export type BenchmarkIngestResult =
  | { ok: true; embedded: number; requests: number; tokens: number }
  | { ok: false; error: string; embedded: 0; requests: number };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Embed one bounded chunk set and stage its benchmark rows. Pure
 * orchestration over injected I/O: the caller supplies tenant-validated
 * chunk reads, a Jina batch runner, and a benchmark-table writer.
 */
export async function ingestBenchmarkEmbeddings(input: {
  tenantId: string;
  runId: string;
  chunks: BenchmarkIngestChunk[];
  embedBatch: BenchmarkIngestEmbedBatch;
  insertRows: (rows: BenchmarkIngestRow[]) => Promise<void>;
}): Promise<BenchmarkIngestResult> {
  if (!isNonEmptyString(input.tenantId)) {
    return { ok: false, error: "tenantId must be a non-empty string", embedded: 0, requests: 0 };
  }
  if (!BENCHMARK_INGEST_RUN_ID_RE.test(input.runId)) {
    return { ok: false, error: "runId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}", embedded: 0, requests: 0 };
  }
  if (!Array.isArray(input.chunks) || input.chunks.length === 0) {
    return { ok: false, error: "chunks must be a non-empty array", embedded: 0, requests: 0 };
  }
  if (input.chunks.length > BENCHMARK_INGEST_MAX_CHUNKS) {
    return {
      ok: false,
      error: `chunks exceeds the per-call bound of ${BENCHMARK_INGEST_MAX_CHUNKS}`,
      embedded: 0,
      requests: 0,
    };
  }
  for (const chunk of input.chunks) {
    if (typeof chunk !== "object" || chunk === null ||
        !isNonEmptyString((chunk as BenchmarkIngestChunk).chunk_id) ||
        !isNonEmptyString((chunk as BenchmarkIngestChunk).content)) {
      return { ok: false, error: "every chunk needs a chunk_id and non-empty content", embedded: 0, requests: 0 };
    }
  }

  const batches = planBenchmarkJinaBatches(
    input.chunks.map((c) => c.content),
    { ...BENCHMARK_JINA_BATCH_DEFAULTS },
  );

  // Embed every batch and validate before any write: a failure anywhere
  // leaves zero rows behind.
  const vectors: number[][] = [];
  let tokens = 0;
  let requests = 0;
  for (const batch of batches) {
    const built = buildBenchmarkJinaEmbedRequest({ task: BENCHMARK_JINA_TASK_PASSAGE, inputs: batch });
    if (!built.ok) {
      return { ok: false, error: `batch rejected: ${built.error}`, embedded: 0, requests };
    }
    let out: { vectors: number[][]; tokens: number | null };
    try {
      out = await input.embedBatch(batch);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `batch failed: ${detail.slice(0, 120)}`, embedded: 0, requests };
    }
    requests++;
    if (!Array.isArray(out.vectors) || out.vectors.length !== batch.length) {
      return { ok: false, error: "batch vector count mismatch", embedded: 0, requests };
    }
    for (const vector of out.vectors) {
      if (
        !Array.isArray(vector) || vector.length !== BENCHMARK_INGEST_DIMENSIONS ||
        !vector.every((v) => typeof v === "number" && Number.isFinite(v))
      ) {
        return { ok: false, error: "batch vector must be 1024 finite numbers", embedded: 0, requests };
      }
      vectors.push(vector);
    }
    if (typeof out.tokens === "number" && Number.isFinite(out.tokens)) tokens += out.tokens;
  }

  const rows: BenchmarkIngestRow[] = input.chunks.map((chunk, i) => ({
    tenant_id: input.tenantId,
    chunk_id: chunk.chunk_id,
    provider: "jina",
    model: BENCHMARK_JINA_EMBED_MODEL,
    dimensions: BENCHMARK_INGEST_DIMENSIONS,
    embedding: vectors[i],
    benchmark_run_id: input.runId,
  }));
  await input.insertRows(rows);
  return { ok: true, embedded: rows.length, requests, tokens };
}
