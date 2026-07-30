-- Records why a conversation turn returned the fail-closed copy.
--
-- Every bounded failure class and every application-side rejection previously
-- collapsed into one owner-visible string with no persisted trace, so the real
-- distribution of causes was unobservable. This is a durable, append-only
-- diagnostic ledger for that distribution.
--
-- It stores reason codes and turn shape only: no owner text, no draft fields,
-- no Calendar data, no model output.

create table public.conversation_turn_failures (
  id uuid primary key default gen_random_uuid(),
  update_id bigint not null
    references public.telegram_updates(update_id) on delete cascade,
  source text not null check (source in ('application', 'decision')),
  site text not null check (
    site in (
      'ambiguity_response_missing',
      'apply_stale',
      'clarification_against_complete_draft',
      'continuation_reply_missing',
      'continuation_route_unavailable',
      'draft_not_created',
      'draft_ordinary_response_missing',
      'draft_relation_unsupported',
      'draft_target_missing',
      'initial_preparation_incomplete',
      'no_state_draft_not_draftable',
      'no_state_relation_invalid',
      'patched_draft_not_draftable',
      'permission_candidate_mismatch',
      'permission_clarification_class_invalid',
      'permission_decline_class_invalid',
      'permission_draft_not_allowed',
      'permission_ordinary_response_missing',
      'permission_relation_unsupported',
      'separate_draft_not_draftable',
      'separate_request_authority_mismatch',
      'status_apply_not_applied',
      'work_session_authority_mismatch',
      'work_session_reply_missing',
      'decision_failure'
    )
  ),
  reason text check (
    reason is null or char_length(btrim(reason)) > 0
  ),
  attempt_count smallint check (
    attempt_count is null
    or (attempt_count >= 0 and attempt_count <= 2)
  ),
  snapshot_kind text not null check (
    snapshot_kind in ('draft', 'none', 'permission')
  ),
  phase text check (
    phase is null
    or phase in ('awaiting_definition', 'awaiting_target', 'complete')
  ),
  created_at timestamptz not null default now()
);

create index conversation_turn_failures_created_at_idx
  on public.conversation_turn_failures (created_at desc);
create index conversation_turn_failures_site_idx
  on public.conversation_turn_failures (site);
create index conversation_turn_failures_update_id_idx
  on public.conversation_turn_failures (update_id);

alter table public.conversation_turn_failures enable row level security;

revoke all on table public.conversation_turn_failures
  from anon, authenticated;
grant select on table public.conversation_turn_failures to service_role;

-- Best-effort recorder.
--
-- Deliberately separate from `apply_conversation_turn` rather than folded into
-- it: a diagnostic write must never be able to fail, roll back, or delay an
-- owner turn. Returns whether the row was written instead of raising, so the
-- caller can stay fire-and-forget.
create function public.record_conversation_turn_failure(
  p_update_id bigint,
  p_site text,
  p_snapshot_kind text,
  p_source text default 'application',
  p_reason text default null,
  p_attempt_count smallint default null,
  p_phase text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exists boolean;
begin
  select true
  into v_exists
  from public.telegram_updates
  where update_id = p_update_id
    and is_owner_private
  limit 1;

  if v_exists is not true then
    return jsonb_build_object('recorded', false);
  end if;

  insert into public.conversation_turn_failures (
    attempt_count,
    phase,
    reason,
    site,
    snapshot_kind,
    source,
    update_id
  )
  values (
    p_attempt_count,
    p_phase,
    p_reason,
    p_site,
    p_snapshot_kind,
    p_source,
    p_update_id
  );

  return jsonb_build_object('recorded', true);
exception
  when others then
    return jsonb_build_object('recorded', false);
end;
$$;

-- `public` must be revoked explicitly: Postgres grants function EXECUTE to
-- PUBLIC by default, and anon/authenticated inherit it, so revoking only those
-- two roles leaves this security-definer function callable unauthenticated.
revoke all on function public.record_conversation_turn_failure(
  bigint, text, text, text, text, smallint, text
) from public, anon, authenticated;
grant execute on function public.record_conversation_turn_failure(
  bigint, text, text, text, text, smallint, text
) to service_role;
