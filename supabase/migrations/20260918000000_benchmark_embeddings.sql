-- Benchmark-only Jina vector storage + retrieval mirror (Step 3).
--
-- ADDITIVE ONLY. This migration creates benchmark-only objects and touches
-- nothing that production reads or writes:
--   - no ALTER/DROP on public.chunks, public.documents, or any index;
--   - no change to public.match_chunks or any other production function;
--   - no change to RLS policies on production tables;
--   - no embedding-provider constants for production.
--
-- Production chunks.embedding, documents.embedding_model and match_chunks keep
-- serving Voyage-only traffic. Benchmark dense retrieval reads exclusively
-- from public.benchmark_embeddings through public.benchmark_match_chunks, so a
-- Jina vector can never enter the production candidate set.
--
-- Lexical retrieval and provenance (chunk_id/document_id/tenant/file/page/
-- content) are read from the existing production chunks rows; chunks are never
-- written here.

-- ---------------------------------------------------------------------------
-- 1. Benchmark-only vector partition
-- ---------------------------------------------------------------------------

create table if not exists public.benchmark_embeddings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  chunk_id text not null,
  provider text not null,
  model text not null,
  dimensions integer not null,
  embedding vector(1024) not null,
  benchmark_run_id text not null,
  created_at timestamptz not null default now(),
  constraint benchmark_embeddings_provider_check
    check (provider in ('jina', 'benchmark-fixture')),
  constraint benchmark_embeddings_model_check
    check (
      (provider = 'jina' and model = 'jina-embeddings-v5-text-small') or
      (provider = 'benchmark-fixture')
    ),
  constraint benchmark_embeddings_dimensions_check
    check (dimensions = 1024),
  constraint benchmark_embeddings_run_check
    check (benchmark_run_id <> ''),
  constraint benchmark_embeddings_identity_unique
    unique (tenant_id, chunk_id, provider, model, benchmark_run_id)
);

comment on table public.benchmark_embeddings is
  'Benchmark-only embedding vectors (never production retrieval state). One row per chunk/provider/model/run; the natural key prevents duplicate or mixed-provider writes.';

-- Same index discipline as production: cosine HNSW for the dense branch.
create index if not exists benchmark_embeddings_hnsw_idx
  on public.benchmark_embeddings
  using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 2. Tenant isolation: reads for benchmark retrieval under caller membership.
--    Production member writes are intentionally NOT granted here; benchmark
--    population runs through a privileged executor in a later authorized step.
-- ---------------------------------------------------------------------------

alter table public.benchmark_embeddings enable row level security;

drop policy if exists "benchmark_embeddings_select_members"
  on public.benchmark_embeddings;
create policy "benchmark_embeddings_select_members"
  on public.benchmark_embeddings for select
  to authenticated
  using (private.is_tenant_member(tenant_id));

grant select on public.benchmark_embeddings to authenticated;
grant select, insert, update, delete on public.benchmark_embeddings to service_role;

-- ---------------------------------------------------------------------------
-- 3. Benchmark-only retrieval mirror.
--
-- Same contract as public.match_chunks (B2), except the dense branch reads
-- public.benchmark_embeddings for one explicit (provider, model, run) triple
-- instead of public.chunks.embedding. Lexical retrieval, candidate counts,
-- channel labels, ordering expressions and the SECURITY INVOKER + tenant
-- scope are identical. The production function is untouched.
-- ---------------------------------------------------------------------------

create or replace function public.benchmark_match_chunks(
  p_tenant_id uuid,
  p_query_vector vector(1024),
  p_query_text text,
  p_provider text,
  p_model text,
  p_benchmark_run_id text,
  p_dense_n integer default 20,
  p_lex_n integer default 20,
  p_document_ids uuid[] default null
)
returns table (
  chunk_id text,
  document_id uuid,
  tenant_id uuid,
  file_name text,
  page integer,
  content text,
  dense_score double precision,
  dense_rank bigint,
  lex_score real,
  lex_rank bigint,
  channel text
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_provider is null or p_provider <> 'jina' then
    raise exception 'benchmark_match_chunks supports only the jina benchmark partition';
  end if;
  if p_model is null or p_model <> 'jina-embeddings-v5-text-small' then
    raise exception 'benchmark_match_chunks supports only jina-embeddings-v5-text-small';
  end if;
  if p_benchmark_run_id is null or p_benchmark_run_id = '' then
    raise exception 'benchmark_run_id is required';
  end if;

  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);

  return query
  with dense as (
    select
      c.chunk_id,
      c.document_id,
      c.tenant_id,
      c.file_name,
      c.page,
      c.content,
      (1 - (b.embedding <=> p_query_vector))::float8 as ds,
      row_number() over (order by b.embedding <=> p_query_vector asc) as dr
    from public.benchmark_embeddings as b
    join public.chunks as c
      on c.tenant_id = b.tenant_id
     and c.chunk_id = b.chunk_id
    where b.tenant_id = p_tenant_id
      and b.provider = p_provider
      and b.model = p_model
      and b.benchmark_run_id = p_benchmark_run_id
      and c.tenant_id = p_tenant_id
      and (p_document_ids is null or c.document_id = any (p_document_ids))
    order by b.embedding <=> p_query_vector asc
    limit greatest(1, least(50, p_dense_n))
  ),
  lex as (
    select
      c.chunk_id,
      c.document_id,
      c.tenant_id,
      c.file_name,
      c.page,
      c.content,
      ts_rank_cd(c.content_tsv, plainto_tsquery('english', p_query_text)) as ls,
      row_number() over (
        order by ts_rank_cd(c.content_tsv, plainto_tsquery('english', p_query_text)) desc
      ) as lr
    from public.chunks as c
    where c.tenant_id = p_tenant_id
      and c.content_tsv @@ plainto_tsquery('english', p_query_text)
      and (p_document_ids is null or c.document_id = any (p_document_ids))
    order by ls desc
    limit greatest(1, least(50, p_lex_n))
  )
  select d.chunk_id, d.document_id, d.tenant_id, d.file_name, d.page,
    d.content, d.ds, d.dr, null::real, null::bigint, 'dense'::text
  from dense as d
  union all
  select l.chunk_id, l.document_id, l.tenant_id, l.file_name, l.page,
    l.content, null::float8, null::bigint, l.ls, l.lr, 'lexical'::text
  from lex as l;
end;
$$;

grant execute on function public.benchmark_match_chunks(uuid, vector, text, text, text, text, integer, integer, uuid[])
  to authenticated;
