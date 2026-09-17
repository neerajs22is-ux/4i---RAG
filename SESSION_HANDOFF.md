# SESSION_HANDOFF — RAG-4i (fresh-session continuity)

Date: 2026-09-17. Status: **V1 backend LOCKED + post-lock capabilities B1–B6
implemented, deployed and validated; full 34-case pre-UI regression PASSED; UI
exposure and polish done — Pass A/B/C/D (notebooks, source selection, scoped
chat, upload), Pass E (chat polish), the Spaces/sidebar polish pass and the
temporary-file pass (D60, chat-surface attach/promote, 30/30 live checks) built,
validated and exercised in production; the visual review pass NOT started.**
Nothing is committed.

---

## 1. Current objective

RAG-4i is a multi-tenant RAG system that answers only from a workspace's own
documents, with citations, and refuses when evidence is insufficient. V1 is
complete and locked; the post-lock capabilities that unblock a NotebookLM-style
upload/notebook UI are built and validated. **The backend speed upgrade is
complete: the D58 optimization (post-parse trigger + paced 3 RPM) is deployed
(`ingest-pdf` v34, `embed-worker` v30) and live-validated with verdict
OPTIMIZATION SUCCESSFUL. Temporary chat files (D60): migration applied;
`ingest-pdf` v35 / `query-chunks` v31 / `ask` v39 / `storage-cleanup` v2
deployed and live-validated (cross-conversation isolation proven, 34-case
regression PASS). Fixtures removed, production restored. The visual review
pass is on hold until instructed.**

## 2. Source-of-truth hierarchy (and documentation discipline — D53)

1. **Code + migrations** (`supabase/functions/`, `supabase/migrations/`).
2. `ARCHITECTURE.md` **Part 1** (backend) · `UI_ARCHITECTURE.md` (frontend).
3. `DECISIONS.md` (D1–D17 status table, D18–D40 platform, D41–D45 UI,
   D46–D60 post-V1 and later).
4. `SESSION_HANDOFF.md` (this file).
5. `eval/runs/*` reports + machine artifacts.

**Rule (D53):** refresh the relevant documents **within** each pass, before the
next pass starts. Never describe planned behaviour as implemented; label
unverified work as unverified. `ARCHITECTURE.md` Part 2 is historical/superseded.

## 3. Production architecture (current)

Supabase (project `uqlpfgtkmsaexmtieulp`, `ap-southeast-2`) + Edge Functions +
Voyage `voyage-4` (1024-dim) + AWS Bedrock **Mantle** (`ap-south-1`, exclusive
generation path). Detail in `ARCHITECTURE.md` Part 1 and §1.16.

Deployed (all ACTIVE):

| Function | Version | Role |
|---|---|---|
| `ingest-pdf` | **35** | parse/chunk + upload-safety limits (D47) + delete + post-parse worker trigger (D58) + `ingest-temp`/`promote` (D60) |
| `embed-worker` | **30** | cron embedding, batched (D48), direct-claim path + paced 3 RPM (D58) |
| `query-chunks` | **31** | retrieval, notebook/document scope (D50) + conversation temp scope with unscoped temp-exclusion (D60) |
| `ask` | **39** | full quality chain, notebook scope (D50) + conversation temp union (D60) |
| `storage-cleanup` | **2** | bounded orphan cleanup (D52) + expired-temp section (D60) |

Key limits/state: bucket `company-documents` private, `file_size_limit` **25 MiB**
(D51); upload limits 25 MB/400 MB/60 docs/20,000 chunks/1+3 jobs (D47);
retrieval LOCKED (dense 20 / lex 20 / RRF k=60 / final k=8, no threshold) with
the **only** addition being the allowed-document filter; `CORRECTNESS_CHECKER_ENABLED` OFF.

**Production snapshot (2026-09-17, read-only audit):** one tenant; 2 documents —
`incometax.pdf` (78 pages, 433,795 B, `ready`, 226 chunks) and
`Thrine Sales SOP (1).pdf` (7 pages, 160,516 B, `ready`, 13 chunks, uploaded
through the UI after the Pass C fix) — **239 chunks**; 1 notebook (`test`) with
that SOP as a selected source; both ingest jobs `succeeded`. Six Storage objects
have no document row (see the limitations below). The corpus grows through
normal use; treat these numbers as a dated snapshot, not a constant.

