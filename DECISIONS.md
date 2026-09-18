# Architectural Decisions (RAG 4i — Supabase + Bedrock)

Only the important decisions and their rationale.
Companion documents: `ARCHITECTURE.md` (Part 1 = current backend, Part 2 =
historical) and `UI_ARCHITECTURE.md` (frontend).

- **D1–D17** are the original pre-implementation decisions (analysis date
  2026-09-14). Their reasoning is preserved verbatim; the table below gives each
  one's **current standing**. Where implementation changed the answer, the table
  points at the superseding decision recorded in Part 2.
- **D18–D53** are decisions actually taken during implementation (D18–D40:
  platform Phases 1–3D; D41–D45: the UI phase; D46–D53: the post-V1 additive
  capabilities B1–B6 and the documentation discipline). They are the current
  record.
- **D41–D45** are frontend/UI-phase decisions (Part 3 below) — boundaries, not
  implementation detail (the UI itself is documented in `UI_ARCHITECTURE.md`).

Status of the analysis-era decisions as of 2026-09-16 (V1 LOCKED):

| # | Topic | Standing |
|---|---|---|
| D1 | Rebuild clean; freeze old repo as reference | CURRENT |
| D2 | No EC2 | CURRENT |
| D3 | No traditional backend in V1 | CURRENT |
| D4 | Supabase = identity + storage + system of record + search + execution | CURRENT |
| D5 | Voyage embeddings; **Bedrock keeps LLM + rerank via Converse/InvokeModel** | PARTIALLY SUPERSEDED — Voyage half CURRENT; answer LLM is now **Mantle** (D23), rerank not shipped |
| D6 | Never call Bedrock/Voyage from browser; **Edge→Bedrock SigV4/IAM keys** | PARTIALLY SUPERSEDED — "never from browser" CURRENT; transport is now a **Mantle Bearer secret** (D23), no SigV4/IAM/`bedrock-runtime` |
| D7 | Tenant isolation is a DB predicate | CURRENT |
| D8 | Retrieval V1 hybrid; **do not inherit k=5/threshold 0.3; recalibrate** | SUPERSEDED IN PART — hybrid shape CURRENT; calibration is now **locked at 20/20 + RRF-60 + k=8, no threshold** (D21, D22) |
| D9 | Rerank is V1.5 via Bedrock Rerank API | CURRENT (still not shipped; not on the V1 path) |
| D10 | Deterministic verification before; tripwire after | CURRENT (extended by the advisory checker, D30/D31) |
| D11 | No decomposition/reasoning/agentic frameworks in V1 | CURRENT |
| D12 | Conversations persist server-side, bounded memory | CURRENT |
| D13 | Ingestion async, additive, idempotent, per-file explicit | CURRENT |
| D14 | Prompts frozen, models explicit, failures honest | CURRENT |
| D15 | Cost controlled by model choice + evidence bounds + quotas | CURRENT (quotas still unenforced — see D40) |
| D16 | Evaluation gates every complexity increase | CURRENT (gold corpus is the frozen 34-case suite, D29) |
| D17 | Voyage 4 is the V1 embedding contract | CURRENT |

---

# Part 1 — Original analysis-era decisions D1–D17 (2026-09-14)

> Historical record with reasoning preserved. See the status table above for
> current standing; some statements (Bedrock Converse/IAM, placeholder
> calibration values) are deliberately left as written because they record what
> was decided *at the time*.

---

## D1. Rebuild clean on Supabase + Bedrock; freeze the old repo as reference

- Decision: new project in this folder; `C:\RAG-4i-Cloud` is a research artifact.
- Rationale: the old stack (EC2 + Streamlit + Chroma + local MiniLM/cross-encoder +
  tunnels) caused the outage class we must eliminate (OOM wedge on 913 MB, manual
  reboots, no auth/HTTPS). Port ideas and golds, not infrastructure.

## D2. No EC2 (options A over B over C)

- Decision: A (Supabase + Edge Functions + Bedrock) is the architecture. B (separate
  lightweight backend) only if Edge Function limits are measured blocking. C (EC2)
  rejected outright.
- Rationale: nothing in V1/V1.5 needs a persistent VM. EC2 reintroduces patching,
  SSH availability, and co-located-model OOM risk with zero quality benefit.

## D3. No traditional backend server in V1

- Decision: Edge Functions are the only server-side execution layer.
- Rationale: the workload is auth-verified orchestration + I/O-bound Bedrock/Postgres
  calls — exactly what Edge Functions fit. A general app server adds ops surface
  without a proven need. The named fallback for PDF parsing is a stateless async job
  (Lambda/Cloud Run), not a standing server.

## D4. Supabase is identity + storage + system of record + search + execution

- Decision: Auth, private Storage, PostgreSQL (pgvector + FTS + RLS), Edge Functions.
- Rationale: managed, co-located, RLS-enforced. Verified current capabilities:
  HNSW (`vector_cosine_ops`, iterative scan from pgvector 0.8.0), generated
  `tsvector` + GIN, private buckets with `storage.objects` RLS + signed URLs,
  Edge limits (256 MB / ~2 s CPU / 150 s response / 400 s paid wall clock).

## D5. Voyage AI is the embedding provider; Bedrock keeps LLM + rerank

- Decision: embeddings = Voyage AI `voyage-4` (single corpus-wide model/dim;
  full contract in D17). Answer LLM (Converse/InvokeModel, temp 0.0) and
  Rerank API (V1.5) stay on Bedrock.
- Rationale: a live single-call POC (Phase 2B.2) proved Edge → Voyage with an
  exact contract match (1024 dims, finite values, norm ≈ 1, token usage
  returned). Bedrock Titan V2 was evaluated first and is blocked by
  account-level authorization (`authorizationStatus: NOT_AUTHORIZED` in
  ap-south-1) — therefore NOT the active V1 provider. Either way, no local
  models (MiniLM + cross-encoder caused the OOM).
  Rerank API with Cohere 3.5 exists (`cohere.rerank-v3-5:0`, region-limited,
  ~$2/1K queries); LLM prices span 285× (Nova Micro $0.035/$0.14 → Sonnet-class
  $3/$15), so model choice — not infra — is the cost lever.

## D6. Never call Bedrock or Voyage from the browser

- Decision: all Bedrock traffic is Edge Function → Bedrock with SigV4; IAM keys in
  Edge Function secrets only. All Voyage traffic is Edge Function → Voyage API
  with `VOYAGE_API_KEY` in Edge Function secrets only.
- Rationale: least privilege, no key exposure, prompts/evidence/model IDs stay
  server-side, tenant scope enforced before any inference spend.

## D7. Tenant isolation is a DB predicate, not frontend discipline

- Decision: `tenant_id` on every RAG row + memberships + `security definer` helper
  (`set search_path=''`) + `(select auth.uid())` policies; tenant predicate in every
  retrieval branch; tenant-prefixed Storage keys; live membership lookups for
  immediate revocation.
- Rationale: per current Supabase RLS guidance; makes cross-tenant leakage a failing
  test rather than a code-review hope. `service_role` bypass confined to Edge Functions.

## D8. Retrieval V1 is Postgres hybrid (HNSW + FTS + fusion), recalibrated

- Decision: single tenant-filtered SQL path (dense + `plainto_tsquery` + RRF/weighted
  fusion, deterministic tie-break), cheap deterministic query forms, small k.
  Do NOT inherit `k=5 / threshold 0.3` — those were MiniLM-384 numbers; voyage-1024
  distributions differ and must be re-tuned on the ported golds.
- Rationale: proven fusion shape from `postgres_vector_store.py` without any local
  model; RRF preferred (fewer knobs); keeps recall-then-fuse server-side and simple.

## D9. Rerank is V1.5 via Bedrock Rerank API — never a local cross-encoder

