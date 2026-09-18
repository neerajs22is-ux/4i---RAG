// Unit tests for benchmark-only reranking. Pure fixtures and injected mocks;
// no network, database, provider calls, or benchmark execution.
// Run: deno test supabase/functions/_shared/benchmark-rerank_test.ts

import {
  applyBenchmarkRerankMode,
  BENCHMARK_FINAL_K,
  BENCHMARK_MAX_RERANK_CANDIDATES,
  BENCHMARK_RERANK_API_KEY_ENV,
  BENCHMARK_RERANK_ENDPOINT,
  BENCHMARK_RERANK_MODEL,
  BENCHMARK_RETRIEVAL,
  buildBenchmarkRerankRequest,
  callBenchmarkRerank,
  parseBenchmarkRerankResponse,
  renumberBenchmarkCitations,
  type BenchmarkCandidatePool,
} from "./benchmark-rerank.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

function pool(count = 10): BenchmarkCandidatePool {
  return {
    question: "What benchmark text is relevant?",
    tenantId: "tenant-benchmark",
    vectorSpace: { provider: "benchmark-fixture", model: "fixture-deterministic", dimensions: 0 },
    candidates: Array.from({ length: count }, (_, i) => ({
      poolIndex: i,
      chunk_id: `chunk-${i}`,
      document_id: `doc-${Math.floor(i / 4)}`,
      tenant_id: "tenant-benchmark",
      file_name: `file-${Math.floor(i / 4)}.pdf`,
      page: i % 3 === 2 ? null : i + 1,
      content: `benchmark passage ${i} with stable fixture text`,
      fused_score: 100 - i,
      fused_rank: i + 1,
    })),
  };
}

function responseFor(indexes: number[], scores: number[]) {
  return {
    model: BENCHMARK_RERANK_MODEL,
    object: "list",
    usage: { total_tokens: 123 },
    results: indexes.map((index, position) => ({
      index,
      relevance_score: scores[position],
      document: `provider echo ${index}`,
    })),
  };
}

type MockCall = { url: string; init: RequestInit | undefined };
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  let calls = 0;
  const seen: MockCall[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls++;
    seen.push({ url, init });
    return await handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls, seen: () => seen };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function readBody(call: MockCall): Record<string, unknown> {
  assert(typeof call.init?.body === "string", "mock request has a JSON body");
  return JSON.parse(call.init?.body as string) as Record<string, unknown>;
}

Deno.test("benchmark rerank: locked retrieval constants and isolated provider names", () => {
  assertEquals(BENCHMARK_RETRIEVAL.dense, 20, "dense candidates");
  assertEquals(BENCHMARK_RETRIEVAL.lexical, 20, "lexical candidates");
  assertEquals(BENCHMARK_RETRIEVAL.candidateCap, 50, "candidate cap");
  assertEquals(BENCHMARK_RETRIEVAL.rrfK, 60, "RRF K");
  assertEquals(BENCHMARK_FINAL_K, 8, "final evidence K");
  assertEquals(BENCHMARK_MAX_RERANK_CANDIDATES, 50, "rerank pool cap");
  assertEquals(BENCHMARK_RERANK_MODEL, "jina-reranker-v3.5", "benchmark rerank model");
  assertEquals(BENCHMARK_RERANK_ENDPOINT, "https://api.jina.ai/v1/rerank", "rerank endpoint");
  assert(
    String(BENCHMARK_RERANK_API_KEY_ENV) === "JINA_API_KEY" &&
      String(BENCHMARK_RERANK_API_KEY_ENV) !== "VOYAGE_API_KEY",
    "single shared benchmark key name, never Voyage",
  );
});

