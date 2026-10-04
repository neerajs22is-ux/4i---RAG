// cost-control.ts — P0 cost/abuse controls (server enforcement boundary).
//
// Three independent layers, cheapest first:
//   1. Kill switch  — env flag, zero DB/provider work, checked after auth.
//   2. Rate gates   — per-minute (tenant+user) + per-UTC-day (tenant+user)
//      fixed windows in Postgres via `check_rate_limit` (single RPC records
//      the attempt, so accepted AND rejected requests are counted).
//   3. Slots       — in-flight provider-call bound per tenant+user via
//      `claim_slot`/`release_slot` (advisory-locked single transaction;
//      stale claims reaped at 300 s, above the 90 s max provider timeout).
//
// Usage accounting: `record_provider_use` writes provider_calls + estimated
// tokens best-effort AFTER the response path is decided — it never blocks
// or fails a user request. Token figures are estimates (chars/4 proxy or
// provider-reported usage where the caller has it), never exact bills.
//
// COST_LIMITS is the single source for the limit matrix (see DECISIONS D83).
// Operator override = change constants here (or the SQL wrapper caps) and
// redeploy — deliberate, auditable, no hot admin path by design.

// deno-lint-ignore no-explicit-any
type Db = any;

export const KILL_SWITCH_ENV = "PROVIDER_KILL_SWITCH";

/** Exact "true" only — "1"/"TRUE"/"yes" must not kill production by typo. */
export function killSwitchEngaged(): boolean {
  try {
    return Deno.env.get(KILL_SWITCH_ENV) === "true";
  } catch {
    return false;
  }
}

export interface EndpointCaps {
  perMinuteTenant: number;
  perMinuteUser: number;
  perDayTenant: number;
  perDayUser: number;
}

/**
 * Limit matrix (0 = no cap at that grain). Rationale per endpoint lives in
 * DECISIONS.md D83 — caps here are the enforced values, not documentation.
 */
export const COST_LIMITS: Record<string, EndpointCaps> = {
  "ask": { perMinuteTenant: 30, perMinuteUser: 10, perDayTenant: 1000, perDayUser: 100 },
  "query-chunks": { perMinuteTenant: 60, perMinuteUser: 20, perDayTenant: 2000, perDayUser: 200 },
  "ingest-pdf": { perMinuteTenant: 10, perMinuteUser: 3, perDayTenant: 100, perDayUser: 20 },
  "edit-message": { perMinuteTenant: 60, perMinuteUser: 20, perDayTenant: 0, perDayUser: 0 },
  "benchmark-answer": { perMinuteTenant: 10, perMinuteUser: 0, perDayTenant: 300, perDayUser: 0 },
  "benchmark-retrieval": { perMinuteTenant: 10, perMinuteUser: 0, perDayTenant: 300, perDayUser: 0 },
  "benchmark-ingest": { perMinuteTenant: 10, perMinuteUser: 0, perDayTenant: 300, perDayUser: 0 },
};

export const SLOT_CAPS = { perTenant: 6, perUser: 2, staleSec: 300 };

export type GateReason =
  | "ok"
  | "user-minute"
  | "tenant-minute"
  | "user-daily"
  | "tenant-daily"
  | "not-member"
  | "missing-rpc"
  | "rpc-error";

export interface CostGate {
  allowed: boolean;
  retryAfterSec: number;
  reason: GateReason;
}

const VALID_REASONS: GateReason[] = [
  "ok",
  "user-minute",
  "tenant-minute",
  "user-daily",
  "tenant-daily",
  "not-member",
  "missing-rpc",
  "rpc-error",
];

/**
 * Combined minute+daily gate. Returns the RPC verdict; the CALLER maps it:
 *   missing-rpc → allow once + log (pre-migration compat only)
 *   rpc-error   → fail CLOSED (503; membership already proved the DB is up)
 *   deny        → 429 with retry_after_sec
 */