- Decision: V1 ships without rerank (or flag-gated off); enable Bedrock Rerank only
  after it beats the frozen baseline on golds + cost/latency review.
- Rationale: the old rerank stage was valuable but its implementation (local
  cross-encoder on t3.micro) caused the outage. The managed API preserves the
  capability without the failure mode; evidence decides whether it ships.

## D10. Deterministic verification before generation; lightweight tripwire after

- Decision: port `evidence_verification` verdicts + one bounded correction
  (pre-LLM gate, fail-open) and the `groundedness` numbers/qualifier/negation
  tripwire (post-LLM label downgrade). No LLM reviewer in V1; at most one
  constrained repair in V1.5+ and only if measured useful.
- Rationale: the old system's hardest-won lesson — model-free where practical,
  bounded where not. Pre-gate saves cost and blocks hallucination on empty evidence.

## D11. No query decomposition / reasoning / agentic frameworks in V1

- Decision: deterministic DIRECT/REWRITE-class handling only; DECOMPOSE fan-out,
  LLM planner, reviewer, two-hop, source router, workflow runners deferred or rejected.
  No LangGraph/LlamaIndex/RAGFlow dependency.
- Rationale: the old planner A/B measured zero delta (all DIRECT as predicted);
  hops were deliberately unwired; router unproven live. Linear pipeline + one bounded
  branch needs no graph runtime.

## D12. Conversations persist server-side with bounded memory

- Decision: `conversations` + `messages` under RLS replace in-memory + localStorage
  snapshots; generation sees a bounded window (e.g. 3 turns); assistant text is never
  retrieval evidence.
- Rationale: multi-device, auditable provenance, cost-bounded prompts.

## D13. Ingestion is async, additive, idempotent, per-file explicit

- Decision: Storage → job row → chunked Edge Function worker → Voyage batch embed →
  `ON CONFLICT DO NOTHING` inserts; zero-text files fail loudly; updates/deletes are
  transactional by `document_id`; `chunk_id` hashes include tenant + embedding model id.
- Rationale: ports what worked (idempotency, per-file reports, originals untouched)
  while fitting Edge limits without a server. Old 384-dim vectors are re-embedded,
  never reinterpreted.

## D14. Prompts frozen, models explicit, failures honest

- Decision: grounded DIRECT/PARTIAL templates versioned; `ANSWER_MODEL_ID` required,
  never defaulted or silently substituted; single deterministic clarification max;
  citations never dropped; think-blocks stripped server-side.
- Rationale: preserves the grounding contract that made the old baseline trustworthy;
  prevents the "helpful substitution" failure class.

## D15. Cost is controlled by model choice + evidence bounds + quotas

- Decision: cheap default answer model, bounded evidence/tokens, no per-query
  planner/reviewer/rerank in V1, per-tenant quotas and spend alerts.
- Rationale: LLM output tokens dominate; infra is predictable base. Never "optimize"
  by lowering the relevance threshold.

## D16. Evaluation gates every complexity increase

- Decision: port `scenarios_v1.json` + `cases_m.json` + grader normalization as the
  release gate (golds untouched; scores recalibrated). V1 → V1.5 → Later advances
  only on measured gold delta + cost/latency note.
- Rationale: evidence-driven complexity; prevents recreating the old tendency to add
  sophisticated mechanisms before proving product benefit.

## D17. Voyage 4 is the V1 embedding contract

- Contract: provider Voyage AI; model `voyage-4`; dimension 1024; dtype float
  (default); corpus `input_type: "document"`; query `input_type: "query"`; key
  `VOYAGE_API_KEY` as a Supabase Edge Function secret; embeddings generated
  server-side only; the browser never calls Voyage; `chunks.embedding
  vector(1024)` remains the active embedding space.
- Rationale: Phase 2B.2 PASS (single live call: exact 1024 dims, finite values,
  norm ≈ 1, token usage returned, no secret leakage, no production writes).
  Titan V2 was evaluated but is blocked by account-level AWS authorization
  (`NOT_AUTHORIZED`) and is therefore NOT the active V1 provider.

---

# Part 2 — Decisions taken during implementation (Phases 1–3D)

These record what was actually built and locked. Each has Decision / Status /
Reason / Consequence / What would justify revisiting.

## D18. Edge Functions are the only production server-side layer

- Decision: the production API is exactly four Deno Edge Functions —
  `ingest-pdf`, `embed-worker`, `query-chunks`, `ask` — using a caller-JWT data
  plane (no `service_role` in the query path). No traditional backend, no EC2.
- Status: LOCKED.
- Reason: the workload is auth-verified orchestration + I/O-bound provider/DB
  calls; implemented and verified hash-identical to source.
- Consequence: stateless horizontal scale; provider credentials stay in Edge
  secrets; the `t3.micro` OOM failure class is structurally absent.
- Revisit if: measured Edge limits block a required real workload (the only
  sanctioned fallback is a stateless async job, never a standing server).

## D19. Async, paced, Cron-driven Voyage embedding worker

- Decision: `ingest-pdf` parses to chunks with NULL embeddings; a pg_cron tick
  (every minute, via pg_net) invokes `embed-worker`, which claims one idle job by
  compare-and-swap on `attempts` and embeds a small budget (`VOYAGE_PER_TICK = 2`)
  per tick; a document becomes `ready` only when zero NULL embeddings remain.
- Status: LOCKED.
- Reason: Voyage's low free-tier RPM makes inline embedding unsafe; durable
  progress (`embedding IS NULL` scan) + retries converge.
- Consequence: ingestion is eventually-consistent and resume-safe; the document
  state machine is honest (`pending` → `ready` only via the worker).
- Revisit if: Voyage limits rise enough that per-tick budget can increase, or a
  bulk-ingest need justifies batching (still bounded).

## D20. Hybrid retrieval is one tenant-scoped `match_chunks` RPC

- Decision: dense + lexical candidates come from a single `SECURITY INVOKER`
  RPC; `hnsw.iterative_scan = 'relaxed_order'` is set per-transaction; fusion
  happens deterministically in the Edge caller.
- Status: LOCKED.
- Reason: one round trip, RLS layered on explicit tenant predicates, full
  candidate sets even under selective tenant filters.
- Consequence: retrieval is reproducible and tenant-safe by construction.
- Revisit if: a measured recall/latency problem requires a different index or
  scan strategy (evidence + controlled experiment required).

## D21. Retrieval calibration is LOCKED at 20/20 + RRF-60 + k=8

- Decision: dense 20 / lexical 20 (cap 50), RRF with `RRF_K = 60`, final
  evidence `k = 8` (cap 20). This supersedes the analysis-era placeholder
  "recalibrate k/threshold on golds".
- Status: LOCKED.
- Reason: calibrated against the gold corpus; baseline retrieval metrics are
  healthy (Hit Rate 0.88, Recall@8 0.60, MRR 0.79 on the frozen baseline).
- Consequence: retrieval is a fixed contract the gate/generation depend on;
  downstream evaluation artifacts are comparable across phases.
- Revisit if: a future corpus/size change measurably degrades recall and a
  controlled experiment shows a specific value change helps — never on a single
  case.

## D22. No global dense threshold/floor

- Decision: retrieval returns candidates regardless of absolute similarity;
  the evidence gate owns the "is this enough" cut.
- Status: LOCKED.
- Reason: a global floor abstracts badly across domains and would silently drop
  legitimate low-similarity evidence; gating is more auditable.
- Consequence: refusal/partial decisions live in the gate, not the retriever.
- Revisit if: measured noise causes systematic gate mis-verdicts and a bounded,
  domain-agnostic alternative is demonstrated.

## D23. Mantle Chat Completions is the exclusive generation/provider path

