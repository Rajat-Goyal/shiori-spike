create table public.work_sessions (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references public.commitments(id),
  sequence_number integer not null check (sequence_number > 0),
  start_at timestamptz not null,
  end_at timestamptz not null,
  duration_minutes integer not null check (
    duration_minutes in (30, 60, 90, 120)
  ),
  status text not null check (status = 'planned'),
  calendar_status text not null check (
    calendar_status in ('free', 'conflict_kept', 'unverified')
  ),
  calendar_attempted_at timestamptz not null,
  calendar_checked_at timestamptz,
  conflict_consent boolean not null,
  final_calendar_observation text not null check (
    final_calendar_observation in ('free', 'conflict', 'unavailable')
  ),
  created_at timestamptz not null default now(),
  unique (commitment_id, sequence_number),
  constraint work_sessions_window_check check (
    end_at > start_at
    and end_at = start_at + duration_minutes * interval '1 minute'
  ),
  constraint work_sessions_calendar_audit_check check (
    (
      calendar_status = 'free'
      and calendar_checked_at is not null
      and not conflict_consent
      and final_calendar_observation = 'free'
    )
    or (
      calendar_status = 'conflict_kept'
      and calendar_checked_at is not null
      and conflict_consent
      and final_calendar_observation in ('free', 'conflict')
    )
    or (
      calendar_status = 'unverified'
      and calendar_checked_at is null
      and final_calendar_observation = 'unavailable'
    )
  )
);

create unique index work_sessions_one_planned_idx
  on public.work_sessions (commitment_id)
  where status = 'planned';

alter table public.work_sessions enable row level security;
revoke all on table public.work_sessions from anon, authenticated;
grant select on table public.work_sessions to service_role;

alter table public.scheduled_messages
  drop constraint scheduled_messages_kind_check,
  add column work_session_id uuid references public.work_sessions(id),
  add constraint scheduled_messages_kind_check check (
    kind in (
      'simple_reminder',
      'work_session_start',
      'work_session_end'
    )
  ),
  add constraint scheduled_messages_aggregate_check check (
    (
      kind = 'simple_reminder'
      and work_session_id is null
    )
    or (
      kind in ('work_session_start', 'work_session_end')
      and work_session_id is not null
    )
  );

create unique index scheduled_messages_work_session_kind_idx
  on public.scheduled_messages (work_session_id, kind)
  where work_session_id is not null;

alter table public.commitment_events
  drop constraint commitment_events_event_type_check;

alter table public.commitment_events
  add constraint commitment_events_event_type_check check (
    event_type in (
      'commitment.created',
      'commitment.done',
      'work_session.created',
      'scheduled_message.created',
      'scheduled_message.delivery_attempt',
      'scheduled_message.delivered',
      'scheduled_message.retry_scheduled',
      'scheduled_message.retry_exhausted',
      'scheduled_message.delivery_unknown',
      'scheduled_message.permanent_failure',
      'scheduled_message.cancelled'
    )
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
      'work_session_confirmed',
      'work_session_draft_cancelled',
      'work_session_draft_expired',
      'work_session_draft_resolved',
      'work_session_draft_stale'
    )
  );

