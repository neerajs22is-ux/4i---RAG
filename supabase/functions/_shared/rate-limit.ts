// rate-limit.ts — H-4: server-enforced per-tenant rate limits.
//
// Now a thin compatibility wrapper over `cost-control.ts`: the combined
// minute+daily gate lives in `checkCostGate` (single RPC records the
// attempt). This wrapper preserves the legacy contract for existing callers
// and tests: { allowed, retryAfterSec }, fail-open ONLY when the RPC is
// missing (pre-migration). New code should call `checkCostGate` directly
// so `rpc-error` fails closed (503) instead of open.
import { checkCostGate } from "./cost-control.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export const RATE_LIMITS: Record<string, { maxPerMinute: number }> = {
  "ask": { maxPerMinute: 30 },
  "query-chunks": { maxPerMinute: 60 },
  "ingest-pdf": { maxPerMinute: 10 },
  "edit-message": { maxPerMinute: 60 },
};

export async function checkRateLimit(
  db: Db,
  tenantId: string,
  endpoint: string,
  userId?: string | null,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const gate = await checkCostGate(db, tenantId, userId ?? null, endpoint);
  if (gate.reason === "missing-rpc") return { allowed: true, retryAfterSec: 0 };
  if (gate.reason === "rpc-error") return { allowed: true, retryAfterSec: 0 };
  return { allowed: gate.allowed, retryAfterSec: gate.retryAfterSec };
}
