import { callFunction } from "@/lib/api/client";
import { normalizePostgrestError } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  ConversationFileRow,
  DocumentRow,
  IngestJobRow,
  IngestResponse,
} from "@/lib/api/types";

/**
 * Document reads and ingestion actions.
 *
 * Reads go to PostgREST under RLS. Ingestion actions call the existing
 * `ingest-pdf` Edge Function — the frontend never parses or embeds anything
 * itself, and there is no fake progress anywhere: `status`, `attempts`,
 * `last_error` and the pending-chunk count are the real values the backend
 * already maintains.
 *
 * Temporary conversation files (D60) are `documents` rows too. The workspace
 * list below is **persistent documents only** — temporary files are read by
 * conversation (`listConversationFiles`) and shown in the conversation they
 * belong to, never as workspace documents.
 *
 * Upload lives in `lib/api/upload.ts` (Storage insert with real XHR progress);
 * this module registers the uploaded object and exposes the ingestion actions.
 */

export async function listDocuments(tenantId: string): Promise<DocumentRow[]> {
  const { data, error } = await getSupabaseClient()
    .from("documents")
    .select("id, file_name, page_count, status, embedding_model, created_at, updated_at, storage_path, file_size")
    .eq("tenant_id", tenantId)
    .is("expires_at", null)
    .order("created_at", { ascending: false });

  const normalized = normalizePostgrestError(error, "documents");
  if (normalized) throw normalized;
  return (data ?? []) as DocumentRow[];
}

/** Temporary files of one conversation (D60), oldest first. */
export async function listConversationFiles(
  conversationId: string,
): Promise<ConversationFileRow[]> {
  const { data, error } = await getSupabaseClient()
    .from("documents")
    .select("id, file_name, page_count, file_size, status, created_at, expires_at, conversation_id")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const normalized = normalizePostgrestError(error, "documents");
  if (normalized) throw normalized;
  return (data ?? []) as ConversationFileRow[];
}

/** Latest ingestion job per document (for retry + failure reasons). */
export async function listIngestJobs(tenantId: string): Promise<IngestJobRow[]> {
  const { data, error } = await getSupabaseClient()
    .from("ingest_jobs")
    .select("id, document_id, status, attempts, last_error, updated_at")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(200);

  const normalized = normalizePostgrestError(error, "ingest_jobs");
  if (normalized) throw normalized;
  return (data ?? []) as IngestJobRow[];
}

/** Latest jobs for a known set of documents (conversation-file status). */
export async function listIngestJobsForDocuments(
  documentIds: string[],
): Promise<IngestJobRow[]> {
  if (documentIds.length === 0) return [];
  const { data, error } = await getSupabaseClient()
    .from("ingest_jobs")
    .select("id, document_id, status, attempts, last_error, updated_at")
    .in("document_id", documentIds)
    .order("updated_at", { ascending: false });

  const normalized = normalizePostgrestError(error, "ingest_jobs");
  if (normalized) throw normalized;
  return (data ?? []) as IngestJobRow[];
}

/**
 * Documents with an ingestion job that is still running.
 *
 * `ingest-pdf` allows one processing job plus three pending jobs per workspace,
 * so a caller must not start a second registration while this is non-zero. The
 * count is real state, not a guess.
 */
export async function countActiveJobs(tenantId: string): Promise<number> {
  const { count, error } = await getSupabaseClient()
    .from("ingest_jobs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .in("status", ["pending", "processing"]);
  const normalized = normalizePostgrestError(error, "ingest_jobs");
  if (normalized) throw normalized;
  return count ?? 0;
}

/** Count of chunks still awaiting embeddings — the real processing progress. */
export async function countPendingChunks(documentId: string): Promise<number> {
  const { count, error } = await getSupabaseClient()
    .from("chunks")
    .select("chunk_id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);

  const normalized = normalizePostgrestError(error, "chunks");
  if (normalized) throw normalized;
  return count ?? 0;
}

/**
 * Total chunks parsed for a document — the denominator for progress.
 * Same read shape as `countPendingChunks` without the NULL filter, so no
 * backend change was needed: completed = total − pending, both live values.
 * Zero while the document is still parsing (chunks are inserted at parse).
 */
export async function countTotalChunks(documentId: string): Promise<number> {
  const { count, error } = await getSupabaseClient()
    .from("chunks")
    .select("chunk_id", { count: "exact", head: true })
    .eq("document_id", documentId);

  const normalized = normalizePostgrestError(error, "chunks");
  if (normalized) throw normalized;
  return count ?? 0;
}

/** Live status of one document (upload-queue progress tracking). */
export async function getDocumentStatus(
  documentId: string,
): Promise<DocumentRow["status"]> {
  const { data, error } = await getSupabaseClient()
    .from("documents")
    .select("status")
    .eq("id", documentId)
    .single();

  const normalized = normalizePostgrestError(error, "documents");
  if (normalized) throw normalized;
  return (data as { status: DocumentRow["status"] }).status;
}

/**
 * Register an already-uploaded object and start ingestion.
 *
 * The document row is created here (status `pending`) and the pipeline parses
 * it; `ready` is set by the embedding worker once every passage has a vector.
 * The server owns the limits — a 413/507/409 comes back with our own message.
 */
export function ingestDocument(
  tenantId: string,
  storagePath: string,
  fileName: string,
): Promise<IngestResponse> {
  return callFunction<IngestResponse>("ingest-pdf", {
    action: "ingest",
    tenant_id: tenantId,
    storage_path: storagePath,
    file_name: fileName,
  });
}

/**
 * Register an uploaded object as a **temporary file of one conversation**
 * (D60). Same pipeline and limits; the backend validates the conversation and
 * sets the 24-hour expiry. The browser never sends scope values of its own.
 */
export function ingestTempDocument(
  tenantId: string,
  storagePath: string,
  fileName: string,
  conversationId: string,
): Promise<IngestResponse> {
  return callFunction<IngestResponse>("ingest-pdf", {
    action: "ingest-temp",
    tenant_id: tenantId,
    storage_path: storagePath,
    file_name: fileName,
    conversation_id: conversationId,
  });
}

/**
 * Promote a temporary file to an ordinary workspace document (D60). The
 * backend clears the conversation binding and expiry in place; storage, chunks
 * and embeddings are preserved. Attaching it to a Space afterwards is the
 * existing source-attach flow.
 */
export function promoteDocument(documentId: string): Promise<IngestResponse> {
  return callFunction<IngestResponse>("ingest-pdf", {
    action: "promote",
    document_id: documentId,
  });
}

/** Re-run ingestion for a failed (or stuck) document. */
export function retryIngest(jobId: string): Promise<IngestResponse> {
  return callFunction<IngestResponse>("ingest-pdf", {
    action: "retry",
    job_id: jobId,
  });
}

/** Remove a document, its chunks and its stored object. */
export function deleteDocument(documentId: string): Promise<IngestResponse> {
  return callFunction<IngestResponse>("ingest-pdf", {
    action: "delete-document",
    document_id: documentId,
  });
}
