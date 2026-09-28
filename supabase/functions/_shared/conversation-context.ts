// conversation-context — H3A minimum viable conversation-context contract.
//
// Pure summarizer for a bounded slice of recent messages. It answers, without
// ever retaining raw document text: is there a previous turn, what was the
// previous user question, and does the previous assistant turn carry reusable
// evidence identifiers?
//
// Hard limits:
//   - the caller reads at most CONTEXT_HISTORY_LIMIT messages (newest first);
//   - the previous question is capped at CONTEXT_QUESTION_CHARS in memory;
//   - evidence is summarized as identifiers/counts only (chunk ids from
//     `messages.sources`), never content.
//
// The contract is tenant/conversation scoped by construction: the caller only
// passes rows it already read under RLS for one verified conversation.

/** Bounded recent-message window (2 turns). */
export const CONTEXT_HISTORY_LIMIT = 4;
/** Upper bound retained for the previous user question (ask accepts ≤1000). */
export const CONTEXT_QUESTION_CHARS = 1000;

export type ConversationContextRead = {
  /** How many messages were actually read (≤ CONTEXT_HISTORY_LIMIT). */
  historyTurnsRead: number;
  /** At least one prior message exists in the window. */
  previousMessageAvailable: boolean;
  /** Most recent prior user question, capped; null when none. */
  previousUserQuestion: string | null;
  /** The most recent prior assistant turn carries ≥1 evidence chunk id. */
  priorEvidenceAvailable: boolean;
  /** Distinct evidence chunk ids on that turn. */
  priorEvidenceCount: number;
};

export type ContextMessageRow = {
  role: string | null;
  content: string | null;
  sources?: unknown;
};

/**
 * The most recent assistant turn's `sources` array (newest-first input), for
 * bounded prior-evidence validation. Returns [] when the newest assistant row
 * carries no sources array. The returned array is the live reference, not a
 * copy — callers must not mutate it.
 */
export function mostRecentAssistantSources(
  rows: ContextMessageRow[] | null | undefined,
): unknown[] {
  if (!Array.isArray(rows)) return [];
  const row = rows.slice(0, CONTEXT_HISTORY_LIMIT).find((r) => r?.role === "assistant");
  return Array.isArray(row?.sources) ? (row.sources as unknown[]) : [];
}

function evidenceChunkIds(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const ids = new Set<string>();
  for (const entry of sources) {
    if (entry && typeof entry === "object") {
      const id = (entry as { chunk_id?: unknown }).chunk_id;
      if (typeof id === "string" && id !== "") ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Summarize rows ordered newest-first. Unknown shapes degrade to "absent"
 * rather than throwing: context is an enhancement, never a failure source.
 */
export function summarizeConversationContext(
  rows: ContextMessageRow[] | null | undefined,
): ConversationContextRead {
  const list = Array.isArray(rows) ? rows.slice(0, CONTEXT_HISTORY_LIMIT) : [];
  let previousUserQuestion: string | null = null;
  let priorEvidenceAvailable = false;
  let priorEvidenceCount = 0;
  let sawAssistant = false;

  for (const row of list) {
    if (previousUserQuestion === null && row?.role === "user" && typeof row.content === "string" && row.content !== "") {
      previousUserQuestion = row.content.slice(0, CONTEXT_QUESTION_CHARS);
    }
    // Only the MOST RECENT assistant turn counts: an older turn's evidence
    // must not masquerade as current context.
    if (!sawAssistant && row?.role === "assistant") {
      sawAssistant = true;
      const ids = evidenceChunkIds(row.sources);
      priorEvidenceAvailable = ids.length > 0;
      priorEvidenceCount = ids.length;
    }
  }

  return {
    historyTurnsRead: list.length,
    previousMessageAvailable: list.length > 0,
    previousUserQuestion,
    priorEvidenceAvailable,
    priorEvidenceCount,
  };
}
