"use client";

import {
  createContext,
  useContext,
  useMemo,
} from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

import { CitationMarker } from "@/components/chat/citation-marker";
import { AnswerReveal } from "@/components/chat/answer-reveal";
import type { AskCitation } from "@/lib/api/types";
import { citationIndex, linkifyCitations } from "@/lib/chat/citations";

/**
 * Answer rendering.
 *
 * `react-markdown` + GFM (tables, task lists, autolinks) with every element
 * mapped onto the design system — no typography plugin, so the answer surface
 * stays consistent with the rest of the product and adds no dependency beyond
 * the renderer itself.
 *
 * Content is model output, so it is treated as untrusted: raw HTML is not
 * rendered (react-markdown ignores it) and `rehype-sanitize` runs over the
 * tree. Citation markers are rewritten to in-page anchors before parsing and
 * swapped for the citation control via the `a` renderer.
 */

type CitationHighlightValue = {
  /** Marker `n` to emphasise, or null. */
  marker: number | null;
  /** Navigates directly to source row `n`. */
  onShowSource?: (n: number) => void;
};

/**
 * Give repeated citations unique link targets.
 *
 * `linkifyCitations` rewrites every `[Sn]` to `[Sn](#cite-n)`. When the same
 * citation appears several times those links would share one target id, so
 * the first keeps `#cite-n` and later mentions become `#cite-n-2`,
 * `#cite-n-3`, … . The renderer maps every variant back to citation `n`;
 * only the DOM id differs. Pure string transform — stable across renders,
 * so marker component identity (and focus) is preserved.
 */
export function withOccurrenceIds(linkified: string): string {
  const seen = new Map<number, number>();
  return String(linkified ?? "").replace(
    /\(#cite-(\d+)\)/g,
    (match, digits: string) => {
      const n = Number(digits);
      if (!Number.isFinite(n)) return match;
      const count = (seen.get(n) ?? 0) + 1;
      seen.set(n, count);
      if (count === 1) return match;
      return `(#cite-${n}-${count})`;
    },
  );
}

const CitationHighlightContext = createContext<CitationHighlightValue | null>(
  null,
);

/**
 * A stable binding between the markdown renderer and the marker component.
 *
 * The element types handed to react-markdown must keep their identity across
 * renders: a new function would make React remount the marker DOM node, which
 * would drop focus right after the reader followed a citation. Highlight state
 * therefore travels through context, and the component functions never change.
 */
function CitationMarkerBound({
  n,
  citation,
  id,
}: {
  n: number;
  citation?: AskCitation;
  id: string;
}) {
  const highlight = useContext(CitationHighlightContext);
  return (
    <CitationMarker
      n={n}
      citation={citation}
      id={id}
      highlighted={highlight?.marker === n}
      onShowSource={highlight?.onShowSource}
    />
  );
}

function buildComponents(
  citations: Map<number, AskCitation>,
  scope: string,
): Components {
  return {
    a({ href, children }) {
      if (typeof href === "string" && href.startsWith("#cite-")) {
        // `#cite-N` (first mention) or `#cite-N-K` (Kth mention of the same
        // citation — see withOccurrenceIds). Both resolve to citation `n`;
        // only the DOM id differs so repeated citations never share an id.
        const rest = href.slice("#cite-".length);
        const parts = rest.split("-");
        const n = Number(parts[0]);
        const occurrence = parts.length > 1 ? Number(parts[1]) : 1;
        if (Number.isFinite(n)) {
          const citation = citations.get(n);
          const safeOccurrence =
            Number.isFinite(occurrence) && occurrence > 1 ? occurrence : 1;
          return (
            <CitationMarkerBound
              n={n}
              citation={citation}
              id={
                safeOccurrence === 1
                  ? `marker-${scope}-${n}`
                  : `marker-${scope}-${n}-${safeOccurrence}`
              }
            />
          );
        }
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
    p: ({ children }) => (
      <p className="my-3 leading-relaxed text-pretty first:mt-1 last:mb-1">{children}</p>
    ),
    h1: ({ children }) => (
      <h3 className="mt-5 mb-2 text-lg font-semibold tracking-tight">{children}</h3>
    ),
    h2: ({ children }) => (
      <h3 className="mt-5 mb-2 text-lg font-semibold tracking-tight">{children}</h3>
    ),
    h3: ({ children }) => (
      <h4 className="mt-4 mb-1.5 text-base font-semibold">{children}</h4>
    ),
    h4: ({ children }) => (
      <h4 className="mt-4 mb-1.5 text-base font-semibold">{children}</h4>
    ),
    ul: ({ children }) => (
      <ul className="my-3 ml-4 list-disc space-y-2 marker:text-muted-foreground">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-3 ml-4 list-decimal space-y-2 marker:text-muted-foreground">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="pl-1 leading-relaxed">{children}</li>,
    strong: ({ children }) => (
      <strong className="font-semibold">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    blockquote: ({ children }) => (
      <blockquote className="border-border text-muted-foreground my-3 border-l-2 pl-3 [&>p]:my-1.5">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="border-border my-4" />,
    code({ className, children }) {
      const isBlock = typeof className === "string" && className.includes("language-");
      if (!isBlock) {
        return (
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
            {children}
          </code>
        );
      }
      return (
        <code className="font-mono text-[0.85em] whitespace-pre">{children}</code>
      );
    },
    pre: ({ children }) => (
      <pre className="bg-muted scrollbar-none my-3 overflow-x-auto rounded-lg p-3 text-xs leading-relaxed">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="scrollbar-none my-3 overflow-x-auto">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-border border-b px-2 py-1.5 text-left font-medium">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-border border-b px-2 py-1.5 align-top">{children}</td>
    ),
  };
}

export function AnswerContent({
  answer,
  citations,
  scope,
  highlightedMarker = null,
  onShowSource,
  reveal = false,
}: {
  answer: string;
  citations: AskCitation[];
  /** Unique per rendered answer — scopes marker ids and navigation targets. */
  scope: string;
  /** Marker `n` to emphasise after arriving from the source list. */
  highlightedMarker?: number | null;
  /** Navigates directly to source row `n`. */
  onShowSource?: (n: number) => void;
  /**
   * Progressive reveal for newly generated answers only. Stored transcripts
   * pass false (or omit) and render the final answer immediately.
   */
  reveal?: boolean;
}) {
  const index = useMemo(() => citationIndex(citations), [citations]);
  const markdown = useMemo(
    () => withOccurrenceIds(linkifyCitations(answer)),
    [answer],
  );
  const components = useMemo(
    () => buildComponents(index, scope),
    [index, scope],
  );
  const highlight = useMemo<CitationHighlightValue>(
    () => ({ marker: highlightedMarker, onShowSource }),
    [highlightedMarker, onShowSource],
  );

  return (
    <CitationHighlightContext.Provider value={highlight}>
      {/*
       * One quiet surface for the answer body so the question, the answer
       * and the evidence read as three distinct bands. Evidence rows and
       * actions intentionally stay chrome-less.
       */}
      <div className="bg-card hairline rounded-xl border px-4 py-3 text-base shadow-xs">
        <AnswerReveal run={reveal}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={components}
          >
            {markdown}
          </Markdown>
        </AnswerReveal>
      </div>
    </CitationHighlightContext.Provider>
  );
}
