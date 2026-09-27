-- =============================================================================
-- What the worker read out of a thread follows the thread (SEC-M15).
--
--        Three tables hold words taken from a conversation, and none of them
--        heard about 0083's narrowed inbox:
--
--          app.ai_calls    the AI's own phone calls: how each went, in a
--                          summary (campaign.get shows it for every recipient)
--          app.promises    what someone told a customer they'd do, read from
--                          their texts, emails and call transcripts
--          app.referrals   the customer's own words about somebody they know,
--                          with that person's name, phone and email
--
--        So a member narrowed to their own threads read, on the campaign page
--        and on Home, what was said on threads the inbox hides from them.
--
--        Each now reads as the thread it came from reads — the wide arm and the
--        member arm, disjoint on private.inbox_narrowed(), as 0083 does it. An AI
--        call follows the call it placed (app.calls keeps a thread's list, and
--        everybody's for a call with none); a promise and a referral follow
--        their conversation. One not placed yet, or with no conversation, is not
--        narrowed to anyone. The customer and their timeline stay as 0083 left
--        them: this is about what was said on a thread, not who the customer is.
--
--        Off by default, and off is today's behaviour: the wide arm is the
--        policy that was already here.
-- =============================================================================

drop policy if exists ai_calls_select on app.ai_calls;
create policy ai_calls_select on app.ai_calls for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and not private.inbox_narrowed(workspace_id));
drop policy if exists ai_calls_member_select on app.ai_calls;
create policy ai_calls_member_select on app.ai_calls for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and private.inbox_narrowed(workspace_id)
    and (call_id is null or exists (
      select 1 from app.calls k
      where k.id = ai_calls.call_id and k.member_viewer_ids @> array[(select auth.uid())])));

drop policy if exists promises_select on app.promises;
create policy promises_select on app.promises for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and not private.inbox_narrowed(workspace_id));
drop policy if exists promises_member_select on app.promises;
create policy promises_member_select on app.promises for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and private.inbox_narrowed(workspace_id)
    and (conversation_id is null or exists (
      select 1 from app.conversations c
      where c.id = promises.conversation_id and c.member_viewer_ids @> array[(select auth.uid())])));

drop policy if exists referrals_select on app.referrals;
create policy referrals_select on app.referrals for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and not private.inbox_narrowed(workspace_id));
drop policy if exists referrals_member_select on app.referrals;
create policy referrals_member_select on app.referrals for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and private.inbox_narrowed(workspace_id)
    and (conversation_id is null or exists (
      select 1 from app.conversations c
      where c.id = referrals.conversation_id and c.member_viewer_ids @> array[(select auth.uid())])));
