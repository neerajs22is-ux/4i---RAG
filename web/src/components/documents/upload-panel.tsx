"use client";

import { AlertTriangle, Check, FileText, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, normalizeApiError } from "@/lib/api/errors";
import { addSource } from "@/lib/api/notebooks";
import {
  countActiveJobs,
  ingestDocument,
  ingestTempDocument,
} from "@/lib/api/documents";
import { formatBytes, isPdf, MAX_FILE_BYTES, uploadDocument } from "@/lib/api/upload";
import { cn } from "cn";

/**
 * Upload queue.
 *
 * One file at a time, and — importantly — **registration waits for the
 * workspace to be free**. `ingest-pdf` allows one processing job (plus three
 * pending), and a document keeps its job in `processing` until the embedding
 * worker has vectorised every passage. Firing a second registration while that
 * is true earns a 409, so the queue watches the real job state
 * (`countActiveJobs`) and says so, instead of failing.
 *
 * Two registration modes:
 *  - workspace documents (default): `ingest` + optional attach to a Space;
 *  - temporary conversation files (D60, `temporary` prop): `ingest-temp` bound
 *    to the conversation `ensureConversation` resolves, never attached to a
 *    Space, removed after 24 hours.
 *
 * Honest by construction: the only percentage shown is the browser's real
 * upload progress; a waiting row reports the real number of active jobs; a
 * failure keeps the object that is already stored so the user can retry
 * **registration only**, without re-uploading the file.
 */

type ItemState = "queued" | "uploading" | "waiting" | "registering" | "done" | "failed";

type QueueItem = {
  id: string;
  file: File;
  state: ItemState;
  /** Real upload fraction, or null while the browser reports nothing. */
  progress: number | null;
  message: string | null;
  documentId: string | null;
  /** Set once the bytes are in Storage; enables registration-only retry. */
  storagePath: string | null;
};

export type UploadLimits = {
  /** Active documents already in the workspace. */
  documents: number;
  /** Sum of stored bytes already used by the workspace. */
  bytes: number;
};

export const MAX_DOCUMENTS = 60;
export const MAX_WORKSPACE_BYTES = 400 * 1024 * 1024;

