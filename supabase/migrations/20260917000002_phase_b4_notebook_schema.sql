-- B4 — Notebook + source data model.
--
-- Workspace (tenant) → Notebook → Sources (documents) → Chunks. A notebook is
-- a user-facing knowledge set; a source is one document, even though that
-- document contains many chunks. Selection state lives on the relationship so a
-- document can be present in a notebook but deselected (enforced in B2).
--
-- Scope: data model only. No retrieval function, policy or object is changed;
-- match_chunks/query-chunks/ask keep reading exactly what they read today.
--
-- Tenant safety is structural, not just policy-driven: notebook_sources carries
-- a composite foreign key (document_id, tenant_id) → documents (id, tenant_id),
-- so a document from another tenant can never be linked to a notebook, not even
-- by a privileged writer. The same pattern is already used by public.chunks.
--
-- Privileges: tables created here by role postgres inherit the grants already
-- set by the phase1/phase3a1 default-privileges statements for `authenticated`
-- and `service_role`. RLS below is the enforcement point for user roles.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Notebooks
-- ---------------------------------------------------------------------------
create table if not exists public.notebooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Composite key so child tables can pin both notebook and tenant in one FK.
  unique (id, tenant_id)
);

create index if not exists notebooks_tenant_idx on public.notebooks (tenant_id);

create trigger notebooks_updated_at
  before update on public.notebooks
  for each row execute function private.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Documents: archive marker
-- ---------------------------------------------------------------------------
-- Archived documents stay fully indexed (chunks untouched) and are simply
-- excluded from notebook selection flows. Purely additive and nullable.
alter table public.documents
  add column if not exists archived_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Notebook sources (document membership + selection)
-- ---------------------------------------------------------------------------
create table if not exists public.notebook_sources (
  notebook_id uuid not null,
  tenant_id uuid not null,
  document_id uuid not null,
  selected boolean not null default true,
  added_at timestamptz not null default now(),
  primary key (notebook_id, document_id),
  -- Notebook and document must both belong to the SAME tenant as this row.
  foreign key (notebook_id, tenant_id)
    references public.notebooks (id, tenant_id) on delete cascade,
  foreign key (document_id, tenant_id)
    references public.documents (id, tenant_id) on delete cascade
);

create index if not exists notebook_sources_tenant_idx
  on public.notebook_sources (tenant_id);
create index if not exists notebook_sources_document_idx
  on public.notebook_sources (document_id);

-- ---------------------------------------------------------------------------
-- 4. Row level security (same member-scoped shape as documents)
-- ---------------------------------------------------------------------------
alter table public.notebooks enable row level security;
alter table public.notebook_sources enable row level security;

create policy "notebooks_select_members"
  on public.notebooks for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

create policy "notebooks_insert_members"
  on public.notebooks for insert
  to authenticated
  with check (private.is_tenant_member(tenant_id));

create policy "notebooks_update_members"
  on public.notebooks for update
  to authenticated
  using (private.is_tenant_member(tenant_id))
  with check (private.is_tenant_member(tenant_id));

create policy "notebooks_delete_members"
  on public.notebooks for delete
  to authenticated
  using (private.is_tenant_member(tenant_id));

create policy "notebook_sources_select_members"
  on public.notebook_sources for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

create policy "notebook_sources_insert_members"
  on public.notebook_sources for insert
  to authenticated
  with check (private.is_tenant_member(tenant_id));

create policy "notebook_sources_update_members"
  on public.notebook_sources for update
  to authenticated
  using (private.is_tenant_member(tenant_id))
  with check (private.is_tenant_member(tenant_id));

create policy "notebook_sources_delete_members"
  on public.notebook_sources for delete
  to authenticated
  using (private.is_tenant_member(tenant_id));
