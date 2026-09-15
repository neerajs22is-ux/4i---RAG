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
#   python eval/run_baseline.py --tenant <uuid> --token <jwt> [--out eval/runs/...]
