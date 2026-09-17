"use client";

import { FileStack, RotateCcw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  EmptyState,
  PageFrame,
  PageHeader,
} from "@/components/foundation/page-frame";
import { UploadPanel } from "@/components/documents/upload-panel";
import { ErrorState, LoadingState } from "@/components/foundation/data-states";
import { useSession } from "@/components/providers/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  countPendingChunks,
  deleteDocument,
  listDocuments,
  listIngestJobs,
} from "@/lib/api/documents";
import { retryIngest } from "@/lib/api/documents";
import { ApiError, normalizeApiError } from "@/lib/api/errors";
import type { DocumentRow, IngestJobRow } from "@/lib/api/types";
import { compactNumber } from "@/lib/format";
import { cn } from "cn";

/**
 * Documents.
 *
 * Everything shown is real: `documents.status`, the latest `ingest_jobs` row
 * (status, attempts, last failure reason) and, for documents still processing,
 * the true count of chunks awaiting embeddings. Nothing is simulated — when the
 * workspace is empty, the empty state says so.
 *
 * Upload is not part of this pass: it needs a Storage insert plus the document
 * registration flow, and belongs with the document experience.
 */

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      documents: DocumentRow[];
      jobs: Map<string, IngestJobRow>;
      pending: Map<string, number>;
    }
  | { kind: "error"; error: ApiError };

const STATUS_STYLE: Record<DocumentRow["status"], string> = {
  ready: "border-success/25 bg-success-muted text-success",
  pending: "border-warning/30 bg-warning-muted text-warning",
  failed: "border-conflict/25 bg-conflict-muted text-conflict",
};

const STATUS_LABEL: Record<DocumentRow["status"], string> = {
  ready: "Ready",
  pending: "Processing",
  failed: "Failed",
};

export function DocumentsView() {
  const { activeWorkspace } = useSession();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<DocumentRow | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!activeWorkspace) return;
    let cancelled = false;
    const tenantId = activeWorkspace.tenantId;

    (async () => {
      try {
        const [documents, jobs] = await Promise.all([
          listDocuments(tenantId),
          listIngestJobs(tenantId),
        ]);
        // Latest job per document (the query is already newest-first).
        const jobMap = new Map<string, IngestJobRow>();
        for (const job of jobs) {
          if (!jobMap.has(job.document_id)) jobMap.set(job.document_id, job);
        }
        // Real progress for anything still processing.
        const pending = new Map<string, number>();
        const processing = documents.filter((d) => d.status === "pending");
        const counts = await Promise.all(
          processing.map((d) =>
            countPendingChunks(d.id).catch(() => null),
          ),
        );
        processing.forEach((d, i) => {
          const value = counts[i];
          if (value !== null) pending.set(d.id, value);
        });
        if (!cancelled) setState({ kind: "ready", documents, jobs: jobMap, pending });
      } catch (error) {
        if (!cancelled) {
          setState({ kind: "error", error: normalizeApiError(error, "documents") });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeWorkspace, reloadToken]);

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    setReloadToken((n) => n + 1);
  }, []);

  async function handleRetry(job: IngestJobRow) {
    setBusyId(job.document_id);
    setActionError(null);
    try {
      await retryIngest(job.id);
      reload();
    } catch (error) {
      setActionError(normalizeApiError(error, "ingest-pdf").userMessage);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(document: DocumentRow) {
    setBusyId(document.id);
    setActionError(null);
    try {
      await deleteDocument(document.id);
      setConfirming(null);
      reload();
    } catch (error) {
      setActionError(normalizeApiError(error, "ingest-pdf").userMessage);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageFrame>
      <PageHeader
        eyebrow="Workspace"
        title="Documents"
        description="The documents this workspace searches. Every answer is grounded in these, and nothing else."
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setUploading(true)}>
            <Upload className="size-3.5" aria-hidden="true" />
            Upload PDFs
          </Button>
        }
      />

      <Dialog open={uploading} onOpenChange={setUploading}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload documents</DialogTitle>
            <DialogDescription>
              PDFs only. Each file is stored privately in this workspace, then parsed and indexed;
              the list below shows the real status.
            </DialogDescription>
          </DialogHeader>
          {activeWorkspace ? (
            <UploadPanel
              tenantId={activeWorkspace.tenantId}
              limits={{
                documents: state.kind === "ready" ? state.documents.filter((d) => d.status !== "failed").length : 0,
                bytes: state.kind === "ready" ? state.documents.reduce((sum, d) => sum + (d.file_size ?? 0), 0) : 0,
              }}
              onUploaded={() => reload()}
              onClose={() => {
                setUploading(false);
                reload();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {actionError ? (
        <p role="alert" className="text-destructive mt-4 text-xs">
          {actionError}
        </p>
      ) : null}

      <div className="mt-8">
        {state.kind === "loading" ? (
          <LoadingState label="Loading documents" />
        ) : null}

        {state.kind === "error" ? (
          <ErrorState
            error={state.error}
            title="Could not load documents"
            onRetry={reload}
          />
        ) : null}

        {state.kind === "ready" && state.documents.length === 0 ? (
          <EmptyState
            icon={FileStack}
            title="No documents yet"
            description="Nothing is indexed in this workspace. Uploads arrive with the document experience."
          />
        ) : null}

        {state.kind === "ready" && state.documents.length > 0 ? (
          <ul className="space-y-3">
            {state.documents.map((doc) => {
              const job = state.jobs.get(doc.id);
              const pending = state.pending.get(doc.id);
              const busy = busyId === doc.id;
              return (
                <li key={doc.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-center gap-3 py-4">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {doc.file_name}
                        </p>
                        <p className="text-muted-foreground mt-0.5 font-mono text-2xs">
                          {doc.page_count != null
                            ? `${compactNumber(doc.page_count)} pages`
                            : "page count pending"}
                          {doc.embedding_model ? ` · ${doc.embedding_model}` : ""}
                          {pending != null && pending > 0
                            ? ` · ${compactNumber(pending)} chunks embedding`
                            : ""}
                        </p>
                        {doc.status === "failed" && job?.last_error ? (
                          <p className="text-conflict mt-1 text-2xs text-pretty">
                            {job.last_error}
                          </p>
                        ) : null}
                      </div>

                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium",
                          STATUS_STYLE[doc.status],
                        )}
                      >
                        {STATUS_LABEL[doc.status]}
                      </span>

                      {job && job.attempts > 0 ? (
                        <Badge variant="secondary" className="font-mono text-2xs">
                          attempt {job.attempts}
                        </Badge>
                      ) : null}

                      {doc.status === "failed" && job ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => handleRetry(job)}
                          className="gap-1.5"
                        >
                          <RotateCcw className="size-3.5" aria-hidden="true" />
                          {busy ? "Retrying…" : "Retry"}
                        </Button>
                      ) : null}

                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${doc.file_name}`}
                        disabled={busy}
                        onClick={() => setConfirming(doc)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </Button>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this document?</DialogTitle>
            <DialogDescription>
              {confirming?.file_name} and its extracted passages and embeddings
              will be removed. Existing conversations keep the citations they
              already recorded.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busyId !== null}
              onClick={() => confirming && handleDelete(confirming)}
            >
              {busyId !== null ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageFrame>
  );
}
