"use client";

import { ApiError } from "@/lib/api/errors";
import { queryChunks } from "@/lib/api/client";
import {
  getSupabaseAnonKey,
  getSupabaseClient,
  getSupabaseUrl,
} from "@/lib/supabase/client";

/**
 * System health.
 *
 * Every status here comes from a real observation of a capability that exists —
 * there are no synthetic "all good" values:
 *
 *  - frontend   — this module is executing in the browser.
 *  - backend    — a live CORS preflight to the deployed `/ask` Edge Function.
 *  - database   — a real PostgREST read of `conversations` under RLS.
 *  - embeddings — a real `query-chunks` call (Voyage query embedding +
 *                 retrieval). The only check with a provider cost, so it is
 *                 cached the longest.
 *  - generation — derived from the outcome of the user's own `/ask` requests;
 *                 there is no cheap, side-effect-free way to exercise the model
 *                 without generating tokens and persisting a conversation, so
 *                 this is reported as "unknown" until a real answer is seen.
 *
 * Results and timestamps are persisted so opening the panel does not re-run
 * expensive checks. Checks are read-only: nothing is reset, restarted or
 * changed anywhere.
 */

export type HealthStatus = "healthy" | "problem" | "unknown";
export type HealthSubsystem =
  | "frontend"
  | "backend"
  | "database"
  | "embeddings"
  | "generation";

export type HealthEntry = {
  status: HealthStatus;
  /** Epoch ms of the observation; null when never observed. */
  at: number | null;
  /** Short, safe explanation — never provider detail or credentials. */
  note: string;
};

export type HealthSnapshot = Record<HealthSubsystem, HealthEntry>;

export const SUBSYSTEMS: { id: HealthSubsystem; label: string; hint: string }[] = [
  { id: "frontend", label: "Frontend", hint: "This interface" },
  { id: "backend", label: "Backend / Edge Functions", hint: "Request handling" },
  { id: "database", label: "Database", hint: "Tenant-scoped reads" },
  { id: "embeddings", label: "Embeddings", hint: "Retrieval and search" },
  { id: "generation", label: "Generation / Models", hint: "Answer writing" },
];

const STORAGE_KEY = "rag4i.health.v1";

/** Cheap probes: short cache. */
const CHEAP_TTL_MS = 60_000;
/** Embeddings probe: one real provider call, cached generously. */
const EMBEDDINGS_TTL_MS = 10 * 60_000;

const UNKNOWN: HealthEntry = {
  status: "unknown",
  at: null,
  note: "Not checked yet",
};

const EMPTY: HealthSnapshot = {
  frontend: { ...UNKNOWN },
  backend: { ...UNKNOWN },
  database: { ...UNKNOWN },
  embeddings: { ...UNKNOWN },
  generation: {
    status: "unknown",
    at: null,
    note: "Ask a question to verify",
  },
};

const listeners = new Set<() => void>();
let cache: HealthSnapshot = { ...EMPTY };

function hydrate(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<HealthSnapshot>;
    const next = { ...EMPTY };
    for (const id of Object.keys(EMPTY) as HealthSubsystem[]) {
      const entry = parsed[id];
      if (entry && typeof entry === "object" && typeof entry.status === "string") {
        next[id] = {
          status: entry.status as HealthStatus,
          at: typeof entry.at === "number" ? entry.at : null,
          note: typeof entry.note === "string" ? entry.note : UNKNOWN.note,
        };
      }
    }
    cache = next;
  } catch {
    // Corrupt or unavailable storage: fall back to unknown, never throw.
  }
}

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full/blocked — health is informational, so failure is harmless.
  }
}

hydrate();

export function subscribeHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getHealthSnapshot(): HealthSnapshot {
  return cache;
}

export function getHealthServerSnapshot(): HealthSnapshot {
  return EMPTY;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function setHealthEntry(id: HealthSubsystem, entry: HealthEntry): void {
  cache = { ...cache, [id]: entry };
  persist();
  emit();
}

/** Record the outcome of a real `/ask` request (called by the chat surface). */
export function recordAskOutcome(ok: boolean, kind?: string): void {
  if (ok) {
    setHealthEntry("generation", {
      status: "healthy",
      at: Date.now(),
      note: "Your last question was answered",
    });
    return;
  }
  if (kind === "backend" || kind === "throttled") {
    setHealthEntry("generation", {
      status: "problem",
      at: Date.now(),
      note: "Your last question could not be answered",
    });
    return;
  }
  setHealthEntry("generation", {
    status: "unknown",
    at: Date.now(),
    note: "Last attempt did not complete",
  });
}

function isStale(entry: HealthEntry, ttlMs: number): boolean {
  return entry.at === null || Date.now() - entry.at > ttlMs;
}

async function probeBackend(): Promise<void> {
  try {
    const res = await fetch(`${getSupabaseUrl()}/functions/v1/ask`, {
      method: "OPTIONS",
      headers: { apikey: getSupabaseAnonKey() },
    });
    if (res.status < 500) {
      setHealthEntry("backend", {
        status: "healthy",
        at: Date.now(),
        note: "Edge Functions are responding",
      });
    } else {
      setHealthEntry("backend", {
        status: "problem",
        at: Date.now(),
        note: `Service returned ${res.status}`,
      });
    }
  } catch {
    setHealthEntry("backend", {
      status: "problem",
      at: Date.now(),
      note: "Service unreachable from this browser",
    });
  }
}

async function probeDatabase(): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (error) {
      setHealthEntry("database", {
        status: "problem",
        at: Date.now(),
        note: "Query was rejected",
      });
    } else {
      setHealthEntry("database", {
        status: "healthy",
        at: Date.now(),
        note: "Tenant-scoped reads are working",
      });
    }
  } catch {
    setHealthEntry("database", {
      status: "problem",
      at: Date.now(),
      note: "Database unreachable from this browser",
    });
  }
}

async function probeEmbeddings(tenantId: string): Promise<void> {
  try {
    await queryChunks({ tenantId, query: "health check" });
    setHealthEntry("embeddings", {
      status: "healthy",
      at: Date.now(),
      note: "Retrieval and embeddings are responding",
    });
  } catch (error) {
    const kind = error instanceof ApiError ? error.kind : null;
    setHealthEntry("embeddings", {
      status: "problem",
      at: Date.now(),
      note:
        kind === "authorization"
          ? "Not permitted in this workspace"
          : "Retrieval could not be reached",
    });
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Run the probes that are due. Never overlaps itself; never throws.
 * `force` re-runs everything (used by the explicit Re-check action).
 */
export function runHealthChecks(options: {
  tenantId: string | null;
  force?: boolean;
}): Promise<void> {
  if (inFlight) return inFlight;
  const force = options.force ?? false;
  const snapshot = cache;

  const run = (async () => {
    setHealthEntry("frontend", {
      status: "healthy",
      at: Date.now(),
      note: "This interface is running",
    });

    const jobs: Promise<void>[] = [];
    if (force || isStale(snapshot.backend, CHEAP_TTL_MS)) jobs.push(probeBackend());

    if (!options.tenantId) {
      setHealthEntry("database", {
        status: "unknown",
        at: null,
        note: "No workspace is available",
      });
      setHealthEntry("embeddings", {
        status: "unknown",
        at: null,
        note: "No workspace is available",
      });
    } else {
      if (force || isStale(snapshot.database, CHEAP_TTL_MS)) {
        jobs.push(probeDatabase());
      }
      if (force || isStale(snapshot.embeddings, EMBEDDINGS_TTL_MS)) {
        jobs.push(probeEmbeddings(options.tenantId));
      }
    }

    await Promise.all(jobs);
  })();

  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}
