-- Security remediation (audit 2026-10-01): ownership, immutability, expiry,
-- rate limits, least-privilege grants, storage path pinning.
--
-- Additive and idempotent: every statement is safe to re-run. No data is
-- deleted or rewritten. Existing rows keep their values; new guards only
-- reject future unsafe writes. RLS stays tenant-confined; ownership narrows
-- writes (creator or manager) while reads stay tenant-wide except expired
-- temporary documents (hidden from non-owners/non-managers).
--
-- Sections:
--  1. Rate-limit counters + check_rate_limit RPC (H-4)
--  2. Tenant-id immutability trigger (M-4 tenant-hop)
--  3. Chunk pipeline guards (H-3 vector/content forgery)
--  4. Document system-column guards (M-6 quota integrity)
--  5. Temp TTL cap on insert + promotion ownership (M-5/H-2)
--  6. Expired-temp visibility helpers + SELECT narrowing (H-2)
--  7. Ownership RLS for conversations/messages/documents/notebooks (H-1/M-4)
--  8. Storage path pinning to docs/ (M-12)
--  9. Least-privilege grant tightening (M-11)
-- 10. Atomic edit_message RPC (H-1/L-5 server-authorized edit)

-- ---------------------------------------------------------------------------
-- 1. Rate limits (H-4)
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  endpoint text not null,
  window_start timestamptz not null,
  hits bigint not null default 0 check (hits >= 0),
  primary key (tenant_id, endpoint, window_start)
);
alter table public.rate_limits enable row level security;
-- No member policies: counters mutate only via the definer RPC below.
revoke all on public.rate_limits from authenticated, anon, public;
grant select on public.rate_limits to service_role;

