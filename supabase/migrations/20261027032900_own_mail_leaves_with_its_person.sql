-- =============================================================================
-- A person's own mail stops reaching their phone when they leave (CS2).
--
--        A private thread's viewer list was its person, always
--        (20261013001200): `member_viewer_ids := array[private_to]`, whether
--        or not they still worked there. RLS was right about it (the private
--        arm asks for a business the person can open), but the phone's me_v1
--        stream reads the list alone, past RLS. So someone removed from a
--        business kept syncing their old mailbox there, threads and message
--        bodies, until an owner reassigned the address, which may be never.
--        The design says that mail "stays unread by anyone" meanwhile.
--
--        Now the list is its person only while they work there, and empty
--        otherwise. Their access row coming or going recomputes their private
--        threads in that business, and 0083's statement trigger carries the
--        list on to the messages, calls, attention items and drafts, so
--        PowerSync takes them off the phone. If they come back, and the
--        address is still theirs, the mail syncs to them again. An owner still
--        can't read it either way: the wide arms ask for `private_to is null`.
--
--        **Agreeing with the repaint.** 20261012070600 repaints a narrowed
--        business's threads when anyone's access changes, and its update
--        reaches private threads too. Both writes go through
--        private.private_thread_viewers, the last BEFORE trigger to touch a
--        private thread's list, so both land on the same answer; this one
--        runs at commit as the repaint does, after it by name, and finds
--        nothing left to change in a business the repaint already did.
--
--        Every row it changes syncs again: only the departed person's own
--        threads and what hangs off them.
-- =============================================================================

-- ---------- the list ----------
-- 20261013001200's, with its person named only while they work here.
create or replace function private.private_thread_viewers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.private_to is not null then
    new.member_viewer_ids := case when private.works_in(new.private_to, new.workspace_id)
      then array[new.private_to] else '{}'::uuid[] end;
  elsif tg_op = 'UPDATE' and old.private_to is not null then
    new.member_viewer_ids :=
      private.inbox_member_viewers(new.workspace_id, new.assignee_user_id, new.phone_number_id, new.person_id);
  end if;
  return new;
end $$;

-- ---------- their access coming or going ----------
-- "Which threads are private to Chris here", for the trigger below. Small: only private threads are in it.
create index if not exists conversations_private_to_idx on app.conversations (private_to, workspace_id)
  where private_to is not null;

-- At commit, from the finished access rows, as the repaint does: someone moved from one role to another in the
-- same transaction never drops off. Only the threads whose list is wrong are written.
create or replace function private.private_mail_follows_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
  v_viewers uuid[];
begin
  v_viewers := case when private.works_in(v_user, v_ws) then array[v_user] else '{}'::uuid[] end;
  update app.conversations c set member_viewer_ids = v_viewers
  where c.private_to = v_user and c.workspace_id = v_ws
    and c.member_viewer_ids is distinct from v_viewers;
  return null;
end $$;

create constraint trigger workspace_access_private_mail after insert or delete on app.workspace_access
  deferrable initially deferred
  for each row execute function private.private_mail_follows_access();

revoke all on function private.private_mail_follows_access() from public;

-- ---------- every list as it stands today ----------
-- The private threads of people who have already left. The trigger decides the value; messages and the rest follow.
update app.conversations c set member_viewer_ids = '{}'
where c.private_to is not null and c.member_viewer_ids <> '{}'
  and not private.works_in(c.private_to, c.workspace_id);

-- ---------- the parity check ----------
-- 20261012020600's, and one more question, asked of everyone rather than of the people in narrowed businesses:
-- is anybody on a list in a business they can't open? me_v1 reads the list alone, so a name left on it is a phone
-- still being sent the row (someone who has left, with their own mail). Such a row is listed and not visible.
create or replace function private.sync_inbox_mismatches(p_workspace uuid default null)
returns table (table_name text, row_id uuid, user_id uuid, listed boolean, visible boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_person record;
  v_policy record;
  v_table text;
  v_narrowed uuid[];
  v_claims constant text := current_setting('request.jwt.claims', true);
  v_sub constant text := current_setting('request.jwt.claim.sub', true);
begin
  -- Every member policy has to exist, or this would pass by checking nothing.
  if (select count(*) from pg_catalog.pg_policies p
      where p.schemaname = 'app' and p.policyname = p.tablename || '_member_select'
        and p.tablename in ('conversations', 'messages', 'calls', 'attention_items', 'ai_teammate_drafts')) <> 5 then
    raise exception 'Expected a members'' SELECT policy on each of the five inbox tables';
  end if;
  foreach v_table in array array['conversations', 'messages', 'calls', 'attention_items', 'ai_teammate_drafts'] loop
    return query execute format(
      'select %L::text, x.id, v.id, true, false
       from app.%I x cross join lateral unnest(x.member_viewer_ids) v (id)
       where ($1::uuid is null or x.workspace_id = $1) and x.member_viewer_ids <> ''{}''
         and not exists (select 1 from app.workspace_access wa
                         where wa.user_id = v.id and wa.workspace_id = x.workspace_id)',
      v_table, v_table)
    using p_workspace;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
  for v_person in
    select x.id from (
      select wa.user_id as id from app.workspace_access wa
      where p_workspace is null or wa.workspace_id = p_workspace
      union
      select wm.user_id from app.workspace_memberships wm
      where p_workspace is null or wm.workspace_id = p_workspace
    ) x
    order by x.id
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_person.id, 'role', 'authenticated')::text, true);
    -- Only the businesses where this person is actually narrowed: anywhere else the wide arm is the whole
    -- answer and member_viewer_ids is never read by anything.
    select coalesce(array_agg(wa.workspace_id), '{}') into v_narrowed
    from app.workspace_access wa
    where wa.user_id = v_person.id
      and (p_workspace is null or wa.workspace_id = p_workspace)
      and private.inbox_narrowed(wa.workspace_id);
    continue when cardinality(v_narrowed) = 0;
    for v_policy in
      select p.tablename::text as tbl, p.qual
      from pg_catalog.pg_policies p
      where p.schemaname = 'app' and p.policyname = p.tablename || '_member_select'
        and p.tablename in ('conversations', 'messages', 'calls', 'attention_items', 'ai_teammate_drafts')
    loop
      return query execute format(
        'select %L::text, x.id, $2, x.member_viewer_ids @> array[$2], coalesce(%s, false)
         from app.%I x
         where x.workspace_id = any($1)
           and (x.member_viewer_ids @> array[$2]) is distinct from coalesce(%s, false)',
        v_policy.tbl, v_policy.qual, v_policy.tbl, v_policy.qual)
      using v_narrowed, v_person.id;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;

revoke all on function private.sync_inbox_mismatches(uuid) from public;
