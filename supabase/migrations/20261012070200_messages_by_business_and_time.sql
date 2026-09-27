-- =============================================================================
-- A business's messages by time (PERF-M3).
--
--        The dashboard numbers (crm.metrics) and the channel pace in the
--        health loaders ask for one business's messages over a period. The
--        only index that starts (workspace_id, occurred_at) is partial on
--        `sync_window`, which those queries don't say, so each one read every
--        business's messages. This is the general one; the sync window's own
--        stays, because the phone's queries do say it.
-- =============================================================================

create index if not exists messages_workspace_occurred_idx
  on app.messages (workspace_id, occurred_at desc);
