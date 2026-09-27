-- =============================================================================
-- Whether the inbox is narrowed here, asked once per query rather than twice
-- per row (PERF-M24).
--
--        0083's policies asked private.inbox_narrowed(workspace_id) on every
--        row, in both arms. It takes the row's business, so Postgres can't
--        work it out once, and it is security definer, so it is never inlined:
--        three function frames and an index probe per row per arm, on the
--        busiest tables in the product, whether or not the business ever
--        turned narrowing on.
--
--        The question turned round: *which* of the businesses this person can
--        open are narrowed for them, and which are not. That takes nothing
--        from the row, so each policy reads it once and each row is a lookup.
--        The businesses are the same list each policy already started from,
--        split by the same private.inbox_narrowed(), so the two arms stay
--        exhaustive and disjoint exactly as 0083 set them out, and
--        private.sync_inbox_mismatches() — which runs the member arm out of
--        pg_policies — checks the new text the same way it checked the old.
-- =============================================================================

drop policy if exists conversations_select on app.conversations;
create policy conversations_select on app.conversations for select to authenticated
  using (workspace_id in (select a.id from private.accessible_workspace_ids() a (id)
                          where not private.inbox_narrowed(a.id)));
drop policy if exists conversations_member_select on app.conversations;
create policy conversations_member_select on app.conversations for select to authenticated
  using (workspace_id in (select a.id from private.accessible_workspace_ids() a (id)
                          where private.inbox_narrowed(a.id))
    and member_viewer_ids @> array[(select auth.uid())]);

drop policy if exists messages_select on app.messages;
create policy messages_select on app.messages for select to authenticated
  using (workspace_id in (select a.id from private.accessible_workspace_ids() a (id)
                          where not private.inbox_narrowed(a.id)));
drop policy if exists messages_member_select on app.messages;
create policy messages_member_select on app.messages for select to authenticated
  using (workspace_id in (select a.id from private.accessible_workspace_ids() a (id)
                          where private.inbox_narrowed(a.id))
    and member_viewer_ids @> array[(select auth.uid())]);

drop policy if exists calls_select on app.calls;
create policy calls_select on app.calls for select to authenticated
  using (workspace_id in (select a.id from private.accessible_workspace_ids() a (id)
                          where not private.inbox_narrowed(a.id)));
drop policy if exists calls_member_select on app.calls;
create policy calls_member_select on app.calls for select to authenticated
  using (workspace_id in (select a.id from private.accessible_workspace_ids() a (id)
                          where private.inbox_narrowed(a.id))
    and member_viewer_ids @> array[(select auth.uid())]);

-- Attention items start from records.read rather than from every business the person can open, as before.
-- private.workspaces_with_permission() is private.has_permission() as a set (PERF-M6).
drop policy if exists attention_items_select on app.attention_items;
create policy attention_items_select on app.attention_items for select to authenticated
  using (workspace_id in (select p.id from private.workspaces_with_permission('records.read') p (id)
                          where not private.inbox_narrowed(p.id)));
drop policy if exists attention_items_member_select on app.attention_items;
create policy attention_items_member_select on app.attention_items for select to authenticated
  using (workspace_id in (select p.id from private.workspaces_with_permission('records.read') p (id)
                          where private.inbox_narrowed(p.id))
    and member_viewer_ids @> array[(select auth.uid())]);
