-- Phase 1 — Supabase database foundation and tenant-isolation layer.
--
-- Source decisions: ARCHITECTURE.md sections 9 (data model concept),
-- 10 (security model), 11 (multi-tenant isolation); DECISIONS.md D4, D5, D7, D13.
--
-- Scope: application tables, pgvector + FTS indexes, RLS with membership-based
-- tenant isolation, private Storage bucket + policies for document originals.
-- No Edge Functions, no Bedrock, no ingestion/retrieval/generation logic here.
-- No secrets, credentials, or customer data in this migration.
--
-- Conventions used throughout:
-- * Every RAG-owned row carries tenant_id (denormalized on purpose so RLS stays
--   a cheap indexed equality check instead of a JOIN).
-- * RLS is enabled on every application table. Policies target the
--   `authenticated` role only; there are no anon policies and no permissive
--   USING (true) policies on tenant data. Cross-tenant access fails closed.
-- * Membership checks go through private.is_tenant_member / is_tenant_manager
--   (SECURITY DEFINER, fixed empty search_path, live DB lookup so revocation
--   takes effect immediately). Policies use (select auth.uid()) inside the
--   helpers per current Supabase RLS guidance.
-- * Child rows reference parents with composite (id, tenant_id) foreign keys so
--   a chunk / message / ingest job can never be linked to another tenant's
--   document / conversation, even on service_role writes.
-- * Embeddings are Titan Text Embeddings V2 at 1024 dimensions (DECISIONS.md D5).
--   Changing the embedding model later requires new chunk_ids, never reinterpreting
--   these vectors.

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ---------------------------------------------------------------------------
-- 1. Private helper schema (NOT exposed via PostgREST)
-- ---------------------------------------------------------------------------

create schema if not exists private;

-- NOTE: private.is_tenant_member / is_tenant_manager reference
-- public.memberships, so they are defined in section 6 AFTER the tables
-- (PostgreSQL resolves SQL-function bodies at CREATE time).

-- Shared updated_at maintenance. Plain trigger helper; touches only NEW.
create or replace function private.handle_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Tenants and memberships
-- ---------------------------------------------------------------------------

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index memberships_user_tenant_idx on public.memberships (user_id, tenant_id);
create index memberships_tenant_idx on public.memberships (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. Documents and chunks
-- ---------------------------------------------------------------------------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  file_name text not null,
  -- Tenant-namespaced Storage key, e.g. tenants/<tenant_id>/docs/<doc_id>/<file>.
  -- Browser filenames are display labels only, never identities.
  storage_path text not null,
  page_count integer check (page_count is null or page_count >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'ready', 'failed')),
  content_hash text,
  embedding_model text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, storage_path)
);

create index documents_tenant_idx on public.documents (tenant_id);
create index documents_tenant_status_idx on public.documents (tenant_id, status);

create table public.chunks (
  -- Content-bound id: hash(content + page + file identity + embedding model id).
  -- Same content re-indexes to the same id (ON CONFLICT DO NOTHING stays
  -- idempotent); a new embedding model yields disjoint ids by construction.
  chunk_id text primary key,
  tenant_id uuid not null,
  document_id uuid not null,
  file_name text,
  page integer,
  content text not null,
  embedding vector(1024) not null,
  -- Maintained by Postgres on every insert; backfills existing rows, so no
  -- re-ingestion is ever needed to (re)build keyword search.
  content_tsv tsvector
    generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  foreign key (document_id, tenant_id)
    references public.documents (id, tenant_id) on delete cascade
);

-- Dense retrieval: HNSW cosine index (starting point m=16, ef_construction=64;
-- tune ef_search per workload; see ARCHITECTURE.md section 7).
create index chunks_embedding_hnsw_idx on public.chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Keyword retrieval: GIN over the generated tsvector.
create index chunks_content_tsv_gin_idx on public.chunks
  using gin (content_tsv);

create index chunks_tenant_document_idx on public.chunks (tenant_id, document_id);

-- ---------------------------------------------------------------------------
-- 4. Conversations and messages (server-side session state)
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id)
);

create index conversations_tenant_idx on public.conversations (tenant_id);
create index conversations_tenant_user_idx on public.conversations (tenant_id, user_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  tenant_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  -- Answer support label (e.g. DIRECT / PARTIAL / ...). Free text on purpose:
  -- the label vocabulary evolves with the generation pipeline (later phase).
  label text,
  -- Provenance record: chunk_id + document_id + file_name + page + score +
  -- retrieval_round + model ids. Never secrets, never other tenants' text.
  sources jsonb not null default '[]'::jsonb,
  model_ids jsonb not null default '{}'::jsonb,
  timings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, tenant_id)
    references public.conversations (id, tenant_id) on delete cascade
);

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at);
create index messages_tenant_idx on public.messages (tenant_id);

