create or replace function public.decline_work_session_preparation(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_draft_id uuid,
  p_version integer
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
  next_version integer;
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
    raise exception 'invalid work-session draft owner';
  end if;

  select *
  into current_draft
  from public.conversation_drafts
  where id = p_draft_id
  for update;

  if (
    current_draft.id is null
    or not current_draft.possible_work_session
    or current_draft.phase <> 'complete'
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_draft_stale',
      processed_at = now()
    where update_id = p_update_id;
    return jsonb_build_object('kind', 'stale');
  end if;

  if (
    current_draft.state <> 'active'
    or current_draft.expires_at <= now()
  ) then
    if current_draft.state = 'active' then
      update public.conversation_drafts
      set state = 'expired', updated_at = now()
      where id = current_draft.id;
    end if;
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_draft_expired',
      processed_at = now()
    where update_id = p_update_id;
    return jsonb_build_object('kind', 'expired');
  end if;

  if (
    current_draft.version <> p_version
    or current_draft.work_session_stage <> 'offer_help'
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_draft_stale',
      processed_at = now()
    where update_id = p_update_id;
    return jsonb_build_object('kind', 'stale');
  end if;

  next_version := current_draft.version + 1;
  update public.conversation_drafts
  set
    version = next_version,
    simple_action = true,
    possible_work_session = false,
    duration_minutes = null,
    offer_work_window_help = false,
    timing_constraints = '{}'::text[],
    work_session_stage = null,
    selected_start_at = null,
    selected_end_at = null,
    calendar_attempted_at = null,
    calendar_checked_at = null,
    conflict_consent = false,
    final_calendar_observation = null,
    last_work_session_transition_id = null,
    last_update_id = p_update_id,
    updated_at = now(),
    expires_at = now() + interval '24 hours'
  where id = current_draft.id;

  delete from public.conversation_work_session_options
  where draft_id = current_draft.id;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'work_session_draft_resolved',
    processed_at = now(),
    resolved_action_key =
      'w:' || current_draft.id::text || ':' ||
      current_draft.version::text || ':no_preparation'
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'work-session preparation decline completion failed';
  end if;

  return jsonb_build_object(
    'kind', 'applied',
    'draft', jsonb_build_object(
      'id', current_draft.id,
      'version', next_version,
      'definitionOfDone', current_draft.definition_of_done,
      'targetAt', current_draft.target_at
    )
  );
end;
$$;

revoke all on function public.decline_work_session_preparation(
  bigint, bigint, text, uuid, integer
) from public, anon, authenticated;

grant execute on function public.decline_work_session_preparation(
  bigint, bigint, text, uuid, integer
) to service_role;
