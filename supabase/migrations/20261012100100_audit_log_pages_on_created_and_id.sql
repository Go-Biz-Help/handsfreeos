-- =============================================================================
-- The audit log pages on (created_at, id), newest first.
--
--        - `audit.list` keyed its pages on created_at alone, at millisecond
--          precision. Every row one command writes shares its now(), so a page
--          that ended among them lost the rest. It now keys on (created_at, id)
--          at full precision, and this index serves that order directly.
--        - It covers everything `audit_logs_workspace_created_idx` did, so
--          that one goes.
-- =============================================================================

create index if not exists audit_logs_workspace_created_id_idx
  on app.audit_logs (workspace_id, created_at desc, id desc);

drop index if exists app.audit_logs_workspace_created_idx;
