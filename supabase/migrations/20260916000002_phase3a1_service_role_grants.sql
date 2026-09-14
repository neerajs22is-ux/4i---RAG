-- Phase 3A.1 — table privileges for service_role (new file only).
--
-- RLS never applied to service_role (bypass by design, confined to Edge
-- Functions per DECISIONS.md D7). Supabase does not auto-grant privileges
-- on migration-created tables, so scheduler-driven Edge workers — which
-- have no caller JWT to forward — cannot read/write application tables
-- without this grant. This changes no RLS policy and grants nothing to
-- anon or public. Verified live: service_role calls failed with
-- "permission denied for table ingest_jobs" before this grant.

grant select, insert, update, delete on public.tenants to service_role;
grant select, insert, update, delete on public.memberships to service_role;
grant select, insert, update, delete on public.documents to service_role;
grant select, insert, update, delete on public.chunks to service_role;
grant select, insert, update, delete on public.conversations to service_role;
grant select, insert, update, delete on public.messages to service_role;
grant select, insert, update, delete on public.ingest_jobs to service_role;
grant select, insert, update, delete on public.usage_counters to service_role;

-- Future application tables (same owner/role) inherit the same minimum
-- privileges; RLS policies remain the enforcement point for user roles.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;
