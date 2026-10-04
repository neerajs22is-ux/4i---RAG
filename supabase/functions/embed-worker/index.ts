// embed-worker — Phase 3A.1 production paced embedding worker.
//
// Cron-driven async embedding: each invocation claims ONE due job and embeds
// budgeted passes of chunks in batched embedding requests (B1), persists the
// vectors, and exits. One invocation may run up to MAX_PASSES_PER_INVOCATION
// sequential passes over the SAME claimed job (D66 continuation) instead of
// releasing it to the next cron tick; progress stays durable (embedding IS
// NULL scan) so a killed invocation resumes exactly like a tick boundary and
// retries converge.
//
// A registration that just persisted chunks can also trigger this worker
// directly (ingest-pdf → POST { job_id } with the same x-worker-key): the
// triggered run claims ONLY that job, so embedding starts seconds after parse
// instead of waiting for the next cron tick. The cron sweep remains the
// backstop — a failed or lost trigger changes nothing about recovery.
//
// Contract: jina-embeddings-v5-text-small, task retrieval.passage, 1024-dim
// float, normalized. Every response is
// validated (model exact, count exact, index mapping complete, all finite)
// before persist — a malformed batch persists nothing. Never overwrites a
// non-NULL embedding.
//
// Rate limiting: per pass, at most REQUESTS_PER_TICK Jina requests carrying
// at most CHUNKS_PER_REQUEST chunks and MAX_CHARS_PER_REQUEST characters each,
// sent sequentially with PACED_REQUEST_GAP_MS between them (uniform gaps
// within and across passes). A full two-pass invocation fits inside ~50 s, so
// a rolling minute can hold up to all 6 of its requests (≈69K tokens worst
// case vs the 100K TPM envelope). A per-pass token guard (PASS_TOKEN_BUDGET)
// stops before breaching the shared account budget. Sized for the documented
// Jina free envelope (100 RPM / 100K TPM, shared with reranking); raise only
// after higher provider limits are confirmed.
// No concurrency across jobs, no payment logic.
//
// Claiming (no new schema, no lock service): compare-and-swap on
// ingest_jobs.attempts — read the oldest processing job, UPDATE only if
// attempts is unchanged. A lost race exits idle. Combined with the
// IS-NULL/ON-CONFLICT write guards, overlapping invocations stay safe.
// CLAIM_IDLE_SECONDS exceeds the worst-case two-pass invocation so the cron
// sweep does not steal a job mid-invocation (the direct trigger bypasses the
// idle threshold by naming the parse-complete job explicitly).
//
// Auth: service-to-service shared secret (WORKER_CRON_KEY Edge secret,
// x-worker-key header, timing-safe compare). verify_jwt is OFF for this
// function only (see supabase/config.toml); the secret check is the gate.
// Logs metadata only. Never keys, content, vectors, or tokens.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  claimProviderSlot,
  killSwitchEngaged,
  recordProviderUse,
  releaseProviderSlot,
} from "../_shared/cost-control.ts";
import {
  EMBED_DIMENSIONS,
  EMBED_MODEL,
  EMBED_NORMALIZED,
  EMBED_TASK_DOCUMENT,
  exceedsTokenBudget,
  parseBatchResponse,
  planBatches,
  type EmbedCandidate,
} from "../_shared/embed-batch.ts";

const MODEL = EMBED_MODEL;
const DIMENSIONS = EMBED_DIMENSIONS;
const TASK_DOCUMENT = EMBED_TASK_DOCUMENT;
const ENDPOINT = "https://api.jina.ai/v1/embeddings";

