# SESSION_HANDOFF — RAG-4i (fresh-session continuity)

Date: 2026-09-17. Status: **V1 backend LOCKED + post-lock capabilities B1–B6
implemented, deployed and validated; full 34-case pre-UI regression PASSED; UI
exposure and polish done — Pass A/B/C/D (notebooks, source selection, scoped
chat, upload), Pass E (chat polish), the Spaces/sidebar polish pass and the
temporary-file pass (D60, chat-surface attach/promote, 30/30 live checks) built,
validated and exercised in production; the visual review pass NOT started.**
Since then: citation excerpts deployed (`ask` v51, verified 7/7 verbatim +
persisted); citation UX shipped three times (`4699f9c` direct marker↔row
navigation, `1f16902` compact rows + excerpts + `[n]`, `d27b057` collapsible
Supporting-evidence disclosure — all live on Vercel); a badge return-to-claim
refinement (1-line excerpts, meta line removed) is implemented and locally
verified, awaiting commit authorization.

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

Deployed (all ACTIVE, verified 2026-10-04):

| Function | Version | Role |
|---|---|---|
| `ingest-pdf` | **40** | parse/chunk + upload-safety limits (D47) + delete + post-parse worker trigger (D58) + `ingest-temp`/`promote` (D60) + D81 hardening + D83 cost gate |
| `embed-worker` | **39** | cron embedding, batched (D48), direct-claim path + paced 3 RPM (D58) + D83 kill switch + provider slot + per-batch usage |
| `query-chunks` | **39** | retrieval, notebook/document scope (D50) + conversation temp scope with unscoped temp-exclusion (D60) + D83 gate/kill/slots |
| `ask` | **54** | full quality chain, notebook scope (D50) + conversation temp union (D60) + citation excerpts (D80) + D83 gate/kill/slots/usage |
| `storage-cleanup` | **6** | bounded orphan cleanup (D52) + expired-temp section (D60) — code unchanged by D83; version lifted by platform redeploys on secret rotation |
| `benchmark-retrieval` | **7** | benchmark path + manager-only (D81) + D83 gate/kill/slots |
| `benchmark-answer` | **5** | benchmark path + manager-only (D81) + D83 gate/kill/slots |
| `benchmark-ingest` | **5** | benchmark path + manager-only (D81) + D83 gate/kill/slots |
| `edit-message` | **3** | NEW: server-authorized edit + truncate (D81) + D83 gate |

(Versions observed post-push 2026-10-04: each `secrets set` triggers a
platform redeploy of ALL functions, so numbers read +2 over the gate's
deploy step with identical source; content re-verified behaviorally.)

Migration `20261001000000` (D81 + D83 §1b) APPLIED 2026-10-04. `PROVIDER_KILL_SWITCH=false` (drill-verified).
D83 live proof: kill 503/zero-records, user-minute 429s, slots busy-503 with
0 stuck, stale reap, member-write 403s, manager benchmark 200, gold 34/34
with 4 in-variance deltas. Full record: `DECISIONS.md` D83.

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
- **Citation excerpts (D80)** — `ask` **v51** (only function deployed):
  `_shared/citation-sources.ts` builds `sources[]` with verbatim `excerpt`
  from the exact retrieved chunk (1:1, numbering/identity unchanged; 5/5 unit
  tests); same array feeds response `citations` and persisted
  `messages.sources` (JSONB, no schema change). Live-verified: HTTP 200,
  7 citations / 4 docs, **7/7 excerpts byte-identical** to query-chunks
  evidence by `chunk_id`, persistence carries excerpts, test conversation
  deleted afterwards. No retrieval/rerank/gate/generation change.
- **Citation UX v1 (`4699f9c`, live on Vercel)** — direct marker↔row
  navigation, `[n]` markers, per-passage rows, no popup/loop; verified 8/8
  round-trips, repeats, themes, reload, 0 console errors.
- **Citation UX v2 (`1f16902`, live on Vercel)** — compact divide-y rows,
  verbatim excerpts with Show more/less, chunk ids unrendered, rank subtle;
  verified with excerpt mapping + backwards-compat reload.
