// H2B usage-telemetry tests — token accounting classification and builders.
//
// Pure functions only: no network, no database, no model.
// Run: deno test supabase/functions/_shared/usage-telemetry_test.ts

import {
  buildTelemetry,
  checkerTelemetry,
  contextTelemetry,
  embeddingTelemetry,
  estimatedTokensFromChars,
  evidenceTelemetry,
  generationTelemetry,
  measuredTokens,
  rerankTelemetry,
  unknownTokens,
  zeroContext,
  zeroRerank,
  zeroReuse,
  zeroRewrite,
  zeroTokens,
} from "./usage-telemetry.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

/* --------------------------------------------------- token classification */

Deno.test("classification: measured stays measured", () => {
  assertEquals(measuredTokens(123), { value: 123, basis: "measured" }, "reported usage");
});

Deno.test("classification: a missing or zero provider number is unknown, not measured zero", () => {
  assertEquals(measuredTokens(null), { value: null, basis: "unknown" }, "null");
  assertEquals(measuredTokens(undefined), { value: null, basis: "unknown" }, "undefined");
  assertEquals(measuredTokens(0), { value: null, basis: "unknown" }, "coerced zero");
});

Deno.test("classification: estimated stays estimated (chars/4, rounded up)", () => {
  assertEquals(estimatedTokensFromChars(9), { value: 3, basis: "estimated" }, "9 chars");
  assertEquals(estimatedTokensFromChars(0), { value: 0, basis: "estimated" }, "empty text");
  assertEquals(estimatedTokensFromChars(null), { value: null, basis: "unknown" }, "no count");
});

Deno.test("classification: calculated and unknown helpers are stable", () => {
  assertEquals(zeroTokens(), { value: 0, basis: "calculated" }, "deterministic zero");
  assertEquals(unknownTokens(), { value: null, basis: "unknown" }, "unknown");
});

/* ---------------------------------------------------------------- rerank */

Deno.test("rerank skipped: zero calls, zero cost, correct reason", () => {
  const t = rerankTelemetry({
    attempted: false, skipped: true, skipReason: "pool-within-final-k",
    inputChars: 5000, providerTokens: null, latencyMs: 7,
  });
  assertEquals(t, {
    attempted: false, skipped: true, skip_reason: "pool-within-final-k",
    calls: 0, input_chars: 0, tokens: { value: 0, basis: "calculated" }, latency_ms: 0,
  }, "skipped rerank accounting");
});

Deno.test("rerank skipped: empty-pool reason is preserved", () => {
  const t = rerankTelemetry({
    attempted: false, skipped: true, skipReason: "empty-pool",
    inputChars: 0, providerTokens: null, latencyMs: 0,
  });
  assertEquals(t.skip_reason, "empty-pool", "reason");
  assertEquals(t.skipped, true, "skipped");
});

Deno.test("rerank attempted: candidate input chars and estimated tokens", () => {
  const t = rerankTelemetry({
    attempted: true, skipped: false, skipReason: null,
    inputChars: 4000, providerTokens: null, latencyMs: 12,
  });
  assertEquals(t, {
    attempted: true, skipped: false, skip_reason: null,
    calls: 1, input_chars: 4000, tokens: { value: 1000, basis: "estimated" }, latency_ms: 12,
  }, "attempted rerank estimate");
});

Deno.test("rerank attempted: provider usage is measured when present", () => {
  const t = rerankTelemetry({
    attempted: true, skipped: false, skipReason: null,
    inputChars: 4000, providerTokens: 913, latencyMs: 12,
  });
  assertEquals(t.tokens, { value: 913, basis: "measured" }, "measured rerank tokens");
});

/* ------------------------------------------------------------- embedding */

Deno.test("query embedding: measured when reported, estimated otherwise", () => {
  const measured = embeddingTelemetry({ calls: 1, inputChars: 88, providerTokens: 21, latencyMs: 30 });
  assertEquals(measured.tokens, { value: 21, basis: "measured" }, "provider usage");
  assertEquals(measured.input_chars, 88, "input chars");
  const estimated = embeddingTelemetry({ calls: 1, inputChars: 88, providerTokens: null, latencyMs: 30 });
  assertEquals(estimated.tokens, { value: 22, basis: "estimated" }, "chars/4 fallback");
});

