// Unit tests for the production rerank helper. Pure fixtures and injected
// mocks; no network, database, or provider calls.
// Run: deno test supabase/functions/_shared/rerank_test.ts

import {
  buildRerankRequest,
  callReranker,
  mapRerankedPool,
  parseRerankResponse,
  RERANK_ENDPOINT,
  RERANK_MODEL,
} from "./rerank.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
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

function okJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function readBody(call: MockCall): Record<string, unknown> {
  assert(typeof call.init?.body === "string", "mock request has a JSON body");
  return JSON.parse(call.init?.body as string) as Record<string, unknown>;
}

function rerankResponse(indexes: number[], model = RERANK_MODEL) {
  return {
    model,
    object: "list",
    usage: { total_tokens: 42 },
    results: indexes.map((index, position) => ({
      index,
      relevance_score: 0.9 - position / 10,
    })),
  };
}

Deno.test("rerank: request sends question plus candidate text only", () => {
  const built = buildRerankRequest({
    query: "What is the lock-in period?",
    documents: ["passage one", "passage two", "passage three"],
    topN: 2,
    maxCandidates: 50,
  });
  assert(built.ok, "request builds");
  if (!built.ok) return;
  assertEquals(built.request, {
    model: "jina-reranker-v3.5",
    query: "What is the lock-in period?",
    documents: ["passage one", "passage two", "passage three"],
    top_n: 2,
    return_documents: false,
  }, "request shape");
});

Deno.test("rerank: invalid inputs rejected before any call", () => {
  assert(!buildRerankRequest({ query: "", documents: ["a"], topN: 1, maxCandidates: 50 }).ok, "empty query");
  assert(!buildRerankRequest({ query: "q", documents: [], topN: 1, maxCandidates: 50 }).ok, "empty pool");
  assert(!buildRerankRequest({ query: "q", documents: ["a"], topN: 2, maxCandidates: 50 }).ok, "topN above pool");
  assert(!buildRerankRequest({ query: "q", documents: ["a", "b"], topN: 1, maxCandidates: 1 }).ok, "over cap");
});

Deno.test("rerank: transport posts to the Jina endpoint with a bearer key", async () => {
  const mock = mockFetch(() => okJson(rerankResponse([1, 0])));
  const result = await callReranker({
    fetchFn: mock.fn,
    apiKey: "test-key",
    query: "q",
    documents: ["a", "b"],
    topN: 2,
    maxCandidates: 50,
    timeoutMs: 1000,
  });
  assert(result.ok, "transport succeeds");
  assertEquals(mock.calls(), 1, "one call");
  const call = mock.seen()[0];
  assertEquals(call.url, RERANK_ENDPOINT, "endpoint");
  assertEquals((call.init?.headers as Record<string, string>)["Authorization"], "Bearer test-key", "bearer");
  const body = readBody(call);
  assertEquals(body["model"], RERANK_MODEL, "model");
  assertEquals(body["top_n"], 2, "top_n");
});

Deno.test("rerank: ordered results parse with usage passthrough", () => {
  const parsed = parseRerankResponse(rerankResponse([2, 0, 1]), 3, 3);
  assert(parsed.ok, "parses");
  if (!parsed.ok) return;
  assertEquals(parsed.ranked.map((r) => r.inputIndex), [2, 0, 1], "order");
  assertEquals(parsed.usageTokens, 42, "usage");
});

Deno.test("rerank: wrong model, bad indexes, bad scores rejected", () => {
  const base = { model: RERANK_MODEL };
  assert(!parseRerankResponse({ ...base, results: [] }, 2, 2).ok, "count mismatch");
  assert(!parseRerankResponse({ model: "other", results: [{ index: 0, relevance_score: 1 }] }, 1, 1).ok, "model");
  assert(!parseRerankResponse(
    { ...base, results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0.5 }] }, 2, 2,
  ).ok, "duplicate");
  assert(!parseRerankResponse({ ...base, results: [{ index: 9, relevance_score: 1 }] }, 2, 1).ok, "range");
  assert(!parseRerankResponse({ ...base, results: [{ index: 0, relevance_score: Number.NaN }] }, 1, 1).ok, "score");
});

Deno.test("rerank: 429 and timeouts fail once without retry", async () => {  const limited = mockFetch(() => new Response("limited", { status: 429 }));
  const limitedResult = await callReranker({
    fetchFn: limited.fn, apiKey: "k", query: "q", documents: ["a"], topN: 1, maxCandidates: 50, timeoutMs: 500,
  });
  assert(!limitedResult.ok, "429 fails");
  assertEquals(limited.calls(), 1, "no retry");
  const hanging = mockFetch(() => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })));
  const timedOut = await callReranker({
    fetchFn: hanging.fn, apiKey: "k", query: "q", documents: ["a"], topN: 1, maxCandidates: 50, timeoutMs: 50,
  });
  assert(!timedOut.ok, "timeout fails");
  if (!timedOut.ok) assertEquals(timedOut.kind, "timeout", "timeout kind");
});

Deno.test("rerank: pool mapping preserves order and rejects mismatch", () => {
  const pool = ["a", "b", "c"];
  assertEquals(
    mapRerankedPool(pool, [{ inputIndex: 2 }, { inputIndex: 0 }]),
    ["c", "a"],
    "reranked order",
  );
  assertEquals(mapRerankedPool(pool, []), null, "empty ranking");
  assertEquals(
    mapRerankedPool(pool, [{ inputIndex: 0 }, { inputIndex: 0 }]),
    null,
    "duplicate index",
  );
  assertEquals(mapRerankedPool(pool, [{ inputIndex: 3 }]), null, "out of range");
  assertEquals(
    mapRerankedPool(pool, [{ inputIndex: 0 }, { inputIndex: 1 }, { inputIndex: 2 }, { inputIndex: 0 }]),
    null,
    "overlong ranking",
  );
});
