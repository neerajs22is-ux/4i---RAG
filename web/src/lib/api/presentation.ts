import type {
  AnswerLabel,
  AskCitation,
  AskResponse,
  GateVerdict,
  MessageSource,
} from "@/lib/api/types";

/**
 * Presentation model.
 *
 * Translates backend vocabulary into what a reader sees. The transport types in
 * `types.ts` are untouched: this is the only place that decides wording, and it
 * is deliberately the inverse of what the UI already exposes through the
 * evidence-status component.
 *
 * No internal diagnostics are surfaced here — `gate.reason`, `tripwire.reason`,
 * `correctness.invalid_reason` and provider names are for diagnostics only.
 */

export type EvidenceState =
  | "supported"
  | "partial"
  | "conflicting"
  | "insufficient";

/** A response outcome the reader can be shown. */
export type AnswerOutcome =
  | { kind: "answered"; state: EvidenceState }
  | { kind: "clarification" }
  | { kind: "conversational" }
  | { kind: "refused" };

const STATE_FOR_GATE: Record<GateVerdict, EvidenceState> = {
  SUPPORTED: "supported",
  PARTIAL: "partial",
  CONFLICTING: "conflicting",
  INSUFFICIENT: "insufficient",
};

const STATE_FOR_LABEL: Record<AnswerLabel, EvidenceState | null> = {
  direct: "supported",
  partial: "partial",
  conflict: "conflicting",
  insufficient: "insufficient",
  clarification: null,
  conversational: null,
};

export function outcomeFor(response: AskResponse): AnswerOutcome {
  if (response.label === "clarification") return { kind: "clarification" };
  if (response.label === "conversational") return { kind: "conversational" };
  if (response.label === "insufficient") return { kind: "refused" };
  const fromGate = response.gate ? STATE_FOR_GATE[response.gate.verdict] : null;
  return { kind: "answered", state: fromGate ?? STATE_FOR_LABEL[response.label] ?? "partial" };
}

/**
 * Whether the pipeline itself expressed doubt about the answer's grounding.
 * Shown as a caution, never as a score.
 */
export function hasGroundingCaution(response: AskResponse): boolean {
  return response.grounded === false;
}

/** Retrieved vs cited, which are genuinely different numbers. */
export function sourceSummary(response: AskResponse): {
  retrieved: number;
  cited: number;
} {
  return {
    retrieved: response.evidence_count,
    cited: response.citations.length,
  };
}

/**
 * "How this answer was made" — built from the real timings the backend
 * returns. This is execution provenance, not model reasoning: the backend
 * strips reasoning blocks before responding, so none is available and none is
 * ever implied.
 */
export type ProvenanceStep = { label: string; ms: number | null };

export function provenanceSteps(response: AskResponse): ProvenanceStep[] {
  const t = response.timings;
  if (!t) return [];
  const steps: ProvenanceStep[] = [
    { label: "Found evidence", ms: t.retrieval_ms ?? null },
    { label: "Wrote the answer", ms: t.generation_ms ?? null },
    { label: "Checked citations", ms: t.citation_guard_ms ?? null },
    { label: "Checked grounding", ms: t.tripwire_ms ?? null },
  ];
  if (response.correctness?.invoked) {
    steps.push({
      label: "Independent answer check",
      ms: response.correctness.latency_ms ?? null,
    });
  }
  return steps.filter((s) => s.ms !== null);
}

/** Model and prompt identification, for the provenance disclosure. */
export function provenanceModel(response: AskResponse): {
  model: string | null;
  promptVersion: string | null;
} {
  return {
    model: response.model?.model ?? null,
    promptVersion: response.model?.prompt_version ?? null,
  };
}

/* ------------------------------------------------- stored transcript views */

/** Evidence state from a persisted message label (no gate verdict stored). */
export function stateForLabel(label: string | null): EvidenceState | null {
  if (!label) return null;
  return STATE_FOR_LABEL[label as AnswerLabel] ?? null;
}

/**
 * Persisted messages store citation metadata in `sources`; the live response
 * uses the same fields under `citations`. One shape for the UI. The excerpt,
 * when present, passes through untouched; rows written before excerpts
 * existed surface a null excerpt and render without one.
 */
export function citationsFromSources(sources: MessageSource[]): AskCitation[] {
  return (sources ?? [])
    .filter((s) => typeof s.n === "number" && Boolean(s.chunk_id))
    .map((s) => ({
      n: s.n as number,
      chunk_id: s.chunk_id as string,
      document_id: s.document_id ?? "",
      file_name: s.file_name ?? "Source",
      page: s.page ?? null,
      fused_rank: s.fused_rank ?? null,
      fused_score: s.fused_score ?? null,
      excerpt: typeof s.excerpt === "string" ? s.excerpt : null,
    }));
}

const RAW_STEP_LABELS: Array<[string, string]> = [
  ["retrieval_ms", "Found evidence"],
  ["generation_ms", "Wrote the answer"],
  ["citation_guard_ms", "Checked citations"],
  ["tripwire_ms", "Checked grounding"],
  ["correctness_ms", "Independent answer check"],
];

/** Provenance steps from a persisted `timings` object. */
export function provenanceFromTimings(
  timings: Record<string, unknown> | null,
): ProvenanceStep[] {
  if (!timings) return [];
  const steps: ProvenanceStep[] = [];
  for (const [key, label] of RAW_STEP_LABELS) {
    const value = timings[key];
    if (typeof value === "number") steps.push({ label, ms: value });
  }
  return steps;
}

/** Grounding flag persisted alongside the answer. */
export function groundedFromTimings(
  timings: Record<string, unknown> | null,
): boolean | null {
  const value = timings?.grounded;
  return typeof value === "boolean" ? value : null;
}
