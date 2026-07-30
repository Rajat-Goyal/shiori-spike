-- Drops the one genuinely abandoned table and its three dead functions.
--
-- `agent_session_turns` was introduced by 20260729010000 for ephemeral agent
-- sessions and superseded by `agent_session_sdk_items` in 20260730010000, which
-- stores durable SDK items instead. Nothing has read or written it since.
--
-- Verified before writing this migration:
--   0 rows, 0 inbound foreign keys, 0 triggers, 0 dependent views
--   the three functions below have no caller in server/src and no SQL caller
--
-- Deliberately NOT dropped, despite looking dead:
--
--   apply_conversation_turn_before_status, apply_conversation_turn_base,
--   read_agent_product_context_before_continuations (and its two predecessors),
--   resolve_simple_reminder_action_before_commitment_edits
--
-- Those are live. This schema versions RPCs by delegation: each new version calls
-- the previous one, so the current entry point depends on every earlier layer.
-- They never appear in TypeScript, which is exactly why a name-based cleanup
-- would break production.
--
--   sync_terminal_work_session, clear_superseded_work_session_options,
--   mark_commitment_preparation_from_work_session
--
-- Those are enabled trigger functions on commitments, conversation_drafts and
-- work_sessions respectively.

drop function if exists public.record_agent_session_turn(
  bigint, bigint, text, uuid, bigint, uuid, text, text
);
drop function if exists public.read_agent_session(bigint);
drop function if exists public.agent_session_snapshot(uuid);

drop table if exists public.agent_session_turns;
