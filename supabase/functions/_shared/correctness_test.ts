// correctness_test.ts — deterministic unit tests for _shared/correctness.ts.
// Run: deno test supabase/functions/_shared/correctness_test.ts
// Provider-free: mocked Mantle envelopes only. No I/O, no network, no secrets.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  aggregateCorrectness,
  buildCorrectnessBody,
  CORRECTNESS_CHECKER_NAME,
  CORRECTNESS_MAX_TOKENS,
  CORRECTNESS_PROMPT_VERSION,
  CORRECTNESS_TEMPERATURE,
  evaluateAnswer,
  parseCorrectnessModelResponse,
  parseCorrectnessResponse,
  renderCorrectnessPrompt,
  shouldRunChecker,
} from "./correctness.ts";

function envelope(content: unknown): unknown {
  return { choices: [{ message: { content } }], usage: { input_tokens: 1, output_tokens: 1 } };
}

function validResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checker: CORRECTNESS_CHECKER_NAME,
    verdict: "PASS",
    claims: [{
      claim_id: "c1",
      claim_text: "The period is 30 days.",
      judgment: "supported",
      evidence_refs: [1],
      issue: null,
    }],
    feedback: "All claims supported.",
    invalid_result: false,
    invalid_reason: null,
    ...over,
  };
}

function sampleInput() {
  return {
    question: "What is the notice period?",
    answer: "The notice period is 30 days [S1].",
    evidence: [{ n: 1, page: 4, text: "The lease requires 30 days notice." }],
    gate_verdict: "SUPPORTED" as const,
    citations: [{ n: 1, chunk_ref: "c1" }],
  };
}

// 1. Valid PASS response
Deno.test("correctness: valid PASS response parses", () => {
  const r = parseCorrectnessModelResponse(envelope(JSON.stringify(validResult())), [1]);
  assert(r.ok);
  if (r.ok) assertEquals(r.result.verdict, "PASS");
});

// 2. Valid PARTIAL response
Deno.test("correctness: valid PARTIAL response parses", () => {
  const r = parseCorrectnessModelResponse(envelope(JSON.stringify(validResult({
    verdict: "PARTIAL",
    claims: [
      { claim_id: "c1", claim_text: "The period is 30 days.", judgment: "supported", evidence_refs: [1], issue: null },
      { claim_id: "c2", claim_text: "No fee applies.", judgment: "unsupported", evidence_refs: [1], issue: "fee unaddressed" },
    ],
    feedback: "Core supported; fee claim unsupported.",
  }))), [1]);
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.result.verdict, "PARTIAL");
    assertEquals(r.result.claims.length, 2);
  }
});

// 3. Valid FAIL response
Deno.test("correctness: valid FAIL response parses", () => {
  const r = parseCorrectnessModelResponse(envelope(JSON.stringify(validResult({
    verdict: "FAIL",
    claims: [{ claim_id: "c1", claim_text: "The period is 60 days.", judgment: "contradicted", evidence_refs: [1], issue: "evidence states 30" }],
    feedback: "Contradicts evidence.",
  }))), [1]);
  assert(r.ok);
  if (r.ok) assertEquals(r.result.claims[0].judgment, "contradicted");
});

// 4. Valid INVALID response
Deno.test("correctness: valid INVALID response parses", () => {
  const r = parseCorrectnessModelResponse(envelope(JSON.stringify({
    checker: CORRECTNESS_CHECKER_NAME,
    verdict: "INVALID",
    claims: [],
    feedback: "Cannot judge.",
    invalid_result: true,
    invalid_reason: "empty evidence",
  })));
  assert(r.ok);
  if (r.ok) assertEquals(r.result.verdict, "INVALID");
});

// 5. Malformed JSON
Deno.test("correctness: malformed model JSON is INVALID", () => {
  const r = parseCorrectnessModelResponse(envelope("not json at all {{{"));
  assertEquals(r.ok, false);
});

// 6. Missing required fields
Deno.test("correctness: missing required fields rejected", () => {
  const v = validResult() as Record<string, unknown>;
  delete v["feedback"];
  const r = parseCorrectnessResponse(v);
  assertEquals(r.ok, false);
});

// 7. Invalid verdict
Deno.test("correctness: invalid verdict rejected", () => {
  const r = parseCorrectnessResponse(validResult({ verdict: "MAYBE" }));
  assertEquals(r.ok, false);
});

// 8. Invalid claim judgment
Deno.test("correctness: invalid claim judgment rejected", () => {
  const r = parseCorrectnessResponse(validResult({
    claims: [{ claim_id: "c1", claim_text: "x.", judgment: "likely", evidence_refs: [1], issue: null }],
  }));
  assertEquals(r.ok, false);
});

