// cost-control_test.ts — P0 cost/abuse controls: kill switch, per-user+daily
// gates, provider-slot concurrency, usage accounting, amplification bound.
//
// Tests run against faithful in-memory fakes of the Postgres RPC contract
// (fixed-window minute counters, UTC-day counters, advisory-locked slot
// claims). Real atomicity lives in the SQL migration; Deno tests prove the
// helper logic (ordering, finally-release, reason mapping, call counting).
import { assertEquals } from "jsr:@std/assert@1";
import {
  COST_LIMITS,
  SLOT_CAPS,
  SlotBusyError,
  checkCostGate,
  claimProviderSlot,
  enforceCostGate,
  killSwitchEngaged,
  recordProviderUse,
  releaseProviderSlot,
  withProviderSlot,
} from "./cost-control.ts";

const TENANT = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";

// --- kill switch (matrix §4: env flag, no DB, no secret) ---

Deno.test("kill switch off when env unset", () => {
  try {
    Deno.env.delete("PROVIDER_KILL_SWITCH");
    assertEquals(killSwitchEngaged(), false);
  } finally {
    Deno.env.delete("PROVIDER_KILL_SWITCH");
  }
});

Deno.test("kill switch on only for exact 'true'", () => {
  const tried = ["true", "1", "TRUE", "yes", ""];
  const want = [true, false, false, false, false];
  tried.forEach((v, i) => {
    try {
      Deno.env.set("PROVIDER_KILL_SWITCH", v);
      assertEquals(killSwitchEngaged(), want[i], `value ${JSON.stringify(v)}`);
    } finally {
      Deno.env.delete("PROVIDER_KILL_SWITCH");
    }
  });
});

// --- limit matrix is pinned (single source; docs reference these) ---

Deno.test("ask matrix pins user+daily bounds", () => {
  assertEquals(COST_LIMITS["ask"], {
    perMinuteTenant: 30,
    perMinuteUser: 10,
    perDayTenant: 1000,
    perDayUser: 100,
  });
  assertEquals(SLOT_CAPS, { perTenant: 6, perUser: 2, staleSec: 300 });
});

// --- gate helper: reason mapping (task tests 1-3, 5-6) ---

function gateDb(first: { allowed: boolean; retry_after_sec: number; reason: string }) {
  return {
    rpc: async (name: string) => {
      assertEquals(name, "check_rate_limit");
      return { data: [first], error: null };
    },
  };
}

Deno.test("gate under limit propagates ok", async () => {
  const r = await checkCostGate(
    gateDb({ allowed: true, retry_after_sec: 0, reason: "ok" }),
    TENANT,
    USER,
    "ask",
  );
  assertEquals(r, { allowed: true, retryAfterSec: 0, reason: "ok" });
});

Deno.test("gate over user-minute denies with reason", async () => {
  const r = await checkCostGate(
    gateDb({ allowed: false, retry_after_sec: 37, reason: "user-minute" }),
    TENANT,
    USER,
    "ask",
  );
  assertEquals(r, { allowed: false, retryAfterSec: 37, reason: "user-minute" });
});

Deno.test("gate over tenant-daily denies with reason", async () => {
  const r = await checkCostGate(
    gateDb({ allowed: false, retry_after_sec: 3600, reason: "tenant-daily" }),
    TENANT,
    USER,
    "ask",
  );
  assertEquals(r, { allowed: false, retryAfterSec: 3600, reason: "tenant-daily" });
});

Deno.test("gate missing RPC fails open once (pre-migration safe)", async () => {
  const db = { rpc: async () => ({ data: null, error: { code: "42883" } }) };
  const r = await checkCostGate(db, TENANT, USER, "ask");
  assertEquals(r.allowed, true);
  assertEquals(r.reason, "missing-rpc");
});

Deno.test("gate RPC error fails closed (cost-first: no silent spend)", async () => {
  const db = { rpc: async () => ({ data: null, error: { code: "57014" } }) };
  const r = await checkCostGate(db, TENANT, USER, "ask");
  assertEquals(r.allowed, false);
  assertEquals(r.reason, "rpc-error");
});

// --- enforceCostGate: handler mapping (task tests 9, 11, 19) ---

Deno.test("enforce allows when gate ok", async () => {
  const r = await enforceCostGate(
    gateDb({ allowed: true, retry_after_sec: 0, reason: "ok" }),
    TENANT,
    USER,
    "ask",
  );
  assertEquals(r, null);
});