create or replace function private.check_rate_limit_impl(
  p_tenant_id uuid, p_endpoint text, p_max_per_minute integer
)
returns table (allowed boolean, retry_after_sec integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := date_trunc('minute', now());
  v_hits bigint;
begin
  insert into public.rate_limits (tenant_id, endpoint, window_start, hits)
  values (p_tenant_id, p_endpoint, v_window, 1)
  on conflict (tenant_id, endpoint, window_start)
  do update set hits = public.rate_limits.hits + 1
  returning public.rate_limits.hits into v_hits;
  if v_hits <= p_max_per_minute then
    return query select true, 0;
  else
    return query select false, (60 - extract(second from now())::integer);
  end if;
end;
$$;
grant execute on function private.check_rate_limit_impl(uuid, text, integer)
  to authenticated, service_role;

-- Legacy tenant-minute-only overload (frozen; new code uses the 7-arg gate
-- below with caps from TS COST_LIMITS). VOLATILE is required: the body
-- writes counters via the impl function.
create or replace function public.check_rate_limit(p_tenant_id uuid, p_endpoint text)
returns table (allowed boolean, retry_after_sec integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max integer := case p_endpoint
    when 'ask' then 30
    when 'query-chunks' then 60
    when 'ingest-pdf' then 10
    when 'edit-message' then 60
    else 30 end;
begin
  -- Caller must belong to the tenant they claim (fail closed otherwise).
  if not exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.tenant_id = p_tenant_id
  ) then
    return query select false, 60;
    return;
  end if;
  return query select * from private.check_rate_limit_impl(p_tenant_id, p_endpoint, v_max);
end;
$$;
grant execute on function public.check_rate_limit(uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1b. P0 cost controls: per-user minute windows, daily ceilings, provider
-- slots, usage accounting (D83). All tables mutate ONLY via the definer RPCs
-- below; members hold no write policies. Caps arrive as RPC arguments from
-- `_shared/cost-control.ts` COST_LIMITS (single source; SQL enforces).
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits_user (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null,
  endpoint text not null,
  window_start timestamptz not null,
  hits bigint not null default 0 check (hits >= 0),
  primary key (tenant_id, user_id, endpoint, window_start)
);
alter table public.rate_limits_user enable row level security;
revoke all on public.rate_limits_user from authenticated, anon, public;
grant select on public.rate_limits_user to service_role;

create table if not exists public.usage_daily (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null,
  endpoint text not null,
  day date not null,
  attempts bigint not null default 0 check (attempts >= 0),
  rejected bigint not null default 0 check (rejected >= 0),
  provider_calls bigint not null default 0 check (provider_calls >= 0),
  tokens_est bigint not null default 0 check (tokens_est >= 0),
  primary key (tenant_id, user_id, endpoint, day)
);
alter table public.usage_daily enable row level security;
revoke all on public.usage_daily from authenticated, anon, public;
grant select on public.usage_daily to service_role;

-- In-flight provider-call slots. One pool for all provider work (embed /
-- rerank / rewrite / generation / checker): a request holds at most one slot
-- at a time (sequential awaits), so this bounds CONCURRENT provider calls
-- per tenant and per user. user_id '00000000-...' is the tenant aggregate
-- row (hence no FK on user_id); crashed isolates leak at most until the
-- 300 s stale reap (above the 90 s max provider timeout).
create table if not exists public.provider_slots (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null,
  inflight integer not null default 0 check (inflight >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
alter table public.provider_slots enable row level security;
revoke all on public.provider_slots from authenticated, anon, public;
grant select on public.provider_slots to service_role;

-- Full gate: per-minute (tenant+user) + per-UTC-day (tenant+user) fixed
-- windows. Caps arrive as arguments (TS COST_LIMITS owns values; 0 = skip
-- that grain). One call records the attempt atomically: denials bump
-- `rejected` in the same transaction. Advisory lock serializes boundary
-- races per (tenant, endpoint). Reasons: ok | user-minute | tenant-minute |
-- user-daily | tenant-daily | not-member.
create or replace function public.check_rate_limit(
  p_tenant_id uuid, p_user_id uuid, p_endpoint text,
  p_min_tenant integer, p_min_user integer,
  p_day_tenant integer, p_day_user integer
)
returns table (allowed boolean, retry_after_sec integer, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_min timestamptz := date_trunc('minute', now());
  v_day date := (now() at time zone 'utc')::date;
  v_tenant_min bigint;
  v_user_min bigint;
  v_tenant_day bigint;
  v_user_day bigint;
begin
  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text || '|' || p_endpoint));
  if not exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.tenant_id = p_tenant_id
  ) then
    return query select false, 60, 'not-member'::text;
    return;
  end if;
  insert into public.rate_limits (tenant_id, endpoint, window_start, hits)
  values (p_tenant_id, p_endpoint, v_min, 1)
  on conflict (tenant_id, endpoint, window_start)
  do update set hits = public.rate_limits.hits + 1
  returning public.rate_limits.hits into v_tenant_min;
  if p_min_user > 0 and p_user_id is not null then
    insert into public.rate_limits_user (tenant_id, user_id, endpoint, window_start, hits)
    values (p_tenant_id, p_user_id, p_endpoint, v_min, 1)
    on conflict (tenant_id, user_id, endpoint, window_start)
    do update set hits = public.rate_limits_user.hits + 1
    returning public.rate_limits_user.hits into v_user_min;
  else
    v_user_min := 0;
  end if;
  insert into public.usage_daily (tenant_id, user_id, endpoint, day, attempts)
  values (p_tenant_id, coalesce(p_user_id, '00000000-0000-0000-0000-000000000000'), p_endpoint, v_day, 1)
  on conflict (tenant_id, user_id, endpoint, day)
  do update set attempts = public.usage_daily.attempts + 1
  returning public.usage_daily.attempts - 1 into v_user_day;
  select coalesce(sum(attempts), 0) into v_tenant_day from public.usage_daily
  where tenant_id = p_tenant_id and endpoint = p_endpoint and day = v_day;
  if p_day_user > 0 and p_user_id is not null and v_user_day >= p_day_user then
    update public.usage_daily set rejected = rejected + 1
    where tenant_id = p_tenant_id and user_id = p_user_id and endpoint = p_endpoint and day = v_day;
    return query select false,
      greatest(0, 86400 - extract(epoch from (now() at time zone 'utc') - date_trunc('day', (now() at time zone 'utc')))::integer),
      'user-daily'::text;
    return;
  end if;
  if p_day_tenant > 0 and v_tenant_day - 1 >= p_day_tenant then
    update public.usage_daily set rejected = rejected + 1
    where tenant_id = p_tenant_id and user_id = coalesce(p_user_id, '00000000-0000-0000-0000-000000000000') and endpoint = p_endpoint and day = v_day;
    return query select false,
      greatest(0, 86400 - extract(epoch from (now() at time zone 'utc') - date_trunc('day', (now() at time zone 'utc')))::integer),
      'tenant-daily'::text;
    return;
  end if;
  if p_min_user > 0 and p_user_id is not null and v_user_min > p_min_user then
    update public.usage_daily set rejected = rejected + 1
    where tenant_id = p_tenant_id and user_id = p_user_id and endpoint = p_endpoint and day = v_day;
    return query select false, (60 - extract(second from now())::integer), 'user-minute'::text;
    return;
  end if;
  if p_min_tenant > 0 and v_tenant_min > p_min_tenant then
    update public.usage_daily set rejected = rejected + 1
    where tenant_id = p_tenant_id and user_id = coalesce(p_user_id, '00000000-0000-0000-0000-000000000000') and endpoint = p_endpoint and day = v_day;
    return query select false, (60 - extract(second from now())::integer), 'tenant-minute'::text;
    return;
  end if;
  return query select true, 0, 'ok'::text;
end;
$$;
grant execute on function public.check_rate_limit(uuid, uuid, text, integer, integer, integer, integer)
  to authenticated, service_role;

-- Claim one provider slot. Single transaction under an advisory lock:
-- reap stale (>300 s), then check user cap and tenant aggregate cap over
-- the same snapshot. Reasons: ok | busy-user | busy-tenant.
create or replace function public.claim_slot(
  p_tenant_id uuid, p_user_id uuid, p_tenant_max integer, p_user_max integer
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_tenant constant uuid := '00000000-0000-0000-0000-000000000000';
  v_tenant integer;
  v_user integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text || '|provider-slots'));
  update public.provider_slots set inflight = 0, updated_at = now()
  where tenant_id = p_tenant_id and updated_at < now() - make_interval(secs => 300);
  select coalesce(sum(inflight), 0) into v_tenant from public.provider_slots
  where tenant_id = p_tenant_id;
  if v_tenant >= p_tenant_max then
    return query select false, 'busy-tenant'::text;
    return;
  end if;
  if p_user_id is not null then
    select coalesce((select inflight from public.provider_slots
      where tenant_id = p_tenant_id and user_id = p_user_id), 0) into v_user;
    if v_user >= p_user_max then
      return query select false, 'busy-user'::text;
      return;
    end if;
    insert into public.provider_slots (tenant_id, user_id, inflight, updated_at)
    values (p_tenant_id, p_user_id, 1, now())
    on conflict (tenant_id, user_id)
    do update set inflight = public.provider_slots.inflight + 1, updated_at = now();
    insert into public.provider_slots (tenant_id, user_id, inflight, updated_at)
    values (p_tenant_id, c_tenant, 1, now())
    on conflict (tenant_id, user_id)
    do update set inflight = public.provider_slots.inflight + 1, updated_at = now();
  else
    insert into public.provider_slots (tenant_id, user_id, inflight, updated_at)
    values (p_tenant_id, c_tenant, 1, now())
    on conflict (tenant_id, user_id)
    do update set inflight = public.provider_slots.inflight + 1, updated_at = now();
  end if;
  return query select true, 'ok'::text;
end;
$$;
grant execute on function public.claim_slot(uuid, uuid, integer, integer)
  to authenticated, service_role;

create or replace function public.release_slot(p_tenant_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_tenant constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  update public.provider_slots
  set inflight = greatest(0, inflight - 1), updated_at = now()
  where tenant_id = p_tenant_id and user_id = c_tenant;
  if p_user_id is not null then
    update public.provider_slots
    set inflight = greatest(0, inflight - 1), updated_at = now()
    where tenant_id = p_tenant_id and user_id = p_user_id;
  end if;
end;
$$;
grant execute on function public.release_slot(uuid, uuid)
  to authenticated, service_role;

-- Post-hoc usage write (best-effort from Edge; never gates traffic).
-- tokens_est is an ESTIMATE (chars/4 proxy or provider-reported usage where
-- the caller holds it) — never an exact provider bill.
create or replace function public.record_provider_use(
  p_tenant_id uuid, p_user_id uuid, p_endpoint text, p_tokens_est integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
begin
  insert into public.usage_daily
    (tenant_id, user_id, endpoint, day, provider_calls, tokens_est)
  values (p_tenant_id, coalesce(p_user_id, '00000000-0000-0000-0000-000000000000'),
    p_endpoint, v_day, 1, greatest(0, p_tokens_est))
  on conflict (tenant_id, user_id, endpoint, day)
  do update set provider_calls = public.usage_daily.provider_calls + 1,
    tokens_est = public.usage_daily.tokens_est + excluded.tokens_est;
end;
$$;
grant execute on function public.record_provider_use(uuid, uuid, text, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tenant-id immutability (M-4: dual-membership hop)
-- ---------------------------------------------------------------------------
create or replace function private.prevent_tenant_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if NEW.tenant_id is distinct from OLD.tenant_id then
    raise exception 'tenant_id is immutable';
  end if;
  return NEW;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'prevent_tenant_hop_documents') then
    create trigger prevent_tenant_hop_documents
      before update on public.documents
      for each row execute function private.prevent_tenant_id_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'prevent_tenant_hop_chunks') then
    create trigger prevent_tenant_hop_chunks
      before update on public.chunks
      for each row execute function private.prevent_tenant_id_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'prevent_tenant_hop_conversations') then
    create trigger prevent_tenant_hop_conversations
      before update on public.conversations
      for each row execute function private.prevent_tenant_id_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'prevent_tenant_hop_messages') then
    create trigger prevent_tenant_hop_messages
      before update on public.messages
      for each row execute function private.prevent_tenant_id_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'prevent_tenant_hop_jobs') then
    create trigger prevent_tenant_hop_jobs
      before update on public.ingest_jobs
      for each row execute function private.prevent_tenant_id_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'prevent_tenant_hop_notebooks') then
    create trigger prevent_tenant_hop_notebooks
      before update on public.notebooks
      for each row execute function private.prevent_tenant_id_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'prevent_tenant_hop_notebook_sources') then
    create trigger prevent_tenant_hop_notebook_sources
      before update on public.notebook_sources
      for each row execute function private.prevent_tenant_id_change();
  end if;
