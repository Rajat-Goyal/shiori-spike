alter table public.conversation_permission_candidates
  add column return_draft_id uuid
    references public.conversation_drafts(id),
  add column return_draft_version integer check (
    return_draft_version > 0
  ),
  add constraint conversation_permission_return_draft_check check (
    (return_draft_id is null) = (return_draft_version is null)
  );

create table public.conversation_control_operation_receipts (
  update_id bigint primary key
    references public.telegram_updates(update_id) on delete cascade,
  operation text not null check (
    operation in ('create_separate_permission', 'resolve_separate_permission', 'reset')
  ),
  request_payload jsonb not null,
  result_payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.conversation_control_operation_receipts
  enable row level security;

revoke all on table public.conversation_control_operation_receipts
  from anon, authenticated;
grant select on table public.conversation_control_operation_receipts
  to service_role;

create function public.create_separate_conversation_permission(
  p_update_id bigint,
  p_expected_focus_id uuid,
  p_expected_focus_version integer,
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
  current_draft public.conversation_drafts;
  receipt public.conversation_control_operation_receipts;
  request_payload jsonb;
  result_payload jsonb;
  completed boolean := false;
begin
  request_payload := jsonb_build_object(
    'expectedFocusId', p_expected_focus_id,
    'expectedFocusVersion', p_expected_focus_version,
    'definitionOfDone', p_definition_of_done,
    'targetAt', p_target_at,
    'targetTimeZone', p_target_time_zone,
    'simpleAction', p_simple_action,
    'possibleWorkSession', p_possible_work_session,
    'durationMinutes', p_duration_minutes,
    'offerWorkWindowHelp', p_offer_work_window_help,
    'timingConstraints', p_timing_constraints,
    'processingResult', p_processing_result,
    'auditInputClass', p_audit_input_class,
    'auditPayload', p_audit_payload,
    'modelId', p_model_id,
    'promptVersion', p_prompt_version
  );

  select *
  into receipt
  from public.conversation_control_operation_receipts
  where update_id = p_update_id;

  if receipt.update_id is not null then
    if
      receipt.operation <> 'create_separate_permission'
      or receipt.request_payload <> request_payload
    then
      raise exception 'separate permission replay changed';
    end if;
    return receipt.result_payload;
  end if;

  if
    p_expected_focus_id is null
    or p_expected_focus_version is null
    or p_expected_focus_version < 1
    or p_processing_result <> 'conversation'
    or p_audit_input_class <> 'implied_intention'
    or not coalesce(
      public.conversation_decision_payload_is_valid(p_audit_payload),
      false
    )
    or p_model_id is null
    or char_length(btrim(p_model_id)) not between 1 and 200
    or p_prompt_version is null
    or char_length(btrim(p_prompt_version)) not between 1 and 200
    or p_simple_action is null
    or p_possible_work_session is null
    or p_offer_work_window_help is null
    or p_timing_constraints is null
    or (
      p_target_at is not null
      and p_target_at::timestamptz <= now()
    )
  then
    raise exception 'invalid separate permission request';
  end if;

  if not exists (
    select 1
    from public.telegram_updates
    where
      update_id = p_update_id
      and processing_status = 'claimed'
      and is_owner_private
  ) then
    raise exception 'separate permission is not a claimed owner update';
  end if;

  perform 1
  from public.telegram_owner_delivery
  where singleton
  for update;

  if not found then
    raise exception 'conversation owner singleton is unavailable';
  end if;

  if exists (
    select 1
    from public.conversation_permission_candidates
    where singleton
  ) then
    raise exception 'a permission request is already active';
  end if;

  select *
  into current_draft
  from public.conversation_drafts
  where owner_key and state = 'active'
  for update;

  if
    current_draft.id is null
    or current_draft.id <> p_expected_focus_id
    or current_draft.version <> p_expected_focus_version
    or current_draft.expires_at <= now()
  then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation_stale',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    result_payload := jsonb_build_object(
      'status', 'stale',
      'completed', completed,
      'draftCreated', false
    );
  else
    update public.conversation_drafts
    set
      state = 'parked',
      updated_at = now()
    where id = current_draft.id;

    insert into public.conversation_permission_candidates (
      source_update_id,
      correlated_update_id,
      definition_of_done,
      target_at,
      target_time_zone,
      simple_action,
      possible_work_session,
      duration_minutes,
      offer_work_window_help,
      timing_constraints,
      expires_at,
      return_draft_id,
      return_draft_version
    )
    values (
      p_update_id,
      null,
      p_definition_of_done,
      p_target_at,
      p_target_time_zone,
      p_simple_action,
      p_possible_work_session,
      p_duration_minutes,
      p_offer_work_window_help,
      p_timing_constraints,
      now() + interval '24 hours',
      current_draft.id,
      current_draft.version
    );

    insert into public.model_decisions (
      update_id,
      draft_id,
      input_class,
      decision_payload,
      model_id,
      prompt_version
    )
    values (
      p_update_id,
      current_draft.id,
      p_audit_input_class,
      p_audit_payload,
      p_model_id,
      p_prompt_version
    );

    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    if not coalesce(completed, false) then
      raise exception 'separate permission completion failed';
    end if;

    result_payload := jsonb_build_object(
      'status', 'applied',
      'completed', true,
      'draftCreated', false
    );
  end if;

  insert into public.conversation_control_operation_receipts (
    update_id,
    operation,
    request_payload,
    result_payload
  )
  values (
    p_update_id,
    'create_separate_permission',
    request_payload,
    result_payload
  );

  return result_payload;
end;
$$;

create function public.resolve_separate_conversation_permission(
  p_update_id bigint,
  p_expected_id uuid,
  p_expected_source_update_id bigint,
  p_expected_correlated_update_id bigint,
  p_action text,
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
  permission_candidate public.conversation_permission_candidates;
  return_draft public.conversation_drafts;
  created_draft public.conversation_drafts;
  receipt public.conversation_control_operation_receipts;
  request_payload jsonb;
  result_payload jsonb;
  completed boolean := false;
begin
  request_payload := jsonb_build_object(
    'expectedId', p_expected_id,
    'expectedSourceUpdateId', p_expected_source_update_id,
    'expectedCorrelatedUpdateId', p_expected_correlated_update_id,
    'action', p_action,
    'processingResult', p_processing_result,
    'auditInputClass', p_audit_input_class,
    'auditPayload', p_audit_payload,
    'modelId', p_model_id,
    'promptVersion', p_prompt_version
  );

  select *
  into receipt
  from public.conversation_control_operation_receipts
  where update_id = p_update_id;

  if receipt.update_id is not null then
    if
      receipt.operation <> 'resolve_separate_permission'
      or receipt.request_payload <> request_payload
    then
      raise exception 'separate permission resolution replay changed';
    end if;
    return receipt.result_payload;
  end if;

  select *
  into permission_candidate
  from public.conversation_permission_candidates
  where singleton;

  if permission_candidate.return_draft_id is null then
    return public.apply_conversation_turn(
      p_update_id,
      'permission',
      p_expected_id,
      null,
      p_expected_source_update_id,
      p_expected_correlated_update_id,
      p_action,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      p_processing_result,
      p_audit_input_class,
      p_audit_payload,
      p_model_id,
      p_prompt_version
    );
  end if;

  if
    p_action not in ('accept_permission', 'terminate_permission')
    or p_processing_result <> 'conversation'
    or p_audit_input_class is null
    or p_audit_input_class not in (
      'explicit_commitment',
      'implied_intention',
      'ordinary_question'
    )
    or not coalesce(
      public.conversation_decision_payload_is_valid(p_audit_payload),
      false
    )
    or p_model_id is null
    or char_length(btrim(p_model_id)) not between 1 and 200
    or p_prompt_version is null
    or char_length(btrim(p_prompt_version)) not between 1 and 200
  then
    raise exception 'invalid separate permission resolution';
  end if;

  if not exists (
    select 1
    from public.telegram_updates
    where
      update_id = p_update_id
      and processing_status = 'claimed'
      and is_owner_private
  ) then
    raise exception 'permission resolution is not a claimed owner update';
  end if;

  perform 1
  from public.telegram_owner_delivery
  where singleton
  for update;

  if not found then
    raise exception 'conversation owner singleton is unavailable';
  end if;

  select *
  into permission_candidate
  from public.conversation_permission_candidates
  where singleton
  for update;

  if
    permission_candidate.id is null
    or permission_candidate.id <> p_expected_id
    or permission_candidate.source_update_id <>
      p_expected_source_update_id
    or permission_candidate.correlated_update_id <>
      p_expected_correlated_update_id
    or p_expected_correlated_update_id <> p_update_id
    or permission_candidate.return_draft_id is null
  then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation_stale',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    result_payload := jsonb_build_object(
      'status', 'stale',
      'completed', completed,
      'draftCreated', false
    );
  else
    select *
    into return_draft
    from public.conversation_drafts
    where id = permission_candidate.return_draft_id
    for update;

    delete from public.conversation_permission_candidates
    where id = permission_candidate.id;

    if p_action = 'terminate_permission' then
      if
        return_draft.id is not null
        and return_draft.state = 'parked'
        and return_draft.version =
          permission_candidate.return_draft_version
        and return_draft.expires_at > now()
      then
        update public.conversation_drafts
        set
          state = 'active',
          updated_at = now()
        where id = return_draft.id;
      elsif
        return_draft.id is not null
        and return_draft.state = 'parked'
        and return_draft.version =
          permission_candidate.return_draft_version
      then
        update public.conversation_drafts
        set
          state = 'expired',
          updated_at = now()
        where id = return_draft.id;
      end if;
    else
      if
        permission_candidate.possible_work_session
        or (
          permission_candidate.target_at is not null
          and permission_candidate.target_at::timestamptz <= now()
        )
      then
        raise exception 'invalid simple separate permission acceptance';
      end if;

      insert into public.conversation_drafts (
        version,
        state,
        phase,
        definition_of_done,
        target_at,
        target_time_zone,
        simple_action,
        possible_work_session,
        duration_minutes,
        offer_work_window_help,
        timing_constraints,
        last_update_id,
        expires_at
      )
      values (
        1,
        'active',
        case
          when permission_candidate.definition_of_done is null
            then 'awaiting_definition'
          when permission_candidate.target_at is null
            then 'awaiting_target'
          else 'complete'
        end,
        permission_candidate.definition_of_done,
        permission_candidate.target_at,
        permission_candidate.target_time_zone,
        permission_candidate.simple_action,
        false,
        null,
        false,
        permission_candidate.timing_constraints,
        p_update_id,
        now() + interval '24 hours'
      )
      returning * into created_draft;
    end if;

    insert into public.model_decisions (
      update_id,
      draft_id,
      input_class,
      decision_payload,
      model_id,
      prompt_version
    )
    values (
      p_update_id,
      created_draft.id,
      p_audit_input_class,
      p_audit_payload,
      p_model_id,
      p_prompt_version
    );

    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    if not coalesce(completed, false) then
      raise exception 'separate permission resolution completion failed';
    end if;

    result_payload := jsonb_build_object(
      'status', 'applied',
      'completed', true,
      'draftCreated', p_action = 'accept_permission'
    );
    if created_draft.id is not null then
      result_payload := result_payload || jsonb_build_object(
        'draftReference',
        jsonb_build_object(
          'id', created_draft.id,
          'version', created_draft.version
        )
      );
    elsif
      p_action = 'terminate_permission'
      and return_draft.id is not null
      and return_draft.state = 'parked'
      and return_draft.version =
        permission_candidate.return_draft_version
      and return_draft.expires_at > now()
    then
      result_payload := result_payload || jsonb_build_object(
        'draftReference',
        jsonb_build_object(
          'id', return_draft.id,
          'version', return_draft.version
        )
      );
    end if;
  end if;

  insert into public.conversation_control_operation_receipts (
    update_id,
    operation,
    request_payload,
    result_payload
  )
  values (
    p_update_id,
    'resolve_separate_permission',
    request_payload,
    result_payload
  );

  return result_payload;
end;
$$;

create function public.reset_owner_unconfirmed_conversation(
  p_update_id bigint,
  p_owner_chat_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt public.conversation_control_operation_receipts;
  session_id uuid;
  request_payload jsonb;
  result_payload jsonb;
  completed boolean := false;
begin
  request_payload := jsonb_build_object(
    'ownerChatId', p_owner_chat_id
  );

  select *
  into receipt
  from public.conversation_control_operation_receipts
  where update_id = p_update_id;

  if receipt.update_id is not null then
    if
      receipt.operation <> 'reset'
      or receipt.request_payload <> request_payload
    then
      raise exception 'conversation reset replay changed';
    end if;
    return receipt.result_payload;
  end if;

  if p_owner_chat_id is null then
    raise exception 'invalid conversation reset owner';
  end if;

  if not exists (
    select 1
    from public.telegram_updates
    where
      update_id = p_update_id
      and processing_status = 'claimed'
      and is_owner_private
  ) then
    raise exception 'conversation reset is not a claimed owner update';
  end if;

  perform pg_advisory_xact_lock(p_owner_chat_id);

  perform 1
  from public.telegram_owner_delivery
  where
    singleton
    and private_chat_id = p_owner_chat_id
  for update;

  if not found then
    raise exception 'invalid conversation reset owner';
  end if;

  delete from public.conversation_permission_candidates
  where singleton;

  update public.conversation_drafts
  set
    state = 'cancelled',
    resolved_update_id = p_update_id,
    resolved_at = now(),
    updated_at = now()
  where
    owner_key
    and state = 'active';

  update public.conversation_drafts
  set
    state = 'expired',
    updated_at = now()
  where
    owner_key
    and state = 'parked';

  select id
  into session_id
  from public.agent_sessions
  where chat_id = p_owner_chat_id;

  if session_id is not null then
    delete from public.agent_sessions
    where id = session_id;
  end if;

  delete from public.agent_session_update_receipts
  where chat_id = p_owner_chat_id;

  delete from public.agent_approval_update_receipts
  where chat_id = p_owner_chat_id;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'conversation',
    processed_at = now()
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'conversation reset completion failed';
  end if;

  result_payload := jsonb_build_object(
    'status', 'applied',
    'completed', true,
    'draftCreated', false
  );

  insert into public.conversation_control_operation_receipts (
    update_id,
    operation,
    request_payload,
    result_payload
  )
  values (
    p_update_id,
    'reset',
    request_payload,
    result_payload
  );

  return result_payload;
end;
$$;

revoke all on function public.create_separate_conversation_permission(
  bigint, uuid, integer, text, text, text, boolean, boolean, integer,
  boolean, text[], text, text, jsonb, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_separate_conversation_permission(
  bigint, uuid, bigint, bigint, text, text, text, jsonb, text, text
) from public, anon, authenticated;
revoke all on function public.reset_owner_unconfirmed_conversation(
  bigint, bigint
) from public, anon, authenticated;

grant execute on function public.create_separate_conversation_permission(
  bigint, uuid, integer, text, text, text, boolean, boolean, integer,
  boolean, text[], text, text, jsonb, text, text
) to service_role;
grant execute on function public.resolve_separate_conversation_permission(
  bigint, uuid, bigint, bigint, text, text, text, jsonb, text, text
) to service_role;
grant execute on function public.reset_owner_unconfirmed_conversation(
  bigint, bigint
) to service_role;
