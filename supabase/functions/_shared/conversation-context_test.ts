// H3A conversation-context contract tests — pure summarizer, bounded window.
//
// Run: deno test supabase/functions/_shared/conversation-context_test.ts

import {
  CONTEXT_HISTORY_LIMIT,
  CONTEXT_QUESTION_CHARS,
  mostRecentAssistantSources,
  summarizeConversationContext,
} from "./conversation-context.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

Deno.test("context: no rows means no context", () => {
  const empty = summarizeConversationContext([]);
  assertEquals(empty.historyTurnsRead, 0, "turns");
  assertEquals(empty.previousMessageAvailable, false, "message");
  assertEquals(empty.previousUserQuestion, null, "question");
  assertEquals(empty.priorEvidenceAvailable, false, "evidence");
  assertEquals(empty.priorEvidenceCount, 0, "count");
  assertEquals(summarizeConversationContext(null).previousMessageAvailable, false, "null input");
  assertEquals(summarizeConversationContext(undefined).previousMessageAvailable, false, "undefined input");
});

Deno.test("context: newest-first rows yield the previous question and evidence flags", () => {
  const read = summarizeConversationContext([
    {
      role: "assistant",
      content: "The lock-in period is 36 months [S1].",
      sources: [{ chunk_id: "c1" }, { chunk_id: "c2" }],
    },
    { role: "user", content: "What is the lock-in period?", sources: [] },
    { role: "assistant", content: "Earlier answer", sources: [{ chunk_id: "c0" }] },
    { role: "user", content: "Earlier question", sources: [] },
  ]);
  assertEquals(read.historyTurnsRead, 4, "turns read");
  assertEquals(read.previousMessageAvailable, true, "message present");
  assertEquals(read.previousUserQuestion, "What is the lock-in period?", "newest user question");
  assertEquals(read.priorEvidenceAvailable, true, "evidence present");
  assertEquals(read.priorEvidenceCount, 2, "distinct ids");
});

Deno.test("context: only the most recent assistant turn counts for evidence", () => {
  const read = summarizeConversationContext([
    { role: "assistant", content: "I could not find enough information.", sources: [] },
    { role: "user", content: "What is the notice period?", sources: [] },
    { role: "assistant", content: "Earlier answer with sources.", sources: [{ chunk_id: "c9" }] },
  ]);
  assertEquals(read.priorEvidenceAvailable, false, "older evidence must not leak forward");
  assertEquals(read.priorEvidenceCount, 0, "count");
});

Deno.test("context: the window and the question length are hard bounded", () => {
  const rows = Array.from({ length: CONTEXT_HISTORY_LIMIT + 3 }, (_, i) => ({
    role: i % 2 === 0 ? "assistant" : "user",
    content: `message ${i}`,
    sources: [],
  }));
  const read = summarizeConversationContext(rows);
  assertEquals(read.historyTurnsRead, CONTEXT_HISTORY_LIMIT, "window capped");

  const long = "x".repeat(CONTEXT_QUESTION_CHARS + 500);
  const capped = summarizeConversationContext([{ role: "user", content: long, sources: [] }]);
  assertEquals(capped.previousUserQuestion?.length, CONTEXT_QUESTION_CHARS, "question capped");
});

Deno.test("context: malformed sources degrade to absent, never throw", () => {
  const read = summarizeConversationContext([
    { role: "assistant", content: "answer", sources: "not-an-array" },
    { role: "user", content: "question", sources: [{ chunk_id: 42 }, { chunk_id: "" }, null] },
  ]);
  assertEquals(read.previousMessageAvailable, true, "rows read");
  assertEquals(read.priorEvidenceAvailable, false, "malformed sources ignored");
  assertEquals(read.priorEvidenceCount, 0, "no phantom ids");
});

Deno.test("prior sources: newest assistant row only, live reference", () => {
  const newest = [{ chunk_id: "c-new" }];
  const rows = [
    { role: "assistant", content: "new", sources: newest },
    { role: "user", content: "q", sources: [] },
    { role: "assistant", content: "old", sources: [{ chunk_id: "c-old" }] },
  ];
  const out = mostRecentAssistantSources(rows);
  assertEquals(out.length, 1, "one row");
  assertEquals((out[0] as { chunk_id: string }).chunk_id, "c-new", "newest row");
  assert(out === newest, "live reference, not a copy");
});

Deno.test("prior sources: absent when nothing usable exists", () => {
  assertEquals(mostRecentAssistantSources([]), [], "empty");
  assertEquals(mostRecentAssistantSources(null), [], "null");
  assertEquals(mostRecentAssistantSources([{ role: "assistant", content: "x", sources: "bad" }]), [], "non-array");
  assertEquals(mostRecentAssistantSources([{ role: "user", content: "q", sources: [] }]), [], "no assistant");
});
