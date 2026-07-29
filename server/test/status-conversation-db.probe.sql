begin;

insert into public.telegram_owner_delivery (
  singleton,
  private_chat_id
)
values (true, 998877)
on conflict (singleton) do nothing;

update public.conversation_drafts
set state = 'parked'
where owner_key and state = 'active';

delete from public.conversation_permission_candidates
where singleton;

insert into public.telegram_updates (
  update_id,
  processing_status,
  is_owner_private
)
values
  (992000000001, 'claimed', true),
  (992000000002, 'claimed', true),
  (992000000003, 'claimed', true),
  (992000000004, 'claimed', true),
  (992000000005, 'claimed', true),
  (992000000006, 'claimed', true),
  (992000000007, 'claimed', true),
  (992000000008, 'claimed', true);

insert into public.conversation_drafts (
  id,
  state,
  phase,
  simple_action,
  possible_work_session,
  last_update_id,
  expires_at
)
values (
  'b0000000-0000-4000-8000-000000000001',
  'active',
  'awaiting_definition',
  false,
  false,
  992000000001,
  now() + interval '1 hour'
);

do $$
declare
  before_draft public.conversation_drafts;
  after_draft public.conversation_drafts;
  result jsonb;
begin
  select * into before_draft
  from public.conversation_drafts
  where id = 'b0000000-0000-4000-8000-000000000001';

  result := public.apply_conversation_turn(
    p_update_id => 992000000001,
    p_expected_kind => 'draft',
    p_expected_id => before_draft.id,
    p_expected_version => before_draft.version,
    p_expected_source_update_id => null,
    p_expected_correlated_update_id => null,
    p_action => 'preserve',
    p_phase => null,
    p_definition_of_done => null,
    p_target_at => null,
    p_target_time_zone => null,
    p_simple_action => null,
    p_possible_work_session => null,
    p_duration_minutes => null,
    p_offer_work_window_help => null,
    p_timing_constraints => null,
    p_processing_result => 'status_listed',
    p_audit_input_class => null,
    p_audit_payload => null,
    p_model_id => null,
    p_prompt_version => null
  );

  select * into after_draft
  from public.conversation_drafts
  where id = before_draft.id;

  if
    result #>> '{status}' <> 'applied'
    or result #>> '{draftReference,id}' <> before_draft.id::text
    or (result #>> '{draftReference,version}')::integer <>
      before_draft.version
    or after_draft.id <> before_draft.id
    or after_draft.version <> before_draft.version
    or after_draft.state <> before_draft.state
    or after_draft.updated_at <> before_draft.updated_at
  then
    raise exception 'status_listed changed active draft: %', result;
  end if;
  if exists (
    select 1 from public.model_decisions
    where update_id = 992000000001
  ) then
    raise exception 'status_listed wrote a model decision';
  end if;
  if not exists (
    select 1 from public.telegram_updates
    where
      update_id = 992000000001
      and processing_status = 'processed'
      and processing_result = 'status_listed'
  ) then
    raise exception 'status_listed did not persist exact result';
  end if;
end;
$$;

update public.conversation_drafts
set state = 'parked'
where id = 'b0000000-0000-4000-8000-000000000001';

insert into public.conversation_permission_candidates (
  id,
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
  expires_at
)
values (
  'b0000000-0000-4000-8000-000000000002',
  992000000002,
  992000000003,
  null,
  null,
  null,
  false,
  false,
  null,
  false,
  '{}'::text[],
  now() + interval '1 hour'
);

do $$
declare
  before_permission public.conversation_permission_candidates;
  after_permission public.conversation_permission_candidates;
  result jsonb;
begin
  select * into before_permission
  from public.conversation_permission_candidates
  where id = 'b0000000-0000-4000-8000-000000000002';

  result := public.apply_conversation_turn(
    p_update_id => 992000000003,
    p_expected_kind => 'permission',
    p_expected_id => before_permission.id,
    p_expected_version => null,
    p_expected_source_update_id => before_permission.source_update_id,
    p_expected_correlated_update_id =>
      before_permission.correlated_update_id,
    p_action => 'preserve',
    p_phase => null,
    p_definition_of_done => null,
    p_target_at => null,
    p_target_time_zone => null,
    p_simple_action => null,
    p_possible_work_session => null,
    p_duration_minutes => null,
    p_offer_work_window_help => null,
    p_timing_constraints => null,
    p_processing_result => 'status_listed',
    p_audit_input_class => null,
    p_audit_payload => null,
    p_model_id => null,
    p_prompt_version => null
  );

  select * into after_permission
  from public.conversation_permission_candidates
  where id = before_permission.id;

  if
    result #>> '{status}' <> 'applied'
    or after_permission.id <> before_permission.id
    or after_permission.source_update_id <>
      before_permission.source_update_id
    or after_permission.correlated_update_id <>
      before_permission.correlated_update_id
    or after_permission.updated_at <> before_permission.updated_at
  then
    raise exception 'status_listed changed permission: %', result;
  end if;
  if exists (
    select 1 from public.model_decisions
    where update_id = 992000000003
  ) then
    raise exception 'permission status wrote a model decision';
  end if;
end;
$$;

delete from public.conversation_permission_candidates
where id = 'b0000000-0000-4000-8000-000000000002';

do $$
declare
  result jsonb;
begin
  result := public.apply_conversation_turn(
    p_update_id => 992000000004,
    p_expected_kind => 'none',
    p_expected_id => null,
    p_expected_version => null,
    p_expected_source_update_id => null,
    p_expected_correlated_update_id => null,
    p_action => 'preserve',
    p_phase => null,
    p_definition_of_done => null,
    p_target_at => null,
    p_target_time_zone => null,
    p_simple_action => null,
    p_possible_work_session => null,
    p_duration_minutes => null,
    p_offer_work_window_help => null,
    p_timing_constraints => null,
    p_processing_result => 'status_empty',
    p_audit_input_class => null,
    p_audit_payload => null,
    p_model_id => null,
    p_prompt_version => null
  );
  if result #>> '{status}' <> 'applied' then
    raise exception 'status_empty without focus failed: %', result;
  end if;
  if not exists (
    select 1 from public.telegram_updates
    where
      update_id = 992000000004
      and processing_result = 'status_empty'
  ) then
    raise exception 'status_empty did not persist exact result';
  end if;
end;
$$;

update public.conversation_drafts
set state = 'active', version = 2
where id = 'b0000000-0000-4000-8000-000000000001';

do $$
declare
  result jsonb;
begin
  result := public.apply_conversation_turn(
    p_update_id => 992000000005,
    p_expected_kind => 'draft',
    p_expected_id => 'b0000000-0000-4000-8000-000000000001',
    p_expected_version => 1,
    p_expected_source_update_id => null,
    p_expected_correlated_update_id => null,
    p_action => 'preserve',
    p_phase => null,
    p_definition_of_done => null,
    p_target_at => null,
    p_target_time_zone => null,
    p_simple_action => null,
    p_possible_work_session => null,
    p_duration_minutes => null,
    p_offer_work_window_help => null,
    p_timing_constraints => null,
    p_processing_result => 'status_listed',
    p_audit_input_class => null,
    p_audit_payload => null,
    p_model_id => null,
    p_prompt_version => null
  );
  if result #>> '{status}' <> 'stale' then
    raise exception 'stale status focus was accepted: %', result;
  end if;
  if not exists (
    select 1 from public.telegram_updates
    where
      update_id = 992000000005
      and processing_result = 'conversation_stale'
  ) then
    raise exception 'stale status did not persist conversation_stale';
  end if;
  if exists (
    select 1 from public.model_decisions
    where update_id = 992000000005
  ) then
    raise exception 'stale status wrote a model decision';
  end if;
end;
$$;

do $$
begin
  begin
    perform public.apply_conversation_turn(
      992000000006, 'draft',
      'b0000000-0000-4000-8000-000000000001', 2,
      null, null, 'update_draft',
      null, null, null, null, null, null, null, null, null,
      'status_listed', null, null, null, null
    );
    raise exception 'invalid status action was accepted';
  exception
    when others then
      if sqlerrm <> 'status completion requires preserve action' then
        raise;
      end if;
  end;

  begin
    perform public.apply_conversation_turn(
      992000000007, 'draft',
      'b0000000-0000-4000-8000-000000000001', 2,
      null, null, 'preserve',
      null, null, null, null, null, null, null, null, null,
      'status_listed', 'ordinary_question', null, null, null
    );
    raise exception 'status audit was accepted';
  exception
    when others then
      if sqlerrm <> 'status completion cannot contain a model audit' then
        raise;
      end if;
  end;

  begin
    perform public.apply_conversation_turn(
      992000000008, 'draft',
      'b0000000-0000-4000-8000-000000000001', 2,
      null, null, 'preserve',
      null, 'forbidden mutation', null, null, null, null, null,
      null, null, 'status_listed', null, null, null, null
    );
    raise exception 'status mutation fields were accepted';
  exception
    when others then
      if sqlerrm <>
        'status completion cannot mutate conversation state'
      then
        raise;
      end if;
  end;

  if (
    select count(*) from public.telegram_updates
    where
      update_id in (992000000006, 992000000007, 992000000008)
      and processing_status = 'claimed'
      and processing_result is null
  ) <> 3 then
    raise exception 'invalid status call changed update state';
  end if;
end;
$$;

rollback;
