const listeners = new Set<() => void>();

/**
 * Conversation revision counter.
 *
 * `/ask` creates a conversation on the server, so after the first message the
 * sidebar list is stale. Rather than adding a data library or polling, the chat
 * bumps a revision and the sidebar re-reads. Tiny external store, read through
 * `useSyncExternalStore`.
 */
let revision = 0;

export function subscribeConversations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConversationRevision(): number {
  return revision;
}

export function getConversationRevisionServer(): number {
  return 0;
}

/** Call after any action that may have changed the conversation list. */
export function invalidateConversations(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
