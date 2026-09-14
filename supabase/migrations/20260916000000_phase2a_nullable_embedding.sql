-- Phase 2A — allow chunks without embeddings.
--
-- Concrete incompatibility with the Phase 1 schema (which this file does not
-- modify): Phase 1 declared chunks.embedding NOT NULL, but the ingestion
-- slice in Phase 2A runs before Bedrock/Titan is wired, so page-aware chunks
-- must persist with embedding NULL until the embedding phase backfills them.
--
-- Why this is safe and not a redesign:
-- * NULL embeddings are simply absent from the HNSW index; FTS/GIN and all
--   RLS policies are unaffected.
-- * Phase 2A chunk_ids carry the 'none-v1' pipeline tag (see ingest-pdf),
--   so unembedded rows can never mix silently with embedded rows later.
--   The embedding phase must backfill (UPDATE embedding) or replace rows
--   whose embedding IS NULL; it must not reinterpret them.
-- * No policy, table, index, or Storage object changes here.

alter table public.chunks alter column embedding drop not null;
