# RAG 4i — Architecture

Status: **V1 LOCKED** (2026-09-16). This document is now the technical source of
truth for the *current* production system. Part 1 below describes what is actually
deployed and verified. Part 2 is the original pre-implementation analysis
(2026-09-14), preserved for history and explicitly **SUPERSEDED**.

- Current production checkpoint: git HEAD `5271e9a` plus the H1 router
  commit (D68); deployed and ACTIVE:
  `ingest-pdf` v36, `embed-worker` v35, `query-chunks` v33, `ask` v43,
  `storage-cleanup` v3 (see §1.15). The H1 pre-RAG router request is deployed
  in `ask` v43; its source is committed at the H1 checkpoint.
- For the fresh-session continuation entry point see `SESSION_HANDOFF.md`.
- For decision records see `DECISIONS.md`.
- **This document covers the backend/RAG only.** The frontend lives in `web/`
  and is documented in `UI_ARCHITECTURE.md`; backend facts below are unchanged
  by UI work.

Source-of-truth hierarchy:

1. **The code and migrations** (`supabase/migrations/`, `supabase/functions/`) are
   authoritative for implementation facts.
2. `ARCHITECTURE.md` (this file, Part 1) — current technical architecture.
3. `DECISIONS.md` — decision records (status table for D1–D17, current decisions
   D18–D45; the original D1–D17 bodies are historical).
4. `UI_ARCHITECTURE.md` — frontend architecture (implementation status,
   boundaries, pending work); never overrides Part 1.
5. `SESSION_HANDOFF.md` — session continuation state.
6. `eval/README.md` — evaluation harness usage.
7. Part 2 of this file — historical analysis, superseded.

---

# Part 1 — Current production architecture (V1 LOCKED)

## 1.1 Application and request flow

Browser app (Next.js; see `UI_ARCHITECTURE.md`) → Supabase Edge Functions. The
browser holds only its Supabase publishable key + the user's Auth JWT. It
**never** calls a model provider (Jina or Bedrock/Mantle) directly; all
provider traffic is server-side.

Edge Functions (Deno), all ACTIVE:

| Function | Role | JWT |
|---|---|---|
| `ingest-pdf` | PDF → chunks: `action` = `ingest` / `retry` / `delete-document` | gateway `verify_jwt` on; caller JWT data plane |
| `embed-worker` | Cron-driven Jina embedding of pending chunks | `verify_jwt` **off**; gated by `x-worker-key` timing-safe secret |
| `query-chunks` | Query embedding + hybrid retrieval + rerank (optional notebook/document scope) | caller JWT |
| `ask` | Full answering pipeline (see 1.2) | caller JWT |
| `storage-cleanup` | Bounded orphan-object cleanup for one tenant (see 1.16) | caller JWT + membership; `apply` requires owner/admin |

All browser-facing functions share `_shared/cors.ts` (D46); `embed-worker` is
cron-only and does not.

`/ask` request pipeline (one invocation):

```
POST /functions/v1/ask  { tenant_id, query (≤1000 chars), conversation_id? }
 → bearer JWT → auth.getUser            (401 fail-closed)
 → membership lookup                    (403)
 → conversation: verify or create
 → pre-RAG router (H1)                  (deterministic; CONVERSATIONAL → fixed
                                         reply, no embedding/retrieval/gate/LLM)
 → conversation context (H3A)            (bounded read + FOLLOW_UP detect, telemetry)
 → clarification gate                   (deterministic; no LLM)
 → retrieval  (internal call to query-chunks)
 → evidence gate (verifyEvidence)
 → INSUFFICIENT? → refusal, no LLM      (label insufficient, 0 cites, grounded null)
 → generation (Bedrock Mantle chat completions, temp 0.0)
 → strip <think> blocks
 → citation guard                       (hard 502 on failure)
 → groundedness tripwire                (downgrade-only)
 → answer-correctness checker           (flag-gated, advisory)
  → deterministic aggregation
  → persist user+assistant messages
  → JSON response (+ bounded diagnostics + per-turn `telemetry`)
```

**Per-turn telemetry (H2B, D70).** Every `ask` response carries a
`telemetry` object with router / retrieval / embedding / rerank / evidence /
generation / checker sections; the same object is persisted inside
`messages.timings.telemetry` (no schema change, caller-JWT RLS unchanged).
Every token number is `{ value, basis }` with basis
`measured` (provider-reported: Jina embed and rerank `usage.total_tokens`,
Mantle `prompt_tokens`/`completion_tokens`), `calculated` (deterministic
zeros for work not performed), `estimated` (chars/4, the only proxy), or
`unknown` (unavailable — never fabricated, never coerced to 0). Counts and
sizes are measured; document text never enters telemetry, only its length.
Totals are deliberately not summed across bases. `usage_counters` is not
written: it is an aggregate window table with no caller-JWT write path, and
making it operational would require a service_role client in `ask` or a
schema/RLS change — out of scope for H2B.

## 1.2 Authentication, tenancy, RLS

- Supabase Auth is the sole identity source. Edge Functions validate the caller
  JWT via `auth.getUser(jwt)` and use a **caller-JWT data plane** — no
  `service_role` in the query path.
- Every RAG row carries `tenant_id`. RLS is enabled on every application table.
  Policies use `to authenticated` + membership helpers
  `private.is_tenant_member(tenant_id)` / `private.is_tenant_manager(tenant_id)`
  (`security definer`, `set search_path = ''`, `STABLE`). The tenant predicate is
  on every retrieval branch.
- `match_chunks` is `SECURITY INVOKER`, so the caller's RLS applies on top of its
  explicit tenant predicates (anon sees nothing — no anon policy exists).
- Browser upload/download uses tenant-namespaced Storage keys
  `tenants/<tenant_id>/docs/<doc>/<file>` in the private `company-documents`
  bucket. Membership is a live DB lookup (immediate revocation).
- `service_role` is confined to the `embed-worker` (platform scheduler role),
  scoped per claimed job to that job's own tenant/document. No other function
  uses it.

## 1.3 Retrieval (LOCKED)

Provider: Jina AI `jina-embeddings-v5-text-small`, **1024-dim float**,
`task: "retrieval.passage"` for corpus and `"retrieval.query"` for queries
(`normalized: true`). Query embeddings are produced server-side.

`query-chunks` behavior:

- Server-side query embedding (Jina model pinned; model mismatch → 502;
  vector length and finiteness validated).
- One RPC round trip: `public.match_chunks(p_tenant_id, p_query_vector,
  p_query_text, p_dense_n, p_lex_n, p_document_ids)`. The last parameter is the
  **only** post-lock addition (D50): `NULL` means the previous unscoped
  behaviour; an array restricts both branches to those documents. Everything
  else below is unchanged. Dense branch skips NULL embeddings;
  `hnsw.iterative_scan = 'relaxed_order'` is set per-transaction so selective
  tenant filters still return full candidate sets.
- Temporary conversation scope (D60; migration applied, deployed in
  `query-chunks` v31 / `ask` v39; live-validated 2026-09-17): `ask` and
  `query-chunks` additionally union the conversation's ready + unexpired
  temporary documents (resolved server-side from a tenant-validated
  `conversation_id`) into the allowed set; direct `document_ids` calls reject
  expired temporary IDs fail-closed. No temporary document can enter the set
  through `notebook_sources` (database trigger). Empty notebook scope with no
  temporaries still refuses deterministically; no conversation and no
  temporaries stays byte-identical unscoped. Unscoped retrieval with temporary
  rows present resolves the persistent set explicitly, so one conversation's
  temporaries never surface in another's (cross-conversation isolation proven
  live).
- Constants (LOCKED, calibrated on the gold corpus): dense **20**, lexical **20**
  (`CANDIDATE_CAP = 50`), fusion **RRF** with **`RRF_K = 60`** (a `weighted`
  min-max blend exists but is not the default), final evidence **`k = 8`**
  (`FINAL_K_CAP = 20`), deterministic tie-break by `chunk_id`.
- **No global dense threshold/floor.** Retrieval is recall-first; the evidence
  gate owns the cut.
- **Second-stage rerank (D64).** The full fused candidate pool (≤50, question +
  chunk text only) is reranked by `jina-reranker-v3.5` (`top_n` = final K);
  evidence order follows the reranker while `fused_rank`/`fused_score` keep
  their RRF provenance values. A reranker failure degrades to RRF order
  (`reranked: false`) instead of failing retrieval.
- **Rerank skip (H2A, D69).** When the fused pool already fits inside final K
  (`pool ≤ 8`), there is nothing the reranker can cut, so the provider call is
  skipped and the fused order stands (`rerank: { attempted, skipped, reason,
  fused_candidates }` records the decision). Same evidence set, zero provider
  cost; the boundary is `pool > finalK`, not a hardcoded size.
- Provenance per evidence item: `chunk_id`, `document_id`, `tenant_id`,
  `file_name`, `page`, `content`, `dense_score/dense_rank`, `lex_score/lex_rank`,
  `fused_rank/fused_score`.

## 1.4 Evidence gate (deterministic, model-free)

`verifyEvidence(question, evidence)` → `{ verdict, reason, supported[],
unsupported[], conflicting[] }`. Verdicts:

