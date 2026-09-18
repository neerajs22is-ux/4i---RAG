// benchmark-answer.ts — benchmark-only answer/evaluation pipeline.
//
// Benchmark-only. This module reuses the EXACT shared answer semantics as
// production /ask (gate, prompts, generation contract, citation guard,
// tripwire, correctness aggregation) over caller-supplied evidence, without
// any of the production side effects: no retrieval, no conversation creation,
// no message persistence, no document/chunk writes, no Voyage calls.
//
// Every answer-semantics import comes from the shared grounding/correctness
// modules that /ask itself uses. Nothing is reinterpreted here; only the
// evidence source (benchmark retrieval) and the persistence step differ.

import {
  aggregateCorrectness,
  evaluateAnswer,
  shouldRunChecker,
  type CorrectnessVerdict,
  type GateVerdictIn,
} from "./correctness.ts";
import {
  buildEvidenceBlock,
  checkGroundedness,
  clarificationTrigger,
  mapMantleFailure,
  parseCitations,
  parseMantleResponse,
  promptModeFor,
  REFUSAL_TEXT,
  renderPrompt,
  tripwireDiagnostics,
  validateCitations,
  verifyEvidence,
  type EvidenceItem,
} from "./grounding.ts";

export type BenchmarkAnswerEvidence = {
  chunk_id: string;
  document_id: string;
  tenant_id: string;
  file_name: string;
  page: number | null;
  content: string;
  fused_rank?: number | null;
  fused_score?: number | null;
  dense_score?: number | null;
  dense_rank?: number | null;
  lex_score?: number | null;
  lex_rank?: number | null;
  rerank_score?: number | null;
};

export type BenchmarkAnswerMantle = {
  baseUrl: string;
  chatPath: string;
  modelId: string;
  key: string;
  maxTokens: number;
};

function stripThink(text: string): string {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type BenchmarkAnswerResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 429 | 502; body: { ok: false; error: string; errors?: string[] } };

/**
 * Run the production answer semantics over benchmark-supplied evidence.
 *
 * Mirrors /ask from the clarification gate onward: clarification, gate,
 * refusal, generation, citation guard, tripwire, correctness, response
 * shapes. The deliberate differences are: no persistence (no conversations or
 * messages rows are created), no retrieval, and no conversation_id.
 */
