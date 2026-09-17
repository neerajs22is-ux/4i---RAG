// embed-worker — Phase 3A.1 production paced embedding worker.
//
// Cron-driven async embedding: each invocation claims ONE due job and embeds a
// budgeted set of chunks in batched Voyage requests (B1), persists the vectors,
// and exits. Progress is durable (embedding IS NULL scan); retries converge.
//
// A registration that just persisted chunks can also trigger this worker
// directly (ingest-pdf → POST { job_id } with the same x-worker-key): the
// triggered run claims ONLY that job, so embedding starts seconds after parse
// instead of waiting for the next cron tick. The cron sweep remains the
// backstop — a failed or lost trigger changes nothing about recovery.
//
// Contract: voyage-4, input_type document, 1024-dim float. Every response is
// validated (model exact, count exact, index mapping complete, all finite)
// before persist — a malformed batch persists nothing. Never overwrites a
// non-NULL embedding.
//
// Rate limiting: per tick, at most REQUESTS_PER_TICK Voyage requests carrying
// at most CHUNKS_PER_REQUEST chunks and MAX_CHARS_PER_REQUEST characters each,
// sent sequentially with PACED_REQUEST_GAP_MS between them so a rolling minute
// holds at most REQUESTS_PER_TICK requests. A per-tick token guard
// (TICK_TOKEN_BUDGET) stops before breaching 10K TPM. Sized for the confirmed
// Voyage Free Tier (3 RPM / 10K TPM) with margin; raise only after higher
// provider limits are confirmed. No concurrency, no payment logic.
//
// Claiming (no new schema, no lock service): compare-and-swap on
// ingest_jobs.attempts — read the oldest processing job, UPDATE only if
// attempts is unchanged. A lost race exits idle. Combined with the
// IS-NULL/ON-CONFLICT write guards, overlapping invocations stay safe.
//
// Auth: service-to-service shared secret (WORKER_CRON_KEY Edge secret,
// x-worker-key header, timing-safe compare). verify_jwt is OFF for this
// function only (see supabase/config.toml); the secret check is the gate.
// Logs metadata only. Never keys, content, vectors, or tokens.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  exceedsTokenBudget,
  parseBatchResponse,
  planBatches,
  type EmbedCandidate,
} from "../_shared/embed-batch.ts";

const MODEL = "voyage-4";
const DIMENSIONS = 1024;
const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

// Batched embedding budget (B1, 3 RPM pacing per the speed optimization).
// Voyage accepts an array of inputs per request, so one request can carry many
// chunks. These application budgets keep the worker inside the confirmed free
// Voyage account limits (3 RPM / 10K TPM):
//   12 chunks/request at ≈950 chars ≈ ≈2.8K tokens (hard cap 12K chars)
//   3 sequential requests/tick, ~20 s apart → ≤ 3 requests in any rolling
//   minute and ≤ ≈8.6K tokens/min ≈ 86% of the 10K TPM budget, with the
//   per-tick token guard as a backstop. Query embeddings during ingestion
//   share the same budget, hence the margin.
// Voyage's own ceiling for voyage-4 is 1,000 inputs / 320K tokens per request —
// far above these numbers, which protect the account limits, not the provider.
const CHUNKS_PER_REQUEST = 12;
const REQUESTS_PER_TICK = 3;
const MAX_CHARS_PER_REQUEST = 12_000;
const MAX_CHUNKS_PER_TICK = CHUNKS_PER_REQUEST * REQUESTS_PER_TICK;
/** Sequential gap between this tick's Voyage requests (paced 3 RPM). */
const PACED_REQUEST_GAP_MS = 20_000;
/** This tick's own token contribution must stay under 10K TPM. */
const TICK_TOKEN_BUDGET = 9_500;

// Only claim jobs idle longer than this (a freshly-touched job is being
// worked or was just parsed; the next tick picks it up). Direct triggers
// (ingest-pdf after durable chunk persistence) bypass this threshold by
// naming the parse-complete job explicitly.
const CLAIM_IDLE_SECONDS = 45;

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
 * One budgeted embedding pass over a claimed job's NULL chunks.
 *
 * Shared by the cron sweep and the direct post-parse trigger: at most
 * REQUESTS_PER_TICK sequential Voyage requests (≈20 s apart), each validated
 * whole-batch-before-write, each chunk written once behind the non-NULL
 * guard. Completion (document ready + job succeeded) happens in this same
 * pass when no NULL embeddings remain — no extra invocation is needed.
 */