## 4. Completed work

- **V1 backend (Phases 1–3D)** — locked, audited (`diagnostic-3d1-v1-lock.md`,
  `diagnostic-3d2.md`).
- **CORS fix (D46)** — browser-facing functions can now be called from the app.
- **B1 batched embeddings (D48)** — 226 chunks in 19 requests / 10.1 min, was ~2 h.
- **B3 upload safety (D47)** — `documents.file_size`, all limits server-side, 28/28 live.
- **B6 storage cap (D51)** — bucket lowered 50 MB → 25 MiB, boundary verified.
- **B4 notebook schema (D49)** — `notebooks`, `notebook_sources` (`selected`),
  `documents.archived_at`, composite tenant-pinned FKs; 22/22 live.
- **B2 notebook-scoped retrieval (D50)** — server-side scope resolution; 16/16
  isolated + 34/34 full-corpus invariant; unscoped retrieval unchanged.
- **B5 orphan cleanup (D52)** — `storage-cleanup` v1; 28/28 live; production
  dry-run found the known `phase3c2` orphan and deleted nothing.
- **Pass A/B/C/D + upload-failure fix** — notebook list/workspace, source
  selection, scoped chat, upload queue with real progress and concurrency-aware
  registration; the reported "could not be registered" failure was diagnosed and
  fixed (D54, report §7). Confirmed by real use: a second PDF was uploaded,
  indexed and attached to a notebook in production.
- **Pass E — chat polish (D55)** — frontend-only. Notebook first-question empty
  states driven by the real source counts (no sources / none included / N of M
  included); "Jump to latest" for long transcripts; citation markers and
  cited-source chips navigate to each other with focus; `/` focuses the
  composer; one polite live region announces answers (handed across the
  `/` → `/c/<id>` remount); single-`h1` semantics inside notebooks. Live
  Chrome/CDP validation with the real account: **32/32 checks, 0 console
  errors, 0 horizontal overflow at 390–1440 px**, production restored after the
  selection-toggle and scratch-notebook checks (`eval/runs/ui-pass-e-chat-polish.md`).
- **Spaces + sidebar polish pass (D56)** — frontend-only, user-facing only:
  the product concept is now **Spaces** everywhere in the UI while tables, API
  fields and routes keep the internal `notebook` names; the global sidebar
  auto-collapses inside a Space as a route-scoped override that never writes
  the stored preference; footer is account directly above expand/collapse at
  the absolute bottom with the collapsed controls exactly centred (36 px
  targets); every collapsed-rail icon has an immediate hover/focus tooltip and
  an accessible name; the Previous Chats drawer gained a titled header with
  equal, separated **+** and **Close** targets; Settings → Retrieval now states
  the behaviour in one sentence with no provider/dimension/RRF/candidate
  internals. Live Chrome/CDP: **48/48 checks, 0 console errors, 0 horizontal
  overflow 390–1440 px**, scoped `/ask` payload verified by request
  interception (same `notebook_id`), selection toggled and reverted, production
  unchanged (`eval/runs/ui-polish-spaces-sidebar.md`). Follow-up fixes after
  review (same report §3): the collapsed rail's two dead decorative icons and
  their unused `collapsed` branches were removed (rail now contains only
  interactive controls), and the Spaces concept uses the `Boxes` container
  glyph everywhere instead of the notebook glyph — re-validated 13/13
  (`eval/runs/ui-polish-spaces-sidebar-fixup-results-20260917.json`).
- **State sync** — `eval/runs/pre-pass-e-state-sync.md` (read-only audit of repo,
  deployment, production and docs).
- **Pre-UI regression** — 34/34 HTTP 200; retrieval bit-identical to the frozen
  baseline; `unscoped == full-corpus scope` on 34/34; **PASS**
  (`eval/runs/pre-ui-regression-34-20260917.md`).
- **Ingestion-speed audit (D57)** — measured, no change: live upload→ready
  86 s (9 chunks), 206 s (60 chunks), ~615 s (226 chunks); bottleneck is the
  24-chunks/min embedding budget on the per-minute worker cadence; 100 MB/file
  rejected under the current architecture; production restored
  (`eval/runs/large-file-ingestion-speed-audit.md` + `.json`).
