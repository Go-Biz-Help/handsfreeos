-- =============================================================================
-- What the AI teammate did is inbox business, and follows its thread (SEC-M14).
--
--        app.ai_teammate_runs and app.ai_teammate_tool_calls were readable by
--        everyone who can open the business, and ai_teammate.activity asked
--        only for workspace.read. A run carries the reply the teammate wrote,
--        its summary and the customer; a tool call carries the words it read
--        and wrote. So a person the business had taken the inbox away from, or
--        narrowed to their own threads (0083), read every conversation the AI
--        handled from the Activity tab.
--
--        Now a run is read by the people who work the inbox, and while the
--        business narrows its inbox, only on the threads they may see — the
--        wide arm and the member arm, disjoint on private.inbox_narrowed(), as
--        0083 does it. A run with no thread (a first message to a new lead, a
--        test) is not narrowed to anyone. A tool call follows its run.
--
--        Only people read these through RLS: the worker has its own policy, and
--        nothing syncs them to a phone.
-- =============================================================================

drop policy if exists ai_teammate_runs_select on app.ai_teammate_runs;
create policy ai_teammate_runs_select on app.ai_teammate_runs for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and not private.inbox_narrowed(workspace_id));
drop policy if exists ai_teammate_runs_member_select on app.ai_teammate_runs;
create policy ai_teammate_runs_member_select on app.ai_teammate_runs for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and private.inbox_narrowed(workspace_id)
    and (conversation_id is null or exists (
      select 1 from app.conversations c
      where c.id = ai_teammate_runs.conversation_id and c.member_viewer_ids @> array[(select auth.uid())])));

drop policy if exists ai_teammate_tool_calls_select on app.ai_teammate_tool_calls;
create policy ai_teammate_tool_calls_select on app.ai_teammate_tool_calls for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and not private.inbox_narrowed(workspace_id));
-- Its run, as this person may read it: the runs policy above decides.
drop policy if exists ai_teammate_tool_calls_member_select on app.ai_teammate_tool_calls;
create policy ai_teammate_tool_calls_member_select on app.ai_teammate_tool_calls for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and private.inbox_narrowed(workspace_id)
    and exists (select 1 from app.ai_teammate_runs r where r.id = ai_teammate_tool_calls.run_id));
