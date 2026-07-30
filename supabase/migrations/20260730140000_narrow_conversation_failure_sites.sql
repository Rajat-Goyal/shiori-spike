-- Narrows the recorded failure sites to those the application can still reach.
--
-- Collapsing the phase-by-relation dispatch into one handler removed nine
-- routes. They existed only to reject a decision that did not fit a cell of the
-- five-phase by seven-relation matrix, and there is no matrix left to miss:
--
--   clarification_against_complete_draft   a clarification now simply patches
--   draft_relation_unsupported             relation no longer gates the turn
--   draft_target_missing                   the focused draft is the target
--   permission_candidate_mismatch          parked fields are authoritative
--   permission_clarification_class_invalid unclear replies re-ask
--   permission_decline_class_invalid       a decline is a decline
--   permission_ordinary_response_missing   answered from application state
--   permission_relation_unsupported        no per-phase relation table
--   separate_request_authority_mismatch    a separate promise needs no authority
--
-- Existing rows are preserved: the check is replaced with one that accepts both
-- the current sites and any historical value already recorded, so a diagnostic
-- ledger never loses its history to a schema change.

alter table public.conversation_turn_failures
  drop constraint if exists conversation_turn_failures_site_check;

alter table public.conversation_turn_failures
  add constraint conversation_turn_failures_site_check check (
    site in (
      -- Currently reachable.
      'ambiguity_response_missing',
      'apply_stale',
      'continuation_reply_missing',
      'continuation_route_unavailable',
      'decision_failure',
      'draft_not_created',
      'draft_ordinary_response_missing',
      'initial_preparation_incomplete',
      'no_state_draft_not_draftable',
      'no_state_relation_invalid',
      'patched_draft_not_draftable',
      'permission_draft_not_allowed',
      'separate_draft_not_draftable',
      'status_apply_not_applied',
      'work_session_authority_mismatch',
      'work_session_reply_missing',
      -- Historical, retained so recorded rows stay valid.
      'clarification_against_complete_draft',
      'draft_relation_unsupported',
      'draft_target_missing',
      'permission_candidate_mismatch',
      'permission_clarification_class_invalid',
      'permission_decline_class_invalid',
      'permission_ordinary_response_missing',
      'permission_relation_unsupported',
      'separate_request_authority_mismatch'
    )
  );
