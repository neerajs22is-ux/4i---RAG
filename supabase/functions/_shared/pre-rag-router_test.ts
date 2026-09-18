// Unit tests for the H1 deterministic pre-RAG router. Pure functions only —
// no network, no database, no model. Run:
//   deno test supabase/functions/_shared/pre-rag-router_test.ts

import {
  normalizeRouterText,
  routePreRag,
  type PreRagRoute,
} from "./pre-rag-router.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

/** Every non-conversational route must fall through to the RAG path. */
function assertFallsThrough(route: PreRagRoute, input: string): void {
  assert(
    route.classification !== "CONVERSATIONAL",
    `"${input}" must not be conversational (got ${route.classification})`,
  );
  assert(route.response === null, `"${input}" must not carry a canned reply`);
  assert(route.matched === null, `"${input}" must not report a match`);
}

/* ------------------------------------------------------------ positives */

Deno.test("conversational: task-listed phrases classify and reply", () => {
  const cases: Array<[string, string]> = [
    ["Hi", "Hi! How can I help?"],
    ["hi", "Hi! How can I help?"],
    ["Hello!", "Hi! How can I help?"],
    ["Hey", "Hi! How can I help?"],
    ["Thanks", "You're welcome."],
    ["Thank you", "You're welcome."],
    ["Good morning", "Good morning! How can I help?"],
    ["Bye", "Goodbye!"],
  ];
  for (const [input, expected] of cases) {
    const route = routePreRag(input);
    assertEquals(route.classification, "CONVERSATIONAL", `class of "${input}"`);
    assertEquals(route.response, expected, `reply to "${input}"`);
    assert(route.matched !== null, `matched key for "${input}"`);
  }
});

Deno.test("conversational: obvious phrase variants are recognized", () => {
  for (
    const input of [
      "Hi there",
      "hello there",
      "Hey there!",
      "Good afternoon",
      "good evening!",
      "Thanks a lot",
      "thanks so much!",
      "Thank you very much",
      "Bye bye",
      "Good bye",
      "See you",
      "See you later!",
    ]
  ) {
    const route = routePreRag(input);
    assertEquals(route.classification, "CONVERSATIONAL", `class of "${input}"`);
    assert(route.response !== null, `reply to "${input}"`);
  }
});

/* ------------------------------------------------------ normalization */

Deno.test("normalization: case, whitespace and wrapping punctuation", () => {
  assertEquals(normalizeRouterText("  Good   Morning!!! "), "good morning", "normalize spacing/case");
  assertEquals(normalizeRouterText("HI"), "hi", "case fold");
  assertEquals(normalizeRouterText("Thanks —"), "thanks", "trailing em dash");
  assertEquals(normalizeRouterText("hello..."), "hello", "ellipsis");
  assertEquals(normalizeRouterText("(thanks)"), "thanks", "wrapping brackets");
  assertEquals(normalizeRouterText("Hi, what is it?"), "hi, what is it", "internal punctuation kept, trailing stripped");

  for (
    const input of [
      "  Hi  ",
      "HI",
      "\nhey\t",
      "Hi!",
      "hi?!",
      "Hello...",
      "THANKS!!!",
      "Thank   You.",
      " Good   morning  ",
    ]
  ) {
    const route = routePreRag(input);
    assertEquals(route.classification, "CONVERSATIONAL", `variant "${input}"`);
    assert(route.response !== null, `reply to variant "${input}"`);
  }
});

/* ------------------------------------------------------------ negatives */

Deno.test("negative: greetings/questions with content never bypass RAG", () => {
  const cases = [
    "Hi, what is the minimum investment?",
    "Hello, summarize the document.",
    "Thanks — what does clause 4 say?",
    "What is the minimum investment?",
    "What is the notice period?",
    "Compare the two documents.",
  ];
  for (const input of cases) {
    assertFallsThrough(routePreRag(input), input);
  }
  // These all carry clear knowledge intent, so they classify as such.
  for (const input of cases) {
    assertEquals(routePreRag(input).classification, "KNOWLEDGE_QUERY", `class of "${input}"`);
  }
});

/* ------------------------------------------- ambiguous / fail-closed */

Deno.test("ambiguous: unrecognized non-questions fail closed to RAG", () => {
  for (const input of ["ok", "hmm", "lol", "hi hi", "goodmorning", "", "   ", "..."]) {
    assertFallsThrough(routePreRag(input), input);
    assertEquals(routePreRag(input).classification, "UNKNOWN", `class of "${input}"`);
  }
});

Deno.test("fallthrough invariant: response is non-null only for CONVERSATIONAL", () => {
  const inputs = [
    "Hi", "Thanks", "Good morning", "Bye",
    "Hi, what is the minimum investment?", "What is the notice period?",
    "Compare the two documents.", "ok", "", "Explain the lock-in period.",
  ];
  for (const input of inputs) {
    const route = routePreRag(input);
    assert(
      (route.response !== null) === (route.classification === "CONVERSATIONAL"),
      `response/class invariant for "${input}"`,
    );
  }
});