end $$;
grant execute on function private.prevent_tenant_id_change()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Chunk pipeline guards (H-3)
-- ---------------------------------------------------------------------------
-- Legitimate flow: ingest-pdf (caller JWT) inserts rows with NULL embedding
-- while the parent document is pending/processing; embed-worker
-- (service_role, auth.uid() NULL) fills embeddings. Direct vector forgery
-- (non-NULL embedding from a member) and content injection into ready docs
-- are rejected. service_role bypasses for pipeline operation.
create or replace function private.guard_chunk_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  -- service_role / internal (no auth.uid): pipeline writer, allow.
  if (select auth.uid()) is null then
    return NEW;
  end if;
  if TG_OP = 'INSERT' then
    if NEW.embedding is not null then
      raise exception 'chunk embeddings are worker-written';
    end if;
    select d.status into v_status from public.documents d
    where d.id = NEW.document_id and d.tenant_id = NEW.tenant_id;
    if v_status is null or v_status not in ('pending', 'processing') then
      raise exception 'chunks may only be added while the document is ingesting';
    end if;
    return NEW;
  end if;
  -- UPDATE: members may never set/replace the vector or move rows.
  if NEW.embedding is distinct from OLD.embedding then
    raise exception 'chunk embeddings are worker-written';
  end if;
  if NEW.content is distinct from OLD.content
     or NEW.document_id is distinct from OLD.document_id
     or NEW.chunk_id is distinct from OLD.chunk_id then
    raise exception 'chunk content is immutable';
  end if;
  return NEW;
