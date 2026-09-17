const STORAGE_KEY = "rag4i:sidebar-collapsed";

/**
 * Sidebar collapse state, shared between the desktop rail and any other
 * consumer, persisted to localStorage.
 *
 * Two layers:
 * - the **global preference** (`collapsed`), persisted per user;
 * - a **context override** (`contextCollapsed`), set by routes that want the
 *   rail out of the way (a Space workspace) without touching the preference.
 *   Leaving the route clears it, so the user's own choice applies again.
 *
 * Implemented as a tiny external store so components read it through
 * `useSyncExternalStore`: that keeps the server render deterministic (always
 * expanded) and lets the client adopt the stored preference after hydration
 * without a setState-in-effect.
 */
let collapsed = false;
let contextCollapsed: boolean | null = null;
let initialised = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function subscribeSidebar(listener: () => void): () => void {
  listeners.add(listener);

  // First subscriber adopts the persisted preference, once, after hydration.
  if (!initialised) {
    initialised = true;
    const stored = readStored();
    if (stored !== collapsed) {
      collapsed = stored;
      notify();
    }
  }

  return () => {
    listeners.delete(listener);
  };
}

/** Effective state: the context override when set, otherwise the preference. */
export function getSidebarCollapsed(): boolean {
  return contextCollapsed ?? collapsed;
}

/** The persisted global preference, ignoring any context override. */
export function getSidebarPreference(): boolean {
  return collapsed;
}

/** Server and hydration snapshot: always expanded. */
export function getSidebarServerSnapshot(): boolean {
  return false;
}

export function setSidebarCollapsed(next: boolean): void {
  if (next === collapsed) return;
  collapsed = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Storage unavailable (private mode): state still works for the session.
  }
  notify();
}

/**
 * Set (or clear) the route-scoped override. Passing `null` returns the rail to
 * the user's global preference.
 */
export function setContextSidebarCollapsed(next: boolean | null): void {
  if (next === contextCollapsed) return;
  contextCollapsed = next;
  notify();
}

export function toggleSidebar(): void {
  if (contextCollapsed !== null) {
    setContextSidebarCollapsed(!contextCollapsed);
    return;
  }
  setSidebarCollapsed(!collapsed);
}
