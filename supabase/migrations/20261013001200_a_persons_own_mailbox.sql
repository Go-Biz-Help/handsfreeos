-- =============================================================================
-- A person's own mailbox (M19, step 3).
--
--        An address can now belong to one person: chris@lonestarhvac.com is
--        Chris's, and the threads on it are his alone (Chris, 2026-09-29).
--        Not the team's, and not the owners' or admins' either, which is
--        what makes this different from 0083's narrowing: there, an owner
--        still sees everything. Here nobody else does.
--
--        **Sealed in the database, not in the screens.** A private thread
--        and its messages carry `private_to`. Every policy that shows the
--        whole business a thread gains "and it isn't private", and a third
--        arm shows a private one to its person. Its viewer list is its
--        person alone, so 0083's member arm, the phone's me_v1 stream and
--        private.sync_inbox_mismatches() all agree with that without a word
--        changed. A file on someone else's private mail can't be opened from
--        Storage either.
--
--        **Never linked to a customer.** A private thread keeps
--        `person_id` null (a check says so). Almost everything that copies
--        mail somewhere the team can read it (the timeline, the AI's notes on
--        a customer, campaigns, workflows, the Action Center) finds mail
--        through the customer it's linked to. A thread no customer points at
--        reaches none of them. Sharing a thread with the team is what links
--        it.
--
--        **Who moves it.** Only its person makes a thread theirs or shares
--        it; only its person sends from their address. When a person leaves,
--        their address waits for an owner (private.reassign_email_address):
--        make it the team's, give it to someone else with its mail, or
--        remove it with its mail. Until then new mail to it goes to the
--        business's default address, so nothing is missed, and the old mail
--        stays unread by anyone.
-- =============================================================================

-- ---------- who works here ----------
-- Whether a person can open this business now: the row 0056's triggers keep from the memberships. Asked about
-- someone other than the caller, which is why it isn't private.accessible_workspace_ids().
create or replace function private.works_in(p_user uuid, p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.workspace_access wa where wa.user_id = p_user and wa.workspace_id = p_ws)
$$;

-- ---------- whose address it is ----------
-- No foreign key on purpose: a person whose account is deleted must not turn their address, and so their mail,
-- into the team's. It stays theirs, sealed, until an owner decides.
alter table app.email_addresses add column owner_user_id uuid;

comment on column app.email_addresses.owner_user_id is
  'The person whose own address this is (M19): only they send from it, and its threads are theirs alone. Null is the team''s.';

-- A person's own address is on the business's own domain, and never the business's default.
alter table app.email_addresses add constraint email_addresses_owned_is_personal
  check (owner_user_id is null or (email_domain_id is not null and not is_default));

-- Giving an address to someone is setting it up; taking it from someone moves their mail, which only
-- private.reassign_email_address does. It reads who is writing, so it runs as them.
create or replace function private.guard_email_address_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.owner_user_id is not distinct from old.owner_user_id then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.owner_user_id is not null and current_user = 'authenticated' then
    raise exception 'Only an owner moves a person''s address, once they have left'
      using errcode = '42501', detail = 'email_address_owner_is_theirs';
  end if;
  if new.owner_user_id is not null and not private.works_in(new.owner_user_id, new.workspace_id) then
    raise exception 'That person doesn''t work here' using errcode = '23514', detail = 'email_address_owner_not_here';
  end if;
  return new;
end $$;

create trigger email_addresses_owner_guard before insert or update on app.email_addresses
  for each row execute function private.guard_email_address_owner();

-- People write an address's columns one by one (0012); whose it is joins them, and the guard above says when.
grant update (owner_user_id) on app.email_addresses to authenticated;

-- ---------- whose thread it is ----------
alter table app.conversations add column private_to uuid;
alter table app.messages add column private_to uuid;

comment on column app.conversations.private_to is
  'The one person who may read this thread: it came in on, or went out from, their own address (M19). Null is the team''s.';
