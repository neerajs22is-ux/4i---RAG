# Architectural Decisions (RAG 4i – Supabase + Bedrock)

Only the important decisions and their rationale. Analysis date: 2026-09-14.
Companion: `ARCHITECTURE.md`. No application code was implemented alongside these decisions.

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
