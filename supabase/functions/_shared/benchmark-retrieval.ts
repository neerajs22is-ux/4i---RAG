// benchmark-retrieval.ts — benchmark-only retrieval mirror helpers.
//
// Benchmark-only. This module never touches the database, never calls Voyage,
// never calls production /ask or /query-chunks, and never calls the production
// match_chunks RPC. It encodes the LOCKED production selection contract by
// value (dense 20 / lexical 20 / candidate cap 50 / RRF-60 / final 8 /
// deterministic chunk_id tie-break) so a benchmark path can reproduce
// retrieval while changing only the vector partition.
//
// The benchmark Edge function performs the reads (with benchmark-scoped rows)
// and calls these pure helpers; the Step 2 rerank orchestrator consumes the
// resulting candidate pool.

import {
  applyBenchmarkRerankMode,
  BENCHMARK_FINAL_K,
  BENCHMARK_RETRIEVAL,
  renumberBenchmarkCitations,
  type BenchmarkCandidate,
  type BenchmarkCandidatePool,
  type BenchmarkCitation,
  type BenchmarkEvidence,
  type BenchmarkMode,
  type BenchmarkRerankRunner,
  type BenchmarkVectorSpace,
} from "./benchmark-rerank.ts";

export const BENCHMARK_FUSION_DEFAULT = BENCHMARK_RETRIEVAL.fusion;
export const BENCHMARK_RRF_K = BENCHMARK_RETRIEVAL.rrfK;
export const BENCHMARK_DENSE_N = BENCHMARK_RETRIEVAL.dense;
export const BENCHMARK_LEX_N = BENCHMARK_RETRIEVAL.lexical;
export const BENCHMARK_CANDIDATE_CAP = BENCHMARK_RETRIEVAL.candidateCap;

/** One retrieval row from the benchmark mirror RPC (same shape as production). */
export type BenchmarkRetrievalRow = {
  chunk_id: string;
  document_id: string;
  tenant_id: string;
  file_name: string;
  page: number;
  content: string;
  dense_score: number | null;
  dense_rank: number | null;
  lex_score: number | null;
  lex_rank: number | null;
  channel: string;
};

type FusedEntry = {
  row: BenchmarkRetrievalRow;
  fused: number;
};

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function mergeInto(
  byId: Map<string, FusedEntry>,
  row: BenchmarkRetrievalRow,
  add: number,
): void {
  let e = byId.get(row.chunk_id);
  if (!e) {
    e = {
      row: {
        chunk_id: row.chunk_id,
        document_id: row.document_id,
        tenant_id: row.tenant_id,
        file_name: row.file_name,
        page: row.page,
        content: row.content,
        dense_score: null,
        dense_rank: null,
        lex_score: null,
        lex_rank: null,
        channel: row.channel,
      },
      fused: 0,
    };
    byId.set(row.chunk_id, e);
  }
  if (row.dense_rank != null) {
    e.row.dense_score = numOrNull(row.dense_score);
    e.row.dense_rank = numOrNull(row.dense_rank);
  }
  if (row.lex_rank != null) {
    e.row.lex_score = numOrNull(row.lex_score);
    e.row.lex_rank = numOrNull(row.lex_rank);
  }
  e.fused += add;
}

/**
 * Reciprocal-rank fusion with the locked production shape: per-channel
 * 1/(RRF_K + rank), chunk_id tie-break, highest fused first.
 */
export function benchmarkRrfFuse(rows: BenchmarkRetrievalRow[]): Map<string, FusedEntry> {
  const byId = new Map<string, FusedEntry>();
  for (const row of rows) {
    const denseRank = numOrNull(row.dense_rank);
    const lexRank = numOrNull(row.lex_rank);
    if (denseRank != null) mergeInto(byId, row, 1 / (BENCHMARK_RRF_K + denseRank));
    if (lexRank != null) mergeInto(byId, row, 1 / (BENCHMARK_RRF_K + lexRank));
  }
  return byId;
}

