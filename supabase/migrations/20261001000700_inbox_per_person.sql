-- =============================================================================
-- 0083 · A member sees their own threads, if the business asks for it (M17).
--
--        **Off by default, and off is today's behaviour byte for byte.** The
--        switch is one boolean in app.workspaces.settings under 'inbox'. Until
--        a business turns it on, private.inbox_narrowed() is false for
--        everyone, every member_viewer_ids list is empty, every
--        workspace_access row says sees_whole_inbox, and the SELECT policies
--        below are the ones that were already there.
--
--        **Copied from the money precedent on purpose** (0050 and 0056), which
--        solved this exact problem — a member sees a subset and the phone
--        agrees — rather than inventing a second way to do it:
--
--          the rule         a `security definer` function, so the answer does
--                           not depend on what the caller can already see
--          the stored list  member_viewer_ids, kept by triggers, never taken
--                           from a caller
--          two policies     the wide one and the member arm, each saying which
--                           case it is for rather than leaving it to the order
--                           permissive policies happen to be OR-ed in
--          the parity test  private.sync_inbox_mismatches(), the twin of
--                           private.sync_viewer_mismatches(): empty means the
--                           stored lists and the policies agree
--
--        **The list is the complete answer whenever the switch is on, and
--        empty whenever it is off.** "Nobody in particular owns this thread" is
--        written as *everybody owns it* rather than as an empty list. That
--        costs a few uuids a row and buys the only property of this migration
--        that really matters: the policy and the sync query are the same plain
--        membership test, with no special case in either to drift out of step.
--        A phone that syncs a thread the web hides is a leak; a phone that
--        drops one the web shows looks like data loss.
--
--        **app.workspace_access.sees_whole_inbox** is the other half of that.
--        PowerSync decides a bucket from a parameter query, and this file's own
--        rule is that who sees what comes only from rows the database keeps
--        equal to RLS. workspace_access is already such a row — the money
--        stream reads `role <> 'member'` off it — so the inbox reads one more
--        column off the same row rather than teaching the sync config to read
--        a JSON setting.
--
--        **app.activities deliberately does not follow.** Narrowing the
--        customer timeline is a different question about a different screen,
--        and folding it in here is how this piece stops shipping. A member who
--        can open a customer still sees that customer's history; what they stop
--        seeing is the inbox thread.
--
--        **channels.manage is the sees-everything test** rather than a new
--        `inbox.see_all` permission: owners and admins hold it, members do not,
--        and packages/core/src/permissions.ts and app.role_permissions stay
--        untouched, so the parity test between those two is unaffected.
-- =============================================================================

alter table app.conversations add column member_viewer_ids uuid[] not null default '{}';
alter table app.messages add column member_viewer_ids uuid[] not null default '{}';
alter table app.calls add column member_viewer_ids uuid[] not null default '{}';
alter table app.attention_items add column member_viewer_ids uuid[] not null default '{}';
alter table app.workspace_access add column sees_whole_inbox boolean not null default true;

comment on column app.conversations.member_viewer_ids is
  'The members who may see this thread while the business narrows its inbox (0083). Empty means the business '
  'has not turned narrowing on, and everybody with the inbox sees everything. Kept by triggers; a value sent '
  'by a caller is replaced.';
comment on column app.workspace_access.sees_whole_inbox is
  'Whether this person sees every thread in this business (0083): true for everyone until the business narrows '
  'its inbox, and true for owners and admins always. What the business_v1 `inbox` sync parameter reads.';

-- ---------- the switch ----------
create or replace function private.inbox_per_person(p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (w.settings -> 'inbox' ->> 'perPerson')::boolean from app.workspaces w where w.id = p_ws),
    false)
$$;