- **Ingestion-speed optimization (D58)** — deployed (`ingest-pdf` v34,
  `embed-worker` v30, authorized controlled deployment, nothing else touched)
  and live-validated: post-parse worker trigger + paced 3 RPM with token
  guard; upload→ready 20.2 s (9 chunks, was 86.4 s) and 194.7 s (60 chunks,
  was 206.3 s); max 3 requests in any rolling minute, zero 429s;
  duplicate/retry/failure paths verified live; production byte-identical
  afterwards; verdict OPTIMIZATION SUCCESSFUL
  (`eval/runs/ingestion-speed-optimization.md`).
- **Temporary chat files (D60)** — migration applied; `ingest-pdf` v35 /
  `query-chunks` v31 / `ask` v39 / `storage-cleanup` v2 deployed (authorized
  controlled deployments, `embed-worker` untouched) and live-validated:
  Phase 4 re-run (temp-only, union scope_count=2, Space-only), full Phase 5
  matrix (cross-conversation isolation proven live; cross-tenant 403/404s;
  explicit-ID member access preserved; notebook_sources link rejected with 0
  rows; TTL-extension and rebinding UPDATEs rejected while benign writes pass;
  expired replay 400 + excluded from conversation, direct-IDs and ask
  citations), Phase 6 (promotion clears scope with storage/chunks/embeddings
  intact; throwaway-Space attach/retrieval/cascade verified), Phase 7
  (dry-run classifies expired-temp separately; fixtures deleted via
  `delete-document`; second dry-run finds nothing), and the frozen 34-case
  regression (34/34 HTTP 200; retrieval metrics bit-identical 0.8824/0.5980/
  0.7926; deltas confined to corpus evolution + generation variance).
  Fixtures removed; production byte-identical afterwards (2 docs, exact
  attributes, 226+13 chunks).

## 5. Frontend state

`web/` — Next.js 16.3.5 / TS 5 / Tailwind v4 / shadcn on Radix / Motion 13.
Passes 1–3B, the post-3B fixes (typography scale, Previous chats, collapsed
rail, system health, cited-source grouping), the **notebook build (Pass A
foundation, Pass B notebook experience, Pass D source selection)**, **Pass E
(chat polish)**, the **Spaces/sidebar polish pass (D56)** and the
**temporary-file pass (D60/D61)** are implemented and verified — including live
browser validation with production data. Full detail: `UI_ARCHITECTURE.md`,
`eval/runs/ui-build-research-and-implementation.md`,
`eval/runs/ui-pass-e-chat-polish.md`,
`eval/runs/ui-polish-spaces-sidebar.md` and
`eval/runs/ui-temporary-chat-files.md`.

User-facing terminology is **Space/Spaces**; tables, API fields (`notebook_id`),
types and the `/notebooks` routes keep the internal `notebook` names (D56).
Routes include `/notebooks` and `/notebooks/[id]`. No new dependencies were
added (the new primitives wrap the existing `radix-ui` package).