// 9. Invalid evidence_refs
Deno.test("correctness: invalid evidence_refs rejected", () => {
  for (const bad of [[], ["1"], [0], [1.5], [1, 1], [9]]) {
    const r = parseCorrectnessResponse(validResult({
      claims: [{ claim_id: "c1", claim_text: "x.", judgment: "supported", evidence_refs: bad, issue: null }],
    }), [1, 2]);
    assertEquals(r.ok, false, JSON.stringify(bad));
  }
});

// 10. invalid_result=true handling
Deno.test("correctness: invalid flag must cohere with INVALID verdict", () => {
  const a = parseCorrectnessResponse(validResult({ invalid_result: true }));
  assertEquals(a.ok, false);
  const b = parseCorrectnessResponse(validResult({ verdict: "INVALID" }));
  assertEquals(b.ok, false);
  const c = parseCorrectnessResponse(validResult({ invalid_reason: "stale" }));
  assertEquals(c.ok, false);
});

// 11. Empty claims handling
Deno.test("correctness: judged verdicts require claims; INVALID requires none", () => {
  const a = parseCorrectnessResponse(validResult({ claims: [] }));
  assertEquals(a.ok, false);
  const b = parseCorrectnessModelResponse(envelope(JSON.stringify({
    checker: CORRECTNESS_CHECKER_NAME, verdict: "INVALID", claims: [{ claim_id: "c1", claim_text: "x.", judgment: "supported", evidence_refs: [1], issue: null }], feedback: "x.", invalid_result: true, invalid_reason: "r",
  })));
  assertEquals(b.ok, false);
});

// 12. Multiple claims
Deno.test("correctness: multiple claims with mixed judgments parse", () => {
  const r = parseCorrectnessResponse(validResult({
    verdict: "PARTIAL",
    claims: [
      { claim_id: "c1", claim_text: "A.", judgment: "supported", evidence_refs: [1], issue: null },
      { claim_id: "c2", claim_text: "B.", judgment: "unsupported", evidence_refs: [2], issue: "missing" },
      { claim_id: "c3", claim_text: "C.", judgment: "contradicted", evidence_refs: [1, 2], issue: "opposite" },
    ],
    feedback: "Mixed.",
  }), [1, 2]);
  assert(r.ok);
  if (r.ok) assertEquals(r.result.claims.length, 3);
});

// 13. Contradicted claim
Deno.test("correctness: contradicted claim accepted with evidence ref", () => {
  const r = parseCorrectnessResponse(validResult({
    verdict: "FAIL",
    claims: [{ claim_id: "c7", claim_text: "Z.", judgment: "contradicted", evidence_refs: [2], issue: "states opposite" }],
    feedback: "Fail.",
  }), [1, 2]);
  assert(r.ok);
});

// 14. Unsupported claim
Deno.test("correctness: unsupported claim accepted with issue", () => {
  const r = parseCorrectnessResponse(validResult({
    verdict: "PARTIAL",
    claims: [{ claim_id: "c2", claim_text: "Y.", judgment: "unsupported", evidence_refs: [1], issue: "absent" }],
    feedback: "Partial.",
  }), [1]);
  assert(r.ok);
});

// Extra structural strictness: unknown fields, bad ids, non-string feedback.
Deno.test("correctness: unknown fields and bad ids rejected", () => {
  assertEquals(parseCorrectnessResponse(validResult({ score: 0.9 })).ok, false);
  assertEquals(parseCorrectnessResponse(validResult({
    claims: [{ claim_id: "1", claim_text: "x.", judgment: "supported", evidence_refs: [1], issue: null }],
  })).ok, false);
  assertEquals(parseCorrectnessResponse(validResult({
    claims: [
      { claim_id: "c1", claim_text: "x.", judgment: "supported", evidence_refs: [1], issue: null },
      { claim_id: "c1", claim_text: "y.", judgment: "supported", evidence_refs: [1], issue: null },
    ],
  })).ok, false);
  assertEquals(parseCorrectnessResponse(validResult({ feedback: "" })).ok, false);
  assertEquals(parseCorrectnessResponse(validResult({ feedback: 42 })).ok, false);
});

// Prompt + body: versioned, bounded, provider-shape compatible.
Deno.test("correctness: prompt renders versioned template with inputs", () => {
  const { template, version } = renderCorrectnessPrompt(sampleInput());
  assert(version.startsWith(CORRECTNESS_PROMPT_VERSION));
  assert(template.includes("What is the notice period?"));
  assert(template.includes("30 days notice"));
  assert(template.includes("JSON ONLY"));
});

