-- Temporary chat files — data/scope model (data model only).
--
-- A temporary document is an ordinary row in public.documents with a
-- conversation binding and an expiry timestamp:
--   persistent: expires_at IS NULL AND conversation_id IS NULL (unchanged)
--   temporary:  expires_at IS NOT NULL AND conversation_id IS NOT NULL
--
-- Everything else reuses the existing pipeline unchanged: ingest_jobs
-- lifecycle, chunks (composite tenant-pinned FK), the Storage bucket and
-- policies, the embed-worker, match_chunks, and the delete-document action.
-- Retrieval scoping, registration, promotion and cleanup read these two
-- columns; no status vocabulary, table, policy or provider is touched here.
--
-- Tenant safety is structural, not just policy-driven: conversation_id is
-- pinned to the same tenant through a composite foreign key, so a temporary
-- document can never be bound to another tenant's conversation, not even by a
-- privileged writer (same pattern as B4 notebook_sources and public.chunks).
-- A database trigger (not UI filtering) forbids temporary documents from
-- entering notebook_sources, for every role including service_role.
--
-- Additive and idempotent: existing rows keep NULL/NULL (persistent), existing
-- foreign keys and retrieval behaviour are untouched. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- 1. Temporary scope columns on documents
-- ---------------------------------------------------------------------------
alter table public.documents
  add column if not exists expires_at timestamptz;

comment on column public.documents.expires_at is
  'NULL for persistent documents; retrieval deadline for temporary chat files. Retrieval-time filtering (not cleanup) is the access boundary.';

alter table public.documents
  add column if not exists conversation_id uuid;

comment on column public.documents.conversation_id is
  'NULL for persistent documents; the owning conversation for temporary chat files, pinned to the same tenant by documents_conversation_tenant_fkey.';

-- ---------------------------------------------------------------------------
-- 2. Structural tenant pinning: (conversation_id, tenant_id)
-- ---------------------------------------------------------------------------
-- public.conversations carries unique (id, tenant_id) (Phase 1 foundation), so
-- the composite reference is exact. Nullable columns: persistent rows (NULL,
-- NULL) are unaffected by the constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'documents_conversation_tenant_fkey'
  ) then
    alter table public.documents
      add constraint documents_conversation_tenant_fkey
      foreign key (conversation_id, tenant_id)
      references public.conversations (id, tenant_id) on delete cascade;
  end if;
end $$;

-- Temporary scope is both-or-neither: a row with only one of the two columns
-- set is malformed (unreachable by any resolution path, unsweepable by the
-- cleanup query). Enforced for every role, including service_role.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'documents_temp_scope_check'
  ) then
    alter table public.documents
      add constraint documents_temp_scope_check
      check ((expires_at is null) = (conversation_id is null));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Temporary-document lookup index (partial: persistent rows excluded)
-- ---------------------------------------------------------------------------
create index if not exists documents_temp_lookup_idx
  on public.documents (tenant_id, conversation_id)
  where expires_at is not null;

-- ---------------------------------------------------------------------------
-- 4. Authoritative protection: temporary documents can never become
--    notebook/Space sources, for any writer role
-- ---------------------------------------------------------------------------
-- notebook_sources rows are written directly by members through PostgREST, so
-- UI filtering alone cannot enforce this. The trigger fails the write closed
-- for every role (authenticated and service_role alike).
create or replace function private.reject_temp_notebook_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.documents d
    where d.id = NEW.document_id
      and d.expires_at is not null
  ) then
    raise exception 'temporary documents cannot be notebook sources';
  end if;
  return NEW;
end;
$$;

drop trigger if exists reject_temp_notebook_source on public.notebook_sources;
create trigger reject_temp_notebook_source
  before insert or update on public.notebook_sources
  for each row execute function private.reject_temp_notebook_source();

-- The trigger runs with invoker rights, so every writer role needs USAGE on
-- the schema and EXECUTE on the function (idempotent re-grants).
grant usage on schema private to authenticated, service_role;
grant execute on function private.reject_temp_notebook_source()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Temporary scope immutability after registration
-- ---------------------------------------------------------------------------
-- Members hold UPDATE on documents, so without this rule any member could
-- extend a temporary document's expiry indefinitely (TTL bypass), rebind it
-- to another conversation, or mark a persistent document temporary (which
-- would expose it to the expiry sweeper — destructive). The only permitted
-- post-registration change is the promotion shape: both columns cleared
-- together, which is exactly what the server-side promote action writes (same
-- role, same outcome, tenant membership required either way — the action
-- remains the audited path). Registration-time INSERTs are unaffected, as are
-- all existing flows, which never touch these columns (verified: ingest
-- finalize, file_size refresh, fail paths and the worker update other
-- columns only).
create or replace function private.protect_temp_scope_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if NEW.expires_at is not distinct from OLD.expires_at
     and NEW.conversation_id is not distinct from OLD.conversation_id then
    return NEW;
  end if;
  if NEW.expires_at is null and NEW.conversation_id is null then
    return NEW;
  end if;
  raise exception 'temporary scope columns are immutable after registration';
end;
$$;

drop trigger if exists protect_temp_scope_columns on public.documents;
create trigger protect_temp_scope_columns
  before update on public.documents
  for each row execute function private.protect_temp_scope_columns();

grant execute on function private.protect_temp_scope_columns()
  to authenticated, service_role;
