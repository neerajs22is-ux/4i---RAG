// usage-telemetry — H2B request-level provider/token accounting.
//
// Pure builders. No I/O, no persistence side effects, no provider calls.
// Every token number carries an explicit basis so a chars/4 proxy can never be
// read as provider-reported usage:
//
//   measured   — reported by the provider or the running system
//   calculated — deterministic consequence of measured/system values
//                (a skipped call consumes exactly zero tokens)
//   estimated  — documented proxy; the only one in use is chars/4
//   unknown    — not available; value is null
//
// Privacy by construction: these structures hold counts, sizes and timings.
// Raw content, prompts, answers, keys and user text can never enter: the only
// place a string is seen is `evidenceTelemetry`, which measures its length and
// keeps no reference to it.
//
// No totals are computed across mixed bases: summing a measured number with an
// estimated one would silently launder the estimate into a measurement.

import type { FollowUpClass } from "./follow-up-detector.ts";

export type TokenBasis = "measured" | "calculated" | "estimated" | "unknown";
export type TokenMetric = { value: number | null; basis: TokenBasis };

/** The documented proxy: ~4 characters per token, rounded up. */
export const CHARS_PER_TOKEN_PROXY = 4;

/**
 * Classify a provider/system-reported token count. A non-positive or missing
 * value is NOT a measurement of zero — providers omit usage, and the Mantle
 * parser coerces missing usage to 0 — so it is classified unknown instead.
 */
export function measuredTokens(value: number | null | undefined): TokenMetric {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? { value, basis: "measured" }
    : { value: null, basis: "unknown" };
}

/** Estimated tokens for a known character count (the only estimate in use). */
export function estimatedTokensFromChars(chars: number | null | undefined): TokenMetric {
  if (typeof chars !== "number" || !Number.isFinite(chars) || chars < 0) {
    return { value: null, basis: "unknown" };
  }
  return { value: Math.ceil(chars / CHARS_PER_TOKEN_PROXY), basis: "estimated" };
}

/** Deterministic zero: the work did not happen, so its cost is known to be 0. */
export function zeroTokens(): TokenMetric {
  return { value: 0, basis: "calculated" };
}

/** Explicitly unavailable. */
export function unknownTokens(): TokenMetric {
  return { value: null, basis: "unknown" };
}

/* ------------------------------------------------------------- sections */

export type RouterTelemetry = {
  classification: string;
  bypassed: boolean;
  latency_ms: number;
};

export type RetrievalTelemetry = {
  rounds: number;
  dense_count: number;
  lexical_count: number;
  fused_count: number;
  final_evidence_count: number;
};

export type EmbeddingTelemetry = {
  calls: number;
  input_chars: number;
  tokens: TokenMetric;
  latency_ms: number;
};

export type RerankTelemetry = {
  attempted: boolean;
  skipped: boolean;
  skip_reason: string | null;
  calls: number;
  input_chars: number;
  tokens: TokenMetric;
  latency_ms: number;
};

export type EvidenceTelemetry = {
  count: number;
  chars: number;
  tokens: TokenMetric;
};

export type GenerationTelemetry = {
  calls: number;
  input_tokens: TokenMetric;
  output_tokens: TokenMetric;
  latency_ms: number;
};

export type CheckerTelemetry = {
  calls: number;
  input_tokens: TokenMetric;
  output_tokens: TokenMetric;
  latency_ms: number;
};

/**
 * H3B bounded-rewrite record. Distinguishes the four outcomes without ever
 * carrying prompt or history text: not required (attempted false), applied,
 * attempted-but-rejected (`fallback` true, `rejected:*` reason), and
 * attempted-but-failed (`fallback` true, `failed:*` reason).
 */
export type RewriteTelemetry = {
  attempted: boolean;
  applied: boolean;
  fallback: boolean;
  reason: string | null;
  input_chars: number;
  output_chars: number;
  latency_ms: number;
  model_id: string | null;
  input_tokens: TokenMetric;
  output_tokens: TokenMetric;
};

/**
 * H3A/H3B/H3C conversation-context diagnostics. `used` means the context
 * layer actually influenced retrieval (a validated rewrite applied, or
 * reconstructed prior evidence was used for generation); the `rewrite` and
 * `reuse` records show whether each mechanism was needed, attempted, and
 * what happened. No conversation text enters this structure.
 */
export type ContextTelemetry = {
  used: boolean;
  classification: FollowUpClass;
  history_turns_read: number;
  previous_message_available: boolean;
  prior_evidence_available: boolean;
  latency_ms: number;
  rewrite: RewriteTelemetry;
  reuse: ReuseTelemetry;
};

