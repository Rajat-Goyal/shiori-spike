alter table public.scheduled_messages
  drop constraint scheduled_messages_state_check;

alter table public.scheduled_messages
  add constraint scheduled_messages_state_check check (
    state in (
      'pending',
      'claimed',
      'delivered',
      'delivery_unknown',
      'permanent_failure',
      'retryable_failure',
      'cancelled'
    )
  ),
  add column action_version integer not null default 1
    check (action_version > 0),
  add column next_attempt_at timestamptz,
  add column lease_expires_at timestamptz,
  add constraint scheduled_messages_attempt_limit_check check (
    attempt_count between 0 and 3
  ),
  add constraint scheduled_messages_retry_time_check check (
    (state = 'pending')
    or next_attempt_at is null
  );

drop index public.scheduled_messages_pending_due_idx;

create index scheduled_messages_pending_due_idx
  on public.scheduled_messages (
    (coalesce(next_attempt_at, due_at)),
    logical_key
  )
  where state = 'pending';

alter table public.commitment_events
  drop constraint commitment_events_event_type_check,
  drop constraint commitment_events_actor_check;

alter table public.commitment_events
  add constraint commitment_events_event_type_check check (
    event_type in (
      'commitment.created',
      'commitment.done',
      'scheduled_message.created',
      'scheduled_message.delivery_attempt',
      'scheduled_message.delivered',
      'scheduled_message.retry_scheduled',
      'scheduled_message.retry_exhausted',
      'scheduled_message.delivery_unknown',
      'scheduled_message.permanent_failure',
      'scheduled_message.cancelled'
    )
  ),
  add constraint commitment_events_actor_check check (
    actor in ('owner', 'system')
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
      'reminder_stale'
    )
  );

