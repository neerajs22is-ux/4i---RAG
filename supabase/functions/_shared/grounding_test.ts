// grounding_test.ts — deterministic unit tests for _shared/grounding.ts.
// Run: deno test supabase/functions/_shared/grounding_test.ts
// No I/O, no network, no secrets. Every case is fully deterministic.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  checkGroundedness,
  clarificationTrigger,
  mapMantleFailure,
  parseCitations,
  parseMantleResponse,
  promptModeFor,
  renderPrompt,
  tripwireDiagnostics,
  validateCitations,
  verifyEvidence,
  type EvidenceItem,
} from "./grounding.ts";

const T = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const D = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function ev(content: string, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    chunk_id: "c1",
    document_id: D,
    tenant_id: T,
    file_name: "lease.pdf",
    page: 4,
    content,
    ...extra,
  };
}

// --- evidence gate ---

Deno.test("gate: supported when every atom is covered", () => {
  const r = verifyEvidence("What is the lock-in period?", [
    ev("The lock-in period in the lease deed is 36 months."),
  ]);
  assertEquals(r.verdict, "SUPPORTED");
});

Deno.test("gate: insufficient on empty evidence", () => {
  const r = verifyEvidence("What is the lock-in period?", []);
  assertEquals(r.verdict, "INSUFFICIENT");
  assertEquals(r.reason, "no-evidence");
});

Deno.test("gate: partial when some atoms are missing but related", () => {
  const r = verifyEvidence("What is the lock-in and notice period?", [
    ev("The lock-in period in the lease deed is 36 months."),
  ]);
  assertEquals(r.verdict, "PARTIAL");
  assert(r.unsupported.length > 0);
});

