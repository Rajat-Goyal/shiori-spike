create or replace function public.conversation_meaningful_tokens(
  p_text text
)
returns table(token text)
language sql
immutable
set search_path = ''
as $$
  select distinct candidate.token
  from regexp_split_to_table(
    regexp_replace(
      lower(coalesce(p_text, '')),
      '[^a-z0-9]+',
      ' ',
      'g'
    ),
    '[[:space:]]+'
  ) as candidate(token)
  where
    char_length(candidate.token) >= 3
    and candidate.token not in (
      -- Commands.
      'change', 'edit', 'move', 'please', 'reschedule', 'set', 'update',
      -- Articles and generic referents.
      'the', 'this', 'that', 'one',
      -- Timing and relationship glue.
      'after', 'at', 'before', 'by', 'for', 'from', 'in', 'on', 'to',
      'with'
    );
$$;

revoke all on function public.conversation_meaningful_tokens(text)
  from public, anon, authenticated;

create or replace function public.resolve_conversation_draft_reference(
  p_query text,
  p_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_query text := btrim(p_query);
  exact_draft public.conversation_drafts;
  candidates jsonb;
  top_candidate_count integer;
  top_score integer;
begin
  if
    char_length(normalized_query) not between 1 and 500
    or p_limit not between 1 and 20
  then
    raise exception 'draft reference request is out of bounds';
  end if;

  -- A clarification selection carries the opaque candidate id. Never
  -- reinterpret a missing, expired, terminal, or foreign id as natural text.
  if normalized_query ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    select *
    into exact_draft
    from public.conversation_drafts as draft
    where
      draft.id = normalized_query::uuid
      and draft.owner_key
      and draft.state in ('active', 'parked')
      and draft.expires_at > now();

    if exact_draft.id is null then
      return jsonb_build_object('kind', 'none');
    end if;
    return jsonb_build_object(
      'kind', 'exact',
      'draft', public.conversation_draft_summary_json(exact_draft)
    );
  end if;

  with query_tokens as materialized (
    select token
    from public.conversation_meaningful_tokens(normalized_query)
  ),
  scored as materialized (
    select
      draft,
      (
        select count(*)::integer
        from query_tokens
        inner join public.conversation_meaningful_tokens(
          draft.definition_of_done
        ) as label_token using (token)
      ) as overlap_score
    from public.conversation_drafts as draft
    where
      draft.owner_key
      and draft.state in ('active', 'parked')
      and draft.expires_at > now()
  ),
  maximum as (
    select coalesce(max(overlap_score), 0) as score
    from scored
  ),
  top_matches as materialized (
    select scored.*
    from scored
    cross join maximum
    where maximum.score > 0 and scored.overlap_score = maximum.score
  ),
  bounded_matches as (
    select *
    from top_matches
    order by
      ((draft).state = 'active') desc,
      (draft).updated_at desc,
      (draft).id desc
    limit p_limit
  )
  select
    (select score from maximum),
    (select count(*)::integer from top_matches),
    coalesce(
      (
        select jsonb_agg(
          public.conversation_draft_summary_json(item.draft)
          order by
            ((item.draft).state = 'active') desc,
            (item.draft).updated_at desc,
            (item.draft).id desc
        )
        from bounded_matches as item
      ),
      '[]'::jsonb
    )
  into top_score, top_candidate_count, candidates;

  if top_score = 0 or top_candidate_count = 0 then
    return jsonb_build_object('kind', 'none');
  end if;
  if top_candidate_count = 1 then
    return jsonb_build_object(
      'kind', 'exact',
      'draft', candidates -> 0
    );
  end if;
  return jsonb_build_object(
    'kind', 'ambiguous',
    'candidates', candidates
  );
end;
$$;

revoke all on function public.resolve_conversation_draft_reference(
  text, integer
) from public, anon, authenticated;
grant execute on function public.resolve_conversation_draft_reference(
  text, integer
) to service_role;
