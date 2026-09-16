// correctness.ts — bounded semantic Answer Correctness Checker (Phase 3C.13).
//
// Standalone evaluator, NOT an agent: fixed input -> fixed prompt ->
// structured JSON -> deterministic aggregation by the caller. No tools, no
// web, no retrieval, no memory, no loops, no regeneration, no control-flow
// authority. Pure functions only: no I/O, no network, no credentials.
// Temp 0.0, bounded output. No numeric score by design.
//
// Transport compatibility: Mantle Chat Completions envelope reuse only
// (parseMantleResponse from ./grounding.ts). No fetch here, no provider
// URLs, no second provider, no LM Studio references anywhere.

import { parseMantleResponse } from "./grounding.ts";

export const CORRECTNESS_PROMPT_VERSION = "correctness-v1";
export const CORRECTNESS_CHECKER_NAME = "answer-correctness";
export const CORRECTNESS_TEMPERATURE = 0.0;

export type GateVerdictIn = "SUPPORTED" | "PARTIAL" | "CONFLICTING";

export type CorrectnessEvidence = {
  n: number;
  page: number | null;
  text: string;
};

export type CorrectnessCitation = {
  n: number;
  chunk_ref: string;
};

export type CorrectnessInput = {
  question: string;
  answer: string;
  evidence: CorrectnessEvidence[];
  gate_verdict: GateVerdictIn;
  citations: CorrectnessCitation[];
};

export type ClaimJudgment = "supported" | "unsupported" | "contradicted";
export type CorrectnessVerdict = "PASS" | "PARTIAL" | "FAIL" | "INVALID";

export type ClaimFinding = {
  claim_id: string;
  claim_text: string;
  judgment: ClaimJudgment;
  evidence_refs: number[];
  issue: string | null;
};

export type CorrectnessResult = {
  checker: "answer-correctness";
  verdict: CorrectnessVerdict;
  claims: ClaimFinding[];
  feedback: string;
  invalid_result: boolean;
  invalid_reason: string | null;
};

export type CorrectnessParse =
  | { ok: true; result: CorrectnessResult }
  | { ok: false; error: string };

const CORRECTNESS_PROMPT = `You are a bounded semantic judge for retrieval-augmented answers. Use ONLY the supplied evidence; never use outside knowledge.

Question:
{question}

Generated answer:
{answer}

Evidence blocks:
{evidence}

The evidence gate classified this case as: {gate}. That classification stands; you do not override it, and a refusal case never reaches you.

Task:
1. Identify the substantive atomic claims in the answer. Ignore pure framing language and citation markers like [S1]. Preserve meaningful qualification and hedging as part of each claim. Split sentences that contain multiple claims.
2. For each claim, judge exactly one of: supported (the evidence entails it, including legitimate paraphrase, with numbers, dates, and negations preserved exactly), unsupported (the evidence does not establish it), contradicted (the evidence establishes the opposite). An extra claim the question did not ask for is judged like any other claim.
3. Judge the whole answer: PASS (every substantive claim supported and the question addressed), PARTIAL (core answer supported but some substantive content missing, overstated, or unsupported), FAIL (materially fails the question or contradicts the evidence).

Rules: no outside knowledge - a fact is not supported merely because it is generally known; no reference answers assumed; do not rule on citation validity, access control, or HTTP status; do not regenerate the answer.

Return JSON ONLY, exactly this shape and no other fields:
{"checker":"answer-correctness","verdict":"PASS|PARTIAL|FAIL|INVALID","claims":[{"claim_id":"c1","claim_text":"...","judgment":"supported|unsupported|contradicted","evidence_refs":[1],"issue":"...|null"}],"feedback":"...","invalid_result":false,"invalid_reason":null}
Set verdict INVALID with claims [] and a non-null invalid_reason only when evaluation is impossible. No numeric score.`;

export function renderCorrectnessPrompt(input: CorrectnessInput): { template: string; version: string } {
  const block = (input.evidence ?? [])
    .map((e) => `[S${e.n}]${e.page != null ? ` (p. ${e.page})` : ""}\n${e.text}`)
    .join("\n\n---\n\n");
  const template = CORRECTNESS_PROMPT
    .replace("{question}", String(input.question ?? ""))
    .replace("{answer}", String(input.answer ?? ""))
    .replace("{evidence}", block)
    .replace("{gate}", String(input.gate_verdict ?? ""));
  return { template, version: `${CORRECTNESS_PROMPT_VERSION}-judge` };
}

export function buildCorrectnessBody(model: string, input: CorrectnessInput): Record<string, unknown> {
  const { template } = renderCorrectnessPrompt(input);
  // No application-level max_tokens: the provider/model applies its own
  // supported maximum (Step 3C.22 — the 1024 ceiling truncated valid
  // structured judgments). All other bounds (timeout, single retry,
  // validator, flag) are unchanged.
  return {
    model,
    messages: [{ role: "user", content: template }],
    temperature: CORRECTNESS_TEMPERATURE,
  };
}

