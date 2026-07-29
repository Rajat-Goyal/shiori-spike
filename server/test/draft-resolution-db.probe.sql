begin;

do $$
declare
  base_update_id bigint :=
    9950000000 + floor(random() * 40000000)::bigint;
  finance_id uuid;
  launch_id uuid;
  expired_id uuid;
  cancelled_id uuid;
  unavailable_id uuid := gen_random_uuid();
  resolution jsonb;
  candidate_ids integer;
begin
  while exists (
    select 1
    from public.telegram_updates
    where update_id between base_update_id and base_update_id + 3
  )
  loop
    base_update_id :=
      9950000000 + floor(random() * 40000000)::bigint;
  end loop;

  insert into public.telegram_updates (
    update_id,
    processing_status,
    processing_result,
    processed_at,
    is_owner_private
  )
  values
    (base_update_id, 'processed', 'conversation', now(), true),
    (base_update_id + 1, 'processed', 'conversation', now(), true),
    (base_update_id + 2, 'processed', 'conversation', now(), true),
    (base_update_id + 3, 'processed', 'conversation', now(), true);

  insert into public.conversation_drafts (
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
    'parked',
    'complete',
    'Submit quarterly finance report',
    '2026-08-30T10:00:00+08:00',
    'Asia/Singapore',
    true,
    false,
    null,
    false,
    array[]::text[],
    base_update_id,
    now() + interval '24 hours'
  )
  returning id into finance_id;

  insert into public.conversation_drafts (
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
    'parked',
    'complete',
    'Publish launch report',
    '2026-08-31T10:00:00+08:00',
    'Asia/Singapore',
    true,
    false,
    null,
    false,
    array[]::text[],
    base_update_id + 1,
    now() + interval '24 hours'
  )
  returning id into launch_id;

  insert into public.conversation_drafts (
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
    'expired',
    'complete',
    'Expired finance report',
    '2026-09-01T10:00:00+08:00',
    'Asia/Singapore',
    true,
    false,
    null,
    false,
    array[]::text[],
    base_update_id + 2,
    now() - interval '1 second'
  )
  returning id into expired_id;

  insert into public.conversation_drafts (
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
    expires_at,
    resolved_update_id,
    resolved_at
  )
  values (
    'cancelled',
    'complete',
    'Cancelled finance report',
    '2026-09-02T10:00:00+08:00',
    'Asia/Singapore',
    true,
    false,
    null,
    false,
    array[]::text[],
    base_update_id + 3,
    now() + interval '24 hours',
    base_update_id + 3,
    now()
  )
  returning id into cancelled_id;

  resolution := public.resolve_conversation_draft_reference(
    'Please move the quarterly finance report to Friday',
    5
  );
  if
    resolution ->> 'kind' <> 'exact'
    or resolution #>> '{draft,id}' <> finance_id::text
  then
    raise exception 'full finance utterance did not resolve uniquely: %',
      resolution;
  end if;

  resolution := public.resolve_conversation_draft_reference(
    'The finance one',
    5
  );
  if
    resolution ->> 'kind' <> 'exact'
    or resolution #>> '{draft,id}' <> finance_id::text
  then
    raise exception 'finance shorthand did not resolve uniquely: %',
      resolution;
  end if;

  resolution := public.resolve_conversation_draft_reference('report', 5);
  select count(*)::integer
  into candidate_ids
  from jsonb_array_elements(
    resolution -> 'candidates'
  ) as candidates(candidate)
  where candidate ->> 'id' in (finance_id::text, launch_id::text);
  if
    resolution ->> 'kind' <> 'ambiguous'
    or jsonb_array_length(resolution -> 'candidates') <> 2
    or candidate_ids <> 2
  then
    raise exception 'generic report reference was not ambiguous: %',
      resolution;
  end if;

  resolution := public.resolve_conversation_draft_reference(
    'Where is the airport shuttle',
    5
  );
  if resolution <> jsonb_build_object('kind', 'none') then
    raise exception 'unrelated query resolved a draft: %', resolution;
  end if;

  foreach unavailable_id in array array[
    expired_id,
    cancelled_id,
    unavailable_id
  ]
  loop
    resolution := public.resolve_conversation_draft_reference(
      unavailable_id::text,
      5
    );
    if resolution <> jsonb_build_object('kind', 'none') then
      raise exception 'unavailable draft id resolved: %', resolution;
    end if;
  end loop;
end;
$$;

rollback;
