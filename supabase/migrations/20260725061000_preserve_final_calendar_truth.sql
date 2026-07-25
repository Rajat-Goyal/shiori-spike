alter table public.work_sessions
  drop constraint work_sessions_calendar_audit_check,
  add constraint work_sessions_calendar_audit_check check (
    (
      calendar_status = 'free'
      and calendar_checked_at is not null
      and final_calendar_observation = 'free'
    )
    or (
      calendar_status = 'conflict_kept'
      and calendar_checked_at is not null
      and conflict_consent
      and final_calendar_observation in ('free', 'conflict')
    )
    or (
      calendar_status = 'unverified'
      and calendar_checked_at is null
      and final_calendar_observation = 'unavailable'
    )
  );

create function public.confirm_work_session_final_state(
  p_update_id bigint,
  p_owner_chat_id bigint,
  p_owner_id text,
  p_draft_id uuid,
  p_version integer,
  p_expected_stage text,
  p_action text,
  p_calendar_attempted_at timestamptz,
  p_calendar_checked_at timestamptz,
  p_conflict_consent boolean,
  p_final_observation text,
  p_calendar_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  compatibility_status text := p_calendar_status;
  normalized boolean := false;
begin
  if (
    p_calendar_status = 'free'
    and p_conflict_consent
    and p_final_observation = 'free'
    and p_action = 'confirm'
    and p_expected_stage = 'conflict_confirming'
    and p_calendar_checked_at is not null
  ) then
    compatibility_status := 'conflict_kept';
    normalized := true;
  end if;

  result := public.confirm_work_session(
    p_update_id,
    p_owner_chat_id,
    p_owner_id,
    p_draft_id,
    p_version,
    p_expected_stage,
    p_action,
    p_calendar_attempted_at,
    p_calendar_checked_at,
    p_conflict_consent,
    p_final_observation,
    compatibility_status
  );

  if normalized and result->>'kind' = 'applied' then
    update public.work_sessions session
    set calendar_status = 'free'
    from public.commitments commitment
    where
      commitment.source_draft_id = p_draft_id
      and session.commitment_id = commitment.id
      and session.sequence_number = 1
      and session.calendar_status = 'conflict_kept'
      and session.conflict_consent
      and session.final_calendar_observation = 'free';

    if not found then
      raise exception 'final Calendar truth normalization failed';
    end if;
  end if;

  return result;
end;
$$;

revoke all on function public.confirm_work_session_final_state(
  bigint, bigint, text, uuid, integer, text, text, timestamptz,
  timestamptz, boolean, text, text
) from public, anon, authenticated;
revoke execute on function public.confirm_work_session(
  bigint, bigint, text, uuid, integer, text, text, timestamptz,
  timestamptz, boolean, text, text
) from service_role;

grant execute on function public.confirm_work_session_final_state(
  bigint, bigint, text, uuid, integer, text, text, timestamptz,
  timestamptz, boolean, text, text
) to service_role;
