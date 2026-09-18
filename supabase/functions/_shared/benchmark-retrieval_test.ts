// Unit tests for the benchmark-only retrieval mirror. Pure fixtures, static
// contract checks, and injected fakes; no network, database, provider calls,
// or benchmark execution.
// Run: deno test supabase/functions/_shared/benchmark-retrieval_test.ts

import {
  applyBenchmarkRetrievalMode,
  benchmarkRankFused,
  benchmarkRrfFuse,
  BENCHMARK_CANDIDATE_CAP,
  BENCHMARK_DENSE_N,
  BENCHMARK_LEX_N,
  BENCHMARK_RRF_K,
  resolveBenchmarkScope,
  toBenchmarkRerankPool,
  type BenchmarkRetrievalRow,
} from "./benchmark-retrieval.ts";
import { BENCHMARK_FINAL_K, BENCHMARK_RERANK_MODEL } from "./benchmark-rerank.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

function row(over: Partial<BenchmarkRetrievalRow> & { chunk_id: string }): BenchmarkRetrievalRow {
  return {
    document_id: "doc-1",
    tenant_id: "tenant-benchmark",
    file_name: "file.pdf",
    page: 1,
    content: `content ${over.chunk_id}`,
    dense_score: null,
    dense_rank: null,
    lex_score: null,
    lex_rank: null,
    channel: "dense",
    ...over,
  };
}

const MIGRATION_URL = new URL("../../migrations/20260918000000_benchmark_embeddings.sql", import.meta.url);
const SHARED_DIR = new URL("./", import.meta.url);

async function readText(url: URL): Promise<string> {
  return await Deno.readTextFile(url);
}

Deno.test("benchmark retrieval: locked selection constants", () => {
  assertEquals(BENCHMARK_DENSE_N, 20, "dense candidates");
  assertEquals(BENCHMARK_LEX_N, 20, "lexical candidates");
  assertEquals(BENCHMARK_CANDIDATE_CAP, 50, "candidate cap");
  assertEquals(BENCHMARK_RRF_K, 60, "RRF K");
  assertEquals(BENCHMARK_FINAL_K, 8, "final K");
});

Deno.test("benchmark retrieval: RRF fusion and deterministic tie-break", () => {
  const rows = [
    row({ chunk_id: "b", dense_rank: 2, dense_score: 0.5, channel: "dense" }),
    row({ chunk_id: "a", dense_rank: 2, dense_score: 0.9, channel: "dense" }),
    row({ chunk_id: "a", lex_rank: 1, lex_score: 3, channel: "lexical" }),
  ];
  const ranked = benchmarkRankFused(benchmarkRrfFuse(rows));
  assertEquals(ranked.map((r) => r.id), ["a", "b"], "fused order");
  const tied = benchmarkRankFused(benchmarkRrfFuse([
    row({ chunk_id: "z", dense_rank: 1, dense_score: 1, channel: "dense" }),
    row({ chunk_id: "a", dense_rank: 1, dense_score: 1, channel: "dense" }),
  ]));
  assertEquals(tied.map((r) => r.id), ["a", "z"], "chunk_id tie-break");
});

Deno.test("benchmark retrieval: scope union and unscoped persistent exclusion", () => {
  const unioned = resolveBenchmarkScope({
    notebookRequested: true,
    notebookDocIds: ["n1"],
    tempDocIds: ["t1"],
    unscopedPersistentIds: null,
    validatedDocIds: null,
  });
  assertEquals(unioned.allowedDocIds, ["n1", "t1"], "notebook plus temp union");
  assertEquals(unioned.scopeEmpty, false, "scope not empty");

  const empty = resolveBenchmarkScope({
    notebookRequested: true,
    notebookDocIds: [],
    tempDocIds: [],
    unscopedPersistentIds: null,
    validatedDocIds: null,
  });
  assertEquals(empty.scopeEmpty, true, "empty notebook scope");
  assertEquals(empty.allowedDocIds, [], "empty list, not null");

  const excluded = resolveBenchmarkScope({
    notebookRequested: false,
    notebookDocIds: null,
    tempDocIds: [],
    unscopedPersistentIds: ["p1", "p2"],
    validatedDocIds: null,
  });
  assertEquals(excluded.allowedDocIds, ["p1", "p2"], "explicit persistent set");
  assertEquals(excluded.scopeEmpty, false, "unscoped is not an empty scope");

  const legacy = resolveBenchmarkScope({
    notebookRequested: false,
    notebookDocIds: null,
    tempDocIds: [],
    unscopedPersistentIds: null,
    validatedDocIds: null,
  });
  assertEquals(legacy.allowedDocIds, null, "legacy unscoped path");
});

Deno.test("benchmark retrieval: validated direct lists win over notebook absence", () => {
  const direct = resolveBenchmarkScope({
    notebookRequested: false,
    notebookDocIds: null,
    tempDocIds: ["t9"],
    unscopedPersistentIds: null,
    validatedDocIds: ["d1"],
  });
  assertEquals(direct.allowedDocIds, ["d1", "t9"], "direct union with temp");
});

