alter table public.conversation_drafts
  drop constraint conversation_drafts_state_check,
  drop constraint conversation_drafts_resolution_check;

alter table public.conversation_drafts
  add constraint conversation_drafts_state_check check (
    state in ('active', 'parked', 'confirmed', 'cancelled', 'expired')
  ),
  add constraint conversation_drafts_resolution_check check (
    (
      state in ('active', 'parked', 'expired')
      and resolved_update_id is null
      and resolved_at is null
    )
    or (
      state in ('confirmed', 'cancelled')
      and resolved_update_id is not null
      and resolved_at is not null
    )
  );

comment on column public.conversation_drafts.state is
  'active is the exact conversational focus; parked is resumable but not focused';

create table public.conversation_draft_operations (
  update_id bigint primary key
    references public.telegram_updates(update_id) on delete cascade,
  operation text not null check (
    operation in ('create_focused', 'focus', 'patch_focused')
  ),
  request_payload jsonb not null,
  result_payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.conversation_draft_operations enable row level security;

revoke all on table public.conversation_draft_operations
  from anon, authenticated;
grant select on table public.conversation_draft_operations to service_role;

create or replace function public.conversation_draft_summary_json(
  p_draft public.conversation_drafts
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', 'draft',
    'id', p_draft.id,
    'version', p_draft.version,
    'focused', p_draft.state = 'active',
    'phase', p_draft.phase,
    'definitionOfDone', p_draft.definition_of_done,
    'targetAt', p_draft.target_at,
    'targetTimeZone', p_draft.target_time_zone,
    'simpleAction', p_draft.simple_action,
    'possibleWorkSession', p_draft.possible_work_session,
    'durationMinutes', p_draft.duration_minutes,
    'offerWorkWindowHelp', p_draft.offer_work_window_help,
    'timingConstraints', p_draft.timing_constraints,
    'expiresAt', p_draft.expires_at,
    'updatedAt', p_draft.updated_at
  );
$$;

revoke all on function public.conversation_draft_summary_json(
  public.conversation_drafts
) from public, anon, authenticated;

create or replace function public.list_conversation_drafts(
  p_limit integer default 10,
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_limit not between 1 and 20 then
    raise exception 'draft list limit is out of bounds';
  end if;
  if (p_before_updated_at is null) <> (p_before_id is null) then
    raise exception 'draft list cursor is incomplete';
  end if;

  with candidates as (
    select draft.*
    from public.conversation_drafts as draft
    where
      draft.owner_key
      and draft.state in ('active', 'parked')
      and draft.expires_at > now()
      and (
        p_before_updated_at is null
        or (draft.updated_at, draft.id) <
          (p_before_updated_at, p_before_id)
      )
    order by draft.updated_at desc, draft.id desc
    limit p_limit + 1
  ),
  page as (
    select *
    from candidates
    order by updated_at desc, id desc
    limit p_limit
  ),
  last_item as (
    select *
    from page
    order by updated_at asc, id asc
    limit 1
  )
  select jsonb_build_object(
    'drafts',
    coalesce(
      (
        select jsonb_agg(
          public.conversation_draft_summary_json(item)
          order by item.updated_at desc, item.id desc
        )
        from page as item
      ),
      '[]'::jsonb
    ),
    'nextCursor',
    case
      when (select count(*) from candidates) > p_limit then (
        select jsonb_build_object(
          'updatedAt', cursor_item.updated_at,
          'id', cursor_item.id
        )
        from last_item as cursor_item
      )
      else null
    end
  )
  into result;

  return result;
end;
$$;

create or replace function public.read_conversation_draft(
  p_draft_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'kind', 'draft',
        'draft', public.conversation_draft_summary_json(draft)
      )
      from public.conversation_drafts as draft
      where
        draft.id = p_draft_id
        and draft.owner_key
        and draft.state in ('active', 'parked')
        and draft.expires_at > now()
    ),
    jsonb_build_object('kind', 'not_found')
  );
