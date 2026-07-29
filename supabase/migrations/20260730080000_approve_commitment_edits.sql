alter table public.commitments
  add column version integer not null default 1 check (version > 0),
  add column preparation_needed boolean not null default false,
  add column updated_at timestamptz not null default clock_timestamp();

update public.commitments as commitment
set preparation_needed = true
where exists (
  select 1
  from public.work_sessions as session
  where session.commitment_id = commitment.id
);

create table public.approved_commitment_change_receipts (
  commitment_id uuid not null
    references public.commitments(id) on delete cascade,
  expected_version integer not null check (expected_version > 0),
  update_id bigint not null unique check (update_id > 0),
  applied_version integer not null check (
    applied_version = expected_version + 1
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (commitment_id, expected_version)
);

alter table public.approved_commitment_change_receipts
  enable row level security;
revoke all on table public.approved_commitment_change_receipts
  from public, anon, authenticated;
grant select on table public.approved_commitment_change_receipts
  to service_role;

alter table public.commitment_events
  drop constraint commitment_events_event_type_check,
  drop constraint commitment_events_metadata_check;

alter table public.commitment_events
  add constraint commitment_events_event_type_check check (
    event_type in (
      'commitment.created',
      'commitment.changed',
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
  ),
  add constraint commitment_events_metadata_check check (
    jsonb_typeof(metadata) = 'object'
  );

create function public.mark_commitment_preparation_from_work_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.commitments
  set preparation_needed = true
  where id = new.commitment_id
    and not preparation_needed;
  return new;
end;
$$;

revoke all on function
  public.mark_commitment_preparation_from_work_session()
  from public, anon, authenticated;

create trigger work_sessions_mark_commitment_preparation
after insert on public.work_sessions
for each row execute function
  public.mark_commitment_preparation_from_work_session();

create or replace function public.protect_commitment_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.target_at is distinct from old.target_at
    and coalesce(
      current_setting(
        'shiori.approved_commitment_change_id',
        true
      ),
      ''
    ) <> old.id::text
  ) then
    raise exception 'commitment target is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.list_active_commitment_status(
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
        'version', commitment.version,
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

create function public.apply_approved_commitment_change(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_commitment_id uuid,
  p_expected_version integer,
  p_definition_of_done text,
  p_target_at timestamptz,
  p_preparation_required boolean,
  p_next_start_at timestamptz,
  p_next_end_at timestamptz,
  p_next_duration_minutes integer,
  p_timing_constraints text,
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
  action_at timestamptz := clock_timestamp();
  current_commitment public.commitments;
  current_session public.work_sessions;
  created_message public.scheduled_messages;
  created_session public.work_sessions;
  changed_fields jsonb := '[]'::jsonb;
  new_version integer;
  next_sequence integer;
  schedule_affected boolean;
  session_changed boolean;
begin
  if (
    p_update_id is null
    or p_update_id < 1
    or p_owner_chat_id is null
    or p_owner_id is null
    or p_owner_id !~ '^[1-9][0-9]{0,18}$'
    or p_owner_id <> p_owner_chat_id::text
    or p_commitment_id is null
    or p_expected_version is null
    or p_expected_version < 1
  ) then
    raise exception 'invalid approved commitment change authority';
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
    singleton
    and private_chat_id = p_owner_chat_id
  for update;

  if not found then
    raise exception 'invalid approved commitment change owner';
  end if;

  select *
  into current_commitment
  from public.commitments
  where
    id = p_commitment_id
    and owner_id = p_owner_id
  for update;

  if current_commitment.id is null then
    return jsonb_build_object('kind', 'missing');
  end if;
  if current_commitment.status <> 'active' then
    return jsonb_build_object('kind', 'terminal');
  end if;
  if exists (
    select 1
    from public.approved_commitment_change_receipts as receipt
    where
      receipt.commitment_id = current_commitment.id
      and receipt.expected_version = p_expected_version
      and receipt.update_id = p_update_id
  ) then
    return jsonb_build_object('kind', 'replay');
  end if;
  if current_commitment.version <> p_expected_version then
    return jsonb_build_object('kind', 'stale');
  end if;

  if (
    p_definition_of_done is null
    or char_length(btrim(p_definition_of_done)) not between 1 and 500
    or p_target_at is null
    or p_target_at <= action_at
    or p_preparation_required is null
    or (
      not p_preparation_required
      and (
        p_next_start_at is not null
        or p_next_end_at is not null
        or p_next_duration_minutes is not null
        or p_timing_constraints is not null
        or p_calendar_attempted_at is not null
        or p_calendar_checked_at is not null
        or p_final_observation is not null
        or p_calendar_status <> 'not_applicable'
        or p_conflict_consent
      )
    )
    or (
      p_preparation_required
      and (
        p_next_start_at is null
        or p_next_end_at is null
        or p_next_duration_minutes not in (30, 60, 90, 120)
        or p_next_start_at <= action_at
        or p_next_end_at <> p_next_start_at +
          p_next_duration_minutes * interval '1 minute'
        or p_next_end_at > p_target_at
        or p_timing_constraints is null
        or char_length(btrim(p_timing_constraints)) not between 1 and 500
        or p_calendar_attempted_at is null
        or p_calendar_status not in (
          'free',
          'conflict_kept',
          'unverified'
        )
        or p_final_observation not in (
          'free',
          'conflict',
          'unavailable'
        )
        or (
          p_calendar_status = 'free'
          and (
            p_calendar_checked_at is null
            or p_final_observation <> 'free'
            or p_conflict_consent
          )
        )
        or (
          p_calendar_status = 'conflict_kept'
          and (
            p_calendar_checked_at is null
            or p_final_observation <> 'conflict'
            or not p_conflict_consent
          )
        )
        or (
          p_calendar_status = 'unverified'
          and (
            p_calendar_checked_at is not null
            or p_final_observation <> 'unavailable'
            or p_conflict_consent
          )
        )
      )
    )
  ) then
    raise exception 'invalid approved commitment change proposal';
  end if;

  select *
  into current_session
  from public.work_sessions
  where
    commitment_id = current_commitment.id
    and status = 'planned'
  order by sequence_number, id
  limit 1
  for update;

  session_changed :=
    (current_session.id is null) is distinct from
      (not p_preparation_required)
    or (
      p_preparation_required
      and current_session.id is not null
      and (
        current_session.start_at <> p_next_start_at
        or current_session.end_at <> p_next_end_at
        or current_session.duration_minutes <>
          p_next_duration_minutes
        or current_session.timing_constraints <>
          btrim(p_timing_constraints)
      )
    );

  if current_commitment.definition_of_done <>
    btrim(p_definition_of_done)
  then
    changed_fields := changed_fields ||
      jsonb_build_array('definition');
  end if;
  if current_commitment.target_at <> p_target_at then
    changed_fields := changed_fields ||
      jsonb_build_array('target');
  end if;
  if current_commitment.preparation_needed <>
    p_preparation_required
  then
    changed_fields := changed_fields ||
      jsonb_build_array('preparation');
  end if;
  if session_changed then
    changed_fields := changed_fields ||
      jsonb_build_array('next_work_session');
  end if;

  if jsonb_array_length(changed_fields) = 0 then
    return jsonb_build_object('kind', 'unchanged');
  end if;

  new_version := current_commitment.version + 1;
  insert into public.approved_commitment_change_receipts (
    commitment_id,
    expected_version,
    update_id,
    applied_version
  )
  values (
    current_commitment.id,
    current_commitment.version,
    p_update_id,
    new_version
  )
  on conflict do nothing;

  if not found then
    return jsonb_build_object('kind', 'replay');
  end if;

  schedule_affected :=
    session_changed
    or (
      not p_preparation_required
      and current_commitment.target_at <> p_target_at
    );

  if schedule_affected then
    perform public.cancel_unsent_commitment_messages(
      current_commitment.id,
      action_at
    );
  end if;

  if current_session.id is not null and session_changed then
    update public.work_sessions
    set
      status = 'cancelled',
      outcome_at = action_at
    where id = current_session.id;
  end if;

  perform set_config(
    'shiori.approved_commitment_change_id',
    current_commitment.id::text,
    true
  );

  update public.commitments
  set
    definition_of_done = btrim(p_definition_of_done),
    target_at = p_target_at,
    preparation_needed = p_preparation_required,
    version = new_version,
    updated_at = action_at
  where id = current_commitment.id;

  if schedule_affected and p_preparation_required then
    select coalesce(max(sequence_number), 0) + 1
    into next_sequence
    from public.work_sessions
    where commitment_id = current_commitment.id;

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
      action_version,
      timing_constraints,
      outcome_at,
      is_recovery
    )
    values (
      current_commitment.id,
      next_sequence,
      p_next_start_at,
      p_next_end_at,
      p_next_duration_minutes,
      'planned',
      p_calendar_status,
      p_calendar_attempted_at,
      p_calendar_checked_at,
      p_conflict_consent,
      p_final_observation,
      1,
      btrim(p_timing_constraints),
      null,
      false
    )
    returning * into created_session;

    insert into public.scheduled_messages (
      logical_key,
      commitment_id,
      work_session_id,
      kind,
      due_at,
      state,
      action_version
    )
    values (
      'work-session-start:' || created_session.id::text ||
        ':v' || new_version::text,
      current_commitment.id,
      created_session.id,
      'work_session_start',
      created_session.start_at,
      'pending',
      1
    )
    returning * into created_message;

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
      'scheduled_message.created',
      action_at,
      'owner',
      'scheduled-message-created:' || created_message.id::text,
      '{}'::jsonb
    );

    insert into public.scheduled_messages (
      logical_key,
      commitment_id,
      work_session_id,
      kind,
      due_at,
      state,
      action_version
    )
    values (
      'work-session-end:' || created_session.id::text ||
        ':v' || new_version::text,
      current_commitment.id,
      created_session.id,
      'work_session_end',
      created_session.end_at,
      'pending',
      1
    )
    returning * into created_message;

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
      'scheduled_message.created',
      action_at,
      'owner',
      'scheduled-message-created:' || created_message.id::text,
      '{}'::jsonb
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
      'work_session.created',
      action_at,
      'owner',
      'work-session-created:' || created_session.id::text,
      '{}'::jsonb
    );
  elsif schedule_affected and not p_preparation_required then
    insert into public.scheduled_messages (
      logical_key,
      commitment_id,
      kind,
      due_at,
      state,
      action_version
    )
    values (
      'simple-reminder:' || current_commitment.id::text ||
        ':v' || new_version::text,
      current_commitment.id,
      'simple_reminder',
      p_target_at,
      'pending',
      new_version
    )
    returning * into created_message;

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
      'scheduled_message.created',
      action_at,
      'owner',
      'scheduled-message-created:' || created_message.id::text,
      '{}'::jsonb
    );
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
    current_commitment.id,
    'commitment.changed',
    action_at,
    'owner',
    'commitment-changed:' || current_commitment.id::text ||
      ':v' || new_version::text,
    jsonb_build_object(
      'changedFields', changed_fields,
      'previousVersion', current_commitment.version,
      'version', new_version
    )
  );

  return jsonb_build_object(
    'kind', 'applied',
    'version', new_version
  );
