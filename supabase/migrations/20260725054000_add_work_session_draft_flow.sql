do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where
      conrelid = 'public.conversation_drafts'::regclass
      and contype = 'c'
  loop
    execute format(
      'alter table public.conversation_drafts drop constraint %I',
      constraint_name
    );
  end loop;
end;
$$;

alter table public.conversation_drafts
  add column work_session_stage text,
  add column selected_start_at text,
  add column selected_end_at text,
  add column calendar_attempted_at timestamptz,
  add column calendar_checked_at timestamptz,
  add column conflict_consent boolean not null default false,
  add column final_calendar_observation text,
  add column last_work_session_transition_id bigint;

create or replace function public.work_session_timing_array_is_valid(
  p_constraints text[]
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item text;
  start_time text;
  end_time text;
  start_minute integer;
  end_minute integer;
begin
  if p_constraints = array['default']::text[] then
    return true;
  end if;
  if cardinality(p_constraints) not between 1 and 4 then
    return false;
  end if;

  foreach item in array p_constraints
  loop
    if item !~
      '^(daily|(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*) ([01][0-9]|2[0-3]):(00|30)-(([01][0-9]|2[0-3]):(00|30)|24:00)$'
    then
      return false;
    end if;
    start_time := split_part(right(item, 11), '-', 1);
    end_time := split_part(right(item, 11), '-', 2);
    start_minute :=
      split_part(start_time, ':', 1)::integer * 60 +
      split_part(start_time, ':', 2)::integer;
    end_minute :=
      split_part(end_time, ':', 1)::integer * 60 +
      split_part(end_time, ':', 2)::integer;
    if end_minute <= start_minute then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

revoke all on function public.work_session_timing_array_is_valid(text[])
  from public, anon, authenticated;

alter table public.conversation_drafts
  add constraint conversation_drafts_owner_key_check check (owner_key),
  add constraint conversation_drafts_version_check check (version > 0),
  add constraint conversation_drafts_state_check check (
    state in ('active', 'confirmed', 'cancelled', 'expired')
  ),
  add constraint conversation_drafts_phase_check check (
    phase in ('awaiting_definition', 'awaiting_target', 'complete')
  ),
  add constraint conversation_drafts_definition_check check (
    definition_of_done is null
    or (
      char_length(btrim(definition_of_done)) > 0
      and char_length(definition_of_done) <= 500
    )
  ),
  add constraint conversation_drafts_target_check check (
    target_at is null
    or target_at ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+]08:00$'
  ),
  add constraint conversation_drafts_duration_check check (
    duration_minutes is null
    or duration_minutes in (30, 60, 90, 120)
  ),
  add constraint conversation_drafts_timing_check check (
    public.conversation_constraints_are_valid(timing_constraints)
  ),
  add constraint conversation_drafts_target_zone_check check (
    (target_at is null) = (target_time_zone is null)
    and (
      target_time_zone is null
      or target_time_zone = 'Asia/Singapore'
    )
  ),
  add constraint conversation_drafts_mode_check check (
    not (simple_action and possible_work_session)
    and (
      simple_action
      or possible_work_session
      or definition_of_done is null
      or target_at is null
    )
  ),
  add constraint conversation_drafts_phase_fields_check check (
    (phase = 'awaiting_definition' and definition_of_done is null)
    or (
      phase = 'awaiting_target'
      and definition_of_done is not null
      and target_at is null
    )
    or (
      phase = 'complete'
      and definition_of_done is not null
      and target_at is not null
      and simple_action <> possible_work_session
    )
  ),
  add constraint conversation_drafts_work_stage_check check (
    (
      possible_work_session
      and not simple_action
      and not offer_work_window_help
      and work_session_stage in (
        'offer_help',
        'awaiting_duration_help',
        'awaiting_duration_owner',
        'awaiting_constraints',
        'awaiting_owner_time',
        'choosing',
        'availability_unavailable',
        'confirming',
        'conflict_choice',
        'conflict_confirming',
        'unverified_confirming',
        'commit_pending'
      )
    )
    or (
      not possible_work_session
      and work_session_stage is null
      and selected_start_at is null
      and selected_end_at is null
      and calendar_attempted_at is null
      and calendar_checked_at is null
      and not conflict_consent
      and final_calendar_observation is null
      and last_work_session_transition_id is null
    )
  ),
  add constraint conversation_drafts_work_timing_check check (
    not possible_work_session
    or work_session_stage in (
      'offer_help',
      'awaiting_duration_help',
      'awaiting_duration_owner',
      'awaiting_constraints'
    )
    or public.work_session_timing_array_is_valid(timing_constraints)
  ),
  add constraint conversation_drafts_selection_check check (
    (selected_start_at is null) = (selected_end_at is null)
    and (
      selected_start_at is null
      or (
        selected_start_at ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:(00|30):00[+]08:00$'
        and selected_end_at ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:(00|30):00[+]08:00$'
        and selected_end_at::timestamptz > selected_start_at::timestamptz
      )
    )
  ),
  add constraint conversation_drafts_final_observation_check check (
    final_calendar_observation is null
    or final_calendar_observation in ('free', 'conflict', 'unavailable')
  ),
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
  ),
  add constraint conversation_drafts_expiry_check check (
    expires_at <= updated_at + interval '24 hours'
  );

