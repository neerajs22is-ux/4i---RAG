-- B2 — notebook-scoped retrieval: document filter for match_chunks.
--
-- Adds ONE optional parameter: the allowed document set. Everything else about
-- retrieval is untouched — same candidate counts (dense 20 / lexical 20, cap
-- 50), same ordering expressions, same channels. Fusion (RRF k=60) and the
-- final k=8 cut still happen in the Edge caller, unchanged.
--
--   p_document_ids IS NULL  -> exactly the previous behaviour (no filter)
--   p_document_ids = {...}  -> dense and lexical candidates are restricted to
--                              those documents; an empty array returns no rows
--
-- The tenant predicate and SECURITY INVOKER are preserved, so caller RLS and
-- the explicit tenant scope both still apply.
--
-- The 5-argument version is dropped rather than overloaded, so there is exactly
-- one match_chunks: a call that omits the new parameter cannot silently resolve
-- to an older, unscoped function.

drop function if exists public.match_chunks(uuid, vector, text, integer, integer);

create function public.match_chunks(
  p_tenant_id uuid,
  p_query_vector vector(1024),
  p_query_text text,
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
      and (p_document_ids is null or c.document_id = any (p_document_ids))
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

grant execute on function public.match_chunks(uuid, vector, text, integer, integer, uuid[])
  to authenticated;