-- Whether *this* person sees only their own threads here. False for everybody until a business opts in, and
-- false for owners and admins always — they hold channels.manage, which is what "sees the whole inbox" means.
create or replace function private.inbox_narrowed(p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.inbox_per_person(p_ws) and not private.has_permission(p_ws, 'channels.manage')
$$;

-- Everyone in this business whose role may work the inbox and may not manage channels: exactly the people the
-- member policies below cover. Said once, because a list that disagreed with the policy is the bug this whole
-- migration is arranged to make impossible.
create or replace function private.inbox_eligible_members(p_ws uuid)
returns table (user_id uuid) language sql stable security definer set search_path = '' as $$
  select wa.user_id from app.workspace_access wa
  where wa.workspace_id = p_ws
    and exists (select 1 from app.role_permissions rp
                where rp.role = wa.role::text and rp.permission = 'inbox.use')
    and not exists (select 1 from app.role_permissions rp
                    where rp.role = wa.role::text and rp.permission = 'channels.manage')
$$;

-- ---------- the rule ----------
-- Who may see one thread. Two arms, and then the fallback that is the whole safety story:
--
--   the assignee          whoever the thread is on, if their role is a member's
--   the number's people   whoever the number it came in on rings (0079's app.phone_number_members)
--   nobody named          everybody with the inbox — because a customer writing in for the first time belongs
--                         to nobody yet, and a thread nobody can see is a lost customer
--
-- Called with two nulls it is the third arm alone, which is what a call or an attention item with no thread
-- gets: not narrowed to anyone, and still written down as a list so that the policy and the sync query can
-- both be a plain membership test.
create or replace function private.inbox_member_viewers(p_ws uuid, p_assignee uuid, p_number uuid)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  -- Checked first and on its own: while the business has not opted in this must cost one index probe, because
  -- it runs on the busiest table in the product.
  if not private.inbox_per_person(p_ws) then
    return '{}'::uuid[];
  end if;
  select array_agg(distinct o.user_id order by o.user_id) into v_ids
  from (
    select e.user_id from private.inbox_eligible_members(p_ws) e where e.user_id = p_assignee
    union
    select e.user_id from private.inbox_eligible_members(p_ws) e
    join app.phone_number_members m on m.user_id = e.user_id
    where m.phone_number_id = p_number and m.workspace_id = p_ws
  ) o;
  if v_ids is not null then
    return v_ids;
  end if;
  select coalesce(array_agg(distinct e.user_id order by e.user_id), '{}'::uuid[]) into v_ids
  from private.inbox_eligible_members(p_ws) e;
  return v_ids;
end $$;

-- ---------- keeping the lists ----------
-- On every write of a conversation, recomputed — never taken from the caller. Recomputed only when something
-- it depends on moved, because this fires on unread counts and last_message_at too.
create or replace function private.inbox_conversation_viewers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and old.assignee_user_id is not distinct from new.assignee_user_id
     and old.phone_number_id is not distinct from new.phone_number_id then
    new.member_viewer_ids := old.member_viewer_ids;
    return new;
  end if;
  new.member_viewer_ids :=
    private.inbox_member_viewers(new.workspace_id, new.assignee_user_id, new.phone_number_id);
  return new;
end $$;
create trigger conversations_member_viewers before insert or update on app.conversations
  for each row execute function private.inbox_conversation_viewers();

-- Messages, calls and attention items follow their thread, or the content leaks around the policy on the
-- thread. One with no thread is not inbox business and gets the everybody list, so it stays exactly as visible
-- as it is today whichever policy arm reads it.
create or replace function private.inbox_child_viewers()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  if new.conversation_id is null then
    new.member_viewer_ids := private.inbox_member_viewers(new.workspace_id, null, null);
    return new;
  end if;
  select c.member_viewer_ids into v_ids from app.conversations c where c.id = new.conversation_id;
  new.member_viewer_ids := coalesce(v_ids, '{}'::uuid[]);
  return new;
end $$;
create trigger messages_member_viewers before insert or update of conversation_id, member_viewer_ids
  on app.messages for each row execute function private.inbox_child_viewers();
create trigger calls_member_viewers before insert or update of conversation_id, member_viewer_ids
  on app.calls for each row execute function private.inbox_child_viewers();
create trigger attention_items_member_viewers before insert or update of conversation_id, member_viewer_ids
  on app.attention_items for each row execute function private.inbox_child_viewers();

-- A thread's list moving reaches its messages, calls and items.
--
-- **Statement level, with transition tables**, unlike money's row-level twin. Money's documents are written a
-- few at a time; conversations are written constantly, and turning the switch on rewrites every one of them at
-- once. Row by row that would be one child update per conversation; this way it is three, whether one thread
-- was reassigned or forty thousand were repainted. The `exists` first is what keeps the ordinary single-row
-- write — an unread count, a preview — from paying for three joins it has no work for.
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
  return null;
end $$;
create trigger conversations_propagate_viewers after update on app.conversations
  referencing old table as prior new table as changed
  for each statement execute function private.inbox_propagate_viewers();

