// follow-up-detector — H3A deterministic follow-up classifier.
//
// Pure, no I/O, no LLM. Answers exactly one question: does this message carry
// an explicit continuation signal that only makes sense against the previous
// turn? It never resolves coreference semantically and never rewrites
// anything; H3A uses the result for telemetry only.
//
// Conservatism rules (the reason this exists):
//   - FOLLOW_UP requires BOTH an explicit continuation construction AND a
//     previous turn. With no history, continuation-shaped messages are
//     UNKNOWN — never a guess.
//   - STANDALONE is preserved for substantive question/imperative shapes and
//     is never degraded merely because a previous turn exists. A full
//     knowledge question ("What is the notice period?") stays STANDALONE in
//     any position in the conversation.
//   - Everything else is UNKNOWN and fails closed: bare imperatives like
//     "tell me more", deictic imperatives like "explain this", fragments, and
//     empty input.

import { normalizeRouterText } from "./pre-rag-router.ts";

export type FollowUpClass = "STANDALONE" | "FOLLOW_UP" | "UNKNOWN";

export type FollowUpInput = {
  message: string;
  hasPreviousTurn: boolean;
};

/** Opening words that make a message a real question. */
const QUESTION_LEADS: ReadonlySet<string> = new Set([
  "what", "which", "when", "where", "who", "whom", "whose", "why", "how",
  "does", "do", "did", "is", "are", "was", "were", "can", "could", "should",
  "would", "will",
]);

/** Imperatives that carry a substantive object (never bare references). */
const IMPERATIVE_LEADS: ReadonlySet<string> = new Set([
  "summarize", "summarise", "list", "compare", "define",
]);

/** Utterance-level references: these point at the previous turn. */
const ANAPHORS: ReadonlySet<string> = new Set(["that", "those", "these", "them"]);

/** "the second one", "the former", "the last one", ... (never bare ordinals) */
const ORDINAL_RE = /\b(the (first|second|third|fourth|fifth|last|other) one|the (latter|former))\b/;

function words(normalized: string): string[] {
  return normalized.match(/[a-z0-9']+/g) ?? [];
}

export function classifyFollowUp(input: FollowUpInput): FollowUpClass {
  const normalized = normalizeRouterText(input.message ?? "");
  if (normalized === "") return "UNKNOWN";
  const tokens = words(normalized);
  const first = tokens[0] ?? "";
  if (tokens.length === 0) return "UNKNOWN";

  const continuation =
    /^what about\b/.test(normalized) ||
    /^how about\b/.test(normalized) ||
    (/^and\b/.test(normalized) && tokens.length > 1) ||
    (tokens.length === 1 && first === "why") ||
    /^why not\b/.test(normalized) ||
    ORDINAL_RE.test(normalized) ||
    (QUESTION_LEADS.has(first) && tokens.some((token) => ANAPHORS.has(token)));

  if (continuation) return input.hasPreviousTurn ? "FOLLOW_UP" : "UNKNOWN";

  if (QUESTION_LEADS.has(first) && tokens.length >= 3) return "STANDALONE";
  if (
    IMPERATIVE_LEADS.has(first) && tokens.length >= 3 &&
    !tokens.some((token) => ANAPHORS.has(token) || token === "this" || token === "it")
  ) {
    return "STANDALONE";
  }
  return "UNKNOWN";
}
