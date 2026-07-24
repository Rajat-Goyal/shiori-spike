alter table public.work_sessions
  drop constraint work_sessions_status_check,
  add constraint work_sessions_status_check check (
    status in (
      'planned',
      'started',
      'awaiting_check_in',
      'done',
      'more_work_needed',
      'missed',
      'cancelled'
    )
  ),
  add column action_version integer not null default 1
    check (action_version > 0),
  add column timing_constraints text not null default 'anytime'
    check (char_length(timing_constraints) between 1 and 500),
  add column outcome_at timestamptz,
  add column source_session_id uuid references public.work_sessions(id),
  add column is_recovery boolean not null default false,
  add constraint work_sessions_outcome_check check (
    (
      status in ('planned', 'started', 'awaiting_check_in')
      and outcome_at is null
    )
    or (
      status in (
        'done',
        'more_work_needed',
        'missed',
        'cancelled'
      )
      and outcome_at is not null
    )
  ),
  add constraint work_sessions_recovery_source_check check (
    (not is_recovery and source_session_id is null)
    or (is_recovery and source_session_id is not null)
  );

create unique index work_sessions_one_recovery_idx
  on public.work_sessions (commitment_id)
  where is_recovery;

create table public.work_session_continuation_intents (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null
    references public.commitments(id) on delete cascade,
  source_session_id uuid not null unique
    references public.work_sessions(id),
  version integer not null default 1 check (version > 0),
  stage text not null check (
    stage in (
      'awaiting_duration',
      'offer',
      'choosing',
      'confirming',
      'confirmed',
      'declined',
      'stale'
    )
  ),
  duration_minutes integer check (
    duration_minutes is null
    or duration_minutes in (30, 60, 90, 120)
  ),
  timing_constraints text not null check (
    char_length(timing_constraints) between 1 and 500
  ),
  options jsonb not null default '[]'::jsonb check (
    jsonb_typeof(options) = 'array'
    and jsonb_array_length(options) <= 2
  ),
  selected_start_at timestamptz,
  selected_end_at timestamptz,
  is_recovery boolean not null default false,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint work_session_continuation_selection_check check (
    (
      selected_start_at is null
      and selected_end_at is null
    )
    or (
      selected_start_at is not null
      and selected_end_at is not null
      and selected_end_at > selected_start_at
    )
  ),
  constraint work_session_continuation_resolution_check check (
    (
      stage in (
        'awaiting_duration',
        'offer',
        'choosing',
        'confirming'
      )
      and resolved_at is null
    )
    or (
      stage in ('confirmed', 'declined', 'stale')
      and resolved_at is not null
    )
  )
);

create unique index work_session_one_active_continuation_idx
  on public.work_session_continuation_intents (commitment_id)
  where stage in (
    'awaiting_duration',
    'offer',
    'choosing',
    'confirming'
  );

alter table public.work_session_continuation_intents
  enable row level security;
revoke all on table public.work_session_continuation_intents
  from anon, authenticated;
grant select on table public.work_session_continuation_intents
  to service_role;

alter table public.commitment_events
  drop constraint commitment_events_event_type_check;

alter table public.commitment_events
  add constraint commitment_events_event_type_check check (
    event_type in (
      'commitment.created',
      'commitment.done',
      'commitment.cancelled',
      'work_session.created',
      'work_session.started',
      'work_session.done',
      'work_session.more_work_needed',
      'work_session.missed',
      'work_session.cancelled',
      'work_session.continuation_declined',
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
      'work_session_outcome_stale'
    )
  );

create function public.protect_commitment_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_at is distinct from old.target_at then
    raise exception 'commitment target is immutable';
  end if;
  return new;
end;
$$;

create trigger commitments_protect_target
before update on public.commitments
for each row execute function public.protect_commitment_target();

create function public.sync_terminal_work_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_session public.work_sessions;
  action_time timestamptz;
  next_session_status text;