- **Evidence disclosure (`d27b057`, live on Vercel)** — collapsible "Supporting
  evidence" header (`N sources · M documents`, `aria-expanded`), marker click
  auto-opens when collapsed, filename truncation with full title, rank as
  hover-only metadata, user-facing "evidence/sources" (ingestion "passages"
  kept where technically accurate). Locally verified 16/16 (collapse
  717px→34px, keyboard toggle, auto-open nav, repeats, clamp-2, dark, 390px,
  reload, 0 console errors); test conversation deleted.
- **Badge return refinement (uncommitted, this pass)** — the row number badge
  is the return-to-claim button; the "Retrieved source · Back to claim [n]"
  meta line is removed; rank survives only as badge hover title; collapsed
  excerpts clamp to 1 line (rows ~52–73px); excerpt text stays selectable.
  Verified locally (lint/tsc/build + browser); commit not yet authorized.

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

**Citation UX (current):** direct `[n]` marker ↔ evidence-row navigation with
focus/highlight, unique occurrence IDs for repeats, no popup/loop
(`4699f9c`); compact rows with verbatim excerpts + Show more/less, no chunk
ids (`1f16902`); collapsible "Supporting evidence" disclosure with badge
return-to-claim and 1-line excerpt previews (`d27b057` + uncommitted badge
refinement, this pass). Frontend `d27b057` is live on Vercel
(`https://4i-rag.vercel.app/`). Backend excerpts live in `ask` v51 (D80).

**Upload-failure diagnosis (2026-09-17):** the reported "could not be
registered" had two causes — (1) the queue registered every file immediately
while `ingest-pdf` allows one processing job per workspace (reproduced: 409 for
files 2–4), now fixed as above; (2) a stale dev module graph, because
`next build` was run twice while `next dev` owned `.next`. **Rule: never run
`next build` while the dev server is running** — restart it from a clean
`.next` instead. Full evidence and validation:
`eval/runs/ui-build-research-and-implementation.md` §7.
Four objects the user uploaded before the fix remain in Storage with no
documents (their files; left untouched — re-upload registers normally, or
`storage-cleanup` can sweep them after 24 h).

**Public landing page + routing + production CSP fix (uncommitted, this pass):
** `/` is now a public landing page (`web/src/app/(site)/page.tsx` +
`web/src/components/site/*`): real-product hero demo (grounding badge, cited
answer, verbatim evidence rows), the four evidence states, four-step how-it
works, Spaces scoping, implemented-only security claims, CTA and footer.
The application home moved from `/` to `/ask`; nav, sidebar brand,
new-question links and the app error page all point at `/ask`; signed-in
visitors keep the landing (no redirect — the entry action switches to
"Open workspace") so the page stays reachable for everyone. Metadata +
generated OG image + brand `icon.svg` added. **During verification a pre-existing production incident was
found and fixed with authorization:** the D81 CSP (`script-src 'self'` in
`next.config.ts`) blocked all of Next.js's inline hydration scripts — the
deployed app (and local HEAD) could not hydrate; sign-in and the entire chat
UI were dead in production. The policy now lives in `src/proxy.ts` with a
per-request nonce (`script-src 'self' 'nonce-…' 'strict-dynamic'`), the root
layout passes the nonce to `next-themes`, and all other security headers stay
in `next.config.ts`. Trade-off (accepted): document routes are dynamically
rendered under nonce CSP instead of static. Live Chrome/CDP verification
(production build): sign-in renders, real `/ask` answered with grounding +
8 evidence rows + 10 citation markers (test conversation deleted 204),
sign-out returns to sign-in, signed-in `/` → `/ask`, theme toggle works,
0 console errors, 0 horizontal overflow at 390–1440 px; light + dark
full-page screenshots captured. Nothing committed or deployed; backend
untouched.

## 6. Known limitations / pending

