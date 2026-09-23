-- =============================================================================
-- 0099 · The AI teammate answers the phone (M18 step 5). A call it picked up
--        is answered by 'ai': it counts as answered, not missed, and its run
--        (one per call, however many turns the call has) points at the call.
--
--        Its settings (when it answers, its voice) live in the teammate's
--        config document with everything else, so nothing else changes here.
-- =============================================================================

alter type app.call_answered_via add value if not exists 'ai';

alter table app.ai_teammate_runs
  add column call_id uuid references app.calls (id) on delete set null;

create index ai_teammate_runs_call_idx on app.ai_teammate_runs (call_id) where call_id is not null;

comment on column app.ai_teammate_runs.call_id is
  'The phone call this run answered live (M18 step 5); null for a text, email or chat reply.';