end;
$$;

drop trigger if exists guard_chunk_write on public.chunks;
create trigger guard_chunk_write
  before insert or update on public.chunks
  for each row execute function private.guard_chunk_write();
grant execute on function private.guard_chunk_write()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Document system-column guards (M-6)
-- ---------------------------------------------------------------------------
-- storage_path/content_hash/tenant_id: immutable always (identity).
-- file_size: authoritative pipeline accounting; members may not zero/shrink
-- it to bypass the 400 MB budget — only the uploader or a manager may adjust
-- (re-ingest size refresh flows through the same authorized writers).
-- archived_at/status/page_count: collaborative workspace fields, any member.
create or replace function private.guard_document_system_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_manager boolean;
begin
  if v_caller is null then
    return NEW; -- service_role / internal
  end if;
  if NEW.storage_path is distinct from OLD.storage_path
     or NEW.content_hash is distinct from OLD.content_hash then
    raise exception 'document identity is immutable';
  end if;
  if NEW.file_size is distinct from OLD.file_size then
    v_manager := private.is_tenant_manager(OLD.tenant_id);
    if OLD.created_by is distinct from v_caller and not v_manager then
      raise exception 'file_size is pipeline accounting';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists guard_document_system_columns on public.documents;
create trigger guard_document_system_columns
  before update on public.documents
  for each row execute function private.guard_document_system_columns();
