alter table public.telegram_updates
  add column is_owner_private boolean not null default false;

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
      'conversation_stale'
    )
  );

create or replace function public.conversation_constraints_are_valid(
  p_timing_constraints text[]
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    cardinality(p_timing_constraints) <= 4
    and not exists (
      select 1
      from unnest(p_timing_constraints) as item
      where
        item is null
        or char_length(btrim(item)) = 0
        or char_length(item) > 200
    );
$$;

revoke all on function public.conversation_constraints_are_valid(text[])
  from public, anon, authenticated;

create table public.conversation_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_key boolean not null default true check (owner_key),
  version integer not null default 1 check (version > 0),
  state text not null default 'active'
    check (state in ('active', 'expired')),
  phase text not null check (
    phase in ('awaiting_definition', 'awaiting_target', 'complete')
  ),
  definition_of_done text check (
    definition_of_done is null
    or (
      char_length(btrim(definition_of_done)) > 0
      and char_length(definition_of_done) <= 500
    )
  ),
  target_at text check (
    target_at is null
    or target_at ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+]08:00$'
  ),
  target_time_zone text,
  simple_action boolean not null,
  possible_work_session boolean not null default false
    check (not possible_work_session),
  duration_minutes integer check (duration_minutes is null),
  offer_work_window_help boolean not null default false
    check (not offer_work_window_help),
  timing_constraints text[] not null default '{}'::text[]
    check (
      public.conversation_constraints_are_valid(timing_constraints)
    ),
  last_update_id bigint not null unique
    references public.telegram_updates(update_id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((target_at is null) = (target_time_zone is null)),
  check (target_time_zone is null or target_time_zone = 'Asia/Singapore'),
  check (
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
      and simple_action
    )
  ),
  check (
    simple_action
    or definition_of_done is null
    or target_at is null
  ),
  check (expires_at <= updated_at + interval '24 hours')
);

create unique index conversation_drafts_one_active_idx
  on public.conversation_drafts (owner_key)
  where state = 'active';

create table public.conversation_permission_candidates (
  singleton boolean primary key default true check (singleton),
  id uuid not null unique default gen_random_uuid(),
  source_update_id bigint not null unique
    references public.telegram_updates(update_id),
  correlated_update_id bigint unique
    references public.telegram_updates(update_id),
  definition_of_done text check (
    definition_of_done is null
    or (
      char_length(btrim(definition_of_done)) > 0
      and char_length(definition_of_done) <= 500
    )
  ),
  target_at text check (
    target_at is null
    or target_at ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+]08:00$'
  ),
  target_time_zone text,
  simple_action boolean not null,
  possible_work_session boolean not null,
  duration_minutes integer check (duration_minutes is null),
  offer_work_window_help boolean not null default false
    check (not offer_work_window_help),
  timing_constraints text[] not null default '{}'::text[]
    check (
      public.conversation_constraints_are_valid(timing_constraints)
    ),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((target_at is null) = (target_time_zone is null)),
  check (target_time_zone is null or target_time_zone = 'Asia/Singapore'),
  check (not (simple_action and possible_work_session)),
  check (
    simple_action
    or possible_work_session
    or definition_of_done is null
    or target_at is null
  ),
  check (expires_at <= updated_at + interval '24 hours')
);

