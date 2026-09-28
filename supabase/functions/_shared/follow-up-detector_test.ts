// H3A follow-up detector tests — deterministic, pure, no LLM.
//
// Run: deno test supabase/functions/_shared/follow-up-detector_test.ts

import { classifyFollowUp, type FollowUpInput } from "./follow-up-detector.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function classify(message: string, hasPreviousTurn: boolean): string {
  return classifyFollowUp({ message, hasPreviousTurn } satisfies FollowUpInput);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

/* ---------------------------------------------------------- FOLLOW_UP */

Deno.test("follow-up: explicit continuation constructions with history", () => {
  const cases = [
    "What about Category II?",
    "And Category III?",
    "What about the notice period?",
    "Why?",
    "How about the second one?",
    "Does that apply here?",
    "What does that mean?",
  ];
  for (const message of cases) {
    assertEquals(classify(message, true), "FOLLOW_UP", `"${message}"`);
  }
});

Deno.test("follow-up: continuation signals without history fail closed to UNKNOWN", () => {
  for (
    const message of [
      "What about Category II?",
      "And Category III?",
      "Why?",
      "How about the second one?",
      "Does that apply here?",
      "What does that mean?",
    ]
  ) {
    assertEquals(classify(message, false), "UNKNOWN", `no-history "${message}"`);
  }
});

/* --------------------------------------------------------- STANDALONE */

Deno.test("standalone: substantive questions stay standalone with history", () => {
  const cases = [
    "What is the minimum investment?",
    "What are the eligibility requirements?",
    "What is the notice period?",
    "Summarize the regulation.",
  ];
  for (const message of cases) {
    assertEquals(classify(message, true), "STANDALONE", `with history "${message}"`);
    assertEquals(classify(message, false), "STANDALONE", `first turn "${message}"`);
  }
});

Deno.test("standalone: a full question is never degraded merely because history exists", () => {
  // The critical rule: specific knowledge questions remain STANDALONE even
  // directly after a turn whose topic overlaps.
  assertEquals(classify("What is the minimum investment?", true), "STANDALONE", "specific question after history");
  assertEquals(classify("What are the lock-in requirements?", true), "STANDALONE", "another specific question");
  assertEquals(classify("List the borrowing conditions.", true), "STANDALONE", "imperative with object");
});

/* ------------------------------------------------------------ UNKNOWN */

Deno.test("unknown: bare imperatives and deictic imperatives stay UNKNOWN", () => {
  for (const message of ["Tell me more.", "Explain this."]) {
    assertEquals(classify(message, true), "UNKNOWN", `"${message}"`);
  }
});

Deno.test("unknown: fragments, pronouns and empty input fail closed", () => {
  for (const message of ["And?", "ok", "hmm", "it", "???", "", "   ", "the second"]) {
    assertEquals(classify(message, true), "UNKNOWN", `"${message}"`);
  }
});

/* ------------------------------------------------------ normalization */

Deno.test("normalization: case, punctuation and whitespace do not change the class", () => {
  assertEquals(classify("  AND Category III?  ", true), "FOLLOW_UP", "case + whitespace");
  assertEquals(classify("WHAT DOES THAT MEAN?!", true), "FOLLOW_UP", "case + punctuation");
  assertEquals(classify("Why ?", true), "FOLLOW_UP", "space before punctuation");
  assertEquals(classify("what about\tcategory ii", true), "FOLLOW_UP", "tab whitespace");
  assertEquals(classify("SUMMARIZE THE REGULATION.", true), "STANDALONE", "imperative case");
  assertEquals(classify("Summarize the regulation.", true), "STANDALONE", "baseline");
});

/* ----------------------------------------------------- classifier purity */

Deno.test("purity: classification depends only on message and history flag", () => {
  const first = classifyFollowUp({ message: "What about Category II?", hasPreviousTurn: true });
  const second = classifyFollowUp({ message: "What about Category II?", hasPreviousTurn: true });
  assertEquals(first, second, "stable result");
  assert(first === "FOLLOW_UP", "expected follow-up");
});