begin
  if old.status <> 'active' or new.status = 'active' then
    return new;
  end if;

  action_time := coalesce(new.completed_at, new.cancelled_at, clock_timestamp());
  select case
    when action_time < session.start_at then 'cancelled'
    when new.status = 'done' then 'done'
    else 'cancelled'
  end
  into next_session_status
  from (
    select work_session.start_at
    from public.work_sessions work_session
    where
      work_session.commitment_id = new.id
      and work_session.status in (
        'planned',
        'started',
        'awaiting_check_in'
      )
    order by work_session.sequence_number desc
    limit 1
  ) session;

  if next_session_status is null then
    return new;
  end if;

  update public.work_sessions
  set
    status = next_session_status,
    outcome_at = action_time
  where id = (
    select work_session.id
    from public.work_sessions work_session
    where
      work_session.commitment_id = new.id
      and work_session.status in (
        'planned',
        'started',
        'awaiting_check_in'
      )
    order by work_session.sequence_number desc
    limit 1
    for update
  )
  returning * into changed_session;

  if changed_session.id is not null then
    insert into public.commitment_events (
      commitment_id,
      event_type,
      occurred_at,
      actor,
      idempotency_key,
      metadata
    )
    values (
      new.id,
      case
        when next_session_status = 'done' then 'work_session.done'
        else 'work_session.cancelled'
      end,
      action_time,
      'owner',
      'work-session-outcome:' || changed_session.id::text,
      '{}'::jsonb
    )
    on conflict (idempotency_key) do nothing;
  end if;

  perform public.cancel_unsent_commitment_messages(new.id, action_time);
  return new;
end;
$$;

create trigger commitments_sync_terminal_work_session
after update of status on public.commitments
for each row execute function public.sync_terminal_work_session();

