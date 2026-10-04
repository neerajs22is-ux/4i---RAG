// ask — Phase 3C.1 grounded answer-generation baseline.
//
// H1 pre-RAG router: obvious conversational utterances ("Hi", "Thanks",
// "Good morning") are answered with a fixed server-authored reply and bypass
// embedding/retrieval/reranking/gate/generation entirely. The router is
// deterministic, conservative (whole-message phrases only) and fails closed;
// every non-conversational query takes the unchanged path below.
//
// Authenticated query → query-chunks evidence (reused, never duplicated) →
// deterministic sufficiency gate → grounded generation (Bedrock Mantle Chat
// Completions, temp 0.0) → citation guard → groundedness tripwire → persisted
// conversation. Refusals/clarifications never touch the LLM.
//
// Grounding contract: the model is not authoritative; retrieved evidence is.
// No reviewer, no planner, no loops, no regeneration. Citation-guard failure
// is a hard safe failure (502). Tripwire findings downgrade the label with
// an explicit note (no silent rewrite, no second generation).
// Caller-JWT data plane throughout (RLS applies); no service_role.
// Logs metadata only. Never keys, content, vectors, or tokens.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, corsPreflight } from "../_shared/cors.ts";
import { buildCitationSources } from "../_shared/citation-sources.ts";
import { combineScopes } from "../_shared/temp-scope.ts";
import { routePreRag } from "../_shared/pre-rag-router.ts";
import { classifyFollowUp } from "../_shared/follow-up-detector.ts";
import {
  callRewriteModel,
  planRewrite,
  resolveRetrievalQuery,
} from "../_shared/query-rewrite.ts";
import {
  CONTEXT_HISTORY_LIMIT,
  summarizeConversationContext,
} from "../_shared/conversation-context.ts";
import {
  buildTelemetry,
  checkerTelemetry,
  contextTelemetry,
  evidenceTelemetry,
  generationTelemetry,
  rewriteTelemetry,
  zeroEmbedding,
  zeroRerank,
  zeroRewrite,
  type EmbeddingTelemetry,
  type RerankTelemetry,
  type RewriteTelemetry,
} from "../_shared/usage-telemetry.ts";
import {
  enforceCostGate,
  recordProviderUse,
  withProviderSlot,
  SlotBusyError,
} from "../_shared/cost-control.ts";
import { requestTooLarge } from "../_shared/request-size.ts";
import {
  aggregateCorrectness,
  evaluateAnswer,
  shouldRunChecker,
  type CorrectnessVerdict,
  type GateVerdictIn,
} from "../_shared/correctness.ts";
import {
  buildEvidenceBlock,
  checkGroundedness,
  clarificationTrigger,
  mapMantleFailure,
  MANTLE_CHAT_PATH,
  parseCitations,
  parseMantleResponse,
  promptModeFor,
  REFUSAL_TEXT,
  renderPrompt,
  tripwireDiagnostics,
  validateCitations,
  verifyEvidence,
  type EvidenceItem,
} from "../_shared/grounding.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKENS = 1024;
// Fixed production Mantle endpoint (ap-south-1). Never taken from the
// request: the browser must not steer the model-provider URL.
const MANTLE_BASE_URL = "https://bedrock-mantle.ap-south-1.api.aws/v1";