Deno.test("benchmark rerank: request construction sends text only and top_n=8", () => {
  const built = buildBenchmarkRerankRequest(pool(10), 8);
  assert(built.ok, "request builds");
  if (!built.ok) return;
  assertEquals(built.request.model, BENCHMARK_RERANK_MODEL, "model");
  assertEquals(built.request.top_n, 8, "top_n");
  assertEquals(built.request.return_documents, false, "do not request echoed documents");
  assertEquals(built.request.documents.length, 10, "all candidates sent");
  assertEquals(built.request.requestOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "input order preserved");
  assertEquals(built.request.documents[3], "benchmark passage 3 with stable fixture text", "semantic input is chunk text");
});

Deno.test("benchmark rerank: provider transport uses Jina rerank fields only", async () => {
  const built = buildBenchmarkRerankRequest(pool(10), 8);
  assert(built.ok, "request builds");
  if (!built.ok) return;
  const mock = mockFetch(() => jsonResponse(responseFor([0], [0.9])));
  const result = await callBenchmarkRerank({
    fetchFn: mock.fn,
    apiKey: "benchmark-test-key",
    query: built.request.query,
    documents: built.request.documents.slice(0, 1),
    topN: 1,
    timeoutMs: 1000,
  });
  assert(result.ok, "transport succeeds");
  assertEquals(mock.calls(), 1, "one benchmark call");
  const call = mock.seen()[0];
  assertEquals(call.url, BENCHMARK_RERANK_ENDPOINT, "Jina endpoint");
  assertEquals(call.init?.method, "POST", "method");
  assertEquals((call.init?.headers as Record<string, string>)["Authorization"], "Bearer benchmark-test-key", "bearer key");
  const body = readBody(call);
  assertEquals(
    Object.keys(body).sort(),
    ["documents", "model", "query", "return_documents", "top_n"].sort(),
    "benchmark-only request fields",
  );
  const serialized = JSON.stringify(body);
  for (const forbidden of ["input_type", "output_dimension", "voyage", "match_chunks", "/ask", "/query-chunks"]) {
    assert(!serialized.includes(forbidden), `request must not contain ${forbidden}`);
  }
});

Deno.test("benchmark rerank: parses ordered Jina results and preserves usage", () => {
  const parsed = parseBenchmarkRerankResponse(responseFor([3, 1, 0], [0.91, 0.72, 0.55]), 4, 3);
  assert(parsed.ok, "response parses");
  if (!parsed.ok) return;
  assertEquals(parsed.parsed.ranked.map((r) => r.inputIndex), [3, 1, 0], "provider order preserved");
  assertEquals(parsed.parsed.ranked.map((r) => r.relevanceScore), [0.91, 0.72, 0.55], "scores preserved");
  assertEquals(parsed.parsed.usageTokens, 123, "usage passes through");
});

Deno.test("benchmark rerank: wrong model is rejected", () => {
  const parsed = parseBenchmarkRerankResponse({ model: "another-model", results: [] }, 4, 3);
  assert(!parsed.ok, "wrong model rejected");
});

Deno.test("benchmark rerank: missing results are rejected", () => {
  const parsed = parseBenchmarkRerankResponse({ model: BENCHMARK_RERANK_MODEL }, 4, 3);
  assert(!parsed.ok, "missing results rejected");
});

Deno.test("benchmark rerank: invalid and duplicate indexes are rejected", () => {
  const base = { model: BENCHMARK_RERANK_MODEL };
  assert(!parseBenchmarkRerankResponse({ ...base, results: [{ index: 1.5, relevance_score: 0.5 }] }, 4, 1).ok, "non-integer index");
  assert(!parseBenchmarkRerankResponse({ ...base, results: [{ index: 4, relevance_score: 0.5 }] }, 4, 1).ok, "out-of-range index");
  assert(
    !parseBenchmarkRerankResponse({
      ...base,
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.8 },
      ],
    }, 4, 2).ok,
    "duplicate index",
  );
});

Deno.test("benchmark rerank: invalid relevance scores are rejected", () => {
  const base = { model: BENCHMARK_RERANK_MODEL };
  assert(!parseBenchmarkRerankResponse({ ...base, results: [{ index: 0, relevance_score: "high" }] }, 4, 1).ok, "string score");
  assert(!parseBenchmarkRerankResponse({ ...base, results: [{ index: 0, relevance_score: Number.POSITIVE_INFINITY }] }, 4, 1).ok, "infinite score");
  assert(!parseBenchmarkRerankResponse({ ...base, results: [{ index: 0, relevance_score: Number.NaN }] }, 4, 1).ok, "NaN score");
});