const VERDICTS: CorrectnessVerdict[] = ["PASS", "PARTIAL", "FAIL", "INVALID"];
const JUDGMENTS: ClaimJudgment[] = ["supported", "unsupported", "contradicted"];
const CLAIM_ID_RE = /^c\d+$/;
const TOP_FIELDS = ["checker", "verdict", "claims", "feedback", "invalid_result", "invalid_reason"];
const CLAIM_FIELDS = ["claim_id", "claim_text", "judgment", "evidence_refs", "issue"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownFields(obj: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

/** Strict validator. Never repairs: any deviation is INVALID (ok:false). */
export function parseCorrectnessResponse(raw: unknown, evidenceNs?: number[]): CorrectnessParse {
  if (!isRecord(raw)) return { ok: false, error: "top-level JSON object required" };
  const extra = unknownFields(raw, TOP_FIELDS);
  if (extra.length) return { ok: false, error: `unknown top-level fields: ${extra.join(",")}` };
  if (raw["checker"] !== CORRECTNESS_CHECKER_NAME) {
    return { ok: false, error: "checker must be answer-correctness" };
  }
  const verdict = raw["verdict"];
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict as CorrectnessVerdict)) {
    return { ok: false, error: "verdict must be PASS|PARTIAL|FAIL|INVALID" };
  }
  if (typeof raw["invalid_result"] !== "boolean") {
    return { ok: false, error: "invalid_result must be boolean" };
  }
  const invalid = raw["invalid_result"] as boolean;
  if (invalid !== (verdict === "INVALID")) {
    return { ok: false, error: "invalid_result must be true exactly when verdict is INVALID" };
  }
  if (invalid) {
    if (typeof raw["invalid_reason"] !== "string" || !(raw["invalid_reason"] as string).trim()) {
      return { ok: false, error: "invalid_reason must be a non-empty string when INVALID" };
    }
  } else if (raw["invalid_reason"] !== null) {
    return { ok: false, error: "invalid_reason must be null unless INVALID" };
  }
  if (!Array.isArray(raw["claims"])) return { ok: false, error: "claims must be an array" };
  const claims = raw["claims"] as unknown[];
  if (invalid && claims.length !== 0) {
    return { ok: false, error: "INVALID must carry zero claims" };
  }
  if (!invalid && claims.length === 0) {
    return { ok: false, error: "judged verdicts require at least one claim" };
  }
  const seen = new Set<string>();
  const allowedNs = evidenceNs ? new Set(evidenceNs) : null;
  for (const c of claims) {
    if (!isRecord(c)) return { ok: false, error: "claim must be an object" };
    const cextra = unknownFields(c, CLAIM_FIELDS);
    if (cextra.length) return { ok: false, error: `unknown claim fields: ${cextra.join(",")}` };
    if (typeof c["claim_id"] !== "string" || !CLAIM_ID_RE.test(c["claim_id"] as string)) {
      return { ok: false, error: "claim_id must match c<number>" };
    }
    if (seen.has(c["claim_id"] as string)) return { ok: false, error: "duplicate claim_id" };
    seen.add(c["claim_id"] as string);
    if (typeof c["claim_text"] !== "string" || !(c["claim_text"] as string).trim()) {
      return { ok: false, error: "claim_text must be a non-empty string" };
    }
    if (typeof c["judgment"] !== "string" || !JUDGMENTS.includes(c["judgment"] as ClaimJudgment)) {
      return { ok: false, error: "judgment must be supported|unsupported|contradicted" };
    }
    if (!Array.isArray(c["evidence_refs"]) || (c["evidence_refs"] as unknown[]).length === 0) {
      return { ok: false, error: "evidence_refs must be a non-empty array" };
    }
    const refs = c["evidence_refs"] as unknown[];
    for (const r of refs) {
      if (typeof r !== "number" || !Number.isInteger(r) || (r as number) < 1) {
        return { ok: false, error: "evidence_refs must be positive integers" };
      }
    }
    if (new Set(refs).size !== refs.length) {
      return { ok: false, error: "duplicate evidence_refs" };
    }
    if (allowedNs && !(refs as number[]).every((r) => allowedNs.has(r))) {
      return { ok: false, error: "evidence_refs must reference supplied evidence" };
    }
    if (c["issue"] !== null && typeof c["issue"] !== "string") {
      return { ok: false, error: "issue must be string|null" };
    }
  }
  if (typeof raw["feedback"] !== "string" || !(raw["feedback"] as string).trim()) {
    return { ok: false, error: "feedback must be a non-empty string" };
  }
  return { ok: true, result: raw as unknown as CorrectnessResult };
}

/** Model-envelope (Mantle Chat Completions) -> text -> strict validation. */
export function parseCorrectnessModelResponse(modelJson: unknown, evidenceNs?: number[]): CorrectnessParse {
  const parsed = parseMantleResponse(modelJson);
  if (!parsed.ok) return { ok: false, error: `model envelope: ${parsed.error}` };
  let raw: unknown;
  try {
    raw = JSON.parse(parsed.text);
  } catch {
    return { ok: false, error: "model output is not JSON" };
  }
  return parseCorrectnessResponse(raw, evidenceNs);
}

