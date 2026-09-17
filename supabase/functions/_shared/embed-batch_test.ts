// Unit tests for the B1 batching helpers. Pure functions only — no network,
// no database, no provider. Run: deno test supabase/functions/_shared/embed-batch_test.ts

import {
  EMBED_DIMENSIONS,
  estimateBatchTokens,
  exceedsTokenBudget,
  planBatches,
  parseBatchResponse,
  type EmbedCandidate,
} from "./embed-batch.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

function rows(count: number, charLength = 100): EmbedCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    chunk_id: `c${i}`,
    content: "x".repeat(charLength),
  }));
}

function vector(): number[] {
  return new Array(EMBED_DIMENSIONS).fill(0.5);
}

/* ------------------------------------------------------------- planBatches */

Deno.test("planBatches: splits by chunk count", () => {
  const batches = planBatches(rows(25), { maxChunks: 12, maxChars: 100_000, maxBatches: 2 });
  assertEquals(batches.length, 2, "batch count");
  assertEquals(batches[0].length, 12, "first batch size");
  assertEquals(batches[1].length, 12, "second batch size");
  assertEquals(batches[0][0].chunk_id, "c0", "order preserved");
  assertEquals(batches[1][11].chunk_id, "c23", "second batch end");
});

Deno.test("planBatches: splits by character budget", () => {
  const batches = planBatches(rows(10, 1_000), { maxChunks: 50, maxChars: 2_500, maxBatches: 5 });
  assertEquals(batches.map((b) => b.length), [2, 2, 2, 2, 2], "two chunks per batch at 1k chars");
});

Deno.test("planBatches: oversized row gets its own batch and nothing is dropped", () => {
  const candidates = [rows(1, 100)[0], rows(1, 50_000)[0], rows(1, 100)[0]];
  const batches = planBatches(candidates, { maxChunks: 12, maxChars: 1_000, maxBatches: 5 });
  const flat = batches.flat();
  assertEquals(flat.length, 3, "no candidate dropped");
  assertEquals(flat.map((r) => r.chunk_id), ["c0", "c0", "c0"], "order preserved");
  assertEquals(batches[1].length, 1, "oversized row alone");
});

Deno.test("planBatches: respects maxBatches (the per-tick request budget)", () => {
  const batches = planBatches(rows(100), { maxChunks: 12, maxChars: 100_000, maxBatches: 2 });
  assertEquals(batches.length, 2, "batches capped");
  assertEquals(batches.flat().length, 24, "only the budgeted chunks are returned");
});

Deno.test("planBatches: empty input yields no batches", () => {
  assertEquals(planBatches([], { maxChunks: 12, maxChars: 1_000, maxBatches: 2 }), [], "empty");
});

/* -------------------------------------------------------- parseBatchResponse */

Deno.test("parseBatchResponse: accepts a well-formed positional response", () => {
  const raw = {
    model: "voyage-4",
    data: [0, 1].map((i) => ({ embedding: vector(), index: i })),
    usage: { total_tokens: 700 },
  };
  const result = parseBatchResponse(raw, 2);
  assert(result.ok, "should parse");
  if (result.ok) {
    assertEquals(result.tokens, 700, "tokens reported");
    assertEquals(result.vectors.length, 2, "vector count");
    assertEquals(result.vectors[1].length, EMBED_DIMENSIONS, "dimensions preserved");
  }
});

Deno.test("parseBatchResponse: maps out-of-order indices back to request order", () => {
  const v0 = vector().fill(0.1);
  const v1 = vector().fill(0.9);
  const raw = {
    model: "voyage-4",
    data: [{ embedding: v1, index: 1 }, { embedding: v0, index: 0 }],
  };
  const result = parseBatchResponse(raw, 2);
  assert(result.ok, "should parse");
  if (result.ok) {
    assertEquals(result.vectors[0][0], 0.1, "index 0 mapped to request position 0");
    assertEquals(result.vectors[1][0], 0.9, "index 1 mapped to request position 1");
  }
});

Deno.test("parseBatchResponse: falls back to positional order without indices", () => {
  const raw = { model: "voyage-4", data: [{ embedding: vector() }] };
  const result = parseBatchResponse(raw, 1);
  assert(result.ok, "should parse");
});

