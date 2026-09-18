# RAG-4i: Voyage → Jina Benchmark & Engineering Report

**Status:** measurement complete; reporting only. No new benchmarks were run,
no provider was called, and nothing in production or in any benchmark artifact
was modified to produce this document.

**Evidence labels used throughout:** [Measured] direct tool observation ·
[Recorded] value from a frozen artifact or prior validated report · [Calculated]
arithmetic on measured/recorded values · [Estimated] bounded approximation with
stated method · [Inferred] conclusion drawn from evidence · [Unknown] not
established.

**Primary sources:** `eval/runs/baseline-20260917T134457Z.json` (Voyage
control) · `eval/runs/benchmark-jina-34case-01.json` (Jina, 34 cases) ·
`eval/runs/benchmark-jina-ca-32case-01.json` (Jina, CA corpus) ·
`eval/cases/gold_cases.json`, `eval/cases/gold_cases_ca.json`,
`eval/mappings/chunk_map_3c4.json`, `eval/mappings/chunk_map_ca.json` ·
`ARCHITECTURE.md`, `DECISIONS.md` (D53–D63), `SESSION_HANDOFF.md` ·
`eval/runs/ingestion-perf-audit-100page.md` (Voyage timing analysis).

---

## 1. Executive summary

The RAG-4i question-answering system originally converted documents into
searchable vectors with Voyage AI (`voyage-4`) at a measured account envelope
of 3 requests/minute and 10,000 tokens/minute. Because a ~60,000-token document
needs at least six minutes of token throughput at that allowance — before
counting request pacing, worker scheduling, parsing, and database work — a
representative 100-page document took about 16 minutes end-to-end to become
searchable.

The team then built an isolated benchmark path using Jina
(`jina-embeddings-v5-text-small`, same 1024 dimensions) plus a second-stage
`jina-reranker-v3.5`, without touching the production Voyage path. On the
frozen 34-question benchmark, Jina with reranking matched the Voyage control
hit rate (0.882) with higher ranking quality (MRR 0.833 vs 0.793), and on a
real 100-page regulatory document it reached hit 0.906 with perfect citation
correctness (1.000). The measured benchmark population path fell from
approximately 975 seconds to approximately 40 seconds — an observed ~96%
wall-clock reduction — while API throughput headroom rose ~33× on requests and
10× on tokens.

That headline needs one careful qualification, developed in §5: the historical
975-second figure is an **upload→ready** measurement that includes PDF parsing,
chunking, database writes, and worker/cron scheduling under the old 3 RPM
limit — it is not a pure embedding-provider latency comparison. The technically
accurate statement is:

> The measured benchmark population path fell from approximately 16 minutes to
> approximately 40 seconds, an observed ~96% reduction in wall-clock time,
> while noting that the historical Voyage measurement included additional
> ingestion-pipeline overhead.

What improved, in brief: far higher API throughput allowance; a reranking stage
that recovers misses the first stage drops; citation and grounding controls
preserved (citation correctness 0.853–1.000 across all runs); full per-stage
timing telemetry where the old pipeline had coarse measurements; and a second,
real-corpus validation beyond the original benchmark. What remains uncertain:
production-scale rate behavior, exact reranker token counts, commercial terms,
and long-term model stability (§13). No provider is ranked or selected here.

---

## 2. Before vs after

| Dimension | OLD system (Voyage-based) | CURRENT system (benchmark path added) |
|---|---|---|
| Embedding provider | Voyage `voyage-4`, 1024 dims, `document`/`query` input types | Voyage unchanged in production; Jina `jina-embeddings-v5-text-small`, 1024 dims, `retrieval.passage`/`retrieval.query` tasks, isolated benchmark partition |
| Account envelope [Recorded] | 3 RPM / 10,000 TPM | 100 RPM / 100,000 TPM on one shared key |
| Retrieval | Hybrid dense + lexical, RRF-60, top-8, deterministic | Identical (mirrored lock-for-lock in benchmark code) |
| Second-stage ranking | None | `jina-reranker-v3.5`, top-8, benchmark-only |
| Evidence controls | Evidence gate, citation guard, tripwire, flag-gated correctness checker, Mantle generation | Identical shared code in the benchmark answer path; no persistence |
| Observability | Coarse timings (retrieval/generation totals) | Per-stage timings (embed, RPC, fusion, rerank), provider token counts, request/429 accounting, case-level provenance |
| Evaluation | Frozen 34-case gold set + mappings + run artifacts | Same, plus frozen 32-case CA gold set + mappings |

