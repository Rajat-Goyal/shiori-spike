alter table public.scheduled_messages
  add column lease_token uuid,
  add column delivery_started_at timestamptz;

with uncertain_claims as (
  update public.scheduled_messages
  set
    state = 'delivery_unknown',
    claimed_at = null,
    lease_expires_at = null,
    lease_token = null,
    delivery_started_at = null,
    last_error_class = 'delivery_unknown'
  where state = 'claimed'
  returning id, commitment_id, attempt_count
)
insert into public.commitment_events (
  commitment_id,
  event_type,
  occurred_at,
  actor,
  idempotency_key,
  metadata
)
select
  uncertain_claims.commitment_id,
  'scheduled_message.delivery_unknown',
  clock_timestamp(),
  'system',
  'delivery-result:' || uncertain_claims.id::text || ':' ||
    uncertain_claims.attempt_count::text,
  '{}'::jsonb
from uncertain_claims
on conflict (idempotency_key) do nothing;

alter table public.scheduled_messages
  add constraint scheduled_messages_lease_check check (
    (
      state = 'claimed'
      and claimed_at is not null
      and lease_expires_at is not null
      and lease_expires_at > claimed_at
      and lease_token is not null
    )
    or (
      state <> 'claimed'
      and claimed_at is null
      and lease_expires_at is null
      and lease_token is null
      and delivery_started_at is null
    )
  ),
  add constraint scheduled_messages_delivery_start_check check (
    delivery_started_at is null
    or (
      state = 'claimed'
      and delivery_started_at >= claimed_at
      and delivery_started_at < lease_expires_at
    )
  );

create unique index scheduled_messages_current_lease_idx
  on public.scheduled_messages (lease_token)
  where state = 'claimed';

drop function public.claim_due_simple_reminders(timestamptz, integer);

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
  lease_token uuid,
  chat_id bigint,
  definition_of_done text,
  target_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  uncertain_claim record;
begin
  if p_now is null or p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'invalid simple reminder claim';
  end if;

  for uncertain_claim in
    with expired_started_claims as (
      select message.id
      from public.scheduled_messages message
      where
        message.kind = 'simple_reminder'
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
    returning
      message.id,
      message.commitment_id,
      message.attempt_count
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
    cross join public.telegram_owner_delivery delivery
    where
      delivery.singleton = true
      and message.kind = 'simple_reminder'
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
    claimed.action_version,
    claimed.attempt_count,
    claimed.lease_token,
    claimed.private_chat_id,
    commitment.definition_of_done,
    commitment.target_at
  from claimed
  join public.commitments commitment
    on commitment.id = claimed.commitment_id
  order by claimed.logical_key;
end;
$$;

create function public.begin_simple_reminder_delivery(
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
begin
  if (
    p_message_id is null
    or p_attempt_count is null
    or p_attempt_count < 1
    or p_lease_token is null
    or p_started_at is null
  ) then
    raise exception 'invalid simple reminder delivery start';
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
    or current_message.lease_token <> p_lease_token
    or p_started_at < current_message.claimed_at
    or p_started_at >= current_message.lease_expires_at
  ) then
    return jsonb_build_object(
      'applied', false,
      'state', current_message.state
    );
  end if;

  update public.scheduled_messages
  set delivery_started_at = coalesce(
    delivery_started_at,
    p_started_at
  )
  where id = current_message.id;

  return jsonb_build_object(
    'applied', true,
    'state', 'claimed'
  );
end;
$$;

drop function public.record_simple_reminder_result(
  uuid,
  integer,
  text,
  timestamptz,
  bigint,
  timestamptz
);

create function public.record_simple_reminder_result(
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
    lease_expires_at = null,
    lease_token = null,
    delivery_started_at = null
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
