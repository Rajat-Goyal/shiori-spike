alter function public.apply_conversation_turn(
  bigint, text, uuid, integer, bigint, bigint, text, text, text, text,
  text, boolean, boolean, integer, boolean, text[], text, text, jsonb,
  text, text
) rename to apply_conversation_turn_before_status;

revoke all on function public.apply_conversation_turn_before_status(
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
  current_draft public.conversation_drafts;
  permission_candidate public.conversation_permission_candidates;
  snapshot_matches boolean := false;
  completed boolean := false;
  result jsonb;
begin
  if p_processing_result not in ('status_empty', 'status_listed') then
    return public.apply_conversation_turn_before_status(
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
  end if;

  if p_action <> 'preserve' then
    raise exception 'status completion requires preserve action';
  end if;
  if
    p_phase is not null
    or p_definition_of_done is not null
    or p_target_at is not null
    or p_target_time_zone is not null
    or p_simple_action is not null
    or p_possible_work_session is not null
    or p_duration_minutes is not null
    or p_offer_work_window_help is not null
    or p_timing_constraints is not null
  then
    raise exception 'status completion cannot mutate conversation state';
  end if;
  if
    p_audit_input_class is not null
    or p_audit_payload is not null
    or p_model_id is not null
    or p_prompt_version is not null
  then
    raise exception 'status completion cannot contain a model audit';
  end if;
  if
    p_expected_kind not in ('none', 'draft', 'permission')
    or (
      p_expected_kind = 'none'
      and (
        p_expected_id is not null
        or p_expected_version is not null
        or p_expected_source_update_id is not null
        or p_expected_correlated_update_id is not null
      )
    )
    or (
      p_expected_kind = 'draft'
      and (
        p_expected_id is null
        or p_expected_version is null
        or p_expected_version < 1
        or p_expected_source_update_id is not null
        or p_expected_correlated_update_id is not null
      )
    )
    or (
      p_expected_kind = 'permission'
      and (
        p_expected_id is null
        or p_expected_version is not null
        or p_expected_source_update_id is null
        or p_expected_correlated_update_id is null
        or p_expected_correlated_update_id <> p_update_id
      )
    )
  then
    raise exception 'status completion snapshot is invalid';
  end if;

  if not exists (
    select 1
    from public.telegram_updates
    where
      update_id = p_update_id
      and processing_status = 'claimed'
      and is_owner_private
  ) then
    raise exception 'status completion is not a claimed owner update';
  end if;

  perform 1
  from public.telegram_owner_delivery
  where singleton
  for update;

  if not found then
    raise exception 'conversation owner singleton is unavailable';
  end if;

  select *
  into current_draft
  from public.conversation_drafts
  where owner_key and state = 'active'
  for update;

  if
    current_draft.id is not null
    and current_draft.expires_at <= now()
  then
    update public.conversation_drafts
    set
      state = 'expired',
      updated_at = now()
    where id = current_draft.id;

    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation_expired',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'status', 'expired',
      'completed', completed,
      'draftCreated', false
    );
  end if;

  select *
  into permission_candidate
  from public.conversation_permission_candidates
  where singleton
  for update;

  if
    permission_candidate.id is not null
    and permission_candidate.expires_at <= now()
  then
    delete from public.conversation_permission_candidates
    where id = permission_candidate.id;

    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation_interrupted',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'status', 'interrupted',
      'completed', completed,
      'draftCreated', false
    );
  end if;

  snapshot_matches := case p_expected_kind
    when 'none' then
      current_draft.id is null
      and permission_candidate.id is null
    when 'draft' then
      current_draft.id = p_expected_id
      and current_draft.version = p_expected_version
      and permission_candidate.id is null
    when 'permission' then
      current_draft.id is null
      and permission_candidate.id = p_expected_id
      and permission_candidate.source_update_id =
        p_expected_source_update_id
      and permission_candidate.correlated_update_id =
        p_expected_correlated_update_id
  end;

  if not coalesce(snapshot_matches, false) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation_stale',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object(
      'status', 'stale',
      'completed', completed,
      'draftCreated', false
    );
  end if;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = p_processing_result,
    processed_at = now()
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'status completion failed';
  end if;

  result := jsonb_build_object(
    'status', 'applied',
    'completed', true,
    'draftCreated', false
  );
  if current_draft.id is not null then
    result := result || jsonb_build_object(
      'draftReference',
      jsonb_build_object(
        'id', current_draft.id,
        'version', current_draft.version
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
