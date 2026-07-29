alter table public.agent_pending_approvals
  add column approved_update_id bigint unique check (
    approved_update_id is null or approved_update_id >= 0
  );

create or replace function public.resolve_agent_approval(
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
  approval_chat_id bigint;
  session public.agent_sessions;
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
    or p_tool_name is null
    or char_length(p_tool_name) = 0
    or p_decision not in ('approve', 'reject')
  then
    raise exception 'invalid agent approval resolution';
  end if;

  select chat_id
  into approval_chat_id
  from public.agent_pending_approvals
  where id = p_approval_id;

  perform pg_advisory_xact_lock(
    coalesce(approval_chat_id, p_chat_id)
  );

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

  select *
  into approval
  from public.agent_pending_approvals
  where id = p_approval_id
  for update;

  if approval.id is null then
    return jsonb_build_object(
      'kind',
      case
        when coalesce(receipt_inserted, false) then 'missing'
        else 'replay'
      end
    );
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
    or session.chat_id <> p_chat_id
    or session.active_draft_id is distinct from p_draft_id
  then
    return jsonb_build_object('kind', 'stale');
  end if;

  if approval.approved_update_id is not null then
    if p_decision = 'reject' then
      return jsonb_build_object('kind', 'stale');
    end if;
    return jsonb_build_object(
      'kind', 'claimed',
      'sealedRunState', approval.sealed_run_state,
      'sessionId', approval.session_id
    );
  end if;

  if not coalesce(receipt_inserted, false) then
    return jsonb_build_object('kind', 'replay');
  end if;

  if p_decision = 'reject' then
    delete from public.agent_pending_approvals
    where id = approval.id;
    return jsonb_build_object('kind', 'rejected');
  end if;

  update public.agent_pending_approvals
  set approved_update_id = p_update_id
  where id = approval.id;

  return jsonb_build_object(
    'kind', 'claimed',
    'sealedRunState', approval.sealed_run_state,
    'sessionId', approval.session_id
  );
end;
$$;

revoke all on function public.resolve_agent_approval(
  bigint, bigint, uuid, bigint, text, bigint, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.resolve_agent_approval(
  bigint, bigint, uuid, bigint, text, bigint, text, text
) to service_role;
