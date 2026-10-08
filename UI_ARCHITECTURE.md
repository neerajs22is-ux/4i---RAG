# RAG-4i — UI Architecture

Status: **UI Passes 1–3B, the post-3B fixes, the notebook build (Pass A
foundation, Pass B notebook experience, Pass C upload, Pass D source selection),
Pass E (chat polish), the Spaces/sidebar polish pass, the temporary-file pass
(D60), the citation/evidence refinement, the chat-layout + answer-reveal pass,
the RAG-4i brand colour system and the public landing page (unauthenticated
entry) are implemented and verified. The dedicated visual review pass is NOT
started.**
This file is the source of truth for the **frontend only**.

The design system (§9) is the RAG-4i brand token set: an Onyx / Jet Black /
Platinum neutral foundation with Bright Gold as the primary accent and Saffron
as the secondary warm accent.

Terminology (D56): user-facing copy says **Space/Spaces** for the product
concept; tables, API fields (`notebook_id`), types, functions and the
`/notebooks` routes keep their existing internal names.

- Backend / RAG architecture: `ARCHITECTURE.md` Part 1 (V1 LOCKED, plus the
  post-lock capabilities B1–B6 in §1.16).
- Decisions, including UI boundaries D41–D45 and the B-series D46–D53:
  `DECISIONS.md`.
- Session continuation state and next action: `SESSION_HANDOFF.md`.
- Per-pass reports: `eval/runs/ui-*.md` and `eval/runs/phase-b*.md`.

Scope rule: this document describes the interface layer. It does **not** restate
retrieval, generation, gate, checker or deployment facts — those live in
`ARCHITECTURE.md` and must not be duplicated or reinterpreted here.

## Status legend

| Tag | Meaning |
|---|---|
| **IMPLEMENTED** | Code exists in `web/` and compiles/builds. |
| **VERIFIED** | Exercised in a browser and measured (typecheck, lint, build, responsive, console, unauthenticated gating). |
| **UNVERIFIED** | Implemented, but the decisive check needs a real signed-in session and has **not** been run. |
| **PENDING** | Planned, not started. |
| **DEFERRED** | Blocked on a prerequisite, or deliberately postponed. |
| **NOT SUPPORTED** | The backend cannot do it; the UI must not fake it. |

## 1. Stack and conventions

| Area | Choice |
|---|---|
| Framework | Next.js **16.3.5**, App Router, Turbopack, `web/` is its own npm project (not a monorepo). |
| Language | TypeScript 5 (strict), path alias `@/*` → `src/*`. |
| Styling | Tailwind CSS **v4** via `@tailwindcss/postcss`. Design tokens as CSS variables in `src/app/globals.css`; no `tailwind.config.js` (v4 CSS-first). |
| Components | shadcn/ui built on the unified `radix-ui` package. 14 primitives in `src/components/ui/`: badge, button, card, dialog, hover-card, input, label, popover, scroll-area, separator, sheet, skeleton, textarea, tooltip. |
| Class utilities | `cn` package (shadcn v4 canonical). `class-variance-authority` for variants. |
| Motion | `motion` (Motion 13) with a project vocabulary in `src/lib/motion.ts` and five primitives in `src/components/motion/primitives.tsx`. Every animation has a reduced-motion fallback. |
| Icons | `lucide-react` (stroke, one family, no mixing). |
| Theme | `next-themes`, class strategy, light + dark both verified. |
| Data | `@supabase/supabase-js` browser client only. |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-sanitize`. |

Scripts (`web/package.json`): `dev`, `build`, `start`, `lint` (ESLint). There is
**no test script and no automated test suite** — verification is typecheck,
lint, `next build`, and measured browser checks.

`web/README.md` is still the stock `create-next-app` boilerplate and is not a
source of truth.

## 1.1 Dependency decisions

No dependency was added for the Space, source-selection, upload or polish work;
the frontend still runs on the stack in §1. Choices made during the research pass
(full reasoning in `eval/runs/ui-build-research-and-implementation.md`):

- **Vaul / shadcn `Drawer` — rejected.** Unmaintained, documented iOS-PWA
  pointer/scroll defects, and shadcn is migrating the drawer to Base UI. Mobile
  panels use the project's Radix `Sheet` (`side="bottom"`).
- **Magic UI / Aceternity / React Bits — rejected.** Landing-page effect
  libraries (gradients, beams, glows) that conflict with the product direction
  and would add a second motion language.
- **react-dropzone — rejected after evaluation in Pass C.** The surface needs
  one `accept="application/pdf"` picker plus a queue; the accessible pattern
  (labelled `role="button"` dropzone + real `input[type=file]`) is ~30 lines.
- **Sonner — rejected.** Upload feedback belongs next to the file it concerns;
  inline rows and `role="alert"` already cover it.
- **Number Flow / ldrs — rejected.** No counters or alternate spinner language
  needed; `Skeleton`/`Loader2`/`shimmer` cover the honest loading states.

## 2. Directory map

```
web/
  .env.local          git-ignored; publishable key + project URL only
  .env.example        documented template
  src/app/
    layout.tsx        fonts, metadata, providers, theme
    globals.css       design tokens + base layer
    not-found.tsx     branded 404
    showcase/page.tsx dev-only design-system QA route
    (app)/
      layout.tsx      AuthGate + application shell
      page.tsx        new conversation (chat)
      loading.tsx | error.tsx
      c/[id]/page.tsx existing conversation (chat)
      documents/page.tsx
      settings/page.tsx
  src/components/
    auth/ chat/ documents/ foundation/ motion/ providers/ settings/ shell/ ui/
  src/lib/
    api/ chat/ supabase/ | format.ts motion.ts sidebar-state.ts