create function public.confirm_work_session(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_draft_id uuid,
  p_version integer,
  p_expected_stage text,
  p_action text,
  p_calendar_attempted_at timestamptz,
  p_calendar_checked_at timestamptz,
  p_conflict_consent boolean,
  p_final_observation text,
  p_calendar_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
  completed boolean := false;
  current_draft public.conversation_drafts;
  created_commitment public.commitments;
  created_session public.work_sessions;
  start_message public.scheduled_messages;
  end_message public.scheduled_messages;
  action_key text;
begin
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
  end if;

  insert into public.telegram_owner_delivery (
    singleton,
    private_chat_id
  )
  values (true, p_owner_chat_id)
  on conflict (singleton) do nothing;

  perform 1
  from public.telegram_owner_delivery
  where
    singleton = true
    and private_chat_id = p_owner_chat_id
  for update;

  if (
    not found
    or p_owner_id is null
    or p_owner_id !~ '^[1-9][0-9]{0,18}$'
    or p_owner_id <> p_owner_chat_id::text
  ) then
    raise exception 'invalid work-session confirmation owner';
  end if;

  select *
  into current_draft
  from public.conversation_drafts
  where id = p_draft_id
  for update;

  if (
    current_draft.id is null
    or not current_draft.possible_work_session
    or current_draft.simple_action
    or current_draft.phase <> 'complete'
  ) then
    raise exception 'invalid work-session confirmation draft';
  end if;

  if current_draft.state <> 'active' then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = case
        when current_draft.state = 'confirmed'
          then 'work_session_draft_resolved'
        else 'work_session_draft_stale'
      end,
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;
    if not coalesce(completed, false) then
      raise exception 'work-session confirmation completion failed';
    end if;
    return jsonb_build_object(
      'kind',
      case
        when current_draft.state = 'confirmed' then 'resolved'
        else 'stale'
      end
    );
  end if;

  if (
    current_draft.expires_at <= now()
    or current_draft.version <> p_version
    or current_draft.work_session_stage <> p_expected_stage
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_draft_stale',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;
    if not coalesce(completed, false) then
      raise exception 'work-session confirmation completion failed';
    end if;
    return jsonb_build_object('kind', 'stale');
  end if;

  if (
    p_action not in ('confirm', 'save_unverified')
    or p_calendar_attempted_at is null
    or p_conflict_consent is null
    or p_final_observation not in ('free', 'conflict', 'unavailable')
    or p_calendar_status not in ('free', 'conflict_kept', 'unverified')
    or current_draft.definition_of_done is null
    or current_draft.target_at is null
    or current_draft.target_time_zone <> 'Asia/Singapore'
    or current_draft.duration_minutes not in (30, 60, 90, 120)
    or current_draft.selected_start_at is null
    or current_draft.selected_end_at is null
    or current_draft.selected_start_at::timestamptz <= now()
    or current_draft.selected_end_at::timestamptz >
      current_draft.target_at::timestamptz
    or current_draft.selected_end_at::timestamptz <>
      current_draft.selected_start_at::timestamptz +
        current_draft.duration_minutes * interval '1 minute'
    or p_conflict_consent is distinct from current_draft.conflict_consent
  ) then
    raise exception 'invalid work-session confirmation';
  end if;

  if (
    (
      p_calendar_status = 'free'
      and (
        p_action <> 'confirm'
        or p_expected_stage <> 'confirming'
        or p_conflict_consent
        or p_final_observation <> 'free'
        or p_calendar_checked_at is null
      )
    )
    or (
      p_calendar_status = 'conflict_kept'
      and (
        p_action <> 'confirm'
        or p_expected_stage <> 'conflict_confirming'
        or not p_conflict_consent
        or p_final_observation not in ('free', 'conflict')
        or p_calendar_checked_at is null
      )
    )
    or (
      p_calendar_status = 'unverified'
      and (
        p_action <> 'save_unverified'
        or p_expected_stage <> 'unverified_confirming'
        or p_final_observation <> 'unavailable'
        or p_calendar_checked_at is not null
        or p_calendar_attempted_at is distinct from
          current_draft.calendar_attempted_at
      )
    )
  ) then
    raise exception 'invalid work-session Calendar audit';
  end if;

  action_key :=
    'w:' || current_draft.id::text || ':' ||
    current_draft.version::text || ':' || p_action;
  if char_length(action_key) > 64 then
    raise exception 'invalid work-session action key';
  end if;

  insert into public.commitments (
    owner_id,
    definition_of_done,
    target_at,
    status,
    source_draft_id
  )
  values (
    p_owner_id,
    current_draft.definition_of_done,
    current_draft.target_at::timestamptz,
    'active',
    current_draft.id
  )
  returning * into created_commitment;

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
    final_calendar_observation
  )
  values (
    created_commitment.id,
    1,
    current_draft.selected_start_at::timestamptz,
    current_draft.selected_end_at::timestamptz,
    current_draft.duration_minutes,
    'planned',
    p_calendar_status,
    p_calendar_attempted_at,
    p_calendar_checked_at,
    p_conflict_consent,
    p_final_observation
  )
  returning * into created_session;

  insert into public.scheduled_messages (
    logical_key,
    commitment_id,
    work_session_id,
    kind,
    due_at,
    state
  )
  values (
    'ws:' || created_session.id::text || ':start',
    created_commitment.id,
    created_session.id,
    'work_session_start',
    created_session.start_at,
    'pending'
  )
  returning * into start_message;

  insert into public.scheduled_messages (
    logical_key,
    commitment_id,
    work_session_id,
    kind,
    due_at,
    state
  )
  values (
    'ws:' || created_session.id::text || ':end',
    created_commitment.id,
    created_session.id,
    'work_session_end',
    created_session.end_at,
    'pending'
  )
  returning * into end_message;

  insert into public.commitment_events (
    commitment_id,
    event_type,
    occurred_at,
    actor,
    idempotency_key,
    metadata
  )
  values
    (
      created_commitment.id,
      'commitment.created',
      now(),
      'owner',
      'commitment-created:' || created_commitment.id::text,
      '{}'::jsonb
    ),
    (
      created_commitment.id,
      'work_session.created',
      now(),
      'owner',
      'work-session-created:' || created_session.id::text,
      '{}'::jsonb
    ),
    (
      created_commitment.id,
      'scheduled_message.created',
      now(),
      'owner',
      'scheduled-message-created:' || start_message.id::text,
      '{}'::jsonb
    ),
    (
      created_commitment.id,
      'scheduled_message.created',
      now(),
      'owner',
      'scheduled-message-created:' || end_message.id::text,
      '{}'::jsonb
    );

  update public.conversation_drafts
  set
    state = 'confirmed',
    work_session_stage = 'commit_pending',
    calendar_attempted_at = p_calendar_attempted_at,
    calendar_checked_at = p_calendar_checked_at,
    conflict_consent = p_conflict_consent,
    final_calendar_observation = p_final_observation,
    resolved_update_id = p_update_id,
    resolved_at = now(),
    last_work_session_transition_id = p_update_id,
    last_update_id = p_update_id,
    updated_at = now()
  where id = current_draft.id;

  delete from public.conversation_work_session_options
  where draft_id = current_draft.id;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'work_session_confirmed',
    processed_at = now(),
    resolved_action_key = action_key
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'work-session confirmation completion failed';
  end if;

  return jsonb_build_object('kind', 'applied');
end;
$$;

revoke all on function public.confirm_work_session(
  bigint, bigint, text, uuid, integer, text, text, timestamptz,
  timestamptz, boolean, text, text
) from public, anon, authenticated;

grant execute on function public.confirm_work_session(
  bigint, bigint, text, uuid, integer, text, text, timestamptz,
  timestamptz, boolean, text, text
) to service_role;