async function runEmbeddingPass(
  admin: Db,
  job: ClaimedJob,
  apiKey: string,
  log: (extra: Record<string, unknown>) => void,
  t0: number,
) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // Next budgeted NULL chunks of THIS document only. One extra row tells us
  // whether more work remains after this tick without a second query.
  const { data: pending, error: listErr } = await admin.from("chunks")
    .select("chunk_id, content")
    .eq("document_id", job.document_id)
    .eq("tenant_id", job.tenant_id)
    .is("embedding", null)
    .order("page", { ascending: true })
    .order("chunk_id", { ascending: true })
    .limit(MAX_CHUNKS_PER_TICK + 1);
  if (listErr) return json(500, { ok: false, error: listErr.message });
  const candidates = ((pending ?? []) as EmbedCandidate[])
    .slice(0, MAX_CHUNKS_PER_TICK);

  let embedded = 0;
  let voyageRequests = 0;
  let http429 = 0;
  let totalTokens = 0;
  let failedThisTick = 0;
  let stopped = "";

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

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (b > 0) {
      // Paced sequential cadence: this tick's requests land ~20 s apart, so a
      // rolling 60 s window holds at most REQUESTS_PER_TICK of them.
      await sleep(PACED_REQUEST_GAP_MS);
      if (exceedsTokenBudget(totalTokens, batch.map((row) => row.content), TICK_TOKEN_BUDGET)) {
        stopped = "tpm budget; resumes next tick";
        break;
      }
    }
    voyageRequests++;
    let raw: unknown;
    try {
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: batch.map((row) => row.content),
          model: MODEL,
          input_type: "document",
          output_dimension: DIMENSIONS,
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
          ? `transient voyage status ${r.status}`
          : `fatal voyage status ${r.status}`;
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

    // Validate the WHOLE batch before persisting anything: a malformed or
    // partial response must never mark chunks as embedded.
    const parsed = parseBatchResponse(raw, batch.length);
    if (!parsed.ok) {
      failedThisTick += batch.length;
      stopped = parsed.reason;
      break;
    }
    totalTokens += parsed.tokens;

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const { error: upErr } = await admin.from("chunks")
        .update({ embedding: parsed.vectors[i] })
        .eq("chunk_id", row.chunk_id)
        .is("embedding", null);
      if (upErr) {
        failedThisTick += batch.length - i;
        stopped = "persist failure";
        break;
      }
      embedded++;
    }
    if (stopped !== "") break;
  }

  const fatal = stopped !== "" && stopped !== "rate_limited_429" && !stopped.startsWith("transient") && stopped !== "tpm budget; resumes next tick";
  if (fatal) {
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
    await admin.from("documents").update({ status: "ready", embedding_model: "voyage-4" })
      .eq("id", job.document_id).eq("tenant_id", job.tenant_id);
    await admin.from("ingest_jobs").update({ status: "succeeded", last_error: null }).eq("id", job.id);
    log({
      tick: "completed", job_id: job.id, tenant_id: job.tenant_id,
      document_id: job.document_id, embedded_this_tick: embedded,
      voyage_requests: voyageRequests, total_tokens: totalTokens,
      failed_this_tick: failedThisTick,
    });
    return json(200, {
      ok: true, completed: true, job_id: job.id, document_id: job.document_id,
      embedded_this_tick: embedded, voyage_requests: voyageRequests,
      http_429: http429, total_tokens: totalTokens,
      failed_this_tick: failedThisTick,
      total_ms: Math.round(performance.now() - t0),
    });
  }

  await admin.from("ingest_jobs").update({
    last_error: stopped === "rate_limited_429"
      ? "voyage 429 rate-limited; resumes next tick"
      : stopped !== "" ? `embedding worker: ${stopped}; resumes next tick` : null,
  }).eq("id", job.id);
  log({
    tick: "progress", job_id: job.id, tenant_id: job.tenant_id,
    embedded_this_tick: embedded, remaining_null: left,
    voyage_requests: voyageRequests, http_429: http429,
    failed_this_tick: failedThisTick,
    stopped: stopped || "budget exhausted",
  });
  return json(200, {
    ok: true, completed: false, job_id: job.id, document_id: job.document_id,
    embedded_this_tick: embedded, remaining_null: left,
    voyage_requests: voyageRequests, http_429: http429,
    stopped: stopped || "budget exhausted", total_tokens: totalTokens,
    failed_this_tick: failedThisTick,
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
  const apiKey = Deno.env.get("VOYAGE_API_KEY") ?? "";
  if (!apiKey) return json(500, { ok: false, error: "VOYAGE_API_KEY not configured" });

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
    return runEmbeddingPass(admin, claimed[0] as ClaimedJob, apiKey, log, t0);
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

  return runEmbeddingPass(admin, job, apiKey, log, t0);
});