comment on column app.messages.private_to is
  'Its thread''s private_to, kept by triggers so the policy reads the row alone.';

alter table app.conversations add constraint conversations_private_unlinked
  check (private_to is null or person_id is null);

-- A person makes a thread theirs only for themselves, and moves one only to share it with the team. The worker
-- (filing their mail) and the owner's reassignment write past this; it reads who is writing, so it runs as them.
create or replace function private.guard_private_thread()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.private_to is not null and new.private_to is distinct from (select auth.uid()) then
      raise exception 'A thread can be private only to the person starting it'
        using errcode = '42501', detail = 'private_thread_is_theirs';
    end if;
    return new;
  end if;
  if new.private_to is distinct from old.private_to
     and not (old.private_to = (select auth.uid()) and new.private_to is null) then
    raise exception 'Only its person shares a private thread'
      using errcode = '42501', detail = 'private_thread_is_theirs';
  end if;
  return new;
end $$;

create trigger conversations_private_guard before insert or update on app.conversations
  for each row execute function private.guard_private_thread();

-- A private thread's viewer list is its person alone; shared again, it is worked out as any thread's is. Named to
-- run after conversations_member_viewers, whose answer it overrides.
create or replace function private.private_thread_viewers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.private_to is not null then
    new.member_viewer_ids := array[new.private_to];
  elsif tg_op = 'UPDATE' and old.private_to is not null then
    new.member_viewer_ids :=
      private.inbox_member_viewers(new.workspace_id, new.assignee_user_id, new.phone_number_id, new.person_id);
  end if;
  return new;
end $$;

create trigger conversations_private_viewers before insert or update on app.conversations
  for each row execute function private.private_thread_viewers();

-- A message is as private as its thread.
create or replace function private.message_private_to()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select c.private_to into new.private_to from app.conversations c where c.id = new.conversation_id;
  return new;
end $$;

create trigger messages_private_to before insert or update of conversation_id, private_to on app.messages
  for each row execute function private.message_private_to();

create or replace function private.private_thread_propagate()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.messages m set private_to = new.private_to
  where m.conversation_id = new.id and m.private_to is distinct from new.private_to;
  return null;
end $$;

create trigger conversations_private_propagate after update of private_to on app.conversations
  for each row when (old.private_to is distinct from new.private_to)
  execute function private.private_thread_propagate();

-- Only its person sends from their own address: not a teammate, a workflow, the AI teammate or a reminder. Mail
-- coming in to it is the worker's to file. It reads who is writing, so it runs as them.
create or replace function private.guard_private_sender()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_owner uuid;
begin
  if new.direction <> 'outbound' or new.email_address_id is null then
    return new;
  end if;
  select a.owner_user_id into v_owner from app.email_addresses a where a.id = new.email_address_id;
  -- One question at a time: the team's addresses never ask who is signed in, and the worker, which has no
  -- sign-in to ask about, is refused before anyone looks.
  if v_owner is null then
    return new;
  end if;
  if current_user <> 'authenticated' then
    raise exception 'Only its person sends from their own address'
      using errcode = '42501', detail = 'email_address_private';
  end if;
  if v_owner is distinct from auth.uid() then
    raise exception 'Only its person sends from their own address'
      using errcode = '42501', detail = 'email_address_private';
  end if;
  return new;
end $$;

create trigger messages_private_sender before insert on app.messages
  for each row execute function private.guard_private_sender();

-- ---------- who reads what ----------
-- The whole-business arms gain one clause; the member arms (0083) stay as they are, because a private thread's
-- list is its person alone; and a third arm shows a private thread to its person wherever they work.
drop policy conversations_select on app.conversations;
create policy conversations_select on app.conversations for select to authenticated
  using (workspace_id in (select a.id from private.accessible_workspace_ids() a (id)
                          where not private.inbox_narrowed(a.id))
    and private_to is null);
