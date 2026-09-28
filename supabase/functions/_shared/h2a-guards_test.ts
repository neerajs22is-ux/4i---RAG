// H2A guard tests — deterministic token-efficiency guards.
//
// Pure functions only: no network, no database, no model. The guards
// themselves live in the production call sites (`query-chunks` rerank block,
// `ask` retrieval block); this suite pins the deterministic decisions they
// rely on.
//
// Coverage map:
//   Guard 1 — rerank skip         → planRerank / resolveRankedOrder
//   Guard 2 — dual-empty refusal  → verifyEvidence(empty) + promptModeFor
//   Guard 3 — no conflict expansion → verifyEvidence(CONFLICTING) + promptModeFor
//   Guard 4 — max one retry       → no retrieval retry exists by construction
//     (the ask path makes exactly one retrieval call; there is no rewrite or
//     loop). The only bounded retry in ask is the correctness checker's
//     (max 2 attempts), already covered in correctness_test.ts by
//     "integration: transport failure retries once then INVALID" and
//     "integration: timeout is INVALID after one retry".
//
// Run: deno test supabase/functions/_shared/h2a-guards_test.ts

import { promptModeFor, verifyEvidence, type EvidenceItem } from "./grounding.ts";
import { planRerank, resolveRankedOrder } from "./rerank-policy.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

const T = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const D = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function ev(content: string, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    chunk_id: "c1",
    document_id: D,
    tenant_id: T,
    file_name: "lease.pdf",
    page: 4,
    content,
    ...extra,
  };
}

/* --------------------------------------------- guard 1: rerank skip */

Deno.test("guard 1: 0 candidates skip the reranker", () => {
  assertEquals(planRerank(0, 8), { kind: "skip", reason: "empty-pool" }, "empty pool");
});

Deno.test("guard 1: 1 candidate skips the reranker", () => {
  assertEquals(planRerank(1, 8), { kind: "skip", reason: "pool-within-final-k" }, "one candidate");
});

Deno.test("guard 1: exactly FINAL_K candidates skip the reranker", () => {
  assertEquals(planRerank(8, 8), { kind: "skip", reason: "pool-within-final-k" }, "pool == FINAL_K");
});

Deno.test("guard 1: FINAL_K + 1 candidates attempt the reranker", () => {
  assertEquals(planRerank(9, 8), { kind: "run" }, "pool > FINAL_K");
});

Deno.test("guard 1: the boundary follows finalK, not a hardcoded size", () => {
  assertEquals(planRerank(20, 20), { kind: "skip", reason: "pool-within-final-k" }, "pool == finalK 20");
  assertEquals(planRerank(21, 20), { kind: "run" }, "pool > finalK 20");
});

Deno.test("guard 1: outage fallback keeps fused order when reranking was attempted", () => {
  const pool = [{ id: "a" }, { id: "b" }, { id: "c" }];
  // Call/validation failure surfaces as null → fused order, reranked false.
  const failed = resolveRankedOrder(pool, null);
  assertEquals(failed.ordered, pool, "null ranking keeps the fused pool");
  assertEquals(failed.reranked, false, "not reranked");
  // An empty ranking is also an outage, never a silent wipe of evidence.
  const empty = resolveRankedOrder(pool, []);
  assertEquals(empty.ordered, pool, "empty ranking keeps the fused pool");
  assertEquals(empty.reranked, false, "not reranked");
});

Deno.test("guard 1: a validated rerank order replaces the fused order", () => {
  const pool = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const ranked = [{ id: "c" }, { id: "a" }];
  const resolved = resolveRankedOrder(pool, ranked);
  assertEquals(resolved.ordered, ranked, "rerank order used");
  assertEquals(resolved.reranked, true, "reranked");
});

/* ------------------------------------------- guard 2: dual-empty */

Deno.test("guard 2: dual-empty evidence takes the immediate insufficient path", () => {
  // Zero candidates from both channels is the only way evidence is empty; the
  // gate refuses deterministically and ask returns before any further work.
  const r = verifyEvidence("What is the minimum investment?", []);
  assertEquals(r.verdict, "INSUFFICIENT", "verdict");
  assertEquals(r.reason, "no-evidence", "reason");
  assertEquals(promptModeFor(r.verdict), "refuse", "mode");
});

Deno.test("guard 2: a single non-empty channel is NOT dual-empty", () => {
  // One item stands in for either dense-only or lexical-only results: the
  // gate evaluates it normally and must never take the empty-evidence path.
  const r = verifyEvidence("What is the lock-in period?", [
    ev("The lock-in period in the lease deed is 36 months."),
  ]);
  assert(r.reason !== "no-evidence", `must not take the empty path (got ${r.reason})`);
});

/* ------------------------------------ guard 3: conflict is terminal */

Deno.test("guard 3: CONFLICTING maps to the conflict template, never expansion", () => {
  const r = verifyEvidence("What is the notice period?", [
    ev("The lease requires 30 days notice for termination.", { chunk_id: "c1" }),
    ev("The lease requires 60 days notice for termination.", { chunk_id: "c2" }),
  ]);
  assertEquals(r.verdict, "CONFLICTING", "verdict");
  assert(r.conflicting.length > 0, "conflicting findings recorded");
  assertEquals(promptModeFor(r.verdict), "conflict", "mode");
});