Deno.test("correctness: request body is bounded temp-0.0 provider shape", () => {
  const body = buildCorrectnessBody("model-id", sampleInput()) as Record<string, unknown>;
  assertEquals(body["model"], "model-id");
  assertEquals(body["temperature"], CORRECTNESS_TEMPERATURE);
  assertEquals(body["temperature"], 0.0);
  assertEquals(body["max_tokens"], CORRECTNESS_MAX_TOKENS);
  assert(Array.isArray((body["messages"] as unknown[])));
});

// 15. Prompt contains no domain-specific vocabulary/rules.
Deno.test("correctness: prompt is domain-agnostic", () => {
  const { template } = renderCorrectnessPrompt(sampleInput());
  const banned = ["income", "tax", "taxes", "legal", "finance", "financial", "amendment", "amended", "section", "clause", "assessee", "deduction", "revenue", "salary", "tribunal", "statute", "contract", "patient", "student", "employee", "dividend", "tenant"];
  for (const w of banned) {
    assert(!new RegExp(`\\b${w}\\b`, "i").test(template), `prompt contains domain word: ${w}`);
  }
});

// --- Step 3C.15 integration behavior (ask plumbing contract, mocked) ---

Deno.test("integration: checker disabled or INSUFFICIENT never runs", () => {
  for (const v of ["SUPPORTED", "PARTIAL", "CONFLICTING", "INSUFFICIENT"]) {
    assertEquals(shouldRunChecker(false, v), false);
  }
  assertEquals(shouldRunChecker(true, "INSUFFICIENT"), false);
  assertEquals(shouldRunChecker(true, "SUPPORTED"), true);
  assertEquals(shouldRunChecker(true, "PARTIAL"), true);
  assertEquals(shouldRunChecker(true, "CONFLICTING"), true);
});

Deno.test("integration: aggregation preserves or downgrades, never upgrades/refuses", () => {
  assertEquals(aggregateCorrectness("direct", null, "PASS"), { label: "direct", groundingNote: null });
  assertEquals(aggregateCorrectness("direct", null, "INVALID"), { label: "direct", groundingNote: null });
  assertEquals(aggregateCorrectness("direct", null, null), { label: "direct", groundingNote: null });
  const p = aggregateCorrectness("direct", null, "PARTIAL");
  assertEquals(p.label, "partial");
  assert(typeof p.groundingNote === "string" && p.groundingNote.length > 0);
  const f = aggregateCorrectness("direct", "base note.", "FAIL");
  assertEquals(f.label, "partial");
  assert((f.groundingNote ?? "").startsWith("base note."));
  // PARTIAL + FAIL stays partial (advisory, never refuses).
  assertEquals(aggregateCorrectness("partial", null, "FAIL").label, "partial");
  // CONFLICTING framing preserved, note appended.
  const c = aggregateCorrectness("conflict", null, "FAIL");
  assertEquals(c.label, "conflict");
  assert(typeof c.groundingNote === "string");
  // INVALID preserves everything, including other labels.
  assertEquals(aggregateCorrectness("partial", "n.", "INVALID"), { label: "partial", groundingNote: "n." });
});