export async function checkCostGate(
  db: Db,
  tenantId: string,
  userId: string | null,
  endpoint: string,
): Promise<CostGate> {
  // Unknown endpoints fall back to the ask row (fail safe, never open).
  const caps: EndpointCaps = COST_LIMITS[endpoint] ?? COST_LIMITS["ask"];
  try {
    const { data, error } = await db.rpc("check_rate_limit", {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_endpoint: endpoint,
      p_min_tenant: caps.perMinuteTenant,
      p_min_user: caps.perMinuteUser,
      p_day_tenant: caps.perDayTenant,
      p_day_user: caps.perDayUser,
    });
    if (error) {
      const code = (error as { code?: string }).code ?? null;
      console.error(JSON.stringify({
        scope: "cost-control",
        context: code === "42883" ? "rate RPC missing, allowing" : "rate RPC failed, blocking",
        endpoint,
        code,
      }));
      if (code === "42883") return { allowed: true, retryAfterSec: 0, reason: "missing-rpc" };
      return { allowed: false, retryAfterSec: 0, reason: "rpc-error" };
    }
    const row = (Array.isArray(data) ? data[0] : data) as {
      allowed?: unknown;
      retry_after_sec?: unknown;
      reason?: unknown;
    } | null;
    if (!row || typeof row.allowed !== "boolean") {
      return { allowed: false, retryAfterSec: 0, reason: "rpc-error" };
    }
    const reason: GateReason = VALID_REASONS.includes(row.reason as GateReason)
      ? (row.reason as GateReason)
      : "rpc-error";
    if (reason === "missing-rpc") return { allowed: true, retryAfterSec: 0, reason };
    return {
      allowed: row.allowed,
      retryAfterSec: Number(row.retry_after_sec ?? 0) || 0,
      reason: row.allowed ? "ok" : reason,
    };
  } catch (e) {
    console.error(JSON.stringify({
      scope: "cost-control",
      context: "gate threw, blocking",
      endpoint,
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 120),
    }));
    return { allowed: false, retryAfterSec: 0, reason: "rpc-error" };
  }
}

export interface SlotClaim {
  ok: boolean;
  reason: "ok" | "busy-user" | "busy-tenant" | "error";
}

export async function claimProviderSlot(
  db: Db,
  tenantId: string,
  userId: string | null,
): Promise<SlotClaim> {
  try {
    const { data, error } = await db.rpc("claim_slot", {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_tenant_max: SLOT_CAPS.perTenant,
      p_user_max: SLOT_CAPS.perUser,
    });
    if (error || !data) return { ok: false, reason: "error" };
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: unknown; reason?: unknown };
    if (row.ok === true) return { ok: true, reason: "ok" };
    return { ok: false, reason: row.reason === "busy-user" ? "busy-user" : "busy-tenant" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Best-effort release — never throws, never affects the response. */
export async function releaseProviderSlot(db: Db, tenantId: string, userId: string | null): Promise<void> {
  try {
    await db.rpc("release_slot", { p_tenant_id: tenantId, p_user_id: userId });
  } catch {
    // Stale claims are reaped server-side at SLOT_CAPS.staleSec.
  }
}

/** Best-effort post-hoc usage write — never throws, never affects the response. */
export async function recordProviderUse(
  db: Db,
  tenantId: string,
  userId: string | null,
  endpoint: string,
  tokensEst: number,
): Promise<void> {
  try {
    await db.rpc("record_provider_use", {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_endpoint: endpoint,
      p_tokens_est: Math.max(0, Math.floor(tokensEst) || 0),
    });
  } catch {
    // Accounting must never fail a served request.
  }
}

/**
 * Full entry gate for provider-backed handlers. Returns null when the
 * request may proceed, else { status, body } for the handler's own `json()`.
 * Order: kill switch (no state touched) → minute+daily gate. Call AFTER
 * membership is verified so `not-member` from the RPC stays unreachable in
 * practice (defense in depth: still mapped to 403, never 500).
 */
export async function enforceCostGate(
  db: Db,
  tenantId: string,
  userId: string | null,
  endpoint: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (killSwitchEngaged()) {
    return { status: 503, body: { ok: false, error: "service temporarily unavailable" } };
  }
  const gate = await checkCostGate(db, tenantId, userId, endpoint);
  if (gate.reason === "missing-rpc" || gate.allowed) return null;
  if (gate.reason === "rpc-error") {
    return { status: 503, body: { ok: false, error: "service temporarily unavailable" } };
  }
  if (gate.reason === "not-member") {
    return { status: 403, body: { ok: false, error: "not a member of this tenant" } };
  }
  return {
    status: 429,
    body: {
      ok: false,
      error: gate.reason === "user-daily" || gate.reason === "tenant-daily"
        ? "daily usage limit reached"
        : "rate limit exceeded; retry shortly",
      retry_after_sec: gate.retryAfterSec,
    },
  };
}

export class SlotBusyError extends Error {  readonly kind: "busy-user" | "busy-tenant";
  constructor(kind: "busy-user" | "busy-tenant") {
    super(kind === "busy-user" ? "too many simultaneous requests for this user" : "workspace is busy");
    this.name = "SlotBusyError";
    this.kind = kind;
  }
}

/**
 * Holds one provider slot for exactly one provider call. Claim failure or a
 * provider throw both release correctly: denial throws SlotBusyError BEFORE
 * fn runs (zero provider spend); fn errors propagate after release.
 */
export async function withProviderSlot<T>(
  db: Db,
  tenantId: string,
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const claim = await claimProviderSlot(db, tenantId, userId);
  if (!claim.ok) throw new SlotBusyError(claim.reason === "busy-user" ? "busy-user" : "busy-tenant");
  try {
    return await fn();
  } finally {
    await releaseProviderSlot(db, tenantId, userId);
  }
}
