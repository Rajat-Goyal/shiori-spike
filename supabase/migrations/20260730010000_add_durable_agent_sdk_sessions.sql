alter table public.agent_sessions
  drop constraint agent_sessions_check;

alter table public.agent_sessions
  add constraint agent_sessions_expiry_check check (
    expires_at > created_at
  );

create table public.agent_session_sdk_items (
  session_id uuid not null
    references public.agent_sessions(id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  item_id uuid not null,
  sealed_item text not null check (
    char_length(sealed_item) > 0
    and octet_length(sealed_item) <= 10485760
  ),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (session_id, sequence),
  unique (session_id, item_id)
);

create table public.agent_session_interaction_context (
  session_id uuid primary key
    references public.agent_sessions(id) on delete cascade,
  context_id uuid not null,
  sealed_context text not null check (
    char_length(sealed_context) > 0
    and octet_length(sealed_context) <= 1048576
  ),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.agent_session_compaction_checkpoints (
  session_id uuid primary key
    references public.agent_sessions(id) on delete cascade,
  checkpoint_id uuid not null,
  through_sequence bigint not null check (through_sequence > 0),
  sealed_checkpoint text not null check (
    char_length(sealed_checkpoint) > 0
    and octet_length(sealed_checkpoint) <= 10485760
  ),
  created_at timestamptz not null default clock_timestamp()
);

create table public.agent_session_sdk_operation_receipts (
  operation text not null check (
    operation in ('application_reply', 'callback_choice')
  ),
  operation_id bigint not null check (operation_id >= 0),
  chat_id bigint not null,
  session_id uuid not null
    references public.agent_sessions(id) on delete cascade,
  item_id uuid not null,
  processed_at timestamptz not null default clock_timestamp(),
  primary key (operation, operation_id)
);

alter table public.agent_session_sdk_items enable row level security;
alter table public.agent_session_interaction_context
  enable row level security;
alter table public.agent_session_compaction_checkpoints
  enable row level security;
alter table public.agent_session_sdk_operation_receipts
  enable row level security;

revoke all on table public.agent_session_sdk_items
  from public, anon, authenticated;
revoke all on table public.agent_session_interaction_context
  from public, anon, authenticated;
revoke all on table public.agent_session_compaction_checkpoints
  from public, anon, authenticated;
revoke all on table public.agent_session_sdk_operation_receipts
  from public, anon, authenticated;

grant select on table public.agent_session_sdk_items to service_role;
grant select on table public.agent_session_interaction_context
  to service_role;
grant select on table public.agent_session_compaction_checkpoints
  to service_role;
grant select on table public.agent_session_sdk_operation_receipts
  to service_role;

create function public.agent_sdk_session_snapshot(
  p_session_id uuid,
  p_item_limit integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with session_item_count as (
    select count(*)::bigint as item_count
    from public.agent_session_sdk_items
    where session_id = p_session_id
  ),
  working_items as (
    select
      item.item_id,
      item.recorded_at,
      item.sealed_item,
      item.sequence
    from public.agent_session_sdk_items as item
    where item.session_id = p_session_id
    order by item.sequence desc
    limit p_item_limit
  )
  select jsonb_build_object(
    'activeDraftId', session.active_draft_id,
    'chatId', session.chat_id,
    'compaction', (
      select jsonb_build_object(
        'checkpointId', checkpoint.checkpoint_id,
        'createdAt', checkpoint.created_at,
        'sealedCheckpoint', checkpoint.sealed_checkpoint,
        'throughSequence', checkpoint.through_sequence
      )
      from public.agent_session_compaction_checkpoints as checkpoint
      where checkpoint.session_id = session.id
    ),
    'expiresAt', session.expires_at,
    'firstWorkingSequence', (
      select min(item.sequence)
      from working_items as item
    ),
    'id', session.id,
    'interaction', (
      select jsonb_build_object(
        'contextId', interaction.context_id,
        'sealedContext', interaction.sealed_context
      )
      from public.agent_session_interaction_context as interaction
      where interaction.session_id = session.id
    ),
    'itemCount', (
      select item_count
      from session_item_count
    ),
    'items', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', item.item_id,
            'recordedAt', item.recorded_at,
            'sealedItem', item.sealed_item,
            'sequence', item.sequence
          )
          order by item.sequence
        )
        from working_items as item
      ),
      '[]'::jsonb
    ),
    'version', session.version
  )
  from public.agent_sessions as session
  where session.id = p_session_id;
