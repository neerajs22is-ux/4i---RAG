-- B6 — Storage file cap: align the platform-level bucket limit with the
-- application policy enforced by ingest-pdf (B3): 25 MiB.
--
-- The bucket was created with the plan maximum (50 MB). This lowers it so a
-- client cannot upload a file the application will always reject; the app check
-- remains as defense in depth.
--
-- Lowering only, and idempotent: it never raises a limit and is a no-op once
-- already at or below 25 MiB. No object, policy, or other bucket is touched.

update storage.buckets
set file_size_limit = 26214400  -- 25 MiB
where id = 'company-documents'
  and (file_size_limit is null or file_size_limit > 26214400);