Deno.test("parseBatchResponse: rejects wrong model", () => {
  const raw = { model: "voyage-3.5", data: [{ embedding: vector(), index: 0 }] };
  const result = parseBatchResponse(raw, 1);
  assert(!result.ok, "wrong model must be rejected");
});

Deno.test("parseBatchResponse: rejects a short response (partial batch)", () => {
  const raw = { model: "voyage-4", data: [{ embedding: vector(), index: 0 }] };
  const result = parseBatchResponse(raw, 12);
  assert(!result.ok, "count mismatch must be rejected so nothing is persisted");
});

Deno.test("parseBatchResponse: rejects a truncated vector", () => {
  const raw = { model: "voyage-4", data: [{ embedding: [0.1, 0.2], index: 0 }] };
  assert(!parseBatchResponse(raw, 1).ok, "wrong dimensions must be rejected");
});

Deno.test("parseBatchResponse: rejects non-finite values", () => {
  const bad = vector();
  bad[10] = Number.NaN;
  const raw = { model: "voyage-4", data: [{ embedding: bad, index: 0 }] };
  assert(!parseBatchResponse(raw, 1).ok, "NaN must be rejected");
});

Deno.test("parseBatchResponse: rejects duplicate indices", () => {
  const raw = {
    model: "voyage-4",
    data: [{ embedding: vector(), index: 0 }, { embedding: vector(), index: 0 }],
  };
  assert(!parseBatchResponse(raw, 2).ok, "duplicate index must be rejected");
});

Deno.test("parseBatchResponse: rejects an out-of-range index", () => {
  const raw = { model: "voyage-4", data: [{ embedding: vector(), index: 7 }] };
  assert(!parseBatchResponse(raw, 1).ok, "out-of-range index must be rejected");
});

Deno.test("parseBatchResponse: rejects null and malformed bodies", () => {
  assert(!parseBatchResponse(null, 1).ok, "null body");
  assert(!parseBatchResponse({ model: "voyage-4" }, 1).ok, "missing data");
  assert(!parseBatchResponse("nope", 1).ok, "string body");
});

/* ------------------------------------------------------- pacing helpers */

Deno.test("estimateBatchTokens: empty batch costs only the per-input term (zero)", () => {
  assertEquals(estimateBatchTokens([]), 0, "empty");
});

Deno.test("estimateBatchTokens: ~4 chars per token plus per-input overhead", () => {
  // 100 chars -> ceil(100/4) = 25 + 10 overhead = 35.
  assertEquals(estimateBatchTokens(["x".repeat(100)]), 35, "single input");
  assertEquals(
    estimateBatchTokens(["x".repeat(100), "y".repeat(8)]),
    35 + 12,
    "two inputs",
  );
});

Deno.test("estimateBatchTokens: never undercounts a dense batch", () => {
  const contents = Array.from({ length: 12 }, () => "x".repeat(1000));
  const estimate = estimateBatchTokens(contents);
  // 12,000 chars / 4 = 3,000 + 120 overhead.
  assertEquals(estimate, 3120, "dense 12-chunk batch");
});

Deno.test("exceedsTokenBudget: allows equality, rejects only over-budget", () => {
  const batch = ["x".repeat(100)]; // estimate 35
  assert(!exceedsTokenBudget(0, batch, 35), "equality allowed");
  assert(exceedsTokenBudget(1, batch, 35), "one over rejects");
  assert(!exceedsTokenBudget(9465, batch, 9500), "headroom allows");
  assert(exceedsTokenBudget(9466, batch, 9500), "no headroom stops");
});

Deno.test("exceedsTokenBudget: a full third request fits a 9500 budget", () => {
  // Three max-observed batches (~2,606 tokens each) stay under budget.
  const observed = 2606;
  let used = 0;
  for (let i = 0; i < 3; i++) {
    assert(!exceedsTokenBudget(used, ["x".repeat(observed * 4)], 9500), `batch ${i + 1} fits`);
    used += observed;
  }
  assertEquals(used, 7818, "three observed batches total");
});
