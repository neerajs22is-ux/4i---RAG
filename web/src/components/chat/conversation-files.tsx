"use client";

import {
  AlertTriangle,
  EllipsisIcon,
  FileText,
  Loader2,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { UploadPanel } from "@/components/documents/upload-panel";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  countPendingChunks,
  deleteDocument,
  listConversationFiles,
  listIngestJobsForDocuments,
  promoteDocument,
  retryIngest,
} from "@/lib/api/documents";
import { normalizeApiError } from "@/lib/api/errors";
import type { ConversationFileRow, IngestJobRow } from "@/lib/api/types";
import { compactNumber, timeUntil } from "@/lib/format";
import { cn } from "cn";

/**
 * L-3: ingest failure text is backend-written (parser/embedding/provider
 * detail, storage keys). Never render it verbatim — map our own envelope
 * copy through and fall back to a generic message. This upholds the
 * errors.ts discipline ("never surface a raw driver message").
 */
function safeIngestError(raw: string | null | undefined): string {
  const text = String(raw ?? "");
  // Own server-authored messages we deliberately surface (ingest-pdf fail()
  // copy for user-actionable states). Match on stable prefixes only.
  if (/duplicate of/i.test(text)) return "This file is already in the workspace.";
  if (/no extractable text|scanned\/image-only/i.test(text)) {
    return "No readable text was found in this PDF.";
  }
  if (/workspace chunk budget exceeded/i.test(text)) {
    return "The workspace has reached its indexed-content limit.";
  }
  if (/workspace storage budget|storage budget/i.test(text)) {
    return "The workspace has reached its storage limit.";
  }
  if (/file is .*limit is 25/i.test(text)) return "This file exceeds the 25 MB limit.";
  return "Processing failed. Try again or re-upload the file.";
}

/**
 * Files in this conversation — temporary chat files (D60).
 *
 * A temporary file is an ordinary document bound to one conversation with a
 * 24-hour expiry; retrieval-time inclusion is decided by the backend and the
 * browser never filters. This surface shows only what the backend knows: the
 * real document status, the real remaining-passage count, the real failure
 * reason and the real expiry — plus the two supported lifecycle actions
 * (`promote` keeps a file in the workspace, `delete-document` removes it).
 *
 * It is deliberately not a workspace document list: workspace documents live
 * under Documents and in Space sources, and the copy says so.
 */

/** Real state is polled while anything is still processing. */
const POLL_MS = 5_000;

