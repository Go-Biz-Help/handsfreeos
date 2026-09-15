-- =============================================================================
-- 0043 · The Action Center: grants and foreign-key indexes. People read the
--        attention list and change only the columns their commands write
--        (state, snooze, dismissal, assignee, handling, and cancelling a
--        waiting automatic action); the guard in 0039 holds the line on the
--        values. The worker adds, updates and removes items. leads keep the
--        grants they had (0040's guard protects their new columns), and the
--        attendee confirmation grant is in 0041, next to its guard. Every
--        foreign key 0039-0041 added gets an index that leads with its column
--        (0020's rule); they are empty on most rows, so the indexes are
--        partial, over the rows that have one.
-- =============================================================================

-- ---------- grants: people ----------
grant select on app.attention_items to authenticated;
grant update (state, assignee_user_id, snoozed_until, snoozed_at, snoozed_by, dismissed_at, dismissed_by, dismiss_reason,
  handled_at, handled_by, handled_via, auto_state, auto_done_at, auto_cancelled_by)
  on app.attention_items to authenticated;

-- ---------- grants: the worker ----------
grant select, insert, update, delete on app.attention_items to service_actor;
revoke all on app.attention_items from anon;

-- ---------- 0039 · attention items ----------
create index attention_items_person_id_idx on app.attention_items (person_id) where person_id is not null;
create index attention_items_lead_id_idx on app.attention_items (lead_id) where lead_id is not null;
create index attention_items_conversation_id_idx on app.attention_items (conversation_id) where conversation_id is not null;
create index attention_items_assignee_user_id_idx on app.attention_items (assignee_user_id) where assignee_user_id is not null;
create index attention_items_snoozed_by_idx on app.attention_items (snoozed_by) where snoozed_by is not null;
create index attention_items_dismissed_by_idx on app.attention_items (dismissed_by) where dismissed_by is not null;
create index attention_items_handled_by_idx on app.attention_items (handled_by) where handled_by is not null;
create index attention_items_auto_cancelled_by_idx on app.attention_items (auto_cancelled_by)
  where auto_cancelled_by is not null;

-- ---------- 0041 · attendee confirmation ----------
create index appointment_attendees_confirmed_by_idx on app.appointment_attendees (confirmed_by)
  where confirmed_by is not null;
