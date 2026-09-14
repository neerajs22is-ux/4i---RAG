// embed-worker — Phase 3A.1 production paced embedding worker.
//
// Cron-driven async embedding: each invocation claims ONE due job, embeds a
// small budgeted number of Voyage vectors sequentially, persists them, and
// exits. Progress is durable (embedding IS NULL scan); retries converge.
//
// Contract: voyage-4, input_type document, 1024-dim float. Every response is
// validated (model exact, length exact, all finite) before persist. Never
// overwrites a non-NULL embedding.
//
// Rate limiting: VOYAGE_PER_TICK bounds Voyage requests per invocation.
// Initial value 2 — conservative margin below the current 3 RPM provider
// limit. Raise only after the Voyage account has higher limits. No
// batching, no concurrency, no payment logic.
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

const MODEL = "voyage-4";
const DIMENSIONS = 1024;
const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

// Per-tick Voyage request budget. Conservative for the current free Voyage
// account (3 RPM). Increase only after higher provider limits are confirmed.
const VOYAGE_PER_TICK = 2;

// Only claim jobs idle longer than this (a freshly-touched job is being
// worked or was just parsed; the next tick picks it up).
const CLAIM_IDLE_SECONDS = 45;

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

  // 4. Next budgeted NULL chunks of THIS document only.
  const { data: pending, error: listErr } = await admin.from("chunks")
    .select("chunk_id, content")
    .eq("document_id", job.document_id)
    .eq("tenant_id", job.tenant_id)
    .is("embedding", null)
    .order("page", { ascending: true })
    .order("chunk_id", { ascending: true })
    .limit(VOYAGE_PER_TICK + 1);
  if (listErr) return json(500, { ok: false, error: listErr.message });
  const queue = ((pending ?? []) as Array<{ chunk_id: string; content: string }>)
    .slice(0, VOYAGE_PER_TICK);

  let embedded = 0;
  let voyageRequests = 0;
  let http429 = 0;
  let totalTokens = 0;
  let stopped = "";
  const failures: Array<{ chunk_id: string; error: string }> = [];

  for (const row of queue) {
    if (!row.content || !row.content.trim()) {
      failures.push({ chunk_id: row.chunk_id, error: "empty content, skipped (no request sent)" });
      continue;
    }
    voyageRequests++;
    let vec: number[];
    try {
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [row.content],
          model: MODEL,
          input_type: "document",
          output_dimension: DIMENSIONS,
        }),
      });
      if (r.status === 429) {
        http429++;
        failures.push({ chunk_id: row.chunk_id, error: "voyage 429 rate-limited; stops this tick, next tick retries" });
        stopped = "rate_limited_429";
        break;
      }
      if (!r.ok) {
        const transient = r.status >= 500;
        failures.push({ chunk_id: row.chunk_id, error: `voyage status ${r.status}${transient ? " (transient)" : " (fatal)"}` });
        if (!transient) {
          stopped = `fatal voyage status ${r.status}`;
          break;
        }
        stopped = `transient voyage status ${r.status}`;
        break;
      }
      const parsed = await r.json() as {
        data?: Array<{ embedding?: number[] }>; model?: string; usage?: { total_tokens?: number };
      };
      if (parsed.model !== MODEL) {
        failures.push({ chunk_id: row.chunk_id, error: "model mismatch (fatal)" });
        stopped = "model mismatch";
        break;
      }
      vec = parsed.data?.[0]?.embedding ?? [];
      if (vec.length !== DIMENSIONS || !vec.every((v) => Number.isFinite(v))) {
        failures.push({ chunk_id: row.chunk_id, error: `invalid vector len=${vec.length} (fatal)` });
        stopped = "invalid vector";
        break;
      }
      totalTokens += parsed.usage?.total_tokens ?? 0;
    } catch (e) {
      failures.push({ chunk_id: row.chunk_id, error: `request failed (transient): ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
      stopped = "transient request failure";
      break;
    }
    const { error: upErr } = await admin.from("chunks")
      .update({ embedding: vec })
      .eq("chunk_id", row.chunk_id)
      .is("embedding", null);
    if (upErr) {
      failures.push({ chunk_id: row.chunk_id, error: `persist failed: ${upErr.message.slice(0, 120)}` });
      stopped = "persist failure";
      break;
    }
    embedded++;
  }

  const fatal = stopped !== "" && stopped !== "rate_limited_429" && !stopped.startsWith("transient");
  if (fatal) {
    await admin.from("ingest_jobs").update({
      status: "failed",
      last_error: `embedding worker fatal: ${stopped}`,
    }).eq("id", job.id);
    await admin.from("documents").update({ status: "failed" })
      .eq("id", job.document_id).eq("tenant_id", job.tenant_id);
    log({ tick: "failed", job_id: job.id, tenant_id: job.tenant_id, reason: stopped });
    return json(500, { ok: false, fatal: true, reason: stopped });
  }

  // 5. Completion check: succeed/ready ONLY when no NULL embeddings remain.
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
    });
    return json(200, {
      ok: true, completed: true, job_id: job.id, document_id: job.document_id,
      embedded_this_tick: embedded, voyage_requests: voyageRequests,
      http_429: http429, total_tokens: totalTokens,
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
    stopped: stopped || "budget exhausted",
  });
  return json(200, {
    ok: true, completed: false, job_id: job.id, document_id: job.document_id,
    embedded_this_tick: embedded, remaining_null: left,
    voyage_requests: voyageRequests, http_429: http429,
    stopped: stopped || "budget exhausted", total_tokens: totalTokens,
    total_ms: Math.round(performance.now() - t0),
  });
});