create table public.conversation_work_session_options (
  draft_id uuid not null references public.conversation_drafts(id)
    on delete cascade,
  draft_version integer not null check (draft_version > 0),
  ordinal integer not null check (ordinal in (1, 2)),
  start_at text not null check (
    start_at ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:(00|30):00[+]08:00$'
  ),
  end_at text not null check (
    end_at ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:(00|30):00[+]08:00$'
    and end_at::timestamptz > start_at::timestamptz
  ),
  created_at timestamptz not null default now(),
  primary key (draft_id, draft_version, ordinal)
);

alter table public.conversation_work_session_options enable row level security;
revoke all on table public.conversation_work_session_options
  from anon, authenticated;
grant select on table public.conversation_work_session_options
  to service_role;

create or replace function public.initialize_work_session_draft()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.possible_work_session then
    if new.work_session_stage is null then
      new.work_session_stage := 'offer_help';
    end if;

    if (
      tg_op = 'UPDATE'
      and new.version <> old.version
      and new.work_session_stage is not distinct from old.work_session_stage
      and new.last_work_session_transition_id
        is not distinct from old.last_work_session_transition_id
    ) then
      new.work_session_stage := 'offer_help';
      new.selected_start_at := null;
      new.selected_end_at := null;
      new.calendar_attempted_at := null;
      new.calendar_checked_at := null;
      new.conflict_consent := false;
      new.final_calendar_observation := null;
    end if;
  else
    new.work_session_stage := null;
    new.selected_start_at := null;
    new.selected_end_at := null;
    new.calendar_attempted_at := null;
    new.calendar_checked_at := null;
    new.conflict_consent := false;
    new.final_calendar_observation := null;
    new.last_work_session_transition_id := null;
  end if;

  return new;
end;
$$;

create trigger conversation_drafts_initialize_work_session
before insert or update on public.conversation_drafts
for each row execute function public.initialize_work_session_draft();

create or replace function public.clear_superseded_work_session_options()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.conversation_work_session_options
  where
    draft_id = new.id
    and draft_version <> new.version;
  return new;
end;
$$;

create trigger conversation_drafts_clear_superseded_options
after update of version on public.conversation_drafts
for each row execute function public.clear_superseded_work_session_options();

