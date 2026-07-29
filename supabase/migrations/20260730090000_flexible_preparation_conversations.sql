alter table public.conversation_drafts
  drop constraint conversation_drafts_duration_check,
  add constraint conversation_drafts_duration_check check (
    duration_minutes is null
    or duration_minutes between 1 and 1440
  ),
  drop constraint conversation_drafts_selection_check,
  add constraint conversation_drafts_selection_check check (
    (selected_start_at is null) = (selected_end_at is null)
    and (
      selected_start_at is null
      or (
        selected_start_at ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:(00|30):00[+]08:00$'
        and selected_end_at ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-5][0-9]:00[+]08:00$'
        and selected_end_at::timestamptz > selected_start_at::timestamptz
      )
    )
  );

alter table public.conversation_work_session_options
  drop constraint conversation_work_session_options_check,
  add constraint conversation_work_session_options_check check (
    end_at ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-5][0-9]:00[+]08:00$'
    and end_at::timestamptz > start_at::timestamptz
  );

alter table public.work_sessions
  drop constraint work_sessions_duration_minutes_check,
  add constraint work_sessions_duration_minutes_check check (
    duration_minutes between 1 and 1440
  );

create or replace function public.work_session_window_is_valid(
  p_window jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  return
    jsonb_typeof(p_window) = 'object'
    and (
      select count(*) from jsonb_object_keys(p_window)
    ) = 2
    and p_window ?& array['startAt', 'endAt']
    and p_window->>'startAt' ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:(00|30):00[+]08:00$'
    and p_window->>'endAt' ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-5][0-9]:00[+]08:00$'
    and (p_window->>'endAt')::timestamptz >
      (p_window->>'startAt')::timestamptz;
exception
  when others then
    return false;
end;
$$;

do $$
declare
  definition text;
begin
  definition := pg_get_functiondef(
    'public.transition_work_session_draft(bigint,bigint,text,uuid,integer,text,text,integer,text,jsonb,jsonb,timestamptz,timestamptz,boolean,text,boolean)'::regprocedure
  );
  definition := replace(
    definition,
    'p_duration_minutes not in (30, 60, 90, 120)',
    'p_duration_minutes not between 1 and 1440'
  );
  if definition like '%not in (30, 60, 90, 120)%' then
    raise exception 'transition duration replacement was incomplete';
  end if;
  execute definition;

  definition := pg_get_functiondef(
    'public.confirm_work_session(bigint,bigint,text,uuid,integer,text,text,timestamptz,timestamptz,boolean,text,text)'::regprocedure
  );
  definition := replace(
    definition,
    'current_draft.duration_minutes not in (30, 60, 90, 120)',
    'current_draft.duration_minutes not between 1 and 1440'
  );
  if definition like '%not in (30, 60, 90, 120)%' then
    raise exception 'confirmation duration replacement was incomplete';
  end if;
  execute definition;

  definition := pg_get_functiondef(
    'public.apply_approved_commitment_change(bigint,bigint,text,uuid,integer,text,timestamptz,boolean,timestamptz,timestamptz,integer,text,timestamptz,timestamptz,boolean,text,text)'::regprocedure
  );
  definition := replace(
    definition,
    'p_next_duration_minutes not in (30, 60, 90, 120)',
    'p_next_duration_minutes not between 1 and 1440'
  );
  if definition like '%not in (30, 60, 90, 120)%' then
    raise exception 'commitment edit duration replacement was incomplete';
  end if;
  execute definition;
end;
$$;

