/**
 * Screen-reader announcement handoff.
 *
 * The first answer in a workspace conversation completes the URL change to
 * `/c/<id>` (the reload must show the persisted transcript). That navigation
 * mounts a fresh `ChatView`, so an announcement held in component state would
 * be unmounted before it could be read.
 *
 * This tiny module carries the announcement across that one mount. It is
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
