create table public.commitment_cancellation_intents (
  commitment_id uuid primary key
    references public.commitments(id) on delete cascade,
  version integer not null check (version > 0),
  state text not null check (
    state in ('pending', 'kept', 'done', 'cancelled')
  ),
  last_update_id bigint not null unique
    references public.telegram_updates(update_id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commitment_cancellation_intents_resolution_check check (
    (state = 'pending' and resolved_at is null)
    or (state <> 'pending' and resolved_at is not null)
  )
);

alter table public.commitment_cancellation_intents
  enable row level security;
revoke all on table public.commitment_cancellation_intents
  from anon, authenticated;
grant select on table public.commitment_cancellation_intents
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
      'work_session_draft_stale'
    )
  );

create function public.cancel_unsent_commitment_messages(
  p_commitment_id uuid,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cancelled_message record;
begin
  for cancelled_message in
    update public.scheduled_messages
    set
      state = 'cancelled',
      claimed_at = null,
      lease_expires_at = null,
      lease_token = null,
      delivery_started_at = null,
      next_attempt_at = null
    where
      commitment_id = p_commitment_id
      and (
        state = 'pending'
        or (
          state = 'claimed'
          and delivery_started_at is null
        )
      )
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
      p_commitment_id,
      'scheduled_message.cancelled',
      p_occurred_at,
      'owner',
      'scheduled-message-cancelled:' ||
        cancelled_message.id::text,
      '{}'::jsonb
    )
    on conflict (idempotency_key) do nothing;
  end loop;
end;
$$;

revoke all on function public.cancel_unsent_commitment_messages(
  uuid, timestamptz
) from public, anon, authenticated;

create function public.list_active_commitment_status(
  p_owner_id text
)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', commitment.id,
        'definitionOfDone', commitment.definition_of_done,
        'targetAt', commitment.target_at,
        'nextKind',
          case
            when session.id is not null then 'work_session'
            when reminder.id is not null then 'simple_reminder'
            else null
          end,
        'nextAt',
          case
            when session.id is not null then session.start_at
            else reminder.due_at
          end,
        'calendarStatus', session.calendar_status,
        'calendarCheckedAt', session.calendar_checked_at
      )
      order by commitment.target_at, commitment.id
    ),
    '[]'::jsonb
  )
  from public.commitments as commitment
  left join lateral (
    select
      work_session.id,
      work_session.start_at,
      work_session.calendar_status,
      work_session.calendar_checked_at
    from public.work_sessions as work_session
    where
      work_session.commitment_id = commitment.id
      and work_session.status = 'planned'
    order by work_session.sequence_number, work_session.id
    limit 1
  ) as session on true
  left join lateral (
    select message.id, message.due_at
    from public.scheduled_messages as message
    where
      message.commitment_id = commitment.id
      and message.kind = 'simple_reminder'
      and (
        message.state = 'pending'
        or (
          message.state = 'claimed'
          and message.delivery_started_at is null
        )
      )
    order by message.due_at, message.id
    limit 1
  ) as reminder on session.id is null
  where
    p_owner_id is not null
    and p_owner_id ~ '^[1-9][0-9]{0,18}$'
    and commitment.owner_id = p_owner_id
    and commitment.status = 'active';
$$;

revoke all on function public.list_active_commitment_status(text)
  from public, anon, authenticated;
grant execute on function public.list_active_commitment_status(text)
  to service_role;

create or replace function public.resolve_simple_reminder_action(
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
  current_intent public.commitment_cancellation_intents;
  action_key text;
  action_time timestamptz;
begin
  insert into public.telegram_updates (
    update_id,
    processing_status,
    is_owner_private
  )
  values (p_update_id, 'claimed', true)
  on conflict (update_id) do nothing
  returning true into claimed;

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
    raise exception 'invalid reminder owner';
  end if;

  select *
  into current_commitment
  from public.commitments
  where id = p_commitment_id
  for update;

  if (
    p_commitment_id is null
    or p_version is null
    or p_version < 1
    or p_action not in ('done', 'cancel')
    or current_commitment.id is null
  ) then
    if coalesce(claimed, false) then
      update public.telegram_updates
      set
        processing_status = 'processed',
        processing_result = 'reminder_malformed',
        processed_at = clock_timestamp()
      where
        update_id = p_update_id
        and processing_status = 'claimed'
      returning true into completed;
    end if;
    return jsonb_build_object(
      'kind', 'malformed', 'completed', true
    );
  end if;

  if not coalesce(claimed, false) then
    select *
    into current_intent
    from public.commitment_cancellation_intents
    where commitment_id = current_commitment.id;
    if current_commitment.status = 'done' then
      return jsonb_build_object(
        'kind', 'already_done',
        'completed', true,
        'completedAt', current_commitment.completed_at
      );
    end if;
    if current_commitment.status = 'cancelled' then
      return jsonb_build_object(
        'kind', 'already_cancelled', 'completed', true
      );
    end if;
    if (
      p_action = 'cancel'
      and current_intent.state = 'pending'
    ) then
      return jsonb_build_object(
        'kind', 'cancel_pending',
        'completed', true,
        'commitmentId', current_commitment.id,
        'version', current_intent.version
      );
    end if;
    if (
      p_action = 'cancel'
      and current_intent.state = 'kept'
    ) then
      return jsonb_build_object(
        'kind', 'kept', 'completed', true
      );
    end if;
    return jsonb_build_object(
      'kind', 'stale', 'completed', true
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
      'kind', 'already_cancelled', 'completed', completed
    );
  end if;

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
      'kind', 'stale', 'completed', completed
    );
  end if;

  if p_action = 'cancel' then
    action_time := clock_timestamp();
    insert into public.commitment_cancellation_intents (
      commitment_id,
      version,
      state,
      last_update_id,
      resolved_at,
      created_at,
      updated_at
    )
    values (
      current_commitment.id,
      1,
      'pending',
      p_update_id,
      null,
      action_time,
      action_time
    )
    on conflict (commitment_id) do update
    set
      version =
        public.commitment_cancellation_intents.version + 1,
      state = 'pending',
      last_update_id = excluded.last_update_id,
      resolved_at = null,
      updated_at = excluded.updated_at
    returning * into current_intent;

    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'reminder_cancel_deferred',
      processed_at = action_time
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'cancel_pending',
      'completed', completed,
      'commitmentId', current_commitment.id,
      'version', current_intent.version
    );
  end if;

  action_time := clock_timestamp();
  action_key :=
    'p:' || current_commitment.id::text || ':' ||
    p_version::text || ':done';

  update public.commitments
  set status = 'done', completed_at = action_time
  where id = current_commitment.id;

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
    'commitment.done',
    action_time,
    'owner',
    'commitment-done:' || current_commitment.id::text,
    '{}'::jsonb
  );

  update public.commitment_cancellation_intents
  set
    state = 'done',
    resolved_at = action_time,
    updated_at = action_time
  where
    commitment_id = current_commitment.id
    and state <> 'cancelled';

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'reminder_done',
    processed_at = action_time,
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
    'completedAt', action_time
  );
