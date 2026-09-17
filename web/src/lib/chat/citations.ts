import type { AskCitation } from "@/lib/api/types";

/**
 * Citation helpers.
 *
 * The backend returns citation *metadata* only — `n`, `chunk_id`,
 * `document_id`, `file_name`, `page`, `fused_rank`, `fused_score`. It does not
 * return passage text, so nothing here may imply that a passage was found or
 * graded: we surface exactly what exists and say so.
 *
 * Model output writes citations as `[S1]`, `[S2]`, … . They are rewritten into
 * markdown links (`[S1](#cite-1)`) so react-markdown renders them as real,
 * focusable anchors with an accessible name; the `a` renderer then swaps in the
 * citation UI. Rewriting is skipped inside fenced code blocks, where `[S1]` may
 * legitimately appear as data.
 */

const FENCE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const MARKER_RE = /\[S(\d+)\]/g;

export function linkifyCitations(markdown: string): string {
  const text = String(markdown ?? "");
  return text
    .split(FENCE_RE)
    .map((chunk, index) => {
      // Odd segments are the captured fenced blocks — leave them untouched.
      if (index % 2 === 1) return chunk;
      return chunk.replace(MARKER_RE, "[S$1](#cite-$1)");
    })
    .join("");
}

export function citationIndex(
  citations: AskCitation[],
): Map<number, AskCitation> {
  const map = new Map<number, AskCitation>();
  for (const citation of citations) map.set(citation.n, citation);
  return map;
}

/** Citations in the order they first appear in the answer text. */
export function citedOrder(answer: string, citations: AskCitation[]): AskCitation[] {
  const index = citationIndex(citations);
  const seen: number[] = [];
  const re = new RegExp(MARKER_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(answer ?? ""))) !== null) {
    const n = Number(match[1]);
    if (index.has(n) && !seen.includes(n)) seen.push(n);
  }
  for (const citation of citations) {
    if (!seen.includes(citation.n)) seen.push(citation.n);
  }
  return seen.map((n) => index.get(n)).filter((c): c is AskCitation => Boolean(c));
}

/** Short label for a citation chip / list row. */
export function citationLabel(citation: AskCitation): string {
  const page = citation.page != null ? ` p.${citation.page}` : "";
  return `${citation.file_name}${page}`;
}

/**
 * Citations grouped by the document they came from.
 *
 * One document is split into many chunks, so a list of raw citations repeats
 * the same file over and over. Grouping keeps the real provenance (every
 * supporting passage is counted, every page is listed) while presenting it the
 * way a reader thinks about sources: document → pages → passages.
 *
 * Groups appear in the order their first citation appears in the answer.
 */
export type DocumentSourceGroup = {
  documentId: string | null;
  fileName: string;
  /** Unique pages, ascending. Empty when the backend reported no page. */
  pages: number[];
  /** Citation markers (`n`) that belong to this document, in answer order. */
  markers: number[];
  /** Number of supporting passages (= citations) from this document. */
  passages: number;
};

export function groupCitationsByDocument(
  citations: AskCitation[],
): DocumentSourceGroup[] {
  const groups: DocumentSourceGroup[] = [];
  const byKey = new Map<string, DocumentSourceGroup>();

  for (const citation of citations) {
    const key = citation.document_id ?? `file:${citation.file_name}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        documentId: citation.document_id ?? null,
        fileName: citation.file_name,
        pages: [],
        markers: [],
        passages: 0,
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.passages += 1;
    group.markers.push(citation.n);
    if (citation.page != null && !group.pages.includes(citation.page)) {
      group.pages.push(citation.page);
    }
  }

  for (const group of groups) group.pages.sort((a, b) => a - b);
  return groups;
}

/** "Pages 1, 3, 5" — with an explicit tail when a document spans many pages. */
export function formatPageList(pages: number[], max = 8): string {
  if (pages.length === 0) return "No page reported";
  const shown = pages.slice(0, max).join(", ");
  const rest = pages.length - max;
  return rest > 0 ? `Pages ${shown} … +${rest} more` : `Pages ${shown}`;
}

export function formatPassageCount(count: number): string {
  return `${count} supporting ${count === 1 ? "passage" : "passages"}`;
}
