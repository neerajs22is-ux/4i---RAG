// Temporary chat files — scope helpers (pure, unit-tested).
//
// A temporary document is an ordinary `documents` row with a conversation
// binding and an expiry timestamp:
//   persistent: expires_at IS NULL AND conversation_id IS NULL (unchanged)
//   temporary:  expires_at IS NOT NULL AND conversation_id IS NOT NULL
//
// These helpers encode the scope-combination rules shared by `ask` and
// `query-chunks`. They never touch I/O: the callers resolve the ID sets
// server-side (tenant membership, conversation ownership, ready + unexpired
// state) and only combine them here. Retrieval-time expiry filtering — not
// cleanup — is the access boundary, so every predicate below fails closed.

/** Temporary-file time to live: 24 hours from registration. */
export const TEMP_TTL_MS = 24 * 60 * 60 * 1000;

/** Registration-time expiry for a temporary document. */
export function tempExpiresAt(nowMs: number): string {
  return new Date(nowMs + TEMP_TTL_MS).toISOString();
}

/** Order-stable union of two document-ID sets (no duplicates). */
export function unionDocIds(first: string[] | null, second: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...(first ?? []), ...second]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export type ScopeCombinationInput = {
  /** Whether the caller requested a notebook/Space scope. */
  notebookRequested: boolean;
  /** Server-resolved persistent scope (null = none requested). */
  notebookIds: string[] | null;
  /** Server-resolved ready + unexpired temporary IDs for the conversation. */
  tempIds: string[];
};

export type ScopeCombination = {
  /**
   * Allowed document IDs, or null for unscoped (legacy persistent) behaviour.
   * Never an empty array: an empty allowed set is expressed via `refused`.
   */
  ids: string[] | null;
  /** True only when a requested scope resolved to nothing (refuse, no LLM). */
  refused: boolean;
};

/**
 * Combine a persistent notebook scope with a conversation temporary set.
 *
 * Rules (each covered by unit tests):
 * - any IDs at all → retrieve exactly those (Space-only, temp-only, union);
 * - notebook requested but both sets empty → deterministic refusal;
 * - nothing requested and nothing temporary → null (byte-identical unscoped
 *   persistent behaviour).
 */
export function combineScopes(input: ScopeCombinationInput): ScopeCombination {
  const ids = unionDocIds(input.notebookIds, input.tempIds);
  if (ids.length > 0) return { ids, refused: false };
  if (input.notebookRequested) return { ids: null, refused: true };
  return { ids: null, refused: false };
}

export type DocumentScopeRow = {
  expires_at: string | null;
};

/** A row is temporary iff it carries an expiry timestamp. */
export function isTempDoc(row: DocumentScopeRow): boolean {
  return row.expires_at !== null;
}

/**
 * True when a temporary row must no longer be retrievable. Persistent rows
 * (NULL expiry) are never expired; malformed timestamps fail closed.
 */
export function isExpiredTemp(row: DocumentScopeRow, nowMs: number): boolean {
  if (row.expires_at === null) return false;
  const t = Date.parse(row.expires_at);
  if (Number.isNaN(t)) return true;
  return t <= nowMs;
}