| Verdict | Meaning | Reasons used |
|---|---|---|
| `SUPPORTED` | every checkable atom is covered | `all-supported`, `no-checkable-claims` |
| `PARTIAL` | some atoms missing | `insufficient-evidence` |
| `INSUFFICIENT` | no evidence, or evidence disjoint from the question | `no-evidence`, `unsupported-claims` |
| `CONFLICTING` | question-relative contradiction | `conflicting-evidence` |

Mechanism: question atoms (terms/numbers/quoted spans) checked against
normalized chunk tokens; conflict detection requires genuinely incompatible
values linked by **exclusive question-anchored phrasal pairs** (a single shared
phrase is treated as boilerplate); bare numbers require the question to frame the
choice; negation uses the same anchored-pair rule; amendment/supersession
language (`prior to its substitution`, `w.e.f.`, etc.) never creates a false
conflict (version-aware). Disjoint evidence short-circuits to `INSUFFICIENT`
before any conflict detector.

`promptModeFor` maps verdict → generation mode: `direct | partial | conflict |`
`refuse`.

## 1.5 Generation (Bedrock Mantle, exclusive)

- Provider: **Bedrock Mantle Chat Completions only** —
  `https://bedrock-mantle.ap-south-1.api.aws/v1/chat/completions` (fixed
  server-side constant, never taken from the request).
- Model: from the `ANSWER_MODEL_ID` secret (production
  `qwen.qwen3-235b-a22b-2507-v1:0`). Never hardcoded, never silently substituted.
- `temperature 0.0`, `max_tokens 1024`, single user message = frozen rendered
  prompt.
- Prompts are frozen/versioned: `PROMPT_VERSION = "v1"` with modes
  `v1-direct`, `v1-partial`, `v1-conflict`. The model must cite evidence as
  `[Sn]`; refusal text is a fixed constant.
- No `bedrock-runtime` SDK, no Converse/InvokeModel, no EC2, no local model, no
  provider fallback or substitution anywhere.

## 1.6 Citation guard

Deterministic. Citations are positional `[Sn]` over the exact evidence array.
`validateCitations` rejects: malformed bare `[S]`, out-of-range `[Sn]`, a
citation with no backing chunk, cross-tenant reference, and (when scoped)
out-of-document reference. Failure is a **hard 502** (never silent). Response
`citations` are the de-duplicated, validated source objects. Each source
object additionally carries `excerpt`: the verbatim content of the exact
retrieved chunk behind that citation (empty/missing content → `null`). The
excerpt is constructed 1:1 over the retrieved array
(`_shared/citation-sources.ts`, D80), so citation numbering and chunk identity
are unchanged; no summarization, rewriting, or second retrieval is involved.

## 1.7 Groundedness tripwire

Deterministic post-generation check (`checkGroundedness`): numbers, dates,
qualifiers/negations, and sentence-level support against the retrieved chunk
text. Any finding sets `grounded = false` and **downgrades** `direct → partial`
with a static note; it never rewrites the answer and never regenerates.
Diagnostics are exposed as `tripwire { reason, findings[], counts }` with reasons
`grounded | unsupported-claims | numeric-mismatch | missing-qualifier`.

## 1.8 Answer-correctness checker (bounded, flag-gated, advisory)

- Enabled only when the server-side secret `CORRECTNESS_CHECKER_ENABLED === "true"`
  (default OFF; never exposed to the browser). It is **structurally never invoked
  for an INSUFFICIENT gate** (that path returns a refusal before it).
- A bounded single-shot evaluator, not an agent: fixed input
  (question / answer / evidence / gate verdict / citations), fixed prompt
  (`correctness-v1`), strict JSON contract
  `{ checker, verdict, claims[], feedback, invalid_result, invalid_reason }`,
  verdict `PASS | PARTIAL | FAIL | INVALID`.
- Uses the same Mantle endpoint/model/key. **No application-level `max_tokens`**
  (provider applies its own maximum). 30 s timeout; at most **one** retry, and
  only for transport/5xx/timeout; malformed output → `INVALID` (never repaired);
  `INVALID` preserves the original result. No tools, no web, no retrieval, no
  memory, no loops, no regeneration.
- Output is **advisory only** (see aggregation). Claims/feedback/model text are
  never logged or returned.

## 1.9 Aggregation

Deterministic and **downgrade-only** (`aggregateCorrectness`):

- `PASS`/`INVALID`/absent → preserve label and note.
- `PARTIAL`/`FAIL` → if the label is `direct`, downgrade to `partial` and append
  a static note; otherwise keep the label and append the note.
- It can never upgrade a verdict, bypass a refusal, override citations, override
  the evidence gate, or change HTTP status.

## 1.10 Persistence

`conversations` + `messages` (RLS-scoped, caller data plane). Each `/ask`
persists a user row and an assistant row in one multi-row insert (uniform keys).
The assistant row stores `label`, `sources` (provenance JSONB — each entry
carrying the verbatim chunk `excerpt`, D80), `model_ids`
(`answer_model`, `prompt`, `embedding`), and `timings` (retrieval/generation/
stage timings, tokens, grounded, and — when the checker runs —
`correctness_verdict`/`correctness_ms`). A persistence failure returns the answer
with `persisted: false` and a bounded error, never silently.

**Conversation context (H3A, D72).** Before clarification, `ask` reads at most
`CONTEXT_HISTORY_LIMIT = 4` recent messages of the verified conversation
(newest first) and summarizes them, in memory only, into: previous user
question (capped at 1000 chars), whether a prior message exists, and whether
the **most recent** assistant turn carries evidence chunk ids (`sources`).
Raw document text is never stored in or read by this layer; evidence is
identifiers/counts only. A deterministic pure classifier
(`_shared/follow-up-detector.ts`) labels the new message
STANDALONE / FOLLOW_UP / UNKNOWN and feeds **telemetry only** — H3A does not
let context alter the RAG path, and the clarification gate remains the
response authority (context is recorded alongside it, never a second
response). No history → continuation signals classify UNKNOWN (fail closed);
a full knowledge question stays STANDALONE regardless of history.

**Bounded follow-up rewrite (H3B, D73).** AFTER the empty-scope refusal and
BEFORE retrieval, a FOLLOW_UP whose query is not already self-contained may
spend **one** Mantle rewrite call (`rewrite-v1`, temperature 0, max 160
tokens, 12 s timeout, no retry): previous question delimited as data,
data-not-instructions rule last, output strictly validated. The validated
rewrite becomes the retrieval query only — the original user question stays
authoritative for the gate, generation, citations, and persistence, and it is
what `/ask` stores. Any failure/rejection falls back to the original query.
Telemetry records `context.rewrite` with measured-or-unknown tokens.

## 1.11 Ingestion

`ingest-pdf`: caller-JWT, membership-checked, tenant-path-validated
(`tenants/<tid>/…/*.pdf`). Pipeline: Storage download → `unpdf@1.8.1`
page-preserving extract → **1000-char chunks / 200-char overlap** →
`chunk_id = sha256("none-v1|<tenant_id>|<storage_path>|<page>|<content>")` →
batched `upsert(onConflict: chunk_id, ignoreDuplicates)` → delete stale chunk IDs
→ document left `pending`. Idempotent: same content → same IDs; a registration
race re-reads the winner; `retry` re-runs the pipeline; empty/scanned PDFs fail
loudly (no OCR).

Temporary chat files (D60; migration applied, deployed in `ingest-pdf` v35 /
`query-chunks` v31 / `ask` v39 / `storage-cleanup` v2; live-validated
2026-09-17): a temporary document is an ordinary `documents` row with `conversation_id` set (composite FK pins the same
tenant) and `expires_at` set (initial TTL 24 h); persistent ⟺ both NULL.
`ingest-temp` validates the conversation server-side and otherwise runs the
identical pipeline (all D47 limits apply, same worker, same chunk model);
`promote` clears both columns in place. Temporary scope columns are immutable
after registration except for the promotion-shaped clear (database trigger,
all roles).

`embed-worker`: pg_cron (every minute) → pg_net → worker with `x-worker-key`.
Per tick it claims one idle `processing` job via a compare-and-swap on
`attempts` and embeds in **bounded passes** (D48/D58/D65/D66): each pass sends
up to `REQUESTS_PER_TICK = 3` sequential Jina requests of up to
`CHUNKS_PER_REQUEST = 48` chunks / 48,000 chars with a 40,000 per-pass token
guard (~5 s uniform gaps within and across passes; a full two-pass invocation
fits inside ~50 s, so rolling-minute usage peaks near ~69K tokens vs the
100K TPM envelope of 100 RPM / 100K TPM shared with reranking). One invocation may run up to 2 passes over the SAME claimed job
(D66 continuation, ~110 s worst case) instead of waiting for the next cron
tick; per-batch results persist via bounded parallel single-row UPDATEs behind
the non-NULL guard (same predicates as the old sequential loop). The cron
claim idle (150 s) exceeds the worst-case invocation so the sweep never steals
a live job; the direct post-parse trigger bypasses the idle threshold.
A registration that just persisted chunks also triggers the worker directly
with the job id (same claim, same pass); the cron sweep remains the backstop.
A whole batch is validated (model exact, count exact, complete index mapping,
1024 finite dimensions) **before** any write — an invalid batch persists
nothing. Updates are non-NULL-only (`is("embedding", null)`). Document becomes
`ready` **only** when zero NULL embeddings remain; 429 stops the tick and
resumes next tick; fatal provider errors fail the job+document loudly.

