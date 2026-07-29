do $$
declare
  definition text;
  original_claim text := $claim$
  insert into public.telegram_updates (
    update_id, processing_status, is_owner_private
  )
  values (p_update_id, 'claimed', true)
  on conflict (update_id) do nothing
  returning true into claimed;$claim$;
  reusable_claim text := $claim$
  select true
  into claimed
  from public.telegram_updates
  where
    update_id = p_update_id
    and processing_status = 'claimed'
    and is_owner_private
  for update;

  if not coalesce(claimed, false) then
    insert into public.telegram_updates (
      update_id, processing_status, is_owner_private
    )
    values (p_update_id, 'claimed', true)
    on conflict (update_id) do nothing
    returning true into claimed;
  end if;$claim$;
begin
  definition := pg_get_functiondef(
    'public.transition_work_session_continuation(bigint,bigint,text,uuid,integer,text,text,text,integer,jsonb,timestamptz,timestamptz,boolean,timestamptz,timestamptz,text)'::regprocedure
  );
  definition := replace(
    definition,
    original_claim,
    reusable_claim
  );
  if definition not like '%' || reusable_claim || '%' then
    raise exception
      'continuation transition claim replacement was incomplete';
  end if;
  execute definition;
end;
$$;

create function public.record_claimed_conversation_decision(
  p_update_id bigint,
  p_draft_id uuid,
  p_draft_version integer,
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
  inserted boolean := false;
begin
  if (
    p_update_id is null
    or (p_draft_id is null) <> (p_draft_version is null)
    or p_audit_input_class is null
    or p_audit_payload is null
    or p_model_id is null
    or p_prompt_version is null
  ) then
    raise exception 'invalid claimed conversation decision';
  end if;

  perform 1
  from public.telegram_updates
  where
    update_id = p_update_id
    and processing_status = 'claimed'
    and is_owner_private
  for update;
  if not found then
    return jsonb_build_object('kind', 'replay');
  end if;

  if p_draft_id is not null then
    perform 1
    from public.conversation_drafts
    where
      id = p_draft_id
      and version = p_draft_version
      and state = 'active'
    for share;
    if not found then
      raise exception 'invalid claimed conversation draft authority';
    end if;
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
    p_draft_id,
    p_audit_input_class,
    p_audit_payload,
    p_model_id,
    p_prompt_version
  )
  on conflict (update_id) do nothing
  returning true into inserted;

  return jsonb_build_object(
    'kind',
    case when coalesce(inserted, false) then 'applied' else 'replay' end
  );
end;
$$;

revoke all on function public.record_claimed_conversation_decision(
  bigint, uuid, integer, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.record_claimed_conversation_decision(
  bigint, uuid, integer, text, jsonb, text, text
) to service_role;

create or replace function
  public.transition_work_session_continuation_from_conversation(
    p_update_id bigint,
    p_owner_chat_id bigint,
    p_owner_id text,
    p_intent_id uuid,
    p_version integer,
    p_expected_stage text,
    p_next_stage text,
    p_action text,
    p_duration_minutes integer default null,
    p_options jsonb default null,
    p_selected_start_at timestamptz default null,
    p_selected_end_at timestamptz default null,
    p_is_recovery boolean default null,
    p_calendar_attempted_at timestamptz default null,
    p_calendar_checked_at timestamptz default null,
    p_final_observation text default null
  )
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.transition_work_session_continuation(
    p_update_id,
    p_owner_chat_id,
    p_owner_id,
    p_intent_id,
    p_version,
    p_expected_stage,
    p_next_stage,
    p_action,
    p_duration_minutes,
    p_options,
    p_selected_start_at,
    p_selected_end_at,
    p_is_recovery,
    p_calendar_attempted_at,
    p_calendar_checked_at,
    p_final_observation
  );
$$;