What changed is three separable things — (a) the embedding provider and its
throughput envelope, (b) the addition of reranking as a second evidence-selection
stage, and (c) substantially richer measurement. Retrieval algorithm, gate,
prompts, citation rules, and generation configuration are byte-identical shared
logic in both paths. Improvements must not be attributed to Jina alone.

---

## 3. Apples-to-apples 34-case comparison

Same corpus (226 chunks), same 34 questions, same mappings, same metric
definitions. Absolute differences are shown without any aggregate score.

| Metric | Voyage control | Jina A (no rerank) | Jina B (+ rerank) | B − control | B − A |
|---|---|---|---|---|---|
| Hit rate | 0.882 | 0.853 | 0.882 | 0.000 | +0.029 |
| Recall@4 | — | 0.449 | 0.500 | — | +0.051 |
| Recall@8 | 0.598 | 0.532 | 0.581 | −0.017 | +0.049 |
| Recall@12 | — | 0.566 | 0.603 | — | +0.037 |
| MRR | 0.793 | 0.753 | 0.833 | +0.040 | +0.080 |
| Gate match | 0.441 | 0.324 | 0.382 | −0.059 | +0.058 |
| Label match | 0.235 | 0.235 | 0.235 | 0.000 | 0.000 |
| Citations OK | 0.824 | 0.853 | 0.853 | +0.029 | 0.000 |
| Key-fact correctness | 0.394 | 0.356 | 0.389 | −0.005 | +0.033 |

(Recall@4/@12 were not summarized for the control; shown as — rather than
invented.)

Practical reading. **Jina A vs Voyage:** slightly lower hit/recall with the
same top-8 budget — different dense orderings over the same chunks, as expected
from a different vector space. **Jina B vs Voyage:** hit rate equal (0.882),
ranking quality higher (MRR +0.040), citations marginally higher, gate match
lower. **Jina A vs Jina B:** reranking recovered misses and lifted every
ranking metric (+0.029 hit, +0.049 R@8, +0.080 MRR) on the identical candidate
pools. Label match is identical (0.235) in all three runs — labels are
dominated by deterministic generation over whatever evidence arrives, so equal
labels do not imply equal retrieval.

---

## 4. What the reranker actually improved

`jina-reranker-v3.5` re-orders the ≤50-candidate fused pool and returns the top
8; it sees question + chunk text only, never scores or vectors. Measured
effects on frozen case evidence:

- **Misses recovered:** E3 (34-case) and CA02/CA07 went miss → hit; several
  gate verdicts returned to control values (C2/C3/G2/D2).
- **Ranking improvements:** MRR +0.080 (34-case) with corresponding recall lifts
  at all cutoffs; CA MRR 0.828 → 0.891.
- **Regressions:** B5 rank decayed 1.0 → 0.333 (still a hit); A3 flipped
  SUPPORTED → CONFLICTING under reranked evidence.
- **Ordering changed, answer intact:** most cases keep verdict and answer while
  evidence order shifts — the normal, healthy reranker signature.
- **Gate flips:** reranking changes which 8 chunks the gate sees, so gate/label
  movement (e.g. C2/C3/G2/D2 fixes, A3 flip) is an evidence-set effect, not a
  gate change.