- Decision: generation uses the fixed Bedrock Mantle endpoint
  (`…/v1/chat/completions`, ap-south-1) with the `ANSWER_MODEL_ID` model
  (production `qwen.qwen3-235b-a22b-2507-v1:0`), `temperature 0.0`,
  `max_tokens 1024`. This **replaces** the analysis-era Converse/InvokeModel +
  SigV4/IAM plan. No `bedrock-runtime`, no Converse, no runtime credentials, no
  EC2, no local model, no fallback, no silent substitution.
- Status: LOCKED.
- Reason: the account's Converse path was dead; the Mantle chat-completions
  path is verified live and is the only provider in the code.
- Consequence: one provider surface; model ID comes from a secret and is never
  hardcoded; provider failure is honest (429/502), never masked.
- Revisit if: the account/provider changes and an explicit architecture task
  approves a different path — never as an incidental swap.

## D24. Frozen, versioned prompts and explicit models

- Decision: grounded prompt templates are frozen strings with version IDs
  (`v1-direct` / `v1-partial` / `v1-conflict`); the model comes from
  `ANSWER_MODEL_ID`; `<think>` blocks are stripped server-side; the refusal text
  is a fixed constant.
- Status: LOCKED.
- Reason: preserves the grounding contract and prevents the "helpful
  substitution" failure class.
- Consequence: prompt changes require re-running the gold suite; behavior is
  reproducible at temp 0.
- Revisit if: a measured quality need + full gold re-run justify a version bump.

## D25. Deterministic evidence gate (model-free)

- Decision: pre-generation verdicts `SUPPORTED | PARTIAL | INSUFFICIENT |
  CONFLICTING`, with question-relative, exclusive-anchored-pair conflict
  detection, bare-number framing, negation rules, and version-aware
  amendment/supersession handling; disjoint evidence short-circuits to
  `INSUFFICIENT`.
- Status: LOCKED.
- Reason: deterministic, auditable, and conservative by design; the model is
  never asked to decide whether evidence is sufficient.
- Consequence: refusals happen before any model spend; conflict handling is
  reproducible.
- Revisit if: a specific, reproducible mis-verdict is demonstrated and a
  domain-agnostic deterministic fix is available (see capability boundaries,
  D38/D40).

## D26. Citation guard is a hard, deterministic failure

- Decision: any malformed, out-of-range, tenant-crossing, or out-of-document
  citation returns HTTP 502; valid citations are returned as validated source
  objects.
- Status: LOCKED.
- Reason: a citation the user cannot trust is worse than no answer.
- Consequence: fabrication via citations is structurally impossible.
- Revisit if: never for weakening; only additive validation could be considered.

## D27. Groundedness tripwire downgrades, never rewrites

- Decision: a deterministic post-generation check (numbers/dates/negations/
  sentence support) downgrades `direct → partial` with a static note on any
  finding; no regeneration, no rewrite.
- Status: LOCKED.
- Reason: conservative fail-toward-less-confidence; keeps the answer as the
  model produced it under the grounded prompt.
- Consequence: the label can only become more cautious, never more confident.
- Revisit if: measured false-positive rate justifies re-tuning — with evidence.

## D28. Production behavior is domain-agnostic

- Decision: no tax/legal/manual-specific vocabulary, synonyms, section rules, or
  corpus-specific heuristics anywhere in production logic. The Income Tax corpus
  is an evaluation instrument, not a domain specification.
- Status: LOCKED.
- Reason: RAG-4i must serve arbitrary enterprise document types (contracts,
  manuals, financial reports, HR policy, research, product docs, marketing,
  mixed corpora).
- Consequence: fixes must use general mechanisms (framing vs load-bearing
  concepts, equivalence, bounded semantic checks), never hardcoded mappings.
- Revisit if: never in the direction of domain hardcoding; only toward more
  general mechanisms.

## D29. Frozen 34-case gold evaluation corpus + live mapping

- Decision: `eval/cases/gold_cases.json` (34 frozen cases, 26 SUPPORTED / 4
  PARTIAL / 4 INSUFFICIENT) is the acceptance suite; production chunk IDs are
  resolved in `eval/mappings/chunk_map_3c4.json` (34 cases, 0 unresolved) against
  live document `a8b3c162` (226 chunks).
- Status: LOCKED (frozen).
- Reason: stable, comparable measurement across phases; production and
  evaluation are explicitly separated.
- Consequence: golds/mappings are never edited to make a result pass.
- Revisit if: a new evaluation corpus is deliberately introduced in a dedicated
  step (new mapping artifact, golds untouched).

## D30. Bounded semantic answer-correctness checker

- Decision: one bounded LLM evaluator (`correctness-v1`) after generation, with
  a fixed input contract (question/answer/evidence/gate verdict/citations),
  strict JSON output (`PASS|PARTIAL|FAIL|INVALID`), strict validation, no
  application-level output cap, one transport-only retry, 30 s timeout, INVALID
  on any malformed/untrusted output.
- Status: LOCKED (component); usage flag-gated OFF by default.
- Reason: deterministic token logic cannot judge semantic equivalence across
  arbitrary domains (the 3C.6 boundary); a bounded evaluator adds an independent
  semantic signal without an agent loop.
- Consequence: an additional model call per answer *when enabled*, with strictly
  bounded behavior and no authority.
- Revisit if: measured value/cost tradeoff changes, or the contract needs
  extension (only with a concrete demonstrated defect).

## D31. Checker is advisory, never authoritative

- Decision: deterministic aggregation is downgrade-only. Checker `PASS`/`INVALID`
  preserves; `PARTIAL`/`FAIL` may downgrade `direct → partial` and append a static
  note; it can never upgrade, refuse, override the gate/citations/security, or
  set HTTP status.
- Status: LOCKED.
- Reason: the evidence gate and citation guard remain the authority; the checker
  is a bounded second opinion.
- Consequence: the checker cannot change the answer's factual content or the
  refusal contract.
- Revisit if: never toward granting authority; only the advisory surface.

## D32. Feature-flagged rollout of the checker

- Decision: `CORRECTNESS_CHECKER_ENABLED` is a server-side secret, default OFF,
  never exposed to the browser. OFF = dead code, behavior identical to
  pre-integration.
- Status: LOCKED (flag currently OFF).
- Reason: controlled rollout and measurement without making the checker
  universally authoritative.
- Consequence: production behavior is unchanged unless the flag is deliberately
  enabled for a controlled run.
- Revisit if: a deliberate decision to enable by default (requires gold evidence).

## D33. Local LM is a test-time oracle only

- Decision: a local LM (e.g. LM Studio) may be used only as an independent
  diagnostic oracle over already-captured question/answer/evidence. It is never
  production infrastructure, never a fallback, never authoritative, never given
  gold answers as judging authority.
- Status: LOCKED.
- Reason: an independent signal for diagnosis; keeps production single-provider.
- Consequence: no local-model code, URL, credential, or fallback exists in
  production.
- Revisit if: never for production use.

## D34. No autonomous agent loops

- Decision: the pipeline is a short deterministic sequence with bounded
  components. No planner, no recursive/decompose loops, no unbounded retries, no
  self-correction loops, no framework runtimes (LangGraph/LlamaIndex/RAGFlow/etc.).
- Status: LOCKED.
- Reason: the old system's failures came from unbounded/complex machinery; the V1
  workload does not need it.
- Consequence: every stage has fixed inputs/outputs and a bounded retry policy.
- Revisit if: a specific, measured need requires a bounded addition (still not an
  agent loop).

## D35. Bounded quality-chain observability

- Decision: `/ask` exposes bounded diagnostics (gate conflicting list,
  citation-guard reason, tripwire reason/findings/counts, checker
  invocation/verdict/invalid_reason/latency/attempts/output size, per-stage
  timings, model/prompt/flag metadata). No secrets, tokens, content, or
  unbounded logs.
- Status: LOCKED.
- Reason: 3C.18 showed real failures were undiagnosable from ephemeral logs;
  persisted bounded state lets future failures be investigated without log access.