-- ---------- what the phone reads ----------
-- Whoever writes an access row, and whatever they send, this is the answer. app.workspace_access is rewritten
-- by private.refresh_workspace_access() from the memberships; keeping the column here rather than there means
-- that function stays exactly as it was and this can never be forgotten in a later edit of it.
create or replace function private.inbox_access_flag()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.sees_whole_inbox :=
    not private.inbox_per_person(new.workspace_id)
    or exists (select 1 from app.role_permissions rp
               where rp.role = new.role::text and rp.permission = 'channels.manage');
  return new;
end $$;
create trigger workspace_access_inbox_flag before insert or update on app.workspace_access
  for each row execute function private.inbox_access_flag();

-- ---------- what moves a list ----------
create or replace function private.inbox_repaint_workspace(p_ws uuid, p_max integer default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_touched integer;
begin
  -- The one place this piece can time out in production, so the switch passes a ceiling and says plainly that
  -- it cannot be flipped in one go — which beats a request that hangs and then rolls the whole thing back. The
  -- triggers below pass nothing: a role change must not fail because a business is large.
  if p_max is not null then
    select count(*) into v_count from app.conversations c where c.workspace_id = p_ws;
    if v_count > p_max then
      raise exception 'Too many conversations to change this in one go (%). Ask HandsFreeOS to run it.', v_count
        using errcode = '55000', detail = 'inbox_repaint_too_large';
    end if;
  end if;
  update app.conversations c
  set member_viewer_ids = private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id)
  where c.workspace_id = p_ws
    and c.member_viewer_ids is distinct from
        private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id);
  get diagnostics v_touched = row_count;
  -- The ones with no thread of their own; the statement above carried the rest through the propagate trigger.
  update app.calls k set member_viewer_ids = private.inbox_member_viewers(k.workspace_id, null, null)
  where k.workspace_id = p_ws and k.conversation_id is null
    and k.member_viewer_ids is distinct from private.inbox_member_viewers(k.workspace_id, null, null);
  update app.attention_items a set member_viewer_ids = private.inbox_member_viewers(a.workspace_id, null, null)
  where a.workspace_id = p_ws and a.conversation_id is null
    and a.member_viewer_ids is distinct from private.inbox_member_viewers(a.workspace_id, null, null);
  return v_touched;
end $$;

-- Every person's access row in one business, recomputed. Separate from the repaint above so neither can set
-- the other going: the access trigger repaints threads, and this is called only when the switch itself moves.
create or replace function private.inbox_repaint_access(p_ws uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_touched integer;
begin
  -- Said twice rather than leaning on the BEFORE trigger to work it out, because a repaint that wrote the
  -- wrong value and was quietly corrected would still have written every row in the business.
  update app.workspace_access wa
  set sees_whole_inbox = (
    not private.inbox_per_person(p_ws)
    or exists (select 1 from app.role_permissions rp
               where rp.role = wa.role::text and rp.permission = 'channels.manage'))
  where wa.workspace_id = p_ws
    and wa.sees_whole_inbox is distinct from (
      not private.inbox_per_person(p_ws)
      or exists (select 1 from app.role_permissions rp
                 where rp.role = wa.role::text and rp.permission = 'channels.manage'));
  get diagnostics v_touched = row_count;
  return v_touched;
end $$;

-- ---------- the switch itself, whoever moves it ----------
-- The repaint used to live only in the `inbox.set_visibility` command. That was not enough: the Assistant's
-- settings tools write app.workspaces.settings too, and so does a support fix. Flipping the switch that way
-- left every viewer list and every `sees_whole_inbox` untouched — the business is told its team sees only
-- their own threads while the database still shows them everything. A promise about who can read a
-- customer's messages cannot depend on which code path happened to move the flag.
--
-- So the database does it. The command keeps its own ceiling check, which it now runs *before* writing, so a
-- business too large to do in one go is refused with something readable instead of a statement timeout.
--
-- The condition compares the stored text rather than casting to boolean: a WHEN clause that raised on a
-- malformed setting would block the settings write itself, which is a worse failure than one extra repaint.
create or replace function private.inbox_switch_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Access rows first, for the reason the command gives: no phone is briefly told it sees everything while
  -- the lists already say otherwise.
  perform private.inbox_repaint_access(new.id);
  perform private.inbox_repaint_workspace(new.id);
  return null;
end $$;

create trigger workspaces_inbox_switch after update of settings on app.workspaces
  for each row
  when (old.settings -> 'inbox' ->> 'perPerson' is distinct from new.settings -> 'inbox' ->> 'perPerson')
  execute function private.inbox_switch_changed();

-- A person's role in a business changed, or their access began or ended: every thread whose list they are, or
-- could now be, part of. A no-op, and one index probe, while the business has not opted in.
create or replace function private.inbox_viewers_access_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
begin
  if not private.inbox_per_person(v_ws) then
    return null;
  end if;
  perform private.inbox_repaint_workspace(v_ws);
  return null;
end $$;
create trigger workspace_access_inbox_viewers after insert or delete on app.workspace_access
  for each row execute function private.inbox_viewers_access_changed();
create trigger workspace_access_inbox_viewers_changed after update on app.workspace_access for each row
  when (old.role is distinct from new.role)
  execute function private.inbox_viewers_access_changed();

-- The people a number rings changed: the threads on that number.
create or replace function private.inbox_viewers_number_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
  v_number uuid := coalesce(new.phone_number_id, old.phone_number_id);
begin
  if not private.inbox_per_person(v_ws) then
    return null;
  end if;
  update app.conversations c
  set member_viewer_ids = private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id)
  where c.workspace_id = v_ws and c.phone_number_id = v_number
    and c.member_viewer_ids is distinct from
        private.inbox_member_viewers(c.workspace_id, c.assignee_user_id, c.phone_number_id);
  return null;
