-- =============================================================================
-- The AI teammate's drafts follow their thread (SEC-M2).
--
--        0083 narrowed the four inbox tables and left app.ai_teammate_drafts
--        on `inbox.use` alone. So a member the business had narrowed to their
--        own threads still read every pending reply the teammate wrote — the
--        whole text, the customer and the conversation — and could approve
--        one on a thread they cannot open, with their own words as the edit.
--        The "customer wrote again" check reads messages, which RLS hides from
--        them, so it passed, and the reply went out as the business.
--
--        A draft is the fifth thing that belongs to a thread, and it is done
--        exactly the way 0083 did the other four rather than a second way:
--
--          the stored list  member_viewer_ids, copied from the conversation
--                           by the same trigger messages and calls use, and
--                           carried along when the thread's list moves
--          two policies     the wide one and the member arm, disjoint on
--                           private.inbox_narrowed()
--          the phone        business_v1 reads it from `inbox`, me_v1 from the
--                           list (apps/sync/sync-config.yaml)
--
--        A draft with no thread yet (a first message to a new lead) gets the
--        everybody list, like a call with no thread: it is not inbox business
--        until it starts one. Off by default, and off is today's behaviour: the
--        list is empty and the wide arm is the policy that was already here.
-- =============================================================================

alter table app.ai_teammate_drafts add column member_viewer_ids uuid[] not null default '{}';

comment on column app.ai_teammate_drafts.member_viewer_ids is
  'The members who may see this draft while the business narrows its inbox: its conversation''s list (0083). '
  'Empty means the business has not turned narrowing on. Kept by triggers; a value sent by a caller is replaced.';

create trigger ai_teammate_drafts_member_viewers before insert or update of conversation_id, member_viewer_ids
  on app.ai_teammate_drafts for each row execute function private.inbox_child_viewers();

-- 0083's, with drafts carried along beside messages, calls and attention items.
create or replace function private.inbox_propagate_viewers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from changed c join prior p on p.id = c.id
    where c.member_viewer_ids is distinct from p.member_viewer_ids
  ) then
    return null;
  end if;
  update app.messages m set member_viewer_ids = c.member_viewer_ids
  from changed c where m.conversation_id = c.id and m.member_viewer_ids is distinct from c.member_viewer_ids;
  update app.calls k set member_viewer_ids = c.member_viewer_ids
  from changed c where k.conversation_id = c.id and k.member_viewer_ids is distinct from c.member_viewer_ids;
  update app.attention_items a set member_viewer_ids = c.member_viewer_ids
  from changed c where a.conversation_id = c.id and a.member_viewer_ids is distinct from c.member_viewer_ids;
  update app.ai_teammate_drafts d set member_viewer_ids = c.member_viewer_ids
  from changed c where d.conversation_id = c.id and d.member_viewer_ids is distinct from c.member_viewer_ids;
  return null;
end $$;

-- 20261006000400's (a customer's owner and team see its threads), with the drafts that have no thread of their
-- own beside the calls and items that have none.
create or replace function private.inbox_repaint_workspace(p_ws uuid, p_max integer default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_touched integer;
begin
  if p_max is not null then
    select count(*) into v_count from app.conversations c where c.workspace_id = p_ws;
    if v_count > p_max then
      raise exception 'Too many conversations to change this in one go (%). Ask HandsFreeOS to run it.', v_count
        using errcode = '55000', detail = 'inbox_repaint_too_large';
    end if;
  end if;
  update app.conversations c
  set member_viewer_ids =
    private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id, c.person_id)
  where c.workspace_id = p_ws
    and c.member_viewer_ids is distinct from
        private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id, c.person_id);
  get diagnostics v_touched = row_count;
  update app.calls k set member_viewer_ids = private.inbox_member_viewers(k.workspace_id, null, null, null)
  where k.workspace_id = p_ws and k.conversation_id is null
    and k.member_viewer_ids is distinct from private.inbox_member_viewers(k.workspace_id, null, null, null);
  update app.attention_items a set member_viewer_ids = private.inbox_member_viewers(a.workspace_id, null, null, null)
  where a.workspace_id = p_ws and a.conversation_id is null
    and a.member_viewer_ids is distinct from private.inbox_member_viewers(a.workspace_id, null, null, null);
  update app.ai_teammate_drafts d set member_viewer_ids = private.inbox_member_viewers(d.workspace_id, null, null, null)
  where d.workspace_id = p_ws and d.conversation_id is null
    and d.member_viewer_ids is distinct from private.inbox_member_viewers(d.workspace_id, null, null, null);
  return v_touched;
end $$;

-- The drafts of businesses that have already narrowed their inbox. The trigger decides the value (the
-- conversation's list, or everybody's for a draft with no thread); naming the column is what sets it going.
update app.ai_teammate_drafts d set member_viewer_ids = d.member_viewer_ids
where private.inbox_per_person(d.workspace_id);

create index if not exists ai_teammate_drafts_member_viewer_ids_idx
  on app.ai_teammate_drafts using gin (member_viewer_ids);

-- ---------- who reads and decides what ----------
drop policy if exists ai_teammate_drafts_select on app.ai_teammate_drafts;
create policy ai_teammate_drafts_select on app.ai_teammate_drafts for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and not private.inbox_narrowed(workspace_id));
drop policy if exists ai_teammate_drafts_member_select on app.ai_teammate_drafts;
create policy ai_teammate_drafts_member_select on app.ai_teammate_drafts for select to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and private.inbox_narrowed(workspace_id)
    and member_viewer_ids @> array[(select auth.uid())]);

-- 20261008000100's, and a draft is decided only by somebody who may see it.
drop policy if exists ai_teammate_drafts_update on app.ai_teammate_drafts;
create policy ai_teammate_drafts_update on app.ai_teammate_drafts for update to authenticated
  using (status = 'pending'
    and private.has_permission(workspace_id, case when kind in ('reply', 'call') then 'inbox.use' else 'ai_team.manage' end)
    and (not private.inbox_narrowed(workspace_id) or member_viewer_ids @> array[(select auth.uid())]))
  with check (status in ('approved', 'rejected', 'cancelled') and decided_by = (select auth.uid())
    and via in ('web', 'assistant', 'mobile')
    and private.has_permission(workspace_id, case when kind in ('reply', 'call') then 'inbox.use' else 'ai_team.manage' end));