Measured first-upload cadence (2026-09-17 audit + optimization, v34/v30):
registration answers in ~8–12 s for 9–60 chunks; the triggered worker claims
within seconds and embeds up to 36 chunks immediately, with further ticks on
the per-minute cron. Live upload→ready: 20 s (148 KB / 9 chunks), 195 s
(2.0 MB / 60 chunks); ~7 min projected for 226 chunks. Parsing is sub-second
locally for these sizes; the per-minute cadence plus the 36-chunks/min budget
is the remaining pacing, by design under the documented Jina envelope
(100 RPM / 100K TPM shared with reranking — see D58/D64).

## 1.12 Observability (bounded)

`/ask` responses (and the eval runner artifacts) carry bounded diagnostics:
`gate { verdict, reason, conflicting[] }`, `citation_guard { ok, reason }`,
`tripwire { reason, findings[], counts }`,
`correctness { invoked, verdict, invalid_reason, latency_ms, attempts,
output_chars, output_tokens }`, `timings { retrieval_ms, generation_ms,
citation_guard_ms, tripwire_ms, aggregation_ms, correctness_ms, persistence_ms,
total_ms }`, and `model { provider, model, prompt_version, temperature,
max_tokens, correctness_enabled }`. Logs are metadata-only — never keys, tokens,
vectors, or answer/evidence content.

## 1.13 Security boundaries

- No provider credential is ever browser-visible; no key in the repo or logs.
- Secret names (values never in repo/logs): `JINA_API_KEY`, `MANTLE_API_KEY`,
  `ANSWER_MODEL_ID`, `WORKER_CRON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SECRET_KEYS`/`SUPABASE_SERVICE_ROLE_KEY`, plus Vault secrets
  `embed_worker_url`/`embed_worker_key`.
- Tenant isolation is a DB predicate + RLS, not frontend discipline. Cross-tenant
  reads fail closed.
- Browser ↔ provider is forbidden by construction.

## 1.14 Failure behavior

Bounded and fail-closed: 400 (bad input), 401 (auth), 403 (membership),
404 (conversation/document), 429 (Mantle throttled), 500 (config/internal),
502 (provider/retrieval/citation failure). No open-ended loops, no autonomous
retries, no silent fallback, no model substitution, no answer generation on
INSUFFICIENT evidence. The only retries are: one checker transport retry, and the
Cron-driven embed-worker resume. Full audit: `eval/runs/diagnostic-3d2.md`.

## 1.15 Deployment state

- Supabase project ref `uqlpfgtkmsaexmtieulp`, region `ap-southeast-2`.
- AWS Bedrock Mantle region `ap-south-1`; Jina server-side.
- Deployed and ACTIVE (observed 2026-09-29 via `functions list`):
  `ingest-pdf` **v37**, `embed-worker` **v36** (+ per-minute Cron),
  `query-chunks` **v36**, `ask` **v51** (citation excerpts, D80),
  `storage-cleanup` **v4**.
- `CORRECTNESS_CHECKER_ENABLED` OFF. No other feature flag enabled.
- Bucket `company-documents` is private with `file_size_limit = 25 MiB`; the
  corpus grows through normal use.**Production snapshot (2026-09-17):** 2
  documents — `incometax.pdf` (78 pages, 433,795 B, `ready`) and
  `Thrine Sales SOP (1).pdf` (7 pages, 160,516 B, `ready`, uploaded through the
  UI after the Pass C fix) — **239 chunks**; 1 notebook (`test`) with one
  selected source; both ingest jobs `succeeded`. Six Storage objects have no
  document row (the long-standing `phase3c2` orphan, four pre-fix uploads run by
   a user, and one object left by a diagnostic in a since-deleted test tenant) —
   see `eval/runs/pre-pass-e-state-sync.md`. Corpus note (observed, not a
   census, 2026-09-29 smoke tests): the workspace now holds 4+ ready documents
   (SEBI AIF Regulations 2012, Income_Tax_Act_2025 as amended, incometax.pdf,
   Applicability of section 56 to rights issue).
- The B-series work (D46–D52) is applied, deployed and committed (`7b4f4fe`
  and later). Current HEAD and working-tree state live in `SESSION_HANDOFF.md`
  §9, not here — do not treat any hash in this section as current.
- **Versions and state in this section are a dated snapshot, not a guarantee.**
  Re-verify with a harmless authenticated read (e.g. `supabase functions list`,
  `supabase projects list`) before any deployment, migration or mutation —
  never act on this section alone (D59).

## 1.16 Post-lock additive capabilities (B1–B6)

These extend the locked V1 chain without changing it; each is a durable decision
in `DECISIONS.md` Part 4 and a validated report under `eval/runs/`.

- **Upload safety (D47, migration `20260917000000`)** — `documents.file_size`
  (backfilled from Storage metadata) plus server-enforced limits in
  `ingest-pdf`: 25 MB per file, 400 MB per workspace, 60 active documents,
  20,000 chunks, at most 1 processing + 3 pending jobs, duplicate rejection by
  extracted-content hash. Rejections are 413/507/409 and write nothing.
- **Batched embedding (D48)** — see §1.11.
- **Notebook model (D49, migration `20260917000002`)** — `notebooks`,
  `notebook_sources` (`selected`, composite tenant-pinned FKs),
  `documents.archived_at`; member-scoped RLS mirroring `documents`.
- **Notebook-scoped retrieval (D50, migration `20260917000003`)** — the only
  retrieval change: an allowed-document filter. `/ask` resolves a notebook's
  selected, non-archived, same-tenant documents server-side and passes them to
  `/query-chunks`; an empty scope refuses deterministically with no retrieval
  call and no LLM. Unscoped calls are bit-identical to pre-B2 behaviour.
- **Storage cap (D51, migration `20260917000001`)** — bucket `file_size_limit`
  lowered to 25 MiB, matching the application policy.
- **Orphan cleanup (D52, `storage-cleanup` v1)** — enumerate one tenant's prefix,
  classify (valid / too_young / active / orphan / unsafe), delete only confirmed
  orphans older than 24 h that are unreferenced, bounded and idempotent;
  dry-run for members, apply for owner/admin; no service_role.
- **Temporary chat files (D60, migration `20260917000004` applied; deployed
  in `ingest-pdf` v35 / `query-chunks` v31 / `ask` v39 / `storage-cleanup`
  v2; live-validated 2026-09-17)** — conversation-scoped temporary rows in
  `documents` reusing jobs/chunks/worker/retrieval/`delete-document`;
  retrieval-time expiry is the access boundary, cleanup is hygiene-only
  (`expired_temp_documents` section in `storage-cleanup`, bounded, via the
  `delete-document` primitive); no separate subsystem. Unscoped retrieval
  excludes temporary rows whenever any exist (else legacy NULL path).
- **Jina embedding stack (D64, migration `20260918000001` applied)** —
  production embeddings moved Voyage-4 → `jina-embeddings-v5-text-small`
  (`retrieval.passage` documents / `retrieval.query` questions, 1024-dim,
  normalized) with `jina-reranker-v3.5` over the fused pool; `chunks.embedding`
  keeps its shape/index, Voyage vectors preserved in `embedding_voyage` for
  rollback; retrieval constants, gate, prompts and generation unchanged.
- **Pre-UI regression** — full 34-case frozen harness: retrieval bit-identical to
  the frozen baseline, gate/label reproduce the latest chain measurement,
  `unscoped == full-corpus scope` on 34/34, PASS
  (`eval/runs/pre-ui-regression-34-20260917.md`).

---

# Part 2 — Historical record (SUPERSEDED)

> **Everything below this line is the original pre-implementation analysis dated
> 2026-09-14, kept for history only.** It is NOT the current architecture.
> Superseded references include: Bedrock **Converse/InvokeModel/Titan V2**
> (production generation is now **Mantle Chat Completions**), AWS **SigV4/IAM
> answer keys** (now a Mantle Bearer secret), **Bedrock Rerank V1.5**
> (not shipped), the streaming/SSE and one-corrective-retrieval flow (not
> implemented), placeholder calibration/"small k"/threshold language (now the
> locked 20/20 + RRF-60 + k=8), "no tables/Edge Functions created" (all exist),
> and the reference-repository list (RAGFlow, OpenViking, ruflo, etc. are
> **rejected and must never be revisited** as implementation references).
> See Part 1 for the current system.

## Amendment — Phase 2C: Voyage 4 embedding contract (2026-09-14)

Active V1 embedding provider is **Voyage AI `voyage-4`** (1024-dim float,
`input_type: "document"` for corpus / `"query"` for queries, `VOYAGE_API_KEY`
Edge secret, server-side only; full contract in `DECISIONS.md` D17). Bedrock
Titan V2 was evaluated and is **blocked** by account-level authorization
(`NOT_AUTHORIZED`) — it is not the active provider. Bedrock remains for the
answer LLM (+ rerank V1.5). Titan references elsewhere in this analysis record
are historical.

---

## 1. Executive summary