create or replace function public.work_session_window_is_valid(
  p_window jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  return
    jsonb_typeof(p_window) = 'object'
    and (
      select count(*) from jsonb_object_keys(p_window)
    ) = 2
    and p_window ?& array['startAt', 'endAt']
    and p_window->>'startAt' ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:(00|30):00[+]08:00$'
    and p_window->>'endAt' ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:(00|30):00[+]08:00$'
    and (p_window->>'endAt')::timestamptz >
      (p_window->>'startAt')::timestamptz;
exception
  when others then
    return false;
end;
$$;

revoke all on function public.work_session_window_is_valid(jsonb)
  from public, anon, authenticated;

create or replace function public.work_session_draft_snapshot(
  p_draft_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'id', draft.id,
    'version', draft.version,
    'stage', draft.work_session_stage,
    'definitionOfDone', draft.definition_of_done,
    'targetAt', draft.target_at,
    'durationMinutes', draft.duration_minutes,
    'timingConstraints',
      case
        when cardinality(draft.timing_constraints) = 0 then null
        when draft.timing_constraints = array['default']::text[]
          then 'default'
        else array_to_string(draft.timing_constraints, E'\n')
      end,
    'selectedWindow',
      case
        when draft.selected_start_at is null then null
        else jsonb_build_object(
          'startAt', draft.selected_start_at,
          'endAt', draft.selected_end_at
        )
      end,
    'options',
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'startAt', option.start_at,
              'endAt', option.end_at
            )
            order by option.ordinal
          )
          from public.conversation_work_session_options as option
          where
            option.draft_id = draft.id
            and option.draft_version = draft.version
        ),
        '[]'::jsonb
      ),
    'calendarAttemptedAt', draft.calendar_attempted_at,
    'calendarCheckedAt', draft.calendar_checked_at,
    'conflictConsent', draft.conflict_consent,
    'finalObservation', draft.final_calendar_observation
  )
  from public.conversation_drafts as draft
  where draft.id = p_draft_id;
$$;

revoke all on function public.work_session_draft_snapshot(uuid)
  from public, anon, authenticated;

create or replace function public.read_work_session_draft(
  p_draft_id uuid,
  p_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  draft public.conversation_drafts;
begin
  select *
  into draft
  from public.conversation_drafts
  where id = p_draft_id;

  if draft.id is null or not draft.possible_work_session then
    return jsonb_build_object('kind', 'missing');
  end if;
  if draft.state <> 'active' or draft.expires_at <= now() then
    return jsonb_build_object('kind', 'expired');
  end if;
  if draft.version <> p_version then
    return jsonb_build_object('kind', 'stale');
  end if;

  return jsonb_build_object(
    'kind', 'current',
    'snapshot', public.work_session_draft_snapshot(draft.id)
  );
end;
$$;

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
      'confirmation_stale',
      'reminder_cancel_deferred',
      'reminder_done',
      'reminder_malformed',
      'reminder_resolved',
      'reminder_stale',
      'work_session_draft_cancelled',
      'work_session_draft_expired',
      'work_session_draft_resolved',
      'work_session_draft_stale'
    )
  );