end;
$$;

create function public.resolve_commitment_cancellation_action(
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
  current_intent public.commitment_cancellation_intents;
  action_key text;
  action_time timestamptz;
begin
  insert into public.telegram_updates (
    update_id,
    processing_status,
    is_owner_private
  )
  values (p_update_id, 'claimed', true)
  on conflict (update_id) do nothing
  returning true into claimed;

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
    raise exception 'invalid cancellation owner';
  end if;

  select *
  into current_commitment
  from public.commitments
  where id = p_commitment_id
  for update;
  select *
  into current_intent
  from public.commitment_cancellation_intents
  where commitment_id = p_commitment_id
  for update;

  if (
    p_commitment_id is null
    or p_version is null
    or p_version < 1
    or p_action not in ('confirm_cancel', 'keep')
    or current_commitment.id is null
  ) then
    if coalesce(claimed, false) then
      update public.telegram_updates
      set
        processing_status = 'processed',
        processing_result = 'cancellation_malformed',
        processed_at = clock_timestamp()
      where
        update_id = p_update_id
        and processing_status = 'claimed'
      returning true into completed;
    end if;
    return jsonb_build_object(
      'kind', 'malformed', 'completed', true
    );
  end if;

  if current_commitment.status = 'done' then
    if coalesce(claimed, false) then
      update public.telegram_updates
      set
        processing_status = 'processed',
        processing_result = 'cancellation_resolved',
        processed_at = clock_timestamp()
      where update_id = p_update_id;
    end if;
    return jsonb_build_object(
      'kind', 'already_done',
      'completed', true,
      'completedAt', current_commitment.completed_at
    );
  end if;

  if current_commitment.status = 'cancelled' then
    if coalesce(claimed, false) then
      update public.telegram_updates
      set
        processing_status = 'processed',
        processing_result = 'cancellation_resolved',
        processed_at = clock_timestamp()
      where update_id = p_update_id;
    end if;
    return jsonb_build_object(
      'kind', 'already_cancelled', 'completed', true
    );
  end if;

  if not coalesce(claimed, false) then
    return jsonb_build_object(
      'kind',
      case
        when current_intent.state = 'kept' then 'kept'
        else 'stale'
      end,
      'completed', true
    );
  end if;

  if (
    current_intent.commitment_id is null
    or current_intent.version <> p_version
    or current_intent.state <> 'pending'
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = case
        when current_intent.state = 'kept'
          then 'cancellation_resolved'
        else 'cancellation_stale'
      end,
      processed_at = clock_timestamp()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;
    return jsonb_build_object(
      'kind',
      case
        when current_intent.state = 'kept' then 'kept'
        else 'stale'
      end,
      'completed', completed
    );
  end if;

  action_time := clock_timestamp();
  action_key :=
    'x:' || current_commitment.id::text || ':' ||
    p_version::text || ':' || p_action;

  if p_action = 'keep' then
    update public.commitment_cancellation_intents
    set
      state = 'kept',
      resolved_at = action_time,
      updated_at = action_time
    where commitment_id = current_commitment.id;
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'cancellation_kept',
      processed_at = action_time,
      resolved_action_key = action_key
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;
    return jsonb_build_object(
      'kind', 'kept', 'completed', completed
    );
  end if;

  update public.commitments
  set status = 'cancelled', cancelled_at = action_time
  where id = current_commitment.id;

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
    'commitment.cancelled',
    action_time,
    'owner',
    'commitment-cancelled:' || current_commitment.id::text,
    '{}'::jsonb
  );

  update public.commitment_cancellation_intents
  set
    state = 'cancelled',
    resolved_at = action_time,
    updated_at = action_time
  where commitment_id = current_commitment.id;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'cancellation_cancelled',
    processed_at = action_time,
    resolved_action_key = action_key
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'commitment cancellation failed';
  end if;
  return jsonb_build_object(
    'kind', 'cancelled', 'completed', true
  );
end;
$$;

revoke all on function public.resolve_simple_reminder_action(
  bigint, bigint, text, uuid, integer, text
) from public, anon, authenticated;
revoke all on function public.resolve_commitment_cancellation_action(
  bigint, bigint, text, uuid, integer, text
) from public, anon, authenticated;

grant execute on function public.resolve_simple_reminder_action(
  bigint, bigint, text, uuid, integer, text
) to service_role;
grant execute on function public.resolve_commitment_cancellation_action(
  bigint, bigint, text, uuid, integer, text
) to service_role;
