-- =============================================================================
-- Starting a run counts the workflow's live runs (up to MAX_LIVE_RUNS) first.
-- workflow_runs_workflow_idx finds them, but `is_test` isn't in it, so every
-- row was a heap visit. Only live, real runs are in this one, so the count is
-- index-only. The statuses are LIVE_STATUSES
-- (apps/worker/src/workflows/constants.ts); enrol spells them out the same way.
-- =============================================================================

create index if not exists workflow_runs_live_idx
  on app.workflow_runs (workflow_id)
  where not is_test and status in ('running', 'waiting', 'awaiting_approval', 'held');
