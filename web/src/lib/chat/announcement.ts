/**
 * Screen-reader announcement handoff (+ fresh-answer reveal handoff).
 *
 * The first answer in a workspace conversation completes the URL change to
 * `/c/<id>` (the reload must show the persisted transcript). That navigation
 * mounts a fresh `ChatView`, so an announcement held in component state would
 * be unmounted before it could be read — and a freshly mounted answer would
 * lose its entrance animation before the reader ever sees it.
 *
 * This tiny module carries both across that one mount. Each slot is
 * write-once, read-once and deliberately memory-only: no persistence, no
 * replay on later loads, and an unread value is simply overwritten.
 */

let pending: string | null = null;

/** Queue the message for the next mounted transcript. */
export function setPendingAnnouncement(text: string): void {
  pending = text;
}

/** Take the queued message, clearing it. */
export function takePendingAnnouncement(): string | null {
  const text = pending;
  pending = null;
  return text;
}

let pendingFreshConversation: string | null = null;

/**
 * Queue the conversation whose freshly generated answer should animate once
 * on the remounted transcript. The pre-remount tree (which carries the
 * entrance flag) is replaced before its reveal can complete, so the remount
 * re-applies the entrance to that answer instead of replaying anything.
 */
export function setPendingFreshConversation(conversationId: string): void {
  pendingFreshConversation = conversationId;
}

/** Take the queued conversation id, clearing it. */
export function takePendingFreshConversation(): string | null {
  const id = pendingFreshConversation;
  pendingFreshConversation = null;
  return id;
}