export type AskTelemetry = {
  router: RouterTelemetry;
  context: ContextTelemetry;
  retrieval: RetrievalTelemetry;
  embedding: EmbeddingTelemetry;
  rerank: RerankTelemetry;
  evidence: EvidenceTelemetry;
  generation: GenerationTelemetry;
  checker: CheckerTelemetry;
};

/* -------------------------------------------------------------- builders */

export function zeroRetrieval(): RetrievalTelemetry {
  return { rounds: 0, dense_count: 0, lexical_count: 0, fused_count: 0, final_evidence_count: 0 };
}

export function zeroEmbedding(): EmbeddingTelemetry {
  return { calls: 0, input_chars: 0, tokens: zeroTokens(), latency_ms: 0 };
}

export function zeroRerank(skipReason: string | null = null): RerankTelemetry {
  return {
    attempted: false, skipped: skipReason !== null, skip_reason: skipReason,
    calls: 0, input_chars: 0, tokens: zeroTokens(), latency_ms: 0,
  };
}

export function zeroEvidence(): EvidenceTelemetry {
  return { count: 0, chars: 0, tokens: zeroTokens() };
}

export function zeroGeneration(): GenerationTelemetry {
  return { calls: 0, input_tokens: zeroTokens(), output_tokens: zeroTokens(), latency_ms: 0 };
}

export function zeroChecker(): CheckerTelemetry {
  return { calls: 0, input_tokens: zeroTokens(), output_tokens: zeroTokens(), latency_ms: 0 };
}

/** No context layer ran for this turn (e.g. the H1 conversational bypass). */
export function zeroContext(): ContextTelemetry {
  return {
    used: false, classification: "UNKNOWN", history_turns_read: 0,
    previous_message_available: false, prior_evidence_available: false, latency_ms: 0,
    rewrite: zeroRewrite(), reuse: zeroReuse(),
  };
}

/**
 * H3C-B bounded prior-evidence reuse record. `eligible` mirrors the
 * reconstruction predicate; `used` additionally requires a non-INSUFFICIENT
 * gate verdict on the reconstructed evidence; `invalidated` is any attempted
 * reuse that did not reach generation. `gate_verdict` is the verdict the gate
 * returned for the reuse candidate (null when the gate never ran on it).
 */
export type ReuseTelemetry = {
  attempted: boolean;
  eligible: boolean;
  used: boolean;
  reason: string | null;
  chunks_reconstructed: number;
  invalidated: boolean;
  validation_latency_ms: number;
  gate_verdict: string | null;
};

/** No reuse was available or attempted; deterministic zeros throughout. */
export function zeroReuse(): ReuseTelemetry {
  return {
    attempted: false, eligible: false, used: false, reason: null,
    chunks_reconstructed: 0, invalidated: false, validation_latency_ms: 0,
    gate_verdict: null,
  };
}

/** No rewrite was needed or reachable; deterministic zeros throughout. */
export function zeroRewrite(): RewriteTelemetry {
  return {
    attempted: false, applied: false, fallback: false, reason: null,
    input_chars: 0, output_chars: 0, latency_ms: 0, model_id: null,
    input_tokens: zeroTokens(), output_tokens: zeroTokens(),
  };
}

/** Bounded-rewrite record; tokens stay measured/unknown, never fabricated. */
export function rewriteTelemetry(input: {
  attempted: boolean;
  applied: boolean;
  fallback: boolean;
  reason: string | null;
  inputChars: number;
  outputChars: number;
  latencyMs: number;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}): RewriteTelemetry {
  if (!input.attempted) {
    return { ...zeroRewrite(), reason: input.reason };
  }
  return {
    attempted: true,
    applied: input.applied,
    fallback: input.fallback,
    reason: input.reason,
    input_chars: input.inputChars,
    output_chars: input.outputChars,
    latency_ms: input.latencyMs,
    model_id: input.modelId,
    input_tokens: measuredTokens(input.inputTokens),
    output_tokens: measuredTokens(input.outputTokens),
  };
}

/** Context diagnostics from the bounded read + deterministic classification. */
export function contextTelemetry(input: {
  used: boolean;
  classification: FollowUpClass;
  historyTurnsRead: number;
  previousMessageAvailable: boolean;
  priorEvidenceAvailable: boolean;
  latencyMs: number;
  rewrite?: RewriteTelemetry;
  reuse?: ReuseTelemetry;
}): ContextTelemetry {
  return {
    used: input.used,
    classification: input.classification,
    history_turns_read: input.historyTurnsRead,
    previous_message_available: input.previousMessageAvailable,
    prior_evidence_available: input.priorEvidenceAvailable,
    latency_ms: input.latencyMs,
    rewrite: input.rewrite ?? zeroRewrite(),
    reuse: input.reuse ?? zeroReuse(),
  };
}

