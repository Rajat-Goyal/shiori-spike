create or replace function public.read_agent_product_context(
  p_owner_id text,
  p_focused_entity_id uuid,
  p_limit integer
)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with
  valid_request as (
    select
      p_owner_id is not null
      and p_owner_id ~ '^[1-9][0-9]{0,18}$'
      and p_limit between 1 and 10 as allowed
  ),
  bounded_drafts as (
    select
      draft.id,
      draft.version,
      draft.state = 'active' as focused,
      draft.phase,
      draft.definition_of_done,
      draft.target_at,
      draft.expires_at,
      case
        when draft.simple_action then 'simple_action'
        when draft.possible_work_session then 'possible_work_session'
        else 'unresolved'
      end as mode,
      draft.updated_at
    from public.conversation_drafts as draft
    cross join valid_request
    where
      valid_request.allowed
      and draft.owner_key
      and draft.state in ('active', 'parked')
      and draft.expires_at > now()
    order by
      (draft.state = 'active') desc,
      draft.updated_at desc,
      draft.id
    limit p_limit + 1
  ),
  bounded_commitments as (
    select
      commitment.id,
      1 as version,
      commitment.status,
      commitment.definition_of_done,
      commitment.target_at,
      greatest(
        commitment.created_at,
        coalesce(commitment.completed_at, '-infinity'::timestamptz),
        coalesce(commitment.cancelled_at, '-infinity'::timestamptz)
      ) as changed_at
    from public.commitments as commitment
    cross join valid_request
    where
      valid_request.allowed
      and commitment.owner_id = p_owner_id
    order by
      (commitment.status = 'active') desc,
      changed_at desc,
      commitment.id
    limit p_limit + 1
  ),
  bounded_work_sessions as (
    select
      session.id,
      session.commitment_id,
      session.status,
      session.start_at,
      session.end_at,
      session.duration_minutes,
      session.created_at
    from public.work_sessions as session
    join public.commitments as commitment
      on commitment.id = session.commitment_id
    cross join valid_request
    where
      valid_request.allowed
      and commitment.owner_id = p_owner_id
    order by
      session.created_at desc,
      session.id
    limit least(20, p_limit * 2) + 1
  ),
  bounded_outcomes as (
    select
      session.commitment_id,
      session.id as work_session_id,
      session.status,
      session.outcome_at
    from public.work_sessions as session
    join public.commitments as commitment
      on commitment.id = session.commitment_id
    cross join valid_request
    where
      valid_request.allowed
      and commitment.owner_id = p_owner_id
      and session.status in (
        'cancelled',
        'done',
        'missed',
        'more_work_needed'
      )
      and session.outcome_at is not null
    order by session.outcome_at desc, session.id
    limit p_limit + 1
  ),
  focused_draft as (
    select jsonb_build_object(
      'kind', 'draft',
      'entity', jsonb_build_object(
        'id', draft.id,
        'version', draft.version,
        'focused', draft.state = 'active',
        'phase', draft.phase,
        'definitionOfDone', draft.definition_of_done,
        'targetAt', draft.target_at,
        'expiresAt', draft.expires_at,
        'mode', case
          when draft.simple_action then 'simple_action'
          when draft.possible_work_session then 'possible_work_session'
          else 'unresolved'
        end
      )
    ) as value
    from public.conversation_drafts as draft
    cross join valid_request
    where
      valid_request.allowed
      and p_focused_entity_id is not null
      and draft.id = p_focused_entity_id
      and draft.owner_key
      and draft.state in ('active', 'parked')
      and draft.expires_at > now()
    limit 1
  ),
  focused_commitment as (
    select jsonb_build_object(
      'kind', 'commitment',
      'entity', jsonb_build_object(
        'id', commitment.id,
        'version', 1,
        'status', commitment.status,
        'definitionOfDone', commitment.definition_of_done,
        'targetAt', commitment.target_at
      )
    ) as value
    from public.commitments as commitment
    cross join valid_request
    where
      valid_request.allowed
      and p_focused_entity_id is not null
      and commitment.id = p_focused_entity_id
      and commitment.owner_id = p_owner_id
    limit 1
  )
  select jsonb_build_object(
    'drafts', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', draft.id,
            'version', draft.version,
            'focused', draft.focused,
            'phase', draft.phase,
            'definitionOfDone', draft.definition_of_done,
            'targetAt', draft.target_at,
            'expiresAt', draft.expires_at,
            'mode', draft.mode
          )
          order by draft.focused desc, draft.updated_at desc, draft.id
        )
        from (
          select *
          from bounded_drafts
          limit p_limit
        ) as draft
      ),
      '[]'::jsonb
    ),
    'commitments', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', commitment.id,
            'version', commitment.version,
            'status', commitment.status,
            'definitionOfDone', commitment.definition_of_done,
            'targetAt', commitment.target_at
          )
          order by
            (commitment.status = 'active') desc,
            commitment.changed_at desc,
            commitment.id
        )
        from (
          select *
          from bounded_commitments
          limit p_limit
        ) as commitment
      ),
      '[]'::jsonb
    ),
    'workSessions', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', session.id,
            'commitmentId', session.commitment_id,
            'status', session.status,
            'startAt', session.start_at,
            'endAt', session.end_at,
            'durationMinutes', session.duration_minutes
          )
          order by session.created_at desc, session.id
        )
        from (
          select *
          from bounded_work_sessions
          limit least(20, p_limit * 2)
        ) as session
      ),
      '[]'::jsonb
    ),
    'recentOutcomes', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'commitmentId', outcome.commitment_id,
            'workSessionId', outcome.work_session_id,
            'status', outcome.status,
            'occurredAt', outcome.outcome_at
          )
          order by outcome.outcome_at desc, outcome.work_session_id
        )
        from (
          select *
          from bounded_outcomes
          limit p_limit
        ) as outcome
      ),
      '[]'::jsonb
    ),
    'focusedEntity', coalesce(
      (select focused_draft.value from focused_draft),
      (select focused_commitment.value from focused_commitment)
    ),
    'truncated', jsonb_build_object(
      'drafts', (select count(*) > p_limit from bounded_drafts),
      'commitments',
        (select count(*) > p_limit from bounded_commitments),
      'workSessions',
        (
          select count(*) > least(20, p_limit * 2)
          from bounded_work_sessions
        ),
      'recentOutcomes',
        (select count(*) > p_limit from bounded_outcomes)
    )
  );
$$;

revoke all on function public.read_agent_product_context(
  text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.read_agent_product_context(
  text, uuid, integer
) to service_role;
