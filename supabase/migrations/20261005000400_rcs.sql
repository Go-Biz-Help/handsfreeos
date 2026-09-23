-- =============================================================================
-- 0103 · RCS, part 2: a business's RCS sender, and what a text now remembers.
--
--        **An RCS sender is made at Twilio, not here.** Twilio creates and
--        onboards them only in its own console — the brand's name, logo and
--        colours, the carriers' review, the test phones — and has no API for
--        doing it at scale. So a business (or Go Biz Help for it) makes the
--        sender in the business's own Twilio subaccount, and connects it here.
--        Connecting it puts it on the business's messaging service, and from
--        then on every text goes RCS first: Twilio checks whether the
--        customer's phone can show it, and sends it as an ordinary SMS or MMS
--        from the thread's own number when it can't. Nobody picks between
--        them; the thread just says which way each message went.
--
--        **Shaped like a number port** (0080), because it is the same machine:
--        a person asks, the worker talks to Twilio in a job, the carriers take
--        their time, a job asks again, and an answer comes back. A person may
--        connect a sender, switch RCS off and on, choose the line a customer's
--        first RCS message lands on, and let the sender go. Everything Twilio
--        says is the worker's to write, and private.guard_rcs_sender_update()
--        holds that line whoever runs the command.
--
--        **One sender per business at a time.** A business has one brand, and
--        a second sender would only make the customer's phone show two
--        threads. A sender that was let go stays, `disconnected`, as history.
--
--        **What a text remembers.** Five columns on app.messages, all of them
--        about texts (a check keeps them off email and chat):
--
--          transport     how it actually went, or came in: sms, mms or rcs
--          read_at       when the customer opened it (RCS says; SMS never does)
--          rich          the card, carousel or buttons it carried, with the
--                        words a phone without RCS got instead
--          button_reply  which button a customer's reply came from, when it
--                        did — a tap on RCS, or the number they texted back
--          content_sid   the Twilio content template a rich text went out as
--
--        `rich` and `button_reply` are written once, when the message is, and
--        never change: the thread must show what was actually sent and what
--        was actually tapped.
-- =============================================================================

-- ---------- the sender ----------
create table app.rcs_senders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  account_id uuid references app.telephony_accounts (id) on delete set null,
  -- The sender's id at Twilio without the `rcs:` in front of it: `lonestar_hvac_agent`.
  sender_id text not null check (sender_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,99}$'),
  status app.rcs_sender_status not null default 'connecting',
  -- Off keeps the sender and sends every text as SMS or MMS until somebody turns it back on.
  enabled boolean not null default true,
  -- Where a customer who writes to the sender before anybody has texted them starts their thread. Null is the
  -- business's default number, which is where a new thread starts everywhere else too.
  phone_number_id uuid references app.phone_numbers (id) on delete set null,

  -- ---- what Twilio says: the worker's alone (private.guard_rcs_sender_update) ----
  -- Twilio's own reference for the sender (XE…), which is what goes on the messaging service.
  provider_sid text check (provider_sid is null or provider_sid ~ '^XE[A-Za-z0-9]{8,40}$'),
  -- Twilio's word for where it stands (ONLINE, TWILIO_REVIEW, OFFLINE …), kept as it spells it.
  provider_status text check (provider_status is null or length(provider_status) <= 60),
  -- The name customers see at the top of the thread on their phone.
  display_name text check (display_name is null or length(display_name) <= 120),
  -- Whether it is on the business's messaging service, which is what makes Twilio try RCS first.
  in_service boolean not null default false,
  last_error text check (last_error is null or length(last_error) <= 2000),
  checked_at timestamptz,
  next_poll_at timestamptz,
  poll_count int not null default 0 check (poll_count >= 0),
  -- The first time it went active: when this business's texts started going as RCS.
  connected_at timestamptz,
  disconnected_at timestamptz,

  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index rcs_senders_one_per_workspace on app.rcs_senders (workspace_id)
  where status <> 'disconnected';
create index rcs_senders_workspace_idx on app.rcs_senders (workspace_id, created_at desc);
-- Twin of number_ports_poll_idx: the poller reads only what is still worth asking about.
create index rcs_senders_poll_idx on app.rcs_senders (next_poll_at)
  where status in ('connecting', 'in_review', 'active', 'offline');

create trigger rcs_senders_updated_at before update on app.rcs_senders
  for each row execute function private.set_updated_at();
create trigger rcs_senders_immutable before update on app.rcs_senders
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- references stay inside the business ----------
create or replace function private.check_rcs_sender_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.phone_number_id is not null and not exists (
        select 1 from app.phone_numbers n where n.id = new.phone_number_id and n.workspace_id = new.workspace_id))
     or (new.account_id is not null and not exists (
        select 1 from app.telephony_accounts a where a.id = new.account_id and a.workspace_id = new.workspace_id)) then
    raise exception 'An RCS sender''s number and account belong to its own business'
      using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger rcs_senders_check_refs before insert or update on app.rcs_senders
  for each row execute function private.check_rcs_sender_refs();

