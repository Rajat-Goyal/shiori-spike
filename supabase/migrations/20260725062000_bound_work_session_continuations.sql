alter table public.work_session_continuation_intents
  drop constraint work_session_continuation_intents_stage_check,
  drop constraint work_session_continuation_resolution_check,
  add column expires_at timestamptz,
  add column calendar_attempted_at timestamptz,
  add column calendar_checked_at timestamptz,
  add column final_calendar_observation text check (
    final_calendar_observation is null
    or final_calendar_observation in ('free', 'conflict', 'unavailable')
  );

update public.work_session_continuation_intents
set expires_at = created_at + interval '24 hours'
where expires_at is null;

alter table public.work_session_continuation_intents
  alter column expires_at set not null,
  alter column expires_at set default (now() + interval '24 hours'),
  add constraint work_session_continuation_intents_expiry_check check (
    expires_at = created_at + interval '24 hours'
  ),
  add constraint work_session_continuation_intents_stage_check check (
    stage in (
      'awaiting_duration',
      'offer',
      'choosing',
      'confirming',
      'conflict_choice',
      'unverified_confirming',
      'confirmed',
      'declined',
      'stale'
    )
  ),
  add constraint work_session_continuation_resolution_check check (
    (
      stage in (
        'awaiting_duration',
        'offer',
        'choosing',
        'confirming',
        'conflict_choice',
        'unverified_confirming'
      )
      and resolved_at is null
    )
    or (
      stage in ('confirmed', 'declined', 'stale')
      and resolved_at is not null
    )
  );

drop index public.work_session_one_active_continuation_idx;
create unique index work_session_one_active_continuation_idx
  on public.work_session_continuation_intents (commitment_id)
  where stage in (
    'awaiting_duration',
    'offer',
    'choosing',
    'confirming',
    'conflict_choice',
    'unverified_confirming'
  );

alter table public.telegram_updates
  drop constraint telegram_updates_processing_result_check;

alter table public.telegram_updates
  add constraint telegram_updates_processing_result_check check (
    processing_result is null
    or processing_result in (
      'failed',
      'ignored',
      'refused',
      'status_empty',
      'status_listed',
      'unsupported',
      'conversation',
      'conversation_busy',
      'conversation_expired',
      'conversation_failed',
      'conversation_interrupted',
      'conversation_stale',
      'confirmation_cancelled',
      'confirmation_confirmed',
      'confirmation_expired',
      'confirmation_malformed',
      'confirmation_resolved',
      'confirmation_stale',
      'reminder_cancel_deferred',
      'reminder_done',
      'reminder_malformed',
      'reminder_resolved',
      'reminder_stale',
      'cancellation_cancelled',
      'cancellation_kept',
      'cancellation_malformed',
      'cancellation_resolved',
      'cancellation_stale',
      'work_session_confirmed',
      'work_session_draft_cancelled',
      'work_session_draft_expired',
      'work_session_draft_resolved',
      'work_session_draft_stale',
      'work_session_done',
      'work_session_more_work_needed',
      'work_session_missed',
      'work_session_outcome_malformed',
      'work_session_outcome_resolved',
      'work_session_outcome_stale',
      'work_session_continuation_declined',
      'work_session_continuation_resolved',
      'work_session_continuation_stale',
      'work_session_continuation_expired',
      'work_session_continuation_confirmed'
    )
  );

create or replace function public.work_session_continuation_snapshot(
  p_intent public.work_session_continuation_intents
)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'id', p_intent.id,
    'version', p_intent.version,
    'stage', p_intent.stage,
    'commitmentId', commitment.id,
    'definitionOfDone', commitment.definition_of_done,
    'targetAt', commitment.target_at,
    'commitmentStatus', commitment.status,
    'sourceSessionId', p_intent.source_session_id,
    'durationMinutes', p_intent.duration_minutes,
    'timingConstraints', p_intent.timing_constraints,
    'options', p_intent.options,
    'selectedWindow', case
      when p_intent.selected_start_at is null then null
      else jsonb_build_object(
        'startAt', p_intent.selected_start_at,
        'endAt', p_intent.selected_end_at
      )
    end,
    'isRecovery', p_intent.is_recovery,
    'calendarAttemptedAt', p_intent.calendar_attempted_at,
    'calendarCheckedAt', p_intent.calendar_checked_at,
    'finalObservation', p_intent.final_calendar_observation
  )
  from public.commitments commitment
  where commitment.id = p_intent.commitment_id;
$$;