```

## 3. Routing

- `/` — **public landing page** (`(site)` route group; server-rendered) for
  everyone, signed in or not. The entry button adapts per session ("Sign in" /
  "Open workspace"; `components/site/entry-action.tsx`) instead of redirecting
  signed-in visitors away, so the page stays reachable and linkable. The page
  never renders protected state.
- `/ask` — new conversation (the application home). Created only when the
  first answer is persisted.
- `/notebooks` — **Spaces** browse surface (internal route): cards with real
  source counts, create, delete.
- `/notebooks/[id]` — **Space workspace** (internal route): sources pane + scoped
  chat. The chat sends `notebook_id`; the backend resolves the allowed document
  set (D50).
- `/c/[id]` — existing conversation, keyed by id so switching remounts state.
- `/documents` — ingestion list, status, retry, delete.
- `/settings` — account card (identity, workspace, theme) and the read-only
  product behaviour cards.
- `/_not-found` — branded 404.
- `/showcase` — design-system QA route; **dev-facing, not part of the product**.
  Removal/relocation is PENDING.

All product routes live in the `(app)` group and are gated. The shell renders one
scroll region per page; navigation never performs a full reload.

### 3.1 Public landing page (new)

The unauthenticated entry experience: `web/src/app/(site)/page.tsx` composed of
`web/src/components/site/*` — nav, hero (with a faithful, static replica of the
real answer surface: question, grounding badge, cited answer, verbatim evidence
rows), the four evidence states, a four-step how-it-works, Spaces scoping,
security boundaries, closing CTA and footer. The evidence and security sections
carry their own product figures: a refusal fragment (the backend's exact
`REFUSAL_TEXT` constant) plus the claim → passage marker pairing, and a
workspace-isolation diagram drawing the implemented row-level-security
boundary. Copy is limited to implemented
behaviour (no logos, testimonials, statistics or certifications are invented;
refusals are presented as the product behaviour they are). One reveal
orchestration (`site-reveal`/`answer-reveal-in` in `globals.css`) runs the demo
card cascade question → answer → evidence at first paint; it works without
JavaScript, respects reduced motion, and no other section animates. The demo
content is labelled as an illustration.

Routing: the application's new-conversation route moved from `/` to `/ask`
(nav config, sidebar brand, new-question links and the app error page all point
at `/ask`). `/` serves the landing for everyone; signed-in visitors keep the
landing (no redirect) and the entry action switches to "Open workspace"
(`components/site/entry-action.tsx`). Metadata (title, description, Open
Graph), a generated OG image and a brand `icon.svg` live beside the page.

**CSP note (same pass):** the CSP added in the D81 hardening
(`script-src 'self'` in `next.config.ts`) blocked Next.js's inline hydration
scripts in production — the sign-in screen and the whole client surface never
mounted. The policy now lives in `src/proxy.ts` with a per-request nonce
(`script-src 'self' 'nonce-…' 'strict-dynamic'`), and the root layout passes the
nonce to `next-themes`. Using a nonce means document routes render per request
(dynamic rendering) instead of being statically prerendered; that trade-off is
accepted to keep an enforcing CSP. Other security headers are unchanged in
`next.config.ts`.

## 4. Auth and session flow

IMPLEMENTED (Pass 3A) and VERIFIED end-to-end in a real browser with the
dedicated test account (§11).

1. `SessionProvider` resolves the Supabase session, subscribes to
   `onAuthStateChange`, then loads the user's `memberships` and resolves a
   workspace (the active one is persisted per user).
2. `AuthGate` renders exactly one state: not-configured → starting → sign-in →
   workspace-loading → no-workspace → workspace-error → ready. Protected DOM is
   never rendered before resolution.
3. `SignInForm` uses email + password and maps provider errors to plain
   language.
4. Every API call attaches `Authorization: Bearer <session JWT>` and the
   publishable `apikey`. The backend re-validates identity, membership and
   `tenant_id`; RLS remains the authorization boundary.
5. A 401 triggers **one** refresh + retry, then an `auth` error.

Boundary: the frontend is not a security boundary. It never sees a service-role
key, a provider key, or another tenant's data.

## 5. API layer

`src/lib/api/` is the only path from UI to backend.

| Module | Responsibility |
|---|---|
| `client.ts` | `callFunction`, `ask`, `queryChunks`; adds auth headers; single refresh-on-401 retry; `CallFunction` is the single transport for every Edge Function call. |
| `types.ts` | Response/row contracts: `AskResponse`, `AskCitation`, `GateInfo`, timings, model block, tripwire, correctness, conversation/message/document/ingest rows, `membership`, `tenantName`. |
| `presentation.ts` | Maps backend vocabulary to UI language: `EvidenceState` (supported / partial / conflicting / insufficient), `AnswerOutcome`, `outcomeFor`, `hasGroundingCaution`, `sourceSummary`, `provenanceSteps`, `provenanceModel`, `stateForLabel`, `citationsFromSources`, `provenanceFromTimings`, `groundedFromTimings`. |
| `errors.ts` | `ApiError` + 9 kinds: `auth`, `authorization`, `validation`, `not-found`, `throttled`, `backend`, `network`, `config`, `unknown`; PostgREST errors normalized too. |
| `conversations.ts` | Conversation + message reads, and `createConversation` — the one conversation write the browser performs (temporary-file attach, D61); `/ask` still owns messages. |
| `documents.ts` | Persistent document/ingest-job reads (temporary rows excluded), `listConversationFiles`, `ingestTempDocument`, `promoteDocument`, `retryIngest`, `deleteDocument`. |
| `notebooks.ts` | Notebook CRUD, source list/attach/detach, `setSourceSelected`, `listNotebookSummaries`. PostgREST under RLS; no notebook endpoint exists (the tables are the API, D49). |
| `upload.ts` | The only browser write: a PDF into the tenant's Storage prefix over XMLHttpRequest for **real** upload progress; PDF/size validation; Storage errors translated. Client limits are early feedback only — the bucket and `ingest-pdf` are authoritative. |
| `documents.ts` (`countActiveJobs`) | Head count of pending/processing jobs under RLS. The upload queue uses it to respect the real concurrency policy before registering. |

Rules:

- Conversation and notebook read/write goes through PostgREST under RLS; only
  `/ask` and `query-chunks` go through Edge Functions.
- `ask` and `queryChunks` accept an optional `notebookId`, sent as
  `notebook_id`. The browser never sends a document list of its own.
- Temporary files are shown from `documents` reads scoped by `conversation_id`;
  the browser sends only the conversation id and never an expiry or scope
  value. Promotion and removal are the deployed `ingest-pdf` actions.
- No mock transport, fixture or fallback data exists in any production path.
- No provider (Mantle, Voyage) call is reachable from the browser.

## 6. Application shell

IMPLEMENTED (Pass 2; footer, tooltips and Space auto-collapse in the polish
pass). VERIFIED for layout/responsive/unauthenticated behaviour.

- Sidebar: 248 px expanded / 56 px collapsed rail, persisted per user
  (`lib/sidebar-state.ts`); real conversation list with an explicit empty state.
- **Contextual collapse (D56):** inside a Space (`/notebooks/<id>`) the desktop
  rail auto-collapses through a route-scoped override that never writes the
  stored preference; expanding there lasts only for that visit, and leaving the
  Space restores the user's own preference. The mobile drawer is unaffected.
- **Footer:** the account control sits directly above the expand/collapse
  control at the absolute bottom; collapsed, both are square 36 px targets
  centred by the flex column (measured offset ≤ 0.5 px), expanded they are
  full-width rows with labels.
- **Collapsed-rail tooltips:** every interactive icon renders an immediate Radix
  tooltip (hover **and** keyboard focus, `delayDuration={0}`) plus an accessible
  name via `components/shell/rail-tooltip.tsx`; the expanded rail shows no
  tooltips because labels are visible.
- **Collapsed-rail contents:** only interactive controls (brand, Previous chats,
  the four nav items, account, expand) — no decorative placeholders and no empty
  section dividers. The Spaces concept renders the `Boxes` container glyph in
  the nav, the sidebar list, the Spaces page and the Space header; no notebook
  glyph remains (D56).
- Top bar: breadcrumb, workspace context, theme toggle, route transition sheen.
- Mobile: sidebar collapses into a drawer (`sheet`), reachable from the top bar.
- `PageFrame` / `PageHeader` / `EmptyState` / loading skeletons / error
  boundaries give every route the same skeleton and states.
- One scrolling region per page; sticky chrome; no nested scroll traps. On
  chat routes the single region is the conversation scroller — the page shell
  itself never scrolls there (see §8).

## 7. Chat

IMPLEMENTED (Pass 3B, polished in Pass E) and VERIFIED end-to-end in a real
browser: sign-in → workspace → real `/ask` → answer + grounding + citations →
reload keeps the transcript → second conversation opens (§11).

- **Request**: real `POST /ask` via `lib/api/client.ts`; the message list,
  grounding state and citations are rendered from the actual response.
- **Transcript**: stored messages load under RLS; live answers and stored
  messages share one view model (`ask` response vs `MessageRow` in
  `lib/chat/answer-view.ts`).
- **Markdown**: sanitized GFM only; every element maps onto design tokens.
  Element types are memoised and highlight state travels through context, so
  navigation never remounts a focused marker.
- **Citations**: `[S1]`… are rewritten to in-page anchors (`linkifyCitations`,
  with occurrence suffixes so repeats get unique DOM ids) and rendered as
  focusable `[n]` markers that navigate directly to the matching row in the
  answer's source list — no popover, no intermediate step. Each row's number
  badge navigates back to the first marker in the text. Both moves scroll the
  target into view, focus it and briefly highlight it. Rows show the real
  `/ask` metadata (document, page, retrieval rank) **plus the verbatim
  retrieved excerpt** (`excerpt`, ask v51); chunk ids are kept in data but
  never rendered. Rows without an excerpt (persisted before excerpts existed)
  render metadata-only.
- **Supporting evidence disclosure**: one compact collapsible section per
  answer ("Supporting evidence — N sources · M documents", `aria-expanded`,
  keyboard operable), collapsed by default so the answer holds focus. Clicking
  a marker auto-opens it when collapsed. Long excerpts clamp with Show
  more/less. No passage-text is ever invented: everything shown comes from
  the persisted citation object.
- **Answer reveal**: a fresh answer cascades in block-by-block
  (`components/chat/answer-reveal.tsx` — CSS opacity/translate over the
  already-rendered Markdown, ~40 ms stagger capped so even long answers finish
  in ~1.5 s). Citation buttons stay real and interactive throughout; the final
  DOM is identical to the static render. Stored transcripts, reloads and
  remounts render instantly with no replay; reduced motion renders instantly;
  any pointer/key/scroll interaction finishes it immediately. This animates
  presentation only — `/ask` still returns one completed response (§10.5).
- **Grounding**: four states — Supported / Partly supported / Sources disagree /
  Not enough evidence — plus a conflict note and the backend's own caution text;
  `N retrieved · M cited` is shown separately. Raw enum names, confidence
  percentages and similarity numbers are never rendered.
- **Composer**: auto-growing textarea, Enter sends, Shift+Enter newline, locked
  in flight, character count near the backend limit; accessible label and
  description. **Pass E**: `/` focuses the composer from anywhere in the chat
  (ignored while typing or while an overlay is open) and the help line says so;
  `enterKeyHint="send"` on mobile keyboards. **Temporary-file pass (D61)**: an
  attach control (labelled + tooltip) opens the conversation-file dialog.
- **Temporary conversation files (D60/D61, temporary-file pass)** — a strip
  above the composer lists the conversation's temporary files with their real
  backend state: uploading/registering (inside the dialog's queue), processing
  with the real remaining-passage count, Ready, Failed with the job's own error
  and a real retry, or Expired — each with `Temporary · expires in …`. The
  menu offers **Save to workspace** (in-place `promote`; the row leaves the
  strip and the notice says how to add it from the Sources panel) and
  **Remove file** (`delete-document`, confirmed). Attaching before the first
  question creates the conversation (RLS-scoped insert, D61), so the first
  answer still replaces the URL with `/c/<id>`. Inside a Space the same strip
  works and the dialog says the file is not a Space source. Temporary files
  never appear in the workspace document list; the answer's cited sources show
  the real file name like any other document.
- **Empty state**: the three product principles outside a Space. **Pass E**
  inside a Space it reports the real source scope — "no sources yet" with an
  add-documents route, "sources exist but none included" with the deterministic
  refusal explained and a route to the sources panel, or the real
  "N of M sources included" card with scope-specific guidance. No example
  questions are offered: the backend generates none.
- **Request state**: elapsed-seconds indicator with time-based escalation. There
  is **no staged progress** and **no Stop button** — see §10.
- **Long answers**: **Pass E** — "Jump to latest" appears when the reader has
  scrolled away from the bottom and returns them to the newest content
  (reduced-motion aware).
- **Errors**: normalized message + "Send again", plus an explicit note that
  resending may duplicate the question (no backend idempotency key exists).
- **Announcements**: **Pass E** — one polite live region announces "Answer ready.
  {grounding state}. N sources cited." when an answer arrives; the message is
  handed across the `/` → `/c/<id>` remount by a memory-only module
  (`lib/chat/announcement.ts`) and never replays.
- **Provenance**: removed from the chat surface as visual noise — answers
  carry a quiet Copy action only. Timings/model metadata remain in the API
  response and are deliberately not rendered.

## 8. Documents and settings

- **Documents** (IMPLEMENTED, VERIFIED unauthenticated): real list with
  ingestion status, failure reason, pending-embedding count, retry and delete.
  No upload UI in V1.
- **Settings** (IMPLEMENTED): account card showing identity, workspace and
  theme, plus read-only **product behaviour** cards. **Retrieval** states the
  benefit in one sentence (searches the sources available to a question before
  an answer is written) and exposes no provider, model, dimension, candidate
  count, fusion method or score (polish pass). Conversation rename/delete is
  **DEFERRED** — the UI exposes no mutation the backend does not support.

## 8.1 Space experience (Pass A/B/D + polish — implemented + verified)

Internal names remain `notebook*` (D56); the surfaces say Space.

- **Space list** — sidebar section (`components/notebooks/notebook-list.tsx`)
  and the `/notebooks` page (`notebooks-view.tsx`): real source counts
  ("N of M sources included"), create dialog ("Create a space"), rename, delete
  with confirmation.
- **Space workspace** (`notebook-workspace.tsx`) — two panes at `lg` (sources
  rail + chat), a bottom `Sheet` below `lg`; header carries the space name,
  the scope summary and the space menu. Entering it auto-collapses the global
  rail (§6).
- **Sources panel** (`sources-panel.tsx`) — per-source checkbox (Radix, keyboard
  operable), real status (ready / processing with remaining passage count /
  failed with the job's error + retry), add-documents dialog, remove-from-space
  and delete-document (confirmed), and a warning when nothing is included.
- **Source selection is a write, not a filter**: `selected` is persisted and the
  backend decides exclusion at retrieval time (D50). Toggling is optimistic and
  reverts on failure.
- **Scoped chat** — `chat-view.tsx` accepts `notebookId`/`scopeLabel`/
  `scopeCounts`/`onOpenSources`, sends `notebook_id`, and shows "Answering from
  N of M sources included". Asking inside a Space keeps the workspace (no
  redirect to `/c/<id>`). The Space empty state reports the real scope and
  routes to the sources panel (Pass E, §7).
- **New primitives** — `ui/checkbox.tsx`, `ui/alert-dialog.tsx`,
  `ui/dropdown-menu.tsx` (Radix, project style, no new dependencies).

## 8.2 Post-3B UI additions (implemented + verified)

- **Previous chats** (`components/shell/previous-chats.tsx`): a labelled row
  under the primary nav when expanded and an icon button in the collapsed rail;
  both open a drawer with the real conversation list. Verified against 50 live
  conversations in both states.
- **Collapsed rail layout**: the expand control moved to the top of the rail and
  the profile control stays at the bottom; measured 56 px rail with expand
  64–96 px, Previous chats 100–132 px, profile 860–892 px at 1440 px — no
  overlap, all independently clickable.
- **System health** (`components/shell/system-status.tsx` + `lib/health.ts`): a
  top-bar dot opening a popover with five **real** observations — Frontend,
  Backend/Edge (live CORS preflight), Database (RLS-scoped read), Embeddings
  (real `query-chunks` call, cached 10 min) and Generation (derived from the
  user's own `/ask` outcomes). Results are persisted with timestamps. The only
  offered recovery is "Retry this check" for backend/database/embeddings;
  Generation shows "Needs attention — no safe automatic fix". No reset exists.
- **Single scroll context on chat routes** (`chat-view.tsx`): the
  conversation scrolls only inside its own scroller (`data-chat-scroll`); the
  scroll region's wrapper clips overflow so content height never propagates to
  `main` (previously the page gained a second scrollbar). Other pages
  (documents, notebooks, settings) scroll `main` normally; the fix is scoped
  to the chat surface and changes no other route.
- **Cited sources grouping** (`lib/chat/citations.ts` +
  `assistant-message.tsx`): superseded — citations render as one compact row
  per source inside the Supporting evidence disclosure (see §7), each with
  document, pinned page, verbatim excerpt and a badge back-link. Grouping
  helpers remain in the lib unused by the UI.
- **Typography scale** (`src/app/globals.css`): one global `@theme` scale
  (2xs 12 · xs 13 · sm 15 · base 17 · lg 19 · xl 22 · 2xl 26 px …), with the chat
  reading surface at `text-base` (17 px) and answer headings stepped up to keep
  the hierarchy. Verified at 390/768/1440 px in both themes.
- **Error copy**: the `network` kind no longer blames the user's connection
  ("The service could not be reached from your browser. This is a service or
  network issue, not an account problem.").

## 9. Design system

### 9.1 Semantic color-token architecture

Colour is defined **once** in `src/app/globals.css` as CSS custom properties and
bridged to Tailwind v4 through `@theme inline` (`--color-*`). Components never
carry raw hex values: they consume semantic roles only — `bg-background`,
`text-foreground`, `bg-card`, `bg-primary`, `text-muted-foreground`, `bg-accent`,
`ring`, `text-success`, … — so a palette change is a token change, never a
component sweep. The palette itself is the RAG-4i brand system (neutral
foundation + gold/saffron accent); every mapped level below is an oklch value
with its source brand hex named in a comment in `globals.css`.

### 9.2 Neutral foundation (Onyx / Jet Black / Platinum)

Neutrals carry roughly 70–80% of the surface area and remain the base in both
themes.

- **Light mode** — `background` = Platinum 50 `#f1f2f3`; `card`/`popover` =
  white; `foreground` = Jet Black 900 `#17191c`; `border`/`input` = Platinum 200
  `#c8cbd0`; `secondary`/`muted` = Platinum 100 `#e4e5e7`; `muted-foreground` =
  Onyx 600 `#626a6a`.
- **Dark mode** — `background` = Onyx 950 `#111313`; `card`/`popover` = Onyx 900
  `#181b1b`; `foreground` = Platinum 100 `#e4e5e7`; `secondary`/`muted` = Onyx
  800 `#313535`; `muted-foreground` = Platinum 400 `#9297a0`; borders stay a low
  neutral alpha over the dark surface.

Platinum, Jet Black and Onyx are used for surfaces, panels, navigation,
typography and borders — never as accent.

### 9.3 Primary accent — Bright Gold

`--primary` is **Bright Gold 500 `#fad905`**, used deliberately and sparingly
(≈5–10% of the surface). It is a **fill / emphasis** colour, always paired with
`--primary-foreground` = Jet Black 950 `#101114` (13.5:1), never as bright gold
text on a light surface.

Where it is used intentionally:

- **Primary CTAs** — default `Button`, composer send, default `Badge`, checked
  `Checkbox`, text selection.
- **Brand identity marks** — the “4i” tile in the sidebar, auth gate, 404 and
  empty-state headers.
- **Active / selected states** — via the warm `--accent` tint (below), with the
  active nav icon and small definition icons drawn in `--primary-strong`.
- **Focus** — `--ring` is a gold value, so focus rings read as brand.
- **Elevation accent** — `--shadow-glow` is derived from `--primary`.

### 9.4 Secondary accent — Saffron

`--accent` / `--accent-foreground` are the Saffron family — Saffron 50
`#fcf8e8` on light, Saffron 900 `#2e2405` on dark. This is a **subtle warm tint
layer**, not a second bright colour: it backs hover states (`hover:bg-accent`),
the animated active-nav indicator, the active conversation row, and the
selected/highlighted evidence row. Saffron keeps the interface warm and
branded without competing with Bright Gold.

### 9.5 `primary-strong` and `primary-ink` (why they exist)

Bright Gold fails contrast as text or icons on light surfaces (~1.4:1 on
white), so two darker-gold semantic tokens exist purely for legibility:

- `--primary-strong` — **Gold 700 `#968203`** on light, **Gold 400 `#fbe137`**
  on dark. Used for **icons and small UI accents** (active nav icon,
  feature-card glyphs, hover text on citation chips), meeting non-text
  contrast.
- `--primary-ink` — **Gold 800 `#645702`** on light, Gold 400 on dark. Used for
  **body text links** (`Button`/`Badge` `link` variants, links inside answers),
  meeting AA text contrast (6.5:1) where bright gold would not.

The rule: **Bright Gold for fills, darker golds for text/ink on light**. This
keeps the brand recognisable while keeping every token accessible.

### 9.6 Semantic status colours stay separate

The four evidence/gate states remain their own functional token set —
`--success`, `--partial` (via `--warning`), `--conflict` and `--neutral-state`
(with `-muted` fills) — because they encode **meaning** (grounded / partly
supported / sources disagree / not enough evidence), not brand. They are
deliberately **not** recoloured to gold/saffron: a reader must be able to tell a
grounding state from a brand accent. Chart tokens are separate for the same
reason, with `chart-1`/`chart-3` aligned to the brand only for continuity.

### 9.7 Light / dark, accessibility, and usage intent

Both themes are first-class: the token set is defined in `:root` and `.dark`,
and the whole app, including gold fills, is verified in each. Accessibility is
the constraint that shapes the palette (see 9.5): body and muted text clear AA
in both themes, primary buttons clear AA by a wide margin (13.5:1), focus rings
use a gold value with sufficient non-text contrast, and `themeColor` metadata in
`layout.tsx` matches the Platinum/Onyx backgrounds. Brand colour is applied at
the surfaces listed in 9.3–9.5 and nowhere else; neutrals stay dominant.

### 9.8 Typography, motion, and interaction

- Typography: **Instrument Sans** (UI) and **JetBrains Mono** (citations, chunk
  ids, page numbers, timings), self-hosted through `next/font` and exposed as
  `font-sans` / `font-mono` tokens.
- Motion vocabulary (`src/lib/motion.ts` + primitives): durations/easings shared
  across the app; motion explains state changes and never decorates.
- Accessibility: landmarks, skip link, visible focus rings, `aria-live` for
  request state, `role="alert"` for failures, icon **and** text (never colour
  alone), labelled controls, reduced-motion support throughout.

## 10. Hard boundaries (must not be crossed)

These follow from the locked backend; violating them would make the UI lie.

1. **No direct provider calls** — Mantle/Voyage are reachable only through Edge
   Functions.
2. **No fabricated evidence** — citations show only what the backend
   actually returned: metadata plus the verbatim retrieved excerpt (ask v51).
   Pre-excerpt rows render metadata-only rather than inventing text (§11).
3. **No invented scores or confidence** — no similarity numbers, no percentages,
   no source-authority ratings.
4. **No reasoning/CoT surface** — the backend strips model thinking before
   responding; there is nothing to display.
5. **No streaming theatre** — `/ask` is non-streaming and persists before
   responding, so there are no honest stages and cancellation cannot be honest.
   The answer-reveal animation (§7) presents an already-completed response and
   must never imply a live stream or delay it.
6. **No mocks presented as validation** — mocks are acceptable for local
   development only, never as evidence that a pass works.
7. **No hidden model/provider switching** — the UI never chooses or substitutes
   a model.
8. **No backend changes justified only by UI convenience** — needed additions
   are separate, explicitly authorized, additive steps.
9. **No client-side authorization** — message edits go through the
   server-authorized `edit-message` function (owner-or-manager, atomic);
   conversation reads collapse authorization/not-found so id existence is
   not disclosed; model links render only for safe protocols (D81).

## 11. Verification state

| Area | State | Evidence |
|---|---|---|
| Typecheck / lint / production build | VERIFIED | `tsc` 0 errors, `eslint` 0 problems, `next build` PASS (all routes) |
| Unauthenticated gating (all product routes → sign-in, no protected DOM) | VERIFIED | Pass 3B report |
| Responsive layout 390/430/768/1024/1280/1440 px | VERIFIED | measured, zero horizontal overflow |
| Light and dark theme | VERIFIED | Pass 1–3B reports |
| Console/server-log cleanliness | VERIFIED | 0 problems on unauthenticated surfaces |
| `/showcase` unaffected by shell/gating work | VERIFIED | Pass 3B report |
| **Signed-in E2E: sign-in → workspace → ask → answer/citations/grounding → reload → second conversation** | **VERIFIED** | real browser (Chrome via CDP) with `test@rag.com`: answer rendered, grounding "Supported", 8 cited sources, transcript survived reload, second conversation opened; 0 console errors |
| Post-3B UI fixes (typography scale, Previous chats, collapsed rail, system health, cited-source grouping) | VERIFIED | tsc/eslint/build clean; measured at 390/768/1440 px in both themes; 0 overflow, 0 console errors |
| Evidence rail / conflict comparison | IMPLEMENTED as the Supporting evidence disclosure | ask v51 returns verbatim excerpts; each answer carries a collapsible per-source list with direct marker ↔ row navigation (D80) |
| Conversation rename/delete | DEFERRED | no supported backend mutation API |
| `/showcase` removal from the product build | PENDING | dev QA route still present |
| Spaces: list/create/rename/delete, source attach/remove, selection toggle | **VERIFIED** | live browser + API validation, 22 checks (5 API / 10 rendering / 7 cleanup-integrity); scoped `/ask` answers from selected sources and refuses with `no-selected-sources` when none are included |
| Space workspace responsive composition (1440 two-pane, 390 bottom sheet) | **VERIFIED** | measured, 0 overflow, 0 console errors |
| Upload (Pass C): dropzone + picker, serial queue, **real** XHR progress, cancel, auto-attach to a space | **VERIFIED** | live: real 433,795 B PDF uploaded and registered; document `pending` with 78 pages / 226 chunks / `file_size` 433795 and the object under the tenant prefix; 26 MB → "26.0 MB — the limit is 25.0 MB."; non-PDF rejected; 0 console errors; isolated tenant cleaned, production unchanged |
| Upload queue respects the **concurrency policy** (1 processing + 3 pending jobs) | **VERIFIED** | two files dropped at once: first registered, second showed a real `waiting` state (live active-job count) and **resumed automatically** when the workspace freed; registration-only retry for items whose bytes are already stored; duplicates surface the server's own message |
| Upload, Space and scoped chat exercised by **real use** | **OBSERVED IN PRODUCTION** | after the Pass C fix a second document (`Thrine Sales SOP (1).pdf`, 7 pages, 13 chunks) was uploaded through the UI, reached `ready`, and was attached as a selected source to a real space (`test`) — the first end-to-end use outside validation |
| **Pass E — chat polish** (space empty states, jump-to-latest, marker↔sources navigation, `/` focus, arrival announcement) | **VERIFIED** | live Chrome/CDP with the real account and production data: 32/32 checks, 0 console errors; real `/ask` answer with grounding + citations; both citation directions move focus; jump control appears at 350 px overflow and returns to the bottom; scratch space created, verified and deleted; selection toggled true→false→true (warning state shown) with production restored; 0 horizontal overflow at 390/430/768/1024/1280/1440 px; light + dark screenshots |
| Pass E screenshots (390/768/1440 × light/dark) | VERIFIED | `%TEMP%\rag4i-pass-e-shots\e-*-{light,dark}.png`; raw checks archived at `eval/runs/ui-pass-e-chat-polish-results-20260917.json` (report: `eval/runs/ui-pass-e-chat-polish.md`) |
| **Polish pass — Space auto-collapse, footer/alignment, rail tooltips, drawer header, Spaces terminology, Settings retrieval** | **VERIFIED** | live Chrome/CDP with the real account and production data: 48/48 checks, 0 console errors; rail 56 px with the 320 px sources panel open and preference untouched; profile/expand centred at 0.5 px with 36×36 targets; hover + keyboard tooltips all exact; drawer +/Close 32×32 with 12 px gap; 0 visible "Notebook" on `/`, `/notebooks`, the space, `/documents`, `/settings`; Settings exposes no retrieval internals; intercepted scoped `/ask` payload carried the same `notebook_id`; selection toggle reverted; 0 overflow 390–1440 px; light + dark screenshots |
| Polish-pass screenshots | VERIFIED | `%TEMP%\rag4i-polish-shots\space-{390,768,1440}-{light,dark}.png`, `drawer-1440-light.png`, `mobile-nav-390.png`; raw checks archived at `eval/runs/ui-polish-spaces-sidebar-results-20260917.json` (report: `eval/runs/ui-polish-spaces-sidebar.md`) |
| **Temporary-file pass (D60/D61)** — composer attach, conversation strip (processing → ready → expired), promote, remove | **VERIFIED** | live Chrome/CDP with the real account and a real 1-page PDF: 30/30 checks, 0 console errors; `ingest-temp` payload carried only `action`/`tenant_id`/`storage_path`/`file_name`/`conversation_id`; real worker state showed "Processing · 1 passages left" → "Ready"; scoped `/ask` cited `lease.pdf` ("36 months"); reload kept transcript + strip; `/documents` excluded the file until **Save to workspace** and listed it after; document deleted and production restored to 2 documents / 0 temporary rows; 0 horizontal overflow at 390 px |
| Temporary-file pass evidence | VERIFIED | `%TEMP%\rag4i-temp-files-shots\` (4 screenshots + `results.json`); report: `eval/runs/ui-temporary-chat-files.md` |
| **Chat layout + answer reveal** (single scroll context, Copy-only actions, answer card, collapsed-by-default evidence, `AnswerReveal` block cascade) | IMPLEMENTED + VERIFIED (`ce3b946`) | `tsc`/`eslint`/`next build` clean; live local prod build: fresh answers reveal progressively and settle <2 s with identical final DOM, `/`→`/c` remount replays once via the announcement-module handoff (no replay on reload), collapsed default holds, marker/badge navigation + repeats + themes + 390 px + reload all pass, 0 console errors; probe conversations deleted |
| **RAG-4i brand colour system** (Onyx/Jet Black/Platinum neutrals; Bright Gold primary; Saffron secondary; `primary-strong`/`primary-ink`) | VERIFIED | centralized token rewrite in `globals.css`, no hardcoded component colours; light + dark + 390 px + desktop screenshots (`brand-*.png`); canvas-sampled contrast: heading 15.7:1 / 14.8:1, body+muted 5.2:1 / 6.2:1, primary fill 13.5:1; 0 console errors, 0 overflow; no behaviour/API change |
| **Public landing page + routing** (`(site)/page.tsx`; app home moved to `/ask`) | **VERIFIED** | `tsc`/`eslint`/`next build` clean; live Chrome/CDP against the production build: 0 console errors; hero, demo card, evidence states, steps, spaces, security, CTA render; signed-out landing and signed-in landing both reachable, entry action switches "Sign in" ↔ "Open workspace"; unauthenticated `/ask` renders the sign-in form; one real `/ask` answer with grounding state, 8 evidence rows and 10 citation markers (test conversation deleted, DELETE 204); sign-out returns to the sign-in screen; 0 horizontal overflow at 390/430/768/1024/1280/1440 px; theme toggle exercised; light + dark full-page screenshots |
| **CSP nonce fix** (`src/proxy.ts`; policy moved out of `next.config.ts`) | **VERIFIED** | the previous static `script-src 'self'` policy blocked Next.js's inline hydration scripts in production (React error #412; sign-in never mounted); with a per-request nonce: 0 CSP violations in Chrome and every client surface regains function. Document routes are dynamic by design under nonce CSP |

## 12. Pending and deferred work

- **NEXT — visual review pass** over the whole surface (brief §20); Pass E and
  the Spaces/sidebar polish pass are complete and their screenshots are the
  starting material.
- **PENDING — frontend error mapping for new statuses.** `413` (file too large),
  `507` (storage budget), `409` (duplicate / limits / concurrency) currently fall
  through to the generic `unknown` kind in `lib/api/errors.ts`; the upload UI
  needs them mapped to honest, specific messages.
- **PENDING — storage health component.** The health popover covers Frontend,
  Backend, Database, Embeddings and Generation. Storage (bucket reachability +
  budget) requires no architectural change and was designed in the Pass 4 audit;
  not implemented.
- **DONE — evidence workspace (was "Pass 3C", D80).** `/ask` v51 returns a
  verbatim excerpt per citation; the UI shows it in the Supporting evidence
  disclosure. The conflict-comparison view was never built and is not
  scheduled.
- **DEFERRED — streaming/live citations.** Requires a backend streaming change.
  The answer-reveal animation (§7) is presentation-only and must not be read
  as streaming.
- **DEFERRED — document download / archive UI.** `archived_at` exists (D49) but
  no UI; download would count against egress.
- **PENDING — remove or relocate `/showcase`.**
- **OBSERVED (Pass E)** — the cited-sources list contains every citation the
  backend returned, while inline markers appear only where the model wrote them
  (live example: 8 chips, 4 markers). Both numbers are real; labelling the
  difference is a possible future polish, not a correctness gap.
- **OBSERVED (temporary-file pass)** — a promoted file is not auto-added to the
  Space it was discussed in (the backend promotes in place); the strip notice
  points to the Sources panel. Temporary citations are not separately badged —
  the strip is the temporary surface. An attachment-created conversation with
  no messages stays until conversation delete ships (D61).

Sequencing detail lives in `eval/runs/ui-pass-3-capability-audit.md`; upload,
storage and notebook behaviour detail in `eval/runs/phase-b3-upload-safety.md`,
`phase-b4-notebook-schema.md`, `phase-b2-notebook-scoped-retrieval.md` and
`phase-b5-orphan-cleanup.md`.

## 13. Reports and references

- `eval/runs/ui-resource-audit.md` — external resource/access audit and stack
  selection.
- `eval/runs/ui-pass-1-foundation.md` — tokens, type, motion, primitives.
- `eval/runs/ui-pass-2-shell.md` — shell, navigation, states, responsive.
- `eval/runs/ui-pass-3-capability-audit.md` — capability research,
  classification, sequencing.
- `eval/runs/ui-pass-3a-session-api.md` — session, auth gate, API layer,
  conversations, documents.
- `eval/runs/ui-pass-3b-chat.md` — chat surface, citations, grounding, states,
  validation.
- `eval/runs/ui-pass-e-chat-polish.md` — Pass E scope, implementation,
  32-check live validation, remaining gaps.
- `eval/runs/ui-polish-spaces-sidebar.md` — Spaces terminology, Space
  auto-collapse, sidebar footer/alignment, rail tooltips, drawer header,
  Settings retrieval; 48-check live validation.
- `eval/runs/ui-temporary-chat-files.md` — temporary conversation files (D60):
  audit, minimum UX, implementation, 30-check live validation, remaining gaps.
- eval/runs/ui-build-research-and-implementation.md — UI library research, the notebook build (Pass A/B/D): architecture, files, validation, remaining gaps.
- Post-lock backend capabilities the UI will build on:
  `eval/runs/phase-b1-batched-embeddings.md`,
  `phase-b3-upload-safety.md`, `phase-b4-notebook-schema.md`,
  `phase-b2-notebook-scoped-retrieval.md`, `phase-b6-storage-cap.md`,
  `phase-b5-orphan-cleanup.md`, `eval/runs/ui-pass-4-upload-storage-architecture.md`
  (design) and `eval/runs/pre-ui-regression-34-20260917.md` (pre-UI gate).
- `ARCHITECTURE.md` Part 1 — backend architecture (authoritative).
- `DECISIONS.md` D41–D45 — UI boundaries; D46–D53 — post-V1 capabilities.
- `SESSION_HANDOFF.md` — current state and immediate next action.