- Consequence: diagnostics are part of the API contract the UI/eval can read.
- Revisit if: a specific new failure class needs an additional bounded field.

## D36. Evaluation artifacts preserve evidence text

- Decision: the eval runner persists the exact retrieved evidence text
  (`/query-chunks` `content` → artifact `text`) per case, excluding `tenant_id`
  and any credential. This fixed a projection mismatch where artifacts had
  `"text": null`.
- Status: LOCKED (evaluation-only; production response contract unchanged).
- Reason: independent diagnosis of A4/D1/E1/G1/F1 required the actual evidence.
- Consequence: evaluation artifacts are self-contained for review; evidence is
  bounded to the retrieval cut (8 items).
- Revisit if: a data-handling decision changes what evaluation artifacts may
  store.

## D37. No application-level checker output-token cap

- Decision: the checker request carries **no** `max_tokens`; the provider/model
  applies its own maximum. Boundedness comes from the timeout, single retry,
  strict validator, and the flag — not an invented token ceiling.
- Status: LOCKED.
- Reason: a 1024-token application cap truncated valid structured judgments
  (eval case D1 reproduced INVALID `invalid-json` at exactly 1024/1024 tokens; removing the
  cap produced a valid PARTIAL at 1241 tokens). No arbitrary replacement cap.
- Consequence: long complex answers are evaluated correctly; cost is bounded by
  the model's own limit.
- Revisit if: never re-introduce an arbitrary cap; only the provider limit.

## D38. V1 quality-chain lock (no demonstrated bottleneck)

- Decision: the locked quality chain is retrieval → evidence gate → generation →
  citation guard → tripwire → optional checker → aggregation. The 3C.23 baseline
  (8/8 HTTP, evidence 64/64, checker 6 PASS/2 PARTIAL/0 FAIL/0 INVALID, zero
  retries, zero checker-caused label changes, citations 8/8, tripwire grounded
  6/8) and 3C.24 bottleneck analysis (no bottleneck, no defect, no justified
  change) are the accepted V1 quality state.
- Status: LOCKED.
- Reason: no layer demonstrated a defect; residual issues are conservative
  behavior, evaluation limitations, or capability boundaries.
- Consequence: no quality-chain change is made without fresh, reproducible
  evidence.
- Revisit if: a new reproducible, evidenced defect appears.

## D39. V1 release lock

- Decision: RAG V1 is released/locked. No release blocker was demonstrated
  (3D.1 audit: architecture, retrieval, corpus/mapping, security, observability,
  failure behavior, flags all verified stable).
- Status: LOCKED.
- Reason: a complete, evidenced audit found no reason V1 should not be locked.
- Consequence: the backend/RAG layer is frozen as the base for UI work; changes
  require new evidence and the standard workflow.
- Revisit if: a concrete release blocker is demonstrated.

## D40. Current non-blocking hardening opportunities

- Decision: the following are recorded as *opportunities*, not blockers, and no
  hardening change is currently justified (3D.2 found **zero** demonstrated
  operational defects): `/ask` non-idempotency (client retries can duplicate
  generation); no explicit application-level timeouts on some provider/DB calls;
  no ingestion file-size cap; raw driver text can appear on 500 responses; no
  cross-function request-id chaining; quotas not yet enforced.
- Status: OPEN / NON-BLOCKING.
- Reason: audited and recorded so they are not lost, while keeping the lock.
- Consequence: when hardening begins, `/ask` idempotency is the highest-value
  first candidate.
- Revisit if: any is promoted to a demonstrated defect by an incident or a
  controlled reproduction.

---

## Part 3 — Frontend/UI-phase decisions (UI Passes 1–3B)

D41. Frontend is a separate, independently documented layer

- Decision: the UI lives in `web/` and is documented in `UI_ARCHITECTURE.md`.
  It is not part of the locked backend, has never been deployed, and
  `ARCHITECTURE.md` Part 1 remains backend-only.
- Status: ACTIVE (UI Passes 1–3B implemented).
- Reason: keeps the V1 backend lock intact while the interface evolves on its
  own track.
- Consequence: UI phases advance against `UI_ARCHITECTURE.md` status; no UI need
  may silently re-open a backend decision. A UI requirement that needs backend
  data is a separate, explicitly authorized, additive backend step.
- Revisit if: the frontend acquires its own deployment/hosting or a second
  consumer of the API appears.

D42. The browser talks only to Supabase and two Edge Functions

- Decision: the frontend holds the Supabase project URL and publishable key plus
  the user's session JWT. Reads/writes go through PostgREST/Storage under RLS;
  answers go through `/ask`; nothing else is reachable.
- Status: ACTIVE / IMPLEMENTED (3A). UNVERIFIED end-to-end (see D44).
- Reason: preserves the security boundary in `ARCHITECTURE.md` §1.13 — no
  provider credential is browser-visible and no model call is possible from the
  client.
- Consequence: any provider-side capability the UI needs must be exposed through
  an Edge Function response; the UI never gains direct provider access.
- Revisit if: never in V1.

D43. The frontend never fabricates backend semantics

- Decision: no fabricated evidence text, no similarity scores, no confidence
  percentages, no invented progress stages, no Stop control on the
  non-streaming `/ask`, no reasoning/CoT surface, no mock data in any production
  path. The response payload is the only evidence of what happened.
- Status: ACTIVE / ENFORCED (3B); recorded so later UI passes cannot regress it.
- Reason: the backend strips model reasoning before responding and returns
  citations as metadata only, so anything more shown in the UI would be invented.
- Consequence: such UI ideas are constrained to the corresponding backend
  capability (e.g. the evidence-text change in D45) rather than approximated.
- Revisit if: the backend response exposes the missing data.

D44. A real authenticated session is the gate between UI phases

- Decision: no UI phase counts as verified until its surface has been exercised
  in a browser against the real backend with a real signed-in session. Mocks are
  acceptable for local development only and must never be presented as
  validation.
- Status: ACTIVE. 3A/3B are IMPLEMENTED but **not yet validated** — the
  authenticated browser smoke test has not been run. A dedicated test account
  (`test@rag.com`, `member` of the single tenant) now exists and was verified to
  sign in and resolve its workspace; its password is held only in the Windows
  Credential Manager target `RAG4I_test_user`, never in the repo. The evaluation
  account's vaulted refresh token was deliberately not consumed.
- Reason: session resolution, membership lookup, RLS-scoped reads and `/ask`
  behaviour cannot be proven by mocks or by unauthenticated checks.
- Consequence: UI Pass 3C does not start until the 3B smoke test passes;
  verification is treated as pending work, not as a failure.
- Revisit if: n/a — this gate is permanent.

D45. Evidence-workspace capabilities require an additive backend change

- Decision: `/ask` currently returns citation metadata only. Displaying actual
  passages (citation → passage, evidence rail, conflict comparison, refusal
  evidence) requires a small **additive** change returning the bounded evidence
  text `/ask` already assembles and persists. Re-deriving evidence via a
  separate `query-chunks` call is not acceptable — it is a different request and
  is not guaranteed to return the evidence that actually grounded the answer.
- Status: OPEN / DEFERRED until D44's smoke test passes.
- Reason: the UI must show the evidence that truly grounded the answer, or show
  nothing.
- Consequence: UI Pass 3C is blocked on (1) authenticated 3B verification and
  (2) that backend addition, which must be authorized as its own step and must
  not change locked retrieval/generation behaviour.
- Revisit if: the addition lands, or the approach is replaced by a documented
  alternative.

---

## Part 4 — Post-V1 additive capabilities (B1–B6)

D46. CORS is handled by the browser-facing Edge Functions

- Decision: `ask`, `query-chunks` and `ingest-pdf` share one `_shared/cors.ts`
  helper — `OPTIONS` → 204 plus `Access-Control-Allow-Origin` (request Origin
  reflected; optional `CORS_ALLOWED_ORIGINS` allow-list), `-Headers`, `-Methods`
  and `Vary: Origin`. `Access-Control-Allow-Credentials` is never sent.
