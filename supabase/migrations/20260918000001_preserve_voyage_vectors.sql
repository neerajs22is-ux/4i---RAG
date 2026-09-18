-- Production embedding migration: preserve Voyage vectors for rollback.
--
-- ADDITIVE ONLY. Adds a backup column for the current Voyage-4 vectors and
-- backfills it from the live column, so the Jina re-embedding can overwrite
-- public.chunks.embedding without destroying the rollback path. No existing
-- column, index, function, policy, or row value is otherwise touched, and no
-- retrieval behavior changes: match_chunks, the HNSW index and all constants
-- keep reading public.chunks.embedding exactly as before.
--
-- documents.embedding_model continues to label whichever vectors are ACTIVE
-- (the embed-worker writes the Jina model id as documents complete).
-- Rollback (while the backup exists): copy embedding_voyage back over
-- embedding, restore documents.embedding_model to 'voyage-4', and redeploy
-- the pre-migration functions. Do NOT drop this column until Jina production
-- validation has passed and rollback is explicitly retired.

alter table public.chunks
  add column if not exists embedding_voyage vector(1024);

comment on column public.chunks.embedding_voyage is
  'Pre-migration Voyage-4 vectors, preserved for rollback. NULL means the row was created after the Jina migration. Never read for retrieval.';

update public.chunks
  set embedding_voyage = embedding
  where embedding_voyage is null
    and embedding is not null;