$$;

create or replace function public.resolve_conversation_draft_reference(
  p_query text,
  p_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidates jsonb;
  candidate_count integer;
begin
  if
    char_length(btrim(p_query)) not between 1 and 500
    or p_limit not between 1 and 20
  then
    raise exception 'draft reference request is out of bounds';
  end if;

  with matching as (
    select draft.*
    from public.conversation_drafts as draft
    where
      draft.owner_key
      and draft.state in ('active', 'parked')
      and draft.expires_at > now()
      and (
        draft.id::text = btrim(p_query)
        or position(
          lower(btrim(p_query))
          in lower(coalesce(draft.definition_of_done, ''))
        ) > 0
      )
    order by
      (draft.id::text = btrim(p_query)) desc,
      (draft.state = 'active') desc,
      draft.updated_at desc,
      draft.id desc
    limit p_limit
  )
  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        public.conversation_draft_summary_json(item)
        order by
          (item.id::text = btrim(p_query)) desc,
          (item.state = 'active') desc,
          item.updated_at desc,
          item.id desc
      ),
      '[]'::jsonb
    )
  into candidate_count, candidates
  from matching as item;

  if candidate_count = 0 then
    return jsonb_build_object('kind', 'none');
  end if;
  if candidate_count = 1 then
    return jsonb_build_object(
      'kind', 'exact',
      'draft', candidates -> 0
    );
  end if;
  return jsonb_build_object(
    'kind', 'ambiguous',
    'candidates', candidates
  );
end;
$$;