end;
$$;

revoke all on function public.apply_approved_commitment_change(
  bigint, bigint, text, uuid, integer, text, timestamptz, boolean,
  timestamptz, timestamptz, integer, text, timestamptz, timestamptz,
  boolean, text, text
) from public, anon, authenticated;
grant execute on function public.apply_approved_commitment_change(
  bigint, bigint, text, uuid, integer, text, timestamptz, boolean,
  timestamptz, timestamptz, integer, text, timestamptz, timestamptz,
  boolean, text, text
) to service_role;

alter table public.agent_pending_approvals
  drop constraint agent_pending_approvals_tool_name_check,
  add constraint agent_pending_approvals_tool_name_check check (
    tool_name in ('execute_commitment', 'update_commitment')
  );

create function public.read_agent_commitment_edit_approval(
  p_chat_id bigint,
  p_draft_id text,
  p_draft_version bigint,
  p_tool_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  approval public.agent_pending_approvals;
  session public.agent_sessions;
begin
  if (
    p_chat_id is null
    or p_draft_id is null
    or p_draft_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_draft_version is null
    or p_draft_version < 1
    or p_tool_name <> 'update_commitment'
  ) then
    raise exception 'invalid commitment edit approval read';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);
  select *
  into approval
  from public.agent_pending_approvals
  where chat_id = p_chat_id
  for update;

  if approval.id is null then
    return jsonb_build_object('kind', 'missing');
  end if;

  select *
  into session
  from public.agent_sessions
  where id = approval.session_id
  for update;

  if (
    session.id is null
    or approval.expires_at <= now()
    or session.expires_at <= now()
  ) then
    if session.id is not null then
      delete from public.agent_sessions where id = session.id;
    else
      delete from public.agent_pending_approvals
      where id = approval.id;
    end if;
    return jsonb_build_object('kind', 'expired');
  end if;

  if (
    session.chat_id <> p_chat_id
    or approval.draft_id <> p_draft_id
    or approval.draft_version <> p_draft_version
    or approval.tool_name <> p_tool_name
  ) then
    return jsonb_build_object('kind', 'missing');
  end if;

  return jsonb_build_object(
    'approval', public.agent_approval_snapshot(approval.id),
    'kind', 'current'
  );