grant execute on function private.guard_document_system_columns()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Temp TTL cap + promotion ownership (M-5/H-2)
-- ---------------------------------------------------------------------------
-- Cap INSERT-time expiry at 7 days (initial TTL is 24 h; 7 d is a generous
-- ceiling that blocks 10-year TTL bypass at birth without affecting legit).
create or replace function private.cap_temp_ttl()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if NEW.expires_at is not null and NEW.expires_at > now() + interval '7 days' then
    raise exception 'temporary expiry exceeds the 7-day maximum';
  end if;
  return NEW;
end;
$$;

drop trigger if exists cap_temp_ttl on public.documents;
create trigger cap_temp_ttl
  before insert on public.documents
  for each row execute function private.cap_temp_ttl();
grant execute on function private.cap_temp_ttl()
  to authenticated, service_role;

-- Extend the existing scope-immutability guard with promotion ownership:
-- the promotion shape (both columns -> NULL) is allowed only for the
-- uploader, a workspace manager, or service_role. TTL extension/rebind
-- stays rejected for everyone (existing behavior preserved).
create or replace function private.protect_temp_scope_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
begin
  if NEW.expires_at is not distinct from OLD.expires_at
     and NEW.conversation_id is not distinct from OLD.conversation_id then
    return NEW;
  end if;
  if NEW.expires_at is null and NEW.conversation_id is null then
    -- Promotion: uploader, manager, or service_role only.
    if v_caller is null then
      return NEW;
    end if;
    if OLD.created_by is distinct from v_caller
       and not private.is_tenant_manager(OLD.tenant_id) then
      raise exception 'only the uploader or a workspace manager can save this file';
    end if;
    return NEW;
  end if;
  raise exception 'temporary scope columns are immutable after registration';
end;
$$;
-- Trigger already exists from the temp migration; function replace is enough.
grant execute on function private.protect_temp_scope_columns()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Expired-temp visibility (H-2: direct-read bypass)
-- ---------------------------------------------------------------------------
-- Retrieval-time expiry is the access boundary; these helpers let RLS hide
-- expired temporary rows from members who neither uploaded them nor manage
-- the workspace. Owners/managers/service_role still see everything (cleanup
-- and support flows keep working). Persistent rows are never hidden.
create or replace function private.is_expired_temp_hidden(
  p_expires_at timestamptz, p_created_by uuid, p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_expires_at is not null
    and p_expires_at <= now()
    and (select auth.uid()) is not null
    and (p_created_by is distinct from (select auth.uid()))
    and not private.is_tenant_manager(p_tenant_id);
$$;
grant execute on function private.is_expired_temp_hidden(timestamptz, uuid, uuid)
  to authenticated, service_role;

-- Helper for chunks: hidden when the parent document is an expired temp the
-- caller may not see. Definer so it reads documents without RLS recursion.
create or replace function private.chunk_hidden_from_caller(p_document_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_expires timestamptz;
  v_creator uuid;
  v_tenant uuid;
begin
  select d.expires_at, d.created_by, d.tenant_id
    into v_expires, v_creator, v_tenant
  from public.documents d where d.id = p_document_id;
  if not found then
    return true; -- fail closed on orphan reference
  end if;
  return private.is_expired_temp_hidden(v_expires, v_creator, v_tenant);
end;
$$;
grant execute on function private.chunk_hidden_from_caller(uuid)
  to authenticated, service_role;

-- Narrow documents SELECT: same tenant members, except expired temps hidden
-- from non-uploaders/non-managers. Other policies (insert/update/delete)
-- unchanged below except where ownership sections replace them.
drop policy if exists "documents_select_members" on public.documents;
create policy "documents_select_members"
  on public.documents for select
  to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and not private.is_expired_temp_hidden(expires_at, created_by, tenant_id)
  );

-- Narrow chunks SELECT the same way (persistent + live temp + own expired).
drop policy if exists "chunks_select_members" on public.chunks;
create policy "chunks_select_members"
  on public.chunks for select
  to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and not private.chunk_hidden_from_caller(document_id)
  );

