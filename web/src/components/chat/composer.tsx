"use client";

import { ArrowUp, LoaderCircle, Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "cn";

/**
 * Composer.
 *
 * Deliberately plain: a growing textarea, Enter to send, Shift+Enter for a new
 * line, a locked state while a request is in flight, and a visible count as the
 * question approaches the backend's 1000-character limit.
 *
 * There is no Stop button. `/ask` is non-streaming and persists its answer
 * before responding, so cancelling the browser request would leave the server
 * finishing and storing an answer the user believes they cancelled — an
 * accepted honesty constraint, not an oversight (see the pass report).
 */

const MAX_QUERY = 1000;
const MAX_HEIGHT_PX = 200;

export function Composer({
  onSubmit,
  busy,
  disabled,
  disabledReason,
  autoFocus = true,
  focusToken = 0,
  attach,
}: {
  onSubmit: (query: string) => void;
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  autoFocus?: boolean;
  /**
   * Increment to move focus into the textarea from outside the composer
   * (the chat surface uses this for the `/` shortcut). Never a request to
   * send or to change the draft — focus only.
   */
  focusToken?: number;
  /**
   * Optional leading control — the conversation-files attach button. The host
   * owns the action; the composer only renders and labels it.
   */
  attach?: { onClick: () => void; disabled?: boolean; label: string };
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with content, up to a bound. A DOM write in an effect (not state).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  // `/` shortcut target: focus without touching the draft or scroll position.
  useEffect(() => {
    if (focusToken === 0) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [focusToken]);

  const trimmed = value.trim();
  const overLimit = value.length > MAX_QUERY;
  const canSend = !busy && !disabled && trimmed.length > 0 && !overLimit;

  function submit() {
    if (!canSend) return;
    onSubmit(trimmed);
    setValue("");
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  const locked = busy || disabled;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="w-full"
    >
      <div
        className={cn(
          "bg-card hairline focus-within:border-ring/60 rounded-xl border p-2 shadow-sm transition-colors duration-[var(--duration-normal)]",
          locked && "opacity-90",
        )}
      >
        <label htmlFor="composer-input" className="sr-only">
          {disabledReason ?? "Ask a question about your documents"}
        </label>
        <textarea
          id="composer-input"
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          enterKeyHint="send"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled
              ? (disabledReason ?? "Unavailable")
              : "Ask a question about your documents…"
          }
          aria-describedby="composer-help"
          className="placeholder:text-muted-foreground/70 max-h-[200px] w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none disabled:cursor-not-allowed"
        />

        <div className="flex items-center gap-2 px-1 pt-1">
          {attach ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={attach.label}
                  disabled={attach.disabled}
                  onClick={attach.onClick}
                  className="shrink-0 rounded-lg"
                >
                  <Paperclip className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{attach.label}</TooltipContent>
            </Tooltip>
          ) : null}

          <p id="composer-help" className="text-muted-foreground text-2xs">
            <kbd className="font-mono">Enter</kbd> to send ·{" "}
            <kbd className="font-mono">Shift</kbd>+
            <kbd className="font-mono">Enter</kbd> for a new line
            <span className="hidden sm:inline">
              {" "}
              · <kbd className="font-mono">/</kbd> to focus
            </span>
          </p>

          {value.length > MAX_QUERY * 0.8 ? (
            <p
              className={cn(
                "ml-auto font-mono text-2xs",
                overLimit ? "text-destructive" : "text-muted-foreground",
              )}
              aria-live="polite"
            >
              {value.length}/{MAX_QUERY}
            </p>
          ) : null}

          <Button
            type="submit"
            size="icon-sm"
            disabled={!canSend}
            aria-label={busy ? "Answering" : "Send question"}
            className="ml-auto rounded-lg"
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUp className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}