Deno.test("query embedding: zero calls is a calculated zero, never a fake usage", () => {
  const t = embeddingTelemetry({ calls: 0, inputChars: 500, providerTokens: null, latencyMs: 0 });
  assertEquals(t, { calls: 0, input_chars: 0, tokens: { value: 0, basis: "calculated" }, latency_ms: 0 }, "no call");
});

/* -------------------------------------------------------------- evidence */

Deno.test("evidence: count and characters are measured, tokens estimated", () => {
  const t = evidenceTelemetry(["abcd", "efghij"]);
  assertEquals(t.count, 2, "count");
  assertEquals(t.chars, 10, "chars");
  assertEquals(t.tokens, { value: 3, basis: "estimated" }, "estimate");
});

/* ------------------------------------------------------------ generation */

Deno.test("generation: provider usage is measured when available", () => {
  const t = generationTelemetry({ calls: 1, inputTokens: 2500, outputTokens: 120, latencyMs: 800 });
  assertEquals(t.calls, 1, "calls");
  assertEquals(t.input_tokens, { value: 2500, basis: "measured" }, "input");
  assertEquals(t.output_tokens, { value: 120, basis: "measured" }, "output");
  assertEquals(t.latency_ms, 800, "latency");
});

Deno.test("generation: absent usage is unknown, not zero", () => {
  const t = generationTelemetry({ calls: 1, inputTokens: null, outputTokens: null, latencyMs: 800 });
  assertEquals(t.input_tokens, { value: null, basis: "unknown" }, "input unknown");
  assertEquals(t.output_tokens, { value: null, basis: "unknown" }, "output unknown");
});

Deno.test("generation: zero calls is a calculated zero", () => {
  const t = generationTelemetry({ calls: 0, inputTokens: null, outputTokens: null, latencyMs: 0 });
  assertEquals(t, {
    calls: 0, input_tokens: { value: 0, basis: "calculated" },
    output_tokens: { value: 0, basis: "calculated" }, latency_ms: 0,
  }, "no generation");
});

/* --------------------------------------------------------------- checker */

Deno.test("checker: attempts/latency measured, input unknown, output measured when present", () => {
  const t = checkerTelemetry({ calls: 2, outputTokens: 80, latencyMs: 900 });
  assertEquals(t.calls, 2, "call count = attempts");
  assertEquals(t.input_tokens, { value: null, basis: "unknown" }, "input unknown");
  assertEquals(t.output_tokens, { value: 80, basis: "measured" }, "output measured");
  assertEquals(t.latency_ms, 900, "latency");
});

Deno.test("checker: disabled is a calculated zero", () => {
  const t = checkerTelemetry({ calls: 0, outputTokens: null, latencyMs: null });
  assertEquals(t, {
    calls: 0, input_tokens: { value: 0, basis: "calculated" },
    output_tokens: { value: 0, basis: "calculated" }, latency_ms: 0,
  }, "checker never ran");
});

/* ------------------------------------------------- H1 conversational bypass */

Deno.test("H1 bypass: conversational turn creates no RAG token usage", () => {
  const t = buildTelemetry({
    router: { classification: "CONVERSATIONAL", bypassed: true, latency_ms: 0.2 },
  });
  assertEquals(t.retrieval.rounds, 0, "no retrieval");
  assertEquals(t.embedding, { calls: 0, input_chars: 0, tokens: { value: 0, basis: "calculated" }, latency_ms: 0 }, "no embedding");
  assertEquals(t.rerank.calls, 0, "no rerank call");
  assertEquals(t.rerank.attempted, false, "not attempted");
  assertEquals(t.evidence.count, 0, "no evidence");
  assertEquals(t.generation.calls, 0, "no generation");
  assertEquals(t.checker.calls, 0, "no checker");
  const bases = [t.embedding.tokens, t.rerank.tokens, t.evidence.tokens,
    t.generation.input_tokens, t.generation.output_tokens,
    t.checker.input_tokens, t.checker.output_tokens].map((m) => m.basis);
  assert(bases.every((b) => b === "calculated"), `all zeros are calculated (got ${bases.join(",")})`);
});

/* ------------------------------------------------------- context (H3A) */

