"use client";

import type { Session } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { listMemberships } from "@/lib/api/conversations";
import { ApiError, normalizeApiError } from "@/lib/api/errors";
import { tenantName } from "@/lib/api/types";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";

/**
 * Session and workspace resolution.
 *
 * Responsibilities, deliberately narrow:
 *  1. resolve the Supabase session (and keep it current via `onAuthStateChange`);
 *  2. resolve which workspaces (tenants) the user belongs to;
 *  3. remember the active workspace and expose a way to switch it.
 *
 * It does not cache API payloads and it does not talk to the Edge Functions —
 * that is the API layer's job. Plain React context is enough; a state library
 * would add weight without solving anything here.
 *
 * Every state update happens inside an async callback (never synchronously in an
 * effect body), which keeps hydration deterministic and satisfies the React 19
 * lint rules.
 */

export type SessionStatus = "loading" | "signed-out" | "signed-in";
export type WorkspaceStatus = "idle" | "loading" | "ready" | "none" | "error";

export type Workspace = {
  tenantId: string;
  name: string;
  role: string;
};

export type SessionUser = {
  id: string;
  email: string | null;
};

type SessionContextValue = {
  configured: boolean;
  status: SessionStatus;
  user: SessionUser | null;
  workspaceStatus: WorkspaceStatus;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  workspaceError: ApiError | null;
  setActiveWorkspace: (tenantId: string) => void;
  refreshWorkspaces: () => void;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

const activeTenantKey = (userId: string) => `rag4i:active-tenant:${userId}`;

function readStoredTenant(userId: string): string | null {
  try {
    return window.localStorage.getItem(activeTenantKey(userId));
  } catch {
    return null;
  }
}

function storeTenant(userId: string, tenantId: string) {
  try {
    window.localStorage.setItem(activeTenantKey(userId), tenantId);
  } catch {
    // Storage unavailable: the selection simply does not persist.
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  // Derived at construction rather than set from an effect: the environment is
  // a build-time constant, so this is deterministic on the server and the
  // client, and there is no synchronous setState inside an effect.
  const [status, setStatus] = useState<SessionStatus>(() =>
    isSupabaseConfigured ? "loading" : "signed-out",
  );
  const [user, setUser] = useState<SessionUser | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus>("idle");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Guards against a stale async resolution overwriting a newer one.
  const resolveSeq = useRef(0);

  const applySession = useCallback((session: Session | null) => {
    if (!session?.user) {
      setUser(null);
      setWorkspaces([]);
      setActiveTenantId(null);
      setWorkspaceError(null);
      setWorkspaceStatus("idle");
      setStatus("signed-out");
      return;
    }
    setUser({
      id: session.user.id,
      email: session.user.email ?? null,
    });
    setStatus("signed-in");
    setWorkspaceStatus("loading");
  }, []);

  useEffect(() => {
    // Nothing to resolve when the environment is absent; `status` already
    // reflects that from its initial value.
    if (!isSupabaseConfigured) return;
    const supabase = getSupabaseClient();
    const seq = ++resolveSeq.current;

    supabase.auth.getSession().then(({ data }) => {
      if (seq === resolveSeq.current) applySession(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      resolveSeq.current++;
      applySession(session);
    });

    return () => sub.subscription.unsubscribe();
  }, [applySession]);

  // Resolve memberships whenever the signed-in user changes (or on demand).
  useEffect(() => {
    if (!user) return;
    const supabase = getSupabaseClient();
    let cancelled = false;

    listMemberships(user.id)
      .then((rows) => {
        if (cancelled) return;
        const mapped: Workspace[] = rows.map((row) => ({
          tenantId: row.tenant_id,
          name: tenantName(row.tenants) ?? "Workspace",
          role: row.role,
        }));
        setWorkspaces(mapped);
        if (mapped.length === 0) {
          setActiveTenantId(null);
          setWorkspaceStatus("none");
          return;
        }
        const stored = readStoredTenant(user.id);
        const next = mapped.find((w) => w.tenantId === stored) ?? mapped[0];
        setActiveTenantId(next.tenantId);
        setWorkspaceStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setWorkspaces([]);
        setActiveTenantId(null);
        setWorkspaceError(normalizeApiError(error, "memberships"));
        setWorkspaceStatus("error");
      })
      .finally(() => {
        void supabase;
      });

    return () => {
      cancelled = true;
    };
  }, [user, reloadToken]);

  const setActiveWorkspace = useCallback(
    (tenantId: string) => {
      if (!user) return;
      setActiveTenantId(tenantId);
      storeTenant(user.id, tenantId);
    },
    [user],
  );

  const refreshWorkspaces = useCallback(() => {
    setWorkspaceError(null);
    setWorkspaceStatus("loading");
    setReloadToken((n) => n + 1);
  }, []);

  const signOut = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    await getSupabaseClient().auth.signOut();
  }, []);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.tenantId === activeTenantId) ?? null,
    [workspaces, activeTenantId],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      configured: isSupabaseConfigured,
      status,
      user,
      workspaceStatus,
      workspaces,
      activeWorkspace,
      workspaceError,
      setActiveWorkspace,
      refreshWorkspaces,
      signOut,
    }),
    [
      status,
      user,
      workspaceStatus,
      workspaces,
      activeWorkspace,
      workspaceError,
      setActiveWorkspace,
      refreshWorkspaces,
      signOut,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