create function public.claim_due_work_session_messages(
  p_now timestamptz,
  p_limit integer
)
returns table (
  id uuid,
  logical_key text,
  commitment_id uuid,
  work_session_id uuid,
  kind text,
  action_version integer,
  attempt_count integer,
  lease_token uuid,
  chat_id bigint,
  definition_of_done text,
  start_at timestamptz,
  end_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  uncertain_claim record;
begin
  if p_now is null or p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'invalid work-session message claim';
  end if;

  for uncertain_claim in
    with expired_started_claims as (
      select message.id
      from public.scheduled_messages message
      where
        message.kind in ('work_session_start', 'work_session_end')
        and message.state = 'claimed'
        and message.lease_expires_at <= p_now
        and message.delivery_started_at is not null
      order by message.lease_expires_at, message.logical_key
      for update skip locked
      limit p_limit
    )
    update public.scheduled_messages message
    set
      state = 'delivery_unknown',
      claimed_at = null,
      lease_expires_at = null,
      lease_token = null,
      delivery_started_at = null,
      last_error_class = 'delivery_unknown'
    from expired_started_claims
    where message.id = expired_started_claims.id
    returning message.id, message.commitment_id, message.attempt_count
  loop
    insert into public.commitment_events (
      commitment_id,
      event_type,
      occurred_at,
      actor,
      idempotency_key,
      metadata
    )
    values (
      uncertain_claim.commitment_id,
      'scheduled_message.delivery_unknown',
      p_now,
      'system',
      'delivery-result:' || uncertain_claim.id::text || ':' ||
        uncertain_claim.attempt_count::text,
      '{}'::jsonb
    )
    on conflict (idempotency_key) do nothing;
  end loop;

  return query
  with candidates as (
    select
      message.id,
      message.state = 'pending' as starts_attempt,
      delivery.private_chat_id
    from public.scheduled_messages message
    join public.commitments commitment
      on commitment.id = message.commitment_id
    join public.work_sessions session
      on session.id = message.work_session_id
    cross join public.telegram_owner_delivery delivery
    where
      delivery.singleton = true
      and message.kind in ('work_session_start', 'work_session_end')
      and (
        (
          message.state = 'pending'
          and coalesce(message.next_attempt_at, message.due_at) <= p_now
        )
        or (
          message.state = 'claimed'
          and message.lease_expires_at <= p_now
          and message.delivery_started_at is null
        )
      )
      and commitment.status = 'active'
      and session.status in (
        'planned',
        'started',
        'awaiting_check_in'
      )
    order by
      coalesce(message.next_attempt_at, message.due_at),
      message.logical_key
    for update of message skip locked
    limit p_limit
  ),
  claimed as (
    update public.scheduled_messages message
    set
      state = 'claimed',
      attempt_count = case
        when candidates.starts_attempt
          then message.attempt_count + 1
        else message.attempt_count
      end,
      claimed_at = p_now,
      lease_expires_at = p_now + interval '30 seconds',
      lease_token = gen_random_uuid(),
      delivery_started_at = null,
      next_attempt_at = null
    from candidates
    where message.id = candidates.id
    returning
      message.*,
      candidates.starts_attempt,
      candidates.private_chat_id
  ),
  attempts as (
    insert into public.commitment_events (
      commitment_id,
      event_type,
      occurred_at,
      actor,
      idempotency_key,
      metadata
    )
    select
      claimed.commitment_id,
      'scheduled_message.delivery_attempt',
      p_now,
      'system',
      'delivery-attempt:' || claimed.id::text || ':' ||
        claimed.attempt_count::text,
      '{}'::jsonb
    from claimed
    where claimed.starts_attempt
    on conflict (idempotency_key) do nothing
    returning 1
  )
  select
    claimed.id,
    claimed.logical_key,
    claimed.commitment_id,
    claimed.work_session_id,
    claimed.kind,
    session.action_version,
    claimed.attempt_count,
    claimed.lease_token,
    claimed.private_chat_id,
    commitment.definition_of_done,
    session.start_at,
    session.end_at
  from claimed
  join public.commitments commitment
    on commitment.id = claimed.commitment_id
  join public.work_sessions session
    on session.id = claimed.work_session_id
  order by claimed.logical_key;
end;
$$;

create function public.begin_work_session_message_delivery(
  p_message_id uuid,
  p_attempt_count integer,
  p_lease_token uuid,
  p_started_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_message public.scheduled_messages;
  active_commitment boolean;
  active_session boolean;
begin
  if (
    p_message_id is null
    or p_attempt_count is null
    or p_attempt_count < 1
    or p_lease_token is null
    or p_started_at is null
  ) then
    raise exception 'invalid work-session delivery start';
  end if;

  select *
  into current_message
  from public.scheduled_messages
  where id = p_message_id
  for update;

  select commitment.status = 'active'
  into active_commitment
  from public.commitments commitment
  where commitment.id = current_message.commitment_id;

  select session.status in (
    'planned',
    'started',
    'awaiting_check_in'
  )
  into active_session
  from public.work_sessions session
  where session.id = current_message.work_session_id;

  if current_message.id is null then
    raise exception 'work-session message does not exist';
  end if;

  if (
    current_message.state <> 'claimed'
    or current_message.attempt_count <> p_attempt_count
    or current_message.lease_token <> p_lease_token
    or p_started_at < current_message.claimed_at
    or p_started_at >= current_message.lease_expires_at
    or not coalesce(active_commitment, false)
    or not coalesce(active_session, false)
  ) then
    return jsonb_build_object(
      'applied', false,
      'state', current_message.state
    );
  end if;

  update public.scheduled_messages
  set delivery_started_at = coalesce(delivery_started_at, p_started_at)
  where id = current_message.id;

  return jsonb_build_object('applied', true, 'state', 'claimed');
end;
$$;

create function public.record_work_session_message_result(
  p_message_id uuid,
  p_attempt_count integer,
  p_lease_token uuid,
  p_result text,
  p_recorded_at timestamptz,
  p_telegram_message_id bigint default null,
  p_retry_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_message public.scheduled_messages;
  current_session public.work_sessions;
  next_state text;
  result_event text;
begin
  if (
    p_message_id is null
    or p_attempt_count is null
    or p_attempt_count < 1
    or p_lease_token is null
    or p_recorded_at is null
    or p_result not in (
      'delivered',
      'rate_limited',
      'delivery_unknown',
      'permanent_failure'
    )
  ) then
    raise exception 'invalid work-session delivery result';
  end if;

  select * into current_message
  from public.scheduled_messages
  where id = p_message_id
  for update;

  if current_message.id is null then
    raise exception 'work-session message does not exist';
  end if;

  if (
    current_message.state <> 'claimed'
    or current_message.attempt_count <> p_attempt_count
    or current_message.lease_token <> p_lease_token
    or current_message.delivery_started_at is null
    or p_recorded_at < current_message.delivery_started_at
  ) then
    return jsonb_build_object(
      'applied', false,
      'state', current_message.state
    );
  end if;

  if p_result = 'delivered' then
    if p_telegram_message_id is null or p_telegram_message_id < 1 then
      raise exception 'invalid Telegram delivery receipt';
    end if;
    next_state := 'delivered';
    result_event := 'scheduled_message.delivered';
  elsif p_result = 'rate_limited' and p_attempt_count < 3 then
    if p_retry_at is null or p_retry_at <= p_recorded_at then
      raise exception 'invalid work-session retry time';
    end if;
    next_state := 'pending';
    result_event := 'scheduled_message.retry_scheduled';
  elsif p_result = 'rate_limited' then
    next_state := 'retryable_failure';
    result_event := 'scheduled_message.retry_exhausted';
  elsif p_result = 'delivery_unknown' then
    next_state := 'delivery_unknown';
    result_event := 'scheduled_message.delivery_unknown';
  else
    next_state := 'permanent_failure';
    result_event := 'scheduled_message.permanent_failure';
  end if;

  update public.scheduled_messages
  set
    state = next_state,
    telegram_message_id = case
      when next_state = 'delivered' then p_telegram_message_id
      else null
    end,
    last_error_class = case
      when p_result = 'delivered' then null
      else p_result
    end,
    next_attempt_at = case
      when next_state = 'pending' then p_retry_at
      else null
    end,
    claimed_at = null,
    lease_expires_at = null,
    lease_token = null,
    delivery_started_at = null
  where id = current_message.id;

  if next_state = 'delivered' then
    select * into current_session
    from public.work_sessions
    where id = current_message.work_session_id
    for update;

    if (
      current_message.kind = 'work_session_start'
      and current_session.status = 'planned'
    ) then
      update public.work_sessions
      set status = 'started'
      where id = current_session.id;
      insert into public.commitment_events (
        commitment_id,
        event_type,
        occurred_at,
        actor,
        idempotency_key,
        metadata
      )
      values (
        current_message.commitment_id,
        'work_session.started',
        p_recorded_at,
        'system',
        'work-session-started:' || current_session.id::text,
        '{}'::jsonb
      )
      on conflict (idempotency_key) do nothing;
    elsif (
      current_message.kind = 'work_session_end'
      and current_session.status in ('planned', 'started')
    ) then
      update public.work_sessions
      set status = 'awaiting_check_in'
      where id = current_session.id;
    end if;
  end if;

  insert into public.commitment_events (
    commitment_id,
    event_type,
    occurred_at,
    actor,
    idempotency_key,
    metadata
  )
  values (
    current_message.commitment_id,
    result_event,
    p_recorded_at,
    'system',
    'delivery-result:' || current_message.id::text || ':' ||
      p_attempt_count::text,
    '{}'::jsonb
  );

  return jsonb_build_object('applied', true, 'state', next_state);
end;
$$;

create function public.resolve_work_session_outcome(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_work_session_id uuid,
  p_version integer,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
  completed boolean := false;
  current_session public.work_sessions;
  current_commitment public.commitments;
  continuation public.work_session_continuation_intents;
  action_time timestamptz := clock_timestamp();
  action_key text;
  next_status text;
  outcome_processing_result text;
begin
  insert into public.telegram_updates (
    update_id,
    processing_status,
    is_owner_private
  )
  values (p_update_id, 'claimed', true)
  on conflict (update_id) do nothing
  returning true into claimed;

  insert into public.telegram_owner_delivery (singleton, private_chat_id)
  values (true, p_owner_chat_id)
  on conflict (singleton) do nothing;

  perform 1
  from public.telegram_owner_delivery
  where singleton = true and private_chat_id = p_owner_chat_id
  for update;

  if (
    not found
    or p_owner_id is null
    or p_owner_id !~ '^[1-9][0-9]{0,18}$'
    or p_owner_id <> p_owner_chat_id::text
  ) then
    raise exception 'invalid work-session owner';
  end if;

  select * into current_session
  from public.work_sessions
  where id = p_work_session_id
  for update;

  if (
    p_work_session_id is null
    or p_version is null
    or p_version < 1
    or p_action not in ('done', 'more', 'missed')
    or current_session.id is null
  ) then
    if coalesce(claimed, false) then
      update public.telegram_updates
      set
        processing_status = 'processed',
        processing_result = 'work_session_outcome_malformed',
        processed_at = action_time
      where update_id = p_update_id and processing_status = 'claimed'
      returning true into completed;
    end if;
    return jsonb_build_object('kind', 'malformed', 'completed', true);
  end if;

  select * into current_commitment
  from public.commitments
  where id = current_session.commitment_id
  for update;

  if not coalesce(claimed, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  action_key :=
    's:' || current_session.id::text || ':' ||
    p_version::text || ':' || p_action;

  if (
    current_session.action_version <> p_version
    or current_commitment.owner_id <> p_owner_id
    or current_commitment.status <> 'active'
    or current_session.status not in (
      'planned',
      'started',
      'awaiting_check_in'
    )
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = case
        when current_session.status = 'done'
          then 'work_session_outcome_resolved'
        else 'work_session_outcome_stale'
      end,
      processed_at = action_time,
      resolved_action_key = action_key
    where update_id = p_update_id and processing_status = 'claimed'
    returning true into completed;
    return jsonb_build_object(
      'kind',
      case when current_session.status = 'done'
        then 'already_done'
        else 'stale'
      end,
      'completed',
      true
    );
  end if;

  if p_action = 'done' then
    next_status := case
      when action_time < current_session.start_at then 'cancelled'
      else 'done'
    end;
    update public.work_sessions
    set status = next_status, outcome_at = action_time
    where id = current_session.id;

    update public.commitments
    set status = 'done', completed_at = action_time
    where id = current_commitment.id and status = 'active';

    perform public.cancel_unsent_commitment_messages(
      current_commitment.id,
      action_time
    );

    insert into public.commitment_events (
      commitment_id,
      event_type,
      occurred_at,
      actor,
      idempotency_key,
      metadata
    )
    values (
      current_commitment.id,
      case
        when next_status = 'done' then 'work_session.done'
        else 'work_session.cancelled'
      end,
      action_time,
      'owner',
      'work-session-outcome:' || current_session.id::text,
      '{}'::jsonb
    )
    on conflict (idempotency_key) do nothing;
    outcome_processing_result := 'work_session_done';
  else
    next_status := case
      when p_action = 'more' then 'more_work_needed'
      else 'missed'
    end;
    update public.work_sessions
    set status = next_status, outcome_at = action_time
    where id = current_session.id;

    insert into public.work_session_continuation_intents (
      commitment_id,
      source_session_id,
      stage,
      duration_minutes,
      timing_constraints
    )
    values (
      current_commitment.id,
      current_session.id,
      case
        when p_action = 'more' then 'awaiting_duration'
        else 'offer'
      end,
      case
        when p_action = 'more' then null
        else current_session.duration_minutes
      end,
      current_session.timing_constraints
    )
    returning * into continuation;

    insert into public.commitment_events (
      commitment_id,
      event_type,
      occurred_at,
      actor,
      idempotency_key,
      metadata
    )
    values (
      current_commitment.id,
      case
        when p_action = 'more'
          then 'work_session.more_work_needed'
        else 'work_session.missed'
      end,
      action_time,
      'owner',
      'work-session-outcome:' || current_session.id::text,
      '{}'::jsonb
    );
    outcome_processing_result := case
      when p_action = 'more'
        then 'work_session_more_work_needed'
      else 'work_session_missed'
    end;
  end if;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = outcome_processing_result,
    processed_at = action_time,
    resolved_action_key = action_key
  where update_id = p_update_id and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'work-session outcome completion failed';
  end if;

  return jsonb_build_object(
    'kind',
    case
      when p_action = 'done' then 'done'
      when p_action = 'more' then 'more'
      else 'missed'
    end,
    'completed',
    true,
    'continuationId', continuation.id,
    'continuationVersion', continuation.version
  );
end;
$$;

revoke all on function public.protect_commitment_target()
  from public, anon, authenticated;
revoke all on function public.sync_terminal_work_session()
  from public, anon, authenticated;
revoke all on function public.claim_due_work_session_messages(
  timestamptz, integer
) from public, anon, authenticated;
revoke all on function public.begin_work_session_message_delivery(
  uuid, integer, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.record_work_session_message_result(
  uuid, integer, uuid, text, timestamptz, bigint, timestamptz
) from public, anon, authenticated;
revoke all on function public.resolve_work_session_outcome(
  bigint, bigint, text, uuid, integer, text
) from public, anon, authenticated;

grant execute on function public.claim_due_work_session_messages(
  timestamptz, integer
) to service_role;
grant execute on function public.begin_work_session_message_delivery(
  uuid, integer, uuid, timestamptz
) to service_role;
grant execute on function public.record_work_session_message_result(
  uuid, integer, uuid, text, timestamptz, bigint, timestamptz
) to service_role;
grant execute on function public.resolve_work_session_outcome(
  bigint, bigint, text, uuid, integer, text
) to service_role;