-- ---------------------------------------------------------------------------
-- 7. Ownership RLS (H-1/M-4)
-- ---------------------------------------------------------------------------
-- Reads stay tenant-wide (shared workspace corpus + transcript visibility).
-- Writes narrow to creator-or-manager so one member cannot rewrite or wipe
-- another's conversations, messages, documents, or spaces. Selection toggles
-- (notebook_sources) stay collaborative by design.

-- Conversations: update/delete by author or manager.
drop policy if exists "conversations_update_members" on public.conversations;
create policy "conversations_update_members"
  on public.conversations for update
  to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and (user_id = (select auth.uid()) or private.is_tenant_manager(tenant_id))
  )
  with check (
    private.is_tenant_member(tenant_id)
    and (user_id = (select auth.uid()) or private.is_tenant_manager(tenant_id))
  );
drop policy if exists "conversations_delete_members" on public.conversations;
create policy "conversations_delete_members"
  on public.conversations for delete
  to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and (user_id = (select auth.uid()) or private.is_tenant_manager(tenant_id))
  );

-- Messages: update/delete by conversation author or manager (messages carry
-- no user_id; ownership lives on the parent conversation). Insert stays
-- member-scoped (/ask + server edit RPC append).
drop policy if exists "messages_update_members" on public.messages;
create policy "messages_update_members"
  on public.messages for update
  to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and c.tenant_id = messages.tenant_id
        and (c.user_id = (select auth.uid()) or private.is_tenant_manager(messages.tenant_id))
    )
  )
  with check (
    private.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and c.tenant_id = messages.tenant_id
        and (c.user_id = (select auth.uid()) or private.is_tenant_manager(messages.tenant_id))
    )
  );
drop policy if exists "messages_delete_members" on public.messages;
create policy "messages_delete_members"
  on public.messages for delete
  to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and c.tenant_id = messages.tenant_id
        and (c.user_id = (select auth.uid()) or private.is_tenant_manager(messages.tenant_id))
    )
  );

-- Documents: delete by uploader or manager (retry/promote/update flows keep
-- their Edge-level checks; delete is the destructive one). Select/insert/
-- update policies unchanged (update further guarded by triggers above).
drop policy if exists "documents_delete_members" on public.documents;
create policy "documents_delete_members"
  on public.documents for delete
  to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and (created_by = (select auth.uid()) or private.is_tenant_manager(tenant_id))
  );

-- Notebooks: rename/delete by creator or manager; selection stays open.
drop policy if exists "notebooks_update_members" on public.notebooks;
create policy "notebooks_update_members"
  on public.notebooks for update
  to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and (created_by = (select auth.uid()) or private.is_tenant_manager(tenant_id))
  )
  with check (
    private.is_tenant_member(tenant_id)
    and (created_by = (select auth.uid()) or private.is_tenant_manager(tenant_id))
  );
drop policy if exists "notebooks_delete_members" on public.notebooks;
create policy "notebooks_delete_members"
  on public.notebooks for delete
  to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and (created_by = (select auth.uid()) or private.is_tenant_manager(tenant_id))
  );