create or replace function public.transition_work_session_draft(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_draft_id uuid,
  p_version integer,
  p_expected_stage text,
  p_next_stage text,
  p_duration_minutes integer,
  p_timing_constraints text,
  p_selected_window jsonb,
  p_options jsonb,
  p_calendar_attempted_at timestamptz,
  p_calendar_checked_at timestamptz,
  p_conflict_consent boolean,
  p_final_observation text,
  p_is_cancel boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
  current_draft public.conversation_drafts;
  next_version integer;
  item jsonb;
  item_ordinal integer := 0;
  completed boolean := false;
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
    raise exception 'invalid work-session draft';
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
    or current_draft.work_session_stage <> p_expected_stage
  ) then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_draft_stale',
      processed_at = now()
    where update_id = p_update_id;
    return jsonb_build_object('kind', 'stale');
  end if;

  if p_is_cancel then
    update public.conversation_drafts
    set
      state = 'cancelled',
      resolved_update_id = p_update_id,
      resolved_at = now(),
      updated_at = now()
    where id = current_draft.id;
    delete from public.conversation_work_session_options
    where draft_id = current_draft.id;
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'work_session_draft_cancelled',
      processed_at = now(),
      resolved_action_key =
        'w:' || current_draft.id::text || ':' ||
        current_draft.version::text || ':cancel'
    where update_id = p_update_id;
    return jsonb_build_object(
      'kind', 'applied',
      'snapshot', public.work_session_draft_snapshot(current_draft.id)
    );
  end if;

  if p_next_stage not in (
    'offer_help',
    'awaiting_duration_help',
    'awaiting_duration_owner',
    'awaiting_constraints',
    'awaiting_owner_time',
    'choosing',
    'availability_unavailable',
    'confirming',
    'conflict_choice',
    'conflict_confirming',
    'unverified_confirming',
    'commit_pending'
  ) then
    raise exception 'invalid work-session draft stage';
  end if;
  if (
    p_duration_minutes is not null
    and p_duration_minutes not in (30, 60, 90, 120)
  ) then
    raise exception 'invalid work-session duration';
  end if;
  if (
    p_timing_constraints is not null
    and not public.work_session_timing_array_is_valid(
      case
        when p_timing_constraints = 'default'
          then array['default']::text[]
        else string_to_array(p_timing_constraints, E'\n')
      end
    )
  ) then
    raise exception 'invalid work-session timing constraints';
  end if;
  if (
    p_selected_window is not null
    and not public.work_session_window_is_valid(p_selected_window)
  ) then
    raise exception 'invalid selected work-session window';
  end if;
  if (
    p_options is not null
    and (
      jsonb_typeof(p_options) <> 'array'
      or jsonb_array_length(p_options) > 2
      or exists (
        select 1
        from jsonb_array_elements(p_options) as option
        where not public.work_session_window_is_valid(option)
      )
    )
  ) then
    raise exception 'invalid work-session options';
  end if;
  if (
    p_final_observation is not null
    and p_final_observation not in ('free', 'conflict', 'unavailable')
  ) then
    raise exception 'invalid final Calendar observation';
  end if;

  next_version := current_draft.version + 1;
  update public.conversation_drafts
  set
    version = next_version,
    work_session_stage = p_next_stage,
    duration_minutes = coalesce(
      p_duration_minutes,
      current_draft.duration_minutes
    ),
    timing_constraints = case
      when p_timing_constraints is null
        then current_draft.timing_constraints
      when p_timing_constraints = 'default'
        then array['default']::text[]
      else string_to_array(p_timing_constraints, E'\n')
    end,
    selected_start_at = case
      when p_selected_window is not null
        then p_selected_window->>'startAt'
      when p_next_stage in (
        'offer_help',
        'awaiting_duration_help',
        'awaiting_duration_owner',
        'awaiting_constraints',
        'awaiting_owner_time',
        'choosing',
        'availability_unavailable'
      ) then null
      else current_draft.selected_start_at
    end,
    selected_end_at = case
      when p_selected_window is not null
        then p_selected_window->>'endAt'
      when p_next_stage in (
        'offer_help',
        'awaiting_duration_help',
        'awaiting_duration_owner',
        'awaiting_constraints',
        'awaiting_owner_time',
        'choosing',
        'availability_unavailable'
      ) then null
      else current_draft.selected_end_at
    end,
    calendar_attempted_at = coalesce(
      p_calendar_attempted_at,
      current_draft.calendar_attempted_at
    ),
    calendar_checked_at = case
      when p_next_stage = 'unverified_confirming' then null
      else coalesce(
        p_calendar_checked_at,
        current_draft.calendar_checked_at
      )
    end,
    conflict_consent = coalesce(
      p_conflict_consent,
      current_draft.conflict_consent
    ),
    final_calendar_observation = coalesce(
      p_final_observation,
      current_draft.final_calendar_observation
    ),
    last_work_session_transition_id = p_update_id,
    last_update_id = p_update_id,
    updated_at = now(),
    expires_at = now() + interval '24 hours'
  where id = current_draft.id;

  delete from public.conversation_work_session_options
  where draft_id = current_draft.id;

  if p_options is not null then
    for item in select value from jsonb_array_elements(p_options)
    loop
      item_ordinal := item_ordinal + 1;
      insert into public.conversation_work_session_options (
        draft_id,
        draft_version,
        ordinal,
        start_at,
        end_at
      )
      values (
        current_draft.id,
        next_version,
        item_ordinal,
        item->>'startAt',
        item->>'endAt'
      );
    end loop;
  end if;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'work_session_draft_resolved',
    processed_at = now(),
    resolved_action_key =
      'w:' || current_draft.id::text || ':' ||
      current_draft.version::text || ':apply'
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'work-session draft completion failed';
  end if;

  return jsonb_build_object(
    'kind', 'applied',
    'snapshot', public.work_session_draft_snapshot(current_draft.id)
  );
