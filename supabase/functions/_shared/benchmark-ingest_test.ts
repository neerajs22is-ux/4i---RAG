// Unit tests for benchmark-only passage-embedding population. Pure fixtures
// and injected I/O; no network, database, provider calls, or writes.
// Run: deno test supabase/functions/_shared/benchmark-ingest_test.ts

import {
  BENCHMARK_INGEST_MAX_CHUNKS,
  ingestBenchmarkEmbeddings,
  type BenchmarkIngestRow,
} from "./benchmark-ingest.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

function chunks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    chunk_id: `chunk-${i}`,
    content: `benchmark content ${i} with stable fixture text`,
  }));
}

function vector(): number[] {
  return new Array(1024).fill(0.125);
}

Deno.test("benchmark ingest: invalid inputs fail with zero side effects", async () => {
  let embeds = 0;
  let inserts = 0;
  const io = {
    embedBatch: (inputs: string[]) => {
      embeds++;
      return Promise.resolve({ vectors: inputs.map(() => vector()), tokens: 1 });
    },
    insertRows: (_rows: BenchmarkIngestRow[]) => {
      inserts++;
      return Promise.resolve();
    },
  };
  const invoke = (over: {
    runId?: string;
    tenantId?: string;
    chunks?: Array<{ chunk_id: string; content: string }>;
  }) =>
    ingestBenchmarkEmbeddings({
      tenantId: "tenant-benchmark",
      runId: "ok-run",
      chunks: chunks(2),
      embedBatch: io.embedBatch,
      insertRows: io.insertRows,
      ...over,
    });
  assert(!(await invoke({ runId: "bad run!" })).ok, "run id");
  assert(!(await invoke({ chunks: [] })).ok, "empty");
  assert(!(await invoke({ chunks: chunks(65) })).ok, "over bound");
  assert(!(await invoke({ chunks: [{ chunk_id: "c", content: "  " }] })).ok, "blank content");
  assert(!(await invoke({ tenantId: " " })).ok, "tenant");
  assertEquals(embeds, 0, "no embedding calls");
  assertEquals(inserts, 0, "no writes");
  assertEquals(BENCHMARK_INGEST_MAX_CHUNKS, 64, "per-call bound");
});

Deno.test("benchmark ingest: batches preserve order and insert once with fixed identity", async () => {
  const batches: string[][] = [];
  let inserted: BenchmarkIngestRow[] = [];
  const result = await ingestBenchmarkEmbeddings({
    tenantId: "tenant-benchmark",
    runId: "run-1",
    chunks: chunks(40),
    embedBatch: (inputs) => {
      batches.push([...inputs]);
      return Promise.resolve({ vectors: inputs.map(() => vector()), tokens: inputs.length });
    },
    insertRows: (rows) => {
      inserted = rows;
      return Promise.resolve();
    },
  });
  assert(result.ok, "ingest succeeds");
  if (!result.ok) return;
  assertEquals(result.embedded, 40, "embedded count");
  assertEquals(result.requests, 2, "batch count");
  assertEquals(batches.map((b) => b.length), [32, 8], "batch sizes");
  assertEquals(batches.flat().length, 40, "no drops");
  assertEquals(inserted.length, 40, "single insert of all rows");
  assertEquals(inserted.map((r) => r.chunk_id), chunks(40).map((c) => c.chunk_id), "row order");
  const first = inserted[0];
  assertEquals(
    { tenant_id: first.tenant_id, provider: first.provider, model: first.model, dimensions: first.dimensions, benchmark_run_id: first.benchmark_run_id },
    { tenant_id: "tenant-benchmark", provider: "jina", model: "jina-embeddings-v5-text-small", dimensions: 1024, benchmark_run_id: "run-1" },
    "fixed benchmark identity",
  );
  assertEquals(result.tokens, 40, "token accounting");
});

Deno.test("benchmark ingest: batch failure leaves zero rows behind", async () => {
  let inserts = 0;
  let calls = 0;
  const result = await ingestBenchmarkEmbeddings({
    tenantId: "tenant-benchmark",
    runId: "run-1",
    chunks: chunks(40),
    embedBatch: (inputs) => {
      calls++;
      if (calls > 1) return Promise.reject(new Error("rate_limited"));
      return Promise.resolve({ vectors: inputs.map(() => vector()), tokens: 1 });
    },
    insertRows: () => {
      inserts++;
      return Promise.resolve();
    },
  });
  assert(!result.ok, "failure surfaces");
  assertEquals(inserts, 0, "no partial writes");
});

Deno.test("benchmark ingest: malformed vectors fail with zero rows behind", async () => {
  let inserts = 0;
  const bad = vector();
  bad[0] = Number.NaN;
  const result = await ingestBenchmarkEmbeddings({
    tenantId: "tenant-benchmark",
    runId: "run-1",
    chunks: chunks(2),
    embedBatch: (inputs) => Promise.resolve({ vectors: inputs.map(() => bad), tokens: 1 }),
    insertRows: () => {
      inserts++;
      return Promise.resolve();
    },
  });
  assert(!result.ok, "non-finite rejected");
  assertEquals(inserts, 0, "no writes");
});

Deno.test("benchmark ingest: module has no production read/write path", async () => {
  const text = await Deno.readTextFile(new URL("./benchmark-ingest.ts", import.meta.url));
  for (const forbidden of [
    'from "../ask',
    'from "../query-chunks',
    'from "../embed-worker',
    'from "../ingest-pdf',
    "VOYAGE_API_KEY",
    "VOYAGE_ENDPOINT",
    "VOYAGE_MODEL",
    'rpc("match_chunks"',
    'from("chunks")',
    'from("documents")',
    'from("conversations")',
    'from("messages")',
    'from("ingest_jobs")',
  ]) {
    assert(!text.includes(forbidden), `benchmark-ingest must not contain ${forbidden}`);
  }
  assert(text.includes("benchmark_embeddings"), "writes target the benchmark partition");
});