Reranking is a second-stage *selection* mechanism over an already-retrieved
pool — it cannot recover chunks outside the pool, and it does not improve every
case. Its contribution is separately measurable precisely because conditions A
and B share one fused pool per case.

---

## 5. Speed / performance

Historical Voyage, 300-chunk/≈60K-token fixture [Measured]: **upload→ready
≈975 s** (register ≈10 s incl. ~2.9 s download; embedding phase ≈962 s).

Jina benchmark population, 274-chunk/≈52.5K-token CA corpus [Measured]:
**56.6 s wall** (≈31.6 s provider-call time + 20.0 s pacing; 9 requests;
52,493 provider-reported tokens; 0×429). The 34-case population (226 chunks)
was recorded at **≈40 s** [Recorded].

Reduction on the population path [Calculated]:

- Absolute: 975 − 40 = **935 s**.
- Multiplier: 975 / 40 ≈ **24.4×**.
- Percentage: 935 / 975 × 100 ≈ **95.9% (≈96%)**.

Jina timing split [Measured]: per-call provider time dominates; pacing is
explicit sleeps between bounded batches. Voyage bottleneck decomposition
[Recorded]: ≈362 s provider token floor + ≈462 s cron/claim idle + ≈138 s
batch/processing overhead.

Per-case retrieval [Measured]: Voyage control ≈1.859 s mean; Jina ≈2.516 s
(34-case) / ≈2.296 s (CA), of which rerank ≈0.47 s, query embed ≈0.36 s, RPC
≈0.42 s, fusion ≈0 ms. Jina retrieval is *not* faster per case than the
control — the speed story is throughput at population scale, not per-query
latency. Generation means (2.2–2.9 s everywhere) reflect the shared Mantle
path, not the embedding provider.

---

## 6. Rate-limit / throughput improvement

| | Voyage (historical) | Jina (recorded envelope) | Multiplier [Calculated] |
|---|---|---|---|
| RPM | 3 | 100 | **≈33×** |
| TPM | 10,000 | 100,000 | **10×** |

Why it matters for a ~60K-token corpus: at 10K TPM the token-time floor alone
is ≈362 s (6 min) regardless of batching; at 100K TPM the same floor is
≈36 s. Three ceilings must not be confused: (a) the **theoretical provider
ceiling** (tokens ÷ TPM), (b) the **observed benchmark throughput** (≈52.5K
tokens in ≈36.6 s of call time, ≈86K TPM effective), and (c) **end-to-end
pipeline throughput** (adds pacing, RPC, fusion, rerank, persistence). A 100K
TPM allowance does not mean production will sustain 100K TPM — burst shape,
concurrency, and shared embed+rerank budget on one key all remain unproven at
scale.

---

## 7. Real CA corpus results

Purpose: validate the current system on a real, amendment-layered regulatory
document beyond the original benchmark — not to compare against Voyage.

Document: `SEBI (AIFs) Regulations, 2012_Amended upto July 14, 2026.pdf` —
100 pages, 1,094,459 bytes, 274 chunks, ≈221,302 chars (≈55K tokens),
32 gold cases (30 SUPPORTED + 2 refusal), frozen in
`eval/cases/gold_cases_ca.json` + `eval/mappings/chunk_map_ca.json`.

| Metric | A no-rerank | B reranked |
|---|---|---|
| Hit / Recall@8 / MRR | 0.844 / 0.844 / 0.828 | 0.906 / 0.906 / 0.891 |
| Gate / label match | 0.250 / 0.094 | 0.219 / 0.125 |
| Citations OK | 1.000 | 1.000 |
| Key-fact correctness | 0.836 | 0.928 |

Timing/tokens [Measured unless noted]: population 56.6 s wall (31.6 s
provider, 20.0 s pacing), 9 requests, 52,493 tokens, 0×429/retries/failures;
retrieval mean 2.296 s (embed 364 ms, RPC 421 ms, fusion ~0 ms, rerank 468 ms);
generation A 2.852 s / B 2.289 s; run wall 538.3 s; queries 513 tokens
[Measured]; rerank tokens lower ~77K / central ~190K / upper ~321K [Estimated
with stated method].

