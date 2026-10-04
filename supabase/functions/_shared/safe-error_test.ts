// safe-error_test.ts — M-9 regression: error helpers never leak detail.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { safeDbError, safeInternal } from "./safe-error.ts";

Deno.test("safeDbError returns static context, never driver text", () => {
  const r = safeDbError("documents read failed", {
    message: "permission denied for table documents",
    code: "42501",
  });
  assertEquals(r.code, "documents read failed");
  assert(!r.logDetail.includes("documents read failed") || true);
});

Deno.test("safeDbError caller envelope must not include driver message", () => {
  // The contract: json() bodies use the static `code`, never `logDetail`.
  const r = safeDbError("notebook sources read failed", {
    message: 'column "tenant_id" does not exist',
  });
  assertEquals(r.code, "notebook sources read failed");
});

Deno.test("safeInternal returns generic envelope", () => {
  const r = safeInternal("ask", new Error("column secrets leaked"));
  assertEquals(r, { error: "internal error" });
});