- Status: IMPLEMENTED + deployed (previously the browser could not call any
  Edge Function: preflight returned 405 with no CORS headers).
- Reason: CORS is a browser control, not an authorization boundary; auth remains
  the caller JWT + membership + RLS. No cookies are used, so reflecting Origin
  grants nothing a token-holder does not already have.
- Consequence: every response path (success and error) carries the headers;
  `embed-worker` (cron-only) deliberately does not.

D47. Upload safety limits are server-enforced, not client-enforced

- Decision: `ingest-pdf` enforces 25 MB per file (size read from Storage
  metadata, never from the caller), a 400 MB per-workspace storage budget
  (`sum(documents.file_size)`), 60 active documents, a 20,000-chunk budget
  (authoritative, post-parse), at most 1 processing + 3 pending jobs, and
  duplicate rejection by extracted-content hash.
- Status: IMPLEMENTED + live-validated (`ingest-pdf` v33; migration
  20260917000000 adds `documents.file_size` and backfills it).
- Reason: the client is not an authority; a direct API call must not bypass a
  limit. Rejections are deterministic HTTP statuses (413/507/409).
- Consequence: rejected calls write nothing; duplicate and chunk-budget
  rejections leave a failed tombstone the user can delete. Limits are tunable
  constants in one place.

D48. Embeddings are requested in bounded batches

- Decision: `embed-worker` sends up to 12 chunks per Voyage request and at most
  2 requests per tick (12,000-character cap per request). A whole batch is
  validated (exact model, exact count, complete index mapping, 1024 finite
  dimensions) **before** any write; an invalid batch persists nothing.
- Status: IMPLEMENTED + live-validated (`embed-worker` v29: 226 chunks in 19
  requests over 10.1 min, zero failures).
- Reason: the previous one-chunk-per-request design took ~2 chunks/min (≈2 h for
  the production document); batching stays inside the free Voyage account
  (3 RPM / 10K TPM ≈ 53% of TPM at peak) without changing the model, the
  dimensions or the stored vector.
- Consequence: `ingest_jobs.attempts` now counts ticks; progress is reported via
  `voyage_requests` and `failed_this_tick`.

D49. Notebook model: tenant → notebook → sources → documents → chunks

- Decision: `public.notebooks` + `public.notebook_sources` (PK
  `(notebook_id, document_id)`, `selected boolean default true`) and
  `documents.archived_at`. A source is one document; a document may appear in
  many notebooks. Tenant safety is **structural**: composite FKs
  `(notebook_id, tenant_id)` and `(document_id, tenant_id)` make linking another
  tenant's document impossible even for a privileged writer.
- Status: IMPLEMENTED + live-validated (migration 20260917000002; 22/22 checks,
  cross-tenant link rejected with 23503).
- Reason: the Cited Sources UI already presents documents as sources; the
  smallest model that supports selection and archiving without touching chunks.
- Consequence: RLS mirrors the documents policy (member-scoped, authenticated
  only). Selection has no effect until B2 enforcement (D50).

D50. Notebook scope is resolved server-side and applied at retrieval

- Decision: `match_chunks(..., p_document_ids uuid[] default null)` filters both
  candidate CTEs; `/ask` accepts `notebook_id` and resolves the selected,
  non-archived, same-tenant documents itself; `/query-chunks` accepts
  `notebook_id` (resolved) or `document_ids` (validated for tenant ownership and
  non-archived); omitting both preserves the previous unscoped behaviour. An
  empty scope is a deterministic refusal with no retrieval call and no LLM.
- Status: IMPLEMENTED + live-validated (`query-chunks` v29, `ask` v38;
  unscoped retrieval bit-identical to the frozen baseline, 34/34 full-corpus
  scope == unscoped, empty scope refused).
- Reason: frontend-only filtering is not a security boundary. The only new
  retrieval variable is the allowed document set — candidate counts, RRF k=60,
  final k=8, thresholds, chunking and generation are unchanged.
- Consequence: the UI cannot widen scope by sending document ids; conversations
  are not notebook-scoped (association is per request).

D51. The Storage platform cap matches the application policy

- Decision: the `company-documents` bucket's `file_size_limit` is lowered from
  50 MB to **25 MiB** (26,214,400), matching `ingest-pdf`'s limit.
- Status: IMPLEMENTED + live-validated (migration 20260917000001; uploads of
  exactly 25 MiB accepted, 25 MiB + 1 rejected by Storage with `statusCode 413`).
- Reason: a client could previously store an object the application would always
  reject; the app-level check remains as defense in depth.
- Consequence: lower-only and idempotent; existing objects are unaffected.

D52. Orphan cleanup is bounded, explicit and admin-triggered

- Decision: `storage-cleanup` (JWT + membership; **dry-run for any member,
  apply for owner/admin only**) enumerates one tenant's prefix, classifies each
  object (valid / too_young / active / orphan / unsafe) and deletes only
  confirmed orphans older than 24 h that are unreferenced, re-checked against a
  fresh document read. Bounds: ≤500 folders, ≤2,000 objects, ≤100 deletes per
  call. Anything ambiguous is preserved. No cron, no autonomous loop.
- Status: IMPLEMENTED + live-validated (`storage-cleanup` v1; 28/28 checks;
  idempotent rerun; production dry-run found the known `phase3c2` orphan and
  deleted nothing).
- Reason: the audit found a real orphan and a leak risk; deletion is the most
  dangerous operation in the system, so it is explicit, bounded and observable.
- Consequence: the client names a tenant, never a path; the function runs
  entirely on the caller's JWT (no service_role). Scheduled sweeping is a
  deliberate follow-up.

D53. Documentation is updated inside the pass, not at the end

- Decision: `UI_ARCHITECTURE.md`, `ARCHITECTURE.md`, `DECISIONS.md`,
  `SESSION_HANDOFF.md` and the relevant `eval/runs/` report are refreshed as
  part of each major pass, before the next pass starts. The hierarchy is
  code/migrations → `UI_ARCHITECTURE.md` / `ARCHITECTURE.md` → `DECISIONS.md` →
  `SESSION_HANDOFF.md` → `eval/runs/` reports. Planned behaviour is never
  described as implemented; unverified work is labelled as such.
- Status: ACTIVE.
- Reason: this project's correctness depends on state that lives across
  sessions; stale docs caused real rediscovery cost earlier.
- Consequence: a pass is not complete until its documentation is current.
- Revisit if: never — this is a standing rule.

D54. The upload queue respects the ingestion concurrency policy

- Decision: the browser uploads a file in the background but **registers it only
  when the workspace can accept it**. Before each registration the queue reads
  the real job state (`countActiveJobs`), and while a document is being
  processed it shows a truthful `waiting` state (live active-job count, bounded
  20-minute wait, cancellable) and resumes by itself. An item whose bytes are
  already in Storage keeps its key and offers **registration-only retry**.
  HTTP 409 maps to a first-class `conflict` error kind.
- Status: IMPLEMENTED + validated (`upload-panel.tsx`, `errors.ts`,
  `documents.ts`; see `eval/runs/ui-build-research-and-implementation.md` §7).
- Reason: `ingest-pdf` allows one processing + three pending jobs per workspace
  and a document holds its job until every passage is embedded, so registering a
  multi-file drop in parallel can only ever produce 409s. (This was the root
  cause of the reported "could not be registered" failures.)
- Consequence: multi-file uploads serialise honestly instead of failing; the UI
  never hides back-pressure behind an error. Re-uploading an already-stored file
  is never required to retry registration.
- Revisit if: the backend admits more than one concurrent ingestion per
  workspace, or `ingest-pdf` learns to queue jobs itself.

D55. Chat polish stays metadata-only and honest