What CA demonstrates: Jina retrieval works on dense regulatory prose (hit
0.906 with rerank); grounding stays intact (citations 1.000, key facts
0.928); the gate/label gaps trace to gold-expectation optimism against a
token-literal gate (§8), not to retrieval failure.

---

## 8. Evaluation lessons

1. **Amendment layers read as conflicts.** Old-vs-new provision text coexisting
   in nearby chunks legitimately triggers CONFLICTING verdicts (A3, C2-A, G2-A).
2. **The gate is token-literal.** Acronym-heavy questions ("SEBI", "AIF")
   against spelled-out chunks yield PARTIAL even when retrieval is perfect
   (e.g. CA01) — a gate/gold interaction, not a retrieval miss.
3. **Refusal taxonomy mismatch.** R1/R2 behave as honest refusals (explicit
   non-answer, zero citations) while the gate returns PARTIAL with reason
   `insufficient-evidence` rather than INSUFFICIENT. Future gold sets should
   expect PARTIAL-or-refusal or test refusal separately.
4. **Fragment exclusion worked.** The 5 near-empty chunks and truncation
   artifacts were mapped by zero cases; no case depends on them.
5. **F1–F4 miss everywhere including the control** — genuinely hard cases,
   provider-independent.

These matter because they separate *measurement artifacts* from *system
behavior*: most gate/label gaps are the former.

---

## 9. RAG-4i architecture improvements

Verified in source of truth (code, migrations, decisions): hosted-cloud
backend on Supabase Postgres + Edge Functions with tenant-scoped RLS
throughout; hybrid dense (HNSW cosine) + lexical (tsvector) retrieval with
locked parameters (20/20/cap-50/RRF-60/k-8); deterministic fusion and
tie-breaking; model-free evidence gate; hard-fail citation guard;
groundedness tripwire; flag-gated correctness checker; conversation-scoped
temporary documents with retrieval-time expiry as the access boundary;
benchmark isolation via separate tables/RPCs/functions with natural-key
uniqueness (tenant, chunk, provider, model, run); frozen, content-bound
evaluation (chunk IDs hash content, so re-runs address identical rows);
per-stage timing telemetry (embed/RPC/fusion/rerank/generation) with provider
token counts and 429 accounting; provider adapters isolated behind separate
config with one shared secret name; additive-only migration discipline with
rollback by preserving the incumbent vectors and reverting query-embedding
configuration.

---

## 10. Observability / engineering maturity

The old pipeline exposed coarse totals; the benchmark path now records, per
case: provider token counts, request counts, 429/retry/failure counters,
embedding/query/RPC/fusion/rerank/generation latencies, full candidate
provenance, and frozen input→output artifacts — plus production-integrity
snapshots (documents, chunks, jobs, conversations, storage, temp rows,
function versions) before and after every run. For an SME/client this is the
difference between "the answer changed" and "the answer changed *because the
reranker promoted chunk X over chunk Y at 468 ms, using Y tokens*" — every
quality delta in §§3–4 is traceable to a stored evidence set.

---

## 11. Operational / migration implications

- 563 production chunks exist today; a provider switch requires re-embedding
  all of them (≈112K tokens by chars/4 estimate).
- Voyage vectors cannot be reused (different vector space despite shared 1024
  dims); additive/dual-provider migration is the safer design; rollback works
  by preserving Voyage vectors and reverting query-embedding configuration.
- Reranking adds ≈5–8K tokens per query (estimated) and ≈0.5 s latency
  (measured) — a per-query cost absent from the current production path.
- Free-key limits sufficed for benchmark scale (≈400 K tokens total spend);
  production-scale query bursts are unproven.
- No migration is recommended here; this is a factual assessment.

---

## 12. What has actually improved