end;
$$;

create function public.stage_agent_commitment_edit_approval(
  p_chat_id bigint,
  p_update_id bigint,
  p_expected_kind text,
  p_session_id uuid,
  p_draft_id text,
  p_draft_version bigint,
  p_tool_name text,
  p_sealed_run_state text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_inserted boolean := false;
  session public.agent_sessions;
  current_approval public.agent_pending_approvals;
  created_approval_id uuid;
begin
  if (
    p_chat_id is null
    or p_update_id is null
    or p_update_id < 1
    or p_expected_kind <> 'none'
    or p_session_id is null
    or p_draft_id is null
    or p_draft_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_draft_version is null
    or p_draft_version < 1
    or p_tool_name <> 'update_commitment'
    or p_sealed_run_state is null
    or char_length(p_sealed_run_state) = 0
  ) then
    raise exception 'invalid commitment edit approval stage';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);
  insert into public.agent_approval_update_receipts (
    operation,
    update_id,
    chat_id
  )
  values ('stage', p_update_id, p_chat_id)
  on conflict (operation, update_id) do nothing
  returning true into receipt_inserted;

  if not coalesce(receipt_inserted, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  select *
  into session
  from public.agent_sessions
  where id = p_session_id
  for update;

  if (
    session.id is null
    or session.chat_id <> p_chat_id
    or session.expires_at <= now()
  ) then
    if session.id is not null and session.expires_at <= now() then
      delete from public.agent_sessions where id = session.id;
    end if;
    return jsonb_build_object('kind', 'stale');
  end if;

  select *
  into current_approval
  from public.agent_pending_approvals
  where chat_id = p_chat_id
  for update;

  if current_approval.id is not null then
    return jsonb_build_object('kind', 'stale');
  end if;

  insert into public.agent_pending_approvals (
    chat_id,
    session_id,
    draft_id,
    draft_version,
    tool_name,
    sealed_run_state,
    stage_update_id,
    expires_at
  )
  values (
    p_chat_id,
    p_session_id,
    p_draft_id,
    p_draft_version,
    p_tool_name,
    p_sealed_run_state,
    p_update_id,
    session.expires_at
  )
  returning id into created_approval_id;

  return jsonb_build_object(
    'approval',
    public.agent_approval_snapshot(created_approval_id),
    'kind',
    'staged'
  );
end;
$$;

create function public.resolve_agent_commitment_edit_approval(
  p_chat_id bigint,
  p_update_id bigint,
  p_approval_id uuid,
  p_approval_version bigint,
  p_draft_id text,
  p_draft_version bigint,
  p_tool_name text,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_inserted boolean := false;
  approval public.agent_pending_approvals;
  approval_chat_id bigint;
  session public.agent_sessions;
begin
  if (
    p_chat_id is null
    or p_update_id is null
    or p_update_id < 1
    or p_approval_id is null
    or p_approval_version is null
    or p_approval_version < 1
    or p_draft_id is null
    or p_draft_version is null
    or p_draft_version < 1
    or p_tool_name <> 'update_commitment'
    or p_decision not in ('approve', 'reject')
  ) then
    raise exception 'invalid commitment edit approval resolution';
  end if;

  select chat_id
  into approval_chat_id
  from public.agent_pending_approvals
  where id = p_approval_id;

  perform pg_advisory_xact_lock(
    coalesce(approval_chat_id, p_chat_id)
  );

  insert into public.agent_approval_update_receipts (
    operation,
    update_id,
    chat_id
  )
  values ('resolve', p_update_id, p_chat_id)
  on conflict (operation, update_id) do nothing
  returning true into receipt_inserted;

  select *
  into approval
  from public.agent_pending_approvals
  where id = p_approval_id
  for update;

  if approval.id is null then
    return jsonb_build_object(
      'kind',
      case
        when coalesce(receipt_inserted, false) then 'missing'
        else 'replay'
      end
    );
  end if;

  select *
  into session
  from public.agent_sessions
  where id = approval.session_id
  for update;

  if (
    session.id is null
    or approval.expires_at <= now()
    or session.expires_at <= now()
  ) then
    if session.id is not null then
      delete from public.agent_sessions where id = session.id;
    else
      delete from public.agent_pending_approvals
      where id = approval.id;
    end if;
    return jsonb_build_object('kind', 'expired');
  end if;

  if (
    approval.version <> p_approval_version
    or approval.draft_id <> p_draft_id
    or approval.draft_version <> p_draft_version
    or approval.tool_name <> p_tool_name
    or approval.chat_id <> p_chat_id
    or session.chat_id <> p_chat_id
  ) then
    return jsonb_build_object('kind', 'stale');
  end if;

  if approval.approved_update_id is not null then
    if p_decision = 'reject' then
      return jsonb_build_object('kind', 'stale');
    end if;
    return jsonb_build_object(
      'kind', 'claimed',
      'sealedRunState', approval.sealed_run_state,
      'sessionId', approval.session_id
    );
  end if;

  if not coalesce(receipt_inserted, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  if p_decision = 'reject' then
    delete from public.agent_pending_approvals
    where id = approval.id;
    return jsonb_build_object('kind', 'rejected');
  end if;

  update public.agent_pending_approvals
  set approved_update_id = p_update_id
  where id = approval.id;

  return jsonb_build_object(
    'kind', 'claimed',
    'sealedRunState', approval.sealed_run_state,
    'sessionId', approval.session_id
  );
end;
$$;

revoke all on function public.read_agent_commitment_edit_approval(
  bigint, text, bigint, text
) from public, anon, authenticated;
revoke all on function public.stage_agent_commitment_edit_approval(
  bigint, bigint, text, uuid, text, bigint, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_agent_commitment_edit_approval(
  bigint, bigint, uuid, bigint, text, bigint, text, text
) from public, anon, authenticated;

grant execute on function public.read_agent_commitment_edit_approval(
  bigint, text, bigint, text
) to service_role;
grant execute on function public.stage_agent_commitment_edit_approval(
  bigint, bigint, text, uuid, text, bigint, text, text
) to service_role;
grant execute on function public.resolve_agent_commitment_edit_approval(
  bigint, bigint, uuid, bigint, text, bigint, text, text
) to service_role;

alter function public.read_agent_product_context(
  text, uuid, integer
) rename to read_agent_product_context_before_commitment_edits;

revoke all on function
  public.read_agent_product_context_before_commitment_edits(
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
  focused_commitment jsonb;
begin
  result :=
    public.read_agent_product_context_before_commitment_edits(
      p_owner_id,
      p_focused_entity_id,
      p_limit
    );

  result := jsonb_set(
    result,
    '{commitments}',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', commitment.id,
            'version', commitment.version,
            'status', commitment.status,
            'definitionOfDone', commitment.definition_of_done,
            'targetAt', commitment.target_at,
            'preparationNeeded', commitment.preparation_needed
          )
          order by
            (commitment.status = 'active') desc,
            commitment.updated_at desc,
            commitment.id
        )
        from (
          select *
          from public.commitments
          where owner_id = p_owner_id
          order by
            (status = 'active') desc,
            updated_at desc,
            id
          limit p_limit
        ) as commitment
      ),
      '[]'::jsonb
    )
  );

  result := jsonb_set(
    result,
    '{workSessions}',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', session.id,
            'commitmentId', session.commitment_id,
            'status', session.status,
            'startAt', session.start_at,
            'endAt', session.end_at,
            'durationMinutes', session.duration_minutes,
            'timingConstraints', session.timing_constraints,
            'calendarStatus', session.calendar_status,
            'calendarAttemptedAt', session.calendar_attempted_at,
            'calendarCheckedAt', session.calendar_checked_at,
            'conflictConsent', session.conflict_consent,
            'finalCalendarObservation',
              session.final_calendar_observation
          )
          order by session.created_at desc, session.id
        )
        from (
          select session.*
          from public.work_sessions as session
          join public.commitments as commitment
            on commitment.id = session.commitment_id
          where commitment.owner_id = p_owner_id
          order by session.created_at desc, session.id
          limit least(20, p_limit * 2)
        ) as session
      ),
      '[]'::jsonb
    )
  );

  if p_focused_entity_id is not null then
    select jsonb_build_object(
      'kind', 'commitment',
      'entity', jsonb_build_object(
        'id', commitment.id,
        'version', commitment.version,
        'status', commitment.status,
        'definitionOfDone', commitment.definition_of_done,
        'targetAt', commitment.target_at,
        'preparationNeeded', commitment.preparation_needed
      )
    )
    into focused_commitment
    from public.commitments as commitment
    where
      commitment.id = p_focused_entity_id
      and commitment.owner_id = p_owner_id;

    if focused_commitment is not null then
      result := jsonb_set(
        result,
        '{focusedEntity}',
        focused_commitment
      );
    end if;
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