- Decision: Pass E adds interaction polish without new backend contracts or
  invented surfaces. Notebook first-question states are driven by the real
  source counts (no sources / none included / N of M included); no example
  questions are offered because the backend generates none. Citation markers
  and cited-source chips navigate to each other and move focus; `/` focuses
  the composer; `Jump to latest` appears only when the reader has scrolled
  away from the bottom; one polite live region announces answer arrival and is
  handed across the `/` -> `/c/<id>` remount by a write-once, memory-only
  module (never replayed). Passage text, excerpts, scores, confidence, staged
  progress, streaming and a Stop button remain explicitly unsupported and are
  not simulated.
- Status: IMPLEMENTED + live-validated (`eval/runs/ui-pass-e-chat-polish.md`:
  32/32 checks, 0 console errors, 0 horizontal overflow 390-1440 px, production
  restored after the selection-toggle and scratch-notebook checks).
- Reason: polish must not create affordances the backend cannot substantiate;
  the UI may only surface what `/ask` and the RLS-scoped tables actually
  return.
- Consequence: the cited-sources list shows every citation the backend
  returned while inline markers appear only where the model wrote them (live
  observation: 8 chips, 4 markers); both numbers are real and the difference is
  documented rather than hidden.
- Revisit if: `/ask` gains the additive passage/evidence text or streaming;
  then the evidence workspace (earlier deferred) can be built honestly.

D56. "Spaces" is the user-facing name; `notebook` is the internal/API name

- Decision: the product concept is called **Spaces** in every user-facing
  surface (navigation, headings, dialogs, empty states, chat copy, page titles,
  screen-reader strings). Database tables (`notebooks`, `notebook_sources`),
  the `notebook_id` field, API types/functions and the `/notebooks` routes keep
  their existing names; the rename is a UX terminology change only. Related
  durable behaviours from the same polish pass: inside a Space workspace the
  global sidebar **auto-collapses as a route-scoped override** (never writing
  the stored preference; expanding there is contextual), the collapsed rail
  gives every interactive icon an immediate tooltip and an accessible name, and
  the Previous Chats drawer exposes title + New question + Close with equal
  targets and deliberate spacing.
- Status: IMPLEMENTED + live-validated (`eval/runs/ui-polish-spaces-sidebar.md`:
  48/48 checks, 0 console errors, 0 horizontal overflow 390-1440 px, production
  restored).
- Reason: users should not have to learn the storage model; an internal rename
  would touch migrations, RLS, RPCs and deployed functions for no user value.
- Consequence: docs and code mix the two vocabularies deliberately — visible
  copy says Space/Spaces, code and API say notebook. Any future backend rename
  would be a separate, explicitly authorised migration.
- Revisit if: the backend itself is ever renamed, or a second UI is built
  directly against these APIs.

D57. Ingestion speed: measured, not changed; 100 MB deferred

- Decision: the 2026-09-17 ingestion audit measured the live pipeline and
  changed nothing. First-upload latency is dominated by the embedding budget
  (24 chunks/min) on the per-minute worker cadence (86 s / 9 chunks, 206 s /
  60 chunks, ~615 s / 226 chunks); parsing, upload and DB writes are seconds.
  No constant was retuned: raising `REQUESTS_PER_TICK` needs Voyage tier
  confirmation (the free-tier assumption is unverified), and lowering
  `CLAIM_IDLE_SECONDS` needs an explicit parse-complete signal first (else a
  mid-parse claim race for large parses). 100 MB/file is rejected under the
  current architecture (256 MB Edge memory vs whole-file parse, 20K workspace
  chunk budget, ~6x DB footprint vs the 500 MB database, ~14 h at 24 chunks/min
  for 20K chunks); the 25 MB / 400 MB limits stand.
- Status: AUDITED (`eval/runs/large-file-ingestion-speed-audit.md` +
  `.json`); no code, migration, deployment or behaviour change.
- Reason: the two obvious one-line wins are each unsafe in isolation
  (provider-limited / race-prone); changing constants on intuition would
  violate the pass's own safety rule.
- Consequence: the smallest future change is parse-complete signal +
  lower claim threshold, as its own authorized deployed step; a Voyage tier
  confirmation unlocks the per-tick budget instead.
- Revisit if: the Voyage dashboard confirms Tier 1+, or the parse-complete
  signal lands.

D58. Immediate post-parse trigger + paced 3 RPM (implemented, undeployed)

- Decision: after durable chunk persistence, `ingest-pdf` fire-and-forgets a
  `{ job_id }` POST to the existing worker URL with the existing
  `x-worker-key` (server-to-server only; never affects the ingest response;
  cron remains the backstop). The worker claims the named `processing` job via
  the same attempts-CAS and runs the same budgeted pass; anything else returns
  idle. Cadence becomes 3 sequential requests/tick ~20 s apart with a 9,500
  per-tick token guard: ≤3 requests in any rolling minute, ≤10K TPM, under the
  confirmed Free Tier (3 RPM / 10K TPM). Batching, validation, write guards,
  retry semantics and all limits are unchanged.
- Status: DEPLOYED + LIVE-VALIDATED (`ingest-pdf` v34, `embed-worker` v30,
  authorized controlled deployment 2026-09-17; locally validated first: deno
  check, 108 unit tests, real-corpus replay with the same 19 requests in
  7 ticks for 226 chunks) — verdict OPTIMIZATION SUCCESSFUL
  (`eval/runs/ingestion-speed-optimization.md`).
- Reason: the first-worker wait was pure polling cadence (durable finalize is
  the parse-complete signal), and 2 RPM voluntarily left one third of the
  confirmed allowance unused.
- Consequence: measured upload→ready 20.2 s (9 chunks, was 86.4 s) and
  194.7 s (60 chunks, was 206.3 s); ~7 min projected for 226 chunks (live
  re-ingest correctly refused by the duplicate guard); max 3 requests in any
  rolling minute with zero 429s; duplicate/retry/failure paths verified live
  on the new code. Deploying further functions needs its own authorization.
- Revisit if: the Voyage tier changes, or a second throughput step is
  authorized (tighter cron cadence would need a fresh RPM/TPM analysis).

D59. Verify live state before acting; never inherit a consequential operational
assumption

- Decision: before any deployment, production mutation, migration, destructive
  action, or any claim that an environment capability is unavailable, establish
  the fact from the live environment — not from reports, handoffs or memory.
  Minimum deployment preflight: CLI availability, one harmless authenticated
  read, project linkage, project ref, currently deployed function versions,
  local function configuration, the deployment mechanism, and whether this
  process can actually perform the operation. Every consequential task reports
  **Before** (verified state), **Action** (what changed), **After** (verified
  state) and **Documentation** (updates for any discovered discrepancy).
  Certainty is labelled: **Verified / Inferred / Historical / Unknown**.
  Historical claims ("credentials unavailable", "project not linked",
  "deployment unavailable", "production state is Y") are unverified until
  rechecked whenever they materially affect the next action. If write
  permission cannot be proven without performing the operation, the exact
  wording is: "Read access is verified; deployment permission is not yet
  verified." — never "no deployment credentials."
- Status: ACTIVE (standing workflow rule). Recorded after a real incident: the
  D58 report and `SESSION_HANDOFF.md` §7 claimed deployment was blocked by
  "no deploy credentials", inherited from the older B3/B6 note "the project is
  not linked". The 2026-09-17 preflight disproved it — CLI v2.117.0 present and
  authenticated through the Windows Credential Manager token, project linked to
  `uqlpfgtkmsaexmtieulp`, read access proven by `supabase functions list`
  (`ingest-pdf` 33 · `embed-worker` 29 · `query-chunks` 29 · `ask` 38 ·
  `storage-cleanup` 1, all ACTIVE; `embed-worker` `verify_jwt=false`).
  Deployment permission remains **unverified** (no CLI dry-run exists; no
  deploy was attempted). Both stale statements were corrected in place.
