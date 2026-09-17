"use client";

import {
  AlertTriangle,
  Check,
  EllipsisIcon,
  FileText,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "cn";
import {
  addSource,
  listNotebookSources,
  removeSource,
  setSourceSelected,
} from "@/lib/api/notebooks";
import {
  countPendingChunks,
  deleteDocument,
  listDocuments,
  listIngestJobs,
  retryIngest,
} from "@/lib/api/documents";
import { ApiError, normalizeApiError } from "@/lib/api/errors";
import type { DocumentRow, IngestJobRow, NotebookSource } from "@/lib/api/types";
import { invalidateNotebooks } from "@/lib/notebooks-store";
import { UploadPanel } from "@/components/documents/upload-panel";
import { compactNumber, relativeTime, truncate } from "@/lib/format";

/**
 * Sources panel — the "which documents may this notebook answer from" surface.
 *
 * The browser does not decide retrieval: it writes `selected` and sends the
 * notebook id to the backend, which resolves the allowed document set (B2/D50).
 * Everything shown here is real state: document status, the latest ingestion
 * job, and how many passages are still waiting for embeddings.
 */

type State =
  | { kind: "loading" }
  | { kind: "ready"; sources: NotebookSource[]; documents: DocumentRow[]; jobs: Map<string, IngestJobRow>; pending: Map<string, number> }
  | { kind: "error"; error: ApiError };

export function SourcesPanel({
  tenantId,
  notebookId,
  onChanged,
  className,
}: {
  tenantId: string;
  notebookId: string;
  /** Called after any mutation so the host can refresh counts. */
  onChanged?: () => void;
  className?: string;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<NotebookSource | null>(null);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sources, documents, jobs] = await Promise.all([
          listNotebookSources(tenantId, notebookId),
          listDocuments(tenantId),
          listIngestJobs(tenantId),
        ]);
        const latestJob = new Map<string, IngestJobRow>();
        for (const job of jobs) {
          if (!latestJob.has(job.document_id)) latestJob.set(job.document_id, job);
        }
        // Passage progress only for documents that are still being prepared.
        const pending = new Map<string, number>();
        await Promise.all(
          documents
            .filter((doc) => doc.status === "pending")
            .map(async (doc) => {
              try {
                pending.set(doc.id, await countPendingChunks(doc.id));
              } catch {
                // Progress is best-effort; the row still shows "processing".
              }
            }),
        );
        if (!cancelled) setState({ kind: "ready", sources, documents, jobs: latestJob, pending });
      } catch (error) {
        if (!cancelled) setState({ kind: "error", error: normalizeApiError(error, "notebook_sources") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, notebookId, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  const ready = state.kind === "ready" ? state : null;
  const totals = useMemo(() => {
    if (!ready) return { total: 0, selected: 0 };
    return {
      total: ready.sources.length,
      selected: ready.sources.filter((source) => source.selected).length,
    };
  }, [ready]);

  async function toggle(source: NotebookSource, next: boolean) {
    setActionError(null);
    // Optimistic: the checkbox must feel instant; a failure reverts it.
    setState((prev) =>
      prev.kind === "ready"
        ? {
            ...prev,
            sources: prev.sources.map((row) =>
              row.documentId === source.documentId ? { ...row, selected: next } : row,
            ),
          }
        : prev,
    );
    try {
      await setSourceSelected(notebookId, source.documentId, next);
      invalidateNotebooks();
      onChanged?.();
    } catch (error) {
      setState((prev) =>
        prev.kind === "ready"
          ? {
              ...prev,
              sources: prev.sources.map((row) =>
                row.documentId === source.documentId ? { ...row, selected: !next } : row,
              ),
            }
          : prev,
      );
      setActionError(normalizeApiError(error, "notebook_sources").userMessage);
    }
  }

  async function handleRemove(source: NotebookSource) {
    setPendingRemoval(null);
    setBusyDocId(source.documentId);
    setActionError(null);
    try {
      await removeSource(notebookId, source.documentId);
      invalidateNotebooks();
      onChanged?.();
      reload();
    } catch (error) {
      setActionError(normalizeApiError(error, "notebook_sources").userMessage);
    } finally {
      setBusyDocId(null);
    }
  }

  async function handleRetry(source: NotebookSource) {
    const job = ready?.jobs.get(source.documentId);
    if (!job) return;
    setBusyDocId(source.documentId);
    setActionError(null);
    try {
      await retryIngest(job.id);
      reload();
    } catch (error) {
      setActionError(normalizeApiError(error, "ingest-pdf").userMessage);
    } finally {
      setBusyDocId(null);
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <div className="min-w-0">
          <p className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">Sources</p>
          <p className="mt-0.5 text-xs">
            {ready ? (
              <>
                <span className="font-medium">{totals.selected}</span>
                <span className="text-muted-foreground"> of {totals.total} included in answers</span>
              </>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            className="gap-1.5"
            onClick={() => setUploading(true)}
          >
            <Upload className="size-3" aria-hidden="true" />
            Upload
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="gap-1.5"
            onClick={() => setAdding(true)}
            disabled={!ready}
          >
            <Plus className="size-3" aria-hidden="true" />
            Add
          </Button>
        </div>
      </div>
      <Separator />

      {actionError ? (
        <p role="alert" className="text-destructive px-3 py-2 text-2xs">
          {actionError}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {state.kind === "loading" ? (
          <div className="space-y-2 px-1" aria-busy="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-5/6" />
            <span className="sr-only" role="status">
              Loading sources
            </span>
          </div>
        ) : null}

        {state.kind === "error" ? (
          <div className="hairline mx-1 rounded-lg border border-dashed px-3 py-3">
            <p className="text-muted-foreground text-2xs">{state.error.userMessage}</p>
            <Button variant="ghost" size="xs" onClick={reload} className="text-muted-foreground mt-2 gap-1.5 px-0">
              <RotateCcw className="size-3" aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : null}

        {ready && ready.sources.length === 0 ? (
          <div className="hairline mx-1 rounded-lg border border-dashed px-3 py-4">
            <p className="text-2xs font-medium">No sources yet</p>
            <p className="text-muted-foreground/70 mt-1 text-2xs text-pretty">
              Add documents to this space, then choose which of them answers may use. Until
              then, questions here will be refused.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="xs" className="gap-1.5 px-0" onClick={() => setAdding(true)}>
                <Plus className="size-3" aria-hidden="true" />
                Add documents
              </Button>
              <Button asChild variant="ghost" size="xs" className="text-muted-foreground px-0">
                <Link href="/documents">Manage documents</Link>
              </Button>
            </div>
          </div>
        ) : null}

        {ready && ready.sources.length > 0 ? (
          <>
            {totals.selected === 0 ? (
              <div className="bg-warning-muted/60 border-warning/25 text-warning mx-1 mb-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-2xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span className="text-pretty">
                  No sources are included, so questions in this space will be refused. Include at
                  least one.
                </span>
              </div>
            ) : null}

            <ul className="space-y-1">
              {ready.sources.map((source) => (
                <SourceRow
                  key={source.documentId}
                  source={source}
                  job={ready.jobs.get(source.documentId)}
                  pending={ready.pending.get(source.documentId)}
                  busy={busyDocId === source.documentId}
                  onToggle={(next) => void toggle(source, next)}
                  onRetry={() => void handleRetry(source)}
                  onRemove={() => setPendingRemoval(source)}
                />
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <Dialog open={uploading} onOpenChange={setUploading}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload and add sources</DialogTitle>
            <DialogDescription>
              Each PDF is stored in this workspace, indexed, and added to this space as an
              included source.
            </DialogDescription>
          </DialogHeader>
          {tenantId ? (
            <UploadPanel
              tenantId={tenantId}
              notebookId={notebookId}
              limits={{
                documents: ready ? ready.documents.filter((d) => d.status !== "failed").length : 0,
                bytes: ready ? ready.documents.reduce((sum, d) => sum + (d.file_size ?? 0), 0) : 0,
              }}
              onUploaded={() => {
                invalidateNotebooks();
                onChanged?.();
                reload();
              }}
              onClose={() => {
                setUploading(false);
                reload();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <AddSourcesDialog
        open={adding}
        onOpenChange={setAdding}
        tenantId={tenantId}
        notebookId={notebookId}
        attached={
          ready
            ? new Set(ready.sources.map((source) => source.documentId))
            : new Set<string>()
        }
        onAdded={() => {
          invalidateNotebooks();
          onChanged?.();
          reload();
        }}
      />

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove “{pendingRemoval?.document?.file_name ?? "this source"}” from the space?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Answers in this space will stop using it. The document stays in the workspace and
              in any other space.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingRemoval;
                if (target) void handleRemove(target);
              }}
            >
              Remove from space
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** One source row: selection, real processing state, and per-source actions. */
function SourceRow({
  source,
  job,
  pending,
  busy,
  onToggle,
  onRetry,
  onRemove,
}: {
  source: NotebookSource;
  job: IngestJobRow | undefined;
  pending: number | undefined;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const document = source.document;
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!document) {
    // The relationship survived a document the caller can no longer read.
    return (
      <li className="hairline flex items-center gap-2 rounded-lg border px-2.5 py-2">
        <FileText className="text-muted-foreground/50 size-4 shrink-0" aria-hidden="true" />
        <span className="text-muted-foreground min-w-0 flex-1 text-2xs">
          This source is no longer available in this workspace.
        </span>
        <Button variant="ghost" size="xs" onClick={onRemove} className="text-muted-foreground px-1.5">
          Remove
        </Button>
      </li>
    );
  }

  const status = document.status;
  const failed = status === "failed";
  const processing = status === "pending";

  return (
    <li
      className={cn(
        "group/source hairline rounded-lg border px-2.5 py-2 transition-colors duration-[var(--duration-fast)]",
        source.selected ? "bg-card" : "bg-transparent",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={source.selected}
          disabled={busy}
          onCheckedChange={(next) => onToggle(next === true)}
          aria-label={`Include ${document.file_name} in answers from this space`}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{document.file_name}</p>
          <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs">
            {status === "ready" ? (
              <span className="text-success inline-flex items-center gap-1">
                <Check className="size-3" aria-hidden="true" />
                Ready
              </span>
            ) : null}
            {processing ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                Processing{pending ? ` · ${compactNumber(pending)} passages left` : ""}
              </span>
            ) : null}
            {failed ? (
              <span className="text-destructive inline-flex items-center gap-1">
                <AlertTriangle className="size-3" aria-hidden="true" />
                Failed
              </span>
            ) : null}
            {document.page_count != null ? <span>{document.page_count} pages</span> : null}
            <span aria-hidden="true">·</span>
            <span>{relativeTime(document.created_at)}</span>
          </p>
          {failed && job?.last_error ? (
            <p className="text-muted-foreground/70 mt-1 text-2xs text-pretty">
              {truncate(job.last_error, 160)}
            </p>
          ) : null}
          {processing ? (
            <div className="bg-muted shimmer mt-1.5 h-0.5 w-full overflow-hidden rounded-full" aria-hidden="true" />
          ) : null}
        </div>
        <DropdownMenuForSource
          failed={failed}
          busy={busy}
          onRetry={onRetry}
          onRemove={onRemove}
          onDelete={() => setConfirmDelete(true)}
        />
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{document.file_name}” from the workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              The document, its indexed passages and its stored file are removed, and it is removed
              from every space. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void deleteDocument(document.id).then(() => {
                  invalidateNotebooks();
                  onRemove();
                });
              }}
            >
              Delete document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function DropdownMenuForSource({
  failed,
  busy,
  onRetry,
  onRemove,
  onDelete,
}: {
  failed: boolean;
  busy: boolean;
  onRetry: () => void;
  onRemove: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Source options"
          disabled={busy}
          className="text-muted-foreground opacity-0 group-hover/source:opacity-100 focus-visible:opacity-100"
        >
          <EllipsisIcon className="size-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {failed ? (
          <DropdownMenuItem onSelect={onRetry}>
            <RotateCcw aria-hidden="true" />
            Retry processing
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onRemove}>
          Remove from space
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 aria-hidden="true" />
          Delete document
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Attach workspace documents that are not yet sources of this notebook. */
function AddSourcesDialog({
  open,
  onOpenChange,
  tenantId,
  notebookId,
  attached,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  notebookId: string;
  attached: Set<string>;
  onAdded: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <AddSourcesForm
          tenantId={tenantId}
          notebookId={notebookId}
          attached={attached}
          onAdded={onAdded}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mounted only while the dialog is open, so it starts empty every time without
 * an effect that resets state on open.
 */
function AddSourcesForm({
  tenantId,
  notebookId,
  attached,
  onAdded,
  onDone,
}: {
  tenantId: string;
  notebookId: string;
  attached: Set<string>;
  onAdded: () => void;
  onDone: () => void;
}) {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDocuments(tenantId)
      .then((docs) => {
        if (!cancelled) setDocuments(docs);
      })
      .catch((err) => {
        if (!cancelled) setError(normalizeApiError(err, "documents").userMessage);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const available = (documents ?? []).filter((doc) => !attached.has(doc.id));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      for (const documentId of chosen) {
        await addSource(tenantId, notebookId, documentId);
      }
      onAdded();
      onDone();
    } catch (err) {
      setError(normalizeApiError(err, "notebook_sources").userMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
        <DialogHeader>
          <DialogTitle>Add documents as sources</DialogTitle>
          <DialogDescription>
            Added sources are included in answers by default. You can deselect any of them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="max-h-72 min-h-24 overflow-y-auto">
            {documents === null && !error ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-5/6" />
              </div>
            ) : null}

            {documents !== null && available.length === 0 ? (
              <div className="hairline rounded-lg border border-dashed px-3 py-4">
                <p className="text-2xs font-medium">Every document is already a source</p>
                <p className="text-muted-foreground/70 mt-1 text-2xs text-pretty">
                  Add more documents to the workspace first, then attach them here.
                </p>
                <Button asChild variant="ghost" size="xs" className="text-muted-foreground mt-2 px-0">
                  <Link href="/documents" onClick={onDone}>
                    Go to documents
                  </Link>
                </Button>
              </div>
            ) : null}

            {available.length > 0 ? (
              <ul className="space-y-0.5">
                {available.map((doc) => {
                  const checked = chosen.has(doc.id);
                  return (
                    <li key={doc.id}>
                      <label className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => {
                            setChosen((prev) => {
                              const copy = new Set(prev);
                              if (next === true) copy.add(doc.id);
                              else copy.delete(doc.id);
                              return copy;
                            });
                          }}
                          aria-label={`Add ${doc.file_name}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-xs">{doc.file_name}</span>
                        <span className="text-muted-foreground shrink-0 text-2xs">
                          {doc.status === "ready"
                            ? doc.page_count != null
                              ? `${doc.page_count} pages`
                              : "Ready"
                            : doc.status === "pending"
                              ? "Processing"
                              : "Failed"}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={chosen.size === 0 || busy}>
              {busy ? "Adding…" : `Add ${chosen.size || ""} source${chosen.size === 1 ? "" : "s"}`.trim()}
            </Button>
          </DialogFooter>
        </form>
    </>
  );
}
