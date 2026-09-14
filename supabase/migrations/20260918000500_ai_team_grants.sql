-- =============================================================================
-- 0034 · The AI teammate and website chat: grants and foreign-key indexes.
--        People read the teammate, its history, runs and tool calls, and the
--        drafts and chat visitors their inbox needs, and change only the
--        columns their commands write: the training counts, the worker's
--        bookkeeping and the token hashes stay out of reach. The worker
--        writes the rest. conversations, messages, leads and ai_usage keep
--        the grants they had, which cover their new columns. Every foreign
--        key 0031-0033 added gets an index that leads with its column where
--        none did (0020's rule). On the busy conversations, messages and
--        ai_usage tables the new keys are empty on most rows, so they get
--        partial indexes over the rows that have one: that is all a
--        foreign-key check, or deleting the row they point at, reads.
-- =============================================================================

-- ---------- grants: people ----------
grant select, insert on app.ai_teammates, app.ai_teammate_revisions to authenticated;
-- A save, a restore or a status change. The counts, when training started and how it turned automatic are
-- left out (the guard sets them from the status), and so is archived_at (nothing archives a teammate yet).
grant update (name, status, config, config_version, revision, labels) on app.ai_teammates to authenticated;
grant select on app.ai_teammate_runs, app.ai_teammate_tool_calls, app.ai_teammate_drafts to authenticated;
-- Deciding a draft; the policy allows only pending -> decided, in the person's own name.
grant update (status, edits, reason, decided_by, decided_at, via) on app.ai_teammate_drafts to authenticated;
grant select, insert on app.chat_widgets to authenticated;
-- The install check (last_seen_*) is the worker's.
grant update (public_key, allowed_origins, teammate_id, greeting, launcher_label, accent_color, position, away_message,
  ask_for, sms_consent, daily_cap, paused_at)
  on app.chat_widgets to authenticated;
-- Who a visitor said they are and where they are; never the token hashes or the hashed IP. RETURNING must
-- name columns from this list.
grant select (id, workspace_id, widget_id, conversation_id, name, phone_e164, email, person_id, last_page_path,
  last_seen_at, blocked_at, network_blocked_until, created_at, updated_at)
  on app.chat_visitors to authenticated;
grant update (blocked_at, network_blocked_until) on app.chat_visitors to authenticated;

-- ---------- grants: the worker ----------
grant select, insert, update on app.ai_teammates, app.chat_widgets to service_actor;
grant select, insert on app.ai_teammate_revisions to service_actor;
grant select, insert, update, delete on app.ai_teammate_runs, app.ai_teammate_tool_calls, app.ai_teammate_drafts,
  app.chat_visitors, app.chat_signals to service_actor;
revoke all on app.ai_teammates, app.ai_teammate_revisions, app.ai_teammate_runs, app.ai_teammate_tool_calls,
  app.ai_teammate_drafts, app.chat_widgets, app.chat_visitors, app.chat_signals from anon;

-- ---------- 0031 · the teammate, and its columns on conversations and messages ----------
create index ai_teammates_workspace_id_idx on app.ai_teammates (workspace_id);
create index ai_teammates_created_by_idx on app.ai_teammates (created_by);
create index ai_teammate_revisions_workspace_id_idx on app.ai_teammate_revisions (workspace_id);
create index ai_teammate_revisions_changed_by_idx on app.ai_teammate_revisions (changed_by);
create index conversations_ai_teammate_id_idx on app.conversations (ai_teammate_id) where ai_teammate_id is not null;
create index conversations_taken_over_by_idx on app.conversations (taken_over_by) where taken_over_by is not null;
create index messages_sent_by_teammate_id_idx on app.messages (sent_by_teammate_id) where sent_by_teammate_id is not null;
create index messages_ai_run_id_idx on app.messages (ai_run_id) where ai_run_id is not null;
create index messages_ai_draft_id_idx on app.messages (ai_draft_id) where ai_draft_id is not null;
create index messages_approved_by_idx on app.messages (approved_by) where approved_by is not null;

-- ---------- 0032 · runs, tool calls, drafts and AI usage ----------
create index ai_teammate_runs_teammate_id_idx on app.ai_teammate_runs (teammate_id);
create index ai_teammate_runs_conversation_id_idx on app.ai_teammate_runs (conversation_id);
create index ai_teammate_runs_person_id_idx on app.ai_teammate_runs (person_id);
create index ai_teammate_runs_lead_id_idx on app.ai_teammate_runs (lead_id);
create index ai_teammate_tool_calls_workspace_id_idx on app.ai_teammate_tool_calls (workspace_id);
create index ai_teammate_drafts_workspace_id_idx on app.ai_teammate_drafts (workspace_id);
create index ai_teammate_drafts_teammate_id_idx on app.ai_teammate_drafts (teammate_id);
create index ai_teammate_drafts_run_id_idx on app.ai_teammate_drafts (run_id);
create index ai_teammate_drafts_conversation_id_idx on app.ai_teammate_drafts (conversation_id);
create index ai_teammate_drafts_person_id_idx on app.ai_teammate_drafts (person_id);
create index ai_teammate_drafts_lead_id_idx on app.ai_teammate_drafts (lead_id);
create index ai_teammate_drafts_decided_by_idx on app.ai_teammate_drafts (decided_by);
create index ai_usage_teammate_id_idx on app.ai_usage (teammate_id) where teammate_id is not null;
create index ai_usage_teammate_run_id_idx on app.ai_usage (teammate_run_id) where teammate_run_id is not null;

-- ---------- 0033 · website chat ----------
create index chat_widgets_workspace_id_idx on app.chat_widgets (workspace_id);
create index chat_widgets_teammate_id_idx on app.chat_widgets (teammate_id);
create index chat_widgets_created_by_idx on app.chat_widgets (created_by);
create index chat_visitors_workspace_id_idx on app.chat_visitors (workspace_id);
create index chat_visitors_widget_id_idx on app.chat_visitors (widget_id);
create index chat_visitors_person_id_idx on app.chat_visitors (person_id);
create index chat_signals_workspace_id_idx on app.chat_signals (workspace_id);
