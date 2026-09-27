-- =============================================================================
-- The step-log clean-up deletes the logs of runs that ended over 180 days ago,
-- then finds when the next is due: the oldest run since the cut-off that still
-- has a log. By end time it starts at the cut-off and stops at the first one,
-- instead of reading every ended run the workspace has.
-- =============================================================================

create index if not exists workflow_runs_ended_idx
  on app.workflow_runs (workspace_id, ended_at) where ended_at is not null;
