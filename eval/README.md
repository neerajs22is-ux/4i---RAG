# RAG-4i Phase 3C.2 evaluation bundle.
#
# Layout:
#   eval/cases/gold_cases.json  — frozen 34-case gold specification (Step 2A).
#   eval/mappings/chunk_map.json — case_id -> production chunk_ids, resolved
#     after ingesting the evaluation corpus through the production pipeline.
#   eval/runs/<run-id>.json     — machine-readable per-case results + summary.
#   eval/run_baseline.py        — stdlib-only runner (no dependencies).
#   eval/map_chunks.py          — deterministic section/page -> chunk mapper.
#
# The runner evaluates the ACTUAL production path (ask endpoint). It never
# reimplements retrieval, gating, or generation. Metrics are deterministic;
# no LLM judge. Paid calls: one Voyage query-embedding + one Mantle answer
# call per case (plus paced sleeps for the shared 3 RPM Voyage budget).
#
# Usage (from repo root):
#   set SUPABASE_URL / SUPABASE_ANON_KEY in the environment (never commit them)
#   set RAG4I_EVAL_JWT / RAG4I_EVAL_REFRESH_TOKEN in the environment (shell-only,
#     never commit them; raw --token is no longer necessary and lands in shell
#     history, so prefer env)
#   python eval/run_baseline.py --tenant <uuid> [--token <jwt>]
#       [--refresh-token <rt>] [--out eval/runs/...]
#
# On HTTP 401 the runner performs at most ONE refresh-grant exchange
# (POST {SUPABASE_URL}/auth/v1/token?grant_type=refresh_token) and retries the
# failed request exactly once. Refreshed access tokens stay process-memory-only
# and never enter result JSON, logs, exceptions, or output. JWT / refresh
# tokens must never be committed (see root .gitignore).
#
# Durable local auth (survives shell/Windows restarts, no plaintext files):
#   one-time init in a shell holding RAG4I_EVAL_REFRESH_TOKEN:
#     python eval/store_refresh_token.py
#   stores it in Windows Credential Manager (DPAPI, per-user vault target
#   RAG4I_eval_refresh_token). Future runs then resolve the refresh token as
#   --refresh-token > RAG4I_EVAL_REFRESH_TOKEN > vault, with no manual login
#   until the refresh token itself expires or is rotated.

--- Latest validated state (2026-09-17) ---
#
# The frozen gold cases and mappings are unchanged. The live mapping for the
# current corpus is eval/mappings/chunk_map_3c4.json (chunk_map.json targets the
# pre-3C.4 corpus) and the runner takes it via --mapping.
#
# Most recent full measurement: eval/runs/baseline-20260917T134457Z.json
# (34/34 HTTP 200; retrieval metrics bit-identical to baseline-001, 0.8824 /
# 0.5980 / 0.7926; gate/label/citation deltas confined to corpus evolution
# and generation variance — see D60).
#
# Completed phases and their reports:
#   3C.17-3C.24  quality chain diagnostics  (eval/runs/diagnostic-3c1*.md, 3c2*.md)
#   3D.1 / 3D.2  V1 lock + hardening audit  (eval/runs/diagnostic-3d1*, 3d2.md)
#   B1  batched embeddings    eval/runs/phase-b1-batched-embeddings.md
#   B3  upload safety         eval/runs/phase-b3-upload-safety.md
#   B6  storage cap           eval/runs/phase-b6-storage-cap.md
#   B4  notebook schema       eval/runs/phase-b4-notebook-schema.md
#   B2  scoped retrieval      eval/runs/phase-b2-notebook-scoped-retrieval.md
#   B5  orphan cleanup        eval/runs/phase-b5-orphan-cleanup.md
#   UI  Pass A/B/C/D + fix    eval/runs/ui-build-research-and-implementation.md
#   UI  Pass E chat polish    eval/runs/ui-pass-e-chat-polish.md
#   UI  Spaces + sidebar      eval/runs/ui-polish-spaces-sidebar.md
#   UI  temp chat files       eval/runs/ui-temporary-chat-files.md (D60; 30/30 live)
#   ingestion speed audit     eval/runs/large-file-ingestion-speed-audit.md (+ .json)
#   ingestion optimization    eval/runs/ingestion-speed-optimization.md (D58; v34/v30 deployed + live-validated)
#   state sync (read-only)    eval/runs/pre-pass-e-state-sync.md
#
# The correctness checker remains OFF; the gold corpus, its mappings and all
# run artifacts above are historical evidence and are never edited.