// Batched embedding budget (B1, paced per the speed optimization).
// Jina accepts an array of inputs per request, so one request can carry many
// chunks. These application budgets keep the worker inside the documented Jina
// free envelope (100 RPM / 100K TPM, shared with reranking):
//   48 chunks/request at ≈950 chars ≈ ≈11.5K tokens (hard cap 48K chars)
//   3 sequential requests/pass, ~5 s apart → a full two-pass invocation (6
//   requests) fits inside ~50 s, so a rolling minute can hold all 6: ≤ 6 RPM
//   (≈6% of the envelope) and ≤ ≈69K tokens worst case vs 100K TPM, with the
//   per-pass token guard as a backstop. A two-pass invocation spans ~50 s, so
//   rolling-minute usage stays under ~70% of the TPM envelope even at the
//   worst alignment. Query embeddings during ingestion share the budget,
//   hence the remaining margin, and the pre-existing 429 path (stop, resume
//   next invocation) remains the final backstop.
// Jina's own per-input ceiling for v5-text-small is a 32K-token context —
// far above these numbers, which protect the account limits, not the provider.
const CHUNKS_PER_REQUEST = 48;
const REQUESTS_PER_TICK = 3;
const MAX_CHARS_PER_REQUEST = 48_000;
const MAX_CHUNKS_PER_PASS = CHUNKS_PER_REQUEST * REQUESTS_PER_TICK;
/** Sequential gap between this invocation's embedding requests (paced). */
const PACED_REQUEST_GAP_MS = 5_000;
/** Each pass's own token contribution stays well under the shared TPM budget. */
const PASS_TOKEN_BUDGET = 40_000;
/**
 * Bounded same-job continuation (D66): one invocation runs at most this many
 * sequential passes over its claimed job. 2 passes × 144 chunks cover the
 * 50–300-chunk company-document range in a single invocation (~50 s worst
 * case); larger jobs still converge across invocations exactly as before.
 */
const MAX_PASSES_PER_INVOCATION = 2;
/**
 * Wall-clock continuation boundary: a second pass starts only within this
 * budget of invocation start, keeping the worst case (~start + one full
 * pass) inside plausible Edge execution limits. A killed invocation loses at
 * most one in-flight batch — recovery is identical to a tick boundary.
 */
const PASS_START_BUDGET_MS = 100_000;

// Only claim jobs idle longer than this (a freshly-touched job is being
// worked or was just parsed; the next tick picks it up). Must exceed the
// worst-case two-pass invocation (~50 s) so the cron sweep never steals a
// job mid-invocation — the v33 overlap it replaces cost a wasted Jina request
// per large document. Direct triggers (ingest-pdf after durable chunk
// persistence) bypass this threshold by naming the parse-complete job
// explicitly, so normal UX latency is unaffected; only genuinely stuck jobs
// wait up to ~3.5 min for the cron backstop.
const CLAIM_IDLE_SECONDS = 150;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// deno-lint-ignore no-explicit-any
type Db = any;
type ClaimedJob = { id: string; tenant_id: string; document_id: string; attempts: number };

/**
 * Budgeted embedding passes over a claimed job's NULL chunks.
 *
 * Shared by the cron sweep and the direct post-parse trigger: each pass runs
 * at most REQUESTS_PER_TICK sequential embedding requests (paced apart),
 * each validated whole-batch-before-write, each chunk written once behind
 * the non-NULL guard. A second pass over the SAME job starts only within the
 * wall-clock budget and only after a clean first pass — otherwise the job
 * keeps its durable state and the next invocation resumes it. Completion
 * (document ready + job succeeded) happens in this same invocation when no
 * NULL embeddings remain — no extra invocation is needed.
 */
type BatchStat = { size: number; jina_ms: number; persist_ms: number; tokens: number };