export async function runBenchmarkAnswer(input: {
  tenantId: string;
  query: string;
  evidence: BenchmarkAnswerEvidence[];
  priorCount: number;
  docCount: number;
  retrievalMs: number | null;
  mantle: BenchmarkAnswerMantle;
  checkerEnabled: boolean;
  fetchFn?: typeof fetch;
}): Promise<BenchmarkAnswerResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const t0 = performance.now();

  if (!isNonEmptyString(input.query) || input.query.length > 1000) {
    return { status: 502, body: { ok: false, error: "invalid benchmark question" } };
  }
  if (!Array.isArray(input.evidence)) {
    return { status: 502, body: { ok: false, error: "invalid benchmark evidence" } };
  }
  for (const item of input.evidence) {
    if (
      typeof item !== "object" || item === null ||
      !isNonEmptyString((item as BenchmarkAnswerEvidence).chunk_id) ||
      !isNonEmptyString((item as BenchmarkAnswerEvidence).content) ||
      (item as BenchmarkAnswerEvidence).tenant_id !== input.tenantId
    ) {
      return { status: 502, body: { ok: false, error: "benchmark evidence failed tenant/provenance validation" } };
    }
  }
  const retrieved = input.evidence as EvidenceItem[];

  // 1. Bounded deterministic clarification gate (no LLM, no loops).
  const clar = clarificationTrigger(input.query, input.priorCount, input.docCount);
  if (clar.needed) {
    return {
      status: 200,
      body: {
        ok: true, answer: clar.question, label: "clarification",
        citations: [], evidence_count: 0, grounded: null,
        persisted: false,
      },
    };
  }

  // 2. Deterministic sufficiency gate (model-free).
  const gate = verifyEvidence(input.query, retrieved);
  const mode = promptModeFor(gate.verdict);
  const sources = retrieved.map((e, i) => ({
    n: i + 1, chunk_id: e.chunk_id, document_id: e.document_id,
    file_name: e.file_name, page: e.page,
    fused_rank: e.fused_rank, fused_score: e.fused_score,
  }));

  // 3. INSUFFICIENT (incl. empty): refusal without any model call.
  if (mode === "refuse") {
    return {
      status: 200,
      body: {
        ok: true, answer: REFUSAL_TEXT, label: "insufficient",
        citations: [], evidence_count: retrieved.length,
        gate: { verdict: gate.verdict, reason: gate.reason },
        grounded: null,
        persisted: false,
      },
    };
  }

  // 4. Grounded generation (same contract as production).
  const { template, version: promptVersion } = renderPrompt(mode, input.query, buildEvidenceBlock(retrieved).block);
  const tG0 = performance.now();
  let rawAnswer: string;
  // Parsed token counts are validated through the shared response parser;
  // production records them only in persistence timings, which the benchmark
  // path deliberately omits (no persistence).
  let _inputTokens = 0;
  let _outputTokens = 0;
  try {
    const r = await fetchFn(`${input.mantle.baseUrl}${input.mantle.chatPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.mantle.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.mantle.modelId,
        messages: [{ role: "user", content: template }],
        temperature: 0.0,
        max_tokens: input.mantle.maxTokens,
      }),
    });
    if (!r.ok) {
      const mapped = mapMantleFailure(r.status, await r.text());
      if (mapped.kind === "throttled") {
        return { status: 429, body: { ok: false, error: mapped.message } };
      }
      return { status: 502, body: { ok: false, error: mapped.message } };
    }
    const parsed = parseMantleResponse(await r.json());
    if (!parsed.ok) {
      return { status: 502, body: { ok: false, error: parsed.error } };
    }
    rawAnswer = parsed.text;
    _inputTokens = parsed.inputTokens;
    _outputTokens = parsed.outputTokens;
  } catch (e) {
    void e;
    return {
      status: 502,
      body: { ok: false, error: `answer generation failed (model ${input.mantle.modelId}). Check model access and configuration, then retry.` },
    };
  }
  const generationMs = Math.round(performance.now() - tG0);
  const answer = stripThink(rawAnswer);
  if (!answer) {
    return { status: 502, body: { ok: false, error: "model returned an empty response" } };
  }

  // 5. Deterministic citation guard (hard failure, never silent).
  const tC0 = performance.now();
  const guard = validateCitations(answer, retrieved, input.tenantId);
  const citationGuardMs = Math.round(performance.now() - tC0);
  if (!guard.ok) {
    return {
      status: 502,
      body: {
        ok: false, error: "answer failed citation validation",
        errors: guard.errors,
      },
    };
  }

  // 6. Groundedness tripwire (downgrade + note; no regeneration).
  const tT0 = performance.now();
  const trip = checkGroundedness(answer, retrieved.map((e) => e.content));
  const tripDiag = tripwireDiagnostics(trip);
  const tripwireMs = Math.round(performance.now() - tT0);
  let label = mode === "direct" ? (trip.grounded ? "direct" : "partial") : mode;
  let groundingNote: string | null = trip.grounded ? null :
    "Some claims could not be fully verified against the retrieved evidence; treat numbers and qualifiers with care.";
  const citedIds = [...new Set(parseCitations(answer))];
  const citations = citedIds.map((n) => sources[n - 1]).filter(Boolean);

  // 7. Bounded answer-correctness check (flag-gated, advisory).
  const checkerEnabled = input.checkerEnabled;
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
    const outcome = await evaluateAnswer({
      fetchFn,
      url: `${input.mantle.baseUrl}${input.mantle.chatPath}`,
      mantleKey: input.mantle.key,
      model: input.mantle.modelId,
      input: {
        question: input.query,
        answer,
        evidence: retrieved.map((e, i) => ({ n: i + 1, page: e.page, text: e.content })),
        gate_verdict: gate.verdict as GateVerdictIn,
        citations: citedIds.map((n) => ({ n, chunk_ref: sources[n - 1]?.chunk_id ?? `S${n}` })),
      },
    });
    if (outcome.invoked) {
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
    }
  }
  if (correctness === null) {
    correctness = {
      invoked: false, verdict: null, invalid_reason: null, latency_ms: null,
      attempts: 0, output_chars: null, output_tokens: null,
    };
  }

  return {
    status: 200,
    body: {
      ok: true, answer, label, citations,
      evidence_count: retrieved.length,
      gate: { verdict: gate.verdict, reason: gate.reason, conflicting: gate.conflicting },
      citation_guard: { ok: true, reason: "pass" },
      tripwire: { reason: tripDiag.reason, findings: tripDiag.findings, counts: tripDiag.counts },
      correctness,
      grounded: trip.grounded, grounding_note: groundingNote,
      timings: {
        retrieval_ms: input.retrievalMs, generation_ms: generationMs,
        citation_guard_ms: citationGuardMs, tripwire_ms: tripwireMs,
        aggregation_ms: aggregationMs, correctness_ms: correctnessMs,
        persistence_ms: 0, total_ms: Math.round(performance.now() - t0),
      },
      model: {
        provider: "mantle", model: input.mantle.modelId, prompt_version: promptVersion,
        temperature: 0.0, max_tokens: input.mantle.maxTokens, correctness_enabled: checkerEnabled,
      },
      persisted: false,
      ...(correctnessVerdict !== null ? { correctness_verdict: correctnessVerdict } : {}),
    },
  };
}
