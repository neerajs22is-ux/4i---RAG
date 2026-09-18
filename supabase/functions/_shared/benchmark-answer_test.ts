// Unit tests for the benchmark-only answer pipeline. Pure fixtures and an
// injected Mantle mock; no network, database, provider calls beyond the mock,
// or benchmark execution.
// Run: deno test supabase/functions/_shared/benchmark-answer_test.ts

import {
  runBenchmarkAnswer,
  type BenchmarkAnswerEvidence,
} from "./benchmark-answer.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function okBody(result: { status: number; body: unknown }): Record<string, unknown> {
  assertEquals(result.status, 200, "status");
  return result.body as Record<string, unknown>;
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

const MANTLE = {
  baseUrl: "https://benchmark.invalid",
  chatPath: "/chat/completions",
  modelId: "benchmark-model",
  key: "benchmark-key",
  maxTokens: 1024,
};

function evidenceItem(over: Partial<BenchmarkAnswerEvidence> = {}): BenchmarkAnswerEvidence {
  return {
    chunk_id: "chunk-1",
    document_id: "doc-1",
    tenant_id: "tenant-benchmark",
    file_name: "file.pdf",
    page: 1,
    content: "The lock-in period is 36 months.",
    ...over,
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

function mantleOk(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function readBody(call: MockCall): Record<string, unknown> {
  assert(typeof call.init?.body === "string", "mock request has a JSON body");
  return JSON.parse(call.init?.body as string) as Record<string, unknown>;
}

const BASE = {
  tenantId: "tenant-benchmark",
  query: "What is the lock-in period?",
  evidence: [evidenceItem()],
  priorCount: 0,
  docCount: 4,
  retrievalMs: 12,
  mantle: MANTLE,
  checkerEnabled: false,
};

Deno.test("benchmark answer: empty evidence refuses without generation", async () => {
  const mock = mockFetch(() => mantleOk("unused"));
  const result = await runBenchmarkAnswer({ ...BASE, evidence: [], fetchFn: mock.fn });
  const body = okBody(result);
  assert(body["label"] === "insufficient", "refusal label");
  assertEquals(mock.calls(), 0, "no model call");
  const gate = body["gate"] as { verdict: string };
  assert(gate.verdict === "INSUFFICIENT", "gate verdict for comparison");
  assertEquals(body["persisted"], false, "nothing persisted");
  assert(!("conversation_id" in body), "no conversation identity");
});

Deno.test("benchmark answer: clarification gate fires without generation", async () => {
  const mock = mockFetch(() => mantleOk("unused"));
  const result = await runBenchmarkAnswer({
    ...BASE,
    query: "What about it?",
    fetchFn: mock.fn,
  });
  const body = okBody(result);
  assertEquals(body["label"], "clarification", "clarification label");
  assertEquals(mock.calls(), 0, "no model call");
});

Deno.test("benchmark answer: generation input matches the production contract", async () => {
  const mock = mockFetch(() => mantleOk("The lock-in period is 36 months [S1]."));
  const result = await runBenchmarkAnswer({ ...BASE, fetchFn: mock.fn });
  assertEquals(result.status, 200, "status");
  assertEquals(mock.calls(), 1, "one generation call");
  const call = mock.seen()[0];
  assertEquals(call.url, "https://benchmark.invalid/chat/completions", "endpoint composition");
  const body = readBody(call);
  assertEquals(body["model"], "benchmark-model", "model passthrough");
  assertEquals(body["temperature"], 0.0, "temperature");
  assertEquals(body["max_tokens"], 1024, "token cap");
  const content = ((body["messages"] as Array<{ content: string }>)[0]?.content) ?? "";
  assert(content.includes("[S1] (file.pdf p. 1)"), "evidence block labeling");
  assert(content.includes("The lock-in period is 36 months."), "evidence content in prompt");
  assert(content.includes("What is the lock-in period?"), "question in prompt");
});

Deno.test("benchmark answer: citations stay positional and provenance intact", async () => {
  const mock = mockFetch(() => mantleOk("The lock-in period is 36 months [S1]."));
  const result = await runBenchmarkAnswer({
    ...BASE,
    evidence: [evidenceItem({ chunk_id: "c-a" }), evidenceItem({ chunk_id: "c-b", content: "Unrelated passage about taxes." })],
    fetchFn: mock.fn,
  });
  const body = okBody(result);
  const citations = body["citations"] as Array<{ n: number; chunk_id: string; page: number | null }>;
  assertEquals(citations.map((c) => c.n), [1], "positional numbering");
  assertEquals(citations[0].chunk_id, "c-a", "chunk identity");
  assertEquals(citations[0].page, 1, "page provenance");
  const model = body["model"] as { provider: string };
  assertEquals(model.provider, "mantle", "model block");
  assert("timings" in body && "gate" in body, "evaluation-compatible shape");
});

Deno.test("benchmark answer: invalid citations fail closed", async () => {
  const mock = mockFetch(() => mantleOk("The answer is 36 months [S9]."));
  const result = await runBenchmarkAnswer({ ...BASE, fetchFn: mock.fn });
  assertEquals(result.status, 502, "guard failure status");
});

Deno.test("benchmark answer: cross-tenant evidence is rejected", async () => {
  const mock = mockFetch(() => mantleOk("unused"));
  const result = await runBenchmarkAnswer({
    ...BASE,
    evidence: [evidenceItem({ tenant_id: "other-tenant" })],
    fetchFn: mock.fn,
  });
  assertEquals(result.status, 502, "tenant rejection");
  assertEquals(mock.calls(), 0, "no model call");
});

Deno.test("benchmark answer: provider throttling surfaces as 429", async () => {
  const mock = mockFetch(() => new Response("throttled", { status: 429 }));
  const result = await runBenchmarkAnswer({ ...BASE, fetchFn: mock.fn });
  assertEquals(result.status, 429, "throttle status");
});

Deno.test("benchmark answer: same evidence yields the same answer path twice", async () => {
  const mock = mockFetch(() => mantleOk("The lock-in period is 36 months [S1]."));
  const first = await runBenchmarkAnswer({ ...BASE, fetchFn: mock.fn });
  const second = await runBenchmarkAnswer({ ...BASE, fetchFn: mock.fn });
  const firstBody = okBody(first);
  const secondBody = okBody(second);
  assertEquals(firstBody["answer"], secondBody["answer"], "deterministic answer");
  assertEquals(firstBody["label"], secondBody["label"], "deterministic label");
  assertEquals(mock.calls(), 2, "one generation per answer call, no caching");
});

Deno.test("benchmark answer: module performs no persistence or production calls", async () => {
  const text = await Deno.readTextFile(new URL("./benchmark-answer.ts", import.meta.url));
  for (const forbidden of [
    'from "../ask',
    'from "../query-chunks',
    'from "../embed-worker',
    "VOYAGE_API_KEY",
    'rpc("match_chunks"',
    'from("conversations")',
    'from("messages")',
    ".insert(",
    ".update(",
    ".delete(",
  ]) {
    assert(!text.includes(forbidden), `benchmark-answer must not contain ${forbidden}`);
  }
});