- **Frontend error mapping gap:** `413` / `507` are shown through
  `ApiError.detail` (their own envelope message) rather than dedicated kinds;
  `409` maps to `conflict` (D54). A dedicated size/budget kind is still a nicety.
- **Storage health** is designed but not implemented (no architectural change needed).
- **Evidence excerpts are live** (`ask` v51, D80) — the former "needs an
  additive `/ask` change" gap is closed; rows render excerpts when present and
  degrade cleanly on pre-excerpt rows.
- **Test-account credential entry is unstable:** the `RAG4I_test_user` blob has
  changed shape twice (60-byte JSON ↔ 14-byte non-JSON) and its username label
  currently disagrees with the working admin email. Sign-in works with the
  stored entry as of 2026-09-29 verification, but re-check the entry (shape +
  a real sign-in) before the next browser session instead of assuming it.
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
frontend pass (D61; 30/30 live checks, production restored). **Step 2 is
complete:** benchmark-only `jina-reranker-v3.5` scaffolding is implemented and
unit/lint/type-tested (D62). **Step 3 is complete:** the isolated Jina
benchmark embedding/retrieval path is implemented and tested (41/41 unit tests;
D63) — additive migration authored but NOT applied, functions NOT deployed,
Jina/Voyage/benchmarks NOT run, production untouched. **Step 4 is complete:**
the benchmark-only answer path (exact shared gate/prompt/citation/generation,
no persistence) is implemented and tested (50/50 unit tests); the benchmark
migration is APPLIED (table+mirror exist, 0 rows); `benchmark-retrieval` is
DEPLOYED (v2; empty-scope readiness PASS, zero provider calls);
`benchmark-answer` is implemented but NOT deployed per the deploy-only
allowlist. No benchmark executed; production untouched. **Step 5 is complete:**
`benchmark-answer` deployed (v1); one benchmark run (`jina-34case-01`, 226
vectors) populated and verified; all 34 cases executed for A (no rerank) and B
(reranked) against the frozen Voyage control with production verified
unchanged afterwards. **CA-corpus audit complete (read-only):** the SEBI AIF
Regulations document is verified live (100 pp / 1,094,459 B / 274 chunks, all
`ready` with vectors + tsv); chunk distribution clean (0 empty, 0 duplicates,
0 missing pages); suitable for a 25–40-case gold set; no questions, runs, or
mutations made. **CA gold set frozen:** 32 cases
(`eval/cases/gold_cases_ca.json`) with content-grounded mappings
(`eval/mappings/chunk_map_ca.json`, 0 unresolved), validation PASS; runner +
benchmark retrieval now capture per-stage timing (embed/RPC/fusion/rerank,
query/rerank tokens) for the CA run. **CA benchmark executed:** fresh run
`jina-ca-32case-01` (274 vectors verified) over all 32 cases — A no-rerank
(hit 0.844, MRR 0.828), B reranked (hit 0.906, MRR 0.891); production verified
unchanged; no ranking or production decision made. **Provider-decision audit
complete (evidence only):** both frozen runs consolidated with timing, token
economics, migration surface, risks, and a scoreless decision matrix; awaiting
the human production decision. Consolidated benchmark report:
`docs/JINA_VS_VOYAGE_BENCHMARK_REPORT.md` (16 sections, no selection made).
**Production Jina migration complete (D64):** `embed-worker` v32 /
`query-chunks` v33 / `ask` v41 deployed (nothing else touched); Voyage vectors
preserved in `chunks.embedding_voyage` (migration `20260918000001`); all 563
chunks re-embedded doc-by-doc (0 NULL, 1024-dim finite, Jina model on all 4
docs); smoke validation PASS (factual/cited, honest refusal, new-PDF upload →
ready in 11 s, follow-up) with fixtures removed. Rollback available while the
backup column exists. **Worker batch-fill (D65):** `embed-worker` v33 raises
per-request batches to the benchmark-validated 32 inputs / 32K chars with a
30K-token tick guard (3 req/tick, 20 s gaps, cron/claim/retry unchanged);
live-validated on a 60-chunk fixture (upload→ready 47 s vs 195 s before, single
triggered tick, 0 errors, fixture removed). **Second worker pass (D66):**
`embed-worker` v34 (48-chunk batches, 2-pass same-job continuation ≤ ~110 s,
bounded parallel persist, claim idle 150 s); 60-chunk fixture 47 s→31 s,
225-chunk doc 222 s→102 s in ONE invocation (5 Jina reqs, 0×429, ~135/min);
production verified unchanged, fixtures removed. **Third worker pass (D67):**
`embed-worker` v35 (pacing gap 20 s→5 s, nothing else); 60-chunk 31 s→15 s,
225-chunk 102 s→41 s (~355/min, 0×429); production verified unchanged,
fixtures removed. **Documents progress UI (uncommitted):** `DocumentsView`
polls while pending (5 s, transitions announced) and shows live `X / Y
chunks` + bar via new `DocumentProgress` (`countTotalChunks` /
`getDocumentStatus` reads, no backend change); `UploadPanel` done-rows track
their own embedding state; truth-probe 0%→80%→87%→100% + corrupt-PDF failure
path verified live, fixtures removed. **H1 pre-RAG router (D68, deployed):**
`ask` v43 calls `_shared/pre-rag-router.ts` after conversation resolution;
pure conversational messages get a fixed reply and bypass
embedding/retrieval/rerank/gate/generation; greetings carrying content and all
other queries take the unchanged RAG path (fail closed). Smoke A–D + warm
(1.4–2.0 s vs 9–12 s) ALL_PASS; 187/187 shared tests; frontend label mapping
added (`conversational`, committed with H1). **H2A guards (D69, deployed):**
`query-chunks` v34 / `ask` v44 — rerank skipped when fused pool ≤ final K
(narrow scopes; normal pools still rerank), dual-empty/conflict take the
existing terminal paths, retrieval is one round with zero expansions
(recorded per request as `retrieval: {rounds, expansions, rerank}`);
smoke A–F ALL_PASS (narrow doc skipped with rerank_ms 0, ~605 tokens
ESTIMATED avoided; conflict + refusal verified; fixtures removed). 197/197
shared tests (10 new). **H2B telemetry (D70, deployed):** `query-chunks` v35 /
`ask` v45 — per-turn `telemetry` (router/retrieval/embedding/rerank/evidence/
generation/checker) returned and persisted in `messages.timings.telemetry`;
token bases measured/calculated/estimated/unknown, never fabricated. Live:
rerank usage measured 4.5–4.7K tokens (full pool), skip = calculated zero,
generation measured, H1 bypass all zeros. 216/216 shared tests. **H2C rerank
audit (D71, no change):** rerank input is raw chunk text only (N=20,
16.6–19.1K chars); measured 4.3–4.8K Jina tokens (215–240/candidate); query
≤1.2%; zero duplicates/wrapper/metadata — no safe representation optimization
exists; quality-sensitive alternatives documented, nothing deployed or
changed. **H3A conversation context (D72, deployed):** `ask` v46 reads ≤4
recent messages (verified conversation only) and records a deterministic
STANDALONE/FOLLOW_UP/UNKNOWN signal + bounded context flags in
`telemetry.context`; no RAG behavior change, no reuse/rewrite yet; smoke A–G
ALL_PASS (233/233 shared tests, 17 new). **H3B bounded rewrite (D73, deployed):**
`ask` v47 — FOLLOW_UP + not-self-contained → at most ONE Mantle rewrite call
(`rewrite-v1`, temp 0, 160 tokens max, no retry, strict validation, fallback
to original); rewritten query is retrieval-only, original question stays
authoritative for gate/generation/citations/persistence; telemetry
`context.rewrite` with measured tokens; smoke 16/16 ALL_PASS (207/13 tokens,
285 ms per applied rewrite), 251/251 tests; 3-pair eval no regression but no
improvement claim. **H3C-A reuse audit (D74, no change):** `messages.sources`
reconstructs safely (live test 6/6 sampled turns, 8 sources each, 0 missing,
0 page mismatches); gate/generation/citations verified compatible (content +
file/page + ids only); deterministic fail-closed predicate + 17 tests in
unwired `_shared/evidence-reuse.ts`; eligible reuse would avoid measured
embed 4–15 tokens / 335–390 ms and rerank 4,495–4,789 tokens / 397–458 ms;
recommended H3C-B contract recorded (gate on prior evidence, INSUFFICIENT →
unchanged fallback). **H3C-B reuse (D75, deployed ask v48):** FOLLOW_UP +
valid prior evidence + gate ≠ INSUFFICIENT → generate from reconstructed
evidence, skipping rewrite/retrieval/embedding/rerank; everything else
(invalid/gate-fail/non-follow-up) takes the unchanged path. Live: used cases
(8 chunks, rounds 0, cited answer AND an honest 0-cite non-answer on a
tangential pair — gate SUPPORTED is necessary but not sufficient, caveat
recorded); fallback + malformed rejection verified; 273/273 tests (5 new).
**H3D reuse evaluation (D76, audit only):** 12-case exploratory set
(`eval/cases/followup_h3d.json`, separate from frozen benchmark); PATH B vs
PATH A — TRUE SAFE 2, CORRECT FALLBACK 4, FALSE REUSE 6 (tangential-mention
pass, 0/8 evidence overlap, honest non-answers; no hallucination/breach),
FALSE REJECTION 0; no deterministic signal separates safe from false; costs
measured per factor (used turns skip ~4.3–6.1K rerank tokens); telemetry
adequate, nothing new needed; v48 unchanged but experimental, rollback lever
documented. **H3D-SELECTIVE reproduction (6 cases, no code change):** all six
prior outcomes reproduced — A1 safe reuse stable; A2/C1/E1/F1 false reuse
stable (tangential-mention pass; C1/E1/F1 0/8 overlap, A2 3/8); B1 fallback
stable. Refinement: evidence overlap separates in neither direction (safe A1
also 0/8), so no deterministic rule can be built from it; no new failure
mode. **H3E gold set + sufficiency (D77, audit only):**
`eval/cases/followup_gold_h3e.json` (14 cases, required facts, separate from
frozen benchmark); PATH B vs PATH A — TRUE SAFE 5, CORRECT FALLBACK 1+4,
FALSE REUSE 7 (tangential-mention pass; 0/8 overlap in 6/7), FALSE REJECTION 0,
AMBIGUOUS 1; gate-vs-gold: sufficient 5/5 reusable, insufficient 7/8 reusable
(E-ii proves phrase-presence ≠ entity attribution); no signal separates safe
from false, no rule proposed; costs per factor; 273/273 green. **H3F offline
judge study (D78, audit only):** local qwen3-1.7b, 3 variants × 14 cases —
best (checklist) 13/14 then 12/14; adds info over gate on 6 tangential cases
but STABLY fails the critical entity-confusion case (I-i ×3), flips a safe
case across runs, confabulates once, blows output budget on ambiguity;
~2.3K in/~0.4K out tokens, 2–10 s latency (exceeds the gated work).
Classification: C. NOT PROMISING at evaluated scale (scoped: 1.7B judge, not
semantic judgment in general); no implementation. **H3C-B ROLLBACK (D79,
deployed ask v49):** experimental reuse removed from the production path —
FOLLOW_UP → H3A context → H3B rewrite → query-chunks → gate → generation
restored; smoke 9/9 ALL_PASS (incl. ex-reuse pair now citing 5 sources);
`evidence-reuse.ts` retained unwired as evaluation history; no other function
touched. **Citation excerpts (D80, deployed ask v51):** `sources[]` carry
verbatim `excerpt` (7/7 byte-identical live, persisted, fixture deleted).
**Evidence disclosure UI (verified locally 16/16, checkpoint commit pending):**
collapsible Supporting-evidence header, auto-open on marker click, truncated
filenames, hover-only rank, evidence/sources terminology. **Next:** checkpoint
commit (excerpt backend source + disclosure UI + this doc pass), push, Vercel
auto-deploy, live smoke test. **Do not start
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