$$;

revoke all on function public.agent_sdk_session_snapshot(uuid, integer)
  from public, anon, authenticated, service_role;

create function public.read_agent_sdk_session(
  p_chat_id bigint,
  p_item_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_session public.agent_sessions;
begin
  if
    p_chat_id is null
    or p_item_limit is null
    or p_item_limit < 1
    or p_item_limit > 100
  then
    raise exception 'invalid agent sdk session read';
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
    'session', public.agent_sdk_session_snapshot(
      current_session.id,
      p_item_limit
    )
  );
end;
$$;

create function public.append_agent_sdk_items(
  p_chat_id bigint,
  p_expected_session_id uuid,
  p_expected_version bigint,
  p_proposed_session_id uuid,
  p_items jsonb,
  p_retention_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_session public.agent_sessions;
  item jsonb;
  item_count integer;
  item_offset bigint := 0;
  next_sequence bigint;
  now_at timestamptz;
  replay_item_count bigint;
  resulting_session_id uuid;
begin
  if
    p_chat_id is null
    or p_proposed_session_id is null
    or p_expected_version is null
    or p_retention_seconds is null
    or p_retention_seconds < 3600
    or p_retention_seconds > 2592000
    or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) < 1
    or jsonb_array_length(p_items) > 100
    or (
      p_expected_session_id is null
      and p_expected_version <> 0
    )
    or (
      p_expected_session_id is not null
      and (
        p_expected_version < 1
        or p_proposed_session_id <> p_expected_session_id
      )
    )
  then
    raise exception 'invalid agent sdk item append';
  end if;

  for item in
    select value
    from jsonb_array_elements(p_items)
  loop
    if
      jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item -> 'id') <> 'string'
      or jsonb_typeof(item -> 'sealedItem') <> 'string'
      or char_length(item ->> 'sealedItem') = 0
      or octet_length(item ->> 'sealedItem') > 10485760
    then
      raise exception 'invalid sealed agent sdk item';
    end if;

    perform (item ->> 'id')::uuid;
  end loop;

  if (
    select count(distinct value ->> 'id')
    from jsonb_array_elements(p_items)
  ) <> jsonb_array_length(p_items) then
    raise exception 'duplicate agent sdk item id';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

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

  if current_session.id is not null then
    select count(*)
    into replay_item_count
    from public.agent_session_sdk_items as stored_item
    where
      stored_item.session_id = current_session.id
      and stored_item.item_id in (
        select (value ->> 'id')::uuid
        from jsonb_array_elements(p_items)
      );

    if
      current_session.id = p_proposed_session_id
      and replay_item_count = jsonb_array_length(p_items)
    then
      return jsonb_build_object(
        'kind', 'replay',
        'session', public.agent_sdk_session_snapshot(
          current_session.id,
          40
        )
      );
    end if;
  end if;

  now_at := clock_timestamp();
  item_count := jsonb_array_length(p_items);

  if p_expected_session_id is null then
    if current_session.id is not null then
      return jsonb_build_object('kind', 'stale');
    end if;

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
      null,
      1,
      now_at,
      now_at + make_interval(secs => p_retention_seconds)
    );

    resulting_session_id := p_proposed_session_id;
    next_sequence := 1;
  else
    if
      current_session.id is null
      or current_session.id <> p_expected_session_id
      or current_session.version <> p_expected_version
    then
      return jsonb_build_object('kind', 'stale');
    end if;

    select coalesce(max(stored_item.sequence), 0) + 1
    into next_sequence
    from public.agent_session_sdk_items as stored_item
    where stored_item.session_id = current_session.id;

    update public.agent_sessions
    set
      expires_at = now_at + make_interval(
        secs => p_retention_seconds
      ),
      version = version + 1
    where id = current_session.id;

    resulting_session_id := current_session.id;
  end if;

  for item in
    select value
    from jsonb_array_elements(p_items)
  loop
    insert into public.agent_session_sdk_items (
      session_id,
      sequence,
      item_id,
      sealed_item,
      recorded_at
    )
    values (
      resulting_session_id,
      next_sequence + item_offset,
      (item ->> 'id')::uuid,
      item ->> 'sealedItem',
      now_at
    );
    item_offset := item_offset + 1;
  end loop;

  return jsonb_build_object(
    'kind', 'applied',
    'session', public.agent_sdk_session_snapshot(
      resulting_session_id,
      greatest(40, least(item_count, 100))
    )
  );
