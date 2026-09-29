"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  FileText,
  LayersIcon,
  MessageSquareText,
  Plus,
  Quote,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { AssistantMessage } from "@/components/chat/assistant-message";
import { Composer } from "@/components/chat/composer";
import { ConversationFiles } from "@/components/chat/conversation-files";
import { RequestStatus } from "@/components/chat/request-status";
import { UserMessage } from "@/components/chat/user-message";
import { ErrorState, LoadingState } from "@/components/foundation/data-states";
import { evidenceStateConfig } from "@/components/foundation/evidence-status";
import { Stagger, StaggerItem } from "@/components/motion/primitives";
import { useSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import { ask } from "@/lib/api/client";
import { createConversation } from "@/lib/api/conversations";
import { ApiError, normalizeApiError, type ApiErrorKind } from "@/lib/api/errors";
import type { MessageRow } from "@/lib/api/types";
import { listMessages } from "@/lib/api/conversations";
import { viewFromResponse, viewFromStored, type AnswerView } from "@/lib/chat/answer-view";
import {
  setPendingAnnouncement,
  takePendingAnnouncement,
} from "@/lib/chat/announcement";
import { invalidateConversations } from "@/lib/chat/conversations-store";
import { recordAskOutcome } from "@/lib/health";
import { DURATION, EASE } from "@/lib/motion";

/**
 * Chat surface.
 *
 * The whole exchange runs through the Pass 3A API client: the caller's session
 * JWT goes to the real `/ask`, and the answer, label, citations and timings
 * that come back are rendered as they are. Nothing is mocked, no stage is
 * invented, and the browser never contacts a model provider directly.
 *
 * New questions start at `/` (no conversation id). The first successful answer
 * returns a conversation id, so the URL is replaced with `/c/<id>` — a reload
 * then shows the persisted transcript instead of an empty page.
 *
 * Polish (Pass E): the empty state inside a notebook reports the real source
 * scope and routes to the sources panel when nothing is included; the
 * transcript can jump back to the latest content after scrolling up; answer
 * citation markers navigate directly to their supporting passage and back;
 * `/` focuses the composer. None of this adds backend behaviour or invents progress.
 */

type ChatItem =
  | { kind: "user"; id: string; content: string; entrance?: boolean }
  | { kind: "answer"; id: string; view: AnswerView; entrance?: boolean }
  | { kind: "pending"; id: string; startedAt: number }
  | {
      kind: "error";
      id: string;
      question: string;
      message: string;
      kindOf: ApiErrorKind;
    };

const PRINCIPLES = [
  {
    icon: ShieldCheck,
    title: "Answers from your documents",
    body: "Questions are answered only from the documents in this workspace. If those documents do not cover a question, the answer says so instead of guessing.",
  },
  {
    icon: Quote,
    title: "Trace every claim to its source",
    body: "Each citation names the document, page and retrieval rank it came from. Select a number in the answer to see its supporting source.",
  },
  {
    icon: FileText,
    title: "Gaps and disagreements are flagged",
    body: "When sources partly cover a question, disagree, or numbers and dates do not line up, the answer is labelled and the caution is shown.",
  },
];

function pendingId() {
  return `pending-${Date.now()}`;
}

/** Short, honest screen-reader announcement when an answer arrives. */
function answerAnnouncement(view: AnswerView): string {
  if (view.label === "clarification") {
    return "Answer ready. The question needed a little more detail before retrieval.";
  }
  const config = view.state ? evidenceStateConfig(view.state) : null;
  const base = config ? `Answer ready. ${config.label}.` : "Answer ready.";
  const cited = view.citations.length;
  if (cited === 0) return base;
  return `${base} ${cited} ${cited === 1 ? "source" : "sources"} cited.`;
}

export function ChatView({
  conversationId,
  notebookId,
  scopeLabel,
  scopeCounts,
  onOpenSources,
}: {
  conversationId?: string;
  /**
   * Notebook scope. The id is sent to `/ask`; the backend resolves the allowed
   * document set (B2/D50). `scopeLabel` is display-only text the host already
   * derived from real source state.
   */
  notebookId?: string;
  scopeLabel?: string;
  /**
   * Real source counts for the notebook empty state. Undefined outside a
   * notebook (or before the host has loaded them) — the surface then shows the
   * generic empty state rather than a guessed number.
   */
  scopeCounts?: { selected: number; total: number };
  /** Opens the sources panel on narrow screens. */
  onOpenSources?: () => void;
}) {
  const { activeWorkspace, user } = useSession();
  const router = useRouter();
  const prefersReducedMotion = useReducedMotion();

  const [items, setItems] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [activeId, setActiveId] = useState<string | null>(conversationId ?? null);
  const [reloadToken, setReloadToken] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [focusToken, setFocusToken] = useState(0);
  const [filesOpen, setFilesOpen] = useState(false);

  /**
   * Mirror of `activeId` readable synchronously. A temporary file can create a
   * conversation before the first question, so two async flows (attach and
   * ask) may need the id in the same tick; the ref prevents a second
   * conversation from being created out of a stale closure.
   */
  const activeIdRef = useRef<string | null>(conversationId ?? null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  /**
   * Resolve the conversation for a temporary-file registration, creating it on
   * first use. The row is created under RLS; `/ask` appends to it exactly as
   * it does to a conversation it created itself.
   */
  const ensureConversation = useCallback(
    async (title: string): Promise<string> => {
      if (activeIdRef.current) return activeIdRef.current;
      if (!activeWorkspace || !user) {
        throw new ApiError("authorization", { source: "conversations" });
      }
      const id = await createConversation(activeWorkspace.tenantId, user.id, title);
      activeIdRef.current = id;
      setActiveId(id);
      invalidateConversations();
      return id;
    },
    [activeWorkspace, user],
  );

  // Transcript load. The page keys this component by conversation id, so a
  // switch between conversations mounts a fresh instance; the effect therefore
  // only ever performs the initial read, and every state update it makes is
  // inside an async callback.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    listMessages(conversationId)
      .then((rows: MessageRow[]) => {
        if (cancelled) return;
        setItems(
          rows.map((row) =>
            row.role === "user"
              ? { kind: "user" as const, id: row.id, content: row.content }
              : { kind: "answer" as const, id: row.id, view: viewFromStored(row) },
          ),
        );
        // A just-finished first answer handed its announcement across the
        // `/` → `/c/<id>` mount (see lib/chat/announcement.ts).
        const pending = takePendingAnnouncement();
        if (pending) setAnnouncement(pending);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(normalizeApiError(error, "messages"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, reloadToken]);

  /* ------------------------------------------------------------ scrolling */

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinnedRef.current = next;
    setPinned((prev) => (prev === next ? prev : next));
  }, []);

  const jumpToLatest = useCallback(() => {
    pinnedRef.current = true;
    setPinned(true);
    const el = scrollerRef.current;
    if (el) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });
    }
  }, [prefersReducedMotion]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  /* ------------------------------------------------------------ shortcuts */

  // `/` focuses the composer. It must never steal a keystroke from a field or
  // from an open layer (dialog, menu, popover, select).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      setFocusToken((n) => n + 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /* -------------------------------------------------------------- sending */

  const sending = items.some((item) => item.kind === "pending");

  const send = useCallback(
    async (question: string) => {
      if (!activeWorkspace) return;
      const pending = pendingId();
      pinnedRef.current = true;
      setPinned(true);
      setAnnouncement("");
      setItems((prev) => [
        ...prev,
        { kind: "user", id: `${pending}-q`, content: question, entrance: true },
        { kind: "pending", id: pending, startedAt: Date.now() },
      ]);

      try {
        const response = await ask({
          tenantId: activeWorkspace.tenantId,
          query: question,
          conversationId: activeIdRef.current,
          notebookId: notebookId ?? null,
        });
        const view = viewFromResponse(response);
        setItems((prev) => {
          const next = prev.filter((item) => item.id !== pending);
          next.push({
            kind: "answer",
            id: response.conversation_id ? `${pending}-a` : pending + "-a",
            view,
            entrance: true,
          });
          return next;
        });
        const announcement = answerAnnouncement(view);
        invalidateConversations();
        recordAskOutcome(true);
        if (response.conversation_id) {
          activeIdRef.current = response.conversation_id;
          setActiveId(response.conversation_id);
        }
        if (!conversationId && response.conversation_id) {
          // First answer in a new conversation: move the URL onto the stored
          // transcript. The conversation may already exist because a temporary
          // file was attached first; the backend returns the same id. Inside a
          // notebook we do NOT move to /c/<id>: the notebook is the workspace,
          // and a notebook conversation is scoped per request (conversations
          // carry no notebook id in the database).
          if (!notebookId) {
            // Persistence completes before the response, so the reloaded
            // transcript on /c/<id> is the same content, now read from the store.
            // The remount would drop the announcement, so hand it over.
            setPendingAnnouncement(announcement);
            router.replace(`/c/${response.conversation_id}`, { scroll: false });
          } else {
            setAnnouncement(announcement);
          }
        } else {
          setAnnouncement(announcement);
        }
      } catch (error) {
        const normalized = normalizeApiError(error, "ask");
        recordAskOutcome(false, normalized.kind);
        setItems((prev) => {
          const next = prev.filter((item) => item.id !== pending);
          next.push({
            kind: "error",
            id: `${pending}-e`,
            question,
            message: normalized.userMessage,
            kindOf: normalized.kind,
          });
          return next;
        });
      }
    },
    [activeWorkspace, conversationId, router, notebookId],
  );

  function retry(item: Extract<ChatItem, { kind: "error" }>) {
    setItems((prev) => prev.filter((entry) => entry.id !== item.id));
    void send(item.question);
  }

  /* ----------------------------------------------------------------- views */

  const composerDisabled = !activeWorkspace;
  const showJump = !pinned && items.length > 0;
  // Inside a notebook the workspace header already carries the page's h1;
  // the empty-state heading steps down so the page keeps one top-level heading.
  const EmptyHeading = notebookId ? "h2" : "h1";

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollerRef}
          onScroll={handleScroll}
          data-chat-scroll=""
          className="h-full overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8">
            {loading ? <LoadingState label="Loading conversation" /> : null}

            {loadError ? (
              <ErrorState
                error={loadError}
                title="Could not load this conversation"
                onRetry={() => {
                  setReloadToken((n) => n + 1);
                }}
              />
            ) : null}

            {!loading && !loadError && items.length === 0 ? (
              <div className="py-6">
                <span className="bg-primary text-primary-foreground text-2xs inline-flex size-8 items-center justify-center rounded-lg font-semibold">
                  4i
                </span>
                <EmptyHeading className="mt-4 text-lg font-semibold tracking-tight">
                  {notebookId ? "Ask this space" : "Ask your documents"}
                </EmptyHeading>
                <p className="text-muted-foreground mt-2 max-w-lg text-sm text-pretty">
                  {notebookId
                    ? "Answers use only the sources you included in this space, with the supporting evidence."
                    : "Questions are answered only from the documents in this workspace, with the supporting evidence."}
                </p>

                {notebookId ? (
                  <NotebookFirstQuestion
                    counts={scopeCounts}
                    onOpenSources={onOpenSources}
                  />
                ) : (
                  <>
                    <Stagger className="mt-8 grid gap-3 sm:grid-cols-3">
                      {PRINCIPLES.map((principle) => {
                        const Icon = principle.icon;
                        return (
                          <StaggerItem
                            key={principle.title}
                            className="rounded-xl border border-border bg-card p-4 shadow-sm"
                          >
                            <span className="bg-primary/10 text-primary inline-flex size-7 items-center justify-center rounded-lg">
                              <Icon className="size-4" aria-hidden="true" />
                            </span>
                            <h2 className="text-foreground mt-3 text-sm font-semibold">
                              {principle.title}
                            </h2>
                            <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed text-pretty">
                              {principle.body}
                            </p>
                          </StaggerItem>
                        );
                      })}
                    </Stagger>

                    <div className="hairline mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-dashed px-4 py-3">
                      <MessageSquareText
                        className="text-muted-foreground size-3.5"
                        aria-hidden="true"
                      />
                      <p className="text-muted-foreground text-2xs">
                        Answers appear here, with their grounding state and sources.
                      </p>
                      <Button asChild variant="ghost" size="xs" className="ml-auto gap-1.5">
                        <Link href="/documents">
                          See what is searchable
                          <ArrowRight className="size-3" aria-hidden="true" />
                        </Link>
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {!loading && !loadError && items.length > 0 ? (
              <ol className="space-y-7">
                {items.map((item) => (
                  <li key={item.id}>
                    {item.kind === "user" ? (
                      <UserMessage content={item.content} entrance={item.entrance} />
                    ) : null}

                    {item.kind === "answer" ? (
                      <AssistantMessage
                        view={item.view}
                        entrance={item.entrance}
                        scope={item.id}
                      />
                    ) : null}

                    {item.kind === "pending" ? (
                      <RequestStatus startedAt={item.startedAt} />
                    ) : null}

                    {item.kind === "error" ? (
                      <div
                        role="alert"
                        className="bg-card hairline flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
                      >
                        <p className="min-w-0 flex-1 text-sm text-pretty">
                          {item.message}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => retry(item)}
                          className="gap-1.5"
                        >
                          <RotateCcw className="size-3.5" aria-hidden="true" />
                          Send again
                        </Button>
                        <p className="text-muted-foreground/70 w-full text-2xs text-pretty">
                          Sending again may add a second entry if the request did
                          reach the service.
                        </p>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}

            <p className="sr-only" role="status" aria-live="polite">
              {announcement}
            </p>
          </div>
        </div>

        <AnimatePresence>
          {showJump ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: DURATION.fast, ease: EASE.decelerate }}
              className="absolute right-4 bottom-4 z-10 sm:right-6"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={jumpToLatest}
                aria-label="Jump to latest"
                className="bg-card gap-1.5 rounded-full shadow-md"
              >
                <ArrowDown className="size-3.5" aria-hidden="true" />
                Jump to latest
              </Button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="bg-background/85 hairline shrink-0 border-t backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-5 py-4 sm:px-8">
          {notebookId ? (
            <div className="mb-2.5 flex min-w-0 items-center gap-2">
              <LayersIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
              <p className="text-muted-foreground min-w-0 flex-1 truncate text-2xs">
                Answering from <span className="text-foreground font-medium">{scopeLabel}</span>
              </p>
              {onOpenSources ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0 gap-1 px-1.5 lg:hidden"
                  onClick={onOpenSources}
                >
                  Sources
                </Button>
              ) : null}
            </div>
          ) : null}
          <ConversationFiles
            tenantId={activeWorkspace?.tenantId ?? ""}
            conversationId={activeId}
            ensureConversation={ensureConversation}
            notebookId={notebookId}
            open={filesOpen}
            onOpenChange={setFilesOpen}
          />
          <Composer
            onSubmit={send}
            busy={sending}
            disabled={composerDisabled}
            focusToken={focusToken}
            disabledReason={
              composerDisabled ? "No workspace is available" : undefined
            }
            autoFocus={items.length === 0}
            attach={{
              onClick: () => setFilesOpen(true),
              disabled: composerDisabled,
              label: "Add a temporary file to this conversation (removed after 24 hours)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * First-question affordances inside a space.
 *
 * The host supplies the real source counts. Three honest cases:
 *  - no sources yet → add documents (the space cannot answer at all);
 *  - sources exist but none included → explain the deterministic refusal and
 *    route to the sources panel;
 *  - sources included → state the scope and what the answer will carry.
 *
 * No example questions are offered: the backend generates none, and any sample
 * would imply corpus content the workspace may not have.
 */
function NotebookFirstQuestion({
  counts,
  onOpenSources,
}: {
  counts?: { selected: number; total: number };
  onOpenSources?: () => void;
}) {
  if (!counts) return null;
  const { selected, total } = counts;

  if (total === 0) {
    return (
      <div className="hairline mt-6 max-w-lg rounded-xl border border-dashed px-4 py-4">
        <p className="text-sm font-medium">This space has no sources yet</p>
        <p className="text-muted-foreground mt-1 text-xs text-pretty">
          Add documents, then choose which of them answers may use. Questions
          asked before that are refused — nothing is invented to fill the gap.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="gap-1.5 lg:hidden"
            onClick={onOpenSources}
            disabled={!onOpenSources}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add documents
          </Button>
          <p className="text-muted-foreground hidden text-xs lg:block">
            Add documents in the Sources panel on the left.
          </p>
          <Button asChild variant="ghost" size="sm">
            <Link href="/documents">Manage documents</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (selected === 0) {
    return (
      <div className="bg-warning-muted/60 border-warning/25 mt-6 max-w-lg rounded-xl border px-4 py-4">
        <p className="text-warning flex items-start gap-2 text-sm font-medium">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          No sources are included
        </p>
        <p className="text-foreground/80 mt-1.5 text-xs text-pretty">
          This space has {total} {total === 1 ? "source" : "sources"}, but none
          are included in answers, so questions are refused. Include at least one
          to ask.
        </p>
        <Button
          size="sm"
          className="mt-3 gap-1.5 lg:hidden"
          onClick={onOpenSources}
          disabled={!onOpenSources}
        >
          <LayersIcon className="size-3.5" aria-hidden="true" />
          Include sources
        </Button>
        <p className="text-muted-foreground mt-3 hidden text-xs lg:block">
          Include at least one in the Sources panel on the left.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 max-w-lg">
      <div className="hairline flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3">
        <LayersIcon
          className="text-muted-foreground size-3.5 shrink-0"
          aria-hidden="true"
        />
        <p className="text-muted-foreground min-w-0 flex-1 text-2xs">
          Answering from{" "}
          <span className="text-foreground font-medium">
            {selected} of {total} {total === 1 ? "source" : "sources"} included
          </span>
        </p>
        {onOpenSources ? (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 lg:hidden"
            onClick={onOpenSources}
          >
            Review sources
          </Button>
        ) : null}
      </div>

      <Stagger className="mt-4 space-y-3" stagger={0.05}>
        {[
          {
            icon: ShieldCheck,
            title: "Only this space is used",
            body: "Answers use only the sources you included here. Nothing outside this space contributes.",
          },
          {
            icon: Quote,
            title: "Trace every claim to its source",
            body: "Each citation names the document, page and retrieval rank. Select a number in the answer to see its supporting source.",
          },
          {
            icon: FileText,
            title: "Gaps are stated, not filled",
            body: "When the included sources do not cover a question, the answer says so instead of guessing.",
          },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <StaggerItem key={item.title} className="flex items-start gap-2.5">
              <Icon className="text-primary mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs font-medium">{item.title}</p>
                <p className="text-muted-foreground mt-0.5 text-2xs text-pretty">
                  {item.body}
                </p>
              </div>
            </StaggerItem>
          );
        })}
      </Stagger>
    </div>
  );
}
