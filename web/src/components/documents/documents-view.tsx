"use client";

import { FileStack, RotateCcw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  countTotalChunks,
  deleteDocument,
  listDocuments,
  listIngestJobs,
} from "@/lib/api/documents";
import { retryIngest } from "@/lib/api/documents";
import { ApiError, normalizeApiError } from "@/lib/api/errors";
import type { DocumentRow, IngestJobRow } from "@/lib/api/types";
import { DocumentProgress } from "@/components/documents/document-progress";
import { compactNumber } from "@/lib/format";
import { cn } from "cn";

/**
 * Documents.
 *
 * Everything shown is real: `documents.status`, the latest `ingest_jobs` row
 * (status, attempts, last failure reason) and, for documents still processing,
 * the true parsed/embedded chunk counts. Nothing is simulated — when the
 * workspace is empty, the empty state says so, and the percentage is always
 * derived from live counts, never animated.
 *
 * Real state is polled while anything is still processing (the same pattern
 * as the conversation file strip): the list refreshes a few seconds after an
 * upload registers, transitions are announced once, and a failed read stops
 * the poll with an explicit retry instead of spinning forever.
 */

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      documents: DocumentRow[];
      jobs: Map<string, IngestJobRow>;
      pending: Map<string, number>;
      totals: Map<string, number>;
    }
  | { kind: "error"; error: ApiError };

/** Real state is polled while anything is still processing. */
const POLL_MS = 5_000;

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
  /** A read that fails after the first load stops the poll, with retry. */
  const [pollError, setPollError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /** Status seen on the previous read, for one announcement per transition. */
  const statusRef = useRef<Map<string, string>>(new Map());

  // Load, then keep polling only while something is still processing. Every
  // state update happens inside an async callback; a failed read stops the
  // poll and offers an explicit retry.
  useEffect(() => {
    if (!activeWorkspace) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tenantId = activeWorkspace.tenantId;

    const tick = async () => {
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
        // Real progress for anything still processing: parsed chunks (the
        // denominator) and chunks still awaiting embeddings.
        const processing = documents.filter((d) => d.status === "pending");
        const [pendingCounts, totalCounts] = await Promise.all([
          Promise.all(
            processing.map((d) => countPendingChunks(d.id).catch(() => null)),
          ),
          Promise.all(
            processing.map((d) => countTotalChunks(d.id).catch(() => null)),
          ),
        ]);
        if (cancelled) return;
        const pending = new Map<string, number>();
        const totals = new Map<string, number>();
        processing.forEach((d, i) => {
          if (pendingCounts[i] !== null) pending.set(d.id, pendingCounts[i]);
          if (totalCounts[i] !== null) totals.set(d.id, totalCounts[i]);
        });

        const transitions: string[] = [];
        for (const doc of documents) {
          const before = statusRef.current.get(doc.id);
          if (before !== undefined && before !== doc.status) {
            if (doc.status === "ready") transitions.push(`${doc.file_name} is ready.`);
            if (doc.status === "failed") {
              transitions.push(`${doc.file_name} could not be processed.`);
            }
          }
          statusRef.current.set(doc.id, doc.status);
        }

        setState({ kind: "ready", documents, jobs: jobMap, pending, totals });
        setPollError(null);
        if (transitions.length > 0) setAnnouncement(transitions.join(" "));

        if (documents.some((d) => d.status === "pending")) {
          timer = setTimeout(() => void tick(), POLL_MS);
        }
      } catch (error) {
        if (cancelled) return;
        const api = normalizeApiError(error, "documents");
        setState((prev) =>
          prev.kind === "ready"
            ? prev
            : { kind: "error", error: api },
        );
        setPollError((prev) => prev ?? api.userMessage);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeWorkspace, reloadToken]);

  const reload = useCallback(() => {
    setPollError(null);
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

      {pollError ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-xs">{pollError}</p>
          <Button variant="ghost" size="xs" onClick={reload} className="gap-1.5">
            <RotateCcw className="size-3" aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

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
              const total = state.totals.get(doc.id);
              const busy = busyId === doc.id;
              return (
                <li key={doc.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-center gap-3 py-4">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {doc.file_name}
                        </p>
                        {doc.status === "pending" ? (
                          <div className="text-muted-foreground mt-0.5 font-mono text-2xs">
                            <DocumentProgress
                              fileName={doc.file_name}
                              total={total ?? null}
                              pending={pending ?? null}
                            />
                          </div>
                        ) : (
                          <p className="text-muted-foreground mt-0.5 font-mono text-2xs">
                            {doc.page_count != null
                              ? `${compactNumber(doc.page_count)} pages`
                              : "page count pending"}
                            {doc.embedding_model ? ` · ${doc.embedding_model}` : ""}
                          </p>
                        )}
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
