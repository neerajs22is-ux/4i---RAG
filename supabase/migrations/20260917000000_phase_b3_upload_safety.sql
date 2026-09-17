-- B3 — Upload safety: persist the authoritative object size on documents.
--
-- `file_size` is the storage-budget accounting source of truth. It is written
-- by ingest-pdf from the Storage object's own metadata (never from a client
-- parameter), so the 400 MB workspace budget can be computed from the database
-- alone — no bucket-wide scan, no Storage API pagination.
--
-- Metadata only: no document content, status, chunk or embedding is touched.
-- Idempotent: safe to re-run.

alter table public.documents
  add column if not exists file_size bigint
  check (file_size is null or file_size >= 0);

comment on column public.documents.file_size is
  'Object size in bytes, read from storage.object metadata at registration; authoritative for workspace storage-budget accounting.';

-- One-time backfill for documents registered before B3. Reads the existing
-- storage.objects row per document (a per-row lookup, not a scan).
update public.documents d
set file_size = (o.metadata ->> 'size')::bigint
from storage.objects o
where o.bucket_id = 'company-documents'
  and o.name = d.storage_path
  and d.file_size is null
  and (o.metadata ->> 'size') ~ '^[0-9]+$';
