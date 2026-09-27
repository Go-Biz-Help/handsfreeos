-- =============================================================================
-- The outbox claims its oldest rows without sorting the whole backlog (PERF-L2).
--
--        The worker claims `where status = 'pending' and next_attempt_at <=
--        now() ... order by created_at limit n`. outbox_pending_idx is on
--        next_attempt_at, so every poll read every due row and sorted them to
--        take the first few: a backlog cost itself squared to drain. Walking
--        the pending rows in created_at order stops at the batch size instead.
-- =============================================================================

create index if not exists outbox_pending_created_idx
  on app.outbox (created_at) where status = 'pending';