end;
$$;

create function public.pop_agent_sdk_item(
  p_chat_id bigint,
  p_session_id uuid,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_session public.agent_sessions;
  popped_item public.agent_session_sdk_items;
begin
  if
    p_chat_id is null
    or p_session_id is null
    or p_expected_version is null
    or p_expected_version < 1
  then
    raise exception 'invalid agent sdk item pop';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

  select *
  into current_session
  from public.agent_sessions
  where chat_id = p_chat_id
  for update;

  if
    current_session.id is null
    or current_session.expires_at <= now()
  then
    if current_session.id is not null then
      delete from public.agent_sessions
      where id = current_session.id;
    end if;
    return jsonb_build_object('kind', 'stale');
  end if;

  if
    current_session.id <> p_session_id
    or current_session.version <> p_expected_version
  then
    return jsonb_build_object('kind', 'stale');
  end if;

  select *
  into popped_item
  from public.agent_session_sdk_items
  where session_id = current_session.id
  order by sequence desc
  limit 1
  for update;

  if popped_item.item_id is null then
    return jsonb_build_object(
      'kind', 'empty',
      'session', public.agent_sdk_session_snapshot(
        current_session.id,
        40
      )
    );
  end if;

  delete from public.agent_session_sdk_items
  where
    session_id = popped_item.session_id
    and sequence = popped_item.sequence;

  delete from public.agent_session_compaction_checkpoints
  where
    session_id = current_session.id
    and through_sequence >= popped_item.sequence;

  update public.agent_sessions
  set version = version + 1
  where id = current_session.id;

  return jsonb_build_object(
    'item', jsonb_build_object(
      'id', popped_item.item_id,
      'recordedAt', popped_item.recorded_at,
      'sealedItem', popped_item.sealed_item,
      'sequence', popped_item.sequence
    ),
    'kind', 'popped',
    'session', public.agent_sdk_session_snapshot(
      current_session.id,
      40
    )
  );
end;
$$;

create function public.page_agent_sdk_history(
  p_chat_id bigint,
  p_session_id uuid,
  p_before_sequence bigint,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_session public.agent_sessions;
  page_items jsonb;
  first_sequence bigint;
  has_older boolean;
begin
  if
    p_chat_id is null
    or p_session_id is null
    or p_before_sequence is null
    or p_before_sequence < 1
    or p_limit is null
    or p_limit < 1
    or p_limit > 100
  then
    raise exception 'invalid agent sdk history page';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

  select *
  into current_session
  from public.agent_sessions
  where chat_id = p_chat_id
  for update;

  if current_session.id is null then
    return jsonb_build_object('kind', 'missing');
  end if;

  if current_session.expires_at <= now() then
    delete from public.agent_sessions
    where id = current_session.id;
    return jsonb_build_object('kind', 'expired');
  end if;

  if current_session.id <> p_session_id then
    return jsonb_build_object('kind', 'missing');
  end if;

  with selected_items as (
    select
      item.item_id,
      item.recorded_at,
      item.sealed_item,
      item.sequence
    from public.agent_session_sdk_items as item
    where
      item.session_id = current_session.id
      and item.sequence < p_before_sequence
    order by item.sequence desc
    limit p_limit
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', selected_item.item_id,
          'recordedAt', selected_item.recorded_at,
          'sealedItem', selected_item.sealed_item,
          'sequence', selected_item.sequence
        )
        order by selected_item.sequence
      ),
      '[]'::jsonb
    ),
    min(selected_item.sequence)
  into page_items, first_sequence
  from selected_items as selected_item;

  select exists (
    select 1
    from public.agent_session_sdk_items as item
    where
      item.session_id = current_session.id
      and first_sequence is not null
      and item.sequence < first_sequence
  )
  into has_older;

  return jsonb_build_object(
    'items', page_items,
    'kind', 'active',
    'nextBeforeSequence', case
      when has_older then first_sequence
      else null
    end
  );
