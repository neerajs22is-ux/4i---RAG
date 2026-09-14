// grounding_test.ts — deterministic unit tests for _shared/grounding.ts.
// Run: deno test supabase/functions/_shared/grounding_test.ts
// No I/O, no network, no secrets. Every case is fully deterministic.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  checkGroundedness,
  clarificationTrigger,
  parseCitations,
  promptModeFor,
  renderPrompt,
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