**Upload works** (`/documents` → "Upload PDFs", and "Upload" in the space
sources panel with auto-attach): drag/drop or picker, serial queue, real XHR
progress, cancel, server-truthful failure messages, and a queue that **respects
the backend's one-document-at-a-time ingestion policy** (it waits on real job
state and resumes automatically). A registration can be retried without
re-uploading the file. **Temporary files (D60/D61)** attach from the composer
(conversation-only, 24 h, never a workspace document until "Save to
workspace"), with a real-state strip (processing → ready / failed / expired),
promote and remove; validated live end to end (30/30, temp file cited in the
scoped answer, production restored). **Pass E, the Spaces/sidebar polish pass
and the temporary-file pass are complete; the visual review pass is the
remaining UI work.**

**Upload-failure diagnosis (2026-09-17):** the reported "could not be
registered" had two causes — (1) the queue registered every file immediately
while `ingest-pdf` allows one processing job per workspace (reproduced: 409 for
files 2–4), now fixed as above; (2) a stale dev module graph, because `next
build` was run twice while `next dev` owned `.next`. **Rule: never run
`next build` while the dev server is running** — restart it from a clean
`.next` instead. Full evidence and validation:
`eval/runs/ui-build-research-and-implementation.md` §7.
Four objects the user uploaded before the fix remain in Storage with no
documents (their files; left untouched — re-upload registers normally, or
`storage-cleanup` can sweep them after 24 h).

## 6. Known limitations / pending

- **Frontend error mapping gap:** `413` / `507` are shown through
  `ApiError.detail` (their own envelope message) rather than dedicated kinds;
  `409` maps to `conflict` (D54). A dedicated size/budget kind is still a nicety.
- **Storage health** is designed but not implemented (no architectural change needed).
- **Evidence workspace** (passage text) still needs an additive `/ask` change.
- **Orphan objects in production (6, all left untouched):** the long-standing
  `…/docs/phase3c2/incometax.pdf`; four pre-fix uploads
  (`839aec39…/Thrine-Sales-SOP-1-.pdf`, `81f5a5bb…/d2c-Growth-Engine-Pitch-Deck-1-.pdf`,
  `f62e06ab…/Scaler-AI-Labs-QA-Intern-Assignment.pdf`,
  `287d3cc9…/Income_Tax_Act_2025_as_amended_by_FA_Act_2026-79-145.pdf`); and one
  object left by a diagnostic in a since-deleted test tenant
  (`tenants/509278b8…/docs/f3c8a7c8…/incometax.pdf`). Cleaning any of them needs
  an owner/admin `apply` of `storage-cleanup`; the test account is only a
  *member* of production. B5 scheduling via cron is a deliberate follow-up.
  The four user uploads can simply be re-uploaded through the UI (they register
  normally now) — the old objects are then swept by B5's 24 h rule.
- **`schema_migrations` history** is not updated for the B-series, although the
  project **is** linked (re-verified 2026-09-17); no DB password is available
  locally (the CLI's stored pooler URL carries no password), so migrations were
  applied via the Management API and are recorded as files. They are
  idempotent.
- Streaming, conversation rename/delete, document download: deferred.

## 7. Immediate next action

Temporary chat files are live-validated end to end (D60) including the
frontend pass (D61; 30/30 live checks, production restored). **Do not start
the visual review** until instructed. Refresh the relevant documents inside
each pass (D53).

## 8. Workflow rules

- Loop: **define problem → verify state → targeted audit → small change → local
  test → controlled live test → audit → document → commit → measure → next**.
- **Verify reality before acting (D59):** for deployment, authentication,
  credentials, linkage, schema/data/storage, function versions, provider or API
  capability and frontend/backend contracts, read the current live state with
  the narrowest harmless check before any consequential action. Never inherit
  such an assumption from historical documentation; label claims **Verified /
  Inferred / Historical / Unknown**, and report Before / Action / After /
  Documentation for consequential tasks.
- **Documentation discipline (D53):** update the docs inside the pass.
- **Never revisit rejected repositories** (RAGFlow, PaddleOCR, Ruflo, OpenViking
  server, AGPL UI sources).
- No mocks when validating production behaviour; no invented evidence, scores,
  confidence or reasoning surfaces.
- Never silently substitute a model/provider path; keep frontend/backend
  boundaries explicit; preserve raw evidence and observability.
- Do not modify production based on one unexplained evaluation result.
- One small task at a time; stop at evidence checkpoints.
- Never commit or deploy without explicit instruction.

## 9. Git / deployment state

- Branch `master`, **HEAD `e3a9062`** — **no commits for any B-series work**.
- **Uncommitted (tracked):** `ARCHITECTURE.md`, `DECISIONS.md`, `eval/README.md`
  (doc updates) and `supabase/functions/{ask,embed-worker,ingest-pdf,query-chunks}/index.ts`
  (CORS + B1/B2/B3 changes). Frontend work stays inside the untracked `web/`.
- **Untracked (new):** `SESSION_HANDOFF.md`, `UI_ARCHITECTURE.md`, `.gitignore`,
  `web/` (whole frontend), `supabase/functions/storage-cleanup/`,
  `supabase/functions/_shared/{cors.ts,embed-batch.ts,embed-batch_test.ts,orphan-policy.ts,orphan-policy_test.ts,temp-scope.ts,temp-scope_test.ts}`,
  five new migrations (`*_phase_b3_upload_safety`, `*_phase_b6_storage_file_cap`,
  `*_phase_b4_notebook_schema`, `*_phase_b2_scoped_retrieval`,
  `20260917000004_temp_documents` — applied 2026-09-17 via Management API),
  `eval/mappings/chunk_map_3c3.json`, `chunk_map_3c4.json`, `eval/store_refresh_token.py`,
  `eval/wincred.py`, all `eval/runs/*.md` and run artifacts, `package.json`,
  `research_context/`, `test data/`.
- Backend functions are **deployed** (versions in §3); the frontend is **not deployed**.
- Test account `test@rag.com`; password in the Windows Credential Manager target
  `RAG4I_test_user` (read via `eval/wincred.py`). Never print or commit it.
- **Preflight snapshot (verified 2026-09-17, D59; refreshed post-validation):**
  HEAD `e3a9062`; tracked modifications are the docs plus the CORS/B-series/D58
  functions; untracked additions include the temp-file implementation
  (migration applied 2026-09-17; `temp-scope` module + edits to `ingest-pdf`,
  `query-chunks`, `ask`, `storage-cleanup` deployed as v35/v31/v39/v2); the
  CLI (v2.117.0) is authenticated through the Windows Credential Manager token
  (`LegacyGeneric:target=Supabase CLI:supabase`) and the project is linked to
  `uqlpfgtkmsaexmtieulp`; deployed: `ingest-pdf` **v35** ·
  `embed-worker` **v30** · `query-chunks` **v31** · `ask` **v39** ·
  `storage-cleanup` **v2**, all ACTIVE (`embed-worker` `verify_jwt=false`);
  write permission proven by the authorized deploys themselves; production:
  1 tenant, 2 documents, both `ready` (7 pp / 160,516 B / 13 chunks; 78 pp /
  433,795 B / 226 chunks), 0 temp rows, jobs 2 `succeeded`; temp files
  live-validated end to end (34-case regression PASS; frontend pass 30/30 with
  production restored). Re-establish this snapshot at the start of a
  substantial session and immediately before any mutation.

## 10. Important files

- `ARCHITECTURE.md` (Part 1 = current; §1.16 = B1–B6 + temp D60), `UI_ARCHITECTURE.md`,
  `DECISIONS.md`, `eval/README.md`.
- `eval/cases/gold_cases.json` (34 frozen) · `eval/mappings/chunk_map.json`
  (frozen, older corpus) · `chunk_map_3c4.json` (**live mapping — use this**).
- `eval/run_baseline.py` (frozen harness: `--mapping`, `--sleep`; auth via
  `RAG4I_EVAL_JWT`), reports/artifacts under `eval/runs/`.
- Phase reports: `phase-b1-*`, `phase-b2-*`, `phase-b3-*`, `phase-b4-*`,
  `phase-b5-*`, `phase-b6-*`, `pre-ui-regression-34-20260917.md`,
  `ui-pass-4-upload-storage-architecture.md` (design),
  `ui-pass-1/2/3/3a/3b-*`, `ui-build-research-and-implementation.md`,
  `ui-pass-e-chat-polish.md`, `ui-polish-spaces-sidebar.md`,
  `ui-temporary-chat-files.md`,
  `large-file-ingestion-speed-audit.md`, `ingestion-speed-optimization.md`,
  diagnostics `3c18–3d2`.

## 10.1 Operational caveats

- **Never run `next build` while `next dev` is running** against the same
  `.next` directory: it corrupts the dev server's module graph (this caused a
  real, hard-to-diagnose upload failure). Restart the dev server from a clean
  `.next` instead.
- Supabase Edge logs are retained only briefly (a read-only query during the
  diagnosis found a single row), so reproduce problems promptly rather than
  relying on later log forensics.

## 11. DO NOT DO

- Do not modify retrieval constants, generation, prompts, gates, citation
  semantics, chunking or embeddings.
- Do not change V1-locked behaviour or the B-series limits without an explicit,
  documented decision.
- Do not fabricate evidence text, similarity scores, confidence percentages or
  reasoning/CoT surfaces; do not fake streaming or a Stop button.
- Do not apply destructive cleanup to production; `storage-cleanup` apply is
  manager-only and bounded.
- Do not expose service-role or provider credentials to the browser.
- Do not commit or deploy anything without explicit instruction.
- Do not revisit rejected repositories; do not create mocks to claim validation.