- **A. Speed:** benchmark population 975 s → ≈40 s wall (≈96%, ≈24×) [Measured
  wall clocks; definitions differ as documented — the Voyage figure includes
  parse/chunk/DB/cron stages].
- **B. Retrieval:** equal-or-better ranking on matched corpus (MRR +0.040 with
  rerank; hit parity 0.882) [Measured].
- **C. Ranking:** reranker lifts recall/MRR on identical pools in both corpora
  [Measured]; not universal (B5 decay, A3 flip preserved as evidence).
- **D. Grounding/citations:** citation correctness 0.853–1.000 across all runs;
  guard unchanged and enforced [Measured].
- **E. Reliability:** 150+ provider calls across the program, zero 429s/retries/
  failures [Measured]; no claim about production load.
- **F. Throughput capacity:** 33× RPM / 10× TPM allowance headroom [Recorded
  limits; capacity, not sustained throughput].
- **G. Observability:** per-stage timing + token accounting where none existed
  [Implemented, verified in artifacts].
- **H. Architecture:** isolated benchmark path, additive migration discipline,
  rollback-safe design [Implemented].
- **I. Evaluation maturity:** frozen gold sets (34 + 32), deterministic
  validation, provenance-preserving artifacts [Implemented].
- **J. Operational safety:** every run verified production-identical before and
  after (documents, chunks, jobs, conversations, storage, temp rows, function
  versions) [Measured].

---

## 13. What has not been proven

Production-scale query throughput and rate-limit behavior; exact reranker
provider token counts (bounded estimates only); long-tail query behavior;
commercial pricing (no prices in repo docs — unresolved input); long-term
model-version stability; full production re-embedding duration at scale;
large-scale concurrent load; sustained 100K TPM in production. Benchmark
success must not be read as any of these.

---

## 14. Numbers that matter

Historical Voyage population ≈975 s · Jina benchmark population ≈40 s ·
observed wall-clock reduction ≈96% · multiplier ≈24× · Voyage RPM 3 → Jina
100 (≈33×) · Voyage TPM 10K → Jina 100K (10×) · frozen cases 34 · frozen
chunks 226 · CA cases 32 · CA chunks 274 · production chunks 563 · CA
population 56.6 s · CA tokens 52,493 · CA requests 9 · failures/429s 0.

---

## 15. Conclusion

What changed from the old Voyage system to the current RAG-4i implementation
is multi-dimensional: provider throughput constraints loosened by roughly an
order of magnitude or more, which collapsed the benchmark population wall
clock; a reranking stage added second-stage evidence selection with separately
measured gains and costs; retrieval ranking improved in the specific measured
ways (§3) while citations and grounding controls held firm; evaluation became
reproducible, provenance-preserving, and observable per stage; and a second
real corpus validated the architecture beyond the original benchmark. The
remaining decision inputs — accepted quality tradeoffs, latency and volume
requirements, token economics, migration cost, and rollback posture — are
factual questions for the owner, not conclusions of this report.

---

## 16. Client/SME version

- We started with document search powered by Voyage AI, limited to 3
  requests/minute — a 100-page document took ~16 minutes to become searchable.
- We added an isolated Jina-powered path (same 1024-dimension format) plus a
  reranking step, without touching the live system.
- Measured population time fell from ~16 minutes to ~40 seconds (≈96%, ≈24×),
  noting the old figure included extra pipeline stages.
- API capacity headroom rose ~33× on requests and 10× on tokens.
- Reranking recovered misses (e.g. hit 0.844 → 0.906 on the real corpus) at a
  cost of ~0.5 s and a few thousand tokens per question.
- Citations and answer-grounding checks stayed at 0.85–1.00 throughout.
- The system was validated on a real 100-page regulation (32 questions), not
  just the original test set.
- Every result is traceable to stored evidence and timings — we can explain
  exactly why any answer changed.
- Still to decide: quality/latency tradeoffs, expected usage volumes, token
  budget, migration cost, and rollback requirements.