**Selected architecture: A — Supabase + Edge Functions + Bedrock. No EC2. No separate
traditional backend unless Edge Function limits are proven blocking. No local/self-hosted
ML anywhere.**

```text
Browser (Supabase Auth + signed Storage flows; never touches Bedrock or Voyage)
  ↓ HTTPS / Supabase JS client
Supabase
├── Auth (users, JWTs; sole identity source)
├── Storage (private buckets; originals only)
├── PostgreSQL + RLS (system of record: tenants, documents, chunks, conversations)
│   ├── pgvector HNSW (dense retrieval, cosine)
│   └── PostgreSQL FTS tsvector + GIN (keyword retrieval)
└── Edge Functions (Deno; the ONLY server-side execution layer in V1)
    ├── auth-verified request handling, rate limiting
    ├── Voyage embeddings (ingestion + query embedding)
    ├── tenant-filtered hybrid retrieval (single SQL path)
    ├── optional Bedrock Rerank (V1.5, flag-gated)
    ├── Bedrock LLM generation (Converse/InvokeModel, temperature 0.0, streamed)
    └── deterministic grounding checks + provenance assembly
              ↓ (server-side only; Bedrock IAM keys + VOYAGE_API_KEY in Edge secrets)
         Voyage AI                       Amazon Bedrock
         └── voyage-4 (1024-dim,         ├── LLM (Converse-compatible answer model)
             document/query)             └── rerank (Rerank API, e.g. Cohere Rerank 3.5;
                                              V1.5 only)
```

Why this wins:

- Every hard problem of the old system (913 MB EC2 OOM, co-loaded MiniLM + cross-encoder,
  SSH tunnels, Streamlit without auth/HTTPS, private RDS reached via forwarded ports,
  dead Converse entitlement worked around via Mantle token generator) disappears by
  deleting the EC2 tier rather than fixing it.
- Supabase already provides the managed pieces the old system hand-built badly:
  Auth, private Storage with RLS, Postgres with pgvector + FTS, and a serverless
  execution layer (Edge Functions) with enough headroom for orchestration + Bedrock calls.
- Bedrock already provides the managed ML pieces the old system ran locally:
  embeddings (Voyage voyage-4) and rerank (Bedrock Rerank API). There is no reason to run
  `all-MiniLM-L6-v2` or `ms-marco-MiniLM-L-6-v2` in the serving path ever again.
- Complexity is evidence-gated. V1 is: private multi-tenant corpus → hybrid
  retrieve (small k) → grounded generation with citations → conversation persistence.
  Everything else (rerank, decomposition, LLM reviewer, workflows) must beat that
  baseline on the ported golds before it ships.

**EC2 required? No.** There is no step in V1/V1.5 that needs a persistent VM.
The only credible threat to a pure Edge Functions design is large-PDF parsing under
Edge Function resource limits (256 MB, ~2 s CPU per request, 150 s response timeout,
400 s wall clock on paid plans — all verified in current Supabase docs; see §14 and
§21). The prescribed fallback is a **stateless async parse worker (AWS Lambda or a
minimal container job), still no EC2**, and only if Deno-side parsing is measured
inadequate. EC2/systemd/tunnels must never return.

---

## 2. Proposed architecture

### 2.1 Tiers and trust flow

| Tier | Runs | Trust |
|---|---|---|
| Browser SPA | UI, Supabase Auth session, upload/download via signed flows, renders streamed answers + citations | Untrusted input; holds only the user's Auth JWT (publishable key). Never sees service-role key, AWS keys, Voyage key, other tenants' data, Bedrock, or Voyage |
| Supabase Auth | Identity, JWTs (`auth.uid()`, `app_metadata`), session lifecycle | Trusted identity source |
| Supabase Storage | Original PDFs/objects in private buckets, tenant-namespaced prefixes | Private by default; access only via RLS + signed URLs / Edge Function mediation |
| Supabase PostgreSQL | Tenants, memberships, documents, chunks (+`vector`, +`tsvector`), conversations, messages, jobs/quotas | System of record; RLS enforced on every table; `service_role` bypass only inside Edge Functions |
| Edge Functions | All orchestration + all Bedrock/Voyage calls | Only tier holding Bedrock/Voyage credentials (Supabase secrets); validates JWT, enforces tenant scope + rate limits on every call |
| Voyage AI | Embeddings (`voyage-4`, 1024-dim float, document/query input types) | Called server-side only via `VOYAGE_API_KEY` Edge secret; no storage, retrieval, or authorization |
| Bedrock | LLM, rerank | Called server-side only; least-privilege IAM (InvokeModel/Rerank on named models only) |

### 2.2 Backend comparison (A vs B vs C)

**A. Supabase + Edge Functions + Bedrock — SELECTED.**

- Fits: auth-verified CRUD, signed upload flows, chunked ingestion orchestration,
  single-SQL hybrid retrieval, Bedrock `InvokeModel`/`Converse`/`Rerank` calls
  (all async I/O, which is exactly what Edge Functions are good at; CPU limit is
  ~2 s per request but retrieval/generation are I/O-bound, not CPU-bound).
- Streaming answers: Edge Functions support streamed responses; long generations
  must be designed around the 150 s response timeout (honest staged UI, bounded
  context, no unbounded repair loops).
- No servers to patch, no SSH, no systemd, no tunnel-related outages.

**B. Supabase + separate lightweight backend (e.g. Cloud Run / Fly / Render) — REJECTED for V1, kept as a named fallback.**

- Concrete trigger to reconsider: measured proof that (a) Deno PDF parsing cannot
  handle the real document distribution within limits, AND (b) a queued async
  design (Storage → DB job row → Edge Function chunked processing) still cannot
  fit, AND (c) a single-purpose Lambda/Cloud Run parse job is insufficient.
- A general-purpose app server is not justified by "comfort" or framework
  preference. If B ever happens, it must own *only* what Edge Functions provably
  cannot do (almost certainly just document parsing), not the whole API.

**C. Supabase + EC2 + Bedrock — REJECTED.**

- This is the old failure mode (OOM wedge on `t3.micro`, manual reboots, no
  operator access guarantee, Streamlit without auth/HTTPS, reverse tunnels).
- No capability in §§5–8 needs a persistent VM. Choosing C would reintroduce
  operational load with zero retrieval/quality benefit.

---

## 3. Architecture diagram

```text
┌─────────┐   Supabase Auth JWT    ┌──────────────────────────────────┐
│ Browser │ ─────────────────────▶ │            SUPABASE              │
│   SPA   │ ◀───────────────────── │                                  │
└─────────┘   streamed SSE + JSON  │  Auth ── JWT (auth.uid)          │
    │                              │  Storage (private buckets)       │
    │ signed upload/download       │    tenants/<tid>/docs/<doc>      │
    └─────────────────────────────▶│  Postgres + RLS                  │
                                   │    tenants, memberships          │
                                   │    documents, chunks             │
                                   │      embedding vector(1024)      │
                                   │      content_tsv tsvector + GIN  │
                                   │      HNSW cosine index           │
                                   │    conversations, messages       │
                                   │    ingest_jobs, usage counters   │
                                   │  Edge Functions (Deno, secrets)  │
                                   └──────────────┬───────────────────┘
                                   │ SigV4 / Bearer key, server-side only
                                   │ Voyage embeddings /
                                   │ Bedrock InvokeModel / Converse / Rerank
                                   ▼
                                   ┌──────────────────────────────────┐
                                   │            VOYAGE AI             │
                                   │  voyage-4 (1024-dim, float;      │
                                   │   document / query input types)  │
                                   ├──────────────────────────────────┤
                                   │         AMAZON BEDROCK           │
                                   │  Answer LLM (Converse API)       │
                                   │  Rerank API (V1.5, flag-gated)   │
                                   └──────────────────────────────────┘
```

Data never flows Browser → Bedrock or Browser → Voyage directly. Storage
originals never flow to Bedrock or Voyage except as server-extracted,
tenant-scoped chunk text inside an Edge Function. Embeddings flow Voyage →
Edge Function → Postgres. Chunks flow Postgres → Edge Function → Bedrock LLM
inside a bounded prompt.

---

## 4. Component responsibilities

| Component | Owns | Explicitly does NOT own |
|---|---|---|
| Browser | Login, tenant switching UI, document upload UX, chat UX, citation rendering, export/copy | Any credential beyond its own JWT; any Bedrock/Voyage call; any cross-tenant read; any embedding |
| Supabase Auth | Users, sessions, JWT claims, password/MFA/oauth per project config | Document/tenant authorization logic beyond identity (that lives in RLS + memberships) |
| Supabase Storage | Durable originals; tenant-prefixed keys; versioning/server-side encryption per bucket policy | Text extraction, chunking, embeddings, search (those read Storage, write Postgres) |
| PostgreSQL | All metadata + text + vectors; hybrid search SQL; RLS; transactional ingest/delete; conversation history; jobs/quotas | ML inference; PDF rendering; long-lived compute |
| pgvector HNSW | Approximate dense retrieval (`vector_cosine_ops`, iterative scan aware) | Authorization (always combined with tenant predicate); exact recall guarantees |
| PostgreSQL FTS | Keyword retrieval (`to_tsvector('english', content)` STORED + GIN, `plainto_tsquery`/`ts_rank_cd`) | Semantic matching; language analysis beyond the configured dictionary (needs a decision for non-English corpora) |
| Edge Functions | JWT validation, rate limits, ingestion orchestration, query embedding, hybrid SQL, optional rerank, generation + streaming, deterministic checks, provenance | Persistent local state; local ML models; direct DB access bypassing RLS except via `service_role` with explicit tenant predicates |
| Voyage embeddings | chunk text → vector (`voyage-4`, 1024-dim float; `document` for corpus, `query` for queries) | Storage, retrieval, authorization |
| Bedrock LLM | `evidence + question → grounded draft` only (temp 0.0, bounded tokens) | Retrieval, citation invention, tool execution, planning authority (its output is untrusted until deterministic guards pass) |
| Bedrock Rerank | `query + candidates → relevance order` (V1.5) | First-stage recall; authorization |

