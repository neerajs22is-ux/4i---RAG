/**
 * Notebook change signal.
 *
 * A tiny external store, deliberately the same shape as
 * `lib/chat/conversations-store.ts`: components that display notebook data
 * subscribe to a revision number, and anything that mutates notebooks bumps it.
 * That keeps refresh logic explicit (no polling, no cache library) while letting
 * a mutation in one panel refresh a list in another.
 */

const listeners = new Set<() => void>();
let revision = 0;

export function subscribeNotebooks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotebookRevision(): number {
  return revision;
}

/** Server snapshot is constant so hydration never mismatches. */
export function getNotebookRevisionServer(): number {
  return 0;
}

/** Call after any notebook/source mutation to re-read dependent views. */
export function invalidateNotebooks(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