export function ConversationFiles({
  tenantId,
  conversationId,
  ensureConversation,
  notebookId,
  open,
  onOpenChange,
}: {
  tenantId: string;
  /** Conversation the files belong to; null until one exists. */
  conversationId: string | null;
  /**
   * Resolves the conversation at registration time, creating it on first use:
   * a temporary file can only be bound to a conversation that already exists.
   */
  ensureConversation: (title: string) => Promise<string>;
  /** Set inside a Space, only to keep the dialog copy honest about scope. */
  notebookId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [files, setFiles] = useState<ConversationFileRow[]>([]);
  const [jobs, setJobs] = useState<Map<string, IngestJobRow>>(new Map());
  const [pending, setPending] = useState<Map<string, number>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ConversationFileRow | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  /**
   * Current time as state, set only inside async callbacks: render code stays
   * pure, and the expiry copy still moves while a conversation stays open.
   */
  const [nowMs, setNowMs] = useState(0);

  /** Status seen on the previous read, for one announcement per transition. */
  const statusRef = useRef<Map<string, string>>(new Map());

  const reload = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  // Load, then keep polling only while something is still processing. Every
  // state update happens inside an async callback; a failed read stops the
  // poll and offers an explicit retry.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const rows = await listConversationFiles(conversationId);
        const [pendingCounts, jobRows] = await Promise.all([
          Promise.all(
            rows
              .filter((row) => row.status === "pending")
              .map(async (row) => {
                try {
                  return [row.id, await countPendingChunks(row.id)] as const;
                } catch {
                  // Progress is best-effort; the row still shows processing.
                  return null;
                }
              }),
          ),
          listIngestJobsForDocuments(rows.map((row) => row.id)),
        ]);
        if (cancelled) return;

        const latestJob = new Map<string, IngestJobRow>();
        for (const job of jobRows) {
          if (!latestJob.has(job.document_id)) latestJob.set(job.document_id, job);
        }
        const counts = new Map<string, number>();
        for (const entry of pendingCounts) {
          if (entry) counts.set(entry[0], entry[1]);
        }

        const transitions: string[] = [];
        for (const row of rows) {
          const before = statusRef.current.get(row.id);
          if (before !== undefined && before !== row.status) {
            if (row.status === "ready") transitions.push(`${row.file_name} is ready.`);
            if (row.status === "failed") {
              transitions.push(`${row.file_name} could not be processed.`);
            }
          }
          statusRef.current.set(row.id, row.status);
        }

        setFiles(rows);
        setJobs(latestJob);
        setPending(counts);
        setLoadError(null);
        setNowMs(Date.now());
        if (transitions.length > 0) setAnnouncement(transitions.join(" "));

        if (rows.some((row) => row.status === "pending")) {
          timer = setTimeout(() => void tick(), POLL_MS);
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(normalizeApiError(error, "documents").userMessage);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conversationId, reloadToken]);

  // Keep the expiry copy honest while a conversation stays open: "expires in
  // 23h" must not outlive the window it describes.
  useEffect(() => {
    if (files.length === 0) return;
    const interval = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, [files.length]);

  async function handlePromote(file: ConversationFileRow) {
    setBusyId(file.id);
    setActionError(null);
    setNotice(null);
    try {
      await promoteDocument(file.id);
      setFiles((prev) => prev.filter((row) => row.id !== file.id));
      setNotice(
        notebookId
          ? `“${file.file_name}” is now a workspace document. Add it to this Space from the Sources panel.`
          : `“${file.file_name}” is now a workspace document — it stays after 24 hours and appears under Documents.`,
      );
    } catch (error) {
      setActionError(normalizeApiError(error, "ingest-pdf").userMessage);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRetry(file: ConversationFileRow) {
    const job = jobs.get(file.id);
    if (!job) return;
    setBusyId(file.id);
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

  async function handleRemove(file: ConversationFileRow) {
    setPendingRemoval(null);
    setBusyId(file.id);
    setActionError(null);
    try {
      await deleteDocument(file.id);
      setFiles((prev) => prev.filter((row) => row.id !== file.id));
    } catch (error) {
      setActionError(normalizeApiError(error, "ingest-pdf").userMessage);
    } finally {
      setBusyId(null);
    }
  }

  const visible =
    files.length > 0 || loadError !== null || actionError !== null || notice !== null;

  return (
    <>
      {visible ? (
        <div className="mb-2.5 space-y-1.5" data-conversation-files="">
          {notice ? (
            <p className="text-muted-foreground text-2xs text-pretty">{notice}</p>
          ) : null}
          {actionError ? (
            <p role="alert" className="text-destructive text-2xs text-pretty">
              {actionError}
            </p>
          ) : null}
          {loadError ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-muted-foreground text-2xs">{loadError}</p>
              <Button
                variant="ghost"
                size="xs"
                onClick={reload}
                className="text-muted-foreground gap-1.5 px-1.5"
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                Retry
              </Button>
            </div>
          ) : null}
          {files.length > 0 ? (
            <ul className="space-y-1.5" aria-label="Temporary files in this conversation">
              {files.map((file) => (
                <ConversationFileItem
                  key={file.id}
                  file={file}
                  nowMs={nowMs}
                  job={jobs.get(file.id)}
                  remaining={pending.get(file.id)}
                  busy={busyId === file.id}
                  onRetry={() => void handleRetry(file)}
                  onPromote={() => void handlePromote(file)}
                  onRemove={() => setPendingRemoval(file)}
                />
              ))}
            </ul>
          ) : null}
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </div>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setNotice(null);
            setActionError(null);
          }
          onOpenChange(next);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a file to this conversation</DialogTitle>
            <DialogDescription>
              Temporary files answer only in this conversation. They are not added to
              {notebookId ? " this Space" : " the workspace’s documents"}, and they are
              removed after 24 hours. You can save one to the workspace at any time.
            </DialogDescription>
          </DialogHeader>
          {tenantId ? (
            <UploadPanel
              tenantId={tenantId}
              temporary={{ ensureConversation }}
              onUploaded={reload}
              onClose={() => {
                onOpenChange(false);
                reload();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{pendingRemoval?.file_name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The file and its indexed passages are deleted from this conversation. This cannot
              be undone. Workspace documents are not affected.
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
              Remove file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** One file: real status, real progress, real expiry, supported actions. */
function ConversationFileItem({
  file,
  nowMs,
  job,
  remaining,
  busy,
  onRetry,
  onPromote,
  onRemove,
}: {
  file: ConversationFileRow;
  /** Current time, owned by the parent (see `nowMs` above). */
  nowMs: number;
  job: IngestJobRow | undefined;
  remaining: number | undefined;
  busy: boolean;
  onRetry: () => void;
  onPromote: () => void;
  onRemove: () => void;
}) {
  const expiresAt = Date.parse(file.expires_at);
  const expired = Number.isNaN(expiresAt) || (nowMs > 0 && expiresAt <= nowMs);
  const processing = !expired && file.status === "pending";
  const failed = !expired && file.status === "failed";

  return (
    <li
      className={cn(
        "hairline bg-card rounded-lg border px-2.5 py-2 transition-opacity duration-[var(--duration-fast)]",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        {processing ? (
          <Loader2
            className="text-muted-foreground mt-0.5 size-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : failed ? (
          <AlertTriangle
            className="text-destructive mt-0.5 size-3.5 shrink-0"
            aria-hidden="true"
          />
        ) : (
          <FileText
            className={cn(
              "mt-0.5 size-3.5 shrink-0",
              expired ? "text-muted-foreground/50" : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{file.file_name}</p>
          <p className="text-muted-foreground mt-0.5 text-2xs">
            {expired ? <span>Expired — no longer used in answers</span> : null}
            {failed ? <span className="text-destructive">Failed</span> : null}
            {processing ? (
              <span>
                {remaining
                  ? `Processing · ${compactNumber(remaining)} passages left`
                  : "Processing"}
              </span>
            ) : null}
            {!expired && !failed && !processing ? (
              <span className="text-success">Ready</span>
            ) : null}
          </p>
          {failed && job?.last_error ? (
            <p className="text-muted-foreground/70 mt-1 text-2xs text-pretty">
              {safeIngestError(job.last_error)}
            </p>
          ) : null}
          {processing ? (
            <div
              className="bg-muted shimmer mt-1.5 h-0.5 w-full overflow-hidden rounded-full"
              aria-hidden="true"
            />
          ) : null}
          <p className="text-muted-foreground/70 mt-1 text-2xs">
            {expired
              ? "Temporary files are removed 24 hours after they are added."
              : `Temporary · expires in ${timeUntil(file.expires_at, nowMs)}`}
          </p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Options for ${file.file_name}`}
              disabled={busy}
              className="text-muted-foreground shrink-0"
            >
              <EllipsisIcon className="size-3" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {failed ? (
              <DropdownMenuItem onSelect={onRetry} disabled={!job}>
                <RotateCcw aria-hidden="true" />
                Retry processing
              </DropdownMenuItem>
            ) : null}
            {!expired ? (
              <DropdownMenuItem onSelect={onPromote}>
                <Save aria-hidden="true" />
                Save to workspace
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 aria-hidden="true" />
              Remove file
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