Framework rule (from the reference-repo lesson): do not add LangGraph / LlamaIndex /
RAGFlow / agent frameworks to get this. The pipeline is a short deterministic
sequence with at most one bounded correction. A framework would add dependency and
ops surface with no measured quality gain.

---

## 5. Request/query flow

V1 query path (all inside one Edge Function invocation, e.g. `POST /query` + SSE stream):

```text
1. Browser → Edge Function with Auth JWT + {conversation_id, question}
2. Edge Function: validate JWT, resolve tenant_id via membership (DB, not JWT claim
   alone when immediate revocation matters), check rate limit/quota
3. Intent gate (deterministic, no LLM): greeting/capability/out-of-scope → canned
   reply without retrieval (port of query_router intent observer idea)
4. Embed question server-side via Voyage voyage-4 (`input_type: query`;
   same model+dim as the corpus — never browser-embedded)
5. Tenant-filtered hybrid SQL (single round trip):
     dense candidates (HNSW, ORDER BY embedding <=> query, tenant predicate)
     UNION keyword candidates (FTS @@ plainto_tsquery, tenant predicate)
     → RRF / weighted fusion in SQL → top-k (k=5 to start, recalibrated)
   Always carries tenant_id = caller tenant. No unscoped reads.
6. Deterministic pre-generation verdict (port of evidence_verification core):
   SUPPORTED / INSUFFICIENT / CONFLICTING / UNSUPPORTED using normalized term/number
   matching. UNSUPPORTED → contextual refusal, no LLM call. Empty → low-relevance
   fallback text (same contract as the old system).
7. Bounded correction (at most ONE): only if verdict is INSUFFICIENT/CONFLICTING
   with an exact-matchable anchor (number/quoted span) → one focused corrective SQL
   search → merge with provenance (retrieval_round 1/2, cap ~10) → re-verify → STOP.
8. Generation: Bedrock Converse with frozen grounded prompt (DIRECT vs PARTIAL
   templates), temperature 0.0, bounded max tokens, evidence block with
   [file p.N] labels. Stream tokens via SSE; strip hidden reasoning server-side.
9. Deterministic post-check (lightweight V1 tripwire, port of groundedness core):
   numbers/qualifiers/negations in the draft must appear in the cited evidence.
   On failure: downgrade label to Partial + "unverified against sources" note.
   No silent regeneration loops in V1 (one constrained repair only in V1.5+ and
   only if measured useful).
10. Persist {question, answer, label, chunk citations, scores, timings, model ids}
    to messages; return answer + structured sources {file_name, page, score,
    chunk_id, document_id} to the browser. Citations are never dropped.
```

Bounds that prevent the old system's failure modes: max 1 corrective retrieval,
max 1 repair generation, no planner-controlled k/threshold/scope/prompts, no
reviewer that can rewrite freely, total response bounded by the 150 s Edge timeout
with honest progress states.

---

## 6. Document ingestion flow

```text
Browser (authenticated, tenant-selected)
  → create document row (status=pending) via Edge Function (validates type/size/quota)
  → direct-to-Storage upload (signed upload URL, tenant-prefixed key) or
    Edge Function mediated upload for small files
  → Storage event / explicit finalize call creates ingest_jobs row
  → Edge Function ingest worker (async, chunked, idempotent):
       download object server-side (service_role, tenant-checked)
       → extract text per page (PDF parser; see §21 open question on Deno libs)
       → split RecursiveCharacterTextSplitter-equivalent (1000/200 to start;
          preserves page numbers)
       → content-hash chunk_id (hash includes tenant_id + embedding model id/version)
       → Voyage voyage-4 batch embed (server-side, `input_type: document`,
          throttled by Voyage rate limits)
       → INSERT chunks (ON CONFLICT DO NOTHING) + FTS column auto-maintained
       → mark document ready; record counts + failures per file
  → browser polls/subscribes to document status; failures are per-file explicit
```

Key properties (ported from what actually worked):

- Additive, idempotent re-index: same content → same chunk IDs → no duplicates.
- Per-file error reporting (`found/succeeded/failed`, failed filenames + reasons).
- Zero-text detection: scanned-image PDFs with no extractable text fail loudly with
  "no usable text / OCR not enabled" rather than indexing empty rows (OCR stays out
  of V1; see §19).
- Originals in Storage are never mutated by indexing; vector delete never deletes
  the original unless an explicit document-delete action also removes the object.
- Updates = new content hash → new chunks + delete of stale `document_id` rows in
  one transaction. Deletes = `DELETE FROM chunks WHERE tenant_id AND document_id`
  + Storage object removal + conversation citations left intact historically (they
  point at immutable chunk snapshots or show "source removed").

Async design note: large documents must not block the upload response. Use a
`ingest_jobs` table (or Supabase Queues/pg_cron if available in the chosen project)
so the Edge Function can process pages/batches across invocations. This is the
approved answer to Edge Function CPU/time limits — not a persistent server.

---

## 7. Retrieval pipeline

V1: **tenant-filtered hybrid dense + keyword in PostgreSQL, no local models.**

```sql
-- Concept (single function/RPC, tenant predicate on every branch):
-- dense:  SELECT ... ORDER BY embedding <=> :qvec  WHERE tenant_id = :tid LIMIT :n
-- lexical:SELECT ..., ts_rank_cd(...) WHERE content_tsv @@ plainto_tsquery(...) 
--           AND tenant_id = :tid LIMIT :n
-- fuse with RRF (k=60) or min-max weighted blend; deterministic tie-break by chunk_id
-- return top-k with provenance (dense_rank, lex_rank, fused_score, retrieval_round)
```

- Dense: Voyage voyage-4 1024-dim float, `vector_cosine_ops` HNSW (`m=16`, `ef_construction=64`
  starting point — the old values remain sane defaults; tune `ef_search` per workload).
  Enable/verify `hnsw.iterative_scan` behavior for selective tenant filters
  (verified available from pgvector 0.8.0; Supabase docs confirm the GUCs).
- Lexical: generated `content_tsv` + GIN (exactly the proven shape from
  `postgres_vector_store.py`: `GENERATED ALWAYS AS (to_tsvector(...)) STORED`,
  backfills existing rows, stays in sync on insert).
- Fusion: RRF preferred over hand-tuned weights (fewer knobs, proven in RAGFlow-style
  hybrids); deterministic ordering `(-fused, chunk_id)`.
- Multi-form query: keep the cheap deterministic forms (normalized + content-core,
  max-pooled) from `backend.build_query_forms`. Do NOT port LLM rewriting or the
  rejected synonym form (measured worst in the old system).
- `k` and threshold: do NOT blindly keep `k=5, threshold 0.3`. Those numbers were
  calibrated for MiniLM-384 cosine scores. Voyage-1024 score distributions differ.
  Recalibrate on the ported golds before freezing; store them as config, not code.
- Session uploads: no separate `scope/session_id` overlay in V1. Either (a) session
  files become first-class tenant documents with lifecycle, or (b) a narrow
  `session_id` column is added later with the same one-shape predicate
  (`tenant AND (persistent OR session=current)`). Do not pay the complexity cost
  until a real UX need demands ephemeral uploads.

What V1 deliberately excludes: local cross-encoder rerank, LLM query planning,
two-hop traversal, source routing, comparison/summary workflow runners. See §19.

---

## 8. Generation/grounding pipeline

- Prompt contract (ported): answer ONLY from provided context; exact-match fallback
  sentence when evidence is absent; PARTIAL template that states what IS established,
  marks the rest unknown, and offers only search directions (never claims unseen
  sections exist). Prompts are frozen strings with version IDs; changes require
  re-running the gold suite.
- Temperature 0.0 for answers. Bounded output tokens. Model ID from config/secrets
  (e.g. `ANSWER_MODEL_ID`), never hardcoded, never silently substituted — unknown
  model failures raise honest errors (ported invariant from `llm_provider.py`).
- Citation guard (ported): every factual sentence should trace to ≥1 cited chunk;
  citations `{file_name, page, chunk_id, score}` preserved exactly through streaming;
  think/reasoning blocks stripped server-side before streaming (ported from
  `output_safety.py`); empty/reasoning-only output mapped to an explicit message.
- Clarification (ported, precision-fixed): at most one deterministic clarification
  when evidence is PARTIAL with genuinely missing terms (old Step-14 rule: clarify
  only if ≥50% terms missing or user words ungrounded). No LLM-generated
  clarifications, no loops — confirmations resolve to the original question.
