create table public.agent_sessions (
  id uuid primary key,
  chat_id bigint not null unique,
  active_draft_id text check (
    active_draft_id is null
    or (
      char_length(active_draft_id) > 0
      and char_length(active_draft_id) <= 200
    )
  ),
  version bigint not null check (version > 0),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at = created_at + interval '24 hours')
);

create table public.agent_session_update_receipts (
  update_id bigint primary key,
  chat_id bigint not null,
  processed_at timestamptz not null default now()
);

create table public.agent_session_turns (
  session_id uuid not null
    references public.agent_sessions(id) on delete cascade,
  turn_index bigint not null check (turn_index > 0),
  update_id bigint not null unique
    references public.agent_session_update_receipts(update_id),
  sealed_turn text not null check (char_length(sealed_turn) > 0),
  recorded_at timestamptz not null default now(),
  primary key (session_id, turn_index)
);

create table public.agent_pending_approvals (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null unique,
  session_id uuid not null unique
    references public.agent_sessions(id) on delete cascade,
  draft_id text not null check (
    char_length(draft_id) > 0 and char_length(draft_id) <= 200
  ),
  draft_version bigint not null check (draft_version > 0),
  tool_name text not null check (tool_name = 'execute_commitment'),
  sealed_run_state text not null check (
    char_length(sealed_run_state) > 0
  ),
  version bigint not null default 1 check (version > 0),
  stage_update_id bigint not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table public.agent_approval_update_receipts (
  operation text not null check (operation in ('resolve', 'stage')),
  update_id bigint not null,
  chat_id bigint not null,
  processed_at timestamptz not null default now(),
  primary key (operation, update_id)
);

alter table public.agent_sessions enable row level security;
alter table public.agent_session_update_receipts enable row level security;
alter table public.agent_session_turns enable row level security;
alter table public.agent_pending_approvals enable row level security;
alter table public.agent_approval_update_receipts enable row level security;

revoke all on table public.agent_sessions
  from public, anon, authenticated;
revoke all on table public.agent_session_update_receipts
  from public, anon, authenticated;
revoke all on table public.agent_session_turns
  from public, anon, authenticated;
revoke all on table public.agent_pending_approvals
  from public, anon, authenticated;
revoke all on table public.agent_approval_update_receipts
  from public, anon, authenticated;

grant select on table public.agent_sessions to service_role;
grant select on table public.agent_session_update_receipts to service_role;
grant select on table public.agent_session_turns to service_role;
grant select on table public.agent_pending_approvals to service_role;
grant select on table public.agent_approval_update_receipts to service_role;

create function public.agent_session_snapshot(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'activeDraftId', session.active_draft_id,
    'chatId', session.chat_id,
    'expiresAt', session.expires_at,
    'id', session.id,
    'turns', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'recordedAt', turn.recorded_at,
            'sealedTurn', turn.sealed_turn,
            'updateId', turn.update_id
          )
          order by turn.turn_index
        )
        from public.agent_session_turns as turn
        where turn.session_id = session.id
      ),
      '[]'::jsonb
    ),
    'version', session.version
  )
  from public.agent_sessions as session
  where session.id = p_session_id;
$$;

create function public.agent_approval_snapshot(p_approval_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'chatId', approval.chat_id,
    'draftId', approval.draft_id,
    'draftVersion', approval.draft_version,
    'expiresAt', approval.expires_at,
    'id', approval.id,
    'sealedRunState', approval.sealed_run_state,
    'sessionId', approval.session_id,
    'toolName', approval.tool_name,
    'version', approval.version
  )
  from public.agent_pending_approvals as approval
  where approval.id = p_approval_id;
$$;