Deno.test("benchmark retrieval: pool adapter preserves provenance for the reranker", () => {
  const ranked = benchmarkRankFused(benchmarkRrfFuse([
    row({ chunk_id: "a", dense_rank: 1, dense_score: 0.9, channel: "dense" }),
    row({ chunk_id: "b", lex_rank: 1, lex_score: 2, channel: "lexical" }),
  ]));
  const pool = toBenchmarkRerankPool({
    question: "q",
    tenantId: "tenant-benchmark",
    vectorSpace: { provider: "jina", model: "jina-embeddings-v5-text-small", dimensions: 1024 },
    ranked,
  });
  assertEquals(pool.candidates.map((c) => c.chunk_id), ["a", "b"], "fused order becomes pool order");
  assertEquals(pool.candidates[0].fused_rank, 1, "fused rank preserved");
  assert(pool.candidates.every((c) => c.tenant_id === "tenant-benchmark"), "tenant provenance");
});

Deno.test("benchmark retrieval: A/B modes share one pool and rerank only order", async () => {
  const ranked = benchmarkRankFused(benchmarkRrfFuse(
    Array.from({ length: 10 }, (_, i) =>
      row({ chunk_id: `c${i}`, dense_rank: i + 1, dense_score: 1 / (i + 1), channel: "dense" })),
  ));
  const pool = toBenchmarkRerankPool({
    question: "q",
    tenantId: "tenant-benchmark",
    vectorSpace: { provider: "jina", model: "jina-embeddings-v5-text-small", dimensions: 1024 },
    ranked,
  });
  const plain = await applyBenchmarkRetrievalMode({
    pool, mode: "no-rerank", denseCount: 10, lexicalCount: 0,
  });
  const reranked = await applyBenchmarkRetrievalMode({
    pool,
    mode: "rerank",
    denseCount: 10,
    lexicalCount: 0,
    rerank: () => Promise.resolve({
      ok: true,
      parsed: {
        model: BENCHMARK_RERANK_MODEL,
        usageTokens: null,
        ranked: [7, 6, 5, 4, 3, 2, 1, 0].map((index) => ({ inputIndex: index, relevanceScore: index })),
      },
    }),
  });
  assert(plain.ok && reranked.ok, "both modes apply");
  if (!plain.ok || !reranked.ok) return;
  assertEquals(plain.evidence.length, 8, "final K without rerank");
  assertEquals(reranked.evidence.length, 8, "final K with rerank");
  assertEquals(
    [...plain.citations.map((c) => c.chunk_id)].sort(),
    [...reranked.citations.map((c) => c.chunk_id)].sort(),
    "same evidence identities before rerank ordering",
  );
  assertEquals(plain.citations.map((c) => c.n), [1, 2, 3, 4, 5, 6, 7, 8], "positional citations");
  assertEquals(reranked.citations.map((c) => c.n), [1, 2, 3, 4, 5, 6, 7, 8], "renumbered citations");
  assertEquals(reranked.citations[0].chunk_id, "c7", "reranked citation order");
});

Deno.test("benchmark storage: migration is additive and benchmark-scoped", async () => {
  const sql = await readText(MIGRATION_URL);
  for (const required of [
    "create table if not exists public.benchmark_embeddings",
    "embedding vector(1024) not null",
    "unique (tenant_id, chunk_id, provider, model, benchmark_run_id)",
    "benchmark_embeddings_hnsw_idx",
    "enable row level security",
    "benchmark_embeddings_select_members",
    "private.is_tenant_member(tenant_id)",
    "create or replace function public.benchmark_match_chunks(",
    "p_benchmark_run_id",
    "grant execute on function public.benchmark_match_chunks",
  ]) {
    assert(sql.includes(required), `migration contains ${required}`);
  }
  for (const forbidden of [
    "alter table public.chunks",
    "alter table public.documents",
    "drop function if exists public.match_chunks",
    "create or replace function public.match_chunks(",
    "VOYAGE_API_KEY",
    "JINA_EMBED_API_KEY=",
    "JINA_RERANK_API_KEY=",
  ]) {
    assert(!sql.includes(forbidden), `migration must not contain ${forbidden}`);
  }
});

Deno.test("benchmark storage: retrieval contract mirrors production selection bounds", async () => {
  const sql = await readText(MIGRATION_URL);
  assert(sql.includes("limit greatest(1, least(50, p_dense_n))"), "dense bound");
  assert(sql.includes("limit greatest(1, least(50, p_lex_n))"), "lexical bound");
  assert(sql.includes("security invoker"), "caller RLS preserved");
  assert(sql.includes("benchmark_embeddings") && sql.includes("public.chunks as c"), "benchmark dense plus existing lexical source");
  assert(!sql.includes('rpc("match_chunks"'), "no production RPC call in SQL");
});

Deno.test("benchmark isolation: benchmark code has no production import or call path", async () => {
  const files = [
    new URL("./benchmark-jina-embed.ts", SHARED_DIR),
    new URL("./benchmark-retrieval.ts", SHARED_DIR),
    new URL("../benchmark-retrieval/index.ts", SHARED_DIR),
  ];
  for (const url of files) {
    const text = await readText(url);
    for (const forbidden of [
      'from "../ask',
      'from "../query-chunks',
      'from "../embed-worker',
      'from "../ingest-pdf',
      "VOYAGE_API_KEY",
      "VOYAGE_ENDPOINT",
      "VOYAGE_MODEL",
      'rpc("match_chunks"',
    ]) {
      assert(!text.includes(forbidden), `${url.pathname} must not contain ${forbidden}`);
    }
  }
  const edge = await readText(new URL("../benchmark-retrieval/index.ts", SHARED_DIR));
  assert(edge.includes('rpc("benchmark_match_chunks"'), "benchmark RPC is the only retrieval call");
  assert(!edge.includes("chunks.embedding"), "benchmark retrieval never reads production vectors");
});
