create function public.read_dashboard_summary(
  p_owner_id text
)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'activeCommitments',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', commitment.id,
            'definitionOfDone', commitment.definition_of_done,
            'targetAt', commitment.target_at,
            'currentSession',
              case
                when session.id is null then null
                else jsonb_build_object(
                  'id', session.id,
                  'sequenceNumber', session.sequence_number,
                  'status', session.status,
                  'startAt', session.start_at,
                  'endAt', session.end_at,
                  'durationMinutes', session.duration_minutes,
                  'calendarStatus', session.calendar_status,
                  'calendarAttemptedAt',
                    session.calendar_attempted_at,
                  'calendarCheckedAt', session.calendar_checked_at,
                  'conflictConsent', session.conflict_consent,
                  'finalCalendarObservation',
                    session.final_calendar_observation,
                  'outcomeAt', session.outcome_at,
                  'isRecovery', session.is_recovery
                )
              end,
            'continuation',
              case
                when continuation.id is null then null
                else jsonb_build_object(
                  'id', continuation.id,
                  'version', continuation.version,
                  'stage', continuation.stage
                )
              end,
            'deliveries',
              coalesce(
                (
                  select jsonb_agg(
                    jsonb_build_object(
                      'id', message.id,
                      'kind', message.kind,
                      'dueAt', message.due_at,
                      'state', message.state
                    )
                    order by message.due_at, message.id
                  )
                  from public.scheduled_messages as message
                  where
                    message.commitment_id = commitment.id
                    and (
                      (
                        session.id is null
                        and message.kind = 'simple_reminder'
                      )
                      or message.work_session_id = session.id
                    )
                ),
                '[]'::jsonb
              )
          )
          order by commitment.target_at, commitment.id
        )
        from public.commitments as commitment
        left join lateral (
          select work_session.*
          from public.work_sessions as work_session
          where work_session.commitment_id = commitment.id
          order by
            work_session.sequence_number desc,
            work_session.id desc
          limit 1
        ) as session on true
        left join lateral (
          select intent.id, intent.version, intent.stage
          from public.work_session_continuation_intents as intent
          where
            intent.commitment_id = commitment.id
            and intent.stage in (
              'awaiting_duration',
              'offer',
              'choosing',
              'confirming'
            )
          order by intent.created_at desc, intent.id desc
          limit 1
        ) as continuation on true
        where
          p_owner_id is not null
          and p_owner_id ~ '^[1-9][0-9]{0,18}$'
          and commitment.owner_id = p_owner_id
          and commitment.status = 'active'
      ),
      '[]'::jsonb
    ),
    'sessionHistoryRows',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', history.id,
            'commitmentId', history.commitment_id,
            'definitionOfDone', history.definition_of_done,
            'sequenceNumber', history.sequence_number,
            'status', history.status,
            'startAt', history.start_at,
            'endAt', history.end_at,
            'durationMinutes', history.duration_minutes,
            'outcomeAt', history.outcome_at,
            'isRecovery', history.is_recovery,
            'totalForCommitment', history.total_for_commitment
          )
          order by
            history.commitment_target_at,
            history.commitment_id,
            history.sequence_number desc,
            history.id desc
        )
        from (
          select
            session.id,
            session.commitment_id,
            commitment.definition_of_done,
            commitment.target_at as commitment_target_at,
            session.sequence_number,
            session.status,
            session.start_at,
            session.end_at,
            session.duration_minutes,
            session.outcome_at,
            session.is_recovery,
            row_number() over (
              partition by session.commitment_id
              order by session.sequence_number desc, session.id desc
            ) as row_number_for_commitment,
            count(*) over (
              partition by session.commitment_id
            ) as total_for_commitment
          from public.work_sessions as session
          join public.commitments as commitment
            on commitment.id = session.commitment_id
          where
            p_owner_id is not null
            and p_owner_id ~ '^[1-9][0-9]{0,18}$'
            and commitment.owner_id = p_owner_id
            and session.status in (
              'done',
              'more_work_needed',
              'missed',
              'cancelled'
            )
        ) as history
        where history.row_number_for_commitment <= 5
      ),
      '[]'::jsonb
    ),
    'terminalCommitments',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', terminal.id,
            'definitionOfDone', terminal.definition_of_done,
            'targetAt', terminal.target_at,
            'status', terminal.status,
            'terminalAt', terminal.terminal_at
          )
          order by
            terminal.terminal_at desc,
            terminal.id desc
        )
        from (
          select
            commitment.id,
            commitment.definition_of_done,
            commitment.target_at,
            commitment.status,
            coalesce(
              commitment.completed_at,
              commitment.cancelled_at
            ) as terminal_at
          from public.commitments as commitment
          where
            p_owner_id is not null
            and p_owner_id ~ '^[1-9][0-9]{0,18}$'
            and commitment.owner_id = p_owner_id
            and commitment.status in ('done', 'cancelled')
          order by
            coalesce(
              commitment.completed_at,
              commitment.cancelled_at
            ) desc,
            commitment.id desc
          limit 10
        ) as terminal
      ),
      '[]'::jsonb
    ),
    'events',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', event.id,
            'commitmentId', event.commitment_id,
            'definitionOfDone', event.definition_of_done,
            'eventType', event.event_type,
            'occurredAt', event.occurred_at,
            'actor', event.actor
          )
          order by event.occurred_at desc, event.id desc
        )
        from (
          select
            commitment_event.id,
            commitment_event.commitment_id,
            commitment.definition_of_done,
            commitment_event.event_type,
            commitment_event.occurred_at,
            commitment_event.actor
          from public.commitment_events as commitment_event
          join public.commitments as commitment
            on commitment.id = commitment_event.commitment_id
          where
            p_owner_id is not null
            and p_owner_id ~ '^[1-9][0-9]{0,18}$'
            and commitment.owner_id = p_owner_id
          order by
            commitment_event.occurred_at desc,
            commitment_event.id desc
          limit 20
        ) as event
      ),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.read_dashboard_summary(text)
  from public, anon, authenticated;
grant execute on function public.read_dashboard_summary(text)
  to service_role;
