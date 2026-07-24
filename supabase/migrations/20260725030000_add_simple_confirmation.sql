alter table public.conversation_drafts
  drop constraint conversation_drafts_state_check;

alter table public.conversation_drafts
  add constraint conversation_drafts_state_check check (
    state in ('active', 'confirmed', 'cancelled', 'expired')
  ),
  add column resolved_update_id bigint unique
    references public.telegram_updates(update_id),
  add column resolved_at timestamptz,
  add constraint conversation_drafts_resolution_check check (
    (
      state in ('active', 'expired')
      and resolved_update_id is null
      and resolved_at is null
    )
    or (
      state in ('confirmed', 'cancelled')
      and resolved_update_id is not null
      and resolved_at is not null
    )
  );

alter table public.commitments
  add column source_draft_id uuid unique
    references public.conversation_drafts(id);

create table public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  logical_key text not null unique check (
    char_length(logical_key) between 1 and 100
  ),
  commitment_id uuid not null
    references public.commitments(id),
  kind text not null check (kind = 'simple_reminder'),
  due_at timestamptz not null,
  state text not null default 'pending' check (
    state in (
      'pending',
      'claimed',
      'delivered',
      'delivery_unknown',
      'retryable_failure',
      'cancelled'
    )
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_at timestamptz,
  telegram_message_id bigint,
  last_error_class text,
  created_at timestamptz not null default now()
);

create index scheduled_messages_pending_due_idx
  on public.scheduled_messages (due_at)
  where state = 'pending';

create table public.commitment_events (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null
    references public.commitments(id),
  event_type text not null check (
    event_type in ('commitment.created', 'scheduled_message.created')
  ),
  occurred_at timestamptz not null default now(),
  actor text not null check (actor = 'owner'),
  idempotency_key text not null unique check (
    char_length(idempotency_key) between 1 and 100
  ),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
    and metadata = '{}'::jsonb
  )
);

alter table public.scheduled_messages enable row level security;
alter table public.commitment_events enable row level security;

revoke all on table public.scheduled_messages from anon, authenticated;
revoke all on table public.commitment_events from anon, authenticated;
grant select on table public.scheduled_messages to service_role;
grant select on table public.commitment_events to service_role;

alter table public.telegram_updates
  add column resolved_action_key text check (
    resolved_action_key is null
    or char_length(resolved_action_key) between 1 and 64
  );

create unique index telegram_updates_resolved_action_key_idx
  on public.telegram_updates (resolved_action_key)
  where resolved_action_key is not null;

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
      'confirmation_stale'
    )
  );

alter function public.apply_conversation_turn(
  bigint, text, uuid, integer, bigint, bigint, text, text, text, text,
  text, boolean, boolean, integer, boolean, text[], text, text, jsonb,
  text, text
) rename to apply_conversation_turn_base;

revoke all on function public.apply_conversation_turn_base(
  bigint, text, uuid, integer, bigint, bigint, text, text, text, text,
  text, boolean, boolean, integer, boolean, text[], text, text, jsonb,
  text, text
) from public, anon, authenticated, service_role;