-- ---------- what Twilio said is ours to write ----------
-- Twin of private.guard_number_port_update(): a person asks and decides; the worker records.
create or replace function private.guard_rcs_sender_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  -- Trying again after it could not be connected: the one moment a person names a sender on a row that exists,
  -- and the one moment they may clear what went wrong last time (clear it, never write it).
  v_retrying boolean := old.status = 'failed' and new.status = 'connecting';
  -- Letting it go, from anywhere short of gone.
  v_letting_go boolean := old.status not in ('disconnecting', 'disconnected') and new.status = 'disconnecting';
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.provider_sid is distinct from new.provider_sid
     or old.provider_status is distinct from new.provider_status
     or old.display_name is distinct from new.display_name
     or old.in_service is distinct from new.in_service
     or old.checked_at is distinct from new.checked_at
     or old.next_poll_at is distinct from new.next_poll_at
     or old.poll_count is distinct from new.poll_count
     or old.connected_at is distinct from new.connected_at
     or old.disconnected_at is distinct from new.disconnected_at
     or old.account_id is distinct from new.account_id
     or (old.last_error is distinct from new.last_error and not (v_retrying and new.last_error is null)) then
    raise exception 'Only HandsFreeOS records what Twilio said about an RCS sender'
      using errcode = '42501', detail = 'rcs_sender_provider_fields';
  end if;
  if old.sender_id is distinct from new.sender_id and not v_retrying then
    raise exception 'Let this RCS sender go before connecting a different one'
      using errcode = '42501', detail = 'rcs_sender_id_fixed';
  end if;
  if old.status is distinct from new.status and not (v_retrying or v_letting_go) then
    raise exception 'People can only connect an RCS sender again or let it go'
      using errcode = '42501', detail = 'rcs_sender_status_transition';
  end if;
  return new;
end $$;
create trigger rcs_senders_update_guard before update on app.rcs_senders
  for each row execute function private.guard_rcs_sender_update();

-- ---------- who may see and change it ----------
-- Everybody who works the inbox can see it: the composer says a message will go as RCS where it can. Only the
-- people who manage the business's channels connect, change or let it go — the same people who buy numbers.
alter table app.rcs_senders enable row level security;

create policy rcs_senders_select on app.rcs_senders for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy rcs_senders_insert on app.rcs_senders for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid())
    and status = 'connecting' and account_id is null and provider_sid is null and provider_status is null
    and display_name is null and not in_service and last_error is null and connected_at is null
    and disconnected_at is null);
create policy rcs_senders_update on app.rcs_senders for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy rcs_senders_service_all on app.rcs_senders for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.rcs_senders from public, anon;
-- No delete for people: a sender that was let go says so, and when.
grant select, insert, update on app.rcs_senders to authenticated;
grant select, insert, update, delete on app.rcs_senders to service_actor;

revoke all on function private.guard_rcs_sender_update(), private.check_rcs_sender_refs() from public;
grant execute on function private.guard_rcs_sender_update(), private.check_rcs_sender_refs()
  to authenticated, service_actor;

-- ---------- what a text remembers ----------
alter table app.messages
  add column transport app.text_transport,
  add column read_at timestamptz,
  add column rich jsonb check (rich is null or (jsonb_typeof(rich) = 'object' and length(rich::text) <= 32000)),
  add column button_reply jsonb check (button_reply is null or (jsonb_typeof(button_reply) = 'object' and length(button_reply::text) <= 2000)),
  add column content_sid text check (content_sid is null or length(content_sid) <= 64);

-- All five are a text's: an email and a website chat never travel by carrier and have no buttons to tap.
alter table app.messages add constraint messages_rcs_is_a_texts
  check (channel = 'sms' or (transport is null and read_at is null and rich is null and button_reply is null
    and content_sid is null));

comment on column app.messages.transport is
  'How a text actually went or came in: sms, mms or rcs (0103). Null until the carrier says, for a text sent '
  'RCS first, which only learns its way from the first status callback.';
comment on column app.messages.rich is
  'The card, carousel or buttons a text carried, and `smsText`, the words a phone without RCS got instead (0103). '
  'Written once, with the message.';
comment on column app.messages.button_reply is
  'Which button a customer''s reply came from (0103): a tap on RCS, or the number they texted back to a list.';

-- Same name, so it keeps its place among the messages triggers (they fire in name order). What was sent and
-- what was tapped are facts about the past.
drop trigger messages_immutable on app.messages;
create trigger messages_immutable before update on app.messages for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'conversation_id', 'channel', 'direction',
    'sent_by', 'sent_by_teammate_id', 'rich', 'button_reply');

-- ---------- read comes after delivered ----------
-- A late `delivered` must never undo `read`, exactly as a late `sent` never undoes `delivered` (0011). The
-- failures keep their place above both.
create or replace function private.message_status_rank(p app.message_status)
returns int language sql immutable set search_path = '' as $$
  select case p
    when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3 when 'read' then 4
    when 'undelivered' then 5 when 'failed' then 5 when 'bounced' then 6 when 'complained' then 7
    else 0 end
$$;

-- ---------- people send rich texts, never what the carrier says about them ----------
-- The same policy as 0011 with the new carrier-side columns added to what a person's insert must leave empty.
drop policy messages_insert on app.messages;
create policy messages_insert on app.messages for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use') and direction = 'outbound' and status = 'queued'
    and sent_by = (select auth.uid()) and provider_message_id is null
    and transport is null and read_at is null and button_reply is null and content_sid is null);
