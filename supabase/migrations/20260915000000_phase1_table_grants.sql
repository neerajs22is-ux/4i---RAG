-- Phase 1 fix — table privileges for the authenticated role.
--
-- Source decisions: ARCHITECTURE.md section 10 (security model),
-- DECISIONS.md D7 (tenant isolation is a DB predicate).
--
-- Context: the Phase 1 migration enabled RLS with membership-scoped policies on
-- all 8 application tables, but client roles held no table privileges, so
-- PostgREST/browser access as `authenticated` was denied at the PostgreSQL
-- privilege layer before RLS could evaluate (fail-closed but non-functional).
-- This migration grants the minimum table privileges RLS needs to enforce the
-- actual authorization. It changes no policy, table, index, or Storage object.
--
-- Deliberately NOT granted:
-- * `anon` receives nothing (unauthenticated access stays denied at both the
--   privilege and RLS layers).
-- * No GRANT ... TO public (would silently cover every current/future role).
-- * usage_counters is included: members already hold a SELECT-only RLS policy
--   there, and the privilege merely lets RLS evaluate; writes remain denied by
--   the absence of any authenticated write policy (service_role writes only).
-- * Sequences are not granted: all primary keys default to gen_random_uuid(),
--   so no sequence privileges are required.

grant select, insert, update, delete on public.tenants to authenticated;
grant select, insert, update, delete on public.memberships to authenticated;
grant select, insert, update, delete on public.documents to authenticated;
grant select, insert, update, delete on public.chunks to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages to authenticated;
grant select, insert, update, delete on public.ingest_jobs to authenticated;
grant select, insert, update, delete on public.usage_counters to authenticated;

-- Future application tables created by later migrations (same owner/role)
-- inherit the same minimum privileges so they do not accidentally become
-- inaccessible; RLS policies on those tables remain the enforcement point.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to authenticated;