create function public.claim_due_simple_reminders(
  p_now timestamptz,
  p_limit integer
)
returns table (
  id uuid,
  logical_key text,
  commitment_id uuid,
  action_version integer,
  attempt_count integer,
  chat_id bigint,
  definition_of_done text,
  target_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_now is null or p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'invalid simple reminder claim';
  end if;

  return query
  with candidates as (
    select
      message.id,
      delivery.private_chat_id
    from public.scheduled_messages message
    join public.commitments commitment
      on commitment.id = message.commitment_id
    cross join public.telegram_owner_delivery delivery
    where
      delivery.singleton = true
      and message.kind = 'simple_reminder'
      and message.state = 'pending'
      and coalesce(message.next_attempt_at, message.due_at) <= p_now
      and commitment.status = 'active'
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
      attempt_count = message.attempt_count + 1,
      claimed_at = p_now,
      lease_expires_at = p_now + interval '30 seconds',
      next_attempt_at = null
    from candidates
    where message.id = candidates.id
    returning message.*
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
    returning 1
  )
  select
    claimed.id,
    claimed.logical_key,
    claimed.commitment_id,
    claimed.action_version,
    claimed.attempt_count,
    candidates.private_chat_id,
    commitment.definition_of_done,
    commitment.target_at
  from claimed
  join candidates on candidates.id = claimed.id
  join public.commitments commitment
    on commitment.id = claimed.commitment_id
  order by claimed.logical_key;
end;
$$;

create function public.record_simple_reminder_result(
  p_message_id uuid,
  p_attempt_count integer,
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
  next_state text;
  result_event text;
begin
  if (
    p_message_id is null
    or p_attempt_count is null
    or p_attempt_count < 1
    or p_recorded_at is null
    or p_result not in (
      'delivered',
      'rate_limited',
      'delivery_unknown',
      'permanent_failure'
    )
  ) then
    raise exception 'invalid simple reminder result';
  end if;

  select *
  into current_message
  from public.scheduled_messages
  where id = p_message_id
  for update;

  if current_message.id is null then
    raise exception 'simple reminder does not exist';
  end if;

  if (
    current_message.state <> 'claimed'
    or current_message.attempt_count <> p_attempt_count
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
      raise exception 'invalid simple reminder retry time';
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
    lease_expires_at = null
  where id = current_message.id;

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

  return jsonb_build_object(
    'applied', true,
    'state', next_state
  );
end;
$$;

create function public.resolve_simple_reminder_action(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_commitment_id uuid,
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
  current_commitment public.commitments;
  action_key text;
  completion_time timestamptz;
  cancelled_message record;
begin
  insert into public.telegram_updates (
    update_id,
    processing_status,
    is_owner_private
  )
  values (
    p_update_id,
    'claimed',
    true
  )
  on conflict (update_id) do nothing
  returning true into claimed;

  if not coalesce(claimed, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  insert into public.telegram_owner_delivery (
    singleton,
    private_chat_id
  )
  values (
    true,
    p_owner_chat_id
  )
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
    raise exception 'invalid reminder owner';
  end if;

  if (
    p_commitment_id is null
    or p_version is null
    or p_version < 1
    or p_action not in ('done', 'cancel')
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'reminder_malformed',
      processed_at = clock_timestamp()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'malformed',
      'completed', completed
    );
  end if;

  select *
  into current_commitment
  from public.commitments
  where id = p_commitment_id
  for update;

  if current_commitment.id is null then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'reminder_malformed',
      processed_at = clock_timestamp()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'malformed',
      'completed', completed
    );
  end if;

  action_key :=
    'p:' || current_commitment.id::text || ':' ||
    p_version::text || ':' || p_action;

  if p_version <> 1 then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'reminder_stale',
      processed_at = clock_timestamp()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'stale',
      'completed', completed
    );
  end if;

  if current_commitment.status = 'done' then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'reminder_resolved',
      processed_at = clock_timestamp()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'already_done',
      'completed', completed,
      'completedAt', current_commitment.completed_at
    );
  end if;

  if current_commitment.status = 'cancelled' then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'reminder_resolved',
      processed_at = clock_timestamp()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'already_cancelled',
      'completed', completed
    );
  end if;

  if p_action = 'cancel' then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'reminder_cancel_deferred',
      processed_at = clock_timestamp()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'cancel_deferred',
      'completed', completed
    );
  end if;

  completion_time := clock_timestamp();

  update public.commitments
  set
    status = 'done',
    completed_at = completion_time
  where id = current_commitment.id;

  for cancelled_message in
    update public.scheduled_messages
    set
      state = 'cancelled',
      claimed_at = null,
      lease_expires_at = null,
      next_attempt_at = null
    where
      commitment_id = current_commitment.id
      and state = 'pending'
    returning id
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
      current_commitment.id,
      'scheduled_message.cancelled',
      completion_time,
      'owner',
      'scheduled-message-cancelled:' || cancelled_message.id::text,
      '{}'::jsonb
    );
  end loop;

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
    'commitment.done',
    completion_time,
    'owner',
    'commitment-done:' || current_commitment.id::text,
    '{}'::jsonb
  );

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'reminder_done',
    processed_at = completion_time,
    resolved_action_key = action_key
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'reminder completion failed';
  end if;

  return jsonb_build_object(
    'kind', 'done',
    'completed', true,
    'completedAt', completion_time
  );
end;
$$;

revoke all on function public.claim_due_simple_reminders(
  timestamptz, integer
) from public, anon, authenticated;
revoke all on function public.record_simple_reminder_result(
  uuid, integer, text, timestamptz, bigint, timestamptz
) from public, anon, authenticated;
revoke all on function public.resolve_simple_reminder_action(
  bigint, bigint, text, uuid, integer, text
) from public, anon, authenticated;

grant execute on function public.claim_due_simple_reminders(
  timestamptz, integer
) to service_role;
grant execute on function public.record_simple_reminder_result(
  uuid, integer, text, timestamptz, bigint, timestamptz
) to service_role;
grant execute on function public.resolve_simple_reminder_action(
  bigint, bigint, text, uuid, integer, text
) to service_role;