async function runEmbeddingPass(
  admin: Db,
  job: ClaimedJob,
  apiKey: string,
  log: (extra: Record<string, unknown>) => void,
  t0: number,
) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  let embedded = 0;
  let embedRequests = 0;
  let http429 = 0;
  let failedThisTick = 0;
  let passes = 0;
  let stopped = "";
  const batchStats: BatchStat[] = [];

  while (passes < MAX_PASSES_PER_INVOCATION && stopped === "") {
    if (passes > 0 && performance.now() - t0 > PASS_START_BUDGET_MS) {
      stopped = "pass budget; resumes next tick";
      break;
    }
    // Next budgeted NULL chunks of THIS document only. One extra row tells us
    // whether more work remains after this pass without a second query.
    // Re-read every pass so a concurrent worker's progress is picked up and
    // never overwritten (the per-row NULL guard makes overlap a no-op).
    const { data: pending, error: listErr } = await admin.from("chunks")
      .select("chunk_id, content")
      .eq("document_id", job.document_id)
      .eq("tenant_id", job.tenant_id)
      .is("embedding", null)
      .order("page", { ascending: true })
      .order("chunk_id", { ascending: true })
      .limit(MAX_CHUNKS_PER_PASS + 1);
    if (listErr) return json(500, { ok: false, error: listErr.message });
    const candidates = ((pending ?? []) as EmbedCandidate[])
      .slice(0, MAX_CHUNKS_PER_PASS);
    if (candidates.length === 0) break;

    // Blank content can never be embedded. Record it and leave the row NULL —
    // the same behaviour as before batching (no request is sent for it).
    const embeddable: EmbedCandidate[] = [];
    for (const row of candidates) {
      if (!row.content || !row.content.trim()) {
        failedThisTick++;
        continue;
      }
      embeddable.push(row);
    }

    const batches = planBatches(embeddable, {
      maxChunks: CHUNKS_PER_REQUEST,
      maxChars: MAX_CHARS_PER_REQUEST,
      maxBatches: REQUESTS_PER_TICK,
    });

    // Per-pass token budget: each pass contributes at most ~3 requests
    // (≈35K tokens) guarded here; a full two-pass invocation fits inside
    // ~50 s, so the rolling-minute worst case is all 6 requests (≈69K
    // tokens) — still under the shared TPM envelope (see budget comment).
    let passTokens = 0;
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (b > 0 || passes > 0) {
        // Paced sequential cadence: this invocation's requests land
        // PACED_REQUEST_GAP_MS apart (plus ~2–4 s of request+persist work),
        // so bursts stay ordered and far below the RPM envelope.
        await sleep(PACED_REQUEST_GAP_MS);
        if (exceedsTokenBudget(passTokens, batch.map((row) => row.content), PASS_TOKEN_BUDGET)) {
          stopped = "tpm budget; resumes next tick";
          break;
        }
      }
      embedRequests++;
      const jinaStart = performance.now();
      let raw: unknown;
      try {
        const r = await fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            input: batch.map((row) => row.content),
            model: MODEL,
            task: TASK_DOCUMENT,
            dimensions: DIMENSIONS,
            normalized: true,
            embedding_type: "float",
          }),
        });
        if (r.status === 429) {
          http429++;
          failedThisTick += batch.length;
          stopped = "rate_limited_429";
          break;
        }
        if (!r.ok) {
          failedThisTick += batch.length;
          const transient = r.status >= 500;
          stopped = transient
            ? `transient provider status ${r.status}`
            : `fatal provider status ${r.status}`;
          break;
        }
        raw = await r.json();
      } catch (e) {
        failedThisTick += batch.length;
        stopped = "transient request failure";
        log({
          tick: "batch_failed", job_id: job.id, batch_size: batch.length,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 120),
        });
        break;
      }
      const jinaMs = Math.round(performance.now() - jinaStart);

      // Validate the WHOLE batch before persisting anything: a malformed or
      // partial response must never mark chunks as embedded.
      const parsed = parseBatchResponse(raw, batch.length);
      if (!parsed.ok) {
        failedThisTick += batch.length;
        stopped = parsed.reason;
        break;
      }
      passTokens += parsed.tokens;

      // Bounded parallel persist: at most one batch (≤ CHUNKS_PER_REQUEST
      // rows) in flight. Same single-row UPDATE with the same non-NULL guard
      // per chunk as the old sequential loop — only the awaiting is
      // concurrent, so tenant scoping, ownership, CAS and retry semantics are
      // unchanged. Supavisor absorbs the burst; statements are single-row.
      const persistStart = performance.now();
      const outcomes = await Promise.all(batch.map((row, i) =>
        admin.from("chunks")
          .update({ embedding: parsed.vectors[i] })
          .eq("chunk_id", row.chunk_id)
          .is("embedding", null)
          .then(
            ({ error: upErr }: { error: { message?: string } | null }) => ({
              ok: !upErr,
              detail: upErr?.message ?? "",
            }),
            (error: unknown) => ({
              ok: false,
              detail: error instanceof Error ? error.message : String(error),
            }),
          )
      ));
      const persistMs = Math.round(performance.now() - persistStart);
      batchStats.push({ size: batch.length, jina_ms: jinaMs, persist_ms: persistMs, tokens: parsed.tokens });
      // P0 accounting (D83): per-batch provider spend, best-effort.
      await recordProviderUse(admin, job.tenant_id, null, "embed-worker", parsed.tokens);
      let persistFailed = 0;
      for (const outcome of outcomes) {
        if (outcome.ok) {
          embedded++;
        } else {
          persistFailed++;
          if (persistFailed === 1) {
            log({
              tick: "persist_failed", job_id: job.id, batch_size: batch.length,
              error: outcome.detail.slice(0, 120),
            });
          }
        }
      }
      if (persistFailed > 0) {
        failedThisTick += persistFailed;
        stopped = "persist failure";
        break;
      }
    }
    passes++;
  }

  // Resumable stops resume on a later invocation; anything else is fatal to
  // the job. Stops ending in "resumes next tick" are budget/deferral stops
  // (per-pass TPM guard, pass continuation boundary) — same class as the
  // pre-existing TPM stop, just reachable from either pass.
  const resumable = stopped === "rate_limited_429" ||
    stopped.startsWith("transient") ||
    stopped.endsWith("resumes next tick");
  if (stopped !== "" && !resumable) {
    await admin.from("ingest_jobs").update({
      status: "failed",
      last_error: `embedding worker fatal: ${stopped}`,
    }).eq("id", job.id);
    await admin.from("documents").update({ status: "failed" })
      .eq("id", job.document_id).eq("tenant_id", job.tenant_id);
    log({
      tick: "failed", job_id: job.id, tenant_id: job.tenant_id,
      reason: stopped, failed_this_tick: failedThisTick,
    });
    return json(500, { ok: false, fatal: true, reason: stopped });
  }

  // Completion check: succeed/ready ONLY when no NULL embeddings remain.
  const { count: remaining } = await admin.from("chunks")
    .select("chunk_id", { count: "exact", head: true })
    .eq("document_id", job.document_id)
    .eq("tenant_id", job.tenant_id)
    .is("embedding", null);
  const left = remaining ?? 0;
  if (left === 0) {
    await admin.from("documents").update({ status: "ready", embedding_model: MODEL })
      .eq("id", job.document_id).eq("tenant_id", job.tenant_id);
    await admin.from("ingest_jobs").update({ status: "succeeded", last_error: null }).eq("id", job.id);
    log({
      tick: "completed", job_id: job.id, tenant_id: job.tenant_id,
      document_id: job.document_id, embedded_this_tick: embedded,
      embedding_requests: embedRequests, total_tokens: batchStats.reduce((sum, s) => sum + s.tokens, 0),
      failed_this_tick: failedThisTick, passes_executed: passes,
      batches: batchStats,
    });
    return json(200, {
      ok: true, completed: true, job_id: job.id, document_id: job.document_id,
      embedded_this_tick: embedded, embedding_requests: embedRequests,
      http_429: http429, total_tokens: batchStats.reduce((sum, s) => sum + s.tokens, 0),
      failed_this_tick: failedThisTick, passes_executed: passes,
      batches: batchStats,
      total_ms: Math.round(performance.now() - t0),
    });
  }

  await admin.from("ingest_jobs").update({
    last_error: stopped === "rate_limited_429"
      ? "rate limited (429); resumes next tick"
      : stopped !== "" ? `embedding worker: ${stopped}; resumes next tick` : null,
  }).eq("id", job.id);
  log({
    tick: "progress", job_id: job.id, tenant_id: job.tenant_id,
    embedded_this_tick: embedded, remaining_null: left,
    embedding_requests: embedRequests, http_429: http429,
    failed_this_tick: failedThisTick, passes_executed: passes,
    batches: batchStats,
    stopped: stopped || "budget exhausted",
  });
  return json(200, {
    ok: true, completed: false, job_id: job.id, document_id: job.document_id,
    embedded_this_tick: embedded, remaining_null: left,
    embedding_requests: embedRequests, http_429: http429,
    stopped: stopped || "budget exhausted", total_tokens: batchStats.reduce((sum, s) => sum + s.tokens, 0),
    failed_this_tick: failedThisTick, passes_executed: passes,
    batches: batchStats,
    total_ms: Math.round(performance.now() - t0),
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const t0 = performance.now();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  // Service-to-service gate (verify_jwt is off for this function only).
  const presented = req.headers.get("x-worker-key") ?? "";
  const expected = Deno.env.get("WORKER_CRON_KEY") ?? "";
  if (!timingSafeEqual(presented, expected)) {
    return json(401, { ok: false, error: "unauthorized worker invocation" });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  );
  const apiKey = Deno.env.get("JINA_API_KEY") ?? "";
  if (!apiKey) return json(500, { ok: false, error: "JINA_API_KEY not configured" });

  // NOTE: the worker acts as the platform scheduler here, not as a tenant
  // user: it reads/writes only the single claimed job's rows, scoped by the
  // job's own tenant_id/document_id at every step. It uses the platform
  // secret key (service_role template, RLS-bypassing by design and confined
  // to Edge Functions per DECISIONS.md D7); tenant isolation rests on the
  // claim scoping below (one job, its tenant, its document, its chunks).
  // Missing/unparseable platform secrets fail loudly — never fall back to
  // an unprivileged client that would fail closed with confusing errors.
  const svcKey = Deno.env.get("SUPABASE_SECRET_KEYS") ?? "";
  let admin: ReturnType<typeof createClient>;
  try {
    const parsed = JSON.parse(svcKey) as Record<string, string>;
    const first = parsed["default"] ?? Object.values(parsed)[0];
    if (!first) return json(500, { ok: false, error: "platform secret unavailable" });
    admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", first);
  } catch {
    return json(500, { ok: false, error: "platform secret unavailable" });
  }

  const log = (extra: Record<string, unknown>) =>
    console.log(JSON.stringify({ fn: "embed-worker", ...extra }));

  // P0 kill switch (D83): stop embedding spend without touching jobs.
  // Pending chunks stay pending; the next tick after switch-off resumes
  // exactly like any tick boundary (durable NULL scan, no corruption).
  if (killSwitchEngaged()) {
    log({ tick: "idle", reason: "kill-switch" });
    return json(200, { ok: true, idle: true, killed: true });
  }

  let body: { tick?: unknown; job_id?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Direct post-parse trigger: ingest-pdf names the job whose chunks it just
  // persisted. The job must already be `processing` (parse-complete state is
  // durable before the trigger fires), and the claim below is the same
  // compare-and-swap the cron path uses — a concurrent tick simply loses the
  // race and exits idle. A missing or already-finished job is idle, never an
  // error: the cron sweep remains the backstop either way.
  if (typeof body.job_id === "string" && body.job_id !== "") {
    if (!UUID_RE.test(body.job_id)) {
      return json(400, { ok: false, error: "invalid job_id" });
    }
    const { data: target, error: targetErr } = await admin.from("ingest_jobs")
      .select("id, tenant_id, document_id, attempts, status")
      .eq("id", body.job_id)
      .single();
    if (targetErr || !target) {
      log({ tick: "idle", reason: "triggered job missing" });
      return json(200, { ok: true, idle: true });
    }
    const named = target as ClaimedJob & { status: string };
    if (named.status !== "processing") {
      log({ tick: "idle", reason: "triggered job not processing" });
      return json(200, { ok: true, idle: true });
    }
    const { data: claimed, error: claimErr } = await admin.from("ingest_jobs")
      .update({ attempts: named.attempts + 1, updated_at: new Date().toISOString() })
      .eq("id", named.id)
      .eq("attempts", named.attempts)
      .select("id, tenant_id, document_id, attempts");
    if (claimErr) return json(500, { ok: false, error: claimErr.message });
    if (!claimed || claimed.length === 0) {
      log({ tick: "idle", reason: "triggered claim lost (concurrent worker)" });
      return json(200, { ok: true, idle: true, claim_lost: true });
    }
    // P0 provider slot (D83): one in-flight embedding stream per tenant.
    // Busy defers (job stays processing; cron/trigger resumes next tick).
    {
      const claimedJob = claimed[0] as ClaimedJob;
      const slot = await claimProviderSlot(admin, claimedJob.tenant_id, null);
      if (!slot.ok) {
        log({ tick: "idle", reason: "provider-busy", job_id: claimedJob.id });
        return json(200, { ok: true, idle: true, deferred: true });
      }
      try {
        return await runEmbeddingPass(admin, claimedJob, apiKey, log, t0);
      } finally {
        await releaseProviderSlot(admin, claimedJob.tenant_id, null);
      }
    }
  }

  // 1. Find the oldest idle embedding-pending job (parse done, still processing).
  const { data: due, error: dueErr } = await admin.from("ingest_jobs")
    .select("id, tenant_id, document_id, attempts, updated_at")
    .eq("status", "processing")
    .lt("updated_at", new Date(Date.now() - CLAIM_IDLE_SECONDS * 1000).toISOString())
    .order("updated_at", { ascending: true })
    .limit(1);
  if (dueErr) return json(500, { ok: false, error: dueErr.message });
  if (!due || due.length === 0) {
    log({ tick: "idle", reason: "no due jobs" });
    return json(200, { ok: true, idle: true });
  }
  const cand = due[0] as { id: string; tenant_id: string; document_id: string; attempts: number };

  // 2. CAS claim: only proceed if attempts is unchanged since the read.
  const { data: claimed, error: claimErr } = await admin.from("ingest_jobs")
    .update({ attempts: cand.attempts + 1, updated_at: new Date().toISOString() })
    .eq("id", cand.id)
    .eq("attempts", cand.attempts)
    .select("id, tenant_id, document_id, attempts");
  if (claimErr) return json(500, { ok: false, error: claimErr.message });
  if (!claimed || claimed.length === 0) {
    log({ tick: "idle", reason: "claim lost (concurrent worker)" });
    return json(200, { ok: true, idle: true, claim_lost: true });
  }
  const job = claimed[0] as { id: string; tenant_id: string; document_id: string; attempts: number };

  // 3. Load the job's document; scope everything below to it.
  const { data: doc, error: docErr } = await admin.from("documents")
    .select("id, tenant_id, status")
    .eq("id", job.document_id)
    .eq("tenant_id", job.tenant_id)
    .single();
  if (docErr || !doc) {
    await admin.from("ingest_jobs").update({
      status: "failed",
      last_error: "embedding worker: document missing for job",
    }).eq("id", job.id);
    log({ tick: "failed", job_id: job.id, reason: "document missing" });
    return json(200, { ok: false, error: "document missing for job" });
  }

  // P0 provider slot (D83): see triggered path above for semantics.
  {
    const slot = await claimProviderSlot(admin, job.tenant_id, null);
    if (!slot.ok) {
      log({ tick: "idle", reason: "provider-busy", job_id: job.id });
      return json(200, { ok: true, idle: true, deferred: true });
    }
    try {
      return await runEmbeddingPass(admin, job, apiKey, log, t0);
    } finally {
      await releaseProviderSlot(admin, job.tenant_id, null);
    }
  }
});