function stripThink(text: string): string {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

Deno.serve(async (req: Request): Promise<Response> => {
  const t0 = performance.now();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders(req) },
    });
  const preflight = corsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  // Anonymous-abuse hardening: reject clearly oversized requests BEFORE
  // auth/body parsing — header read only, no DB, no provider, no counter.
  if (requestTooLarge(req)) return json(413, { ok: false, error: "request too large" });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { ok: false, error: "missing bearer token" });
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const db = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
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
  const conversationId = body.conversation_id != null ? String(body.conversation_id) : null;
  if (!UUID_RE.test(tenantId)) return json(400, { ok: false, error: "invalid tenant_id" });
  if (!query || query.length > 1000) return json(400, { ok: false, error: "invalid query" });
  if (conversationId !== null && !UUID_RE.test(conversationId)) {
    return json(400, { ok: false, error: "invalid conversation_id" });
  }
  const notebookId = body.notebook_id != null ? String(body.notebook_id) : null;
  if (notebookId !== null && !UUID_RE.test(notebookId)) {
    return json(400, { ok: false, error: "invalid notebook_id" });
  }

  const { data: mem } = await db.from("memberships")
    .select("tenant_id").eq("tenant_id", tenantId).eq("user_id", caller).limit(1);
  if (!mem || mem.length === 0) return json(403, { ok: false, error: "not a member of this tenant" });

  // P0 cost controls (D83): kill switch, then combined per-minute + daily
  // gate (tenant + user) before any spend (embed, retrieval, rerank,
  // generation, rewrite, checker). Denials return BEFORE conversation
  // creation, so blocked requests persist nothing and fuel no retries:
  // 429 carries Retry-After, 503 carries none (no thundering herd).
  {
    const blocked = await enforceCostGate(db, tenantId, caller, "ask");
    if (blocked) return json(blocked.status, blocked.body);
  }

  // L-6: bound unbounded conversation creation (spam/DB growth). Normal
  // use never approaches this; loops creating convs hit 429.
  const MAX_CONVERSATIONS_PER_TENANT = 500;
  if (!conversationId) {
    const { count: convCount } = await db.from("conversations")
      .select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
    if ((convCount ?? 0) >= MAX_CONVERSATIONS_PER_TENANT) {
      return json(429, { ok: false, error: "conversation limit reached for this workspace" });
    }
  }

  // Conversation: verify ownership or create. History count feeds the
  // clarification gate (referent check); full transcripts are never sent
  // to the model in this baseline.
  let convId = conversationId;
  let priorCount = 0;
  if (convId) {
    const { data: conv, error: convErr } = await db.from("conversations")
      .select("id").eq("id", convId).eq("tenant_id", tenantId).single();
    if (convErr || !conv) return json(404, { ok: false, error: "conversation not found" });
    const { count } = await db.from("messages")
      .select("id", { count: "exact", head: true }).eq("conversation_id", convId);
    priorCount = count ?? 0;
  } else {
    const { data: created, error: createErr } = await db.from("conversations").insert({
      tenant_id: tenantId,
      user_id: caller,
      title: query.slice(0, 80),
    }).select("id").single();
    if (createErr || !created) return json(500, { ok: false, error: "conversation create failed" });
    convId = (created as { id: string }).id;
  }
  async function persistAssistant(
    content: string,
    label: string,
    sources: unknown[],
    modelIds: unknown,
    timings: unknown,
    grounded: boolean | null,
  ): Promise<string | null> {
    // Single multi-row insert: PostgREST requires uniform keys across rows
    // (PGRST102 otherwise). User row carries neutral metadata columns.
    const { error } = await db.from("messages").insert([
      {
        conversation_id: convId, tenant_id: tenantId, role: "user",
        content: query, label: null, sources: [], model_ids: {}, timings: {},
      },
      {
        conversation_id: convId, tenant_id: tenantId, role: "assistant",
        content, label, sources, model_ids: modelIds, timings: { ...(timings as object), grounded },
      },
    ]);
    if (error) {
      // M-9: never return driver text to the caller. The frontend maps 5xx
      // to a generic message; direct API callers get a static code.
      console.log(JSON.stringify({ fn: "ask", caller, tenant_id: tenantId, path: "persist-failed", error: error.message.slice(0, 200) }));
      return "persistence failed";
    }
    return null;
  }

  // 0. H1 deterministic pre-RAG router — no LLM, no retrieval, no state.
  //
  // Obvious conversational utterances ("Hi", "Thanks", "Good morning") are
  // answered with a fixed server-authored reply and bypass query embedding,
  // retrieval, reranking, the evidence gate, RAG generation and the
  // correctness checker entirely. Placement is deliberate: after auth,
  // membership and conversation resolution (so the exchange still persists
  // normally), before every expensive stage.
  //
  // The router is conservative and fails closed: only a whole-message
  // conversational phrase matches; any message carrying actual content —
  // including "Hi, what is the minimum investment?" — continues through the
  // unchanged RAG path below, as does every UNKNOWN input.
  const tRo0 = performance.now();
  const route = routePreRag(query);
  const routerMs = Math.round(performance.now() - tRo0);
  // H2B telemetry: the router section is shared by every response path.
  const routerTelemetry = {
    classification: route.classification,
    bypassed: route.classification === "CONVERSATIONAL",
    latency_ms: routerMs,
  };
  const routerInfo = (bypassed: boolean) => ({
    classification: route.classification,
    bypassed,
    latency_ms: routerMs,
  });
  console.log(JSON.stringify({
    fn: "ask", caller, tenant_id: tenantId, path: "router",
    classification: route.classification,
    bypassed: route.classification === "CONVERSATIONAL",
    router_ms: routerMs,
  }));
  if (route.classification === "CONVERSATIONAL" && route.response !== null) {
    // No provider work happens on this path: every downstream section is a
    // deterministic zero, never a fabricated usage number. The context layer
    // also does not run here (H1 bypass stays the cheapest path).
    const telemetry = buildTelemetry({ router: routerTelemetry });
    const persistErr = await persistAssistant(
      route.response, "conversational", [], { prompt: null },
      { router_ms: routerMs, total_ms: Math.round(performance.now() - t0), telemetry }, null,
    );
    return json(200, {
      ok: true, answer: route.response, label: "conversational",
      citations: [], evidence_count: 0, grounded: null, conversation_id: convId,
      router: routerInfo(true),
      telemetry,
      persisted: persistErr === null,
      ...(persistErr ? { persistence_error: persistErr } : {}),
    });
  }

  // H3A conversation-context layer: one bounded read of the most recent
  // messages plus a deterministic follow-up classification. This is
  // telemetry-only in H3A — nothing below consults it, and the RAG path
  // (scope, retrieval, gate, generation) is unchanged. Precedence with the
  // clarification gate: clarification remains the response authority; the
  // context signal is recorded alongside it and never produces a second
  // response or a different question.
  const tCtx0 = performance.now();
  let contextRead = summarizeConversationContext([]);
  if (priorCount > 0) {
    const { data: recent, error: ctxErr } = await db.from("messages")
      .select("role, content, sources")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: false })
      .limit(CONTEXT_HISTORY_LIMIT);
    if (ctxErr) {
      // Context is an enhancement, never a failure source: fall back to an
      // empty window and continue on the unchanged path.
      console.log(JSON.stringify({
        fn: "ask", caller, tenant_id: tenantId, path: "context-read-failed",
        error: ctxErr.message.slice(0, 160),
      }));
    } else {
      contextRead = summarizeConversationContext(recent);
    }
  }
  const followUpClass = classifyFollowUp({
    message: query,
    hasPreviousTurn: priorCount > 0,
  });
  const contextMs = Math.round(performance.now() - tCtx0);
  const contextPart = contextTelemetry({
    used: contextRead.previousMessageAvailable,
    classification: followUpClass,
    historyTurnsRead: contextRead.historyTurnsRead,
    previousMessageAvailable: contextRead.previousMessageAvailable,
    priorEvidenceAvailable: contextRead.priorEvidenceAvailable,
    latencyMs: contextMs,
  });
  console.log(JSON.stringify({
    fn: "ask", caller, tenant_id: tenantId, path: "context",
    classification: followUpClass,
    history_turns_read: contextRead.historyTurnsRead,
    previous_message_available: contextRead.previousMessageAvailable,
    prior_evidence_available: contextRead.priorEvidenceAvailable,
    context_ms: contextMs,
  }));

  // 1. Bounded deterministic clarification gate (no LLM, no loops).
  const { count: docCount } = await db.from("documents")
    .select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
  const clar = clarificationTrigger(query, priorCount, docCount ?? 0);
  if (clar.needed) {
    const telemetry = buildTelemetry({ router: routerTelemetry, context: contextPart });
    const persistErr = await persistAssistant(clar.question, "clarification", [], { prompt: null }, { total_ms: Math.round(performance.now() - t0), telemetry }, null);
    console.log(JSON.stringify({ fn: "ask", caller, tenant_id: tenantId, path: "clarification", reason: clar.reason }));
    return json(200, {
      ok: true, answer: clar.question, label: "clarification",
      citations: [], evidence_count: 0, grounded: null, conversation_id: convId,
      router: routerInfo(false),
      telemetry,
      persisted: persistErr === null,
      ...(persistErr ? { persistence_error: persistErr } : {}),
    });
  }

  // 1b. B2 — notebook scope resolved SERVER-SIDE (selection is never trusted
  // from the client). Selected, non-archived, same-tenant documents only.
  let scopedDocIds: string[] | null = null;
  if (notebookId) {
    const { data: nb } = await db.from("notebooks")
      .select("id").eq("id", notebookId).eq("tenant_id", tenantId).limit(1);
    if (!nb || nb.length === 0) return json(404, { ok: false, error: "notebook not found" });
    const { data: srcRows, error: srcErr } = await db.from("notebook_sources")
      .select("document_id")
      .eq("notebook_id", notebookId).eq("tenant_id", tenantId).eq("selected", true);
    if (srcErr) {
      console.error(JSON.stringify({ scope: "db-error", context: "notebook sources read failed", code: srcErr.code, detail: srcErr.message.slice(0, 200) }));
      return json(500, { ok: false, error: "notebook sources read failed" });
    }
    const ids = [...new Set((srcRows ?? []).map((r: { document_id: string }) => r.document_id))];
    if (ids.length > 0) {
      const { data: live, error: liveErr } = await db.from("documents")
        .select("id").eq("tenant_id", tenantId).in("id", ids).is("archived_at", null);
      if (liveErr) {
        console.error(JSON.stringify({ scope: "db-error", context: "notebook documents read failed", code: liveErr.code, detail: liveErr.message.slice(0, 200) }));
        return json(500, { ok: false, error: "notebook documents read failed" });
      }
      scopedDocIds = (live ?? []).map((r: { id: string }) => r.id);
    }
  }

  // 1b2. Temporary conversation scope, resolved SERVER-SIDE from the
  // conversation id verified-or-created above (tenant-bound either way).
  // Ready + unexpired temporary documents only; persistent rows (NULL
  // conversation_id) can never match. Retrieval-time expiry filtering is the
  // access boundary for temporary data — cleanup is hygiene only.
  let tempDocIds: string[] = [];
  if (convId) {
    const nowIso = new Date().toISOString();
    const { data: tempRows, error: tempErr } = await db.from("documents")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("conversation_id", convId)
      .eq("status", "ready")
      .is("archived_at", null)
      .gt("expires_at", nowIso);
    if (tempErr) {
      console.error(JSON.stringify({ scope: "db-error", context: "temporary documents read failed", code: tempErr.code, detail: tempErr.message.slice(0, 200) }));
      return json(500, { ok: false, error: "temporary documents read failed" });
    }
    tempDocIds = [...new Set((tempRows ?? []).map((r: { id: string }) => r.id))];
  }
  const combined = combineScopes({
    notebookRequested: notebookId !== null,
    notebookIds: scopedDocIds,
    tempIds: tempDocIds,
  });

  // 1c. Empty notebook scope: deterministic refusal — no retrieval call, no
  // query embedding, no LLM. Same response shape as the INSUFFICIENT path.
  // Fires only when a notebook scope was requested AND nothing resolved —
  // neither persistent sources nor conversation temporaries.
  if (combined.refused) {
    const telemetry = buildTelemetry({ router: routerTelemetry, context: contextPart });
    const persistErr = await persistAssistant(
      REFUSAL_TEXT, "insufficient", [],
      { prompt: null }, { retrieval_ms: 0, total_ms: Math.round(performance.now() - t0), telemetry }, null,
    );
    console.log(JSON.stringify({
      fn: "ask", caller, tenant_id: tenantId, path: "refusal",
      verdict: "INSUFFICIENT", reason: "no-selected-sources", evidence: 0,
      notebook_id: notebookId,
    }));
    return json(200, {
      ok: true, answer: REFUSAL_TEXT, label: "insufficient",
      citations: [], evidence_count: 0,
      gate: { verdict: "INSUFFICIENT", reason: "no-selected-sources", conflicting: [] },
      grounded: null, conversation_id: convId,
      router: routerInfo(false),
      telemetry,
      persisted: persistErr === null,
      ...(persistErr ? { persistence_error: persistErr } : {}),
      scope: { notebook_id: notebookId, document_count: 0 },
    });
  }

  // 1d. H3B bounded follow-up rewrite — at most ONE model call, only for
  // FOLLOW_UP turns whose retrieval query genuinely needs the previous
  // question, and only when retrieval is actually about to run. The rewrite
  // is a RETRIEVAL query only: `query` (the original user question) remains
  // authoritative for the gate, generation, citations, and persistence.
  // Failure, timeout, or invalid output falls back to the original query with
  // no retry. Placed after the empty-scope refusal so no model call is spent
  // when no retrieval would happen.
  let retrievalQuery = query;
  let rewritePart: RewriteTelemetry = zeroRewrite();
  {
    const plan = planRewrite({
      classification: followUpClass,
      currentQuery: query,
      previousUserQuestion: contextRead.previousUserQuestion,
    });
    if (plan.eligible) {
      const rewriteModelId = Deno.env.get("ANSWER_MODEL_ID") ?? "";
      const rewriteKey = Deno.env.get("MANTLE_API_KEY") ?? "";
      if (rewriteModelId && rewriteKey) {
        // Slot-busy falls back to the original query: the rewrite is an
        // optimization, never a correctness requirement (gate/generation
        // still see the authoritative user question).
        try {
          const resolution = await withProviderSlot(db, tenantId, caller, () =>
            resolveRetrievalQuery({
              classification: followUpClass,
              currentQuery: query,
              previousUserQuestion: contextRead.previousUserQuestion,
              modelId: rewriteModelId,
              callModel: (prompt) => callRewriteModel({
                url: `${MANTLE_BASE_URL}${MANTLE_CHAT_PATH}`,
                apiKey: rewriteKey,
                model: rewriteModelId,
                prompt,
              }),
            }));
          retrievalQuery = resolution.retrievalQuery;
          rewritePart = resolution.rewrite;
          if (resolution.rewrite.attempted) {
            await recordProviderUse(db, tenantId, caller, "ask",
              Math.ceil(((resolution.rewrite.input_chars ?? 0) + (resolution.rewrite.output_chars ?? 0)) / 4));
          }
        } catch (e) {
          if (e instanceof SlotBusyError) {
            rewritePart = rewriteTelemetry({
              attempted: false, applied: false, fallback: false, reason: "slot-busy",
              inputChars: 0, outputChars: 0, latencyMs: 0, modelId: null,
              inputTokens: null, outputTokens: null,
            });
          } else {
            throw e;
          }
        }
      } else {
        rewritePart = rewriteTelemetry({
          attempted: false, applied: false, fallback: false, reason: "model-unavailable",
          inputChars: 0, outputChars: 0, latencyMs: 0, modelId: null,
          inputTokens: null, outputTokens: null,
        });
      }
    } else {
      rewritePart = rewriteTelemetry({
        attempted: false, applied: false, fallback: false, reason: plan.reason,
        inputChars: 0, outputChars: 0, latencyMs: 0, modelId: null,
        inputTokens: null, outputTokens: null,
      });
    }
    console.log(JSON.stringify({
      fn: "ask", caller, tenant_id: tenantId, path: "rewrite",
      attempted: rewritePart.attempted,
      applied: rewritePart.applied,
      fallback: rewritePart.fallback,
      reason: rewritePart.reason,
      input_chars: rewritePart.input_chars,
      output_chars: rewritePart.output_chars,
      rewrite_ms: rewritePart.latency_ms,
    }));
  }
  // Context telemetry for every path after the rewrite: `used` means the
  // context layer actually influenced retrieval (a validated rewrite applied).
  const contextPartFinal = {
    ...contextPart,
    used: rewritePart.applied,
    rewrite: rewritePart,
  };

  // 2. Retrieve evidence through the existing mechanism (reused, not copied).
  // Retrieval receives the rewritten query when one was applied; the original
  // user question is never replaced anywhere in this handler.
  const tR0 = performance.now();
  let retrieved: EvidenceItem[];
  let retrievalTokens = 0;
  let qcEmbedding: EmbeddingTelemetry | null = null;
  let qcRerank: (RerankTelemetry & { fused_candidates: number }) | null = null;
  let qcCandidates: { dense: number; lexical: number } | null = null;
  try {
    const r = await fetch(`${supabaseUrl}/functions/v1/query-chunks`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: tenantId, query: retrievalQuery,
        ...(combined.ids ? { document_ids: combined.ids } : {}),
      }),
      // L-7: bound internal retrieval so a hung query-chunks cannot hold
      // this invocation to the platform timeout.
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 200);
      console.error(JSON.stringify({ scope: "retrieval", context: "query-chunks transport failed", detail: t }));
      // Propagate cost-control signals honestly instead of relabeling them:
      // 429/503 from retrieval mean "back off", not "retrieval is broken".
      if (r.status === 429 || r.status === 503) {
        return json(r.status, { ok: false, error: "workspace is busy; retry shortly" });
      }
      return json(502, { ok: false, error: "retrieval failed" });
    }
    const rj = await r.json() as {
      ok?: boolean; error?: string; evidence?: EvidenceItem[]; query_tokens?: number;
      candidates?: { dense: number; lexical: number } | null;
      rerank?: (RerankTelemetry & { fused_candidates: number }) | null;
      embedding?: EmbeddingTelemetry | null;
    };
    if (!rj.ok) {
      console.error(JSON.stringify({ scope: "retrieval", context: "query-chunks failed", detail: String(rj.error ?? "unknown").slice(0, 200) }));
      return json(502, { ok: false, error: "retrieval failed" });
    }
    retrieved = rj.evidence ?? [];
    retrievalTokens = rj.query_tokens ?? 0;
    qcCandidates = rj.candidates ?? null;
    qcRerank = rj.rerank ?? null;
    qcEmbedding = rj.embedding ?? null;
  } catch (e) {
    console.error(JSON.stringify({ scope: "retrieval", context: "query-chunks threw", detail: (e instanceof Error ? e.message : String(e)).slice(0, 120) }));
    return json(502, { ok: false, error: "retrieval failed" });
  }
  const retrievalMs = Math.round(performance.now() - tR0);

  // H2A observability: structural retrieval trace. This path performs exactly
  // ONE retrieval round and has no expansion/retry by construction — H3B adds
  // at most one rewrite, which replaces the retrieval query but does not add
  // a retrieval. The counts make that invariant measurable per request.

  const retrievalTrace = {
    rounds: 1,
    expansions: 0,
    rerank: qcRerank,
  };

  // H2B telemetry: retrieval sections, straight from the query-chunks
  // accounting (measured provider usage, labeled estimates, calculated zeros).
  const telemetrySections = {
    retrieval: {
      rounds: 1,
      dense_count: qcCandidates?.dense ?? 0,
      lexical_count: qcCandidates?.lexical ?? 0,
      fused_count: qcRerank?.fused_candidates ?? retrieved.length,
      final_evidence_count: retrieved.length,
    },
    embedding: qcEmbedding ?? zeroEmbedding(),
    rerank: qcRerank ?? zeroRerank(),
    evidence: evidenceTelemetry(retrieved.map((e) => e.content)),
  };

  // 3. Deterministic sufficiency gate (model-free).
  const gate = verifyEvidence(query, retrieved);
  const mode = promptModeFor(gate.verdict);
  // Citation sources: identity/numbering exactly as before, plus a verbatim
  // excerpt of the already-retrieved chunk (see _shared/citation-sources.ts).
  // No retrieval, ranking, gating or generation change: the content was
  // already in memory on this path.
  const sources = buildCitationSources(retrieved);

  // 4. INSUFFICIENT (incl. empty): refusal without any model call.
  if (mode === "refuse") {
    const telemetry = buildTelemetry({ router: routerTelemetry, context: contextPartFinal, ...telemetrySections });
    const persistErr = await persistAssistant(
      REFUSAL_TEXT, "insufficient", sources,
      { prompt: null }, { retrieval_ms: retrievalMs, total_ms: Math.round(performance.now() - t0), telemetry }, null,
    );
    console.log(JSON.stringify({
      fn: "ask", caller, tenant_id: tenantId, path: "refusal",
      verdict: gate.verdict, reason: gate.reason, evidence: retrieved.length,
    }));
    return json(200, {
      ok: true, answer: REFUSAL_TEXT, label: "insufficient",
      citations: [], evidence_count: retrieved.length,
      gate: { verdict: gate.verdict, reason: gate.reason },
      grounded: null, conversation_id: convId,
      router: routerInfo(false),
      retrieval: retrievalTrace,
      telemetry,
      persisted: persistErr === null,
      ...(persistErr ? { persistence_error: persistErr } : {}),
      ...(notebookId ? { scope: { notebook_id: notebookId, document_count: (combined.ids ?? scopedDocIds ?? []).length } } : {}),
    });
  }

  // 5. Grounded generation (Bedrock Mantle Chat Completions, temp 0.0,
  // model from secrets). Server-side fetch with the Bearer key; the AWS
  // Bedrock Runtime SDK is not used on this path.
  const modelId = Deno.env.get("ANSWER_MODEL_ID") ?? "";
  const mantleKey = Deno.env.get("MANTLE_API_KEY") ?? "";
  if (!modelId) return json(500, { ok: false, error: "ANSWER_MODEL_ID is not configured" });
  if (!mantleKey) {
    return json(500, { ok: false, error: "answer model credentials are not configured" });
  }
  const { block, refs } = buildEvidenceBlock(retrieved);
  void refs;
  const { template, version: promptVersion } = renderPrompt(mode, query, block);
  const tG0 = performance.now();
  let rawAnswer: string;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const r = await withProviderSlot(db, tenantId, caller, () => fetch(`${MANTLE_BASE_URL}${MANTLE_CHAT_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mantleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: template }],
        temperature: 0.0,
        max_tokens: MAX_TOKENS,
      }),
      // L-7: bound generation so a stalled provider cannot hold the Edge
      // invocation open (availability + H-4 cost amplification).
      signal: AbortSignal.timeout(90_000),
    }));
    if (!r.ok) {
      const mapped = mapMantleFailure(r.status, await r.text());
      const failedGenerationMs = Math.round(performance.now() - tG0);
      const telemetry = buildTelemetry({
        router: routerTelemetry, context: contextPartFinal, ...telemetrySections,
        generation: generationTelemetry({ calls: 1, inputTokens: null, outputTokens: null, latencyMs: failedGenerationMs }),
      });
      console.log(JSON.stringify({
        fn: "ask", caller, tenant_id: tenantId, path: "provider-failure",
        model: modelId, failure: mapped.kind, status: mapped.status,
      }));
      await persistAssistant(
        `The answer model is currently unavailable (${modelId}). Please try again shortly.`,
        "provider-error", sources,
        { answer_model: modelId, prompt: promptVersion },
        { retrieval_ms: retrievalMs, total_ms: Math.round(performance.now() - t0), telemetry }, null,
      );
      if (mapped.kind === "throttled") return json(429, { ok: false, error: mapped.message, telemetry });
      if (mapped.kind === "auth") return json(502, { ok: false, error: mapped.message, telemetry });
      return json(502, { ok: false, error: mapped.message, telemetry });
    }
    const parsed = parseMantleResponse(await r.json());
    if (!parsed.ok) {
      const failedGenerationMs = Math.round(performance.now() - tG0);
      const telemetry = buildTelemetry({
        router: routerTelemetry, context: contextPartFinal, ...telemetrySections,
        generation: generationTelemetry({ calls: 1, inputTokens: null, outputTokens: null, latencyMs: failedGenerationMs }),
      });
      await persistAssistant(
        "The model returned an invalid response. Please try again.",
        "provider-error", sources,
        { answer_model: modelId, prompt: promptVersion },
        { retrieval_ms: retrievalMs, total_ms: Math.round(performance.now() - t0), telemetry }, null,
      );
      return json(502, { ok: false, error: parsed.error, telemetry });
    }
    rawAnswer = parsed.text;
    inputTokens = parsed.inputTokens;
    outputTokens = parsed.outputTokens;
    await recordProviderUse(db, tenantId, caller, "ask", inputTokens + outputTokens);
  } catch (e) {
    // Slot-busy degrades exactly like provider throttling: persist the same
    // provider-error shape (no new label, no UI change) and return 429
    // WITHOUT Retry-After so a busy workspace does not thundering-herd.
    if (e instanceof SlotBusyError) {
      const busyMs = Math.round(performance.now() - tG0);
      const telemetry = buildTelemetry({
        router: routerTelemetry, context: contextPartFinal, ...telemetrySections,
        generation: generationTelemetry({ calls: 0, inputTokens: null, outputTokens: null, latencyMs: busyMs }),
      });
      await persistAssistant(
        "The workspace is busy right now. Please try again shortly.",
        "provider-error", sources,
        { answer_model: modelId, prompt: promptVersion },
        { retrieval_ms: retrievalMs, total_ms: Math.round(performance.now() - t0), telemetry }, null,
      );
      return json(429, { ok: false, error: "workspace is busy; retry shortly", telemetry });
    }
    const msg = e instanceof Error ? e.message : String(e);
    const failedGenerationMs = Math.round(performance.now() - tG0);
    const telemetry = buildTelemetry({
      router: routerTelemetry, context: contextPartFinal, ...telemetrySections,
      generation: generationTelemetry({ calls: 1, inputTokens: null, outputTokens: null, latencyMs: failedGenerationMs }),
    });
    console.log(JSON.stringify({
      fn: "ask", caller, tenant_id: tenantId, path: "provider-failure",
      model: modelId, failure: "transport", error: msg.slice(0, 200),
    }));
    await persistAssistant(
      `The answer model is currently unavailable (${modelId}). Please try again shortly.`,
      "provider-error", sources,
      { answer_model: modelId, prompt: promptVersion },
      { retrieval_ms: retrievalMs, total_ms: Math.round(performance.now() - t0), telemetry }, null,
    );
    return json(502, {
      ok: false,
      error: `answer generation failed (model ${modelId}). Check model access and configuration, then retry.`,
      telemetry,
    });
  }
  const generationMs = Math.round(performance.now() - tG0);
  const answer = stripThink(rawAnswer);
  if (!answer) {
    const telemetry = buildTelemetry({
      router: routerTelemetry, context: contextPartFinal, ...telemetrySections,
      generation: generationTelemetry({ calls: 1, inputTokens, outputTokens, latencyMs: generationMs }),
    });
    await persistAssistant(
      "The model returned an empty response. Please try again.",
      "provider-error", sources,
      { answer_model: modelId, prompt: promptVersion },
      { retrieval_ms: retrievalMs, generation_ms: generationMs, total_ms: Math.round(performance.now() - t0), telemetry }, null,
    );
    return json(502, { ok: false, error: "model returned an empty response", telemetry });
  }

  // 6. Deterministic citation guard (hard failure, never silent).
  const tC0 = performance.now();
  const guard = validateCitations(answer, retrieved, tenantId);
  const citationGuardMs = Math.round(performance.now() - tC0);
  if (!guard.ok) {
    const telemetry = buildTelemetry({
      router: routerTelemetry, context: contextPartFinal, ...telemetrySections,
      generation: generationTelemetry({ calls: 1, inputTokens, outputTokens, latencyMs: generationMs }),
    });
    await persistAssistant(answer, "invalid", sources,
      { answer_model: modelId, prompt: promptVersion },
      { retrieval_ms: retrievalMs, generation_ms: generationMs, total_ms: Math.round(performance.now() - t0), telemetry }, false);
    console.log(JSON.stringify({
      fn: "ask", caller, tenant_id: tenantId, path: "citation-invalid",
      errors: guard.errors,
    }));
    return json(502, {
      ok: false, error: "answer failed citation validation",
      errors: guard.errors, conversation_id: convId, telemetry,
    });
  }

  // 7. Groundedness tripwire (downgrade + note; no regeneration in baseline).
  // Diagnostics (Step 3C.19): tripwireDiagnostics only explains the EXISTING
  // decision with a static category + bounded finding refs. No new detection.
  const tT0 = performance.now();
  const trip = checkGroundedness(answer, retrieved.map((e) => e.content));
  const tripDiag = tripwireDiagnostics(trip);
  const tripwireMs = Math.round(performance.now() - tT0);
  let label = mode === "direct" ? (trip.grounded ? "direct" : "partial") : mode;
  let groundingNote: string | null = trip.grounded ? null :
    "Some claims could not be fully verified against the retrieved evidence; treat numbers and qualifiers with care.";
  const citedIds = [...new Set(parseCitations(answer))];
  const citations = citedIds.map((n) => sources[n - 1]).filter(Boolean);

  // 7b. Bounded answer-correctness check (Step 3C.15: flag-gated, advisory).
  // Disabled by default the path below is dead code and behavior is exactly
  // as before. Never runs for INSUFFICIENT (returned above). Advisory only:
  // may downgrade direct->partial with a static note; never upgrades,
  // refuses, regenerates, or touches HTTP status, citations, or tenant
  // decisions. INVALID preserves the original result.
  const checkerEnabled = Deno.env.get("CORRECTNESS_CHECKER_ENABLED") === "true";
  let correctnessVerdict: CorrectnessVerdict | null = null;
  let correctnessMs: number | null = null;
  let correctness: {
    invoked: boolean;
    verdict: CorrectnessVerdict | null;
    invalid_reason: string | null;
    latency_ms: number | null;
    attempts: number;
    output_chars: number | null;
    output_tokens: number | null;
  } | null = null;
  let aggregationMs: number | null = null;
  if (shouldRunChecker(checkerEnabled, gate.verdict)) {
    // Advisory only: slot-busy skips the check (never blocks the answer).
    try {
      const outcome = await withProviderSlot(db, tenantId, caller, () => evaluateAnswer({
        fetchFn: fetch,
        url: `${MANTLE_BASE_URL}${MANTLE_CHAT_PATH}`,
        mantleKey,
        model: modelId,
        input: {
          question: query,
          answer,
          evidence: retrieved.map((e, i) => ({ n: i + 1, page: e.page, text: e.content })),
          gate_verdict: gate.verdict as GateVerdictIn,
          citations: citedIds.map((n) => ({ n, chunk_ref: sources[n - 1]?.chunk_id ?? `S${n}` })),
        },
      }));
      if (outcome.invoked) {
        await recordProviderUse(db, tenantId, caller, "ask",
          (outcome.outputTokens ?? 0) > 0 ? (outcome.outputTokens as number) : 500);
        correctnessVerdict = outcome.verdict;
      correctnessMs = outcome.latencyMs;
      correctness = {
        invoked: true,
        verdict: outcome.verdict,
        invalid_reason: outcome.invalidReason,
        latency_ms: outcome.latencyMs,
        attempts: outcome.attempts,
        output_chars: outcome.outputChars,
        output_tokens: outcome.outputTokens,
      };
      const tA0 = performance.now();
      const agg = aggregateCorrectness(label, groundingNote, outcome.verdict);
      aggregationMs = Math.round(performance.now() - tA0);
      label = agg.label;
      groundingNote = agg.groundingNote;
      console.log(JSON.stringify({
        fn: "ask", caller, tenant_id: tenantId, path: "correctness",
        verdict: outcome.verdict, invalid_reason: outcome.invalidReason,
        latency_ms: outcome.latencyMs,
      }));
      }
    } catch (e) {
      // Slot-busy (or slot-infra failure inside the wrapper cannot happen —
      // withProviderSlot only throws SlotBusyError): skip the advisory check.
      if (!(e instanceof SlotBusyError)) throw e;
      console.log(JSON.stringify({
        fn: "ask", caller, tenant_id: tenantId, path: "correctness",
        verdict: "skipped", invalid_reason: "slot-busy",
      }));
    }
  }
  if (correctness === null) {
    // Checker never ran: flag OFF on an eligible gate. (INSUFFICIENT returns
    // earlier with no correctness key at all; the refusal shape is frozen.)
    correctness = {
      invoked: false, verdict: null, invalid_reason: null, latency_ms: null,
      attempts: 0, output_chars: null, output_tokens: null,
    };
  }

  const tP0 = performance.now();
  // H2B: the turn's full accounting, built from the measured/estimated
  // sections above plus the generation and (optional) checker calls.
  const telemetry = buildTelemetry({
    router: routerTelemetry,
    context: contextPartFinal,
    ...telemetrySections,
    generation: generationTelemetry({ calls: 1, inputTokens, outputTokens, latencyMs: generationMs }),
    checker: checkerTelemetry({
      calls: correctness.invoked ? correctness.attempts : 0,
      outputTokens: correctness.output_tokens,
      latencyMs: correctness.latency_ms,
    }),
  });
  const persistErr = await persistAssistant(answer, label, sources,
    { answer_model: modelId, prompt: promptVersion, embedding: "jina-embeddings-v5-text-small" },
    {
      retrieval_ms: retrievalMs, generation_ms: generationMs,
      total_ms: Math.round(performance.now() - t0),
      input_tokens: inputTokens, output_tokens: outputTokens,
      query_tokens: retrievalTokens,
      ...(correctnessVerdict !== null
        ? { correctness_verdict: correctnessVerdict, correctness_ms: correctnessMs }
        : {}),
      telemetry,
    }, trip.grounded);
  const persistenceMs = Math.round(performance.now() - tP0);
  console.log(JSON.stringify({
    fn: "ask", caller, tenant_id: tenantId, path: "answer",
    label, verdict: gate.verdict, evidence: retrieved.length,
    grounded: trip.grounded,
    router_class: route.classification, router_bypassed: false, router_ms: routerMs,
  }));
  return json(200, {
    ok: true, answer, label, citations,
    evidence_count: retrieved.length,
    gate: { verdict: gate.verdict, reason: gate.reason, conflicting: gate.conflicting },
    citation_guard: { ok: true, reason: "pass" },
    tripwire: { reason: tripDiag.reason, findings: tripDiag.findings, counts: tripDiag.counts },
    correctness,
    grounded: trip.grounded, grounding_note: groundingNote,
    router: routerInfo(false),
    retrieval: retrievalTrace,
    telemetry,
    timings: {
      retrieval_ms: retrievalMs, generation_ms: generationMs,
      citation_guard_ms: citationGuardMs, tripwire_ms: tripwireMs,
      aggregation_ms: aggregationMs, correctness_ms: correctnessMs,
      persistence_ms: persistenceMs, total_ms: Math.round(performance.now() - t0),
    },
    model: {
      provider: "mantle", model: modelId, prompt_version: promptVersion,
      temperature: 0.0, max_tokens: MAX_TOKENS, correctness_enabled: checkerEnabled,
    },
    conversation_id: convId,
    persisted: persistErr === null,
    ...(persistErr ? { persistence_error: persistErr } : {}),
    ...(notebookId ? { scope: { notebook_id: notebookId, document_count: (combined.ids ?? scopedDocIds ?? []).length } } : {}),
  });
});