/**
 * One query-embedding call. `providerTokens` is the provider-reported usage
 * when the response carried it (measured); otherwise the query length gives a
 * clearly labeled estimate.
 */
export function embeddingTelemetry(input: {
  calls: number;
  inputChars: number;
  providerTokens: number | null;
  latencyMs: number;
}): EmbeddingTelemetry {
  if (input.calls <= 0) return zeroEmbedding();
  return {
    calls: input.calls,
    input_chars: input.inputChars,
    tokens: input.providerTokens !== null && input.providerTokens > 0
      ? measuredTokens(input.providerTokens)
      : estimatedTokensFromChars(input.inputChars),
    latency_ms: input.latencyMs,
  };
}

/**
 * The rerank decision plus its cost. A skipped rerank consumed nothing:
 * zero calls, zero input, zero tokens, zero latency — all calculated, never
 * dressed up as a measurement. An attempted rerank reports the provider usage
 * when present, otherwise the pool's chars/4 estimate.
 */
export function rerankTelemetry(input: {
  attempted: boolean;
  skipped: boolean;
  skipReason: string | null;
  inputChars: number;
  providerTokens: number | null;
  latencyMs: number;
}): RerankTelemetry {
  if (!input.attempted) {
    return {
      attempted: false, skipped: input.skipped, skip_reason: input.skipReason,
      calls: 0, input_chars: 0, tokens: zeroTokens(), latency_ms: 0,
    };
  }
  return {
    attempted: true, skipped: false, skip_reason: null,
    calls: 1,
    input_chars: input.inputChars,
    tokens: input.providerTokens !== null && input.providerTokens > 0
      ? measuredTokens(input.providerTokens)
      : estimatedTokensFromChars(input.inputChars),
    latency_ms: input.latencyMs,
  };
}

/** Counts and sizes only: the contents are measured, never retained. */
export function evidenceTelemetry(contents: string[]): EvidenceTelemetry {
  let chars = 0;
  for (const text of contents) {
    if (typeof text === "string") chars += text.length;
  }
  return { count: contents.length, chars, tokens: estimatedTokensFromChars(chars) };
}

/** One generation call (success or failure — the call still happened). */
export function generationTelemetry(input: {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}): GenerationTelemetry {
  if (input.calls <= 0) return zeroGeneration();
  return {
    calls: input.calls,
    input_tokens: measuredTokens(input.inputTokens),
    output_tokens: measuredTokens(input.outputTokens),
    latency_ms: input.latencyMs,
  };
}

/**
 * The optional correctness checker. Calls = transport attempts (the checker's
 * own bounded retry is already limited to 2). Input tokens are unknown: the
 * checker prompt is assembled inside the checker module and is deliberately
 * not surfaced; output tokens are measured when the provider returns usage.
 */
export function checkerTelemetry(input: {
  calls: number;
  outputTokens: number | null;
  latencyMs: number | null;
}): CheckerTelemetry {
  if (input.calls <= 0) return zeroChecker();
  return {
    calls: input.calls,
    input_tokens: unknownTokens(),
    output_tokens: measuredTokens(input.outputTokens),
    latency_ms: input.latencyMs ?? 0,
  };
}

/** Assemble the per-turn object; omitted sections are deterministic zero. */
export function buildTelemetry(parts: {
  router: RouterTelemetry;
  context?: ContextTelemetry;
  retrieval?: Partial<RetrievalTelemetry>;
  embedding?: EmbeddingTelemetry;
  rerank?: RerankTelemetry;
  evidence?: EvidenceTelemetry;
  generation?: GenerationTelemetry;
  checker?: CheckerTelemetry;
}): AskTelemetry {
  return {
    router: parts.router,
    context: parts.context ?? zeroContext(),
    retrieval: { ...zeroRetrieval(), ...(parts.retrieval ?? {}) },
    embedding: parts.embedding ?? zeroEmbedding(),
    rerank: parts.rerank ?? zeroRerank(),
    evidence: parts.evidence ?? zeroEvidence(),
    generation: parts.generation ?? zeroGeneration(),
    checker: parts.checker ?? zeroChecker(),
  };
}