create or replace function public.apply_focused_conversation_draft(
  p_operation text,
  p_update_id bigint,
  p_expected_focus_id uuid,
  p_expected_focus_version integer,
  p_draft_id uuid,
  p_expected_version integer,
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
  current_focus public.conversation_drafts;
  target_draft public.conversation_drafts;
  resulting_draft public.conversation_drafts;
  receipt public.conversation_draft_operations;
  request_payload jsonb;
  result_payload jsonb;
  completed boolean := false;
  expected_focus_matches boolean := false;
begin
  if p_operation not in (
    'create_focused',
    'focus',
    'patch_focused'
  ) then
    raise exception 'invalid focused draft operation';
  end if;
  if (p_expected_focus_id is null) <>
    (p_expected_focus_version is null)
  then
    raise exception 'expected focus identity is incomplete';
  end if;
  if p_processing_result <> 'conversation' then
    raise exception 'focused draft mutation requires a successful decision';
  end if;
  if (
    p_audit_input_class not in (
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
  ) then
    raise exception 'invalid bounded model decision audit';
  end if;
  if p_operation = 'create_focused' then
    if
      p_draft_id is not null
      or p_expected_version is not null
      or p_phase not in (
        'awaiting_definition',
        'awaiting_target',
        'complete'
      )
      or p_simple_action is null
      or p_possible_work_session is null
      or p_offer_work_window_help is null
      or p_timing_constraints is null
    then
      raise exception 'invalid focused draft creation';
    end if;
  elsif (
    p_draft_id is null
    or p_expected_version is null
    or p_expected_version < 1
  ) then
    raise exception 'focused draft target is incomplete';
  end if;
  if p_operation = 'focus' and (
    p_phase is not null
    or p_definition_of_done is not null
    or p_target_at is not null
    or p_target_time_zone is not null
    or p_simple_action is not null
    or p_possible_work_session is not null
    or p_duration_minutes is not null
    or p_offer_work_window_help is not null
    or p_timing_constraints is not null
  ) then
    raise exception 'focus operation cannot patch draft fields';
  end if;
  if p_operation = 'patch_focused' and (
    p_phase not in (
      'awaiting_definition',
      'awaiting_target',
      'complete'
    )
    or p_simple_action is null
    or p_possible_work_session is null
    or p_offer_work_window_help is null
    or p_timing_constraints is null
  ) then
    raise exception 'invalid focused draft patch';
  end if;
  if p_target_at is not null and p_target_at::timestamptz <= now() then
    raise exception 'focused draft target must be in the future';
  end if;

  request_payload := jsonb_build_object(
    'operation', p_operation,
    'expectedFocusId', p_expected_focus_id,
    'expectedFocusVersion', p_expected_focus_version,
    'draftId', p_draft_id,
    'expectedVersion', p_expected_version,
    'phase', p_phase,
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
  from public.conversation_draft_operations
  where update_id = p_update_id;

  if receipt.update_id is not null then
    if
      receipt.operation <> p_operation
      or receipt.request_payload <> request_payload
    then
      raise exception 'focused draft operation replay changed';
    end if;
    return receipt.result_payload;
  end if;

  if not exists (
    select 1
    from public.telegram_updates
    where
      update_id = p_update_id
      and processing_status = 'claimed'
      and is_owner_private
  ) then
    raise exception 'focused draft turn is not a claimed owner update';
  end if;

  perform 1
  from public.telegram_owner_delivery
  where singleton
  for update;

  if not found then
    raise exception 'conversation owner singleton is unavailable';
  end if;

  select *
  into current_focus
  from public.conversation_drafts
  where owner_key and state = 'active'
  for update;

  if
    current_focus.id is not null
    and current_focus.expires_at <= now()
  then
    update public.conversation_drafts
    set state = 'expired'
    where id = current_focus.id;
    current_focus := null;
  end if;

  expected_focus_matches := case
    when p_expected_focus_id is null then current_focus.id is null
    else
      current_focus.id = p_expected_focus_id
      and current_focus.version = p_expected_focus_version
  end;

  if p_operation in ('focus', 'patch_focused') then
    select *
    into target_draft
    from public.conversation_drafts
    where
      id = p_draft_id
      and owner_key
      and state in ('active', 'parked')
      and expires_at > now()
    for update;

    expected_focus_matches :=
      expected_focus_matches
      and target_draft.id = p_draft_id
      and target_draft.version = p_expected_version;
  end if;

  if not coalesce(expected_focus_matches, false) then
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
      current_focus.id,
      p_audit_input_class,
      p_audit_payload,
      p_model_id,
      p_prompt_version
    );

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
    insert into public.conversation_draft_operations (
      update_id,
      operation,
      request_payload,
      result_payload
    )
    values (
      p_update_id,
      p_operation,
      request_payload,
      result_payload
    );
    return result_payload;
  end if;

  if
    current_focus.id is not null
    and (
      p_operation = 'create_focused'
      or current_focus.id <> target_draft.id
    )
  then
    update public.conversation_drafts
    set state = 'parked'
    where id = current_focus.id;
  end if;

  case p_operation
    when 'create_focused' then
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
        p_phase,
        p_definition_of_done,
        p_target_at,
        p_target_time_zone,
        p_simple_action,
        p_possible_work_session,
        p_duration_minutes,
        p_offer_work_window_help,
        p_timing_constraints,
        p_update_id,
        now() + interval '24 hours'
      )
      returning * into resulting_draft;
    when 'focus' then
      update public.conversation_drafts
      set state = 'active'
      where id = target_draft.id
      returning * into resulting_draft;
    when 'patch_focused' then
      update public.conversation_drafts
      set
        state = 'active',
        version = version + 1,
        phase = p_phase,
        definition_of_done = p_definition_of_done,
        target_at = p_target_at,
        target_time_zone = p_target_time_zone,
        simple_action = p_simple_action,
        possible_work_session = p_possible_work_session,
        duration_minutes = p_duration_minutes,
        offer_work_window_help = p_offer_work_window_help,
        timing_constraints = p_timing_constraints,
        last_update_id = p_update_id,
        updated_at = now(),
        expires_at = now() + interval '24 hours'
      where id = target_draft.id
      returning * into resulting_draft;
  end case;

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
    resulting_draft.id,
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
    raise exception 'focused draft turn completion failed';
  end if;

  result_payload := jsonb_build_object(
    'status', 'applied',
    'completed', true,
    'draftCreated', p_operation = 'create_focused',
    'draftReference', jsonb_build_object(
      'id', resulting_draft.id,
      'version', resulting_draft.version
    )
  );
  insert into public.conversation_draft_operations (
    update_id,
    operation,
    request_payload,
    result_payload
  )
  values (
    p_update_id,
    p_operation,
    request_payload,
    result_payload
  );
  return result_payload;
end;
$$;

create or replace function public.create_focused_conversation_draft(
  p_update_id bigint,
  p_expected_focus_id uuid,
  p_expected_focus_version integer,
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
language sql
security definer
set search_path = ''
as $$
  select public.apply_focused_conversation_draft(
    'create_focused',
    p_update_id,
    p_expected_focus_id,
    p_expected_focus_version,
    null,
    null,
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
$$;

create or replace function public.focus_conversation_draft(
  p_update_id bigint,
  p_expected_focus_id uuid,
  p_expected_focus_version integer,
  p_draft_id uuid,
  p_expected_version integer,
  p_processing_result text,
  p_audit_input_class text,
  p_audit_payload jsonb,
  p_model_id text,
  p_prompt_version text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.apply_focused_conversation_draft(
    'focus',
    p_update_id,
    p_expected_focus_id,
    p_expected_focus_version,
    p_draft_id,
    p_expected_version,
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
$$;

create or replace function public.patch_focused_conversation_draft(
  p_update_id bigint,
  p_expected_focus_id uuid,
  p_expected_focus_version integer,
  p_draft_id uuid,
  p_expected_version integer,
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
language sql
security definer
set search_path = ''
as $$
  select public.apply_focused_conversation_draft(
    'patch_focused',
    p_update_id,
    p_expected_focus_id,
    p_expected_focus_version,
    p_draft_id,
    p_expected_version,
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
$$;

revoke all on function public.list_conversation_drafts(
  integer, timestamptz, uuid
) from public, anon, authenticated;
revoke all on function public.read_conversation_draft(uuid)
  from public, anon, authenticated;
revoke all on function public.resolve_conversation_draft_reference(
  text, integer
) from public, anon, authenticated;
revoke all on function public.apply_focused_conversation_draft(
  text, bigint, uuid, integer, uuid, integer, text, text, text, text,
  boolean, boolean, integer, boolean, text[], text, text, jsonb, text,
  text
) from public, anon, authenticated;
revoke all on function public.create_focused_conversation_draft(
  bigint, uuid, integer, text, text, text, text, boolean, boolean,
  integer, boolean, text[], text, text, jsonb, text, text
) from public, anon, authenticated;
revoke all on function public.focus_conversation_draft(
  bigint, uuid, integer, uuid, integer, text, text, jsonb, text, text
) from public, anon, authenticated;
revoke all on function public.patch_focused_conversation_draft(
  bigint, uuid, integer, uuid, integer, text, text, text, text, boolean,
  boolean, integer, boolean, text[], text, text, jsonb, text, text
) from public, anon, authenticated;

grant execute on function public.list_conversation_drafts(
  integer, timestamptz, uuid
) to service_role;
grant execute on function public.read_conversation_draft(uuid)
  to service_role;
grant execute on function public.resolve_conversation_draft_reference(
  text, integer
) to service_role;
grant execute on function public.create_focused_conversation_draft(
  bigint, uuid, integer, text, text, text, text, boolean, boolean,
  integer, boolean, text[], text, text, jsonb, text, text
) to service_role;
grant execute on function public.focus_conversation_draft(
  bigint, uuid, integer, uuid, integer, text, text, jsonb, text, text
) to service_role;
grant execute on function public.patch_focused_conversation_draft(
  bigint, uuid, integer, uuid, integer, text, text, text, text, boolean,
  boolean, integer, boolean, text[], text, text, jsonb, text, text
) to service_role;
