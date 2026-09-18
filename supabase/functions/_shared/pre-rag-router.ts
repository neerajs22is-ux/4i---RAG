// pre-rag-router — Phase H1 deterministic pre-RAG router (no LLM, no I/O).
//
// Purpose: obvious conversational utterances ("Hi", "Thanks", "Good morning")
// must not pay for query embedding, retrieval, reranking, the evidence gate,
// RAG generation or the correctness checker. This module classifies a query
// deterministically and returns a fixed, server-authored reply for the
// conversational class. Everything else falls through to the existing RAG
// path unchanged.
//
// Conservative by construction:
//  - a phrase matches only as the WHOLE normalized message (exact match after
//    case/whitespace/wrapping-punctuation normalization) — a greeting that
//    carries any actual content ("Hi, what is the minimum investment?") can
//    never match, because the extra words remain;
//  - every non-conversational input — including gibberish and empty text —
//    is routed to the existing pipeline (fail closed);
//  - no semantic classification, no model call, no database, no state.
//
// Classes:
//  - CONVERSATIONAL: exact conversational phrase; `response` carries the tiny
//    deterministic reply.
//  - KNOWLEDGE_QUERY: appears to require document evidence (question mark,
//    digit, interrogative lead, or a knowledge verb). Observability only —
//    behaves exactly like UNKNOWN on the pipeline.
//  - UNKNOWN: everything else. Also proceeds through the existing RAG path;
//    the class exists so the boundary is measurable, never so the router can
//    guess.

export type PreRagClass = "CONVERSATIONAL" | "KNOWLEDGE_QUERY" | "UNKNOWN";

export type PreRagRoute = {
  classification: PreRagClass;
  /** Fixed reply for CONVERSATIONAL; null for every other class. */
  response: string | null;
  /** Normalized phrase that matched (observability); null otherwise. */
  matched: string | null;
};

/**
 * Normalize a message for exact-phrase matching: case-fold, unify curly
 * apostrophes, collapse whitespace, and strip wrapping punctuation only
 * (leading/trailing — never internal, so "hi, what ...?" can never collapse
 * into "hi what ...").
 */
export function normalizeRouterText(input: string): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc\u0060\u00b4]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s!?.,;:~\-–—()\[\]{}"'…*_]+/, "")
    .replace(/[\s!?.,;:~\-–—()\[\]{}"'…*_]+$/, "")
    .trim();
}

const GREETING_REPLY = "Hi! How can I help?";
const WELCOME_REPLY = "You're welcome.";
const FAREWELL_REPLY = "Goodbye!";

/**
 * Complete conversational utterances only. Each entry is a full-message
 * phrase: if any other words are present, the normalized message will not
 * equal the key and the query stays on the RAG path.
 */
const CONVERSATIONAL_REPLIES: Readonly<Record<string, string>> = {
  "hi": GREETING_REPLY,
  "hi there": GREETING_REPLY,
  "hello": GREETING_REPLY,
  "hello there": GREETING_REPLY,
  "hey": GREETING_REPLY,
  "hey there": GREETING_REPLY,
  "good morning": "Good morning! How can I help?",
  "good afternoon": "Good afternoon! How can I help?",
  "good evening": "Good evening! How can I help?",
  "thanks": WELCOME_REPLY,
  "thank you": WELCOME_REPLY,
  "thanks a lot": WELCOME_REPLY,
  "thanks so much": WELCOME_REPLY,
  "thank you so much": WELCOME_REPLY,
  "thank you very much": WELCOME_REPLY,
  "bye": FAREWELL_REPLY,
  "bye bye": FAREWELL_REPLY,
  "goodbye": FAREWELL_REPLY,
  "good bye": FAREWELL_REPLY,
  "see you": FAREWELL_REPLY,
  "see you later": FAREWELL_REPLY,
};

/** Opening word of a question or knowledge request. */
const QUESTION_LEADS: ReadonlySet<string> = new Set([
  "what", "which", "when", "where", "who", "whom", "whose", "why", "how",
  "does", "do", "did", "is", "are", "was", "were", "can", "could", "should",
  "would", "will", "tell", "explain", "summarize", "summarise", "describe",
  "compare", "list", "show", "find", "give", "define", "calculate",
]);

/** Anywhere in the message: a request that clearly wants an answer. */
const KNOWLEDGE_VERBS: ReadonlySet<string> = new Set([
  "explain", "summarize", "summarise", "describe", "compare", "define",
  "list", "calculate", "quote", "cite",
]);

function looksLikeKnowledgeRequest(raw: string, normalized: string): boolean {
  if (/\?/.test(raw)) return true;
  if (/\d/.test(normalized)) return true;
  const tokens = normalized.match(/[a-z']+/g) ?? [];
  const first = tokens[0];
  if (first === undefined) return false;
  if (QUESTION_LEADS.has(first)) return true;
  return tokens.some((token) => KNOWLEDGE_VERBS.has(token));
}

/** Classify one query. Pure and total: every input gets a class. */
export function routePreRag(input: string): PreRagRoute {
  const normalized = normalizeRouterText(input);
  const reply = normalized === "" ? undefined : CONVERSATIONAL_REPLIES[normalized];
  if (reply !== undefined) {
    return { classification: "CONVERSATIONAL", response: reply, matched: normalized };
  }
  return {
    classification: looksLikeKnowledgeRequest(String(input ?? ""), normalized)
      ? "KNOWLEDGE_QUERY"
      : "UNKNOWN",
    response: null,
    matched: null,
  };
}