create or replace function public.conversation_decision_payload_is_valid(
  p_payload jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    jsonb_typeof(p_payload) = 'object'
    and (
      select count(*)
      from jsonb_object_keys(p_payload)
    ) = 11
    and p_payload ?& array[
      'definitionOfDone',
      'durationMinutes',
      'missingFields',
      'nextAction',
      'offerWorkWindowHelp',
      'possibleWorkSession',
      'simpleAction',
      'targetAt',
      'targetTimeZone',
      'timingConstraints',
      'turnRelation'
    ]
    and (
      p_payload->'definitionOfDone' = 'null'::jsonb
      or (
        jsonb_typeof(p_payload->'definitionOfDone') = 'string'
        and char_length(btrim(p_payload->>'definitionOfDone')) > 0
        and char_length(p_payload->>'definitionOfDone') <= 500
      )
    )
    and (
      p_payload->'durationMinutes' = 'null'::jsonb
      or (
        jsonb_typeof(p_payload->'durationMinutes') = 'number'
        and p_payload->>'durationMinutes' in ('30', '60', '90', '120')
      )
    )
    and jsonb_typeof(p_payload->'offerWorkWindowHelp') = 'boolean'
    and jsonb_typeof(p_payload->'possibleWorkSession') = 'boolean'
    and jsonb_typeof(p_payload->'simpleAction') = 'boolean'
    and (
      p_payload->'targetAt' = 'null'::jsonb
      or (
        jsonb_typeof(p_payload->'targetAt') = 'string'
        and p_payload->>'targetAt' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+]08:00$'
      )
    )
    and (
      p_payload->'targetTimeZone' = 'null'::jsonb
      or (
        jsonb_typeof(p_payload->'targetTimeZone') = 'string'
        and p_payload->>'targetTimeZone' = 'Asia/Singapore'
      )
    )
    and (
      (p_payload->'targetAt' = 'null'::jsonb)
      =
      (p_payload->'targetTimeZone' = 'null'::jsonb)
    )
    and jsonb_typeof(p_payload->'timingConstraints') = 'array'
    and jsonb_array_length(p_payload->'timingConstraints') <= 4
    and not exists (
      select 1
      from jsonb_array_elements(
        p_payload->'timingConstraints'
      ) as item
      where
        jsonb_typeof(item) <> 'string'
        or char_length(btrim(item #>> '{}')) = 0
        or char_length(item #>> '{}') > 200
    )
    and jsonb_typeof(p_payload->'missingFields') = 'array'
    and p_payload->'missingFields' in (
      '[]'::jsonb,
      '["definition_of_done"]'::jsonb,
      '["target"]'::jsonb,
      '["definition_of_done", "target"]'::jsonb
    )
    and p_payload->>'nextAction' in (
      'ask_definition',
      'ask_target',
      'ask_permission',
      'answer',
      'ready',
      'offer_work_window',
      'ask_duration'
    )
    and p_payload->>'turnRelation' in (
      'none',
      'new_request',
      'clarification_continuation',
      'correction',
      'separate_request',
      'permission_accepted',
      'permission_declined'
    );
$$;

revoke all on function public.conversation_decision_payload_is_valid(jsonb)
  from public, anon, authenticated;

create table public.model_decisions (
  id uuid primary key default gen_random_uuid(),
  update_id bigint not null unique
    references public.telegram_updates(update_id),
  draft_id uuid references public.conversation_drafts(id),
  input_class text not null check (
    input_class in (
      'explicit_commitment',
      'implied_intention',
      'ordinary_question'
    )
  ),
  decision_payload jsonb not null check (
    public.conversation_decision_payload_is_valid(decision_payload)
  ),
  model_id text not null check (
    char_length(btrim(model_id)) > 0
    and char_length(model_id) <= 200
  ),
  prompt_version text not null check (
    char_length(btrim(prompt_version)) > 0
    and char_length(prompt_version) <= 200
  ),
  created_at timestamptz not null default now()
);

alter table public.conversation_drafts enable row level security;
alter table public.conversation_permission_candidates enable row level security;
alter table public.model_decisions enable row level security;

revoke all on table public.conversation_drafts from anon, authenticated;
revoke all on table public.conversation_permission_candidates
  from anon, authenticated;
revoke all on table public.model_decisions from anon, authenticated;
grant select on table public.conversation_drafts to service_role;
grant select on table public.conversation_permission_candidates
  to service_role;
grant select on table public.model_decisions to service_role;

create or replace function public.claim_telegram_update(
  p_update_id bigint,
  p_owner_chat_id bigint default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
begin
  insert into public.telegram_updates (
    update_id,
    processing_status,
    is_owner_private
  )
  values (
    p_update_id,
    'claimed',
    p_owner_chat_id is not null
  )
  on conflict (update_id) do nothing
  returning true into claimed;

  if coalesce(claimed, false) and p_owner_chat_id is not null then
    insert into public.telegram_owner_delivery (
      singleton,
      private_chat_id
    )
    values (
      true,
      p_owner_chat_id
    )
    on conflict (singleton) do nothing;

    update public.conversation_permission_candidates
    set correlated_update_id = p_update_id
    where
      singleton = true
      and correlated_update_id is null
      and source_update_id <> p_update_id;
  end if;

  return coalesce(claimed, false);
end;
$$;

create or replace function public.read_conversation_turn(
  p_update_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_draft public.conversation_drafts;
  expired_draft public.conversation_drafts;
  permission_candidate public.conversation_permission_candidates;
  correlated_status text;
  completed boolean := false;
begin
  if not exists (
    select 1
    from public.telegram_updates
    where
      update_id = p_update_id
      and processing_status = 'claimed'
      and is_owner_private
  ) then
    raise exception 'conversation turn is not a claimed owner update';
  end if;

  perform 1
  from public.telegram_owner_delivery
  where singleton = true
  for update;

  if not found then
    raise exception 'conversation owner singleton is unavailable';
  end if;

  update public.conversation_drafts
  set
    state = 'expired',
    updated_at = now()
  where
    owner_key = true
    and state = 'active'
    and expires_at <= now()
  returning * into expired_draft;

  if expired_draft.id is not null then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation_expired',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    if not coalesce(completed, false) then
      raise exception 'conversation expiry completion failed';
    end if;

    return jsonb_build_object('kind', 'expired', 'completed', true);
  end if;

  delete from public.conversation_permission_candidates
  where singleton = true and expires_at <= now()
  returning * into permission_candidate;

  if permission_candidate.id is not null then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation_interrupted',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    if not coalesce(completed, false) then
      raise exception 'conversation interruption completion failed';
    end if;

    return jsonb_build_object('kind', 'interrupted', 'completed', true);
  end if;

  select *
  into current_draft
  from public.conversation_drafts
  where owner_key = true and state = 'active';

  if current_draft.id is not null then
    return jsonb_build_object(
      'kind', 'draft',
      'id', current_draft.id,
      'version', current_draft.version,
      'phase', current_draft.phase,
      'definitionOfDone', current_draft.definition_of_done,
      'targetAt', current_draft.target_at,
      'targetTimeZone', current_draft.target_time_zone,
      'simpleAction', current_draft.simple_action,
      'possibleWorkSession', current_draft.possible_work_session,
      'durationMinutes', current_draft.duration_minutes,
      'offerWorkWindowHelp', current_draft.offer_work_window_help,
      'timingConstraints', current_draft.timing_constraints,
      'expiresAt', current_draft.expires_at
    );
  end if;

  update public.conversation_permission_candidates
  set correlated_update_id = p_update_id
  where
    singleton = true
    and correlated_update_id is null
    and source_update_id <> p_update_id
  returning * into permission_candidate;

  if permission_candidate.id is null then
    select *
    into permission_candidate
    from public.conversation_permission_candidates
    where singleton = true;
  end if;

  if permission_candidate.id is null then
    return jsonb_build_object('kind', 'none');
  end if;

  if permission_candidate.correlated_update_id = p_update_id then
    return jsonb_build_object(
      'kind', 'permission',
      'id', permission_candidate.id,
      'sourceUpdateId', permission_candidate.source_update_id,
      'correlatedUpdateId', permission_candidate.correlated_update_id,
      'definitionOfDone', permission_candidate.definition_of_done,
      'targetAt', permission_candidate.target_at,
      'targetTimeZone', permission_candidate.target_time_zone,
      'simpleAction', permission_candidate.simple_action,
      'possibleWorkSession', permission_candidate.possible_work_session,
      'durationMinutes', permission_candidate.duration_minutes,
      'offerWorkWindowHelp', permission_candidate.offer_work_window_help,
      'timingConstraints', permission_candidate.timing_constraints,
      'expiresAt', permission_candidate.expires_at
    );
  end if;

  select processing_status
  into correlated_status
  from public.telegram_updates
  where update_id = permission_candidate.correlated_update_id;

  if correlated_status = 'claimed' then
    update public.telegram_updates
    set
      processing_status = 'processed',
      processing_result = 'conversation_busy',
      processed_at = now()
    where
      update_id = p_update_id
      and processing_status = 'claimed'
    returning true into completed;

    return jsonb_build_object('kind', 'busy', 'completed', completed);
  end if;

  delete from public.conversation_permission_candidates
  where
    singleton = true
    and id = permission_candidate.id
    and correlated_update_id = permission_candidate.correlated_update_id;

  update public.telegram_updates
  set
    processing_status = 'processed',
    processing_result = 'conversation_interrupted',
    processed_at = now()
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  return jsonb_build_object('kind', 'interrupted', 'completed', completed);
end;
$$;

create or replace function public.apply_conversation_turn(
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
  expired_draft public.conversation_drafts;
  permission_candidate public.conversation_permission_candidates;
  snapshot_matches boolean := false;
  completed boolean := false;
  created_draft boolean := false;
  audit_draft_id uuid;
begin
  if p_expected_kind not in ('none', 'draft', 'permission') then
    raise exception 'invalid expected conversation kind';
  end if;
  if p_action not in (
    'preserve',
    'create_draft',
    'update_draft',
    'create_permission',
    'rearm_permission',
    'terminate_permission',
    'accept_permission'
  ) then
    raise exception 'invalid conversation action';
  end if;
  if p_processing_result not in ('conversation', 'conversation_failed') then
    raise exception 'invalid conversation processing result';
  end if;
  if p_processing_result = 'conversation' then
    if (
      p_audit_input_class is null
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
      or char_length(btrim(p_model_id)) = 0
      or char_length(p_model_id) > 200
      or p_prompt_version is null
      or char_length(btrim(p_prompt_version)) = 0
      or char_length(p_prompt_version) > 200
    ) then
      raise exception 'invalid bounded model decision audit';
    end if;
  elsif (
    p_audit_input_class is not null
    or p_audit_payload is not null
    or p_model_id is not null
    or p_prompt_version is not null
  ) then
    raise exception 'failed decisions cannot be audited';
  end if;
  if not exists (
    select 1
    from public.telegram_updates
    where
      update_id = p_update_id
      and processing_status = 'claimed'
      and is_owner_private
  ) then
    raise exception 'conversation turn is not a claimed owner update';
  end if;

  perform 1
  from public.telegram_owner_delivery
  where singleton = true
  for update;

  if not found then
    raise exception 'conversation owner singleton is unavailable';
  end if;

  select *
  into current_draft
  from public.conversation_drafts
  where owner_key = true and state = 'active'
  for update;

  if current_draft.id is not null and current_draft.expires_at <= now() then
    update public.conversation_drafts
    set
      state = 'expired',
      updated_at = now()
    where id = current_draft.id
    returning * into expired_draft;

    if p_processing_result = 'conversation' then
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
    end if;

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
  where singleton = true
  for update;

  if (
    permission_candidate.id is not null
    and permission_candidate.expires_at <= now()
  ) then
    delete from public.conversation_permission_candidates
    where id = permission_candidate.id;

    if p_processing_result = 'conversation' then
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
        null,
        p_audit_input_class,
        p_audit_payload,
        p_model_id,
        p_prompt_version
      );
    end if;

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
      current_draft.id is null and permission_candidate.id is null
    when 'draft' then
      current_draft.id = p_expected_id
      and current_draft.version = p_expected_version
    when 'permission' then
      permission_candidate.id = p_expected_id
      and permission_candidate.source_update_id =
        p_expected_source_update_id
      and permission_candidate.correlated_update_id =
        p_expected_correlated_update_id
      and p_expected_correlated_update_id = p_update_id
  end;

  if not coalesce(snapshot_matches, false) then
    if p_processing_result = 'conversation' then
      audit_draft_id := case
        when p_expected_kind = 'draft' then p_expected_id
        else null
      end;
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
        audit_draft_id,
        p_audit_input_class,
        p_audit_payload,
        p_model_id,
        p_prompt_version
      );
    end if;

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

  if p_expected_kind = 'draft' then
    audit_draft_id := current_draft.id;
  end if;

  if p_action in (
    'preserve',
    'rearm_permission',
    'terminate_permission',
    'accept_permission'
  ) and (
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
    raise exception 'candidate fields are forbidden for this action';
  end if;

  if p_action in ('create_draft', 'create_permission', 'update_draft') then
    if (
      p_simple_action is null
      or p_possible_work_session is null
      or p_offer_work_window_help is null
      or p_timing_constraints is null
      or (
        p_action in ('create_draft', 'update_draft')
        and p_phase is null
      )
      or (
        p_target_at is not null
        and p_target_at::timestamptz <= now()
      )
    ) then
      raise exception 'invalid conversation candidate';
    end if;
  end if;

  case p_action
    when 'preserve' then
      null;
    when 'create_draft' then
      if p_expected_kind <> 'none' then
        raise exception 'draft creation requires absent state';
      end if;
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
      returning id into audit_draft_id;
      created_draft := true;
    when 'update_draft' then
      if p_expected_kind <> 'draft' then
        raise exception 'draft update requires draft state';
      end if;
      update public.conversation_drafts
      set
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
      where id = current_draft.id;
      audit_draft_id := current_draft.id;
    when 'create_permission' then
      if p_expected_kind <> 'none' then
        raise exception 'permission creation requires absent state';
      end if;
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
        expires_at
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
        now() + interval '24 hours'
      );
    when 'rearm_permission' then
      if p_expected_kind <> 'permission' then
        raise exception 'permission rearm requires permission state';
      end if;
      update public.conversation_permission_candidates
      set
        source_update_id = p_update_id,
        correlated_update_id = null,
        updated_at = now(),
        expires_at = now() + interval '24 hours'
      where id = permission_candidate.id;
    when 'terminate_permission' then
      if p_expected_kind <> 'permission' then
        raise exception 'permission termination requires permission state';
      end if;
      delete from public.conversation_permission_candidates
      where id = permission_candidate.id;
    when 'accept_permission' then
      if p_expected_kind <> 'permission' then
        raise exception 'permission acceptance requires permission state';
      end if;
      delete from public.conversation_permission_candidates
      where id = permission_candidate.id;

      if (
        not permission_candidate.possible_work_session
        and (
          permission_candidate.target_at is null
          or permission_candidate.target_at::timestamptz > now()
        )
      ) then
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
        returning id into audit_draft_id;
        created_draft := true;
      end if;
  end case;

  if p_processing_result = 'conversation' then
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
      audit_draft_id,
      p_audit_input_class,
      p_audit_payload,
      p_model_id,
      p_prompt_version
    );
  end if;

  update public.telegram_updates
  set
    processing_status = case
      when p_processing_result = 'conversation_failed' then 'failed'
      else 'processed'
    end,
    processing_result = p_processing_result,
    processed_at = now()
  where
    update_id = p_update_id
    and processing_status = 'claimed'
  returning true into completed;

  if not coalesce(completed, false) then
    raise exception 'conversation update completion failed';
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'completed', true,
    'draftCreated', created_draft
  );
end;
$$;

revoke all on function public.read_conversation_turn(bigint)
  from public, anon, authenticated;
revoke all on function public.apply_conversation_turn(
  bigint, text, uuid, integer, bigint, bigint, text, text, text, text,
  text, boolean, boolean, integer, boolean, text[], text, text, jsonb,
  text, text
) from public, anon, authenticated;

grant execute on function public.read_conversation_turn(bigint)
  to service_role;
grant execute on function public.apply_conversation_turn(
  bigint, text, uuid, integer, bigint, bigint, text, text, text, text,
  text, boolean, boolean, integer, boolean, text[], text, text, jsonb,
  text, text
) to service_role;
