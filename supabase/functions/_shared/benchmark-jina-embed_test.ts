// Unit tests for the benchmark-only Jina embedding adapter. Pure fixtures
// and injected mocks; no network, database, provider calls, or benchmark
// execution. Run: deno test supabase/functions/_shared/benchmark-jina-embed_test.ts

import {
  BENCHMARK_JINA_BATCH_DEFAULTS,
  BENCHMARK_JINA_EMBED_API_KEY_ENV,
  BENCHMARK_JINA_EMBED_DIMENSIONS,
  BENCHMARK_JINA_EMBED_ENDPOINT,
  BENCHMARK_JINA_EMBED_MODEL,
  BENCHMARK_JINA_TASK_PASSAGE,
  BENCHMARK_JINA_TASK_QUERY,
  buildBenchmarkJinaEmbedRequest,
  callBenchmarkJinaEmbed,
  parseBenchmarkJinaEmbedResponse,
  planBenchmarkJinaBatches,
} from "./benchmark-jina-embed.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

function vector(dimensions = BENCHMARK_JINA_EMBED_DIMENSIONS): number[] {
  return new Array(dimensions).fill(0.25);
}

function embedResponse(count: number, model = BENCHMARK_JINA_EMBED_MODEL) {
  return {
    object: "list",
    data: Array.from({ length: count }, (_, i) => ({
      object: "embedding",
      embedding: vector(),
      index: i,
    })),
    model,
    usage: { prompt_tokens: 10 * count, total_tokens: 12 * count },
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

function okJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function readBody(call: MockCall): Record<string, unknown> {
  assert(typeof call.init?.body === "string", "mock request has a JSON body");
  return JSON.parse(call.init?.body as string) as Record<string, unknown>;
}

Deno.test("jina embed: locked model, endpoint, and separated key name", () => {
  assertEquals(BENCHMARK_JINA_EMBED_MODEL, "jina-embeddings-v5-text-small", "model");
  assertEquals(BENCHMARK_JINA_EMBED_ENDPOINT, "https://api.jina.ai/v1/embeddings", "endpoint");
  assertEquals(BENCHMARK_JINA_EMBED_DIMENSIONS, 1024, "dimensions");
  assert(
    String(BENCHMARK_JINA_EMBED_API_KEY_ENV) === "JINA_API_KEY" &&
      String(BENCHMARK_JINA_EMBED_API_KEY_ENV) !== "VOYAGE_API_KEY",
    "single shared benchmark key name, never Voyage",
  );
  assert(BENCHMARK_JINA_BATCH_DEFAULTS.maxInputs > 12, "batching is not a blind Voyage copy");
});

Deno.test("jina embed: passage payload carries retrieval.passage", () => {
  const built = buildBenchmarkJinaEmbedRequest({ task: BENCHMARK_JINA_TASK_PASSAGE, inputs: ["a", "b"] });
  assert(built.ok, "request builds");
  if (!built.ok) return;
  assertEquals(built.request, {
    model: BENCHMARK_JINA_EMBED_MODEL,
    task: "retrieval.passage",
    dimensions: 1024,
    normalized: true,
    embedding_type: "float",
    input: ["a", "b"],
  }, "passage request");
});

Deno.test("jina embed: query payload carries retrieval.query", () => {
  const built = buildBenchmarkJinaEmbedRequest({ task: BENCHMARK_JINA_TASK_QUERY, inputs: ["q"] });
  assert(built.ok, "request builds");
  if (!built.ok) return;
  assertEquals(built.request.task, BENCHMARK_JINA_TASK_QUERY, "task identity");
  assertEquals(built.request.dimensions, 1024, "dimensions");
  assertEquals(built.request.normalized, true, "normalized");
});

Deno.test("jina embed: invalid task and empty inputs rejected", () => {
  assert(!buildBenchmarkJinaEmbedRequest({ task: "other" as never, inputs: ["a"] }).ok, "task");
  assert(!buildBenchmarkJinaEmbedRequest({ task: BENCHMARK_JINA_TASK_QUERY, inputs: [] }).ok, "empty");
  assert(!buildBenchmarkJinaEmbedRequest({ task: BENCHMARK_JINA_TASK_QUERY, inputs: [""] }).ok, "blank");
});

Deno.test("jina embed: transport posts the provider body with a bearer key", async () => {
  const mock = mockFetch(() => okJson(embedResponse(2)));
  const result = await callBenchmarkJinaEmbed({
    fetchFn: mock.fn,
    apiKey: "benchmark-embed-key",
    task: BENCHMARK_JINA_TASK_PASSAGE,
    inputs: ["a", "b"],
    timeoutMs: 1000,
  });
  assert(result.ok, "transport succeeds");
  assertEquals(mock.calls(), 1, "one call");
  const call = mock.seen()[0];
  assertEquals(call.url, BENCHMARK_JINA_EMBED_ENDPOINT, "endpoint");
  assertEquals((call.init?.headers as Record<string, string>)["Authorization"], "Bearer benchmark-embed-key", "bearer");
  const body = readBody(call);
  assertEquals(body["model"], BENCHMARK_JINA_EMBED_MODEL, "model");
  assertEquals(body["task"], "retrieval.passage", "task");
  assertEquals(body["dimensions"], 1024, "dimensions");
  assertEquals(body["normalized"], true, "normalized");
  const serialized = JSON.stringify(body);
  for (const forbidden of ["input_type", "output_dimension", "voyage", "match_chunks", "/ask"]) {
    assert(!serialized.includes(forbidden), `body must not contain ${forbidden}`);
  }
});

Deno.test("jina embed: response ordering follows request indexes", () => {
  const raw = {
    model: BENCHMARK_JINA_EMBED_MODEL,
    data: [
      { embedding: vector(), index: 1 },
      { embedding: vector(), index: 0 },
    ],
    usage: { total_tokens: 20 },
  };
  const parsed = parseBenchmarkJinaEmbedResponse(raw, 2);
  assert(parsed.ok, "parses");
  if (!parsed.ok) return;
  assertEquals(parsed.parsed.vectors.length, 2, "count");
  assertEquals(parsed.parsed.tokens, 20, "usage passes through");
});

Deno.test("jina embed: malformed response rejected", () => {
  assert(!parseBenchmarkJinaEmbedResponse(null, 1).ok, "null");
  assert(!parseBenchmarkJinaEmbedResponse({}, 1).ok, "missing data");
  assert(!parseBenchmarkJinaEmbedResponse({ model: BENCHMARK_JINA_EMBED_MODEL, data: [] }, 1).ok, "empty data");
});

Deno.test("jina embed: wrong model rejected when returned", () => {
  assert(!parseBenchmarkJinaEmbedResponse(embedResponse(1, "other-model"), 1).ok, "model mismatch");
});

Deno.test("jina embed: wrong dimension rejected", () => {
  const raw = {
    model: BENCHMARK_JINA_EMBED_MODEL,
    data: [{ embedding: new Array(512).fill(0.1), index: 0 }],
  };
  assert(!parseBenchmarkJinaEmbedResponse(raw, 1).ok, "dimension");
});

Deno.test("jina embed: non-finite embeddings rejected", () => {
  const bad = vector();
  bad[0] = Number.POSITIVE_INFINITY;
  const raw = { model: BENCHMARK_JINA_EMBED_MODEL, data: [{ embedding: bad, index: 0 }] };
  assert(!parseBenchmarkJinaEmbedResponse(raw, 1).ok, "infinite");
});

Deno.test("jina embed: count mismatch rejected", () => {
  assert(!parseBenchmarkJinaEmbedResponse(embedResponse(1), 2).ok, "short");
  assert(!parseBenchmarkJinaEmbedResponse(embedResponse(3), 2).ok, "long");
});

Deno.test("jina embed: 429 is a single failure, never a retry", async () => {
  const mock = mockFetch(() => new Response("limited", { status: 429 }));
  const result = await callBenchmarkJinaEmbed({
    fetchFn: mock.fn, apiKey: "k", task: BENCHMARK_JINA_TASK_QUERY, inputs: ["q"], timeoutMs: 500,
  });
  assert(!result.ok, "fails");
  if (result.ok) return;
  assertEquals(result.kind, "rate_limited", "mapped");
  assertEquals(mock.calls(), 1, "no retry");
});

Deno.test("jina embed: timeout and transport failures are explicit", async () => {
  const aborting = mockFetch(() => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })));
  const timedOut = await callBenchmarkJinaEmbed({
    fetchFn: aborting.fn, apiKey: "k", task: BENCHMARK_JINA_TASK_QUERY, inputs: ["q"], timeoutMs: 20,
  });
  assert(!timedOut.ok && timedOut.kind === "timeout", "timeout");
  const failing = mockFetch(() => Promise.reject(new TypeError("down")));
  const failed = await callBenchmarkJinaEmbed({
    fetchFn: failing.fn, apiKey: "k", task: BENCHMARK_JINA_TASK_QUERY, inputs: ["q"], timeoutMs: 500,
  });
  assert(!failed.ok && failed.kind === "transport", "transport");
});