end $$;
create trigger phone_number_members_inbox_viewers after insert or delete on app.phone_number_members
  for each row execute function private.inbox_viewers_number_changed();

-- "Which threads is Marco on", for the repaints above and for the member policies below.
create index conversations_member_viewer_ids_idx on app.conversations using gin (member_viewer_ids);
create index messages_member_viewer_ids_idx on app.messages using gin (member_viewer_ids);
create index calls_member_viewer_ids_idx on app.calls using gin (member_viewer_ids);
create index attention_items_member_viewer_ids_idx on app.attention_items using gin (member_viewer_ids);

-- ---------- who reads what ----------
-- The wide policy gains one clause and is otherwise the one that was already there; the member arm is new.
-- Saying "this is the narrowed case" in the member arm, rather than relying on the OR, keeps the lookup off
-- every row an owner reads — exactly as 0050 argued for money. The two arms are exhaustive and disjoint on
-- private.inbox_narrowed(), which is what makes them equivalent to the single sync parameter beside them.
drop policy conversations_select on app.conversations;
create policy conversations_select on app.conversations for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and not private.inbox_narrowed(workspace_id));
create policy conversations_member_select on app.conversations for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and private.inbox_narrowed(workspace_id)
    and member_viewer_ids @> array[(select auth.uid())]);

drop policy messages_select on app.messages;
create policy messages_select on app.messages for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and not private.inbox_narrowed(workspace_id));
create policy messages_member_select on app.messages for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and private.inbox_narrowed(workspace_id)
    and member_viewer_ids @> array[(select auth.uid())]);

drop policy calls_select on app.calls;
create policy calls_select on app.calls for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and not private.inbox_narrowed(workspace_id));
create policy calls_member_select on app.calls for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and private.inbox_narrowed(workspace_id)
    and member_viewer_ids @> array[(select auth.uid())]);

drop policy attention_items_select on app.attention_items;
create policy attention_items_select on app.attention_items for select to authenticated
  using (private.has_permission(workspace_id, 'records.read')
    and not private.inbox_narrowed(workspace_id));
create policy attention_items_member_select on app.attention_items for select to authenticated
  using (private.has_permission(workspace_id, 'records.read')
    and private.inbox_narrowed(workspace_id)
    and member_viewer_ids @> array[(select auth.uid())]);

-- ---------- function privileges ----------
revoke all on function
  private.inbox_per_person(uuid), private.inbox_narrowed(uuid),
  private.inbox_member_viewers(uuid, uuid, uuid), private.inbox_eligible_members(uuid),
  private.inbox_conversation_viewers(), private.inbox_child_viewers(),
  private.inbox_propagate_viewers(), private.inbox_access_flag(),
  private.inbox_repaint_workspace(uuid, integer), private.inbox_repaint_access(uuid),
  private.inbox_viewers_access_changed(), private.inbox_viewers_number_changed(),
  private.inbox_switch_changed()
  from public;
-- Only the two the policies name are reachable by a person; the rest belong to the triggers and the command.
grant execute on function private.inbox_per_person(uuid), private.inbox_narrowed(uuid)
  to authenticated, service_actor;
grant execute on function private.inbox_member_viewers(uuid, uuid, uuid),
  private.inbox_eligible_members(uuid), private.inbox_repaint_workspace(uuid, integer),
  private.inbox_repaint_access(uuid)
  to service_actor;