- Branch `main`, **HEAD `2dfd12e`** (`feat(chat): add safe user message
  editing`, 2026-09-30; prior doc claim `d27b057` was stale — corrected
  here. Deployed frontend version unverified; Vercel previously served
  `d27b057`, both `4i-rag.vercel.app` and `ask4i.in` observed live 2026-10-01
  on one identical deployment).
- **Uncommitted (tracked, security remediation, NOT authorized to commit):**
  `ARCHITECTURE.md`, `DECISIONS.md` (D81), `SESSION_HANDOFF.md` (this pass),
  `web/next.config.ts`, `web/package.json`, `web/package-lock.json`,
  `web/src/components/chat/answer-content.tsx`,
  `web/src/components/chat/chat-view.tsx`,
  `web/src/components/chat/conversation-files.tsx`,
  `web/src/lib/api/conversations.ts`,
  `supabase/functions/{ask,query-chunks,ingest-pdf,edit-message,storage-cleanup,
  benchmark-answer,benchmark-retrieval,benchmark-ingest}/index.ts`,
  `supabase/functions/_shared/{cors,grounding,grounding_test}.ts`,
  plus pre-existing `web/src/components/chat/request-status.tsx` (untouched
  by remediation; was dirty before) and the badge refinement in
  `assistant-message.tsx` (still pending from the prior pass).