Deno.test("jina embed: no Voyage fallback on provider failure", async () => {
  const mock = mockFetch(() => new Response("bad", { status: 500 }));
  const result = await callBenchmarkJinaEmbed({
    fetchFn: mock.fn, apiKey: "k", task: BENCHMARK_JINA_TASK_PASSAGE, inputs: ["a"], timeoutMs: 500,
  });
  assert(!result.ok, "fails");
  assertEquals(mock.calls(), 1, "exactly one attempt");
});

Deno.test("jina embed: batching preserves order and never drops rows", () => {
  const inputs = Array.from({ length: 70 }, (_, i) => `row-${i}-` + "x".repeat(50));
  const batches = planBenchmarkJinaBatches(inputs, { maxInputs: 32, maxChars: 32_000 });
  assertEquals(batches.flat(), inputs, "order and completeness");
  assert(batches.every((b) => b.length <= 32), "chunk budget");
  const chars = (rows: string[]) => rows.join("").length;
  assert(batches.every((b) => chars(b) <= 32_000 + 4_000), "character budget");
  const big = planBenchmarkJinaBatches(["y".repeat(100_000), "z"], { maxInputs: 32, maxChars: 32_000 });
  assertEquals(big.flat(), ["y".repeat(100_000), "z"], "oversized input keeps progress");
  assertEquals(big[0].length, 1, "oversized row alone");
});