// ---------------------------------------------------------------------------
// Step 3C.15 integration helpers (pure; ask/index.ts only wires them).
// The deterministic aggregator below is the SOLE consumer of checker
// verdicts. It can only preserve labels or downgrade direct->partial with
// a static note: no upgrades, no refusals, no regeneration, no status or
// citation changes. All invalidReason strings produced here are static
// metadata (never answer/evidence content) and safe to log.
// ---------------------------------------------------------------------------

export const CORRECTNESS_NOTE =
  "An independent answer check flagged possible issues; verify important claims against the cited sources.";

export const CORRECTNESS_TIMEOUT_MS = 30000;
const CORRECTNESS_MAX_ATTEMPTS = 2; // 1 initial + 1 retry on transport/5xx/timeout only.

/** Flag-gated invocation predicate. INSUFFICIENT never runs the checker. */
export function shouldRunChecker(flagEnabled: boolean, gateVerdict: string): boolean {
  if (!flagEnabled) return false;
  return gateVerdict === "SUPPORTED" || gateVerdict === "PARTIAL" || gateVerdict === "CONFLICTING";
}

/** Deterministic advisory aggregation. Downgrade-only. */
export function aggregateCorrectness(
  label: string,
  groundingNote: string | null,
  verdict: CorrectnessVerdict | null,
): { label: string; groundingNote: string | null } {
  if (verdict === null || verdict === "PASS" || verdict === "INVALID") {
    return { label, groundingNote };
  }
  const note = groundingNote ? `${groundingNote} ${CORRECTNESS_NOTE}` : CORRECTNESS_NOTE;
  if (label === "direct") return { label: "partial", groundingNote: note };
  return { label, groundingNote: note };
}

/** Same rule as ask/index.ts stripThink: drop <think> blocks before parsing. */
export function stripCheckerThink(text: string): string {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export type CheckOutcome =
  | {
    invoked: true;
    verdict: CorrectnessVerdict;
    invalidReason: string | null;
    latencyMs: number;
    attempts: number;
    outputChars: number | null;
    outputTokens: number | null;
  }
  | { invoked: false };

/**
 * Bounded checker invocation. fetchFn is injected (unit-testable; production
 * passes global fetch). One retry on transport/5xx/timeout only; never on a
 * semantic verdict or malformed output. Never throws with content.
 *
 * Observability (Step 3C.19): attempts/outputChars/outputTokens describe the
 * transport only and never alter the verdict path. outputTokens is null when
 * the provider omits usage; outputChars is null when no model text arrived.
 */
export async function evaluateAnswer(opts: {
  fetchFn: typeof fetch;
  url: string;
  mantleKey: string;
  model: string;
  input: CorrectnessInput;
  timeoutMs?: number;
}): Promise<CheckOutcome> {
  const timeoutMs = opts.timeoutMs ?? CORRECTNESS_TIMEOUT_MS;
  const body = buildCorrectnessBody(opts.model, opts.input);
  const evidenceNs = (opts.input.evidence ?? []).map((e) => e.n);
  const t0 = Date.now();
  let attempts = 0;
  const fail = (
    invalidReason: string,
    outputChars: number | null = null,
    outputTokens: number | null = null,
  ): CheckOutcome => ({
    invoked: true,
    verdict: "INVALID",
    invalidReason,
    latencyMs: Date.now() - t0,
    attempts,
    outputChars,
    outputTokens,
  });
  for (;;) {
    attempts++;
    let res: Response;
    try {
      res = await opts.fetchFn(opts.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.mantleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempts < CORRECTNESS_MAX_ATTEMPTS) continue;
      const timeout = e instanceof DOMException && e.name === "TimeoutError";
      return fail(timeout ? "timeout" : "transport");
    }
    if (!res.ok) {
      if (res.status >= 500 && attempts < CORRECTNESS_MAX_ATTEMPTS) continue;
      return fail(`provider-http-${res.status}`);
    }
    let modelJson: unknown;
    try {
      modelJson = await res.json();
    } catch {
      return fail("invalid-envelope");
    }
    const env = parseMantleResponse(modelJson);
    if (!env.ok) return fail("invalid-envelope");
    const outputChars = env.text.length;
    const outputTokens = env.outputTokens > 0 ? env.outputTokens : null;
    let raw: unknown;
    try {
      raw = JSON.parse(stripCheckerThink(env.text));
    } catch {
      return fail("invalid-json", outputChars, outputTokens);
    }
    const v = parseCorrectnessResponse(raw, evidenceNs);
    if (!v.ok) return fail("invalid-schema", outputChars, outputTokens);
    if (v.result.verdict === "INVALID") return fail("checker-invalid", outputChars, outputTokens);
    return {
      invoked: true,
      verdict: v.result.verdict,
      invalidReason: null,
      latencyMs: Date.now() - t0,
      attempts,
      outputChars,
      outputTokens,
    };
  }
}
