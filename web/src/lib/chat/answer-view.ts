import type { EvidenceState } from "@/lib/api/presentation";
import {
  citationsFromSources,
  groundedFromTimings,
  outcomeFor,
  provenanceFromTimings,
  provenanceSteps,
  stateForLabel,
  type ProvenanceStep,
} from "@/lib/api/presentation";
import type { AskCitation, AskResponse, MessageRow } from "@/lib/api/types";

/**
 * One shape for rendering an answer, whether it just arrived from `/ask` or was
 * loaded from the stored transcript.
 *
 * The live response carries a gate verdict, the exact timings and the model id;
 * the stored message carries a label, the `timings` blob it was persisted with
 * and the source list. Both are normalised here so the message component never
 * has to care which it received — and neither path invents a field.
 */
export type AnswerView = {
  answer: string;
  /** Raw backend label; used only for branching, never displayed. */
  label: string | null;
  /** Human-facing grounding state, or null when the case has none. */
  state: EvidenceState | null;
  citations: AskCitation[];
  grounded: boolean | null;
  groundingNote: string | null;
  steps: ProvenanceStep[];
  model: string | null;
  promptVersion: string | null;
  /** Retrieved vs cited — the two numbers the backend actually reports. */
  retrieved: number | null;
};

export function viewFromResponse(response: AskResponse): AnswerView {
  return {
    answer: response.answer,
    label: response.label,
    state: outcomeFor(response).kind === "answered"
      ? (outcomeFor(response) as { kind: "answered"; state: EvidenceState }).state
      : null,
    citations: response.citations ?? [],
    grounded: response.grounded,
    groundingNote: response.grounding_note ?? null,
    steps: provenanceSteps(response),
    model: response.model?.model ?? null,
    promptVersion: response.model?.prompt_version ?? null,
    retrieved: response.evidence_count ?? null,
  };
}

export function viewFromStored(row: MessageRow): AnswerView {
  const citations = citationsFromSources(row.sources ?? []);
  const timings = (row.timings ?? {}) as Record<string, unknown>;
  const modelIds = (row.model_ids ?? {}) as Record<string, unknown>;
  return {
    answer: row.content,
    label: row.label,
    state: stateForLabel(row.label),
    citations,
    grounded: groundedFromTimings(timings),
    groundingNote: null,
    steps: provenanceFromTimings(timings),
    model: typeof modelIds.answer_model === "string" ? modelIds.answer_model : null,
    promptVersion: typeof modelIds.prompt === "string" ? modelIds.prompt : null,
    retrieved:
      typeof timings.evidence_count === "number"
        ? (timings.evidence_count as number)
        : null,
  };
}