- Verification placement: deterministic pre-generation verdict gates the LLM call
  (saves cost + prevents hallucination on empty evidence); lightweight post-generation
  tripwire downgrades labels. LLM-as-judge reviewer stays out of V1 (see §19).

---

## 9. Data model concept

No tables are created by this task. Concept only; exact DDL is an implementation phase.

```text
tenants (id uuid PK, name, created_at, ...)
memberships (tenant_id FK, user_id FK→auth.users, role owner|admin|member|viewer,
             UNIQUE(tenant_id,user_id), INDEX(user_id,tenant_id))
documents (id uuid PK, tenant_id FK, file_name, storage_path, page_count,
           status pending|ready|failed, content_hash, embedding_model, created_by,
           created_at, ...)
chunks (chunk_id TEXT PK, tenant_id FK, document_id FK, file_name, page INT,
        content TEXT NOT NULL, embedding vector(1024) NULL (NULL until the embedding phase backfills),
        content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english',content)) STORED,
        created_at, ...)
  INDEX HNSW (embedding vector_cosine_ops), INDEX GIN (content_tsv),
  INDEX (tenant_id, document_id)
conversations (id uuid PK, tenant_id FK, user_id FK, title, created_at, ...)
messages (id uuid PK, conversation_id FK, tenant_id FK, role user|assistant|system,
          content TEXT, label DIRECT|PARTIAL|..., sources JSONB (chunk refs),
          model_ids JSONB, timings JSONB, created_at, ...)
ingest_jobs (id uuid PK, tenant_id FK, document_id FK, status, attempts,
             last_error, created_at, updated_at, ...)
usage_counters (tenant_id, window, queries, tokens_in/out, embeds, reranks, ...)
```

Notes:

- `tenant_id` is denormalized onto every RAG row (chunks, documents, conversations,
  messages, jobs). RLS then stays a cheap indexed equality check instead of a JOIN.
- `chunk_id` = hash(content + page + file identity + embedding model id). Changing
  the embedding model yields disjoint IDs — prevents silent mixing of MiniLM-384
  rows with voyage-4/1024 rows. Old 384-dim data is NOT migrated by reinterpreting
  vectors; it is re-embedded or discarded (decision before coding: start empty).
- `sources JSONB` on messages is the provenance record: chunk_id + document_id +
  file_name + page + score + retrieval_round + embedding/LLM model ids. Never stores
  secrets or other tenants' text.
- Storage keys: `<bucket>/tenants/<tenant_id>/docs/<document_id>/<filename>`.
  Never trust browser filenames as identities (ported 5C rule).

---

## 10. Security model

| Concern | Design |
|---|---|
| RLS | Enabled on every table including `storage.objects` policies. Policies use `to authenticated` + `(select auth.uid())` + membership helper (`security definer`, `set search_path=''`, `STABLE`). No anon reads of company data. Verified against current Supabase RLS docs |
| Storage policies | Buckets private by default. Upload/download/select policies scoped by `bucket_id` + tenant prefix + membership. Downloads via authenticated `object/authenticated/...` or short-lived signed URLs minted server-side. Originals never public |
| service-role boundary | `service_role` key lives ONLY in Edge Function secrets. Never shipped to the browser, never prefixed `NEXT_PUBLIC_`/Vite-public, never logged. Browser uses publishable key + JWT. Any leak = full tenant bypass (called out in Supabase docs) |
| Bedrock credentials | AWS IAM access keys (or short-lived STS) stored as Supabase Edge Function secrets. Least privilege: `bedrock:InvokeModel` + `bedrock:Rerank` on named model ARNs only, pinned region. No `.env` secrets in the repo; no browser calls to Bedrock ever |
| Voyage credentials | `VOYAGE_API_KEY` stored as a Supabase Edge Function secret, server-side only. No Voyage key in the repo, logs, or commits; no browser calls to Voyage ever |
| Browser ↔ Bedrock | Forbidden. All Bedrock traffic is Edge Function → Bedrock with SigV4 (AWS SDK v3 in Deno). This also keeps model IDs, prompts, and evidence server-side |
| Browser ↔ Voyage | Forbidden. All Voyage traffic is Edge Function → Voyage API with the secret key. Chunk/corpus text stays server-side |
| Chunk authorization | Every retrieval branch carries `tenant_id = caller tenant`. `chunks_for_source`/list-sources helpers carry the same predicate. Application-level filtering alone is insufficient; the DB predicate is the enforcement point |
| Revocation | Membership reads are live DB lookups (not JWT-claim-only) so removal takes effect immediately. If a JWT-cached tenant claim is ever added for speed, revocation semantics must be re-decided explicitly |
| Abuse/rate limiting | Per-user + per-tenant quotas in Edge Functions (token bucket / sliding window in Postgres), upload size/count caps, ingest concurrency caps, max output tokens, SSE timeout. Public signup (if any) starts closed/invite-only |
| Secrets management | Supabase project secrets for Edge Functions; AWS IAM user per environment (dev/prod separated); rotation runbook; no secrets in logs/telemetry (metadata-only telemetry rule ported from Phase 5) |
| Prompt/injection hygiene | Planner/reviewer outputs (when they exist) treated as untrusted input to deterministic validators; retrieved evidence is grounding-trusted but never executed; suggested follow-ups re-validated before any retrieval |

---

## 11. Multi-tenant/company isolation

- Hierarchy: `tenant (company) → users (memberships with roles) → documents/chunks → conversations/messages`.
- Isolation mechanism: `tenant_id` column + RLS membership check on every table +
  tenant-prefixed Storage keys + tenant predicate in every search branch (dense,
  lexical, top-up, list, delete). Cross-tenant reads must be impossible by
  construction of the SQL, not by frontend discipline.
- Roles: `owner | admin | member | viewer`. V1 needs at minimum member vs admin
  (who can upload/delete vs ask). Owners manage memberships. Enforce in RLS, not
  just UI gating.
- Session uploads: V1 treats uploads as tenant documents (simplest correct model).
  Ephemeral per-session scoping is deferred; if added, it reuses the proven one-shape
  predicate extended with tenant: `tenant_id=:tid AND (scope='persistent' OR
  (scope='session' AND session_id=:sid))`.
- Tenant switching UX passes an explicit tenant id that the Edge Function
  re-validates against memberships; the JWT alone is not trusted for "which company".
- Tests that must exist before launch: cross-tenant retrieval returns zero rows,
  cross-tenant Storage signed URL fails, revoked member loses access immediately,
  service-role key absent from all client bundles.

---

## 12. Session/conversation state

- Server-side persistence (unlike the old in-memory + localStorage snapshot):
  `conversations` + `messages` rows under RLS. Browser holds only the active
  conversation id + Auth session.
- Bounded memory for generation: last N turns (e.g. 3, ported from
  `conversation_memory.py`) + topic-anchored follow-up expansion for retrieval;
  greetings/out-of-scope never contaminate retrieval anchors; assistant text is
  never retrieval evidence.
- Restore/new-chat: `New chat` starts a new conversation id (old vectors/docs
  untouched); refresh rehydrates from the DB; no paste-a-backup restore flow.
- Token/cost control: history window is bounded and truncated server-side before
  prompt assembly; full transcripts never sent to planner/reviewer equivalents.

---

## 13. Scaling strategy

| Stage | Shape | First bottlenecks to watch |
|---|---|---|
| 10 users, 1–3 companies | Smallest Supabase project + on-demand Bedrock. Single HNSW + GIN, no read replicas | None structural; watch PDF-parse edge cases and prompt size |
| 50 users | Same project, larger Postgres compute if pgbouncer/connection or embedding-insert throughput lags. Ingest queue depth monitored | Voyage embedding rate limits; Edge Function concurrency on bulk uploads; HNSW recall under tenant filters (enable iterative scan tuning) |
| 200 users | Supabase Pro/Team compute upgrade path (Micro → larger, PITR + backups verified). Separate ingest vs query Edge Functions. Usage counters → per-tenant quotas | DB connections (pooling), storage egress, LLM latency/cost (prompt caching, bounded evidence), rerank spend if enabled |
| 1,000 users | Read scaling (replicas for search), partitioned/capped message history, per-tenant ingest parallelism, provisioned Bedrock throughput only if on-demand throttles persistently | Cross-tenant noisy-neighbor (quotas + statement timeouts), vector index build time on bulk loads (`CONCURRENTLY` discipline), support/deletion SLAs |

Scaling principles: stateless Edge Functions scale horizontally by construction;
Postgres scales vertically first (Supabase compute tiers Micro→16XL) then via
replicas/partitions; Bedrock scales via quotas → quota increases → provisioned
throughput only with sustained load. No EC2-shaped step anywhere on this path.
The old `t3.micro` OOM class of failure is structurally absent (no local models).

---

## 14. Cost considerations

Rough, order-of-magnitude only (verify against live AWS + Supabase pricing before
budgeting; model prices move). Major drivers: **LLM output tokens ≫ LLM input
tokens ≫ rerank queries ≫ embeddings ≫ Supabase compute/storage**.

Reference rates verified during analysis (2026, us-east-1-ish on-demand):