create function public.transition_work_session_draft_from_conversation(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_draft_id uuid,
  p_version integer,
  p_expected_stage text,
  p_next_stage text,
  p_duration_minutes integer,
  p_timing_constraints text,
  p_selected_window jsonb,
  p_options jsonb,
  p_calendar_attempted_at timestamptz,
  p_calendar_checked_at timestamptz,
  p_conflict_consent boolean,
  p_final_observation text,
  p_is_cancel boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.telegram_updates
  where
    update_id = p_update_id
    and processing_status = 'claimed'
    and is_owner_private
  for update;
  if not found then
    return jsonb_build_object('kind', 'replay');
  end if;

  delete from public.telegram_updates
  where update_id = p_update_id;

  return public.transition_work_session_draft(
    p_update_id,
    p_owner_chat_id,
    p_owner_id,
    p_draft_id,
    p_version,
    p_expected_stage,
    p_next_stage,
    p_duration_minutes,
    p_timing_constraints,
    p_selected_window,
    p_options,
    p_calendar_attempted_at,
    p_calendar_checked_at,
    p_conflict_consent,
    p_final_observation,
    p_is_cancel
  );
end;
$$;

create function public.decline_work_session_preparation_from_conversation(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_draft_id uuid,
  p_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.telegram_updates
  where
    update_id = p_update_id
    and processing_status = 'claimed'
    and is_owner_private
  for update;
  if not found then
    return jsonb_build_object('kind', 'replay');
  end if;

  delete from public.telegram_updates
  where update_id = p_update_id;

  return public.decline_work_session_preparation(
    p_update_id,
    p_owner_chat_id,
    p_owner_id,
    p_draft_id,
    p_version
  );
end;
$$;

revoke all on function public.transition_work_session_draft_from_conversation(
  bigint, bigint, text, uuid, integer, text, text, integer, text, jsonb,
  jsonb, timestamptz, timestamptz, boolean, text, boolean
) from public, anon, authenticated;
revoke all on function
  public.decline_work_session_preparation_from_conversation(
    bigint, bigint, text, uuid, integer
  )
  from public, anon, authenticated;
grant execute on function
  public.transition_work_session_draft_from_conversation(
    bigint, bigint, text, uuid, integer, text, text, integer, text, jsonb,
    jsonb, timestamptz, timestamptz, boolean, text, boolean
  )
  to service_role;
grant execute on function
  public.decline_work_session_preparation_from_conversation(
    bigint, bigint, text, uuid, integer
  )
  to service_role;

alter function public.read_agent_product_context(
  text, uuid, integer
) rename to read_agent_product_context_before_flexible_preparation;

revoke all on function
  public.read_agent_product_context_before_flexible_preparation(
    text, uuid, integer
  )
  from public, anon, authenticated, service_role;

create function public.read_agent_product_context(
  p_owner_id text,
  p_focused_entity_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  result jsonb;
  drafts jsonb;
  focused jsonb;
begin
  result :=
    public.read_agent_product_context_before_flexible_preparation(
      p_owner_id,
      p_focused_entity_id,
      p_limit
    );

  select coalesce(
    jsonb_agg(
      item || jsonb_build_object(
        'preparation',
        case
          when draft.possible_work_session then
            jsonb_build_object(
              'stage', draft.work_session_stage,
              'durationMinutes', draft.duration_minutes,
              'timingConstraints',
                case
                  when cardinality(draft.timing_constraints) = 0 then null
                  else array_to_string(draft.timing_constraints, E'\n')
                end,
              'selectedStartAt', draft.selected_start_at,
              'selectedEndAt', draft.selected_end_at
            )
          else null
        end
      )
      order by ordinal
    ),
    '[]'::jsonb
  )
  into drafts
  from jsonb_array_elements(result->'drafts')
    with ordinality as listed(item, ordinal)
  join public.conversation_drafts as draft
    on draft.id::text = item->>'id';

  result := jsonb_set(result, '{drafts}', drafts);
  focused := result->'focusedEntity';
  if focused->>'kind' = 'draft' then
    select jsonb_build_object('kind', 'draft', 'entity', item)
    into focused
    from jsonb_array_elements(drafts) as item
    where item->>'id' = focused->'entity'->>'id';
    result := jsonb_set(
      result,
      '{focusedEntity}',
      coalesce(focused, 'null'::jsonb)
    );
  end if;

  return result;
end;
$$;

revoke all on function public.read_agent_product_context(
  text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.read_agent_product_context(
  text, uuid, integer
) to service_role;
