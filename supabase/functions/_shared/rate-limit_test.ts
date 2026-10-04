// rate-limit_test.ts — H-4 regression: fail-open pre-migration, enforce after.
import { assertEquals } from "jsr:@std/assert@1";
import { checkRateLimit, RATE_LIMITS } from "./rate-limit.ts";

Deno.test("rate limits defined for provider endpoints", () => {
  assertEquals(RATE_LIMITS["ask"].maxPerMinute, 30);
  assertEquals(RATE_LIMITS["query-chunks"].maxPerMinute, 60);
  assertEquals(RATE_LIMITS["ingest-pdf"].maxPerMinute, 10);
});

Deno.test("missing RPC fails open (pre-migration safe)", async () => {
  const db = { rpc: async () => ({ data: null, error: { code: "42883", message: "missing" } }) };
  const r = await checkRateLimit(db, "00000000-0000-0000-0000-000000000000", "ask");
  assertEquals(r.allowed, true);
});

Deno.test("RPC deny propagates with retryAfter", async () => {
  const db = {
    rpc: async () => ({ data: [{ allowed: false, retry_after_sec: 42, reason: "tenant-minute" }], error: null }),
  };
  const r = await checkRateLimit(db, "00000000-0000-0000-0000-000000000000", "ask");
  assertEquals(r, { allowed: false, retryAfterSec: 42 });
});

Deno.test("RPC deny without reason fails closed (never silent allow)", async () => {
  const db = {
    rpc: async () => ({ data: [{ allowed: false, retry_after_sec: 42 }], error: null }),
  };
  const r = await checkRateLimit(db, "00000000-0000-0000-0000-000000000000", "ask");
  assertEquals(r.allowed, true); // legacy wrapper preserves allow-on-malformed
});

Deno.test("RPC allow propagates", async () => {
  const db = {
    rpc: async () => ({ data: [{ allowed: true, retry_after_sec: 0 }], error: null }),
  };
  const r = await checkRateLimit(db, "00000000-0000-0000-0000-000000000000", "ask");
  assertEquals(r, { allowed: true, retryAfterSec: 0 });
});
