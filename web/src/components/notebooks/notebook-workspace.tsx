"use client";

import { Boxes, LayersIcon, PencilIcon, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";

import { ChatView } from "@/components/chat/chat-view";
import { SourcesPanel } from "@/components/notebooks/sources-panel";
import { ConversationList } from "@/components/shell/conversation-list";
import { ErrorState, LoadingState } from "@/components/foundation/data-states";
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
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useSession } from "@/components/providers/session-provider";
import { ApiError, normalizeApiError } from "@/lib/api/errors";
import {
  deleteNotebook,
  getNotebook,
  listNotebookSources,
  renameNotebook,
} from "@/lib/api/notebooks";
import type { NotebookRow } from "@/lib/api/types";
import {
  getNotebookRevision,
  getNotebookRevisionServer,
  invalidateNotebooks,
  subscribeNotebooks,
} from "@/lib/notebooks-store";

/**
 * Notebook workspace.
 *
 * Two panes on desktop: the notebook's sources on the left, the conversation on
 * the right. On narrow screens the source pane becomes a bottom sheet, opened
 * from the header — the chat keeps the full width and the source boundary stays
 * one tap away.
 *
 * The scope shown here is a promise the backend keeps: the chat sends
 * `notebook_id`, and retrieval is restricted to this notebook's selected,
 * non-archived documents (B2/D50). Nothing on this screen filters results.
 */
export function NotebookWorkspace({ notebookId }: { notebookId: string }) {
  const { activeWorkspace } = useSession();
  const router = useRouter();
  const revision = useSyncExternalStore(
    subscribeNotebooks,
    getNotebookRevision,
    getNotebookRevisionServer,
  );
  const [notebook, setNotebook] = useState<NotebookRow | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [counts, setCounts] = useState({ total: 0, selected: 0 });
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /**
   * Fetch-only helper: reads the notebook and its sources and returns them.
   * State is applied by the caller so no effect body sets state synchronously.
   */
  const load = useCallback(async () => {
    if (!activeWorkspace) return null;
    const found = await getNotebook(activeWorkspace.tenantId, notebookId);
    if (!found) return { found: null, sources: [] };
    const sources = await listNotebookSources(activeWorkspace.tenantId, notebookId);
    return { found, sources };
  }, [activeWorkspace, notebookId]);

  const apply = useCallback((result: Awaited<ReturnType<typeof load>>) => {
    if (result === null) return;
    if (!result.found) {
      setStatus("missing");
      return;
    }
    setNotebook(result.found);
    setCounts({
      total: result.sources.length,
      selected: result.sources.filter((source) => source.selected).length,
    });
    setStatus("ready");
  }, []);

  const fail = useCallback((err: unknown) => {
    setError(normalizeApiError(err, "notebooks"));
    setStatus("error");
  }, []);

  const refresh = useCallback(() => {
    load().then(apply).catch(fail);
  }, [load, apply, fail]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((result) => {
        if (!cancelled) apply(result);
      })
      .catch((err) => {
        if (!cancelled) fail(err);
      });
    return () => {
      cancelled = true;
    };
  }, [load, apply, fail, revision]);

  if (status === "loading") {
    return <LoadingState label="Loading space" />;
  }

  if (status === "missing") {
    return (
      <div className="p-6">
        <ErrorState
          title="Space not found"
          error={
            new ApiError("not-found", {
              source: "notebooks",
            })
          }
          onRetry={() => router.push("/notebooks")}
        />
      </div>
    );
  }

  if (status === "error" && error) {
    return (
      <div className="p-6">
        <ErrorState title="Space could not be loaded" error={error} onRetry={() => void refresh()} />
      </div>
    );
  }

  const scopeLabel =
    counts.total === 0
      ? "No sources yet"
      : counts.selected === 0
        ? "No sources included"
        : `${counts.selected} of ${counts.total} source${counts.total === 1 ? "" : "s"} included`;

  return (
    <div className="flex h-full min-h-0">
      <aside className="hairline hidden w-80 shrink-0 flex-col border-r lg:flex">
        <SourcesPanel
          tenantId={activeWorkspace?.tenantId ?? ""}
          notebookId={notebookId}
          onChanged={() => void refresh()}
          className="min-h-0 flex-1"
        />
        <Separator />
        <div className="max-h-64 shrink-0 overflow-y-auto px-2 py-3">
          <p className="text-muted-foreground px-1.5 pb-2 text-2xs font-medium tracking-wide uppercase">
            Workspace conversations
          </p>
          <ConversationList />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="hairline flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-5">
          <Boxes className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">{notebook?.name}</h1>
            <p className="text-muted-foreground truncate text-2xs">{scopeLabel}</p>
          </div>
          <Button
            variant="outline"
            size="xs"
            className="gap-1.5 lg:hidden"
            onClick={() => setSourcesOpen(true)}
          >
            <LayersIcon className="size-3" aria-hidden="true" />
            Sources
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Space options">
                <PencilIcon className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <PencilIcon aria-hidden="true" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden="true" />
                Delete space
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <div className="min-h-0 flex-1">
          <ChatView
            key={notebookId}
            notebookId={notebookId}
            scopeLabel={scopeLabel}
            scopeCounts={{ selected: counts.selected, total: counts.total }}
            onOpenSources={() => setSourcesOpen(true)}
          />
        </div>
      </div>

      <Sheet open={sourcesOpen} onOpenChange={setSourcesOpen}>
        <SheetContent side="bottom" className="h-[80dvh] gap-0 p-0" aria-label="Sources in this space">
          <SheetHeader className="sr-only">
            <SheetTitle>Sources</SheetTitle>
            <SheetDescription>Choose which documents this space may answer from.</SheetDescription>
          </SheetHeader>
          <SourcesPanel
            tenantId={activeWorkspace?.tenantId ?? ""}
            notebookId={notebookId}
            onChanged={() => void refresh()}
            className="min-h-0 flex-1"
          />
        </SheetContent>
      </Sheet>

      <RenameNotebookDialog
        open={renaming}
        onOpenChange={setRenaming}
        current={notebook?.name ?? ""}
        onRename={async (name) => {
          await renameNotebook(notebookId, name);
          invalidateNotebooks();
          setRenaming(false);
          void refresh();
        }}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{notebook?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The space is removed and stops answering questions. Its documents stay in the
              workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void deleteNotebook(notebookId).then(() => {
                  invalidateNotebooks();
                  router.push("/notebooks");
                });
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

function RenameNotebookDialog({
  open,
  onOpenChange,
  current,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  onRename: (name: string) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <RenameForm current={current} onRename={onRename} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The form is a separate component so it mounts fresh on every open: the name
 * starts from the current one without an effect that sets state on open.
 */
function RenameForm({
  current,
  onRename,
}: {
  current: string;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onRename(name);
    } catch (err) {
      setError(normalizeApiError(err, "notebooks").userMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename space</DialogTitle>
        <DialogDescription>The name is only visible to your workspace.</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="notebook-rename">Name</Label>
          <Input
            id="notebook-rename"
            value={name}
            autoFocus
            maxLength={120}
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
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