function mockFetch(handler: (url: string, init: Record<string, unknown>) => unknown) {
  let calls = 0;
  const fn = (async (url: unknown, init: unknown) => {
    calls++;
    return handler(String(url), (init ?? {}) as Record<string, unknown>);
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

function okJson(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function checkerInput() {
  return {
    question: "What is the notice period?",
    answer: "The notice period is 30 days [S1].",
    evidence: [{ n: 1, page: 4 as number | null, text: "The lease requires 30 days notice." }],
    gate_verdict: "SUPPORTED" as const,
    citations: [{ n: 1, chunk_ref: "c1" }],
  };
}

function passEnvelope() {
  return {
    choices: [{ message: { content: JSON.stringify(validResult()) } }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

Deno.test("integration: happy path returns PASS verdict with transport metadata", async () => {
  const m = mockFetch(() => okJson(passEnvelope()));
  const o = await evaluateAnswer({
    fetchFn: m.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(),
  });
  assertEquals(m.calls(), 1);
  assert(o.invoked && o.verdict === "PASS" && o.invalidReason === null);
  assert(typeof (o as { latencyMs: number }).latencyMs === "number");
  // Observability-only metadata: single attempt, model text length.
  // NOTE: passEnvelope uses usage {input_tokens, output_tokens}, which the
  // OpenAI-style parser does not read (it reads prompt_tokens /
  // completion_tokens), so outputTokens is null here by contract.
  assert(o.invoked && o.attempts === 1);
  assert(o.invoked && typeof o.outputChars === "number" && (o.outputChars as number) > 0);
  assert(o.invoked && o.outputTokens === null);
});

Deno.test("integration: provider completion_tokens pass through when present", async () => {
  const m = mockFetch(() => okJson({
    choices: [{ message: { content: JSON.stringify(validResult()) } }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  }));
  const o = await evaluateAnswer({
    fetchFn: m.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(),
  });
  assert(o.invoked && o.verdict === "PASS");
  assert(o.invoked && o.outputTokens === 7);
});

Deno.test("integration: absent provider usage becomes null, never guessed", async () => {
  const m = mockFetch(() => okJson({
    choices: [{ message: { content: JSON.stringify(validResult()) } }],
    usage: {},
  }));
  const o = await evaluateAnswer({
    fetchFn: m.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(),
  });
  assert(o.invoked && o.verdict === "PASS");
  assert(o.invoked && o.outputTokens === null);
  assert(o.invoked && typeof o.outputChars === "number");
});

Deno.test("integration: think-wrapped JSON parses via stripThink behavior", async () => {
  const m = mockFetch(() => okJson({
    choices: [{ message: { content: `<think>reasoning here</think>\n${JSON.stringify(validResult({ verdict: "PARTIAL", claims: [{ claim_id: "c1", claim_text: "x.", judgment: "unsupported", evidence_refs: [1], issue: "y" }], feedback: "p." }))}` } }],
    usage: {},
  }));
  const o = await evaluateAnswer({
    fetchFn: m.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(),
  });
  assertEquals(m.calls(), 1);
  assert(o.invoked && o.verdict === "PARTIAL");
});

Deno.test("integration: prose output is INVALID with no retry", async () => {
  const m = mockFetch(() => okJson({ choices: [{ message: { content: "I think it looks fine." } }], usage: {} }));
  const o = await evaluateAnswer({
    fetchFn: m.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(),
  });
  assertEquals(m.calls(), 1);
  assert(o.invoked && o.verdict === "INVALID" && o.invalidReason === "invalid-json");
  assert(o.invoked && o.attempts === 1 && typeof o.outputChars === "number" && o.outputTokens === null);
});

Deno.test("integration: transport failure retries once then INVALID", async () => {
  const m = mockFetch(() => { throw new TypeError("boom"); });
  const o = await evaluateAnswer({
    fetchFn: m.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(), timeoutMs: 1000,
  });
  assertEquals(m.calls(), 2);
  assert(o.invoked && o.verdict === "INVALID" && o.invalidReason === "transport");
  assert(o.invoked && o.attempts === 2 && o.outputChars === null && o.outputTokens === null);
});

Deno.test("integration: 500 retries once, 429 never retried", async () => {
  let n = 0;
  const m = mockFetch(() => (++n === 1 ? okJson({ error: "x" }, 500) : okJson(passEnvelope())));
  const o = await evaluateAnswer({
    fetchFn: m.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(),
  });
  assertEquals(m.calls(), 2);
  assert(o.invoked && o.verdict === "PASS");
  const m2 = mockFetch(() => okJson({ error: "slow" }, 429));
  const o2 = await evaluateAnswer({
    fetchFn: m2.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(),
  });
  assertEquals(m2.calls(), 1);
  assert(o2.invoked && o2.verdict === "INVALID" && o2.invalidReason === "provider-http-429");
});

Deno.test("integration: timeout is INVALID after one retry", async () => {
  const m = mockFetch((_url, init) =>
    new Promise((_res, rej) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      const err = new DOMException("aborted", "TimeoutError");
      if (signal?.aborted) {
        rej(err);
        return;
      }
      signal?.addEventListener("abort", () => rej(err));
    })
  );
  const o = await evaluateAnswer({
    fetchFn: m.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(), timeoutMs: 30,
  });
  assertEquals(m.calls(), 2);
  assert(o.invoked && o.verdict === "INVALID");
  assert(o.invoked && (o.invalidReason === "timeout" || o.invalidReason === "transport"));
});

Deno.test("integration: model INVALID verdict stays INVALID without echo", async () => {
  const m = mockFetch(() => okJson({
    choices: [{ message: { content: JSON.stringify({ checker: CORRECTNESS_CHECKER_NAME, verdict: "INVALID", claims: [], feedback: "Cannot judge.", invalid_result: true, invalid_reason: "model-side reason text" }) } }],
    usage: {},
  }));
  const o = await evaluateAnswer({
    fetchFn: m.fn, url: "https://x/v1/chat", mantleKey: "k", model: "m", input: checkerInput(),
  });
  assert(o.invoked && o.verdict === "INVALID" && o.invalidReason === "checker-invalid");
});