alter function public.resolve_simple_reminder_action(
  bigint, bigint, text, uuid, integer, text
) rename to resolve_simple_reminder_action_before_commitment_edits;

revoke all on function
  public.resolve_simple_reminder_action_before_commitment_edits(
    bigint, bigint, text, uuid, integer, text
  )
  from public, anon, authenticated, service_role;

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
  current_commitment public.commitments;
begin
  if (
    p_commitment_id is null
    or p_version is null
    or p_version < 1
    or p_action not in ('done', 'cancel')
  ) then
    return
      public.resolve_simple_reminder_action_before_commitment_edits(
        p_update_id,
        p_owner_chat_id,
        p_owner_id,
        p_commitment_id,
        p_version,
        p_action
      );
  end if;

  select *
  into current_commitment
  from public.commitments
  where
    id = p_commitment_id
    and owner_id = p_owner_id
  for update;

  if (
    current_commitment.id is not null
    and current_commitment.status = 'active'
    and current_commitment.version <> p_version
  ) then
    return
      public.resolve_simple_reminder_action_before_commitment_edits(
        p_update_id,
        p_owner_chat_id,
        p_owner_id,
        p_commitment_id,
        2,
        p_action
      );
  end if;

  return
    public.resolve_simple_reminder_action_before_commitment_edits(
      p_update_id,
      p_owner_chat_id,
      p_owner_id,
      p_commitment_id,
      1,
      p_action
    );
end;
$$;

revoke all on function public.resolve_simple_reminder_action(
  bigint, bigint, text, uuid, integer, text
) from public, anon, authenticated;
grant execute on function public.resolve_simple_reminder_action(
  bigint, bigint, text, uuid, integer, text
) to service_role;