end;
$$;

create function public.write_agent_sdk_interaction(
  p_operation text,
  p_chat_id bigint,
  p_session_id uuid,
  p_expected_version bigint,
  p_active_draft_id text,
  p_operation_id bigint,
  p_item_id uuid,
  p_sealed_item text,
  p_context_id uuid,
  p_sealed_context text,
  p_retention_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_session public.agent_sessions;
  existing_receipt public.agent_session_sdk_operation_receipts;
  next_sequence bigint;
  now_at timestamptz;
begin
  if
    p_operation not in ('application_reply', 'callback_choice')
    or p_chat_id is null
    or p_session_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or (
      p_active_draft_id is not null
      and (
        char_length(p_active_draft_id) = 0
        or char_length(p_active_draft_id) > 200
      )
    )
    or p_operation_id is null
    or p_operation_id < 0
    or p_item_id is null
    or p_sealed_item is null
    or char_length(p_sealed_item) = 0
    or octet_length(p_sealed_item) > 10485760
    or p_retention_seconds is null
    or p_retention_seconds < 3600
    or p_retention_seconds > 2592000
    or (
      (p_context_id is null) <>
      (p_sealed_context is null)
    )
    or (
      p_sealed_context is not null
      and (
        char_length(p_sealed_context) = 0
        or octet_length(p_sealed_context) > 1048576
      )
    )
  then
    raise exception 'invalid agent sdk interaction write';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

  select *
  into existing_receipt
  from public.agent_session_sdk_operation_receipts
  where
    operation = p_operation
    and operation_id = p_operation_id
  for update;

  if existing_receipt.operation_id is not null then
    if
      existing_receipt.chat_id <> p_chat_id
      or existing_receipt.session_id <> p_session_id
      or existing_receipt.item_id <> p_item_id
    then
      return jsonb_build_object('kind', 'stale');
    end if;

    return jsonb_build_object(
      'kind', 'replay',
      'session', public.agent_sdk_session_snapshot(
        existing_receipt.session_id,
        40
      )
    );
  end if;

  select *
  into current_session
  from public.agent_sessions
  where chat_id = p_chat_id
  for update;

  if
    current_session.id is null
    or current_session.expires_at <= now()
  then
    if current_session.id is not null then
      delete from public.agent_sessions
      where id = current_session.id;
    end if;
    return jsonb_build_object('kind', 'stale');
  end if;

  if
    current_session.id <> p_session_id
    or current_session.version <> p_expected_version
  then
    return jsonb_build_object('kind', 'stale');
  end if;

  if exists (
    select 1
    from public.agent_session_sdk_items
    where
      session_id = current_session.id
      and item_id = p_item_id
  ) then
    return jsonb_build_object('kind', 'stale');
  end if;

  select coalesce(max(item.sequence), 0) + 1
  into next_sequence
  from public.agent_session_sdk_items as item
  where item.session_id = current_session.id;

  now_at := clock_timestamp();
  insert into public.agent_session_sdk_items (
    session_id,
    sequence,
    item_id,
    sealed_item,
    recorded_at
  )
  values (
    current_session.id,
    next_sequence,
    p_item_id,
    p_sealed_item,
    now_at
  );

  if p_context_id is null then
    delete from public.agent_session_interaction_context
    where session_id = current_session.id;
  else
    insert into public.agent_session_interaction_context (
      session_id,
      context_id,
      sealed_context,
      updated_at
    )
    values (
      current_session.id,
      p_context_id,
      p_sealed_context,
      now_at
    )
    on conflict (session_id) do update
    set
      context_id = excluded.context_id,
      sealed_context = excluded.sealed_context,
      updated_at = excluded.updated_at;
  end if;

  insert into public.agent_session_sdk_operation_receipts (
    operation,
    operation_id,
    chat_id,
    session_id,
    item_id,
    processed_at
  )
  values (
    p_operation,
    p_operation_id,
    p_chat_id,
    current_session.id,
    p_item_id,
    now_at
  );

  update public.agent_sessions
  set
    active_draft_id = p_active_draft_id,
    expires_at = now_at + make_interval(
      secs => p_retention_seconds
    ),
    version = version + 1
  where id = current_session.id;

  return jsonb_build_object(
    'kind', 'applied',
    'session', public.agent_sdk_session_snapshot(
      current_session.id,
      40
    )
  );
end;
$$;

revoke all on function public.write_agent_sdk_interaction(
  text, bigint, uuid, bigint, text, bigint, uuid, text, uuid, text,
  integer
) from public, anon, authenticated, service_role;

create function public.write_agent_sdk_application_reply(
  p_chat_id bigint,
  p_session_id uuid,
  p_expected_version bigint,
  p_active_draft_id text,
  p_operation_id bigint,
  p_item_id uuid,
  p_sealed_item text,
  p_context_id uuid,
  p_sealed_context text,
  p_retention_seconds integer
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.write_agent_sdk_interaction(
    'application_reply',
    p_chat_id,
    p_session_id,
    p_expected_version,
    p_active_draft_id,
    p_operation_id,
    p_item_id,
    p_sealed_item,
    p_context_id,
    p_sealed_context,
    p_retention_seconds
  );
$$;

create function public.write_agent_sdk_callback_choice(
  p_chat_id bigint,
  p_session_id uuid,
  p_expected_version bigint,
  p_active_draft_id text,
  p_operation_id bigint,
  p_item_id uuid,
  p_sealed_item text,
  p_context_id uuid,
  p_sealed_context text,
  p_retention_seconds integer
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.write_agent_sdk_interaction(
    'callback_choice',
    p_chat_id,
    p_session_id,
    p_expected_version,
    p_active_draft_id,
    p_operation_id,
    p_item_id,
    p_sealed_item,
    p_context_id,
    p_sealed_context,
    p_retention_seconds
  );
$$;

create function public.write_agent_sdk_compaction(
  p_chat_id bigint,
  p_session_id uuid,
  p_expected_version bigint,
  p_checkpoint_id uuid,
  p_through_sequence bigint,
  p_sealed_checkpoint text,
  p_retention_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_checkpoint public.agent_session_compaction_checkpoints;
  current_session public.agent_sessions;
  latest_sequence bigint;
  now_at timestamptz;
begin
  if
    p_chat_id is null
    or p_session_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or p_checkpoint_id is null
    or p_through_sequence is null
    or p_through_sequence < 1
    or p_sealed_checkpoint is null
    or char_length(p_sealed_checkpoint) = 0
    or octet_length(p_sealed_checkpoint) > 10485760
    or p_retention_seconds is null
    or p_retention_seconds < 3600
    or p_retention_seconds > 2592000
  then
    raise exception 'invalid agent sdk compaction write';
  end if;

  perform pg_advisory_xact_lock(p_chat_id);

  select *
  into current_session
  from public.agent_sessions
  where chat_id = p_chat_id
  for update;

  if
    current_session.id is null
    or current_session.expires_at <= now()
  then
    if current_session.id is not null then
      delete from public.agent_sessions
      where id = current_session.id;
    end if;
    return jsonb_build_object('kind', 'stale');
  end if;

  if current_session.id <> p_session_id then
    return jsonb_build_object('kind', 'stale');
  end if;

  select *
  into current_checkpoint
  from public.agent_session_compaction_checkpoints
  where session_id = current_session.id
  for update;

  if
    current_checkpoint.checkpoint_id = p_checkpoint_id
    and current_checkpoint.through_sequence = p_through_sequence
  then
    return jsonb_build_object(
      'kind', 'replay',
      'session', public.agent_sdk_session_snapshot(
        current_session.id,
        40
      )
    );
  end if;

  if current_session.version <> p_expected_version then
    return jsonb_build_object('kind', 'stale');
  end if;

  select max(item.sequence)
  into latest_sequence
  from public.agent_session_sdk_items as item
  where item.session_id = current_session.id;

  if
    latest_sequence is null
    or p_through_sequence > latest_sequence
    or (
      current_checkpoint.through_sequence is not null
      and p_through_sequence < current_checkpoint.through_sequence
    )
  then
    raise exception 'invalid agent sdk compaction boundary';
  end if;

  now_at := clock_timestamp();
  insert into public.agent_session_compaction_checkpoints (
    session_id,
    checkpoint_id,
    through_sequence,
    sealed_checkpoint,
    created_at
  )
  values (
    current_session.id,
    p_checkpoint_id,
    p_through_sequence,
    p_sealed_checkpoint,
    now_at
  )
  on conflict (session_id) do update
  set
    checkpoint_id = excluded.checkpoint_id,
    through_sequence = excluded.through_sequence,
    sealed_checkpoint = excluded.sealed_checkpoint,
    created_at = excluded.created_at;

  update public.agent_sessions
  set
    expires_at = now_at + make_interval(
      secs => p_retention_seconds
    ),
    version = version + 1
  where id = current_session.id;

  return jsonb_build_object(
    'kind', 'applied',
    'session', public.agent_sdk_session_snapshot(
      current_session.id,
      40
    )
  );
end;
$$;

create function public.reset_agent_sdk_session(
  p_chat_id bigint,
  p_session_id uuid,
  p_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_session public.agent_sessions;
begin
  if
    p_chat_id is null
    or p_mode not in ('forget', 'reset')
  then
    raise exception 'invalid agent sdk session reset';
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

  if
    p_session_id is not null
    and current_session.id <> p_session_id
  then
    return jsonb_build_object('kind', 'stale');
  end if;

  delete from public.agent_session_update_receipts
  where chat_id = p_chat_id;

  delete from public.agent_approval_update_receipts
  where chat_id = p_chat_id;

  delete from public.agent_sessions
  where id = current_session.id;

  return jsonb_build_object(
    'kind', 'cleared',
    'mode', p_mode
  );
end;
$$;

revoke all on function public.read_agent_sdk_session(bigint, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.append_agent_sdk_items(
  bigint, uuid, bigint, uuid, jsonb, integer
) from public, anon, authenticated, service_role;
revoke all on function public.pop_agent_sdk_item(bigint, uuid, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.page_agent_sdk_history(
  bigint, uuid, bigint, integer
) from public, anon, authenticated, service_role;
revoke all on function public.write_agent_sdk_application_reply(
  bigint, uuid, bigint, text, bigint, uuid, text, uuid, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.write_agent_sdk_callback_choice(
  bigint, uuid, bigint, text, bigint, uuid, text, uuid, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.write_agent_sdk_compaction(
  bigint, uuid, bigint, uuid, bigint, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.reset_agent_sdk_session(
  bigint, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.read_agent_sdk_session(bigint, integer)
  to service_role;
grant execute on function public.append_agent_sdk_items(
  bigint, uuid, bigint, uuid, jsonb, integer
) to service_role;
grant execute on function public.pop_agent_sdk_item(bigint, uuid, bigint)
  to service_role;
grant execute on function public.page_agent_sdk_history(
  bigint, uuid, bigint, integer
) to service_role;
grant execute on function public.write_agent_sdk_application_reply(
  bigint, uuid, bigint, text, bigint, uuid, text, uuid, text, integer
) to service_role;
grant execute on function public.write_agent_sdk_callback_choice(
  bigint, uuid, bigint, text, bigint, uuid, text, uuid, text, integer
) to service_role;
grant execute on function public.write_agent_sdk_compaction(
  bigint, uuid, bigint, uuid, bigint, text, integer
) to service_role;
grant execute on function public.reset_agent_sdk_session(
  bigint, uuid, text
) to service_role;
