"use client";

import { Boxes, EllipsisIcon, Plus, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";

import { useSession } from "@/components/providers/session-provider";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, normalizeApiError } from "@/lib/api/errors";
import {
  createNotebook,
  deleteNotebook,
  listNotebookSummaries,
  type NotebookSummary,
} from "@/lib/api/notebooks";
import type { NotebookRow } from "@/lib/api/types";
import {
  getNotebookRevision,
  getNotebookRevisionServer,
  invalidateNotebooks,
  subscribeNotebooks,
} from "@/lib/notebooks-store";
import { cn } from "cn";

/**
 * Notebook list for the sidebar.
 *
 * Shows every notebook in the workspace with a real source count
 * ("2 of 3 sources included"), and hosts creation and deletion. Counts come
 * from `notebook_sources`, never from the document list — a document that is
 * not a source of this notebook must not appear to be one.
 */

type State =
  | { kind: "loading" }
  | { kind: "ready"; items: NotebookSummary[] }
  | { kind: "error"; error: ApiError };

export function NotebookList() {
  const { activeWorkspace, user } = useSession();
  const router = useRouter();
  const revision = useSyncExternalStore(
    subscribeNotebooks,
    getNotebookRevision,
    getNotebookRevisionServer,
  );
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<NotebookRow | null>(null);

  useEffect(() => {
    if (!activeWorkspace) return;
    let cancelled = false;
    (async () => {
      try {
        const items = await listNotebookSummaries(activeWorkspace.tenantId);
        if (!cancelled) setState({ kind: "ready", items });
      } catch (error) {
        if (!cancelled) setState({ kind: "error", error: normalizeApiError(error, "notebooks") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace, reloadToken, revision]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setReloadToken((n) => n + 1);
  }, []);

  async function handleCreate(name: string) {
    if (!activeWorkspace) return;
    const notebook = await createNotebook(activeWorkspace.tenantId, name, user?.id ?? null);
    invalidateNotebooks();
    setCreating(false);
    router.push(`/notebooks/${notebook.id}`);
  }

  return (
    <div className="min-h-0">
      <div className="flex items-center justify-between px-1.5 pb-2">
        <p className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">Spaces</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label="New space"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3" aria-hidden="true" />
        </Button>
      </div>

      {state.kind === "loading" ? (
        <div className="space-y-1.5 px-1.5" aria-busy="true">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-4/5" />
          <span className="sr-only" role="status">
            Loading spaces
          </span>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="hairline rounded-lg border border-dashed px-3 py-3">
          <p className="text-muted-foreground text-2xs">{state.error.userMessage}</p>
          <Button variant="ghost" size="xs" onClick={retry} className="text-muted-foreground mt-2 gap-1.5 px-0">
            <RotateCcw className="size-3" aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}

      {state.kind === "ready" && state.items.length === 0 ? (
        <div className="hairline rounded-lg border border-dashed px-3 py-4">
          <p className="text-muted-foreground text-2xs">No spaces yet</p>
          <p className="text-muted-foreground/70 mt-1 text-2xs text-pretty">
            A space is a knowledge set: you choose which documents it may answer from.
          </p>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setCreating(true)}
            className="text-muted-foreground mt-2 gap-1.5 px-0"
          >
            <Plus className="size-3" aria-hidden="true" />
            New space
          </Button>
        </div>
      ) : null}

      {state.kind === "ready" && state.items.length > 0 ? (
        <ul className="space-y-0.5">
          {state.items.map(({ notebook, sources, selected }) => (
            <li key={notebook.id}>
              <Link
                href={`/notebooks/${notebook.id}`}
                className={cn(
                  "group/notebook block rounded-md px-1.5 py-1.5 transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:ring-ring/50 outline-none focus-visible:ring-2 hover:bg-accent/60",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <Boxes className="text-muted-foreground/70 size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{notebook.name}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Options for ${notebook.name}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        className="opacity-0 group-hover/notebook:opacity-100 focus-visible:opacity-100"
                      >
                        <EllipsisIcon className="size-3" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" onSelect={() => setPendingDelete(notebook)}>
                        <Trash2 aria-hidden="true" />
                        Delete space
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
                <span className="text-muted-foreground/70 mt-0.5 block pl-5 text-2xs">
                  {sources === 0
                    ? "No sources · add documents"
                    : `${selected} of ${sources} source${sources === 1 ? "" : "s"} included`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <CreateNotebookDialog open={creating} onOpenChange={setCreating} onCreate={handleCreate} />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The space is removed and stops answering questions. Its documents stay in the
              workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) void deleteNotebook(target.id).then(() => invalidateNotebooks());
              }}
            >
              Delete space
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function CreateNotebookDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name);
      setName("");
    } catch (err) {
      setError(normalizeApiError(err, "notebooks").userMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName("");
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a space</DialogTitle>
          <DialogDescription>
            A space keeps its own sources. You decide which of them each answer may use.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="notebook-name">Name</Label>
            <Input
              id="notebook-name"
              value={name}
              autoFocus
              maxLength={120}
              placeholder="e.g. FY 2026 income tax"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={!name.trim() || busy}>
              {busy ? "Creating…" : "Create space"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