end;
$$;

create or replace function public.accept_work_session_permission(
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
  candidate public.conversation_permission_candidates;
  created_draft public.conversation_drafts;
  completed boolean := false;
begin
  if (
    p_expected_kind <> 'permission'
    or p_action <> 'accept_work_permission'
    or p_phase <> 'complete'
    or p_processing_result <> 'conversation'
    or p_definition_of_done is null
    or p_target_at is null
    or p_target_at::timestamptz <= now()
    or p_target_time_zone <> 'Asia/Singapore'
    or p_simple_action
    or not p_possible_work_session
    or p_offer_work_window_help
  ) then
    raise exception 'invalid work-session permission acceptance';
  end if;

  select *
  into candidate
  from public.conversation_permission_candidates
  where
    id = p_expected_id
    and source_update_id = p_expected_source_update_id
    and correlated_update_id = p_expected_correlated_update_id
  for update;

  if candidate.id is null then
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

  if (
    candidate.expires_at <= now()
    or candidate.definition_of_done is distinct from p_definition_of_done
    or candidate.target_at is distinct from p_target_at
    or candidate.target_time_zone is distinct from p_target_time_zone
    or candidate.simple_action is distinct from p_simple_action
    or candidate.possible_work_session is distinct from p_possible_work_session
    or candidate.duration_minutes is distinct from p_duration_minutes
    or candidate.offer_work_window_help is distinct from p_offer_work_window_help
    or candidate.timing_constraints is distinct from p_timing_constraints
  ) then
    raise exception 'work-session permission candidate changed';
  end if;

  delete from public.conversation_permission_candidates
  where id = candidate.id;

  insert into public.conversation_drafts (
    version,
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
    'complete',
    candidate.definition_of_done,
    candidate.target_at,
    candidate.target_time_zone,
    false,
    true,
    candidate.duration_minutes,
    false,
    candidate.timing_constraints,
    p_update_id,
    now() + interval '24 hours'
  )
  returning * into created_draft;

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
    raise exception 'work-session permission completion failed';
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'completed', true,
    'draftCreated', true,
    'draftReference', jsonb_build_object(
      'id', created_draft.id,
      'version', created_draft.version
    )
  );
end;
$$;

revoke all on function public.read_work_session_draft(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.transition_work_session_draft(
  bigint, bigint, text, uuid, integer, text, text, integer, text,
  jsonb, jsonb, timestamptz, timestamptz, boolean, text, boolean
) from public, anon, authenticated;
revoke all on function public.accept_work_session_permission(
  bigint, text, uuid, integer, bigint, bigint, text, text, text, text,
  text, boolean, boolean, integer, boolean, text[], text, text, jsonb,
  text, text
) from public, anon, authenticated;

grant execute on function public.read_work_session_draft(uuid, integer)
  to service_role;
grant execute on function public.transition_work_session_draft(
  bigint, bigint, text, uuid, integer, text, text, integer, text,
  jsonb, jsonb, timestamptz, timestamptz, boolean, text, boolean
) to service_role;
grant execute on function public.accept_work_session_permission(
  bigint, text, uuid, integer, bigint, bigint, text, text, text, text,
  text, boolean, boolean, integer, boolean, text[], text, text, jsonb,
  text, text
) to service_role;
