create function public.work_session_timestamptz_window_is_valid(
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_duration_minutes integer
)
returns boolean
language sql
immutable
set search_path = ''
return
  p_start_at is not null
  and p_end_at is not null
  and p_duration_minutes between 1 and 1440
  and extract(
    minute from p_start_at at time zone 'Asia/Singapore'
  ) in (0, 30)
  and extract(
    second from p_start_at at time zone 'Asia/Singapore'
  ) = 0
  and p_end_at =
    p_start_at + p_duration_minutes * interval '1 minute';

revoke all on function public.work_session_timestamptz_window_is_valid(
  timestamptz, timestamptz, integer
) from public, anon, authenticated;

create or replace function public.conversation_decision_payload_is_valid(
  p_payload jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    jsonb_typeof(p_payload) = 'object'
    and (
      select count(*)
      from jsonb_object_keys(p_payload)
    ) = 11
    and p_payload ?& array[
      'definitionOfDone',
      'durationMinutes',
      'missingFields',
      'nextAction',
      'offerWorkWindowHelp',
      'possibleWorkSession',
      'simpleAction',
      'targetAt',
      'targetTimeZone',
      'timingConstraints',
      'turnRelation'
    ]
    and (
      p_payload->'definitionOfDone' = 'null'::jsonb
      or (
        jsonb_typeof(p_payload->'definitionOfDone') = 'string'
        and char_length(btrim(p_payload->>'definitionOfDone')) > 0
        and char_length(p_payload->>'definitionOfDone') <= 500
      )
    )
    and (
      p_payload->'durationMinutes' = 'null'::jsonb
      or (
        jsonb_typeof(p_payload->'durationMinutes') = 'number'
        and mod(
          (p_payload->>'durationMinutes')::numeric,
          1
        ) = 0
        and (p_payload->>'durationMinutes')::numeric between 1 and 1440
      )
    )
    and jsonb_typeof(p_payload->'offerWorkWindowHelp') = 'boolean'
    and jsonb_typeof(p_payload->'possibleWorkSession') = 'boolean'
    and jsonb_typeof(p_payload->'simpleAction') = 'boolean'
    and (
      p_payload->'targetAt' = 'null'::jsonb
      or (
        jsonb_typeof(p_payload->'targetAt') = 'string'
        and p_payload->>'targetAt' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+]08:00$'
      )
    )
    and (
      p_payload->'targetTimeZone' = 'null'::jsonb
      or (
        jsonb_typeof(p_payload->'targetTimeZone') = 'string'
        and p_payload->>'targetTimeZone' = 'Asia/Singapore'
      )
    )
    and (
      (p_payload->'targetAt' = 'null'::jsonb)
      =
      (p_payload->'targetTimeZone' = 'null'::jsonb)
    )
    and jsonb_typeof(p_payload->'timingConstraints') = 'array'
    and jsonb_array_length(p_payload->'timingConstraints') <= 4
    and not exists (
      select 1
      from jsonb_array_elements(
        p_payload->'timingConstraints'
      ) as item
      where
        jsonb_typeof(item) <> 'string'
        or char_length(btrim(item #>> '{}')) = 0
        or char_length(item #>> '{}') > 200
    )
    and jsonb_typeof(p_payload->'missingFields') = 'array'
    and p_payload->'missingFields' in (
      '[]'::jsonb,
      '["definition_of_done"]'::jsonb,
      '["target"]'::jsonb,
      '["definition_of_done", "target"]'::jsonb
    )
    and p_payload->>'nextAction' in (
      'ask_definition',
      'ask_target',
      'ask_permission',
      'answer',
      'ready',
      'offer_work_window',
      'ask_duration'
    )
    and p_payload->>'turnRelation' in (
      'none',
      'new_request',
      'clarification_continuation',
      'correction',
      'separate_request',
      'permission_accepted',
      'permission_declined'
    );
$$;

alter table public.conversation_drafts
  drop constraint conversation_drafts_selection_check,
  add constraint conversation_drafts_selection_check check (
    (
      selected_start_at is null
      and selected_end_at is null
    )
    or public.work_session_timestamptz_window_is_valid(
      selected_start_at::timestamptz,
      selected_end_at::timestamptz,
      duration_minutes
    )
  );

do $$
declare
  definition text;
  original_claim text := $claim$
  insert into public.telegram_updates (
    update_id,
    processing_status,
    is_owner_private
  )
  values (p_update_id, 'claimed', true)
  on conflict (update_id) do nothing
  returning true into claimed;

  if not coalesce(claimed, false) then
    return jsonb_build_object('kind', 'replay');
  end if;$claim$;
  reusable_claim text := $claim$
  select true
  into claimed
  from public.telegram_updates
  where
    update_id = p_update_id
    and processing_status = 'claimed'
    and is_owner_private
  for update;

  if not coalesce(claimed, false) then
    insert into public.telegram_updates (
      update_id,
      processing_status,
      is_owner_private
    )
    values (p_update_id, 'claimed', true)
    on conflict (update_id) do nothing
    returning true into claimed;
  end if;

  if not coalesce(claimed, false) then
    return jsonb_build_object('kind', 'replay');
  end if;$claim$;
begin
  definition := pg_get_functiondef(
    'public.transition_work_session_draft(bigint,bigint,text,uuid,integer,text,text,integer,text,jsonb,jsonb,timestamptz,timestamptz,boolean,text,boolean)'::regprocedure
  );
  definition := replace(
    definition,
    original_claim,
    reusable_claim
  );
  if definition not like '%' || reusable_claim || '%' then
    raise exception
      'work-session transition claim replacement was incomplete';
  end if;
  execute definition;

  definition := pg_get_functiondef(
    'public.decline_work_session_preparation(bigint,bigint,text,uuid,integer)'::regprocedure
  );
  definition := replace(
    definition,
    original_claim,
    reusable_claim
  );
  if definition not like '%' || reusable_claim || '%' then
    raise exception
      'work-session decline claim replacement was incomplete';
  end if;
  execute definition;
end;
$$;

create or replace function public.transition_work_session_draft_from_conversation(
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
declare
  reusable boolean := false;
begin
  select true
  into reusable
  from public.telegram_updates as update
  where
    update.update_id = p_update_id
    and update.is_owner_private
    and (
      update.processing_status = 'claimed'
      or (
        update.processing_status = 'processed'
        and update.processing_result = 'conversation'
        and exists (
          select 1
          from public.conversation_drafts as draft
          where
            draft.id = p_draft_id
            and draft.version = p_version
            and draft.last_update_id = p_update_id
            and draft.state = 'active'
        )
      )
    )
  for update;
  if not coalesce(reusable, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  update public.telegram_updates
  set
    processing_status = 'claimed',
    processing_result = null,
    processed_at = null,
    resolved_action_key = null
  where
    update_id = p_update_id
    and processing_status = 'processed'
    and processing_result = 'conversation';

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

create or replace function
  public.decline_work_session_preparation_from_conversation(
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
declare
  reusable boolean := false;
begin
  select true
  into reusable
  from public.telegram_updates as update
  where
    update.update_id = p_update_id
    and update.is_owner_private
    and (
      update.processing_status = 'claimed'
      or (
        update.processing_status = 'processed'
        and update.processing_result = 'conversation'
        and exists (
          select 1
          from public.conversation_drafts as draft
          where
            draft.id = p_draft_id
            and draft.version = p_version
            and draft.last_update_id = p_update_id
            and draft.state = 'active'
        )
      )
    )
  for update;
  if not coalesce(reusable, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  update public.telegram_updates
  set
    processing_status = 'claimed',
    processing_result = null,
    processed_at = null,
    resolved_action_key = null
  where
    update_id = p_update_id
    and processing_status = 'processed'
    and processing_result = 'conversation';

  return public.decline_work_session_preparation(
    p_update_id,
    p_owner_chat_id,
    p_owner_id,
    p_draft_id,
    p_version
  );
end;
$$;

alter table public.work_sessions
  drop constraint work_sessions_window_check,
  add constraint work_sessions_window_check check (
    public.work_session_timestamptz_window_is_valid(
      start_at,
      end_at,
      duration_minutes
    )
  );

alter table public.work_session_continuation_intents
  drop constraint work_session_continuation_intents_duration_minutes_check,
  add constraint work_session_continuation_intents_duration_minutes_check
    check (
      duration_minutes is null
      or duration_minutes between 1 and 1440
    ),
  drop constraint work_session_continuation_selection_check,
  add constraint work_session_continuation_selection_check check (
    (
      selected_start_at is null
      and selected_end_at is null
    )
    or public.work_session_timestamptz_window_is_valid(
      selected_start_at,
      selected_end_at,
      duration_minutes
    )
  );

do $$
declare
  definition text;
begin
  definition := pg_get_functiondef(
    'public.transition_work_session_continuation(bigint,bigint,text,uuid,integer,text,text,text,integer,jsonb,timestamptz,timestamptz,boolean,timestamptz,timestamptz,text)'::regprocedure
  );
  definition := replace(
    definition,
    'p_duration_minutes not in (30, 60, 90, 120)',
    'p_duration_minutes not between 1 and 1440'
  );
  if definition like '%not in (30, 60, 90, 120)%' then
    raise exception 'continuation transition duration replacement incomplete';
  end if;
  execute definition;

  definition := pg_get_functiondef(
    'public.confirm_work_session_continuation_final_state(bigint,bigint,text,uuid,integer,text,timestamptz,timestamptz,text,text)'::regprocedure
  );
  definition := replace(
    definition,
    'current_intent.duration_minutes not in (30, 60, 90, 120)',
    'current_intent.duration_minutes not between 1 and 1440'
  );
  definition := replace(
    definition,
    'or current_intent.selected_start_at is null',
    'or not public.work_session_timestamptz_window_is_valid(' ||
      'current_intent.selected_start_at, ' ||
      'current_intent.selected_end_at, ' ||
      'current_intent.duration_minutes)' || E'\n    ' ||
      'or current_intent.selected_start_at is null'
  );
  if definition like '%not in (30, 60, 90, 120)%' then
    raise exception 'continuation confirmation duration replacement incomplete';
  end if;
  execute definition;

  definition := pg_get_functiondef(
    'public.apply_approved_commitment_change(bigint,bigint,text,uuid,integer,text,timestamptz,boolean,timestamptz,timestamptz,integer,text,timestamptz,timestamptz,boolean,text,text)'::regprocedure
  );
  definition := replace(
    definition,
    'or p_next_start_at <= action_at',
    'or not public.work_session_timestamptz_window_is_valid(' ||
      'p_next_start_at, p_next_end_at, p_next_duration_minutes)' ||
      E'\n        ' || 'or p_next_start_at <= action_at'
  );
  execute definition;
end;
$$;

create function public.finalize_work_session_conversation_turn(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_draft_id uuid,
  p_version integer,
  p_result text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  completed boolean := false;
begin
  perform 1
  from public.telegram_owner_delivery
  where singleton and private_chat_id = p_owner_chat_id
  for update;
  if (
    not found
    or p_owner_id is null
    or p_owner_id <> p_owner_chat_id::text
    or p_draft_id is null
    or p_version is null
    or p_version < 1
    or p_result not in ('domain_error', 'expired', 'invalid', 'stale')
  ) then
    raise exception 'invalid work-session conversation finalization';
  end if;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = case p_result
      when 'domain_error' then 'failed'
      when 'expired' then 'work_session_draft_expired'
      when 'invalid' then 'unsupported'
      else 'work_session_draft_stale'
    end,
    processed_at = clock_timestamp()
  where
    update_id = p_update_id
    and processing_status = 'claimed'
    and is_owner_private
  returning true into completed;

  return jsonb_build_object(
    'kind',
    case when coalesce(completed, false) then 'applied' else 'replay' end
  );
end;
$$;

create function public.finalize_work_session_continuation_conversation_turn(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_intent_id uuid,
  p_version integer,
  p_result text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  completed boolean := false;
begin
  perform 1
  from public.telegram_owner_delivery
  where singleton and private_chat_id = p_owner_chat_id
  for update;
  if (
    not found
    or p_owner_id is null
    or p_owner_id <> p_owner_chat_id::text
    or p_intent_id is null
    or p_version is null
    or p_version < 1
    or p_result not in ('domain_error', 'expired', 'invalid', 'stale')
  ) then
    raise exception 'invalid continuation conversation finalization';
  end if;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = case p_result
      when 'domain_error' then 'failed'
      when 'expired' then 'work_session_continuation_expired'
      when 'invalid' then 'unsupported'
      else 'work_session_continuation_stale'
    end,
    processed_at = clock_timestamp()
  where
    update_id = p_update_id
    and processing_status = 'claimed'
    and is_owner_private
  returning true into completed;

  return jsonb_build_object(
    'kind',
    case when coalesce(completed, false) then 'applied' else 'replay' end
  );
end;
$$;

create function public.transition_work_session_continuation_from_conversation(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_intent_id uuid,
  p_version integer,
  p_expected_stage text,
  p_next_stage text,
  p_action text,
  p_duration_minutes integer default null,
  p_options jsonb default null,
  p_selected_start_at timestamptz default null,
  p_selected_end_at timestamptz default null,
  p_is_recovery boolean default null,
  p_calendar_attempted_at timestamptz default null,
  p_calendar_checked_at timestamptz default null,
  p_final_observation text default null
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

  delete from public.telegram_updates where update_id = p_update_id;

  return public.transition_work_session_continuation(
    p_update_id,
    p_owner_chat_id,
    p_owner_id,
    p_intent_id,
    p_version,
    p_expected_stage,
    p_next_stage,
    p_action,
    p_duration_minutes,
    p_options,
    p_selected_start_at,
    p_selected_end_at,
    p_is_recovery,
    p_calendar_attempted_at,
    p_calendar_checked_at,
    p_final_observation
  );
end;
$$;

revoke all on function public.finalize_work_session_conversation_turn(
  bigint, bigint, text, uuid, integer, text
) from public, anon, authenticated;
revoke all on function
  public.finalize_work_session_continuation_conversation_turn(
    bigint, bigint, text, uuid, integer, text
  )
  from public, anon, authenticated;
revoke all on function
  public.transition_work_session_continuation_from_conversation(
    bigint, bigint, text, uuid, integer, text, text, text, integer, jsonb,
    timestamptz, timestamptz, boolean, timestamptz, timestamptz, text
  )
  from public, anon, authenticated;

grant execute on function public.finalize_work_session_conversation_turn(
  bigint, bigint, text, uuid, integer, text
) to service_role;
grant execute on function
  public.finalize_work_session_continuation_conversation_turn(
    bigint, bigint, text, uuid, integer, text
  )
  to service_role;
grant execute on function
  public.transition_work_session_continuation_from_conversation(
    bigint, bigint, text, uuid, integer, text, text, text, integer, jsonb,
    timestamptz, timestamptz, boolean, timestamptz, timestamptz, text
  )
  to service_role;

alter function public.read_agent_product_context(
  text, uuid, integer
) rename to read_agent_product_context_before_continuations;

revoke all on function
  public.read_agent_product_context_before_continuations(
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
begin
  result := public.read_agent_product_context_before_continuations(
    p_owner_id,
    p_focused_entity_id,
    p_limit
  );

  return jsonb_set(
    result,
    '{continuations}',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', intent.id,
            'version', intent.version,
            'commitmentId', intent.commitment_id,
            'stage', intent.stage,
            'durationMinutes', intent.duration_minutes,
            'targetAt', commitment.target_at,
            'timingConstraints', intent.timing_constraints
          )
          order by intent.created_at desc, intent.id
        )
        from (
          select candidate.*
          from public.work_session_continuation_intents as candidate
          join public.commitments as owned
            on owned.id = candidate.commitment_id
          where
            owned.owner_id = p_owner_id
            and candidate.stage in (
              'awaiting_duration',
              'offer',
              'choosing',
              'confirming',
              'conflict_choice',
              'unverified_confirming'
            )
          order by candidate.created_at desc, candidate.id
          limit least(5, p_limit)
        ) as intent
        join public.commitments as commitment
          on commitment.id = intent.commitment_id
      ),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.read_agent_product_context(
  text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.read_agent_product_context(
  text, uuid, integer
) to service_role;