-- ---------------------------------------------------------------------------
-- 5. Ingest jobs and usage counters
-- ---------------------------------------------------------------------------

create table public.ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (document_id, tenant_id)
    references public.documents (id, tenant_id) on delete cascade
);

create index ingest_jobs_tenant_idx on public.ingest_jobs (tenant_id);
create index ingest_jobs_document_idx on public.ingest_jobs (document_id);
create index ingest_jobs_tenant_status_idx on public.ingest_jobs (tenant_id, status);

-- Per-tenant accounting windows for rate limiting and cost visibility.
-- Written server-side (service_role); members get read access via RLS below.
-- window_start is the start of the accounting window (e.g. truncated to the hour).
create table public.usage_counters (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  window_start timestamptz not null,
  queries bigint not null default 0 check (queries >= 0),
  tokens_in bigint not null default 0 check (tokens_in >= 0),
  tokens_out bigint not null default 0 check (tokens_out >= 0),
  embeds bigint not null default 0 check (embeds >= 0),
  reranks bigint not null default 0 check (reranks >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, window_start)
);

-- ---------------------------------------------------------------------------
-- 6. Membership helpers (defined AFTER the tables they read)
-- ---------------------------------------------------------------------------

-- True when the calling user holds any membership in the tenant.
-- SECURITY DEFINER so it bypasses RLS on public.memberships (avoids recursion);
-- it only ever inspects the caller's own rows via (select auth.uid()), so it
-- reveals nothing about other users. STABLE lets the planner evaluate it once
-- per statement.
create or replace function private.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = (select auth.uid())
      and m.tenant_id = p_tenant_id
  );
$$;

-- True when the calling user is an owner or admin of the tenant.
create or replace function private.is_tenant_manager(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = (select auth.uid())
      and m.tenant_id = p_tenant_id
      and m.role in ('owner', 'admin')
  );
$$;

-- ---------------------------------------------------------------------------
-- 7. updated_at triggers
-- ---------------------------------------------------------------------------

create trigger tenants_updated_at
  before update on public.tenants
  for each row execute function private.handle_updated_at();

create trigger documents_updated_at
  before update on public.documents
  for each row execute function private.handle_updated_at();

create trigger conversations_updated_at
  before update on public.conversations
  for each row execute function private.handle_updated_at();

create trigger ingest_jobs_updated_at
  before update on public.ingest_jobs
  for each row execute function private.handle_updated_at();

create trigger usage_counters_updated_at
  before update on public.usage_counters
  for each row execute function private.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 8. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.tenants enable row level security;
alter table public.memberships enable row level security;
alter table public.documents enable row level security;
alter table public.chunks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ingest_jobs enable row level security;
alter table public.usage_counters enable row level security;

-- Tenants: members can read their tenants. Any signed-in user may create a
-- tenant row (bootstrap); the creator's owner membership is added by the
-- privileged tenant-creation flow (service_role, later phase), which is why
-- membership-gated writes would deadlock here. Owner/admin-only update/delete.
create policy "tenants_select_members"
  on public.tenants for select
  to authenticated
  using (private.is_tenant_member(id));

create policy "tenants_insert_authenticated"
  on public.tenants for insert
  to authenticated
  with check (true);

create policy "tenants_update_managers"
  on public.tenants for update
  to authenticated
  using (private.is_tenant_manager(id))
  with check (private.is_tenant_manager(id));

create policy "tenants_delete_managers"
  on public.tenants for delete
  to authenticated
  using (private.is_tenant_manager(id));

-- Memberships: members can see co-members of their tenants; only owners/admins
-- can add, change, or remove memberships. NOTE bootstrap: the very first
-- membership of a new tenant cannot satisfy the manager policy, so it must be
-- inserted by the privileged tenant-creation flow (service_role), never by
-- relaxing these policies.
create policy "memberships_select_members"
  on public.memberships for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

create policy "memberships_insert_managers"
  on public.memberships for insert
  to authenticated
  with check (private.is_tenant_manager(tenant_id));