/** Bounded wait for the workspace to finish its current document. */
const WAIT_POLL_MS = 15_000;
const MAX_WAIT_MS = 20 * 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApiError("validation", { source: "ingest-pdf", detail: "Cancelled." }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function UploadPanel({
  tenantId,
  limits,
  notebookId,
  temporary,
  onUploaded,
  onClose,
}: {
  tenantId: string;
  /**
   * Early feedback only (the server is authoritative). Omitted by the
   * conversation-file flow, which has no workspace document list loaded; the
   * per-file checks below still run and the server still enforces every limit.
   */
  limits?: UploadLimits;
  /** When set, each finished document is attached to this notebook. */
  notebookId?: string;
  /**
   * Temporary conversation files (D60). `ensureConversation` resolves the
   * conversation at registration time — created on first use by the host —
   * and each document is bound to it with a 24-hour expiry instead of being
   * stored as a workspace document.
   */
  temporary?: { ensureConversation: (title: string) => Promise<string> };
  /** Called once per successfully registered document. */
  onUploaded?: (documentId: string) => void;
  onClose?: () => void;
}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const queueRef = useRef<QueueItem[]>([]);
  const runningRef = useRef(false);
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  const sync = useCallback(() => setItems([...queueRef.current]), []);
  const patch = useCallback(
    (id: string, changes: Partial<QueueItem>) => {
      queueRef.current = queueRef.current.map((item) =>
        item.id === id ? { ...item, ...changes } : item,
      );
      sync();
    },
    [sync],
  );
  const remove = useCallback(
    (id: string) => {
      queueRef.current = queueRef.current.filter((item) => item.id !== id);
      sync();
    },
    [sync],
  );

  /** Process the queue serially; safe to call repeatedly. */
  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        const next = queueRef.current.find((item) => item.state === "queued");
        if (!next) break;

        const controller = new AbortController();
        abortRef.current.set(next.id, controller);

        // 1. Upload the bytes (real progress). Skipped on a registration retry.
        let storagePath = next.storagePath;
        if (!storagePath) {
          patch(next.id, { state: "uploading", progress: 0, message: null });
          try {
            const uploaded = await uploadDocument({
              tenantId,
              file: next.file,
              signal: controller.signal,
              onProgress: ({ loaded, total }) => patch(next.id, { progress: loaded / total }),
            });
            storagePath = uploaded.storagePath;
            patch(next.id, { storagePath, progress: 1 });
          } catch (error) {
            const api = normalizeApiError(error, "storage");
            patch(next.id, { state: "failed", message: api.detail ?? api.userMessage });
            abortRef.current.delete(next.id);
            continue;
          }
        }

        // 2. Wait until the workspace can accept a registration. The backend
        //    allows one processing job, so this is real back-pressure.
        patch(next.id, { state: "waiting", message: null });
        try {
          const started = Date.now();
          for (;;) {
            if (controller.signal.aborted) {
              throw new ApiError("validation", { source: "ingest-pdf", detail: "Cancelled." });
            }
            const active = await countActiveJobs(tenantId);
            if (active === 0) break;
            if (Date.now() - started > MAX_WAIT_MS) {
              throw new ApiError("conflict", {
                source: "ingest-pdf",
                detail: "The workspace is still processing another document. Try registration again later.",
              });
            }
            patch(next.id, {
              message: `Waiting for the workspace to finish its current document (${active} active ${active === 1 ? "job" : "jobs"}).`,
            });
            await sleep(WAIT_POLL_MS, controller.signal);
          }
        } catch (error) {
          const api = normalizeApiError(error, "ingest-pdf");
          patch(next.id, { state: "failed", message: api.detail ?? api.userMessage });
          abortRef.current.delete(next.id);
          continue;
        }

        // 3. Register the stored object (the pipeline parses and indexes it).
        patch(next.id, { state: "registering", message: null });
        try {
          const result = temporary
            ? await ingestTempDocument(
                tenantId,
                storagePath,
                next.file.name,
                await temporary.ensureConversation(next.file.name),
              )
            : await ingestDocument(tenantId, storagePath, next.file.name);
          if (!result.ok) {
            patch(next.id, {
              state: "failed",
              message: result.error ?? "The document could not be registered.",
            });
            continue;
          }
          const documentId = result.document_id ?? null;
          if (!temporary && notebookId && documentId) {
            try {
              await addSource(tenantId, notebookId, documentId);
            } catch {
              patch(next.id, {
                message: "Uploaded and registered, but it could not be added to this space.",
              });
            }
          }
          patch(next.id, { state: "done", documentId });
          if (documentId) onUploaded?.(documentId);
        } catch (error) {
          // A real ApiError carries our own message (conflict, limits,
          // duplicate). Anything else is reported as what it is, not as a
          // vague registration failure.
          const api = normalizeApiError(error, "ingest-pdf");
          patch(next.id, { state: "failed", message: api.detail ?? api.userMessage });
        } finally {
          abortRef.current.delete(next.id);
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [tenantId, notebookId, temporary, patch, onUploaded]);

  /** Early validation only; the server is authoritative. */
  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const queued = queueRef.current;
      const activeCount =
        limits ? limits.documents + queued.filter((item) => item.state !== "failed").length : 0;
      let projectedBytes = limits
        ? limits.bytes +
          queued.reduce((sum, item) => (item.state === "failed" ? sum : sum + item.file.size), 0)
        : 0;

      const accepted: QueueItem[] = [];
      for (const file of files) {
        const reject = (message: string) => {
          accepted.push({
            id: crypto.randomUUID(),
            file,
            state: "failed",
            progress: null,
            message,
            documentId: null,
            storagePath: null,
          });
        };
        if (!isPdf(file)) {
          reject("Only PDF files are supported.");
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          reject(`${formatBytes(file.size)} — the limit is ${formatBytes(MAX_FILE_BYTES)}.`);
          continue;
        }
        if (limits && activeCount + accepted.filter((i) => i.message === null).length >= MAX_DOCUMENTS) {
          reject(`The workspace document limit is ${MAX_DOCUMENTS}.`);
          continue;
        }
        if (limits && projectedBytes + file.size > MAX_WORKSPACE_BYTES) {
          reject(`This would exceed the workspace storage budget of ${formatBytes(MAX_WORKSPACE_BYTES)}.`);
          continue;
        }
        projectedBytes += file.size;
        accepted.push({
          id: crypto.randomUUID(),
          file,
          state: "queued",
          progress: null,
          message: null,
          documentId: null,
          storagePath: null,
        });
      }
      queueRef.current = [...queueRef.current, ...accepted];
      sync();
      void pump();
    },
    [limits, pump, sync],
  );

  const cancel = useCallback(
    (id: string) => {
      const controller = abortRef.current.get(id);
      if (controller) {
        controller.abort();
        return;
      }
      remove(id);
    },
    [remove],
  );

  /** Retry only the registration step: the object is already in Storage. */
  const retryRegistration = useCallback(
    (id: string) => {
      patch(id, { state: "queued", message: null });
      void pump();
    },
    [patch, pump],
  );

  const busy = items.some(
    (item) => item.state === "uploading" || item.state === "waiting" || item.state === "registering",
  );

  return (
    <div className="flex min-h-0 flex-col">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload PDF files: press Enter to choose files, or drop them here"
        onClick={() => {
          if (!busy) inputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !busy) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (!busy) addFiles(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "hairline rounded-xl border border-dashed px-4 py-6 text-center transition-colors duration-[var(--duration-fast)]",
          "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
          dragActive && "border-primary/40 bg-accent/40",
          busy ? "cursor-default opacity-60" : "cursor-pointer hover:bg-accent/30",
        )}
      >
        <Upload className="text-muted-foreground mx-auto size-4" aria-hidden="true" />
        <p className="mt-2 text-xs font-medium">
          {busy ? "Working…" : "Drop PDFs here, or choose files"}
        </p>
        <p className="text-muted-foreground mt-1 text-2xs">
          {temporary
            ? `${formatBytes(MAX_FILE_BYTES)} per file · temporary files are removed after 24 hours · indexed one at a time`
            : `${formatBytes(MAX_FILE_BYTES)} per file · ${formatBytes(MAX_WORKSPACE_BYTES)} per workspace · documents are indexed one at a time`}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="sr-only"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </div>

      {items.length > 0 ? (
        <ul className="mt-3 space-y-1.5" aria-live="polite">
          {items.map((item) => (
            <li
              key={item.id}
              className={cn(
                "hairline rounded-lg border px-2.5 py-2",
                item.state === "failed" ? "border-destructive/25" : "bg-card",
              )}
            >
              <div className="flex items-start gap-2">
                {item.state === "done" ? (
                  <Check className="text-success mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                ) : item.state === "failed" ? (
                  <AlertTriangle className="text-destructive mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                ) : item.state === "queued" ? (
                  <FileText className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <Loader2 className="text-muted-foreground mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs">{item.file.name}</p>
                  <p className="text-muted-foreground mt-0.5 text-2xs">
                    {item.state === "queued" ? "Waiting in the queue" : null}
                    {item.state === "uploading"
                      ? item.progress === null
                        ? `Uploading · ${formatBytes(item.file.size)}`
                        : `Uploading ${Math.round(item.progress * 100)}%`
                      : null}
                    {item.state === "waiting"
                      ? (item.message ?? "Waiting for the workspace…")
                      : null}
                    {item.state === "registering" ? "Registering…" : null}
                    {item.state === "done" && temporary ? "Added to this conversation · temporary" : null}
                    {item.state === "done" && !temporary ? "Added · processing continues in the background" : null}
                    {item.state === "failed" ? item.message : null}
                  </p>
                  {item.state === "uploading" && item.progress !== null ? (
                    <div
                      className="bg-muted mt-1.5 h-0.5 w-full overflow-hidden rounded-full"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(item.progress * 100)}
                      aria-label={`Uploading ${item.file.name}`}
                    >
                      <div
                        className="bg-primary h-full transition-[width] duration-[var(--duration-fast)]"
                        style={{ width: `${Math.round(item.progress * 100)}%` }}
                      />
                    </div>
                  ) : null}
                  {item.state === "waiting" ? (
                    <div className="bg-muted shimmer mt-1.5 h-0.5 w-full overflow-hidden rounded-full" aria-hidden="true" />
                  ) : null}
                  {item.state === "failed" && item.storagePath ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground mt-1 gap-1.5 px-0"
                      onClick={() => retryRegistration(item.id)}
                    >
                      <RotateCcw className="size-3" aria-hidden="true" />
                      Try registration again
                    </Button>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    item.state === "queued" || item.state === "failed"
                      ? `Dismiss ${item.file.name}`
                      : `Cancel ${item.file.name}`
                  }
                  onClick={() => cancel(item.id)}
                  className="text-muted-foreground shrink-0"
                >
                  <X className="size-3" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mt-3 text-2xs text-pretty">
          {temporary
            ? "Temporary files answer only in this conversation, are not added to the workspace or a Space, and are removed after 24 hours. Nothing here is a placeholder."
            : "Passages become searchable after processing finishes; the document list shows the real status. Nothing here is a placeholder."}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        {busy ? <Skeleton className="h-2 w-16" /> : null}
        {onClose ? (
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {items.some((item) => item.state === "done") ? "Done" : "Close"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