Deno.test("gate: conflicting on distinct numbers with the same unit", () => {
  const r = verifyEvidence("What is the notice period?", [
    ev("The lease requires 30 days notice for termination.", { chunk_id: "c1" }),
    ev("The lease requires 60 days notice for termination.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "CONFLICTING");
  assert(r.conflicting.length > 0);
});

Deno.test("gate: incidental bare numbers stay silent (Step 3C.3)", () => {
  const r = verifyEvidence("What is the notice period?", [
    ev("The notice period spans 30 days under rule 1234.", { chunk_id: "c1" }),
    ev("Rule 5678 also covers the notice period fees.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "SUPPORTED");
  assertEquals(r.conflicting.length, 0);
});

Deno.test("gate: disjoint number-dense evidence is INSUFFICIENT (Step 3C.3)", () => {
  const r = verifyEvidence("What is the arbitration clause?", [
    ev("Section 1234 sets fees of 500 rupees.", { chunk_id: "c1" }),
    ev("In 2021, section 5678 fixed penalties at 900 rupees.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "INSUFFICIENT");
  assertEquals(r.conflicting.length, 0);
});

Deno.test("gate: boilerplate-only negation sharing stays silent (Step 3C.3)", () => {
  const r = verifyEvidence("What is the notice period?", [
    ev("The notice period is 30 days, signed and sealed.", { chunk_id: "c1" }),
    ev("Notice periods were signed and sealed, not reviewed.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "SUPPORTED");
  assertEquals(r.conflicting.length, 0);
});

Deno.test("gate: bare number asked about in the question still conflicts (Step 3C.3)", () => {
  const r = verifyEvidence("Was it section 1234 or section 5678?", [
    ev("See section 1234 for the rule.", { chunk_id: "c1" }),
    ev("No, section 5678 governs instead.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "CONFLICTING");
  assert(r.conflicting.length > 0);
});

Deno.test("gate: different provisions with different amounts stay silent (Step 3C.3)", () => {
  const r = verifyEvidence("What is the standard deduction?", [
    ev("The standard deduction is 75000 rupees.", { chunk_id: "c1" }),
    ev("The penalty is 5000 rupees.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "SUPPORTED");
  assertEquals(r.conflicting.length, 0);
});

Deno.test("gate: same proposition with incompatible dates conflicts (Step 3C.3)", () => {
  const r = verifyEvidence("When does the Act come into force?", [
    ev("The Act comes into force on the 1st April, 2026.", { chunk_id: "c1" }),
    ev("The Act comes into force on the 1st April, 2025.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "CONFLICTING");
  assert(r.conflicting.length > 0);
});

Deno.test("gate: amendment succession (prior quote + current text) is not a conflict (Step 3C.5)", () => {
  const r = verifyEvidence("How is co-operative society defined after the Finance Act, 2026 amendment?", [
    ev("Substituted by the Finance Act, 2026, w.e.f. 1-4-2026 after amendment. Prior to its substitution, clause read as under: co-operative society means a society registered under the Societies Act, 1912.", { chunk_id: "c1" }),
    ev("Co-operative society is defined as a society registered under the Societies Act, 1912, or the Multi-State Societies Act, 2002.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "SUPPORTED");
  assertEquals(r.conflicting.length, 0);
});

Deno.test("gate: same-version conflict beside currency markers still conflicts (Step 3C.5)", () => {
  const r = verifyEvidence("What is the employer contribution rate w.e.f. 2026?", [
    ev("The employer contribution rate is 10% w.e.f. 1-4-2026.", { chunk_id: "c1" }),
    ev("The employer contribution rate is 12% w.e.f. 1-4-2026.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "CONFLICTING");
  assert(r.conflicting.length > 0);
});

Deno.test("gate: amendment effective date beside prior Act year does not conflict (Step 3C.5)", () => {
  const r = verifyEvidence("When did the 2026 amendment take effect?", [
    ev("The 2026 amendment sets the clause limit. Prior to amendment, the clause read as under: the 1912 clause limit.", { chunk_id: "c1" }),
    ev("The amended clause limit takes effect in 2026.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "SUPPORTED");
  assertEquals(r.conflicting.length, 0);
});

Deno.test("gate: insufficient when evidence is disjoint from the question", () => {
  const r = verifyEvidence("What is the arbitration clause?", [
    ev("The monthly rent is payable on the fifth day."),
  ]);
  assertEquals(r.verdict, "INSUFFICIENT");
});

// --- prompt selection ---

Deno.test("prompt selection maps verdicts to modes", () => {
  assertEquals(promptModeFor("SUPPORTED"), "direct");
  assertEquals(promptModeFor("PARTIAL"), "partial");
  assertEquals(promptModeFor("CONFLICTING"), "conflict");
  assertEquals(promptModeFor("INSUFFICIENT"), "refuse");
});

Deno.test("rendered prompts embed evidence and question, never outside text", () => {
  const { template, version } = renderPrompt("direct", "Q?", "[S1] (f p. 1)\nCTX");
  assert(template.includes("Q?") && template.includes("CTX") && version.startsWith("v1-direct"));
});

// --- clarification gate ---

Deno.test("clarify: bare anaphoric query with no history needs clarification", () => {
  const r = clarificationTrigger("What about it?", 0, 3);
  assert(r.needed === true && r.reason === "anaphoric-no-referent");
});

Deno.test("clarify: same query with history proceeds", () => {
  assertEquals(clarificationTrigger("What about it?", 2, 3).needed, false);
});

Deno.test("clarify: comparison naming two pdfs proceeds", () => {
  assertEquals(
    clarificationTrigger("Compare a.pdf and b.pdf", 0, 3).needed,
    false,
  );
});

Deno.test("clarify: comparison naming one pdf with several docs clarifies", () => {
  const r = clarificationTrigger("Compare the notice in a.pdf", 0, 3);
  assert(r.needed === true && r.reason === "ambiguous-comparison-target");
});

Deno.test("clarify: comparison with a single-doc corpus proceeds", () => {
  assertEquals(clarificationTrigger("Compare the notice in a.pdf", 0, 1).needed, false);
});

Deno.test("clarify: ordinary question proceeds", () => {
  assertEquals(clarificationTrigger("What is the lock-in period?", 0, 3).needed, false);
});

// --- citation guard ---

const EV2: EvidenceItem[] = [
  ev("The lock-in is 36 months.", { chunk_id: "c1", page: 4 }),
  ev("Notice is 30 days.", { chunk_id: "c2", page: 9 }),
];

Deno.test("citations: valid answer passes", () => {
  assertEquals(validateCitations("The lock-in is 36 months [S1] and notice is 30 days [S2].", EV2, T).ok, true);
});

Deno.test("citations: nonexistent chunk citation fails", () => {
  const r = validateCitations("The lock-in is 36 months [S3].", EV2, T);
  assertEquals(r.ok, false);
});

Deno.test("citations: malformed citation fails", () => {
  assertEquals(validateCitations("The lock-in is long [S].", EV2, T).ok, false);
  assertEquals(validateCitations("The lock-in is long [S0].", EV2, T).ok, false);
});

Deno.test("citations: wrong-document scope fails", () => {
  const r = validateCitations("Notice is 30 days [S2].", EV2, T, { documentId: "other-doc" });
  assertEquals(r.ok, false);
});

Deno.test("citations: cross-tenant row fails", () => {
  const foreign = ev("Notice is 30 days.", { chunk_id: "x1", tenant_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
  assertEquals(validateCitations("Notice [S1].", [foreign], T).ok, false);
});

Deno.test("parseCitations extracts numbers in order", () => {
  assertEquals(parseCitations("A [S2] B [S1] C [S10]."), [2, 1, 10]);
});

// --- groundedness tripwire ---

const LEASE_EV = ["The lock-in period in the lease deed is 36 months. Early termination requires 3 months written notice."];

Deno.test("tripwire: supported factual answer is grounded", () => {
  const r = checkGroundedness(
    "The lock-in period is 36 months [S1]. Early termination requires 3 months written notice [S1].",
    LEASE_EV,
  );
  assertEquals(r.grounded, true);
});

Deno.test("tripwire: unsupported number is flagged", () => {
  const r = checkGroundedness("The lock-in period is 48 months [S1].", LEASE_EV);
  assertEquals(r.grounded, false);
  assert(r.numericMismatches.length > 0);
});

Deno.test("tripwire: unsupported date is flagged", () => {
  const r = checkGroundedness("The lease was signed on 2024-03-15 [S1].", LEASE_EV);
  assertEquals(r.grounded, false);
});

Deno.test("tripwire: unsupported named entity sentence is flagged", () => {
  const r = checkGroundedness("The arbitration panel in Mumbai awarded damages [S1].", LEASE_EV);
  assertEquals(r.grounded, false);
  assert(r.unsupportedClaims.length > 0);
});

Deno.test("tripwire: dropped negation is flagged", () => {
  const r = checkGroundedness(
    "Early termination requires written notice [S1].",
    ["Early termination does not require written notice under this lease."],
  );
  assertEquals(r.grounded, false);
  assert(r.missingQualifiers.length > 0);
});

Deno.test("tripwire: refusal phrasing carries no factual load", () => {
  const r = checkGroundedness(
    "I could not find enough relevant information in the documents to answer that.",
    LEASE_EV,
  );
  assertEquals(r.grounded, true);
});

// --- tripwire diagnostics (Step 3C.19, observability only) ---

Deno.test("tripwire diagnostics: grounded case reports grounded with empty findings", () => {
  const d = tripwireDiagnostics(checkGroundedness(
    "The lock-in period is 36 months [S1]. Early termination requires 3 months written notice [S1].",
    LEASE_EV,
  ));
  assertEquals(d.reason, "grounded");
  assertEquals(d.findings, []);
  assertEquals(d.counts, { unsupportedClaims: 0, numericMismatches: 0, missingQualifiers: 0 });
});

Deno.test("tripwire diagnostics: numeric mismatch categorised with bounded findings", () => {
  const d = tripwireDiagnostics(checkGroundedness("The lock-in period is 48 months [S1].", LEASE_EV));
  assertEquals(d.reason, "numeric-mismatch");
  assert(d.findings.length >= 1 && d.findings.length <= 3);
  assertEquals(d.counts.numericMismatches >= 1, true);
});

Deno.test("tripwire diagnostics: dropped negation takes priority as missing-qualifier", () => {
  const d = tripwireDiagnostics(checkGroundedness(
    "Early termination requires written notice [S1].",
    ["Early termination does not require written notice under this lease."],
  ));
  assertEquals(d.reason, "missing-qualifier");
  assert(d.findings.length >= 1 && d.findings.length <= 3);
});

Deno.test("tripwire diagnostics: unsupported sentence categorised when nothing else fires", () => {
  const d = tripwireDiagnostics(checkGroundedness("The arbitration panel in Mumbai awarded damages [S1].", LEASE_EV));
  assertEquals(d.reason, "unsupported-claims");
  assert(d.findings.length >= 1 && d.findings.length <= 3);
});

Deno.test("tripwire diagnostics: findings stay bounded under many failures", () => {
  const sentences = [
    "The lease was signed on 2024-03-15 [S1].",
    "A penalty of 999 rupees applies [S1].",
    "The term runs for 77 months [S1].",
    "Arbitration in Mumbai awarded damages [S1].",
    "The deposit equals 5 BTC [S1].",
  ];
  const d = tripwireDiagnostics(checkGroundedness(sentences.join(" "), LEASE_EV));
  assertEquals(d.reason, "numeric-mismatch");
  assert(d.findings.length <= 3);
  assertEquals(
    d.counts.unsupportedClaims + d.counts.numericMismatches + d.counts.missingQualifiers >= 2,
    true,
  );
});

// --- Mantle transport mapping ---

Deno.test("mantle: 401/403 map to auth failure", () => {
  for (const s of [401, 403]) {
    const f = mapMantleFailure(s, '{"error":"denied"}');
    assertEquals(f.kind, "auth");
    assert(!/Bearer\s+[A-Za-z0-9]|sk-[A-Za-z0-9]/i.test(f.message));
  }
});

Deno.test("mantle: 429 maps to throttled", () => {
  const f = mapMantleFailure(429, "slow down");
  assertEquals(f.kind, "throttled");
});

Deno.test("mantle: 5xx maps to provider failure with bounded body", () => {
  const f = mapMantleFailure(500, "x".repeat(500));
  assertEquals(f.kind, "provider");
  assert(f.message.includes("status 500"));
  assert(f.message.length <= 260); // status text + at most 200 body chars
});

Deno.test("mantle: valid response parses text + usage", () => {
  const r = parseMantleResponse({
    choices: [{ message: { content: "The lock-in is 36 months [S1]." } }],
    usage: { prompt_tokens: 120, completion_tokens: 15 },
  });
  assert(r.ok === true && r.text.includes("36 months"));
  if (r.ok) assertEquals([r.inputTokens, r.outputTokens], [120, 15]);
});

Deno.test("mantle: missing/empty content fails closed", () => {
  assertEquals(parseMantleResponse({ choices: [] }).ok, false);
  assertEquals(parseMantleResponse({ choices: [{ message: {} }] }).ok, false);
  assertEquals(parseMantleResponse({ choices: [{ message: { content: "   " } }] }).ok, false);
  assertEquals(parseMantleResponse("not json{{{").ok, false);
  assertEquals(parseMantleResponse(null).ok, false);
});

Deno.test("mantle: non-finite usage coerces to zero", () => {
  const r = parseMantleResponse({
    choices: [{ message: { content: "Hi [S1]." } }],
    usage: { prompt_tokens: "many", completion_tokens: null },
  });
  assert(r.ok === true);
  if (r.ok) assertEquals([r.inputTokens, r.outputTokens], [0, 0]);
});
