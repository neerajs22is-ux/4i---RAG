// benchmark-ingest — benchmark-only passage-embedding population.
//
// Benchmark-only Edge Function. Reads chunk content through the caller's JWT
// (member RLS), embeds it with Jina (retrieval.passage) using the runtime
// JINA_API_KEY secret, and writes ONLY to public.benchmark_embeddings through
// a service-role client constrained to the validated tenant/run/chunks.
//
// It never reads production vectors, never writes chunks/documents/jobs/
// conversations/messages, never calls Voyage or any production endpoint, and
// never imports /ask, /query-chunks, /ingest-pdf or /embed-worker. Writes are
// all-or-nothing per call: every batch is embedded and validated first, and
// rows are inserted exactly once afterward.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, corsPreflight } from "../_shared/cors.ts";
import { requestTooLarge } from "../_shared/request-size.ts";
import {
  enforceCostGate,
  recordProviderUse,
  withProviderSlot,
  SlotBusyError,
} from "../_shared/cost-control.ts";
import {
  BENCHMARK_JINA_EMBED_API_KEY_ENV,
  callBenchmarkJinaEmbed,
  parseBenchmarkJinaEmbedResponse,
} from "../_shared/benchmark-jina-embed.ts";
import {
  BENCHMARK_INGEST_MAX_CHUNKS,
  BENCHMARK_INGEST_RUN_ID_RE,
  ingestBenchmarkEmbeddings,
} from "../_shared/benchmark-ingest.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
type Db = any;

Deno.serve(async (req: Request): Promise<Response> => {
  const t0 = performance.now();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(req) } });
  const preflight = corsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  // Anonymous-abuse hardening: reject clearly oversized requests BEFORE
  // auth/body parsing — header read only, no DB, no provider, no counter.
  if (requestTooLarge(req)) return json(413, { ok: false, error: "request too large" });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { ok: false, error: "missing bearer token" });
  const db = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );
  const { data: udata, error: uerr } = await db.auth.getUser(jwt);
  if (uerr || !udata?.user) return json(401, { ok: false, error: "invalid token" });
  const caller = udata.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  const tenantId = String(body.tenant_id ?? "");
  const runId = String(body.benchmark_run_id ?? "");
  if (!UUID_RE.test(tenantId)) return json(400, { ok: false, error: "invalid tenant_id" });
  if (!BENCHMARK_INGEST_RUN_ID_RE.test(runId)) {
    return json(400, { ok: false, error: "benchmark_run_id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}" });
  }
  if (!Array.isArray(body.chunk_ids) || body.chunk_ids.length === 0 ||
      body.chunk_ids.length > BENCHMARK_INGEST_MAX_CHUNKS ||
      !body.chunk_ids.every((x) => typeof x === "string" && x.trim().length > 0)) {
    return json(400, { ok: false, error: `chunk_ids must be 1..${BENCHMARK_INGEST_MAX_CHUNKS} non-empty strings` });
  }
  const chunkIds = body.chunk_ids as string[];

  const { data: mem } = await db.from("memberships")
    .select("tenant_id, role").eq("tenant_id", tenantId).eq("user_id", caller).limit(1);
  if (!mem || mem.length === 0) return json(403, { ok: false, error: "not a member of this tenant" });
  // M-10: manager-only (see benchmark-answer). Writes via service_role.
  const role = (mem[0] as { role?: string }).role;
  if (role !== "owner" && role !== "admin") {
    return json(403, { ok: false, error: "benchmarks require a workspace manager" });
  }

  // P0 cost controls (D83): managers are gated too (bulk embedding on demand).
  {
    const blocked = await enforceCostGate(db, tenantId, caller, "benchmark-ingest");
    if (blocked) return json(blocked.status, blocked.body);
  }

  // Tenant-validated reads only: every requested chunk must exist in this
  // tenant, otherwise nothing is embedded and nothing is written.
  const { data: rows, error: rowsErr } = await db.from("chunks")
    .select("chunk_id, content")
    .eq("tenant_id", tenantId)
    .in("chunk_id", chunkIds);
  if (rowsErr) {
    console.error(JSON.stringify({ scope: "db-error", context: "benchmark chunks read failed", code: rowsErr.code, detail: rowsErr.message.slice(0, 200) }));
    return json(500, { ok: false, error: "benchmark chunks read failed" });
  }
  const byId = new Map(((rows ?? []) as Array<{ chunk_id: string; content: string }>).map((r) => [r.chunk_id, r]));
  if (chunkIds.some((id) => !byId.has(id))) {
    return json(400, { ok: false, error: "every chunk_id must exist in this tenant" });
  }
  const chunks = chunkIds.map((id) => {
    const row = byId.get(id) as { chunk_id: string; content: string };
    return { chunk_id: row.chunk_id, content: row.content };
  });

  const apiKey = Deno.env.get(BENCHMARK_JINA_EMBED_API_KEY_ENV) ?? "";
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!svcKey) return json(500, { ok: false, error: "platform secret unavailable" });
  const admin: Db = createClient(Deno.env.get("SUPABASE_URL") ?? "", svcKey);

  // One provider slot for the whole benchmark ingestion (its batch embeds
  // run sequentially under this one slot).
  let result;
  try {
    result = await withProviderSlot(db, tenantId, caller, () => ingestBenchmarkEmbeddings({
      tenantId,
      runId,
      chunks,
      embedBatch: async (inputs) => {
        const call = await callBenchmarkJinaEmbed({ apiKey, task: "retrieval.passage", inputs });
        if (!call.ok) throw new Error(call.detail);
        const parsed = parseBenchmarkJinaEmbedResponse(call.payload, inputs.length);
        if (!parsed.ok) throw new Error(parsed.error);
        return { vectors: parsed.parsed.vectors, tokens: parsed.parsed.tokens };
      },
      // Constrained writer: benchmark_embeddings rows only, for exactly the
      // validated tenant, chunks, provider, model and run.
      insertRows: async (staged) => {
        const { error } = await admin.from("benchmark_embeddings").insert(staged);
        if (error) throw new Error(error.message);
      },
    }));
  } catch (e) {
    if (e instanceof SlotBusyError) return json(503, { ok: false, error: "workspace is busy" });
    throw e;
  }
  await recordProviderUse(db, tenantId, caller, "benchmark-ingest", result.ok ? result.tokens : 0);
  const totalMs = Math.round(performance.now() - t0);
  if (!result.ok) {
    console.log(JSON.stringify({
      fn: "benchmark-ingest", caller, tenant_id: tenantId, benchmark_run_id: runId,
      error: result.error, requests: result.requests,
    }));
    return json(502, { ok: false, error: result.error });
  }
  console.log(JSON.stringify({
    fn: "benchmark-ingest", caller, tenant_id: tenantId, benchmark_run_id: runId,
    embedded: result.embedded, requests: result.requests, tokens: result.tokens, total_ms: totalMs,
  }));
  return json(200, {
    ok: true,
    provider: "jina",
    model: "jina-embeddings-v5-text-small",
    benchmark_run_id: runId,
    embedded: result.embedded,
    requests: result.requests,
    tokens: result.tokens,
    total_ms: totalMs,
  });
});