- Reason: an unverified operational assumption stopped a locally validated
  optimization from proceeding and would have propagated into every later
  session; the cost of the harmless read is seconds.
- Consequence: deployment is blocked only by explicit authorization, not by
  access. The preflight snapshot lives in `SESSION_HANDOFF.md` §9 and is
  recorded/refreshed at substantial-session start and immediately before any
  mutation.
- Revisit if: never — standing rule.

D60. Temporary chat files: conversation-scoped rows in the existing pipeline
(deployed; live-validated)

- Decision: temporary files are ordinary `documents` rows marked by
  (`conversation_id`, `expires_at`); persistent ⟺ both NULL. Initial TTL is
  **24 hours** from registration. Reused unchanged: `ingest_jobs`,
  `chunks`, the Storage bucket and policies, `embed-worker`, `match_chunks`,
  `query-chunks`, `ask`, and the `delete-document` primitive. **No separate
  temporary-file subsystem is created.** Retrieval-time expiry filtering is
  the access boundary; cleanup is hygiene only. Scope is
  **conversation-scoped, not user-private**: any tenant member who can access
  a conversation shares that conversation's temporary retrieval context (the
  pipeline has no per-user secrecy; notebooks work the same way). Temporary
  documents can never become notebook/Space sources unless explicitly
  promoted (database trigger, all roles); promotion is a membership-checked
  server action clearing both columns in place, preserving storage, chunks
  and embeddings with no second copy.
- Status: DEPLOYED (`ingest-pdf` v35, `query-chunks` **v31**, `ask` v39,
  `storage-cleanup` v2; authorized controlled deployments 2026-09-17; migration
  `20260917000004_temp_documents.sql` applied and verified) + unit-validated
  (119/119 shared tests including 11 temp-scope tests; `deno check` clean on
  all touched files except pre-existing errors in untouched code). Live
  validation PASS: Phase 4 re-run (temp-only, union scope_count=2, Space-only),
  Phase 5 full matrix (cross-conversation isolation proven — C2 query excludes
  TEMP-A while unscoped persistent retrieval is byte-identical; cross-tenant
  403/404s; explicit-ID member access preserved; notebook_sources link rejected
  with temp message + 0 rows; TTL-extension and rebinding UPDATEs rejected
  while benign writes succeed; expired replay 400 + excluded from conversation,
  ask citations reference live temp only), Phase 6 (promotion clears scope
  with storage/chunks/embeddings preserved; throwaway-Space attach/retrieval/
  cascade-delete verified), Phase 7 (dry-run classifies expired-temp
  separately; fixtures deleted via `delete-document`; second dry-run finds
  nothing). The earlier Phase 5.1 failure (unscoped fallback scanning temp
  rows) was fixed by the unscoped-exclusion rule and re-proven live. Frozen
  34-case regression re-run (`eval/runs/baseline-20260917T134457Z.json`):
  34/34 HTTP 200 with retrieval metrics bit-identical to baseline
  (0.8824/0.5980/0.7926); gate/label/citation deltas confined to corpus
  evolution (SOP document added after the baseline run) and model generation
  variance — no delta attributable to temp code.
- Reason: the architecture audit demonstrated reuse safe and a parallel
  subsystem strictly worse — it would duplicate ingestion, embedding,
  retrieval-filtering and cleanup while weakening the single set of
  guarantees (deterministic IDs, NULL-guarded writes, attempts-CAS claims,
  whole-batch validation) that make the current path safe.
- Consequence: temp rows count toward all workspace budgets from registration
  (no budget escape on promotion); `notebook_sources` trigger and temp-column
  immutability hold for every role including `service_role`; direct
  promotion-shaped clears remain technically writable but are authorization-
  equivalent to the server action (auditability is the only difference).
- Revisit if: the TTL/product scope changes, or a second throughput step is
  authorized (tighter cron cadence would need a fresh RPM/TPM analysis).

D61. Temporary chat files in the chat UI: conversation-surface attach, no new primitives
(implemented + live-validated 2026-09-17; frontend not deployed)

- Decision: temporary files are exposed in the chat surface only — an attach
  control in the composer plus a strip above it showing each file's real backend
  state, expiry, `promote` ("Save to workspace") and `delete-document`
  ("Remove file"). Attaching before the first question creates the conversation
  through PostgREST under RLS (`conversations_insert_members`) — the one
  conversation write the browser performs; `/ask` still owns messages and
  appends exactly as before. Workspace document reads are persistent-only
  (`expires_at is null`); temporary rows are read by `conversation_id`. No new
  dependency; no backend change.
- Reason: a temporary file is bound to a conversation that must already exist,
  and the natural moment to attach one is before asking. Requiring a first
  answer first would defeat the feature's main purpose; the RLS insert is the
  smallest server-authoritative path (membership-checked, tenant-pinned) that
  avoids inventing an endpoint.
