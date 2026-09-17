import {
  getSupabaseClient,
} from "@/lib/supabase/client";
import { ApiError, normalizePostgrestError } from "@/lib/api/errors";
import type {
  DocumentRow,
  NotebookRow,
  NotebookSource,
  NotebookSourceRow,
} from "@/lib/api/types";

/**
 * Notebooks and their sources.
 *
 * All of this goes through PostgREST under RLS with the caller's session — the
 * same authorization boundary as every other read. There is no notebook endpoint
 * to call: the tables *are* the API (see DECISIONS.md D49).
 *
 * Scope of authority: this module may create/rename/delete a notebook, attach
 * and detach documents, and toggle `selected`. It must never attempt to filter
 * retrieval — the backend resolves the allowed document set from
 * `notebook_sources` when `/ask` is given a `notebook_id` (D50).
 */

const NOTEBOOK_COLUMNS = "id,tenant_id,name,created_by,created_at,updated_at";
const DOCUMENT_COLUMNS =
  "id,file_name,page_count,status,embedding_model,created_at,updated_at,storage_path";

/** A notebook with its real source counts, for nav/list surfaces. */
export type NotebookSummary = {
  notebook: NotebookRow;
  sources: number;
  selected: number;
};

/** Bounded read: workspaces hold at most a few notebooks (audit §15). */
const NOTEBOOK_LIMIT = 100;

function fail(error: { code?: string; message?: string }, source: string): never {
  throw normalizePostgrestError(error, source) ?? new ApiError("backend", { source });
}

export async function listNotebooks(tenantId: string): Promise<NotebookRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("notebooks")
    .select(NOTEBOOK_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(NOTEBOOK_LIMIT);
  if (error) fail(error, "notebooks");
  return (data ?? []) as NotebookRow[];
}

export async function getNotebook(
  tenantId: string,
  notebookId: string,
): Promise<NotebookRow | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("notebooks")
    .select(NOTEBOOK_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("id", notebookId)
    .limit(1);
  if (error) fail(error, "notebooks");
  return ((data ?? [])[0] as NotebookRow | undefined) ?? null;
}

export async function createNotebook(
  tenantId: string,
  name: string,
  createdBy: string | null,
): Promise<NotebookRow> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("notebooks")
    .insert({ tenant_id: tenantId, name: name.trim(), created_by: createdBy })
    .select(NOTEBOOK_COLUMNS)
    .single();
  if (error) fail(error, "notebooks");
  return data as NotebookRow;
}

export async function renameNotebook(notebookId: string, name: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("notebooks")
    .update({ name: name.trim() })
    .eq("id", notebookId);
  if (error) fail(error, "notebooks");
}

/** Deletes the notebook; `notebook_sources` rows cascade. Documents are kept. */
export async function deleteNotebook(notebookId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("notebooks").delete().eq("id", notebookId);
  if (error) fail(error, "notebooks");
}

/**
 * Every source of a notebook, joined to its document.
 *
 * The join is an inner embed on the FK `(document_id, tenant_id)`, so a document
 * from another tenant can never appear here even if a row existed.
 */
export async function listNotebookSources(
  tenantId: string,
  notebookId: string,
): Promise<NotebookSource[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("notebook_sources")
    .select(
      `notebook_id,document_id,tenant_id,selected,added_at,documents(${DOCUMENT_COLUMNS})`,
    )
    .eq("tenant_id", tenantId)
    .eq("notebook_id", notebookId)
    .order("added_at", { ascending: true })
    .limit(500);
  if (error) fail(error, "notebook_sources");

  return ((data ?? []) as Array<
    NotebookSourceRow & { documents: DocumentRow | DocumentRow[] | null }
  >).map((row) => ({
    documentId: row.document_id,
    selected: row.selected,
    addedAt: row.added_at,
    document: (Array.isArray(row.documents) ? row.documents[0] : row.documents) ?? null,
  }));
}

export async function addSource(
  tenantId: string,
  notebookId: string,
  documentId: string,
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("notebook_sources").insert({
    tenant_id: tenantId,
    notebook_id: notebookId,
    document_id: documentId,
    selected: true,
  });
  if (error) fail(error, "notebook_sources");
}

/** Removes the document from the notebook. The document itself is untouched. */
export async function removeSource(notebookId: string, documentId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("notebook_sources")
    .delete()
    .eq("notebook_id", notebookId)
    .eq("document_id", documentId);
  if (error) fail(error, "notebook_sources");
}

/**
 * Selects or deselects a source.
 *
 * This only writes the flag: whether a deselected document is really excluded
 * is decided by the backend at retrieval time (D50), which is the point.
 */
export async function setSourceSelected(
  notebookId: string,
  documentId: string,
  selected: boolean,
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("notebook_sources")
    .update({ selected })
    .eq("notebook_id", notebookId)
    .eq("document_id", documentId);
  if (error) fail(error, "notebook_sources");
}

/**
 * Notebooks with their source counts.
 *
 * Source counts come from 
otebook_sources, never from the document list: a
 * document that is not a source of this notebook must not appear to be one.
 */
export async function listNotebookSummaries(tenantId: string): Promise<NotebookSummary[]> {
  const notebooks = await listNotebooks(tenantId);
  return Promise.all(
    notebooks.map(async (notebook) => {
      const sources = await listNotebookSources(tenantId, notebook.id);
      return {
        notebook,
        sources: sources.length,
        selected: sources.filter((source) => source.selected).length,
      };
    }),
  );
}