create or replace function public.read_work_session_continuation(
  p_intent_id uuid,
  p_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  current_intent public.work_session_continuation_intents;
begin
  if p_intent_id is null or p_version is null or p_version < 1 then
    return jsonb_build_object('kind', 'missing');
  end if;
  select * into current_intent
  from public.work_session_continuation_intents
  where id = p_intent_id;
  if current_intent.id is null then
    return jsonb_build_object('kind', 'missing');
  end if;
  if (
    current_intent.stage in (
      'awaiting_duration',
      'offer',
      'choosing',
      'confirming',
      'conflict_choice',
      'unverified_confirming'
    )
    and current_intent.expires_at <= now()
  ) then
    return jsonb_build_object('kind', 'expired');
  end if;
  if (
    current_intent.version <> p_version
    or current_intent.stage in ('confirmed', 'declined', 'stale')
  ) then
    return jsonb_build_object('kind', 'stale');
  end if;
  return jsonb_build_object(
    'kind', 'current',
    'snapshot', public.work_session_continuation_snapshot(current_intent)
  );
end;
$$;

drop function public.transition_work_session_continuation(
  bigint, bigint, text, uuid, integer, text, text, text,
  integer, jsonb, timestamptz, timestamptz, boolean
);

create function public.transition_work_session_continuation(
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
declare
  claimed boolean := false;
  completed boolean := false;
  current_intent public.work_session_continuation_intents;
  next_intent public.work_session_continuation_intents;
  action_time timestamptz := clock_timestamp();
begin
  insert into public.telegram_updates (
    update_id, processing_status, is_owner_private
  )
  values (p_update_id, 'claimed', true)
  on conflict (update_id) do nothing
  returning true into claimed;

  insert into public.telegram_owner_delivery (singleton, private_chat_id)
  values (true, p_owner_chat_id)
  on conflict do nothing;

  perform 1 from public.telegram_owner_delivery
  where singleton = true and private_chat_id = p_owner_chat_id
  for update;
  if (
    not found
    or p_owner_id is null
    or p_owner_id !~ '^[1-9][0-9]{0,18}$'
    or p_owner_id <> p_owner_chat_id::text
  ) then
    raise exception 'invalid continuation owner';
  end if;

  select * into current_intent
  from public.work_session_continuation_intents
  where id = p_intent_id
  for update;

  if not coalesce(claimed, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  if (
    current_intent.id is not null
    and current_intent.stage in (
      'awaiting_duration',
      'offer',
      'choosing',
      'confirming',
      'conflict_choice',
      'unverified_confirming'
    )
    and current_intent.expires_at <= action_time
  ) then
    update public.work_session_continuation_intents
    set stage = 'stale', version = version + 1, resolved_at = action_time
    where id = current_intent.id;
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_continuation_expired',
      processed_at = action_time
    where update_id = p_update_id and processing_status = 'claimed';
    return jsonb_build_object('kind', 'expired');
  end if;

  if (
    current_intent.id is null
    or current_intent.version <> p_version
    or current_intent.stage <> p_expected_stage
    or p_next_stage not in (
      'offer',
      'choosing',
      'confirming',
      'conflict_choice',
      'unverified_confirming',
      'declined'
    )
    or p_action is null
    or char_length(p_action) > 32
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_continuation_stale',
      processed_at = action_time
    where update_id = p_update_id and processing_status = 'claimed';
    return jsonb_build_object('kind', 'stale');
  end if;

  if p_next_stage = 'declined' then
    update public.work_session_continuation_intents
    set
      stage = 'declined',
      version = version + 1,
      resolved_at = action_time
    where id = current_intent.id
    returning * into next_intent;
    insert into public.commitment_events (
      commitment_id, event_type, occurred_at, actor,
      idempotency_key, metadata
    )
    values (
      current_intent.commitment_id,
      'work_session.continuation_declined',
      action_time,
      'owner',
      'work-session-continuation-declined:' || current_intent.id::text,
      '{}'::jsonb
    )
    on conflict (idempotency_key) do nothing;
  else
    if (
      p_duration_minutes is not null
      and p_duration_minutes not in (30, 60, 90, 120)
    ) then
      raise exception 'invalid continuation duration';
    end if;
    if (
      p_options is not null
      and (
        jsonb_typeof(p_options) <> 'array'
        or jsonb_array_length(p_options) > 2
      )
    ) then
      raise exception 'invalid continuation options';
    end if;
    if (
      p_final_observation is not null
      and p_final_observation not in ('free', 'conflict', 'unavailable')
    ) then
      raise exception 'invalid continuation Calendar observation';
    end if;

    update public.work_session_continuation_intents
    set
      stage = p_next_stage,
      version = version + 1,
      duration_minutes = coalesce(p_duration_minutes, duration_minutes),
      options = coalesce(p_options, options),
      selected_start_at = case
        when p_next_stage = 'confirming' then p_selected_start_at
        when p_next_stage in ('conflict_choice', 'unverified_confirming')
          then selected_start_at
        else null
      end,
      selected_end_at = case
        when p_next_stage = 'confirming' then p_selected_end_at
        when p_next_stage in ('conflict_choice', 'unverified_confirming')
          then selected_end_at
        else null
      end,
      is_recovery = coalesce(p_is_recovery, is_recovery),
      calendar_attempted_at = coalesce(
        p_calendar_attempted_at,
        calendar_attempted_at
      ),
      calendar_checked_at = case
        when p_final_observation = 'unavailable' then null
        else coalesce(p_calendar_checked_at, calendar_checked_at)
      end,
      final_calendar_observation = coalesce(
        p_final_observation,
        final_calendar_observation
      )
    where id = current_intent.id
    returning * into next_intent;
  end if;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = case
      when p_next_stage = 'declined'
        then 'work_session_continuation_declined'
      else 'work_session_continuation_resolved'
    end,
    processed_at = action_time,
    resolved_action_key =
      'c:' || current_intent.id::text || ':' ||
      p_version::text || ':' || p_action
  where update_id = p_update_id and processing_status = 'claimed'
  returning true into completed;
  if not coalesce(completed, false) then
    raise exception 'continuation completion failed';
  end if;

  return jsonb_build_object(
    'kind', 'applied',
    'snapshot', public.work_session_continuation_snapshot(next_intent)
  );
end;
$$;

create function public.confirm_work_session_continuation_final_state(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_intent_id uuid,
  p_version integer,
  p_expected_stage text,
  p_calendar_attempted_at timestamptz,
  p_calendar_checked_at timestamptz,
  p_calendar_status text,
  p_final_observation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
  completed boolean := false;
  current_intent public.work_session_continuation_intents;
  current_commitment public.commitments;
  created_session public.work_sessions;
  start_message public.scheduled_messages;
  end_message public.scheduled_messages;
  action_time timestamptz := clock_timestamp();
  next_sequence integer;
begin
  insert into public.telegram_updates (
    update_id, processing_status, is_owner_private
  )
  values (p_update_id, 'claimed', true)
  on conflict (update_id) do nothing
  returning true into claimed;

  insert into public.telegram_owner_delivery (singleton, private_chat_id)
  values (true, p_owner_chat_id)
  on conflict do nothing;

  perform 1 from public.telegram_owner_delivery
  where singleton = true and private_chat_id = p_owner_chat_id
  for update;
  if (
    not found
    or p_owner_id is null
    or p_owner_id !~ '^[1-9][0-9]{0,18}$'
    or p_owner_id <> p_owner_chat_id::text
  ) then
    raise exception 'invalid continuation owner';
  end if;

  select * into current_intent
  from public.work_session_continuation_intents
  where id = p_intent_id
  for update;

  if not coalesce(claimed, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  if (
    current_intent.id is not null
    and current_intent.stage in (
      'awaiting_duration',
      'offer',
      'choosing',
      'confirming',
      'conflict_choice',
      'unverified_confirming'
    )
    and current_intent.expires_at <= action_time
  ) then
    update public.work_session_continuation_intents
    set stage = 'stale', version = version + 1, resolved_at = action_time
    where id = current_intent.id;
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_continuation_expired',
      processed_at = action_time
    where update_id = p_update_id and processing_status = 'claimed';
    return jsonb_build_object('kind', 'expired');
  end if;

  select * into current_commitment
  from public.commitments
  where id = current_intent.commitment_id
  for update;

  if (
    current_intent.id is null
    or current_intent.version <> p_version
    or current_intent.stage <> p_expected_stage
    or p_expected_stage not in (
      'confirming', 'conflict_choice', 'unverified_confirming'
    )
    or current_intent.duration_minutes not in (30, 60, 90, 120)
    or current_intent.selected_start_at is null
    or current_intent.selected_end_at is null
    or current_intent.selected_start_at <= action_time
    or current_intent.selected_end_at <>
      current_intent.selected_start_at +
        current_intent.duration_minutes * interval '1 minute'
    or p_calendar_attempted_at is null
    or p_calendar_status not in ('free', 'unverified')
    or p_final_observation not in ('free', 'unavailable')
    or (
      p_calendar_status = 'free'
      and (
        p_calendar_checked_at is null
        or p_final_observation <> 'free'
      )
    )
    or (
      p_calendar_status = 'unverified'
      and (
        p_expected_stage <> 'unverified_confirming'
        or p_calendar_checked_at is not null
        or p_final_observation <> 'unavailable'
        or p_calendar_attempted_at is distinct from
          current_intent.calendar_attempted_at
      )
    )
    or current_commitment.status <> 'active'
    or current_commitment.owner_id <> p_owner_id
    or (
      not current_intent.is_recovery
      and current_intent.selected_end_at > current_commitment.target_at
    )
    or (
      current_intent.is_recovery
      and (
        current_intent.selected_start_at <= current_commitment.target_at
        or current_intent.selected_end_at >
          current_commitment.target_at + interval '7 days'
      )
    )
    or exists (
      select 1 from public.work_sessions session
      where
        session.commitment_id = current_commitment.id
        and session.status = 'planned'
    )
    or (
      current_intent.is_recovery
      and exists (
        select 1 from public.work_sessions session
        where
          session.commitment_id = current_commitment.id
          and session.is_recovery
      )
    )
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_continuation_stale',
      processed_at = action_time
    where update_id = p_update_id and processing_status = 'claimed';
    return jsonb_build_object('kind', 'stale');
  end if;

  select coalesce(max(session.sequence_number), 0) + 1
  into next_sequence
  from public.work_sessions session
  where session.commitment_id = current_commitment.id;

  insert into public.work_sessions (
    commitment_id,
    sequence_number,
    start_at,
    end_at,
    duration_minutes,
    status,
    calendar_status,
    calendar_attempted_at,
    calendar_checked_at,
    conflict_consent,
    final_calendar_observation,
    timing_constraints,
    source_session_id,
    is_recovery
  )
  values (
    current_commitment.id,
    next_sequence,
    current_intent.selected_start_at,
    current_intent.selected_end_at,
    current_intent.duration_minutes,
    'planned',
    p_calendar_status,
    p_calendar_attempted_at,
    p_calendar_checked_at,
    false,
    p_final_observation,
    current_intent.timing_constraints,
    current_intent.source_session_id,
    current_intent.is_recovery
  )
  returning * into created_session;

  insert into public.scheduled_messages (
    logical_key, commitment_id, work_session_id, kind, due_at, state
  )
  values (
    'ws:' || created_session.id::text || ':start',
    current_commitment.id,
    created_session.id,
    'work_session_start',
    created_session.start_at,
    'pending'
  )
  returning * into start_message;

  insert into public.scheduled_messages (
    logical_key, commitment_id, work_session_id, kind, due_at, state
  )
  values (
    'ws:' || created_session.id::text || ':end',
    current_commitment.id,
    created_session.id,
    'work_session_end',
    created_session.end_at,
    'pending'
  )
  returning * into end_message;

  insert into public.commitment_events (
    commitment_id, event_type, occurred_at, actor,
    idempotency_key, metadata
  )
  values
    (
      current_commitment.id,
      'work_session.created',
      action_time,
      'owner',
      'work-session-created:' || created_session.id::text,
      '{}'::jsonb
    ),
    (
      current_commitment.id,
      'scheduled_message.created',
      action_time,
      'owner',
      'scheduled-message-created:' || start_message.id::text,
      '{}'::jsonb
    ),
    (
      current_commitment.id,
      'scheduled_message.created',
      action_time,
      'owner',
      'scheduled-message-created:' || end_message.id::text,
      '{}'::jsonb
    );

  update public.work_session_continuation_intents
  set
    stage = 'confirmed',
    version = version + 1,
    calendar_attempted_at = p_calendar_attempted_at,
    calendar_checked_at = p_calendar_checked_at,
    final_calendar_observation = p_final_observation,
    resolved_at = action_time
  where id = current_intent.id;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'work_session_continuation_confirmed',
    processed_at = action_time,
    resolved_action_key =
      'c:' || current_intent.id::text || ':' ||
      p_version::text || ':' ||
      case when p_calendar_status = 'unverified'
        then 'save_unverified'
        else 'confirm'
      end
  where update_id = p_update_id and processing_status = 'claimed'
  returning true into completed;
  if not coalesce(completed, false) then
    raise exception 'continuation confirmation completion failed';
  end if;

  return jsonb_build_object(
    'kind', 'applied',
    'workSessionId', created_session.id
  );
end;
$$;

revoke all on function public.transition_work_session_continuation(
  bigint, bigint, text, uuid, integer, text, text, text,
  integer, jsonb, timestamptz, timestamptz, boolean,
  timestamptz, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.confirm_work_session_continuation_final_state(
  bigint, bigint, text, uuid, integer, text, timestamptz,
  timestamptz, text, text
) from public, anon, authenticated;
revoke execute on function public.confirm_work_session_continuation(
  bigint, bigint, text, uuid, integer, timestamptz, timestamptz
) from service_role;

grant execute on function public.transition_work_session_continuation(
  bigint, bigint, text, uuid, integer, text, text, text,
  integer, jsonb, timestamptz, timestamptz, boolean,
  timestamptz, timestamptz, text
) to service_role;
grant execute on function public.confirm_work_session_continuation_final_state(
  bigint, bigint, text, uuid, integer, text, timestamptz,
  timestamptz, text, text
) to service_role;