Deno.test("benchmark rerank: result-count mismatch is rejected", () => {
  const short = parseBenchmarkRerankResponse(responseFor([0, 1], [0.9, 0.8]), 10, 8);
  assert(!short.ok, "fewer than requested results rejected");
  const smallPoolMismatch = parseBenchmarkRerankResponse(responseFor([0, 1, 2, 3], [0.9, 0.8, 0.7, 0.6]), 5, 8);
  assert(!smallPoolMismatch.ok, "small-pool count mismatch rejected");
});

Deno.test("benchmark rerank: top_n behavior preserves final K", () => {
  const large = buildBenchmarkRerankRequest(pool(10), 8);
  assert(large.ok && large.request.top_n === 8, "ten candidates request top eight");
  const small = buildBenchmarkRerankRequest(pool(5), 8);
  assert(small.ok && small.request.top_n === 5, "smaller pool requests all candidates");
  assert(!buildBenchmarkRerankRequest(pool(10), 9).ok, "top_n above final K rejected");
  assert(!buildBenchmarkRerankRequest(pool(10), 0).ok, "non-positive top_n rejected");
});

Deno.test("benchmark rerank: provenance survives reranking and input is unchanged", async () => {
  const input = pool(6);
  const before = JSON.parse(JSON.stringify(input)) as BenchmarkCandidatePool;
  const reversed = await applyBenchmarkRerankMode({
    pool: input,
    mode: "rerank",
    topN: 4,
    rerank: () => Promise.resolve({
      ok: true,
      parsed: {
        model: BENCHMARK_RERANK_MODEL,
        usageTokens: 9,
        ranked: [3, 2, 1, 0].map((index) => ({ inputIndex: index, relevanceScore: 1 - index / 10 })),
      },
    }),
  });
  assert(reversed.ok, "rerank applies");
  if (!reversed.ok) return;
  assertEquals(reversed.evidence.map((e) => e.poolIndex), [3, 2, 1, 0], "order follows reranker");
  assertEquals(reversed.evidence.map((e) => e.chunk_id), ["chunk-3", "chunk-2", "chunk-1", "chunk-0"], "chunk identity preserved");
  assertEquals(reversed.evidence[0].content, "benchmark passage 3 with stable fixture text", "text preserved");
  assertEquals(reversed.evidence[0].evidenceOrder, 1, "evidence order rebuilt");
  assert(!("embedding" in reversed.evidence[0]), "no vector is introduced");
  assertEquals(JSON.parse(JSON.stringify(input)), before, "candidate pool is immutable");
});

Deno.test("benchmark rerank: no-rerank path is deterministic and never calls the provider", async () => {
  const input = pool(10);
  const outcome = await applyBenchmarkRerankMode({
    pool: input,
    mode: "no-rerank",
    topN: 8,
    rerank: () => Promise.reject(new Error("provider must not run in no-rerank mode")),
  });
  assert(outcome.ok, "no-rerank applies");
  if (!outcome.ok) return;
  assertEquals(outcome.evidence.map((e) => e.poolIndex), [0, 1, 2, 3, 4, 5, 6, 7], "input order retained");
  assert(outcome.evidence.every((e) => e.relevanceScore === null), "no synthetic score");
  assertEquals(outcome.request, null, "no provider request");
  assertEquals(outcome.usageTokens, null, "no provider usage");
});