- **Committed `ceddea7` (pushed 2026-10-04):** D81/D82/D83 code + migration +
  docs (34 files). Post-commit drift fix pending (this doc + ARCH §1.15/§1.17
  version numbers only) — see below.
- **P0 final state (2026-10-04, post-push `ceddea7`):** migration applied,
  8 functions deployed + live-verified (kill drill, 429/busy, reap,
  member-write denials, manager benchmark, gold 34/34), probe + gold
  conversations deleted (verified zero), kill switch OFF (re-verified by
  200 probe), no test credentials in repo, benchmark artifacts left
  unstaged. Open verification gaps (need 2nd credential/tenant or expensive
  trips — all BLOCKED, none faked): non-manager benchmark deny, cross-tenant
  proof, tenant-minute/daily + user-daily live trips.
  **Untracked (pre-existing, leave alone):** `brag-output*/`, `deno.lock`,
  `eval/cases/followup_*` golds, `supabase/functions/_shared/evidence-reuse*.ts`
  (H3C-B history, still unwired — verified, no imports added), `super-video-maker-skill/`.
- Backend functions are **deployed** (versions in §3; `ask` v51 source was
  reconciled in `d27b057`); the frontend `d27b057` is **deployed on Vercel**.
- Test account `test@rag.com` is RETIRED — forget it fully. Working admin
  account is `neeraj2016year@gmail.com` (role admin); password in the Windows
  Credential Manager target `RAG4I_test_user` (read via `eval/wincred.py` as
  `{"email","password"}` JSON). Never print or commit it.
- **Preflight snapshot (verified 2026-09-29, D59):** HEAD `d27b057`; working
  tree holds one uncommitted refinement (`assistant-message.tsx` badge return)
  plus this doc pass — commit NOT authorized; the CLI (v2.117.0) is
  authenticated (Owner account; `functions list` works) and the project is
  linked to `uqlpfgtkmsaexmtieulp`; deployed: `ingest-pdf` **v37** ·
  `embed-worker` **v36** · `query-chunks` **v36** · `ask` **v51** ·
  `storage-cleanup` **v4**, all ACTIVE; production Q/A smoke tests create real
  conversations — delete them afterwards via PostgREST (verified working:
  DELETE 204 + zero messages remain). Re-establish this snapshot at the start
  of a substantial session and immediately before any mutation.

## 10. Important files

- `ARCHITECTURE.md` (Part 1 = current; §1.16 = B1–B6 + temp D60; §1.17 = P0
  cost controls D83, implemented NOT deployed), `UI_ARCHITECTURE.md`,
  `DECISIONS.md` (see D83), `eval/README.md`.
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
