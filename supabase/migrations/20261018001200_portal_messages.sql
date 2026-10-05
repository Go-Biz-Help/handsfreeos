-- =============================================================================
-- Messages in a customer's portal, in the Inbox (Real Estate round two,
-- step 5; core).
--
--        A client writes to the business from their portal, and the team
--        answers from the Inbox. Chris decided (2026-09-30) that portal
--        messages are seen only by the people on that client's deals, plus
--        owners, admins and anyone who sees every deal.
--
--        **One thread per client per record.** A portal thread is about one
--        of the records the client is on (a deal): channel `portal`,
--        counterpart `portal:<person>:<record>` (or `portal:<person>` when a
--        portal has no records yet), and the record in the new
--        `conversations.custom_record_id`. A conversation on a private
--        record is sealed (`keep_sealed`, as tasks and files are), so the
--        rules round one built for private records decide who sees it:
--        its people, owners and admins, and anyone who sees every deal.
--        Its messages, its timeline lines (logged on the record) and its
--        Home cards follow it.
--
--        **The client reads only their own threads** as portal_actor: on
--        records they're on through a portal-visible relationship.
--
--        **Phones** don't receive portal threads yet (sync-config), until the
--        phone's deal screens arrive in round six.
-- =============================================================================

alter table app.conversations
  add column custom_record_id uuid references app.custom_records (id) on delete set null,
  add column sealed boolean not null default false,
  add constraint conversations_portal_counterpart_check check (
    channel <> 'portal' or counterpart ~ '^portal:[0-9a-f-]{36}(:[0-9a-f-]{36})?$');
comment on column app.conversations.custom_record_id is
  'The record a thread is about (a portal thread''s deal). A private record''s thread is sealed with it.';
comment on column app.conversations.sealed is
  'On a private record: seen only by the people who see that record. Kept by a trigger.';
create index conversations_custom_record_idx on app.conversations (custom_record_id)
  where custom_record_id is not null;

create trigger conversations_sealed before insert or update of custom_record_id, sealed on app.conversations
  for each row execute function private.keep_sealed();

-- The sealed threads in the businesses the caller can open that they may not see (once per query).
create or replace function private.unseen_sealed_conversations()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select c.id from app.conversations c
  where c.sealed and c.workspace_id in (select private.accessible_workspace_ids())
    and c.custom_record_id in (select private.unseen_private_records())
$$;
revoke all on function private.unseen_sealed_conversations() from public;
grant execute on function private.unseen_sealed_conversations() to authenticated, service_actor;

-- On top of every rule a thread already has (the inbox, narrowing, a private mailbox): a sealed one only for the
-- people who see its record, reading or writing.
create policy conversations_sealed on app.conversations as restrictive for all to authenticated
  using (not sealed or not (custom_record_id in (select private.unseen_private_records())))
  with check (not sealed or not (custom_record_id in (select private.unseen_private_records())));
create policy messages_sealed on app.messages as restrictive for all to authenticated
  using (not (conversation_id in (select private.unseen_sealed_conversations())))
  with check (not (conversation_id in (select private.unseen_sealed_conversations())));

-- A Home card about a thread follows the thread's record too.
create or replace function private.keep_attention_sealed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.subject_type = 'task' then
    select t.custom_record_id into new.custom_record_id from app.tasks t where t.id = new.subject_id;
  elsif new.subject_type = 'addon_alert' then
    select a.custom_record_id into new.custom_record_id from app.addon_alerts a where a.id = new.subject_id;
  elsif new.subject_type = 'appointment' then
    select a.custom_record_id into new.custom_record_id from app.appointments a where a.id = new.subject_id;
  end if;
  if new.custom_record_id is null and new.conversation_id is not null then
    select c.custom_record_id into new.custom_record_id from app.conversations c where c.id = new.conversation_id;
  end if;
  new.sealed := new.custom_record_id is not null and private.record_is_private(new.custom_record_id);
  return new;
end $$;
drop trigger attention_items_sealed on app.attention_items;
create trigger attention_items_sealed
  before insert or update of subject_type, subject_id, conversation_id, custom_record_id, sealed
  on app.attention_items for each row execute function private.keep_attention_sealed();

-- A portal message is contact with the customer, as a text, an email or a chat is (a lead's last contact).
create or replace function private.activity_contact(p_kind app.activity_kind, p_subtype text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_kind::text in ('sms', 'email', 'chat', 'portal') then case when p_subtype = 'outbound' then 'outreach' else 'contact' end
    when p_kind::text = 'call' then case
      when p_subtype in ('missed', 'outbound_missed') then null
      when p_subtype = 'voicemail' then 'contact'
      else 'outreach'
    end
    when p_kind::text = 'visit' then 'outreach'
  end
$$;

-- ---------- what the client reads ----------
create policy conversations_portal_select on app.conversations for select to portal_actor
  using (channel = 'portal' and workspace_id = (select portal.workspace())
    and person_id = (select portal.person())
    and (custom_record_id is null or custom_record_id in (select portal.records())));
grant select (id, workspace_id, channel, person_id, custom_record_id, last_message_at, created_at)
  on app.conversations to portal_actor;

create policy messages_portal_select on app.messages for select to portal_actor
  using (channel = 'portal' and workspace_id = (select portal.workspace())
    and conversation_id in (select c.id from app.conversations c
      where c.channel = 'portal' and c.person_id = (select portal.person())
        and (c.custom_record_id is null or c.custom_record_id in (select portal.records()))));
grant select (id, workspace_id, conversation_id, channel, direction, status, body_text, sent_by, occurred_at,
  sent_at, delivered_at, created_at) on app.messages to portal_actor;

-- The names of the people in the business who wrote to them ("Dana Reyes"), and nobody else's.
create or replace function portal.staff_names(p_ids uuid[])
returns table (id uuid, full_name text) language sql stable security definer set search_path = '' as $$
  select u.id, u.full_name from app.users u
  join app.workspace_memberships m on m.user_id = u.id and m.workspace_id = portal.workspace()
  where u.id = any (p_ids)
$$;
revoke all on function portal.staff_names(uuid[]) from public;
grant execute on function portal.staff_names(uuid[]) to portal_actor;