Deno.test("enforce maps daily denial to daily message", async () => {
  const r = await enforceCostGate(
    gateDb({ allowed: false, retry_after_sec: 3600, reason: "user-daily" }),
    TENANT,
    USER,
    "ask",
  );
  assertEquals(r, {
    status: 429,
    body: { ok: false, error: "daily usage limit reached", retry_after_sec: 3600 },
  });
});

Deno.test("enforce maps rpc-error to safe 503 (never a key/stack leak)", async () => {
  const db = { rpc: async () => ({ data: null, error: { code: "XX000" } }) };
  const r = await enforceCostGate(db, TENANT, USER, "ask");
  assertEquals(r, { status: 503, body: { ok: false, error: "service temporarily unavailable" } });
});

Deno.test("enforce kill switch blocks before any DB gate call", async () => {
  let rpcCalls = 0;
  const db = { rpc: async () => { rpcCalls += 1; return { data: null, error: null }; } };
  try {
    Deno.env.set("PROVIDER_KILL_SWITCH", "true");
    const r = await enforceCostGate(db, TENANT, USER, "ask");
    assertEquals(r, { status: 503, body: { ok: false, error: "service temporarily unavailable" } });
    assertEquals(rpcCalls, 0);
  } finally {
    Deno.env.delete("PROVIDER_KILL_SWITCH");
  }
});

Deno.test("slot claim ok then busy-user at cap", async () => {
  let held = 0;
  const db = {
    rpc: async (name: string) => {
      assertEquals(name, "claim_slot");
      held += 1;
      if (held <= SLOT_CAPS.perUser) return { data: [{ ok: true, reason: "ok" }], error: null };
      return { data: [{ ok: false, reason: "busy-user" }], error: null };
    },
  };
  assertEquals((await claimProviderSlot(db, TENANT, USER)).ok, true);
  assertEquals((await claimProviderSlot(db, TENANT, USER)).ok, true);
  const third = await claimProviderSlot(db, TENANT, USER);
  assertEquals(third, { ok: false, reason: "busy-user" });
});

Deno.test("slot release never throws (best-effort finally path)", async () => {
  const db = { rpc: async () => { throw new Error("db down"); } };
  await releaseProviderSlot(db, TENANT, USER);
  await recordProviderUse(db, TENANT, USER, "ask", 1200);
});

Deno.test("provider throw still releases the slot", async () => {
  const calls: string[] = [];
  const db = {
    rpc: async (name: string) => {
      calls.push(name);
      if (name === "claim_slot") return { data: [{ ok: true, reason: "ok" }], error: null };
      return { data: null, error: null };
    },
  };
  let threw = false;
  try {
    await withProviderSlot(db, TENANT, USER, async () => {
      throw new Error("provider exploded");
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(calls, ["claim_slot", "release_slot"]);
});

Deno.test("busy slot throws SlotBusyError without calling provider", async () => {
  const db = {
    rpc: async (name: string) => {
      if (name === "claim_slot") return { data: [{ ok: false, reason: "busy-tenant" }], error: null };
      return { data: null, error: null };
    },
  };
  let providerCalls = 0;
  let busy: unknown = null;
  try {
    await withProviderSlot(db, TENANT, USER, async () => {
      providerCalls += 1;
      return 1;
    });
  } catch (e) {
    busy = e;
  }
  assertEquals(busy instanceof SlotBusyError, true);
  assertEquals(providerCalls, 0);
});

// --- cost-amplification bound: 25 rapid requests, tiny caps (task §14) ---

Deno.test("25 rapid requests yield bounded provider calls", async () => {
  const USER_MIN = 3;
  let minuteUsed = 0;
  let providerCalls = 0;
  const db = {
    rpc: async (name: string) => {
      if (name === "check_rate_limit") {
        minuteUsed += 1;
        if (minuteUsed <= USER_MIN) return { data: [{ allowed: true, retry_after_sec: 0, reason: "ok" }], error: null };
        return { data: [{ allowed: false, retry_after_sec: 60, reason: "user-minute" }], error: null };
      }
      if (name === "claim_slot") return { data: [{ ok: true, reason: "ok" }], error: null };
      return { data: null, error: null };
    },
  };
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < 25; i++) {
    if (killSwitchEngaged()) {
      rejected += 1;
      continue;
    }
    const g = await checkCostGate(db, TENANT, USER, "ask");
    if (!g.allowed) {
      rejected += 1;
      continue;
    }
    await withProviderSlot(db, TENANT, USER, async () => {
      providerCalls += 1;
    });
    accepted += 1;
  }
  assertEquals(accepted, USER_MIN);
  assertEquals(rejected, 25 - USER_MIN);
  assertEquals(providerCalls, USER_MIN);
});
