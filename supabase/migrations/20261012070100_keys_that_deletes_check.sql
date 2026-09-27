-- =============================================================================
-- The keys a delete has to check, indexed (PERF-M1, PERF-M2).
--
--        Deleting a row makes Postgres look up every row that points at it,
--        through each foreign key, one lookup per deleted row. With no index
--        on the pointing column that lookup is a scan of the whole table —
--        every business's rows, not just this one's.
--
--          workflow_runs.trigger_event_id   The workflows said events are never
--                                           deleted, so it needed no index.
--                                           private.purge_workspace now
--                                           deletes a business's events, and
--                                           each one scanned every run.
--          messages.activity_id,            deleting one timeline entry (or a
--          calls.activity_id                purge deleting all of them) set
--                                           these to null by scanning both
--                                           tables, per entry.
--          email_suppressions.message_id,   the same for deleting a message.
--          email_inbound_unmatched
--            .resolved_message_id
--
--        Partial on `is not null`: most rows point nowhere, and a null never
--        matches a delete. Plain `create index`, as every migration here does:
--        the migration runs in a transaction, where `concurrently` can't.
-- =============================================================================

create index if not exists workflow_runs_trigger_event_id_idx
  on app.workflow_runs (trigger_event_id) where trigger_event_id is not null;

create index if not exists messages_activity_id_idx
  on app.messages (activity_id) where activity_id is not null;
create index if not exists calls_activity_id_idx
  on app.calls (activity_id) where activity_id is not null;

create index if not exists email_suppressions_message_id_idx
  on app.email_suppressions (message_id) where message_id is not null;
create index if not exists email_inbound_unmatched_resolved_message_id_idx
  on app.email_inbound_unmatched (resolved_message_id) where resolved_message_id is not null;
