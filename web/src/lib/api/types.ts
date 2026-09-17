/**
 * API contract types.
 *
 * These mirror what the Edge Functions actually return today (verified against
 * `supabase/functions/ask/index.ts` and `query-chunks/index.ts`). They are the
 * *transport* contract: nothing is renamed, nothing is invented, and every
 * field that the backend may omit is optional here.
 *
 * Human-facing presentation is a separate concern — see `lib/api/presentation.ts`.
 */

/* ------------------------------------------------------------------- /ask */

export type GateVerdict =
  | "SUPPORTED"
  | "PARTIAL"
  | "INSUFFICIENT"
  | "CONFLICTING";

/**
 * Labels the backend can emit:
 *  - direct / partial / conflict / insufficient → answer outcomes
 *  - clarification → the deterministic clarification gate fired (no retrieval)
 *  - invalid → citation guard rejected the answer (HTTP 502, not returned as ok)
 *  - provider-error → model unavailable (HTTP 4xx/5xx, not returned as ok)
 */
export type AnswerLabel =
  | "direct"
  | "partial"
  | "conflict"
  | "insufficient"
  | "clarification";

export type GateInfo = {
  verdict: GateVerdict;
  reason: string;
  /** Present on newer responses; internal phrasing, never shown verbatim. */
  conflicting?: string[];
};

export type AskCitation = {
  n: number;
  chunk_id: string;
  document_id: string;
  file_name: string;
  page: number | null;
  fused_rank?: number | null;
  fused_score?: number | null;
};

export type AskTimings = {
  retrieval_ms?: number;
  generation_ms?: number;
  citation_guard_ms?: number;
  tripwire_ms?: number;
  aggregation_ms?: number;
  correctness_ms?: number | null;
  persistence_ms?: number;
  total_ms?: number;
};

export type AskModel = {
  provider: string;
  model: string;
  prompt_version: string;
  temperature: number;
  max_tokens: number;
  correctness_enabled: boolean;
};

export type CorrectnessVerdict = "PASS" | "PARTIAL" | "FAIL" | "INVALID";

export type AskCorrectness = {
  invoked: boolean;
  verdict: CorrectnessVerdict | null;
  invalid_reason: string | null;
  latency_ms: number | null;
  attempts?: number;
  output_chars?: number | null;
  output_tokens?: number | null;
} | null;

export type AskCitationGuard = { ok: boolean; reason: string } | null;

export type AskTripwire = {
  reason: string;
  findings: string[];
  counts: Record<string, number>;
} | null;

/** Successful `/ask` response body (`ok: true`). */
export type AskResponse = {
  ok: true;
  answer: string;
  label: AnswerLabel;
  citations: AskCitation[];
  evidence_count: number;
  /** Absent on the clarification path (no retrieval happened). */
  gate?: GateInfo;
  grounded: boolean | null;
  grounding_note?: string | null;
  /** Present from the observability release onward. */
  citation_guard?: AskCitationGuard;
  tripwire?: AskTripwire;
  correctness?: AskCorrectness;
  timings?: AskTimings;
  model?: AskModel;
  conversation_id: string;
  persisted: boolean;
  persistence_error?: string;
};

/** Clarification responses have no evidence and no gate. */
export function isClarification(res: AskResponse): boolean {
  return res.label === "clarification";
}

/* ---------------------------------------------------------- /query-chunks */

export type EvidenceItem = {
  fused_rank: number;
  fused_score: number;
  chunk_id: string;
  document_id: string;
  file_name: string;
  page: number;
  content: string;
  dense_score: number | null;
  dense_rank: number | null;
  lex_score: number | null;
  lex_rank: number | null;
};

export type QueryChunksResponse = {
  ok: true;
  model: string;
  fusion: string;
  query_tokens: number;
  candidates: { dense: number; lexical: number };
  evidence: EvidenceItem[];
  timings: { embed_ms: number; retrieval_ms: number; total_ms: number };
};

/* ------------------------------------------------------------ PostgREST */

export type MembershipRole = "owner" | "admin" | "member" | "viewer";

export type MembershipRow = {
  tenant_id: string;
  role: MembershipRole;
  /**
   * Embedded relation. PostgREST types it as an array even though the
   * foreign key is many-to-one, so both shapes are accepted here.
   */
  tenants: { name: string } | { name: string }[] | null;
};

/** Display name from the embedded tenant relation, whatever its shape. */
export function tenantName(embedded: MembershipRow["tenants"]): string | null {
  if (!embedded) return null;
  const row = Array.isArray(embedded) ? embedded[0] : embedded;
  return row?.name ?? null;
}

export type ConversationRow = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageSource = {
  n?: number;
  chunk_id?: string;
  document_id?: string;
  file_name?: string;
  page?: number | null;
  fused_rank?: number | null;
  fused_score?: number | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  label: string | null;
  sources: MessageSource[];
  model_ids: Record<string, unknown>;
  timings: Record<string, unknown>;
  created_at: string;
};

export type DocumentRow = {
  id: string;
  file_name: string;
  page_count: number | null;
  /** Object size in bytes, written by ingest-pdf from Storage metadata (B3). */
  file_size: number | null;
  status: "pending" | "ready" | "failed";
  embedding_model: string | null;
  created_at: string;
  updated_at: string;
  storage_path: string;
};

export type IngestJobRow = {
  id: string;
  document_id: string;
  status: "pending" | "processing" | "succeeded" | "failed";
  attempts: number;
  last_error: string | null;
  updated_at: string;
};

/**
 * A temporary file bound to one conversation (D60): an ordinary `documents`
 * row whose `conversation_id` and `expires_at` are both set. The chat surface
 * reads these directly under RLS; the backend decides retrieval.
 */
export type ConversationFileRow = {
  id: string;
  file_name: string;
  page_count: number | null;
  file_size: number | null;
  status: "pending" | "ready" | "failed";
  created_at: string;
  expires_at: string;
  conversation_id: string;
};

/** `ingest-pdf` action responses (union of the three actions). */
export type IngestResponse = {
  ok: boolean;
  error?: string;
  document_id?: string;
  job_id?: string;
  chunks?: number;
  inserted?: number;
  inserted_attempted?: number;
  removed_stale?: number;
  page_count?: number;
  content_hash?: string;
  embedding_pending?: boolean;
  idempotent?: boolean;
  chunks_removed?: number;
  object_removed?: boolean;
};

/* ---------------------------------------------------------------- notebooks */

/**
 * A notebook is a user-facing knowledge set: a named collection of documents
 * (sources) that a question may draw from. A source is one document, even
 * though that document contains many chunks.
 *
 * `notebook_sources.selected` is what the backend uses (B2) to decide the
 * allowed document set. The browser never filters retrieval itself.
 */
export type NotebookRow = {
  id: string;
  tenant_id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** One document's membership in a notebook, with its selection state. */
export type NotebookSourceRow = {
  notebook_id: string;
  tenant_id: string;
  document_id: string;
  selected: boolean;
  added_at: string;
};

/**
 * A source as the UI needs it: the membership joined to the document it points
 * at. `document` is null only when the row survives a document the caller can
 * no longer read (RLS) — the UI then shows an honest unavailable state.
 */
export type NotebookSource = {
  documentId: string;
  selected: boolean;
  addedAt: string;
  document: DocumentRow | null;
};
