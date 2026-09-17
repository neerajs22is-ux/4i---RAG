"use client";

import { Boxes, EllipsisIcon, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { useSession } from "@/components/providers/session-provider";
import { CreateNotebookDialog } from "@/components/notebooks/notebook-list";
import { ErrorState } from "@/components/foundation/data-states";
import { EmptyState, PageFrame, PageHeader } from "@/components/foundation/page-frame";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { relativeTime } from "@/lib/format";

/**
 * Spaces page.
 *
 * The browse surface for knowledge sets: what each space is, how many of its
 * sources are included in answers, and when it last changed. The sidebar keeps
 * the compact list; this page is where the concept is explained.
 */
export function NotebooksView() {
  const { activeWorkspace, user } = useSession();
  const router = useRouter();
  const revision = useSyncExternalStore(
    subscribeNotebooks,
    getNotebookRevision,
    getNotebookRevisionServer,
  );
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; items: NotebookSummary[] }
    | { kind: "error"; error: ApiError }
  >({ kind: "loading" });
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

  return (
    <PageFrame width="wide">
      <PageHeader
        eyebrow="Workspace"
        title="Spaces"
        description="A space is a knowledge set. You choose which documents it may answer from, and every answer shows the sources it used."
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden="true" />
            New space
          </Button>
        }
      />

      <div className="mt-8">
        {state.kind === "loading" ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map((key) => (
              <div key={key} className="hairline rounded-xl border p-5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="mt-3 h-3 w-1/2" />
              </div>
            ))}
            <span className="sr-only" role="status">
              Loading spaces
            </span>
          </div>
        ) : null}

        {state.kind === "error" ? (
          <ErrorState title="Spaces could not be loaded" error={state.error} onRetry={retry} />
        ) : null}

        {state.kind === "ready" && state.items.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="No spaces yet"
            description="Create a space to keep a focused set of sources — for example one tax year, one contract set, or one project — and ask questions that can only use those."
          >
            <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" aria-hidden="true" />
              Create your first space
            </Button>
          </EmptyState>
        ) : null}

        {state.kind === "ready" && state.items.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {state.items.map(({ notebook, sources, selected }) => (
              <li key={notebook.id}>
                <div className="group/notebook-card bg-card hairline flex h-full flex-col rounded-xl border transition-shadow duration-[var(--duration-fast)] hover:shadow-sm">
                  <Link
                    href={`/notebooks/${notebook.id}`}
                    className="focus-visible:ring-ring/50 flex min-w-0 flex-1 flex-col rounded-xl p-5 outline-none focus-visible:ring-2"
                  >
                    <div className="flex items-start gap-2">
                      <Boxes className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <h2 className="min-w-0 flex-1 text-sm font-medium break-words">{notebook.name}</h2>
                    </div>
                    <p className="text-muted-foreground mt-3 text-xs">
                      {sources === 0 ? (
                        "No sources yet"
                      ) : (
                        <>
                          <span className="text-foreground font-medium">{selected}</span> of {sources}{" "}
                          source{sources === 1 ? "" : "s"} included in answers
                        </>
                      )}
                    </p>
                    <p className="text-muted-foreground/70 mt-1 text-2xs">
                      Updated {relativeTime(notebook.updated_at)}
                    </p>
                  </Link>
                  <div className="flex items-center justify-end px-3 pb-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Options for ${notebook.name}`}
                          className="text-muted-foreground opacity-0 group-hover/notebook-card:opacity-100 focus-visible:opacity-100"
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
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <CreateNotebookDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={async (name) => {
          if (!activeWorkspace) return;
          const notebook = await createNotebook(activeWorkspace.tenantId, name, user?.id ?? null);
          invalidateNotebooks();
          setCreating(false);
          router.push(`/notebooks/${notebook.id}`);
        }}
      />

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
    </PageFrame>
  );
}
