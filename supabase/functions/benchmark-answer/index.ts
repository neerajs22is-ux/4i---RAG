// benchmark-answer — benchmark-only answer/evaluation endpoint.
//
// Benchmark-only Edge Function (NOT deployed in Step 4 unless explicitly
// authorized alongside benchmark-retrieval). This is the isolated counterpart
// of /ask downstream of retrieval: it runs the EXACT shared answer semantics
// (clarification gate, evidence gate, grounded generation, citation guard,
// tripwire, correctness aggregation) over caller-supplied benchmark evidence.
//
// Deliberate differences from /ask: no retrieval, no conversation creation, no
// message persistence, no conversation_id, no Voyage calls. It never imports
// /ask, never writes conversations/messages/documents/chunks, and never calls
// the production match_chunks RPC. Evidence tenant/provenance is validated
// before use.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, corsPreflight } from "../_shared/cors.ts";
import { requestTooLarge } from "../_shared/request-size.ts";
import {
  enforceCostGate,
  recordProviderUse,
  withProviderSlot,
  SlotBusyError,
} from "../_shared/cost-control.ts";
import { MANTLE_CHAT_PATH } from "../_shared/grounding.ts";
import {
  runBenchmarkAnswer,
  type BenchmarkAnswerEvidence,
} from "../_shared/benchmark-answer.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKENS = 1024;
const MANTLE_BASE_URL = "https://bedrock-mantle.ap-south-1.api.aws/v1";

Deno.serve(async (req: Request): Promise<Response> => {
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
  const query = String(body.query ?? "").trim();
  if (!UUID_RE.test(tenantId)) return json(400, { ok: false, error: "invalid tenant_id" });
  if (!query || query.length > 1000) return json(400, { ok: false, error: "invalid query" });

  const { data: mem } = await db.from("memberships")
    .select("tenant_id, role").eq("tenant_id", tenantId).eq("user_id", caller).limit(1);
  if (!mem || mem.length === 0) return json(403, { ok: false, error: "not a member of this tenant" });
  // M-10: benchmark endpoints spend provider budget on caller-supplied
  // evidence without owning documents. Restrict to tenant managers so a
  // compromised member cannot turn them into a public generation oracle.
  // Member use stays on /ask + /query-chunks.
  const role = (mem[0] as { role?: string }).role;
  if (role !== "owner" && role !== "admin") {
    return json(403, { ok: false, error: "benchmarks require a workspace manager" });
  }

  // P0 cost controls (D83): manager-only is necessary but not sufficient —
  // one eval run is 66+ Mantle calls. Kill switch + minute/daily gate apply
  // to managers too.
  {
    const blocked = await enforceCostGate(db, tenantId, caller, "benchmark-answer");
    if (blocked) return json(blocked.status, blocked.body);
  }

  if (!Array.isArray(body.evidence)) {
    return json(400, { ok: false, error: "evidence must be an array" });
  }
  const evidence = body.evidence as BenchmarkAnswerEvidence[];
  if (evidence.length > 20) {
    return json(400, { ok: false, error: "evidence exceeds the benchmark cap" });
  }
  const priorCount = Number(body.prior_count ?? 0);
  const docCount = Number(body.doc_count ?? 0);
  if (!Number.isInteger(priorCount) || priorCount < 0 || !Number.isInteger(docCount) || docCount < 0) {
    return json(400, { ok: false, error: "prior_count and doc_count must be non-negative integers" });
  }
  const retrievalMs = body.retrieval_ms == null ? null : Number(body.retrieval_ms);
  if (retrievalMs !== null && (!Number.isFinite(retrievalMs) || retrievalMs < 0)) {
    return json(400, { ok: false, error: "retrieval_ms must be a non-negative number" });
  }

  const provider = String(body.provider ?? "");
  const model = String(body.model ?? "");
  const reranker = String(body.reranker ?? "");
  const benchmarkRunId = String(body.benchmark_run_id ?? "");
  if (provider !== "jina" || model !== "jina-embeddings-v5-text-small" || !benchmarkRunId) {
    return json(400, { ok: false, error: "benchmark provider, model and run identity are required" });
  }
  if (reranker !== "none" && reranker !== "jina-reranker-v3.5") {
    return json(400, { ok: false, error: "reranker must be none or jina-reranker-v3.5" });
  }

  const modelId = Deno.env.get("ANSWER_MODEL_ID") ?? "";
  const mantleKey = Deno.env.get("MANTLE_API_KEY") ?? "";
  if (!modelId) return json(500, { ok: false, error: "ANSWER_MODEL_ID is not configured" });
  if (!mantleKey) {
    return json(500, { ok: false, error: "answer model credentials are not configured" });
  }
  const checkerEnabled = Deno.env.get("CORRECTNESS_CHECKER_ENABLED") === "true";

  // One provider slot for the whole benchmark answer (sequential internal
  // calls hold at most one slot at a time by construction of the helper).
  let result;
  try {
    result = await withProviderSlot(db, tenantId, caller, () => runBenchmarkAnswer({
      tenantId,
      query,
      evidence,
      priorCount,
      docCount,
      retrievalMs,
      mantle: { baseUrl: MANTLE_BASE_URL, chatPath: MANTLE_CHAT_PATH, modelId, key: mantleKey, maxTokens: MAX_TOKENS },
      checkerEnabled,
    }));
  } catch (e) {
    if (e instanceof SlotBusyError) return json(503, { ok: false, error: "workspace is busy" });
    throw e;
  }
  await recordProviderUse(db, tenantId, caller, "benchmark-answer",
    Math.ceil(evidence.reduce((sum, e) => sum + e.content.length, 0) / 4) + 1024);
  if (result.status !== 200) return json(result.status, result.body);
  const responseBody = result.body as Record<string, unknown>;
  console.log(JSON.stringify({
    fn: "benchmark-answer", caller, tenant_id: tenantId,
    provider, model, reranker, benchmark_run_id: benchmarkRunId,
    label: responseBody["label"], evidence: evidence.length,
  }));
  return json(200, {
    ...responseBody,
    benchmark: {
      provider, model, reranker, run_id: benchmarkRunId, retrieval_mode: "benchmark",
    },
  });
});
