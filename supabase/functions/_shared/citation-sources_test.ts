// Citation source excerpt tests — deterministic, pure, no I/O.
//
// Run: deno test supabase/functions/_shared/citation-sources_test.ts
//
// Verifies the excerpt contract:
// - excerpt is the EXACT retrieved chunk content (same index, same chunk)
// - citation identity/numbering is unchanged
// - missing or empty content fails safely to a null excerpt (never throws,
//   never borrows another chunk's text)
// - JSON persistence round-trip preserves the excerpt
// - tenant/document provenance fields pass through untouched

import { buildCitationSources } from "./citation-sources.ts";
import type { EvidenceItem } from "./grounding.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

function evidence(overrides: Partial<EvidenceItem> & { content?: unknown } = {}): EvidenceItem {
  return {
    chunk_id: "chunk-1",
    document_id: "doc-1",
    tenant_id: "tenant-1",
    file_name: "a.pdf",
    page: 3,
    content: "passage one",
    fused_rank: 0,
    fused_score: 0.9,
    ...overrides,
  } as EvidenceItem;
}

Deno.test("citation-sources: excerpt is the exact retrieved content per index", () => {
  const retrieved = [evidence({ content: "first chunk" }), evidence({ chunk_id: "chunk-2", content: "second chunk" })];
  const sources = buildCitationSources(retrieved);
  assertEquals(sources.length, 2, "one source per retrieved item");
  assertEquals(sources[0].excerpt, "first chunk", "excerpt[0]");
  assertEquals(sources[1].excerpt, "second chunk", "excerpt[1]");
  assert(sources[0].excerpt !== sources[1].excerpt, "excerpts are not shared across citations");
});

Deno.test("citation-sources: identity and numbering unchanged", () => {
  const retrieved = [
    evidence({ chunk_id: "c-a", document_id: "d-a", file_name: "a.pdf", page: 1, fused_rank: 4, fused_score: 0.5 }),
    evidence({ chunk_id: "c-b", document_id: "d-b", file_name: "b.pdf", page: null, fused_rank: 9, fused_score: 0.1 }),
  ];
  const sources = buildCitationSources(retrieved);
  assertEquals(sources[0].n, 1, "n[0]");
  assertEquals(sources[1].n, 2, "n[1]");
  assertEquals(sources[0].chunk_id, "c-a", "chunk_id[0]");
  assertEquals(sources[1].chunk_id, "c-b", "chunk_id[1]");
  assertEquals(sources[0].document_id, "d-a", "document_id[0]");
  assertEquals(sources[1].document_id, "d-b", "document_id[1]");
  assertEquals(sources[0].file_name, "a.pdf", "file_name[0]");
  assertEquals(sources[1].file_name, "b.pdf", "file_name[1]");
  assertEquals(sources[0].page, 1, "page[0]");
  assertEquals(sources[1].page, null, "page[1]");
  assertEquals(sources[0].fused_rank, 4, "fused_rank[0]");
  assertEquals(sources[1].fused_rank, 9, "fused_rank[1]");
});

Deno.test("citation-sources: missing or empty content fails safely to null", () => {
  const retrieved = [
    evidence({ content: "" }),
    evidence({ content: undefined }),
    evidence({ content: "   " }),
  ];
  const sources = buildCitationSources(retrieved);
  assertEquals(sources[0].excerpt, null, "empty string content");
  assertEquals(sources[1].excerpt, null, "missing content");
  // Whitespace-only content is preserved verbatim (no content judgments here).
  assertEquals(sources[2].excerpt, "   ", "whitespace content passes through");
  // Numbering and identity survive the null excerpts.
  assertEquals(sources.map((s) => s.n), [1, 2, 3], "numbering intact");
});

Deno.test("citation-sources: empty retrieval yields no sources", () => {
  assertEquals(buildCitationSources([]), [], "empty in, empty out");
  assertEquals(buildCitationSources(null as unknown as EvidenceItem[]), [], "null-safe");
});

Deno.test("citation-sources: JSON persistence round-trip preserves excerpt", () => {
  const retrieved = [evidence({ content: "persisted “quoted” passage — p.3 ✓" })];
  const roundTripped = JSON.parse(JSON.stringify(buildCitationSources(retrieved)));
  assertEquals(roundTripped[0].excerpt, "persisted “quoted” passage — p.3 ✓", "excerpt survives JSON");
  assertEquals(roundTripped[0].chunk_id, "chunk-1", "identity survives JSON");
  assertEquals(roundTripped[0].n, 1, "numbering survives JSON");
});