create policy conversations_private_select on app.conversations for select to authenticated
  using (private_to = (select auth.uid())
    and workspace_id in (select private.accessible_workspace_ids()));

drop policy messages_select on app.messages;
create policy messages_select on app.messages for select to authenticated
  using (workspace_id in (select a.id from private.accessible_workspace_ids() a (id)
                          where not private.inbox_narrowed(a.id))
    and private_to is null);
create policy messages_private_select on app.messages for select to authenticated
  using (private_to = (select auth.uid())
    and workspace_id in (select private.accessible_workspace_ids()));

drop policy conversations_insert on app.conversations;
create policy conversations_insert on app.conversations for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use') and created_by = (select auth.uid())
    and (private_to is null or private_to = (select auth.uid())));
drop policy conversations_update on app.conversations;
create policy conversations_update on app.conversations for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and (private_to is null or private_to = (select auth.uid())))
  with check (private.has_permission(workspace_id, 'inbox.use')
    and (private_to is null or private_to = (select auth.uid())));

drop policy messages_insert on app.messages;
create policy messages_insert on app.messages for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use') and direction = 'outbound' and status = 'queued'
    and sent_by = (select auth.uid()) and provider_message_id is null
    and transport is null and read_at is null and button_reply is null and content_sid is null
    and (private_to is null or private_to = (select auth.uid())));
drop policy messages_update on app.messages;
create policy messages_update on app.messages for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use')
    and (private_to is null or private_to = (select auth.uid())))
  with check (private.has_permission(workspace_id, 'inbox.use')
    and (private_to is null or private_to = (select auth.uid())));

-- ---------- files ----------
-- As 20261012020300, and a file on someone else's private mail is theirs alone, whoever else can open the
-- business: owners and admins included. The lookup reads only private messages, through their own index.
create index messages_private_media_idx on app.messages using gin (media jsonb_path_ops)
  where private_to is not null;

