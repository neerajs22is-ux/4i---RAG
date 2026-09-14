-- Phase 3B.1 — hybrid retrieval RPC (additive; no table/policy changes).
--
-- match_chunks returns tenant-scoped dense + lexical candidate sets in ONE
-- round trip; deterministic fusion happens in the Edge caller. SECURITY
-- INVOKER so the caller's RLS applies on top of the explicit tenant
-- predicates below (anon callers see nothing: no anon RLS policy exists).
-- Unembedded rows never enter the dense branch (embedding IS NOT NULL).
-- Iterative scan is set per-transaction (relaxed_order) so selective tenant
-- filters still return full candidate sets; no index or GUC changes needed.

create or replace function public.match_chunks(
  p_tenant_id uuid,
  p_query_vector vector(1024),
  p_query_text text,
  p_dense_n integer default 20,
  p_lex_n integer default 20
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
      (1 - (c.embedding <=> p_query_vector))::float8 as ds,
      row_number() over (order by c.embedding <=> p_query_vector asc) as dr
    from public.chunks as c
    where c.tenant_id = p_tenant_id
      and c.embedding is not null
    order by c.embedding <=> p_query_vector asc
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

-- Explicit execute grant (defense in depth; functions default to PUBLIC
-- execute, but tenant data stays protected by INVOKER RLS + predicates).
grant execute on function public.match_chunks(uuid, vector, text, integer, integer)
  to authenticated;