/** Fused ranking in final order (fused desc, chunk_id asc), uncut. */
export function benchmarkRankFused(byId: Map<string, FusedEntry>): Array<FusedEntry & { id: string }> {
  return [...byId.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (b.fused - a.fused) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type BenchmarkScopeInput = {
  notebookRequested: boolean;
  /** Same-tenant, live (non-archived), selected source IDs; null when not requested. */
  notebookDocIds: string[] | null;
  /** Conversation temp IDs (ready + unexpired), already tenant-validated. */
  tempDocIds: string[];
  /** Explicit persistent-only IDs when temp rows exist but no scope was requested; otherwise null. */
  unscopedPersistentIds: string[] | null;
  /** Caller-validated explicit document list (tenant/archived/expiry checked). */
  validatedDocIds: string[] | null;
};

export type BenchmarkScopeResult = {
  allowedDocIds: string[] | null;
  scopeEmpty: boolean;
  tempDocIds: string[];
};

/**
 * Pure mirror of the query-chunks scope-combination rules: notebook scope,
 * validated direct lists, temporary union, and the unscoped persistent
 * exclusion when temp rows exist. The benchmark Edge function performs the
 * reads; this helper combines them deterministically.
 */
export function resolveBenchmarkScope(input: BenchmarkScopeInput): BenchmarkScopeResult {
  let allowedDocIds = input.notebookDocIds ?? input.validatedDocIds;
  const scopeEmpty = input.notebookRequested && (!allowedDocIds || allowedDocIds.length === 0);

  if (allowedDocIds !== null) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...allowedDocIds, ...input.tempDocIds]) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    allowedDocIds = out;
  } else if (input.tempDocIds.length > 0) {
    allowedDocIds = [...input.tempDocIds];
  } else if (input.unscopedPersistentIds !== null) {
    allowedDocIds = [...input.unscopedPersistentIds];
  }

  return { allowedDocIds, scopeEmpty, tempDocIds: [...input.tempDocIds] };
}

export function toBenchmarkRerankPool(input: {
  question: string;
  tenantId: string;
  vectorSpace: BenchmarkVectorSpace;
  ranked: Array<{ id: string; row: BenchmarkRetrievalRow; fused: number }>;
}): BenchmarkCandidatePool {
  return {
    question: input.question,
    tenantId: input.tenantId,
    vectorSpace: { ...input.vectorSpace },
    candidates: input.ranked.map((entry, order) => {
      const candidate: BenchmarkCandidate = {
        poolIndex: order,
        chunk_id: entry.row.chunk_id,
        document_id: entry.row.document_id,
        tenant_id: entry.row.tenant_id,
        file_name: entry.row.file_name,
        page: entry.row.page,
        content: entry.row.content,
        fused_score: entry.fused,
        fused_rank: order + 1,
        dense_score: entry.row.dense_score,
        dense_rank: entry.row.dense_rank,
        lex_score: entry.row.lex_score,
        lex_rank: entry.row.lex_rank,
      };
      return candidate;
    }),
  };
}

export type BenchmarkRetrievalOutcome =
  | {
    ok: true;
    mode: BenchmarkMode;
    evidence: BenchmarkEvidence[];
    citations: BenchmarkCitation[];
    candidateCount: number;
    denseCount: number;
    lexicalCount: number;
    usageTokens: number | null;
  }
  | { ok: false; mode: BenchmarkMode; error: string };

/**
 * Run one benchmark retrieval mode over an already-fused, already-ranked pool.
 * Both modes receive the identical pool object; only the rerank stage differs.
 */
export async function applyBenchmarkRetrievalMode(input: {
  pool: BenchmarkCandidatePool;
  mode: BenchmarkMode;
  topN?: number;
  rerank?: BenchmarkRerankRunner;
  denseCount: number;
  lexicalCount: number;
}): Promise<BenchmarkRetrievalOutcome> {
  const outcome = await applyBenchmarkRerankMode({
    pool: input.pool,
    mode: input.mode,
    topN: input.topN ?? BENCHMARK_FINAL_K,
    rerank: input.rerank,
  });
  if (!outcome.ok) return { ok: false, mode: input.mode, error: outcome.error };
  return {
    ok: true,
    mode: input.mode,
    evidence: outcome.evidence,
    citations: renumberBenchmarkCitations(outcome.evidence),
    candidateCount: input.pool.candidates.length,
    denseCount: input.denseCount,
    lexicalCount: input.lexicalCount,
    usageTokens: outcome.usageTokens,
  };
}
