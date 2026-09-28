// rerank-policy — H2A guard: deterministic skip decision for second-stage
// reranking, plus the existing outage fallback as one pure helper.
//
// Pure, no I/O, no provider calls, no state. The decision is server-side and
// deterministic; no model is consulted.
//
// Rationale: the reranker selects the top FINAL_K hits out of the fused pool
// and reorders the evidence list. When the fused pool already fits inside
// FINAL_K there is nothing to exclude, so the provider call cannot change
// WHICH chunks reach generation — it can only reorder them. Skipping the call
// therefore removes a provider round trip with no selection loss: the fused
// order stands and the existing evidence selection/gating path is unchanged.
//
// This is not a retrieval-constant change: FINAL_K, candidate counts, the
// candidate cap and the fusion shape are untouched. It is a cost-control
// guard around an already-existing decision point.

export type RerankPlan =
  | { kind: "skip"; reason: "empty-pool" | "pool-within-final-k" }
  | { kind: "run" };

/**
 * Whether the second-stage reranker should run for a fused pool of
 * `fusedCount` candidates given the current `finalK`.
 *
 *  - empty pool      → skip: there is nothing to send; the pipeline proceeds
 *                      to its existing empty-evidence/refusal path.
 *  - pool ≤ finalK   → skip: nothing can be cut; fused order is preserved.
 *  - pool > finalK   → run: the reranker can change which candidates survive
 *                      the cut, so it is still attempted.
 */
export function planRerank(fusedCount: number, finalK: number): RerankPlan {
  if (fusedCount <= 0) return { kind: "skip", reason: "empty-pool" };
  if (fusedCount <= finalK) return { kind: "skip", reason: "pool-within-final-k" };
  return { kind: "run" };
}

/**
 * Resolve the final ordered pool after a rerank attempt.
 *
 * `ranked` is the mapped rerank order, or null when the call failed or its
 * response failed validation. A null/empty result is the pre-existing outage
 * fallback: the fused order stands unchanged and `reranked` stays false, so a
 * reranker outage never takes down question answering.
 */
export function resolveRankedOrder<T>(
  pool: T[],
  ranked: T[] | null,
): { ordered: T[]; reranked: boolean } {
  if (ranked !== null && ranked.length > 0) {
    return { ordered: ranked, reranked: true };
  }
  return { ordered: pool, reranked: false };
}