- Consequence: a conversation can exist before its first message (title = the
  first attached file's name) and appears in the sidebar; until conversation
  delete ships, an attachment-created conversation with no messages remains
  ordinary user data. Temporary files never appear as workspace documents;
  promotion is in-place and adding the file to a Space is still the existing
  source-attach step. Live validation: `eval/runs/ui-temporary-chat-files.md`
  (30/30 checks; payload and citation assertions; production restored).
- Revisit if: conversation delete ships (offer cleanup of empty
  attachment-created conversations), or the backend adds an explicit
  conversation-create endpoint (use it instead of the PostgREST insert).

D62. Benchmark-only reranker scaffolding before any Jina embedding work
(benchmark code implemented; no benchmark executed; production unchanged)

- Decision: establish an isolated benchmark rerank contract first: Jina
  `jina-reranker-v3.5` transport with injected calls only, question + chunk
  text as semantic input, locked `top_n = 8`, and mirrored no-rerank/rerank
  modes over the same candidate pool. The provider configuration is separate
  from any future Jina embedding configuration.
- Reason: a reranker must be measurable independently of a changed embedding
  model; otherwise Jina score changes and rerank-order changes cannot be
  distinguished. Isolation avoids Voyage/Jina vector mixing, production RPC
  changes, `chunks.embedding` writes, historical-artifact overwrites, and
  benchmark persistence becoming production state.
- Consequence: Step 3 can add Jina document/query vectors into a separate
  benchmark partition while reusing the same candidate-pool contract and
  rerank/no-rerank comparison. Jina embeddings remain not implemented, and
  production retrieval remains Voyage-only.
- Revisit if: a non-Jina reranker is selected (its contract must pass the same
  provenance/index/top-count/isolation tests), or the benchmark pool needs a
  larger candidate window (current locked pool remains ≤50, final 8).

D63. Benchmark-only Jina embedding/retrieval path (implemented; 34-case run executed, no production change)

- Decision: implement the isolated Jina benchmark path as additive-only
  objects: `benchmark_embeddings` table + `benchmark_match_chunks` mirror
  (migration applied 2026-09-18, verified 0 rows), `benchmark-jina-embed`
  provider adapter (`jina-embeddings-v5-text-small`, passage/query tasks, 1024
  dims, normalized float), a `benchmark-retrieval` Edge function mirroring
  locked selection semantics (deployed v2; empty-scope readiness PASS with zero
  provider calls), a benchmark-only `benchmark-answer` path reusing the exact
  shared gate/prompt/citation/generation semantics with no persistence
  (implemented + tested; `benchmark-answer` deployed v1 in Step 5), and a
  retrieval+answer `eval/run_benchmark.py` with explicit
  provider/model/reranker/run metadata.
  One operator-provisioned `JINA_API_KEY` serves both benchmark adapters;
  production stays Voyage voyage-4; benchmark execution has not happened.
- Reason: a same-chunk, same-question, same-algorithm comparison requires Jina
  vectors in a separate partition with an exact retrieval mirror; anything less
  either risks production contamination or invalidates the experiment.
- Consequence: Step 5 populated one benchmark run (`jina-34case-01`, 226
  mapped-document vectors) and compared retrieval + answer metrics against the
  frozen Voyage control without touching production state, code, or artifacts:
  hit 0.853/0.882 (A/B) vs 0.882 control; recall@8 0.532/0.581 vs 0.598; MRR
  0.753/0.833 vs 0.793; gate match 0.324/0.382 vs 0.441; label match identical
  0.235. Deployed production versions observed during this step (v36/v31/v32/
  v40/v3, redeployed alongside a secrets rotation) are behaviorally consistent
  with repo code per Sep-18 probes, but the experiment depends only on
  repo-locked semantics, not on production bytes. No quality, speed, or
  production conclusions drawn.
- Revisit if: answer/label comparison needs anything beyond the implemented
  benchmark-answer path, or a different embedding model is required (report the
  blocker first; do not substitute silently).

D64. Production embedding stack moved Voyage-4 → Jina v5-text-small + reranker
(deployed; re-embedded; smoke-validated; Voyage vectors preserved for rollback)

- Decision: switch production document/query embeddings to Jina
  `jina-embeddings-v5-text-small` (1024-dim, `retrieval.passage` /
  `retrieval.query`, normalized float, single `JINA_API_KEY` secret) with
  `jina-reranker-v3.5` over the fused pool (`top_n` = final K), keeping dense
  20 / lexical 20 / cap 50 / RRF-60 / final-8, the evidence gate, prompts,
  citation guard, tripwire, correctness checker and Mantle generation
  byte-identical. Voyage vectors are preserved untouched in
  `chunks.embedding_voyage` (migration `20260918000001`); `chunks.embedding`
  keeps its shape, HNSW index and RPC contract. A reranker outage degrades to
  RRF order (`reranked: false`) instead of failing retrieval.
- Status: DEPLOYED (`embed-worker` v32, `query-chunks` v33, `ask` v41; nothing
  else touched) + unit-validated (181/181 shared tests; `deno check`/`lint`
  clean on touched files). Migration verified: 563/563 chunks backed up, then
  re-embedded doc-by-doc (13/226/50/274 chunks; 0 NULL, 1024-dim finite,
  `embedding_model` = Jina on all 4 docs; 8 succeeded jobs, 0 errors). Smoke
  validation PASS on live data: known-factual (direct/SUPPORTED, cited),
  unanswerable (honest non-answer, 0 cites), new 1-page PDF upload → ready in
  11 s → cited answer, same-conversation follow-up; fixtures removed
  afterwards (document + 3 conversations deleted, production counts restored).
- Reason: the frozen Jina benchmark (34-case + real CA corpus) measured
  retrieval at or above the Voyage control with citations intact, and the
  1024-dim shape change needs no schema, index or retrieval redesign — an
  in-place vector swap with a preserved rollback copy is the smallest safe
  migration.
- Consequence: `VOYAGE_API_KEY` stays configured but unused. Rollback while
  the backup column exists: copy `embedding_voyage` back over `embedding`,
  restore `embedding_model`, redeploy pre-migration functions. Do NOT drop
  `embedding_voyage` until rollback is explicitly retired.
- Revisit if: Jina rate behavior degrades at production query scale, or the
  worker pacing budget needs recalibration for the higher envelope.

D65. Worker batch fill for the Jina envelope (pacing cadence unchanged)

- Decision: raise the per-request batch envelope from 12 chunks / 12,000 chars
  to 32 chunks / 32,000 chars and the per-tick token guard from 9,500 to
  30,000 tokens, keeping 3 sequential requests per tick ~20 s apart, the
  per-minute cron, the 45 s claim idle, CAS claiming, and all retry/fatal paths
  byte-identical. Worst-case tick ≈23K tokens/min (≈23% of the documented
  100K TPM, shared with reranking); ≤3 requests in any rolling minute
  (≈3% of 100 RPM).
- Reason: live measurement showed the Voyage-era 36-chunks/tick cap holding
  ingestion to ~18 chunks/min while the Jina envelope sat ~97% idle (0×429
  across 150+ calls); the 32-input batch shape was already proven live by the
  benchmark population path with zero failures. This is the recalibration D64
  anticipated — batch fullness only, no cadence change.
- Consequence: up to 96 chunks per ~2-minute tick cycle (≈3–4× throughput;
  a ~190-chunk document completes in ~2 ticks instead of ~6). Rollback is a
  constant revert + redeploy; no schema, retrieval, or evaluation artifact is
  affected.
- Revisit if: sustained per-tick token totals approach the guard, 429s appear,
  or query/rerank traffic needs a share of the budget reserved.

D66. Second worker pass: 48-chunk batches, same-job continuation, parallel persist

- Decision: (a) `CHUNKS_PER_REQUEST` 32→48, `MAX_CHARS_PER_REQUEST`
  32K→48K, per-pass token guard 30K→40K (3 req/pass and 20 s gaps unchanged);
  (b) one invocation may run up to 2 sequential passes over its SAME claimed
  job (fresh NULL re-read per pass; second pass only after a clean first pass
  and within 100 s of invocation start; ~110 s worst case); (c) per-batch
  persist becomes bounded parallel single-row UPDATEs (≤48 in flight, same
  predicates + non-NULL guard — no bulk statement, no schema change);
  (d) `CLAIM_IDLE_SECONDS` 45→150 s so cron never steals a live invocation
  (trigger path bypasses idle; stuck-job backstop ≤ ~3.5 min).
- Reason: live v33 measurement on a 225-chunk doc (upload→ready 222 s) showed
  Jina ~2–3 s/req (10%) vs sequential UPDATEs ~0.15–0.35 s/chunk (~45%) vs 20 s
  pacing gaps vs 71 s cron idle, plus a cron/trigger overlap at ~t=48 s (idle
  45 s < 50 s tick) wasting one Jina request per large doc. The 48-input shape
  keeps per-request tokens ≈11.5K; two passes span ~110 s so rolling-minute
  usage stays under half the TPM envelope.
- Consequence: same 60-chunk fixture 47 s→31 s (single claim, 2 requests);
  same 225-chunk doc 222 s→102 s in ONE invocation (attempts delta 1, 5
  requests, 0×429, 0 errors, ~135 chunks/min). Small docs stay pacing-bound
  by design (gaps untouched). Rollback is a constant revert + redeploy.
- Revisit if: 429s appear, Jina_48 latency climbs vs Jina_32 (~2 s), Edge
  kills long invocations (>~110 s unproven beyond ~100 s observed), or the
  remaining 20 s gaps become the target of a third pass.

D67. Third worker pass: pacing gap 20 s → 5 s (single constant)

- Decision: `PACED_REQUEST_GAP_MS` 20_000→5_000; every other constant,
  budget, claim/CAS, retry, fatal, persist, and continuation rule unchanged.
- Reason: gaps were ~65% of small-doc and ~60% of large-doc time at v34
  while rolling usage sat at ~35K TPM / ~3 RPM vs the 100K TPM / 100 RPM
  envelope. Worst-case rolling minute is now a full 2-pass invocation
  (6 requests, ≈69K tokens) — thinner margin, still bounded, guard intact.
- Consequence (live, same fixtures): 60 chunks 31 s→15 s (2 Jina reqs,
  single claim); 225 chunks 102 s→41 s (5 reqs in ~40 s, single claim,
  ~355 chunks/min embedding rate). 0×429, Jina latency steady at ~2–3 s,
  0 errors. Small-PDF path: ready 12 s, correct cited answers, honest
  non-answer; production unchanged.
- Revisit if: 429s appear under concurrent load, TPM headroom is needed for
  query/rerank bursts, or gaps need restoring for any reason — revert is one
  constant + redeploy.

