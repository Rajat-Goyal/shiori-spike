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
  candidate_count integer;
begin
  if
    char_length(normalized_query) not between 1 and 500
    or p_limit not between 1 and 20
  then
    raise exception 'draft reference request is out of bounds';
  end if;

  -- A clarification selection carries the opaque candidate id. Never
  -- reinterpret a missing, expired, terminal, or foreign id as fuzzy text.
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

  with matching as (
    select draft.*
    from public.conversation_drafts as draft
    where
      draft.owner_key
      and draft.state in ('active', 'parked')
      and draft.expires_at > now()
      and position(
        lower(normalized_query)
        in lower(coalesce(draft.definition_of_done, ''))
      ) > 0
    order by
      (draft.state = 'active') desc,
      draft.updated_at desc,
      draft.id desc
    limit p_limit
  )
  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        public.conversation_draft_summary_json(item)
        order by
          (item.state = 'active') desc,
          item.updated_at desc,
          item.id desc
      ),
      '[]'::jsonb
    )
  into candidate_count, candidates
  from matching as item;

  if candidate_count = 0 then
    return jsonb_build_object('kind', 'none');
  end if;
  if candidate_count = 1 then
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