create function public.apply_conversation_turn(
  p_update_id bigint,
  p_expected_kind text,
  p_expected_id uuid,
  p_expected_version integer,
  p_expected_source_update_id bigint,
  p_expected_correlated_update_id bigint,
  p_action text,
  p_phase text,
  p_definition_of_done text,
  p_target_at text,
  p_target_time_zone text,
  p_simple_action boolean,
  p_possible_work_session boolean,
  p_duration_minutes integer,
  p_offer_work_window_help boolean,
  p_timing_constraints text[],
  p_processing_result text,
  p_audit_input_class text,
  p_audit_payload jsonb,
  p_model_id text,
  p_prompt_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  resulting_draft public.conversation_drafts;
begin
  result := public.apply_conversation_turn_base(
    p_update_id,
    p_expected_kind,
    p_expected_id,
    p_expected_version,
    p_expected_source_update_id,
    p_expected_correlated_update_id,
    p_action,
    p_phase,
    p_definition_of_done,
    p_target_at,
    p_target_time_zone,
    p_simple_action,
    p_possible_work_session,
    p_duration_minutes,
    p_offer_work_window_help,
    p_timing_constraints,
    p_processing_result,
    p_audit_input_class,
    p_audit_payload,
    p_model_id,
    p_prompt_version
  );

  if result->>'status' = 'applied' then
    select *
    into resulting_draft
    from public.conversation_drafts
    where
      owner_key = true
      and state = 'active'
      and (
        last_update_id = p_update_id
        or id = p_expected_id
      )
    order by (last_update_id = p_update_id) desc
    limit 1;
  end if;

  if resulting_draft.id is not null then
    result := result || jsonb_build_object(
      'draftReference',
      jsonb_build_object(
        'id', resulting_draft.id,
        'version', resulting_draft.version
      )
    );
  end if;

  return result;
end;
$$;

revoke all on function public.apply_conversation_turn(
  bigint, text, uuid, integer, bigint, bigint, text, text, text, text,
  text, boolean, boolean, integer, boolean, text[], text, text, jsonb,
  text, text
) from public, anon, authenticated;

grant execute on function public.apply_conversation_turn(
  bigint, text, uuid, integer, bigint, bigint, text, text, text, text,
  text, boolean, boolean, integer, boolean, text[], text, text, jsonb,
  text, text
) to service_role;

create function public.resolve_simple_draft_action(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_draft_id uuid,
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
  current_draft public.conversation_drafts;
  created_commitment public.commitments;
  created_message public.scheduled_messages;
  action_key text;
  completed boolean := false;
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
    raise exception 'invalid confirmation owner';
  end if;

  if (
    p_draft_id is null
    or p_version is null
    or p_version < 1
    or p_action not in ('confirm', 'cancel')
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'confirmation_malformed',
      processed_at = now()
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
  into current_draft
  from public.conversation_drafts
  where id = p_draft_id
  for update;

  if current_draft.id is null then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'confirmation_malformed',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'malformed',
      'completed', completed
    );
  end if;

  if current_draft.state = 'confirmed' then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'confirmation_resolved',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'already_confirmed',
      'completed', completed
    );
  end if;

  if current_draft.state = 'cancelled' then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'confirmation_resolved',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'already_cancelled',
      'completed', completed
    );
  end if;

  if (
    current_draft.state = 'expired'
    or current_draft.expires_at <= now()
  ) then
    if current_draft.state = 'active' then
      update public.conversation_drafts
      set
        state = 'expired',
        updated_at = now()
      where id = current_draft.id;
    end if;

    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'confirmation_expired',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'expired',
      'completed', completed
    );
  end if;

  if current_draft.version <> p_version then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'confirmation_stale',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'stale',
      'completed', completed,
      'draft', jsonb_build_object(
        'id', current_draft.id,
        'version', current_draft.version,
        'definitionOfDone', current_draft.definition_of_done,
        'targetAt', current_draft.target_at
      )
    );
  end if;

  if (
    current_draft.phase <> 'complete'
    or current_draft.definition_of_done is null
    or current_draft.target_at is null
    or current_draft.target_time_zone <> 'Asia/Singapore'
    or not current_draft.simple_action
    or current_draft.possible_work_session
    or current_draft.duration_minutes is not null
    or current_draft.offer_work_window_help
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'confirmation_malformed',
      processed_at = now()
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
    'd:' || current_draft.id::text || ':' ||
    current_draft.version::text || ':' || p_action;

  if p_action = 'cancel' then
    update public.conversation_drafts
    set
      state = 'cancelled',
      resolved_update_id = p_update_id,
      resolved_at = now(),
      updated_at = now()
    where id = current_draft.id;

    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'confirmation_cancelled',
      processed_at = now(),
      resolved_action_key = action_key
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'kind', 'cancelled',
      'completed', completed
    );
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

  insert into public.scheduled_messages (
    logical_key,
    commitment_id,
    kind,
    due_at,
    state
  )
  values (
    'simple-reminder:' || created_commitment.id::text,
    created_commitment.id,
    'simple_reminder',
    current_draft.target_at::timestamptz,
    'pending'
  )
  returning * into created_message;

  insert into public.commitment_events (
    commitment_id,
    event_type,
    actor,
    idempotency_key,
    metadata
  )
  values
    (
      created_commitment.id,
      'commitment.created',
      'owner',
      'commitment-created:' || created_commitment.id::text,
      '{}'::jsonb
    ),
    (
      created_commitment.id,
      'scheduled_message.created',
      'owner',
      'scheduled-message-created:' || created_message.id::text,
      '{}'::jsonb
    );

  update public.conversation_drafts
  set
    state = 'confirmed',
    resolved_update_id = p_update_id,
    resolved_at = now(),
    updated_at = now()
  where id = current_draft.id;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'confirmation_confirmed',
    processed_at = now(),
    resolved_action_key = action_key
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'confirmation completion failed';
  end if;

  return jsonb_build_object(
    'kind', 'confirmed',
    'completed', true,
    'reminderAt', current_draft.target_at
  );
end;
$$;

revoke all on function public.resolve_simple_draft_action(
  bigint, bigint, text, uuid, integer, text
) from public, anon, authenticated;

grant execute on function public.resolve_simple_draft_action(
  bigint, bigint, text, uuid, integer, text
) to service_role;
