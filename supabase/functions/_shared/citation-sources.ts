// citation-sources — citation source records with evidence excerpts.
//
// Pure function only: no I/O, no network, no Deno APIs. Runnable under
// `deno test`. Used by the ask endpoint to build the `sources` array that is
// both returned as `citations` and persisted in `messages.sources`.
//
// The excerpt is the already-retrieved chunk content VERBATIM. Chunks are
// bounded by the ingestion contract (1000 chars / 200 overlap), so no
// truncation, summarization, rewriting or semantic extraction is applied and
// no information is lost. Construction is 1:1 over the retrieved array, so
// citation numbering (`n: i + 1`) and chunk identity are exactly preserved.
//
// Tenant scoping is inherited, not implemented here: the input is the
// tenant-scoped evidence the retrieval path already produced. No second
// retrieval, embedding, rerank or model call happens in this module.

import type { EvidenceItem } from "./grounding.ts";

export type CitationSource = {
  n: number;
  chunk_id: string;
  document_id: string;
  file_name: string;
  page: number | null;
  fused_rank?: number | null;
  fused_score?: number | null;
  /**
   * Verbatim retrieved chunk content, or null when the chunk carried no
   * usable content. Never synthesized, never taken from another chunk.
   */
  excerpt: string | null;
};

export function buildCitationSources(
  retrieved: EvidenceItem[],
): CitationSource[] {
  return (retrieved ?? []).map((e, i) => ({
    n: i + 1,
    chunk_id: e.chunk_id,
    document_id: e.document_id,
    file_name: e.file_name,
    page: e.page,
    fused_rank: e.fused_rank,
    fused_score: e.fused_score,
    excerpt:
      typeof e.content === "string" && e.content.length > 0
        ? e.content
        : null,
  }));
}