create policy "memberships_update_managers"
  on public.memberships for update
  to authenticated
  using (private.is_tenant_manager(tenant_id))
  with check (private.is_tenant_manager(tenant_id));

create policy "memberships_delete_managers"
  on public.memberships for delete
  to authenticated
  using (private.is_tenant_manager(tenant_id));

-- Documents: tenant members get scoped CRUD. UPDATE carries WITH CHECK on the
-- same predicate so a row can never be moved into another tenant.
create policy "documents_select_members"
  on public.documents for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

create policy "documents_insert_members"
  on public.documents for insert
  to authenticated
  with check (private.is_tenant_member(tenant_id));

create policy "documents_update_members"
  on public.documents for update
  to authenticated
  using (private.is_tenant_member(tenant_id))
  with check (private.is_tenant_member(tenant_id));

create policy "documents_delete_members"
  on public.documents for delete
  to authenticated
  using (private.is_tenant_member(tenant_id));

-- Chunks: same member-scoped CRUD shape. Production ingestion writes via
-- service_role (bypasses RLS and enforces tenant_id explicitly); these policies
-- keep direct authenticated access tenant-confined.
create policy "chunks_select_members"
  on public.chunks for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

create policy "chunks_insert_members"
  on public.chunks for insert
  to authenticated
  with check (private.is_tenant_member(tenant_id));

create policy "chunks_update_members"
  on public.chunks for update
  to authenticated
  using (private.is_tenant_member(tenant_id))
  with check (private.is_tenant_member(tenant_id));

create policy "chunks_delete_members"
  on public.chunks for delete
  to authenticated
  using (private.is_tenant_member(tenant_id));

-- Conversations: member-scoped CRUD.
create policy "conversations_select_members"
  on public.conversations for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

create policy "conversations_insert_members"
  on public.conversations for insert
  to authenticated
  with check (private.is_tenant_member(tenant_id));

create policy "conversations_update_members"
  on public.conversations for update
  to authenticated
  using (private.is_tenant_member(tenant_id))
  with check (private.is_tenant_member(tenant_id));

create policy "conversations_delete_members"
  on public.conversations for delete
  to authenticated
  using (private.is_tenant_member(tenant_id));

-- Messages: member-scoped CRUD (append-mostly by convention; no DB-level
-- immutability so corrections/redactions remain possible via privileged flows).
create policy "messages_select_members"
  on public.messages for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

create policy "messages_insert_members"
  on public.messages for insert
  to authenticated
  with check (private.is_tenant_member(tenant_id));

create policy "messages_update_members"
  on public.messages for update
  to authenticated
  using (private.is_tenant_member(tenant_id))
  with check (private.is_tenant_member(tenant_id));

create policy "messages_delete_members"
  on public.messages for delete
  to authenticated
  using (private.is_tenant_member(tenant_id));

-- Ingest jobs: member-scoped CRUD (status polling + retry bookkeeping).
create policy "ingest_jobs_select_members"
  on public.ingest_jobs for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

create policy "ingest_jobs_insert_members"
  on public.ingest_jobs for insert
  to authenticated
  with check (private.is_tenant_member(tenant_id));

create policy "ingest_jobs_update_members"
  on public.ingest_jobs for update
  to authenticated
  using (private.is_tenant_member(tenant_id))
  with check (private.is_tenant_member(tenant_id));

create policy "ingest_jobs_delete_members"
  on public.ingest_jobs for delete
  to authenticated
  using (private.is_tenant_member(tenant_id));

-- Usage counters: members may read their own tenant's counters (quota/cost
-- visibility). No authenticated write policies on purpose: counters are mutated
-- server-side via service_role only, so a member can never forge usage.
create policy "usage_counters_select_members"
  on public.usage_counters for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- 9. Private Storage for document originals
-- ---------------------------------------------------------------------------
-- Represented here because buckets + storage.objects policies are plain SQL and
-- therefore safe inside the migration workflow. The bucket stays private;
-- access is per-tenant-prefix, members-only, authenticated-only.

insert into storage.buckets (id, name, public, file_size_limit)
values ('company-documents', 'company-documents', false, 52428800)
on conflict (id) do nothing;

-- Object keys MUST look like: tenants/<tenant_id>/docs/<document_id>/<filename>
-- Any other shape fails the policy (fail closed, including malformed UUIDs).
create policy "company_docs_insert_members"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  );

create policy "company_docs_select_members"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  );

create policy "company_docs_update_members"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  )
  with check (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  );

create policy "company_docs_delete_members"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  );