- Embeddings (Voyage voyage-4): per-token API pricing — verify live Voyage rates
  before budgeting. At pilot scale (hundreds of docs, hundreds of Q/mo) embedding
  spend is negligible next to LLM output tokens. Negligible ongoing per query
  (queries embed tens of tokens).
- LLM: Nova Micro ~$0.035 in / $0.14 out per 1M; Haiku-class ~$1 / $5; Sonnet-class
  ~$3 / $15. Model choice dominates the bill (285× spread). Start cheap, upgrade
  only on measured gold improvement.
- Rerank (Cohere 3.5 via Bedrock): ~$2 / 1,000 queries (each ≤100 chunks). Only if
  V1.5 proves worth.
- Supabase: project compute (tiered) + DB size + bandwidth + Edge Function
  invocations. Predictable base + usage slope; no GPU/VM line items.

| Profile | Assumed load | Expected shape |
|---|---|---|
| Very small (pilot, 1 company, <10 users, hundreds of docs, hundreds of Q/mo) | Base Supabase project + near-zero Bedrock | Single-digit to tens of USD/mo. Embeddings cents. LLM cents–dollars on a cheap model. Supabase base is the bill |
| Small company (tens of users, thousands of docs, thousands of Q/mo, 2–5K tokens evidence/query) | Pro-tier Supabase + on-demand Bedrock | Tens to low-hundreds USD/mo. LLM input+output dominates; rerank off; storage trivial |
| Moderate company (hundreds of users, tens of thousands of docs, tens of thousands of Q/mo) | Larger Supabase compute + quotas + possibly prompt caching | Hundreds to low-thousands USD/mo depending almost entirely on answer-model choice and evidence size. Switching Haiku→Sonnet or doubling evidence tokens moves the bill more than all infra combined |

Cost controls (V1): cheap default answer model, bounded evidence (k + char caps),
temperature-0 short answers, no per-query planner/reviewer calls, no rerank by
default, per-tenant quotas, evidence caching for repeated questions, batch embedding
on ingest. Never optimize by lowering the relevance threshold (ported invariant).

---

## 15. Failure modes and recovery

| Failure | Behavior | Recovery |
|---|---|---|
| Bedrock throttling/5xx | Honest error + retry with backoff (idempotent reads); ingest jobs retry with attempts cap; queries never silently substitute another model | Quota increase request; cache; reduce evidence size; provisioned throughput only if sustained |
| Bedrock entitlement (model not enabled) | Loud configuration error naming model+region (ported `bedrock-mantle` lesson: never route around it silently) | Enable model access / fix `ANSWER_MODEL_ID` / use in-region model |
| Edge Function timeout (150 s response) | Streamed partial answer + "still working" state; ingest continues async via jobs | Bound evidence/tokens; split ingest into chunks; never add unbounded repair loops |
| Large/corrupt PDF | Per-file failure row, original retained, other files unaffected | Fix/replace file; re-run single-document ingest (idempotent) |
| Empty/scanned PDF | Explicit "no usable text / OCR not enabled" status | OCR decision deferred to Later (see §19); never index empty chunks |
| Tenant revocation mid-session | Next request fails closed (live membership lookup) | Re-login / switch tenant |
| Bad/poisoned chunk (wrong tenant, PII) | Targeted `DELETE WHERE tenant+document`, re-embed affected docs, audit messages citing it | Point-in-time recovery + Storage versioning if bucket versioned |
| Supabase outage | Degraded honest status (KB unavailable message, same contract as old `get_status`) | Backups/PITR per project tier; no local fallback that bypasses RLS |
| Score/threshold miscalibration after embedding change | Gold suite fails loudly before release | Recalibrate k/threshold on ported golds; never ship with MiniLM numbers |

---

## 16. What we preserve from RAG-4i-Cloud

Port the ideas, not the code (the stack changes too much for line ports):

1. Hybrid dense+FTS fusion shape + HNSW discipline (`vector_cosine_ops`, GIN on a
   STORED generated `tsvector`, deterministic fusion ordering) — from
   `postgres_vector_store.py`.
2. Deterministic evidence verification verdicts + at most one corrective round
   with provenance (`retrieval_round`, cap) — from `evidence_verification.py`.
   Fail-open, bounded, no loops.
3. Lightweight deterministic groundedness tripwire (numbers/qualifiers/negations) —
   from `groundedness.py`. Post-generation label downgrade, not a rewrite engine.
4. Bounded planner shape with constraint preservation + silent DIRECT fallback —
   from `query_plan.py`. V1 runs it in its cheapest deterministic form only.
5. Clarification-gate precision rule (clarify only on genuinely missing coverage) +
   grader normalization (numbers, possessives, boundary matching) — from
   `answer_support.py` + `beb6695`.
6. Bounded fan-out + provenance merge shape (≤3, round-robin, cap) — design kept,
   wiring deferred to V1.5+ (from `evidence_fanout.py`).
7. Tenant/session isolation as a DB predicate, frozen-prompt grounding contract,
   additive/idempotent ingestion, per-file ingest reports, metadata-only telemetry,
   explicit-model-failure rule (never silently substitute).
8. Evaluation assets as acceptance gates: `scenarios_v1.json`, `cases_m.json`,
   deterministic grader + normalization, frozen `final01` baseline for regression
   comparison (recalibrated for the new embedding space, golds untouched).

---

## 17. What we explicitly abandon

1. EC2 / systemd / Streamlit / SSH tunnels / reverse LM-Studio tunnel / `deploy/`
   scripts / `start_app.bat` / venv-on-a-VM operations. Entire class rejected.
2. Chroma + local-filesystem document paths. Supabase Postgres + Storage replace both.
3. Local embedding model (`all-MiniLM-L6-v2`, 384-dim) in any serving or ingest path.
   No `sentence-transformers`, no torch, no GPU sizing on our side.
4. Local cross-encoder reranker (`ms-marco-MiniLM-L-6-v2`, singleton + warmup).
   The OOM story ends here. Rerank, if needed, is Bedrock Rerank API only.
5. LM Studio provider wiring as a production path (keep the pattern in mind for
   local dev only, never as fallback that silently swaps models).
6. Bedrock Converse-dead workarounds as architecture: the Mantle-token-generator
   via EC2 instance role was account/region-specific. New system uses standard
   Converse/InvokeModel with IAM secrets in Edge Functions; re-validate model
   access in the chosen region instead of porting the workaround.
7. LLM query planner (`query_planner.py` 5D), LLM answer reviewer
   (`answer_reviewer.py` 5E), two-hop retrieval (`evidence_hops.py`), source router
   (`source_router.py`), comparison/extraction/summary runners (`workflows.py`) as
   V1 scope. All deferred or rejected per §19 (planner A/B showed zero delta; hops
   unwired by design; router thin and unproven live).
8. `/tmp` SSH-transport benchmark harness pattern, result-artifact commits,
   Streamlit UI layer, `localStorage`-only conversation restore.
9. Any design that lowers the relevance threshold to "fix" recall, drops citations,
   treats assistant text as evidence, or lets the planner control scope/prompts/k.

---

## 18. Reference-repository findings

Selectively inspected under `C:\RAG-4i-Cloud-LAB\research` (per `SESSION_HANDOFF.md`
§10: nothing was imported; no dependencies added except the old Mantle path).
Use patterns, not frameworks:

- **Controllable-RAG-Agent**: bounded verify → correct → stop; per-task
  retrieve-vs-answer decision; refined self-contained steps. → Adopted as the
  one-correction bound + deterministic verdict gate (§§5, 8).
- **NVIDIA RAG Blueprint**: bounded verification gate after retrieval. → Adopted
  as pre-generation verdict + post-generation tripwire (§8).
- **LlamaIndex**: sub-question fan-out with isolation + router-decision shape. →
  Adopted as deferred bounded fan-out design (§16.6), not as a dependency.
- **LangGraph**: graph/step orchestration for agents. → Rejected for V1: our
  pipeline is linear with one bounded branch; a graph runtime adds surface
  without measured benefit.
- **RAGFlow**: full-featured pipeline reference. → Nothing cheaply adoptable as a
  component (per prior study); its lesson is architectural (parse → chunk →
  hybrid → fuse → rerank → cite), which §§6–8 already encode with managed services.
- **Semantica**: provenance references. → Adopted as `sources JSONB` citation
  records + `[file p.N]` evidence labels (§9).
- **OpenViking / Mem0 / claude-mem / ai-memory / Maka**: agent-memory designs. →
  Not adopted for V1 RAG; conversation memory stays bounded window + persisted
  messages (§12). Revisit only if a real multi-session memory need is measured.

Rule enforced: no framework/dependency is added because a reference uses it.
Each adopted item above is a deterministic, dependency-free pattern.

---

## 19. V1 / V1.5 / Later / Reject classification

Evidence-driven complexity: nothing advances without beating the frozen baseline
on the ported golds.

**V1 — necessary now:**

- Supabase Auth + private Storage + Postgres RLS + tenant/membership model.
- Edge Functions-only API (query/stream, documents CRUD, ingest worker, status).
- Voyage voyage-4 embeddings (1024-dim float, `input_type: document` for corpus /
  `query` for queries; single model/dim corpus-wide), server-side only.