revoke all on function public.agent_session_snapshot(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_approval_snapshot(uuid)
  from public, anon, authenticated, service_role;

create function public.read_agent_session(p_chat_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_session public.agent_sessions;
begin
  if p_chat_id is null then
    raise exception 'agent session chat is required';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

  select *
  into current_session
  from public.agent_sessions
  where chat_id = p_chat_id
  for update;

  if current_session.id is null then
    return jsonb_build_object('kind', 'none');
  end if;

  if current_session.expires_at <= now() then
    delete from public.agent_sessions
    where id = current_session.id;
    return jsonb_build_object('kind', 'expired');
  end if;

  return jsonb_build_object(
    'kind', 'active',
    'session', public.agent_session_snapshot(current_session.id)
  );
end;
$$;

create function public.record_agent_session_turn(
  p_chat_id bigint,
  p_update_id bigint,
  p_expected_kind text,
  p_expected_session_id uuid,
  p_expected_version bigint,
  p_proposed_session_id uuid,
  p_active_draft_id text,
  p_sealed_turn text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_inserted boolean := false;
  current_session public.agent_sessions;
  created_at timestamptz;
  next_version bigint;
  resulting_session_id uuid;
begin
  if
    p_chat_id is null
    or p_update_id is null
    or p_update_id < 0
    or p_expected_kind not in ('active', 'none')
    or p_proposed_session_id is null
    or p_sealed_turn is null
    or char_length(p_sealed_turn) = 0
    or (
      p_active_draft_id is not null
      and (
        char_length(p_active_draft_id) = 0
        or char_length(p_active_draft_id) > 200
      )
    )
    or (
      p_expected_kind = 'none'
      and (
        p_expected_session_id is not null
        or p_expected_version is not null
      )
    )
    or (
      p_expected_kind = 'active'
      and (
        p_expected_session_id is null
        or p_expected_version is null
        or p_expected_version < 1
        or p_proposed_session_id <> p_expected_session_id
      )
    )
  then
    raise exception 'invalid agent session turn';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

  insert into public.agent_session_update_receipts (
    update_id,
    chat_id
  )
  values (
    p_update_id,
    p_chat_id
  )
  on conflict (update_id) do nothing
  returning true into receipt_inserted;

  if not coalesce(receipt_inserted, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  select *
  into current_session
  from public.agent_sessions
  where chat_id = p_chat_id
  for update;

  if
    current_session.id is not null
    and current_session.expires_at <= now()
  then
    delete from public.agent_sessions
    where id = current_session.id;
    current_session := null;
  end if;

  if p_expected_kind = 'none' then
    if current_session.id is not null then
      return jsonb_build_object('kind', 'stale');
    end if;

    created_at := clock_timestamp();
    insert into public.agent_sessions (
      id,
      chat_id,
      active_draft_id,
      version,
      created_at,
      expires_at
    )
    values (
      p_proposed_session_id,
      p_chat_id,
      p_active_draft_id,
      1,
      created_at,
      created_at + interval '24 hours'
    );

    insert into public.agent_session_turns (
      session_id,
      turn_index,
      update_id,
      sealed_turn
    )
    values (
      p_proposed_session_id,
      1,
      p_update_id,
      p_sealed_turn
    );
    resulting_session_id := p_proposed_session_id;
  else
    if
      current_session.id is null
      or current_session.id <> p_expected_session_id
      or current_session.version <> p_expected_version
    then
      return jsonb_build_object('kind', 'stale');
    end if;

    next_version := current_session.version + 1;
    insert into public.agent_session_turns (
      session_id,
      turn_index,
      update_id,
      sealed_turn
    )
    values (
      current_session.id,
      next_version,
      p_update_id,
      p_sealed_turn
    );

    delete from public.agent_session_turns
    where
      session_id = current_session.id
      and turn_index <= next_version - 6;

    update public.agent_sessions
    set
      active_draft_id = p_active_draft_id,
      version = next_version
    where id = current_session.id;
    resulting_session_id := current_session.id;
  end if;

  return jsonb_build_object(
    'kind', 'applied',
    'session', public.agent_session_snapshot(resulting_session_id)
  );
end;
$$;

create function public.clear_agent_session(
  p_chat_id bigint,
  p_update_id bigint,
  p_expected_session_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_inserted boolean := false;
  current_session public.agent_sessions;
begin
  if
    p_chat_id is null
    or p_update_id is null
    or p_update_id < 0
    or p_reason not in ('cancelled', 'confirmed', 'expired')
  then
    raise exception 'invalid agent session clear';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

  insert into public.agent_session_update_receipts (
    update_id,
    chat_id
  )
  values (
    p_update_id,
    p_chat_id
  )
  on conflict (update_id) do nothing
  returning true into receipt_inserted;

  if not coalesce(receipt_inserted, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  select *
  into current_session
  from public.agent_sessions
  where chat_id = p_chat_id
  for update;

  if current_session.id is null then
    return jsonb_build_object('kind', 'none');
  end if;

  if
    p_expected_session_id is not null
    and current_session.id <> p_expected_session_id
  then
    return jsonb_build_object('kind', 'stale');
  end if;

  delete from public.agent_sessions
  where id = current_session.id;
  return jsonb_build_object('kind', 'cleared');
end;
$$;

create function public.read_agent_approval(
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
  if
    p_chat_id is null
    or p_draft_id is null
    or char_length(p_draft_id) = 0
    or p_draft_version is null
    or p_draft_version < 1
    or p_tool_name <> 'execute_commitment'
  then
    raise exception 'invalid agent approval read';
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

  if
    session.id is null
    or approval.expires_at <= now()
    or session.expires_at <= now()
  then
    if session.id is not null then
      delete from public.agent_sessions where id = session.id;
    else
      delete from public.agent_pending_approvals where id = approval.id;
    end if;
    return jsonb_build_object('kind', 'expired');
  end if;

  if
    approval.draft_id <> p_draft_id
    or approval.draft_version <> p_draft_version
    or approval.tool_name <> p_tool_name
  then
    return jsonb_build_object('kind', 'missing');
  end if;

  return jsonb_build_object(
    'approval', public.agent_approval_snapshot(approval.id),
    'kind', 'current'
  );
end;
$$;

create function public.stage_agent_approval(
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
  if
    p_chat_id is null
    or p_update_id is null
    or p_update_id < 0
    or p_expected_kind <> 'none'
    or p_session_id is null
    or p_draft_id is null
    or char_length(p_draft_id) = 0
    or char_length(p_draft_id) > 200
    or p_draft_version is null
    or p_draft_version < 1
    or p_tool_name <> 'execute_commitment'
    or p_sealed_run_state is null
    or char_length(p_sealed_run_state) = 0
  then
    raise exception 'invalid agent approval stage';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

  insert into public.agent_approval_update_receipts (
    operation,
    update_id,
    chat_id
  )
  values (
    'stage',
    p_update_id,
    p_chat_id
  )
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

  if
    session.id is null
    or session.chat_id <> p_chat_id
    or session.expires_at <= now()
    or session.active_draft_id is distinct from p_draft_id
  then
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
    'approval', public.agent_approval_snapshot(created_approval_id),
    'kind', 'staged'
  );
end;
$$;

create function public.resolve_agent_approval(
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
  session public.agent_sessions;
  claimed_state text;
  claimed_session_id uuid;
begin
  if
    p_chat_id is null
    or p_update_id is null
    or p_update_id < 0
    or p_approval_id is null
    or p_approval_version is null
    or p_approval_version < 1
    or p_draft_id is null
    or char_length(p_draft_id) = 0
    or p_draft_version is null
    or p_draft_version < 1
    or p_tool_name <> 'execute_commitment'
    or p_decision not in ('approve', 'reject')
  then
    raise exception 'invalid agent approval resolution';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

  insert into public.agent_approval_update_receipts (
    operation,
    update_id,
    chat_id
  )
  values (
    'resolve',
    p_update_id,
    p_chat_id
  )
  on conflict (operation, update_id) do nothing
  returning true into receipt_inserted;

  if not coalesce(receipt_inserted, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

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

  if
    session.id is null
    or approval.expires_at <= now()
    or session.expires_at <= now()
  then
    if session.id is not null then
      delete from public.agent_sessions where id = session.id;
    else
      delete from public.agent_pending_approvals where id = approval.id;
    end if;
    return jsonb_build_object('kind', 'expired');
  end if;

  if
    approval.id <> p_approval_id
    or approval.version <> p_approval_version
    or approval.draft_id <> p_draft_id
    or approval.draft_version <> p_draft_version
    or approval.tool_name <> p_tool_name
    or approval.chat_id <> p_chat_id
  then
    return jsonb_build_object('kind', 'stale');
  end if;

  if p_decision = 'reject' then
    delete from public.agent_pending_approvals
    where id = approval.id;
    return jsonb_build_object('kind', 'rejected');
  end if;

  claimed_state := approval.sealed_run_state;
  claimed_session_id := approval.session_id;
  delete from public.agent_pending_approvals
  where id = approval.id;
  return jsonb_build_object(
    'kind', 'claimed',
    'sealedRunState', claimed_state,
    'sessionId', claimed_session_id
  );
end;
$$;

create function public.clear_agent_approval_for_session(
  p_session_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleared_count bigint;
  session_chat_id bigint;
begin
  if
    p_session_id is null
    or p_reason not in ('cancelled', 'confirmed', 'expired')
  then
    raise exception 'invalid agent approval clear';
  end if;

  select chat_id
  into session_chat_id
  from public.agent_sessions
  where id = p_session_id;

  if session_chat_id is not null then
    perform pg_advisory_xact_lock(session_chat_id);
  end if;

  delete from public.agent_pending_approvals
  where session_id = p_session_id;
  get diagnostics cleared_count = row_count;

  return jsonb_build_object('cleared', cleared_count > 0);
end;
$$;

revoke all on function public.read_agent_session(bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.record_agent_session_turn(
  bigint, bigint, text, uuid, bigint, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.clear_agent_session(
  bigint, bigint, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.read_agent_approval(
  bigint, text, bigint, text
) from public, anon, authenticated, service_role;
revoke all on function public.stage_agent_approval(
  bigint, bigint, text, uuid, text, bigint, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.resolve_agent_approval(
  bigint, bigint, uuid, bigint, text, bigint, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.clear_agent_approval_for_session(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.read_agent_session(bigint)
  to service_role;
grant execute on function public.record_agent_session_turn(
  bigint, bigint, text, uuid, bigint, uuid, text, text
) to service_role;
grant execute on function public.clear_agent_session(
  bigint, bigint, uuid, text
) to service_role;
grant execute on function public.read_agent_approval(
  bigint, text, bigint, text
) to service_role;
grant execute on function public.stage_agent_approval(
  bigint, bigint, text, uuid, text, bigint, text, text
) to service_role;
grant execute on function public.resolve_agent_approval(
  bigint, bigint, uuid, bigint, text, bigint, text, text
) to service_role;
grant execute on function public.clear_agent_approval_for_session(uuid, text)
  to service_role;