-- ---------------------------------------------------------------------------
-- 8. Storage path pinning (M-12)
-- ---------------------------------------------------------------------------
-- Policies required tenants/<tid>/... but not docs/<doc>/<file>. Pin the
-- docs segment so members cannot stash arbitrary keys elsewhere in the
-- tenant prefix. Existing valid objects already live under docs/ (pipeline
-- invariant); nothing stored is moved.
drop policy if exists "company_docs_insert_members" on storage.objects;
create policy "company_docs_insert_members"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and (storage.foldername(name))[3] = 'docs'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  );
drop policy if exists "company_docs_select_members" on storage.objects;
create policy "company_docs_select_members"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and (storage.foldername(name))[3] = 'docs'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  );
drop policy if exists "company_docs_update_members" on storage.objects;
create policy "company_docs_update_members"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and (storage.foldername(name))[3] = 'docs'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  )
  with check (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and (storage.foldername(name))[3] = 'docs'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  );
drop policy if exists "company_docs_delete_members" on storage.objects;
create policy "company_docs_delete_members"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'company-documents'
    and (storage.foldername(name))[1] = 'tenants'
    and (storage.foldername(name))[3] = 'docs'
    and private.is_tenant_member(((storage.foldername(name))[2])::uuid)
  );

-- ---------------------------------------------------------------------------
-- 9. Least-privilege grants (M-11)
-- ---------------------------------------------------------------------------
-- Counters/benchmark partitions are SELECT-only for members by design
-- (policies already); revoke the over-broad table grants so a future stray
-- write policy cannot instantly allow forgery. service_role keeps full
-- access for pipeline writers.
revoke insert, update, delete on public.usage_counters from authenticated;
revoke insert, update, delete on public.benchmark_embeddings from authenticated;
revoke all on public.rate_limits from authenticated, anon, public;
-- Future tables must not inherit write access by default (M-11 fail-open).
-- Keep SELECT default off as well: new tables grant explicitly per migration.
alter default privileges for role postgres in schema public
  revoke insert, update, delete on tables from authenticated;

-- ---------------------------------------------------------------------------
-- 10. Atomic server-authorized edit (H-1/L-5)
-- ---------------------------------------------------------------------------
-- Single-transaction update + tail truncate with ownership enforced inside
-- the database (definer, fail closed). Only user-role rows may be rewritten
-- (assistant answers/citations are never edited in place — regeneration
-- replaces them). All ids must belong to one conversation in the caller's
-- tenant; anything else aborts with no partial write.
create or replace function public.edit_message(
  p_tenant_id uuid,
  p_conversation_id uuid,
  p_message_id uuid,
  p_content text,
  p_delete_ids uuid[]
)
returns table (edited_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_owner uuid;
  v_manager boolean;
  v_role text;
  v_conv_tenant uuid;
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if p_content is null or char_length(trim(p_content)) = 0
     or char_length(p_content) > 1000 then
    raise exception 'invalid content';
  end if;
  select c.user_id, c.tenant_id into v_owner, v_conv_tenant
  from public.conversations c where c.id = p_conversation_id;
  if not found or v_conv_tenant is distinct from p_tenant_id then
    raise exception 'conversation not found';
  end if;
  if not private.is_tenant_member(p_tenant_id) then
    raise exception 'not a member of this tenant';
  end if;
  v_manager := private.is_tenant_manager(p_tenant_id);
  if v_owner is distinct from v_caller and not v_manager then
    raise exception 'only the conversation owner or a workspace manager can edit';
  end if;
  select m.role into v_role from public.messages m
  where m.id = p_message_id
    and m.conversation_id = p_conversation_id
    and m.tenant_id = p_tenant_id;
  if not found then
    raise exception 'message not found';
  end if;
  if v_role <> 'user' then
    raise exception 'only user messages can be edited';
  end if;
  -- Tail ids, when given, must all belong to the same conversation/tenant.
  if p_delete_ids is not null and array_length(p_delete_ids, 1) is not null then
    if exists (
      select 1 from public.messages m
      where m.id = any (p_delete_ids)
        and (m.conversation_id is distinct from p_conversation_id
             or m.tenant_id is distinct from p_tenant_id)
    ) then
      raise exception 'delete set leaves this conversation';
    end if;
    delete from public.messages m
    where m.id = any (p_delete_ids)
      and m.id is distinct from p_message_id;
  end if;
  update public.messages m set content = p_content
  where m.id = p_message_id;
  return query select p_message_id;
end;
$$;
grant execute on function public.edit_message(uuid, uuid, uuid, text, uuid[])
  to authenticated;
revoke execute on function public.edit_message(uuid, uuid, uuid, text, uuid[])
  from anon, public;