- Tenant-filtered hybrid retrieval (HNSW + FTS + RRF/weighted fusion, small k,
  recalibrated threshold) + deterministic multi-form query (normalized + core).
- Deterministic pre-generation verdict + one bounded correction + refusal/fallback
  contract + frozen grounded prompts (DIRECT/PARTIAL) + citation guard + think-strip.
- One deterministic clarification max (precision rule).
- Server-persisted conversations/messages with bounded history window.
- Per-file ingest reports, idempotent re-index, transactional delete.
- Rate limits/quotas, signed upload/download flows, metadata-only telemetry.
- Ported gold suite (scenarios + M-corpus shape + grader normalization) as the
  release gate; recalibrated scores/thresholds for voyage-1024.

**V1.5 — useful, add after baseline validation:**

- Bedrock Rerank API (Cohere 3.5 / Amazon Rerank 1.0) as a flag-gated stage:
  recall broad N → rerank → top-k. Ship only if golds + latency/cost justify it.
- Constrained one-repair generation (reuse existing path, same evidence discipline).
- Bounded DECOMPOSE fan-out (≤3, provenance merge, cap) for genuinely compound
  questions — only after single-retrieval baseline is stable.
- Prompt caching / evidence caching, ingest parallelism, usage dashboards.

**Later — only with measured product benefit:**

- Query decomposition/reasoning LLM, LLM reviewer/judge, two-hop dependent
  retrieval, source routing, comparison/extraction/summary workflow runners.
- OCR for scanned PDFs, multilingual FTS dictionaries, per-document ACLs inside a
  tenant, full-text page-image viewer, multi-region/data-residency profiles.
- Provisioned Bedrock throughput, read replicas, Supabase compute upgrades beyond
  what quotas prove necessary.

**Reject — unnecessary/too complex for this system:**

- EC2/self-hosted anything, local embeddings, local cross-encoder, Chroma,
  Streamlit production UI, LM Studio production path, Converse-workaround
  architecture, general agent frameworks, silent model substitution, threshold
  lowering to fake recall, assistant-text-as-evidence, unbounded repair loops,
  result artifacts in git, secrets in code/logs.

---

## 20. Proposed implementation phases

1. **Phase 0 — Decisions + project scaffolding (no RAG yet).** Resolve §21 items
   (region, embedding dim, answer-model shortlist, PDF parser proof-of-concept,
   Storage/RLS naming). Stand up Supabase project, Auth, private buckets, secret
   slots. Port gold assets + grader (untouched) into the new repo harness.
2. **Phase 1 — Data plane.** Concept schema (§9) → migrations with RLS + indexes
   (HNSW, GIN, tenant indexes) → Storage policies + tenant prefixes → seed one
   test tenant + membership. Prove cross-tenant isolation tests green.
3. **Phase 2 — Ingestion.** Upload → Storage → chunked Edge Function worker →
   Voyage voyage-4 embeddings → chunks + FTS. Per-file reports, idempotent re-index,
   delete path. Load the M-corpus shape; measure ingest cost/latency/rate limits.
4. **Phase 3 — Retrieval baseline.** Hybrid SQL RPC + deterministic query forms +
   pre-generation verdict + one bounded correction. Recalibrate k/threshold on
   golds. Freeze the baseline numbers.
5. **Phase 4 — Generation baseline.** Converse answer path (temp 0.0, frozen
   prompts, SSE streaming, think-strip, citation guard, clarification gate,
   conversation persistence). Gold-gated release; no rerank/reviewer yet.
6. **Phase 5 — Harden.** Rate limits/quotas, signed-URL lifecycle, backup/PITR
   verification, failure-mode drills (§15), cost dashboard, security review
   (RLS + service-role + Bedrock IAM audit).
7. **Phase 6 — V1.5 candidates, one at a time.** Bedrock rerank → repair → fan-out,
   each behind a flag and each requiring a gold delta + cost/latency note before
   becoming default.

---

## 21. Open questions/decisions that must be resolved before coding

1. AWS region + Supabase project region (co-locate; must support the chosen
   answer model + Rerank in-region — Rerank is not in every region).
2. Embedding dimension: RESOLVED Phase 2C — voyage-4, 1024-dim float (freezing
   this freezes the whole corpus; see the embedding contract above).
3. Answer-model shortlist for the first eval (cheap default + one upgrade
   candidate; no hardcoded winner in code; entitlement verified in the new account).
4. Deno PDF parsing proof-of-concept: pick library, measure against the real file
   distribution under Edge Function limits; decide chunked-Edge vs Lambda-parse
   fallback before building ingestion.
5. FTS language configuration for the real corpora (english vs multilingual needs).
6. Chunking re-validation: keep 1000/200 for gold comparability vs retune for
   voyage-4; page-preservation format; `chunk_id` hash composition (must include
   embedding model id).
7. `k`, threshold, fusion weights/RRF-k, corrective-query triggers — recalibrate,
   do not inherit MiniLM numbers.
8. Session-upload semantics: tenant documents (recommended V1) vs ephemeral scope.
9. Per-document ACLs inside a tenant: yes/no for V1 (recommended: no).
10. Auth mode: invite-only vs open signup; MFA/SSO needs; tenant creation flow.
11. Quota defaults (queries/min, uploads, evidence size, output tokens) per role.
12. Backup/PITR tier, Storage versioning, log retention, telemetry store.
13. Old-data stance: start empty + re-embed (recommended) vs any migration of RDS/S3
    content (requires re-embedding anyway due to dim change — say so explicitly).
14. Streaming transport details (SSE vs WebSocket) against Edge Function timeout
    behavior; honest long-query UX contract.
15. Cost guardrails: per-tenant spend alerts, model-upgrade approval path.

---

## Appendix — what was inspected and verified

- Repositories inspected: `C:\RAG-4i-Cloud` (all files named in `SESSION_HANDOFF.md`
  §4 verified present by name; deep-read: `SESSION_HANDOFF.md`, `README.md`,
  `docs/ARCHITECTURE.md`, `docs/RAG_INVARIANTS.md`, `docs/CURRENT_STATE.md`,
  `docs/PHASE_5_ARCHITECTURE.md`, `docs/adr-retrieval-upgrades.md`, `config.py`,
  `backend.py`, `postgres_vector_store.py`, `reranking.py`, `groundedness.py`,
  `evidence_verification.py`, `query_plan.py`, `bedrock_mantle_provider.py`,
  `embeddings.py`); `C:\RAG-4i-Cloud-LAB\research` top-level + subfolders
  (`Controllable-RAG-Agent`, `nvidia-rag`, `semantica`, `ragflow`, `llama_index`,
  `langgraph`, `OpenViking`, `ai-memory`, `mem0`, `maka`, `claude-mem`, `ruflo` names
  listed; patterns per handoff §10 reused selectively). New project folder verified
  empty (only `.git/`).
- Authoritative docs verified live during analysis: Supabase HNSW/pgvector guides
  (HNSW recommended, `vector_cosine_ops`, dims ≤2000, iterative scan from 0.8.0),
  Supabase Edge Function limits (256 MB, 150 s free / 400 s paid wall clock,
  ~2 s CPU, 150 s response timeout), Supabase Storage access control (private by
  default, RLS on `storage.objects`, signed URLs, service-role bypass),
  Supabase RLS guide (`auth.uid()`, `(select auth.uid())`, role-scoped policies),
  AWS Bedrock Titan V2 model card (1024/512/256 dims, 8K tokens, RPM throttling),
  Bedrock Rerank docs (Rerank API, `cohere.rerank-v3-5:0`, per-region support,
  ~$2/1K queries), Bedrock pricing (Titan ~$0.02/1M; Nova Micro $0.035/$0.14
  through Sonnet-class $3/$15 — model choice dominates cost).
- Phase 2B/2B.1/2B.2 verification: Bedrock Titan V2 invocation refused
  (`Operation not allowed`; `authorizationStatus: NOT_AUTHORIZED` in ap-south-1,
  no Organization/SCP involvement) — Titan is NOT the active provider. Voyage
  `voyage-4` single-call POC: PASS (1024 dims, finite, norm ≈ 1, 176 tokens,
  ~2.3 s; `VOYAGE_API_KEY` Edge secret; no production writes, no leakage).
- Architecture selected: **A (Supabase + Edge Functions + Bedrock)**. EC2 not
  required. Backend = Edge Functions only in V1. Supabase = identity + storage +
  system of record + search + execution. Voyage AI = embeddings (voyage-4/1024,
  live-proven in Phase 2B.2); Bedrock = answer LLM (+ rerank V1.5).
- Major risks: (1) Deno PDF parsing under Edge limits → mitigated by async chunked
  jobs + Lambda-parse fallback; (2) score/threshold invalidation from 384→1024 dim
  change → mitigated by gold recalibration; (3) region/entitlement mismatch (old
  Converse-dead lesson) → mitigated by pre-coding region+model verification;
  (4) tenant-filter + HNSW recall interaction → mitigated by iterative-scan tuning;
  (5) cost overrun from answer-model choice → mitigated by cheap default + quotas.
- Files created: `ARCHITECTURE.md` (this file), `DECISIONS.md`. No application code,
  tables, functions, integrations, or dependencies were implemented.