create or replace function private.storage_read_allowed(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_bucket
    when 'attachments' then exists (
      select 1 from app.files f
      where f.bucket = 'attachments' and f.object_path = p_name and f.status = 'ready' and f.deleted_at is null
        and f.workspace_id in (select private.accessible_workspace_ids())
        and (f.record_type <> 'port' or private.has_permission(f.workspace_id, 'channels.manage')))
    when 'telephony' then
      coalesce(private.path_workspace(p_name) in (select private.accessible_workspace_ids()), false)
      and (not private.inbox_narrowed(private.path_workspace(p_name))
        or exists (
          select 1 from app.calls c
          where c.workspace_id = private.path_workspace(p_name)
            and c.member_viewer_ids @> array[(select auth.uid())]
            and (c.recording_object_path = p_name
              or (split_part(p_name, '/', 2) = 'calls'
                and c.id = case when split_part(p_name, '/', 3)
                    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then split_part(p_name, '/', 3)::uuid end)))
        or exists (
          select 1 from app.messages m
          where m.workspace_id = private.path_workspace(p_name)
            and m.member_viewer_ids @> array[(select auth.uid())]
            and (m.media @> jsonb_build_array(jsonb_build_object('objectPath', p_name))
              or (split_part(p_name, '/', 2) = 'messages'
                and m.id = case when split_part(p_name, '/', 3)
                    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then split_part(p_name, '/', 3)::uuid end))))
      and not exists (
        select 1 from app.messages m
        where m.private_to is not null and m.private_to <> (select auth.uid())
          and m.workspace_id = private.path_workspace(p_name)
          and (m.media @> jsonb_build_array(jsonb_build_object('objectPath', p_name))
            or (split_part(p_name, '/', 2) = 'messages'
              and m.id = case when split_part(p_name, '/', 3)
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(p_name, '/', 3)::uuid end)))
    when 'migrations' then exists (
      select 1 from app.migrations m
      where m.organization_id = private.path_workspace(p_name)
        and private.has_org_permission(m.organization_id, 'org.migrations.manage'))
    else false
  end
$$;

-- ---------- mail to someone who has left ----------
-- As step 1's, except that a person's own address whose person no longer works here routes to the default
-- address like a name nobody has: the team sees new mail to it while an owner decides what becomes of it.
create or replace function private.email_receiving_route(p_address text)
returns table (email_address_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.id, d.workspace_id, w.organization_id
  from app.email_domains d
  join app.workspaces w on w.id = d.workspace_id
  cross join lateral (
    select x.id
    from app.email_addresses x
    where x.workspace_id = d.workspace_id
      and ((x.address = lower(p_address)
            and (x.owner_user_id is null or private.works_in(x.owner_user_id, x.workspace_id)))
        or x.is_default)
    order by x.address = lower(p_address) desc
    limit 1
  ) a
  where d.domain = split_part(lower(p_address), '@', 2)
    and d.receiving in ('on', 'lapsed')
    and w.deletion_requested_at is null
$$;

-- An owner decides what becomes of the address of someone who has left, and of the mail on it: the team's
-- (p_to null), someone else's (p_to), or gone (p_remove), the threads with it. Returns the files the removed
-- mail carried, for the worker to take out of storage.
create or replace function private.reassign_email_address(p_address uuid, p_to uuid, p_remove boolean)
returns table (was uuid, threads integer, media jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_owner uuid;
  v_threads integer := 0;
  v_media jsonb := '[]'::jsonb;
begin
  select a.workspace_id, a.owner_user_id into v_ws, v_owner
  from app.email_addresses a where a.id = p_address for update;
  if not found or v_ws not in (select private.accessible_workspace_ids()) then
    raise exception 'No address with that id' using errcode = 'P0002', detail = 'no_email_address';
  end if;
  if private.effective_workspace_role(v_ws) is distinct from 'owner' then
    raise exception 'Only an owner decides what becomes of a person''s address'
      using errcode = '42501', detail = 'email_address_reassign_owner';
  end if;
  if v_owner is null then
    raise exception 'That address is the team''s already' using errcode = '23514', detail = 'email_address_not_owned';
  end if;
  if private.works_in(v_owner, v_ws) then
    raise exception 'That person still works here' using errcode = '23514', detail = 'email_address_owner_still_here';
  end if;
  if p_remove then
    with gone as (
      delete from app.conversations c
      where c.email_address_id = p_address and c.private_to = v_owner
      returning c.id
    )
    select count(*)::int,
      coalesce((select jsonb_agg(f) from app.messages m, jsonb_array_elements(m.media) f
                where m.conversation_id in (select g.id from gone g)), '[]'::jsonb)
    into v_threads, v_media
    from gone;
    delete from app.email_addresses where id = p_address;
  else
    if p_to is not null and not private.works_in(p_to, v_ws) then
      raise exception 'That person doesn''t work here' using errcode = '23514', detail = 'email_address_owner_not_here';
    end if;
    update app.email_addresses set owner_user_id = p_to where id = p_address;
    update app.conversations set private_to = p_to
    where email_address_id = p_address and private_to = v_owner;
    get diagnostics v_threads = row_count;
  end if;
  return query select v_owner, v_threads, v_media;
end $$;

-- ---------- function privileges ----------
revoke all on function
  private.works_in(uuid, uuid), private.guard_email_address_owner(), private.guard_private_thread(),
  private.private_thread_viewers(), private.message_private_to(), private.private_thread_propagate(),
  private.guard_private_sender(), private.reassign_email_address(uuid, uuid, boolean)
  from public;
grant execute on function
  private.works_in(uuid, uuid), private.guard_email_address_owner(), private.guard_private_thread(),
  private.private_thread_viewers(), private.message_private_to(), private.private_thread_propagate(),
  private.guard_private_sender()
  to authenticated, service_actor;
grant execute on function private.reassign_email_address(uuid, uuid, boolean) to authenticated;