Deno.test("benchmark rerank: A/B modes receive the same pool and differ only by order", async () => {
  const input = pool(8);
  const without = await applyBenchmarkRerankMode({
    pool: input,
    mode: "no-rerank",
    rerank: () => Promise.reject(new Error("provider must not run in no-rerank mode")),
  });
  let providerCalls = 0;
  let providerDocuments: string[] = [];
  const withRerank = await applyBenchmarkRerankMode({
    pool: input,
    mode: "rerank",
    rerank: (request) => {
      providerCalls++;
      providerDocuments = request.documents;
      return Promise.resolve({
        ok: true,
        parsed: {
          model: BENCHMARK_RERANK_MODEL,
          usageTokens: null,
          ranked: [7, 6, 5, 4, 3, 2, 1, 0].map((index) => ({ inputIndex: index, relevanceScore: index })),
        },
      });
    },
  });
  assert(without.ok && withRerank.ok, "both modes apply");
  if (!without.ok || !withRerank.ok) return;
  assertEquals(providerCalls, 1, "rerank provider called once");
  assertEquals(providerDocuments, input.candidates.map((c) => c.content), "same candidate texts enter the provider");
  assertEquals(
    [...without.evidence.map((e) => e.chunk_id)].sort(),
    [...withRerank.evidence.map((e) => e.chunk_id)].sort(),
    "same candidate identities in both modes",
  );
  assertEquals(without.evidence.map((e) => e.chunk_id)[0], "chunk-0", "control order");
  assertEquals(withRerank.evidence.map((e) => e.chunk_id)[0], "chunk-7", "reranked order");
});

Deno.test("benchmark rerank: citations are renumbered from reranked evidence", () => {
  const input = pool(4);
  const evidence = [3, 0, 2, 1].map((position, order) => {
    const { poolIndex: sourcePoolIndex, ...candidate } = input.candidates[position];
    return {
      evidenceOrder: order + 1,
      poolIndex: sourcePoolIndex,
      relevanceScore: 0.9 - order / 10,
      ...candidate,
    };
  });
  const citations = renumberBenchmarkCitations(evidence);
  assertEquals(citations.map((c) => c.n), [1, 2, 3, 4], "positional citation numbers");
  assertEquals(citations.map((c) => c.chunk_id), ["chunk-3", "chunk-0", "chunk-2", "chunk-1"], "citation identity follows order");
  assertEquals(citations[1].page, input.candidates[0].page, "page provenance preserved");
});

Deno.test("benchmark rerank: mixed tenants or vector spaces are rejected", async () => {
  const tenantMix = pool(3);
  tenantMix.candidates[1] = { ...tenantMix.candidates[1], tenant_id: "other-tenant" };
  assert(!(await applyBenchmarkRerankMode({ pool: tenantMix, mode: "no-rerank" })).ok, "tenant mix rejected");
  const modelMix = pool(3);
  assert(
    !(await applyBenchmarkRerankMode({
      pool: { ...modelMix, vectorSpace: { provider: "", model: "", dimensions: -1 } },
      mode: "no-rerank",
    })).ok,
    "invalid vector-space metadata rejected",
  );
});

Deno.test("benchmark rerank: 429 is a single benchmark failure, never a retry", async () => {
  const mock = mockFetch(() => new Response("limited", { status: 429 }));
  const result = await callBenchmarkRerank({
    fetchFn: mock.fn,
    apiKey: "benchmark-test-key",
    query: "What benchmark text is relevant?",
    documents: ["one", "two"],
    topN: 2,
    timeoutMs: 1000,
  });
  assert(!result.ok, "429 fails");
  if (result.ok) return;
  assertEquals(result.kind, "rate_limited", "429 mapped");
  assertEquals(result.status, 429, "status preserved");
  assertEquals(mock.calls(), 1, "no retry");
});

Deno.test("benchmark rerank: aborted calls are reported as timeouts", async () => {
  const mock = mockFetch(() => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  const result = await callBenchmarkRerank({
    fetchFn: mock.fn,
    apiKey: "benchmark-test-key",
    query: "What benchmark text is relevant?",
    documents: ["one"],
    topN: 1,
    timeoutMs: 50,
  });
  assert(!result.ok, "abort fails");
  if (result.ok) return;
  assertEquals(result.kind, "timeout", "abort mapped");
});
