// Unit tests for the temporary-file scope helpers. Pure functions only — no
// network, no database. Run: deno test supabase/functions/_shared/temp-scope_test.ts

import {
  combineScopes,
  isExpiredTemp,
  isTempDoc,
  TEMP_TTL_MS,
  tempExpiresAt,
  unionDocIds,
} from "./temp-scope.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

/* ------------------------------------------------------------------- TTL */

Deno.test("tempExpiresAt: exactly 24 hours after registration", () => {
  assertEquals(TEMP_TTL_MS, 86_400_000, "TTL constant");
  assertEquals(
    tempExpiresAt(Date.parse("2026-09-17T10:00:00.000Z")),
    "2026-09-18T10:00:00.000Z",
    "expiry timestamp",
  );
});

/* ------------------------------------------------------------------ union */

Deno.test("unionDocIds: order-stable deduplication", () => {
  assertEquals(unionDocIds(null, []), [], "both empty");
  assertEquals(unionDocIds(["a", "b"], ["b", "c"]), ["a", "b", "c"], "dedup keeps first order");
  assertEquals(unionDocIds([], ["a"]), ["a"], "temp only");
  assertEquals(unionDocIds(["a"], []), ["a"], "persistent only");
});

/* ------------------------------------------------------- scope combining */

Deno.test("combineScopes: Space sources only (case A)", () => {
  assertEquals(
    combineScopes({ notebookRequested: true, notebookIds: ["a", "b"], tempIds: [] }),
    { ids: ["a", "b"], refused: false },
    "case A",
  );
});

Deno.test("combineScopes: temporary files only (cases B, E)", () => {
  assertEquals(
    combineScopes({ notebookRequested: false, notebookIds: null, tempIds: ["t1"] }),
    { ids: ["t1"], refused: false },
    "temp only",
  );
});

Deno.test("combineScopes: Space + temporary union (cases C, F)", () => {
  assertEquals(
    combineScopes({ notebookRequested: true, notebookIds: ["a"], tempIds: ["t1", "a"] }),
    { ids: ["a", "t1"], refused: false },
    "union deduped",
  );
});

Deno.test("combineScopes: no temporary files keeps persistent behaviour (case D)", () => {
  assertEquals(
    combineScopes({ notebookRequested: false, notebookIds: null, tempIds: [] }),
    { ids: null, refused: false },
    "unscoped, byte-identical legacy path",
  );
});

Deno.test("combineScopes: empty Space scope with no temporary files refuses", () => {
  assertEquals(
    combineScopes({ notebookRequested: true, notebookIds: [], tempIds: [] }),
    { ids: null, refused: true },
    "deterministic refusal",
  );
});

Deno.test("combineScopes: empty Space scope with temporary files answers from temp", () => {
  assertEquals(
    combineScopes({ notebookRequested: true, notebookIds: [], tempIds: ["t1"] }),
    { ids: ["t1"], refused: false },
    "temp rescues the empty scope",
  );
});

Deno.test("combineScopes: never returns an empty ID array", () => {
  const noTemp = combineScopes({ notebookRequested: false, notebookIds: [], tempIds: [] });
  assert(noTemp.ids === null, "empty resolves to null, not []");
});

/* ------------------------------------------------------- expiry predicates */

Deno.test("isTempDoc: expiry timestamp is the temporary marker", () => {
  assert(!isTempDoc({ expires_at: null }), "persistent");
  assert(isTempDoc({ expires_at: "2026-09-18T10:00:00.000Z" }), "temporary");
});

Deno.test("isExpiredTemp: boundary and malformed timestamps", () => {
  const now = Date.parse("2026-09-17T10:00:00.000Z");
  assert(!isExpiredTemp({ expires_at: null }, now), "persistent never expires");
  assert(
    !isExpiredTemp({ expires_at: "2026-09-17T10:00:01.000Z" }, now),
    "unexpired temporary",
  );
  assert(
    isExpiredTemp({ expires_at: "2026-09-17T10:00:00.000Z" }, now),
    "expiry instant is already expired (fail closed)",
  );
  assert(
    isExpiredTemp({ expires_at: "2026-09-16T10:00:00.000Z" }, now),
    "past expiry",
  );
  assert(isExpiredTemp({ expires_at: "not-a-timestamp" }, now), "malformed fails closed");
});