Deno.test("context: zero context means the layer did not run", () => {
  const t = zeroContext();
  assertEquals(t, {
    used: false, classification: "UNKNOWN", history_turns_read: 0,
    previous_message_available: false, prior_evidence_available: false, latency_ms: 0,
    rewrite: zeroRewrite(), reuse: zeroReuse(),
  }, "zero context");
});

Deno.test("context: builder maps classification and bounded-read diagnostics", () => {
  const t = contextTelemetry({
    used: true, classification: "FOLLOW_UP", historyTurnsRead: 4,
    previousMessageAvailable: true, priorEvidenceAvailable: true, latencyMs: 21,
  });
  assertEquals(t, {
    used: true, classification: "FOLLOW_UP", history_turns_read: 4,
    previous_message_available: true, prior_evidence_available: true, latency_ms: 21,
    rewrite: zeroRewrite(), reuse: zeroReuse(),
  }, "context telemetry");
});

Deno.test("context: telemetry never carries conversation text", () => {
  const t = contextTelemetry({
    used: true, classification: "FOLLOW_UP", historyTurnsRead: 2,
    previousMessageAvailable: true, priorEvidenceAvailable: true, latencyMs: 5,
  });
  const serialized = JSON.stringify(t);
  assert(!serialized.includes("?"), "no question text");
  assertEquals(t.history_turns_read, 2, "only counts and flags");
});

Deno.test("context: assembly defaults to zero context when omitted", () => {
  const t = buildTelemetry({ router: { classification: "KNOWLEDGE_QUERY", bypassed: false, latency_ms: 0.1 } });
  assertEquals(t.context, zeroContext(), "default context section");
});

/* ------------------------------------------------------- full assembly */

Deno.test("assembly: a normal turn carries measured and estimated sections side by side", () => {
  const t = buildTelemetry({
    router: { classification: "KNOWLEDGE_QUERY", bypassed: false, latency_ms: 0.1 },
    retrieval: { rounds: 1, dense_count: 20, lexical_count: 5, fused_count: 22, final_evidence_count: 8 },
    embedding: embeddingTelemetry({ calls: 1, inputChars: 60, providerTokens: 14, latencyMs: 40 }),
    rerank: rerankTelemetry({
      attempted: true, skipped: false, skipReason: null,
      inputChars: 20000, providerTokens: null, latencyMs: 430,
    }),
    evidence: evidenceTelemetry(["a".repeat(1900), "b".repeat(1900)]),
    generation: generationTelemetry({ calls: 1, inputTokens: 2400, outputTokens: 150, latencyMs: 3200 }),
  });
  assertEquals(t.router.classification, "KNOWLEDGE_QUERY", "router");
  assertEquals(t.retrieval.dense_count, 20, "dense");
  assertEquals(t.embedding.tokens.basis, "measured", "embedding measured");
  assertEquals(t.rerank.tokens, { value: 5000, basis: "estimated" }, "rerank estimated");
  assertEquals(t.evidence.tokens, { value: 950, basis: "estimated" }, "evidence estimated");
  assertEquals(t.generation.input_tokens, { value: 2400, basis: "measured" }, "generation measured");
  assertEquals(t.checker.calls, 0, "checker zero by default");
});

/* -------------------------------------------------------------- privacy */

Deno.test("privacy: no document text or secrets can enter telemetry", () => {
  const secret = "PROJECT-NIGHTFALL acquisition of ACME clause 7.3 confidential";
  const t = buildTelemetry({
    router: { classification: "KNOWLEDGE_QUERY", bypassed: false, latency_ms: 0.1 },
    retrieval: { rounds: 1, dense_count: 1, lexical_count: 1, fused_count: 1, final_evidence_count: 1 },
    embedding: embeddingTelemetry({ calls: 1, inputChars: secret.length, providerTokens: null, latencyMs: 10 }),
    rerank: rerankTelemetry({
      attempted: true, skipped: false, skipReason: null,
      inputChars: secret.length, providerTokens: null, latencyMs: 10,
    }),
    evidence: evidenceTelemetry([secret]),
  });
  const serialized = JSON.stringify(t);
  assert(!serialized.includes("NIGHTFALL"), "secret content absent");
  assert(!serialized.includes("ACME"), "named entity absent");
  assert(!serialized.includes("confidential"), "secret word absent");
  assertEquals(t.evidence.chars, secret.length, "only the length is retained");
});
