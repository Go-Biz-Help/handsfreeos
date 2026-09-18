-- =============================================================================
-- 0070 · The support desk and the people who run it.
--
--        Everything so far has been tenant data: a business's customers, its
--        messages, its money. This is the first thing that belongs to
--        HandsFreeOS itself — the tickets customers send us, and the handful of
--        people who answer them. It lives in its own schema, `platform`, for
--        one blunt reason: no tenant policy should ever have to be trusted to
--        keep a business out of another business's support history. A schema
--        the tenant policies never mention cannot leak through one.
--
--        Chris chose (2026-09-18) that support@handsfreeos.com is not a mailbox
--        anybody signs into. Mail arrives through Postmark exactly as a
--        customer's mail does, and becomes a ticket here. Tenant mail keeps the
--        `mail.handsfreeos.com` subdomain it has always had, so the bare domain
--        is free for this and the two routes never meet.
--
--        Who may do what is the same machinery as everywhere else — rows in
--        app.role_permissions, mirrored in @hfos/core — with a third axis
--        beside a workspace role and an org role: a staff role. A staff member
--        has no standing in any business. They see tickets, and they may open a
--        business read-only, for a while, with a reason, and the business sees
--        that they did.
-- =============================================================================

create schema if not exists platform;
revoke all on schema platform from public;
grant usage on schema platform to authenticated, service_actor;

comment on schema platform is
  'HandsFreeOS''s own data: support tickets and the staff who answer them. Never tenant data, and never '
  'reachable by a tenant policy.';

-- ---------- who we are ----------
-- agent answers tickets; lead also assigns them and keeps the canned replies; admin also adds and
-- removes staff. Suspended keeps the row (and its history on old tickets) while closing the door.
create type platform.staff_role as enum ('agent', 'lead', 'admin');
create type platform.staff_status as enum ('active', 'suspended');

create table platform.staff (
  user_id uuid primary key references app.users (id) on delete cascade,
  role platform.staff_role not null default 'agent',
  status platform.staff_status not null default 'active',
  display_name text not null default '' check (length(display_name) <= 120),
  /** What customers see on a reply from this person ("Chris at HandsFreeOS"); their own name when empty. */
  signature text not null default '' check (length(signature) <= 2000),
  invited_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger staff_updated_at before update on platform.staff
  for each row execute function private.set_updated_at();

create table platform.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  email extensions.citext not null,
  role platform.staff_role not null default 'agent',
  token_hash bytea unique,
  invited_by uuid references app.users (id) on delete set null,
  sent_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references app.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email::text ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$')
);
create unique index staff_invitations_one_pending_per_email on platform.staff_invitations (email)
  where accepted_at is null and revoked_at is null;
create index staff_invitations_created_idx on platform.staff_invitations (created_at desc);
create trigger staff_invitations_updated_at before update on platform.staff_invitations
  for each row execute function private.set_updated_at();
create trigger staff_invitations_immutable before update on platform.staff_invitations
  for each row execute function private.forbid_tenant_column_change('email', 'role', 'invited_by');

-- ---------- tickets ----------
-- `new` has never been answered; `open` has; `waiting_on_customer` is ours answered and theirs awaited;
-- `solved` is done but still easy to reopen (a customer's reply reopens it); `closed` is done and quiet.
create type platform.ticket_status as enum ('new', 'open', 'waiting_on_customer', 'solved', 'closed');
create type platform.ticket_priority as enum ('low', 'normal', 'high', 'urgent');
-- How the person reached us. Email is a stranger until we match them; in_app and chat already know who.
create type platform.ticket_channel as enum ('email', 'in_app', 'chat');
create type platform.ticket_author as enum ('customer', 'staff', 'ai', 'system');

create sequence platform.ticket_number_seq start 1000;

create table platform.tickets (
  id uuid primary key default gen_random_uuid(),
  /** What we and the customer both call it: "#1042". */
  number bigint not null unique default nextval('platform.ticket_number_seq'),
  subject text not null default '' check (length(subject) <= 500),
  status platform.ticket_status not null default 'new',
  priority platform.ticket_priority not null default 'normal',
  channel platform.ticket_channel not null,
  requester_email extensions.citext not null check (requester_email::text ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  requester_name text not null default '' check (length(requester_name) <= 200),
  /** Set when the address is one of our users; null while they are still a stranger. */
  requester_user_id uuid references app.users (id) on delete set null,
  /** The business the ticket is about, once we know it. Kept if the business is deleted, as history. */
  workspace_id uuid references app.workspaces (id) on delete set null,
  organization_id uuid references app.organizations (id) on delete set null,
  assignee_user_id uuid references platform.staff (user_id) on delete set null,
  /** Reply-To carries this, so an answer comes back to its own ticket whatever the mail program does. */
  reply_token text unique check (reply_token is null or reply_token ~ '^[a-z2-7]{10}$'),
  /** The first time a person here answered: the number Chris will care about. */
  first_response_at timestamptz,
  resolved_at timestamptz,
  last_customer_at timestamptz,
  last_staff_at timestamptz,
  /** Put down until then: it stays out of the queue without being called done. */
  snooze_until timestamptz,
  tags text[] not null default '{}',
  merged_into uuid references platform.tickets (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (merged_into is null or merged_into <> id)
);
create index tickets_queue_idx on platform.tickets (status, priority desc, updated_at desc);
create index tickets_assignee_idx on platform.tickets (assignee_user_id, status);
create index tickets_requester_idx on platform.tickets (requester_email, created_at desc);
create index tickets_workspace_idx on platform.tickets (workspace_id, created_at desc);
create trigger tickets_updated_at before update on platform.tickets
  for each row execute function private.set_updated_at();

-- Every ticket gets a reply token the same way a conversation does (10 base32 characters).
create or replace function private.set_ticket_reply_token()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_token text := '';
begin
  if new.reply_token is null or new.reply_token = '' then
    for i in 0..9 loop
      v_token := v_token || substr(v_alphabet, (get_byte(v_bytes, i * 3) % 32) + 1, 1);
    end loop;
    new.reply_token := v_token;
  end if;
  return new;
end $$;
create trigger tickets_reply_token before insert on platform.tickets
  for each row execute function private.set_ticket_reply_token();
create trigger tickets_reply_token_immutable before update on platform.tickets
  for each row execute function private.forbid_tenant_column_change('reply_token', 'number');

-- ---------- what was said ----------
create table platform.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references platform.tickets (id) on delete cascade,
  author platform.ticket_author not null,
  /** An internal note: staff read it, the customer never does. */
  internal boolean not null default false,
  author_user_id uuid references app.users (id) on delete set null,
  body_text text not null default '' check (length(body_text) <= 100000),
  body_html text check (body_html is null or length(body_html) <= 1000000),
  /** The Message-ID we sent or received, and what it answered: threading, and no message filed twice. */
  email_message_id text,
  email_in_reply_to text,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  check (not internal or author = 'staff')
);
create index ticket_messages_ticket_idx on platform.ticket_messages (ticket_id, created_at);
create unique index ticket_messages_email_id_idx on platform.ticket_messages (email_message_id)
  where email_message_id is not null;

-- The AI's suggested answer. One live draft per ticket: a newer one replaces it.
create table platform.ticket_drafts (
  ticket_id uuid primary key references platform.tickets (id) on delete cascade,
  body_text text not null check (length(body_text) <= 20000),
  /** Where it got its answer: knowledge items, past tickets. Shown so the person can check it. */
  sources jsonb not null default '[]'::jsonb,
  model text not null default '',
  /** The customer message it answers; a draft older than the conversation is not offered. */
  answers_message_id uuid references platform.ticket_messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  dismissed_at timestamptz
);

-- What happened to the ticket, as a person reads it: assigned, status changed, merged, viewed-as.
create table platform.ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references platform.tickets (id) on delete cascade,
  kind text not null check (kind ~ '^[a-z_]+$'),
  actor_user_id uuid references app.users (id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index ticket_events_ticket_idx on platform.ticket_events (ticket_id, created_at);

create table platform.canned_replies (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 200),
  body_text text not null check (length(body_text) between 1 and 20000),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index canned_replies_title_idx on platform.canned_replies (lower(title));
create trigger canned_replies_updated_at before update on platform.canned_replies
  for each row execute function private.set_updated_at();

-- ---------- looking at a business ----------
-- A staff member may open a business to see what the customer sees. It is read-only by construction:
-- the request runs with the service actor's read policies and the kernel refuses every command while a
-- session is open. It ends by itself, it carries a reason, and the business finds it in its own audit log.
create table platform.view_as_sessions (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references platform.staff (user_id) on delete cascade,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  ticket_id uuid references platform.tickets (id) on delete set null,
  reason text not null check (length(reason) between 3 and 500),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create index view_as_sessions_staff_idx on platform.view_as_sessions (staff_user_id, started_at desc);
create index view_as_sessions_workspace_idx on platform.view_as_sessions (workspace_id, started_at desc);
create unique index view_as_sessions_one_open_per_staff on platform.view_as_sessions (staff_user_id)
  where ended_at is null;

-- ---------- the third axis: what a staff role may do ----------
-- The same table every other role reads from, so there is one answer to "may they?" in the database and
-- one mirror of it in TypeScript (permissions-parity.test.ts asserts they stay equal).
alter table app.role_permissions drop constraint role_permissions_role_check;
alter table app.role_permissions add constraint role_permissions_role_check
  check (role in ('owner', 'admin', 'member', 'org_owner', 'org_admin',
                  'staff_agent', 'staff_lead', 'staff_admin'));

insert into app.role_permissions (role, permission) values
  ('staff_agent', 'support.read'), ('staff_agent', 'support.reply'),
  ('staff_agent', 'platform.businesses.read'), ('staff_agent', 'platform.view_as'),
  ('staff_lead', 'support.read'), ('staff_lead', 'support.reply'), ('staff_lead', 'support.assign'),
  ('staff_lead', 'support.manage'), ('staff_lead', 'platform.businesses.read'),
  ('staff_lead', 'platform.view_as'), ('staff_lead', 'platform.health.read'),
  ('staff_admin', 'support.read'), ('staff_admin', 'support.reply'), ('staff_admin', 'support.assign'),
  ('staff_admin', 'support.manage'), ('staff_admin', 'platform.businesses.read'),
  ('staff_admin', 'platform.view_as'), ('staff_admin', 'platform.health.read'),
  ('staff_admin', 'platform.staff.manage');

-- ---------- helpers ----------
-- Suspended staff are nobody: the row stays for the history on old tickets, the door is shut.
create or replace function private.staff_role()
returns text language sql stable security definer set search_path = '' as $$
  select s.role::text from platform.staff s
  where s.user_id = auth.uid() and s.status = 'active'
$$;

create or replace function private.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.staff_role() is not null
$$;

create or replace function private.staff_can(p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.role_permissions rp
    where rp.role = 'staff_' || private.staff_role() and rp.permission = p_perm
  )
$$;

-- The one open session a staff member has, for the business they asked for. The API asks this before it
-- serves a look-up as the service actor, so an expired or ended session simply stops working.
create or replace function private.active_view_as(p_user uuid, p_ws uuid)
returns table (session_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select v.id, v.organization_id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  where v.staff_user_id = p_user and v.workspace_id = p_ws
    and v.ended_at is null and v.expires_at > now()
$$;

-- A staff member never changes their own role, and the last admin cannot be removed or demoted: the same
-- rule the last workspace owner has, for the same reason.
create or replace function private.protect_staff_roles()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_removed boolean;
  v_role_changed boolean;
begin
  -- NEW does not exist on a delete, so the two questions are answered before either is asked.
  if tg_op = 'DELETE' then
    v_removed := true;
    v_role_changed := true;
  else
    v_removed := new.role <> 'admin' or new.status <> 'active';
    v_role_changed := new.role is distinct from old.role;
  end if;
  if auth.uid() is not null and old.user_id = auth.uid() and v_role_changed then
    raise exception 'You cannot change your own staff role' using errcode = '42501', detail = 'own_staff_role';
  end if;
  if old.role = 'admin' and old.status = 'active' and v_removed and not exists (
       select 1 from platform.staff s
       where s.user_id <> old.user_id and s.role = 'admin' and s.status = 'active') then
    raise exception 'HandsFreeOS needs one support admin' using errcode = '23514', detail = 'last_staff_admin';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger staff_protect_roles before update or delete on platform.staff
  for each row execute function private.protect_staff_roles();

-- ---------- row level security ----------
-- Every table here reads the same way: staff with the permission, and the worker, which does the sending,
-- the filing and the drafting. Nobody else can see the schema at all.
alter table platform.staff enable row level security;
alter table platform.staff_invitations enable row level security;
alter table platform.tickets enable row level security;
alter table platform.ticket_messages enable row level security;
alter table platform.ticket_drafts enable row level security;
alter table platform.ticket_events enable row level security;
alter table platform.canned_replies enable row level security;
alter table platform.view_as_sessions enable row level security;

create policy staff_read on platform.staff for select to authenticated
  using (private.is_staff());
create policy staff_write on platform.staff for all to authenticated
  using (private.staff_can('platform.staff.manage'))
  with check (private.staff_can('platform.staff.manage'));
create policy staff_service on platform.staff for all to service_actor
  using (true) with check (true);

create policy staff_invitations_read on platform.staff_invitations for select to authenticated
  using (private.staff_can('platform.staff.manage'));
create policy staff_invitations_write on platform.staff_invitations for all to authenticated
  using (private.staff_can('platform.staff.manage'))
  with check (private.staff_can('platform.staff.manage'));
create policy staff_invitations_service on platform.staff_invitations for all to service_actor
  using (true) with check (true);

create policy tickets_read on platform.tickets for select to authenticated
  using (private.staff_can('support.read'));
create policy tickets_write on platform.tickets for all to authenticated
  using (private.staff_can('support.reply'))
  with check (private.staff_can('support.reply'));
create policy tickets_service on platform.tickets for all to service_actor
  using (true) with check (true);

create policy ticket_messages_read on platform.ticket_messages for select to authenticated
  using (private.staff_can('support.read'));
create policy ticket_messages_write on platform.ticket_messages for all to authenticated
  using (private.staff_can('support.reply'))
  with check (private.staff_can('support.reply'));
create policy ticket_messages_service on platform.ticket_messages for all to service_actor
  using (true) with check (true);

create policy ticket_drafts_read on platform.ticket_drafts for select to authenticated
  using (private.staff_can('support.read'));
create policy ticket_drafts_write on platform.ticket_drafts for all to authenticated
  using (private.staff_can('support.reply'))
  with check (private.staff_can('support.reply'));
create policy ticket_drafts_service on platform.ticket_drafts for all to service_actor
  using (true) with check (true);

create policy ticket_events_read on platform.ticket_events for select to authenticated
  using (private.staff_can('support.read'));
create policy ticket_events_write on platform.ticket_events for insert to authenticated
  with check (private.staff_can('support.reply'));
create policy ticket_events_service on platform.ticket_events for all to service_actor
  using (true) with check (true);

create policy canned_replies_read on platform.canned_replies for select to authenticated
  using (private.staff_can('support.read'));
create policy canned_replies_write on platform.canned_replies for all to authenticated
  using (private.staff_can('support.manage'))
  with check (private.staff_can('support.manage'));
create policy canned_replies_service on platform.canned_replies for all to service_actor
  using (true) with check (true);

-- A staff member sees their own sessions and, with the permission, opens one. Ending one is an update.
create policy view_as_read on platform.view_as_sessions for select to authenticated
  using (private.staff_can('platform.view_as') or private.staff_can('platform.staff.manage'));
create policy view_as_write on platform.view_as_sessions for all to authenticated
  using (private.staff_can('platform.view_as') and staff_user_id = (select auth.uid()))
  with check (private.staff_can('platform.view_as') and staff_user_id = (select auth.uid()));
create policy view_as_service on platform.view_as_sessions for all to service_actor
  using (true) with check (true);

-- ---------- grants ----------
grant select, insert, update, delete on platform.tickets, platform.ticket_messages,
  platform.ticket_drafts, platform.canned_replies, platform.view_as_sessions to authenticated;
grant select, insert on platform.ticket_events to authenticated;
grant select, insert, update, delete on platform.staff to authenticated;
-- The token is written by the worker and read by nobody: an invitation link exists once, in one email.
grant select (id, email, role, invited_by, sent_at, expires_at, accepted_at, accepted_by, revoked_at,
  revoked_by, created_at, updated_at) on platform.staff_invitations to authenticated;
grant insert, update on platform.staff_invitations to authenticated;
grant usage on sequence platform.ticket_number_seq to authenticated, service_actor;

grant select, insert, update, delete on all tables in schema platform to service_actor;

revoke all on function
  private.staff_role(), private.is_staff(), private.staff_can(text),
  private.active_view_as(uuid, uuid), private.set_ticket_reply_token(), private.protect_staff_roles()
  from public;
grant execute on function
  private.staff_role(), private.is_staff(), private.staff_can(text),
  private.set_ticket_reply_token(), private.protect_staff_roles()
  to authenticated, service_actor;
grant execute on function private.active_view_as(uuid, uuid) to service_actor;

-- ---------- the two doors that open before you are staff, or without being staff ----------
-- Asking for help from inside HandsFreeOS. The person is in the business they are asking about, and that
-- is the whole check: they may open a ticket about their own business and nothing else. Their name, their
-- address and their business are taken from the database, never from what the screen sent.
create or replace function private.open_support_ticket(
  p_workspace uuid,
  p_subject text,
  p_body text,
  p_context jsonb
) returns table (ticket_id uuid, ticket_number bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_ticket uuid;
  v_number bigint;
  v_email extensions.citext;
  v_name text;
  v_org uuid;
begin
  if private.effective_workspace_role(p_workspace) is null then
    raise exception 'Workspace not found' using errcode = '42501', detail = 'not_a_member';
  end if;
  select u.email, u.full_name into v_email, v_name from app.users u where u.id = auth.uid();
  if v_email is null then
    raise exception 'Sign in first' using errcode = '42501', detail = 'no_user';
  end if;
  select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
  insert into platform.tickets (
    subject, channel, requester_email, requester_name, requester_user_id,
    workspace_id, organization_id, last_customer_at)
  values (
    left(coalesce(nullif(btrim(p_subject), ''), 'Help please'), 500), 'in_app', v_email,
    coalesce(v_name, ''), auth.uid(), p_workspace, v_org, now())
  returning id, number into v_ticket, v_number;
  insert into platform.ticket_messages (ticket_id, author, body_text)
  values (v_ticket, 'customer', left(coalesce(p_body, ''), 100000));
  insert into platform.ticket_events (ticket_id, kind, actor_user_id, data)
  values (v_ticket, 'opened', auth.uid(), coalesce(p_context, '{}'::jsonb));
  return query select v_ticket, v_number;
end $$;

-- Accepting a support invitation. The link is not enough on its own: it has to be opened by the person it
-- was sent to, signed in with that address. Nobody becomes staff by forwarding an email.
create or replace function private.accept_staff_invitation(p_token_hash bytea)
returns table (accepted boolean, staff_role text, reason text)
language plpgsql security definer set search_path = '' as $$
declare
  v_inv platform.staff_invitations;
  v_email extensions.citext;
begin
  select u.email into v_email from app.users u where u.id = auth.uid();
  if v_email is null then
    return query select false, null::text, 'not_signed_in'; return;
  end if;
  select * into v_inv from platform.staff_invitations i
  where i.token_hash = p_token_hash for update;
  if v_inv.id is null then
    return query select false, null::text, 'unknown'; return;
  end if;
  if v_inv.accepted_at is not null then
    return query select false, null::text, 'already_accepted'; return;
  end if;
  if v_inv.revoked_at is not null then
    return query select false, null::text, 'revoked'; return;
  end if;
  if v_inv.expires_at <= now() then
    return query select false, null::text, 'expired'; return;
  end if;
  if v_inv.email <> v_email then
    return query select false, null::text, 'wrong_address'; return;
  end if;
  insert into platform.staff (user_id, role, invited_by)
  values (auth.uid(), v_inv.role, v_inv.invited_by)
  on conflict (user_id) do update set status = 'active', updated_at = now();
  update platform.staff_invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_inv.id;
  return query select true, v_inv.role::text, null::text;
end $$;

revoke all on function
  private.open_support_ticket(uuid, text, text, jsonb), private.accept_staff_invitation(bytea)
  from public;
grant execute on function
  private.open_support_ticket(uuid, text, text, jsonb), private.accept_staff_invitation(bytea)
  to authenticated;

-- ---------- the worker reads the platform's own events ----------
-- Support events belong to no business, so the worker holds no tenant scope while it handles them. Without
-- this it could claim the outbox row and then not see the event it named.
create policy events_service_select_platform on app.events
  for select to service_actor
  using (organization_id is null and workspace_id is null
    and (event_type like 'support%' or event_type like 'platform.%'));

-- ---------- what a support person may see of a business ----------
-- Two different things, kept apart on purpose.
--
-- The first is the directory: which businesses exist, what they are called, who works in them, when they
-- signed up. A support person needs it to answer "I can't log in" and "which account are you?", and it is
-- names and dates, not anybody's customers. It is four ordinary read policies, gated on the permission.
--
-- The second is their actual data — leads, messages, money. None of that is readable here at all. It is
-- reached only by looking at the business (view-as), which is time limited, needs a reason, and is written
-- into the business's own audit log. What the pages below show of it is counts, and counts only.
create policy workspaces_staff_read on app.workspaces for select to authenticated
  using (private.staff_can('platform.businesses.read'));
create policy organizations_staff_read on app.organizations for select to authenticated
  using (private.staff_can('platform.businesses.read'));
create policy workspace_memberships_staff_read on app.workspace_memberships for select to authenticated
  using (private.staff_can('platform.businesses.read'));
create policy users_staff_read on app.users for select to authenticated
  using (private.staff_can('platform.businesses.read'));

-- How much there is of each thing in one business. Counts, never rows: this answers "is anything set up?"
-- and "are they using it?" without showing a single customer.
create or replace function private.admin_business_counts(p_ws uuid)
returns table (
  people bigint, leads bigint, conversations bigint, appointments bigint, invoices bigint,
  has_phone boolean, has_email boolean, has_payments boolean, has_calendar boolean, has_ai boolean,
  last_active_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from app.people p where p.workspace_id = p_ws and p.archived_at is null),
    (select count(*) from app.leads l where l.workspace_id = p_ws and l.archived_at is null),
    (select count(*) from app.conversations c where c.workspace_id = p_ws),
    (select count(*) from app.appointments a where a.workspace_id = p_ws),
    (select count(*) from app.invoices i where i.workspace_id = p_ws),
    exists (select 1 from app.phone_numbers n where n.workspace_id = p_ws and n.released_at is null),
    exists (select 1 from app.email_addresses e where e.workspace_id = p_ws),
    exists (select 1 from app.payment_connections pc where pc.workspace_id = p_ws and pc.status = 'active'),
    exists (select 1 from app.calendars cal where cal.workspace_id = p_ws and cal.status = 'active'),
    exists (select 1 from app.ai_teammates t where t.workspace_id = p_ws),
    (select max(e.created_at) from app.events e where e.workspace_id = p_ws)
  where private.staff_can('platform.businesses.read')
$$;

-- The last time anybody in a business did anything, for a page of businesses at once.
create or replace function private.admin_last_active(p_ws uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select max(e.created_at) from app.events e
  where e.workspace_id = p_ws and private.staff_can('platform.businesses.read')
$$;

-- How many businesses there are, how many arrived this week, how many did anything this week.
create or replace function private.admin_business_totals()
returns table (businesses bigint, new_this_week bigint, active_this_week bigint)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from app.workspaces),
    (select count(*) from app.workspaces w where w.created_at > now() - interval '7 days'),
    (select count(distinct e.workspace_id) from app.events e
      where e.created_at > now() - interval '7 days' and e.workspace_id is not null)
  where private.staff_can('platform.businesses.read')
$$;

-- What has gone wrong lately, across every business: the numbers first.
create or replace function private.admin_health_counts(p_since timestamptz)
returns table (
  failed_jobs bigint, failed_deliveries bigint, email_bounces bigint, failed_texts bigint,
  payment_failures bigint, outbox_backlog bigint, oldest_pending_minutes int)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from app.scheduled_jobs j where j.status = 'failed' and j.updated_at > p_since),
    (select count(*) from app.webhook_deliveries d where d.status = 'failed' and d.updated_at > p_since),
    (select count(*) from app.email_suppressions s
      where s.created_at > p_since and s.released_at is null and s.reason <> 'manual'),
    (select count(*) from app.messages m
      where m.channel = 'sms' and m.status = 'failed' and m.updated_at > p_since),
    (select count(*) from app.payments p where p.status = 'failed' and p.updated_at > p_since),
    (select count(*) from app.outbox o where o.status in ('pending', 'failed')),
    (select coalesce(max(extract(epoch from (now() - o.created_at)) / 60), 0)::int from app.outbox o
      where o.status = 'pending')
  where private.staff_can('platform.health.read')
$$;

-- And then the last few, named well enough to go and look: what kind, which business, and the error itself.
-- Never a message body, never a customer's name: a failure is a failure of ours, and that is all this shows.
create or replace function private.admin_health_recent(p_since timestamptz, p_limit int)
returns table (kind text, at timestamptz, business text, detail text)
language sql stable security definer set search_path = '' as $$
  select * from (
    select 'Background job' as kind, j.updated_at as at, w.name as business,
           j.kind || ': ' || left(coalesce(j.last_error, 'failed'), 200) as detail
    from app.scheduled_jobs j left join app.workspaces w on w.id = j.workspace_id
    where j.status = 'failed' and j.updated_at > p_since
    union all
    select 'Webhook', d.updated_at, w.name,
           d.provider || ' ' || d.kind || ': ' || left(coalesce(d.last_error, 'failed'), 200)
    from app.webhook_deliveries d left join app.workspaces w on w.id = d.workspace_id
    where d.status = 'failed' and d.updated_at > p_since
    union all
    select 'Text message', m.updated_at, w.name,
           coalesce(m.error_code, 'failed') || ': ' || left(coalesce(m.error_message, ''), 200)
    from app.messages m join app.workspaces w on w.id = m.workspace_id
    where m.channel = 'sms' and m.status = 'failed' and m.updated_at > p_since
    union all
    select 'Email bounced', s.created_at, w.name, s.reason::text || ' · ' || left(s.address, 120)
    from app.email_suppressions s join app.workspaces w on w.id = s.workspace_id
    where s.created_at > p_since and s.released_at is null and s.reason <> 'manual'
    union all
    select 'Payment', p.updated_at, w.name, left(coalesce(p.failure_code, 'failed'), 200)
    from app.payments p join app.workspaces w on w.id = p.workspace_id
    where p.status = 'failed' and p.updated_at > p_since
  ) all_of_it
  where private.staff_can('platform.health.read')
  order by at desc
  limit greatest(1, least(p_limit, 100))
$$;

revoke all on function
  private.admin_business_counts(uuid), private.admin_last_active(uuid), private.admin_business_totals(),
  private.admin_health_counts(timestamptz), private.admin_health_recent(timestamptz, int)
  from public;
grant execute on function
  private.admin_business_counts(uuid), private.admin_last_active(uuid), private.admin_business_totals(),
  private.admin_health_counts(timestamptz), private.admin_health_recent(timestamptz, int)
  to authenticated;

-- ---------- who wrote in ----------
-- Mail arriving at support@ belongs to no business, so the worker holds no tenant scope while it files it
-- and cannot read the people or membership tables at all. This answers the one question it needs answered:
-- is this address one of our users, and if so, is there exactly one business it could be about? Two
-- businesses (or none) leaves the ticket unlinked, for a person to say which.
create or replace function private.support_requester(p_email text)
returns table (user_id uuid, full_name text, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select u.id, u.full_name, one.workspace_id, w.organization_id
  from app.users u
  left join lateral (
    select m.workspace_id from app.workspace_memberships m
    where m.user_id = u.id
    limit 2
  ) one on true
  left join app.workspaces w on w.id = one.workspace_id
  where u.email = lower(p_email)::extensions.citext
$$;

revoke all on function private.support_requester(text) from public;
grant execute on function private.support_requester(text) to service_actor;

-- ---------- what "looking at a business" means to the read rules ----------
-- A support person looking at a business reads it as themselves, under the ordinary rules, with one line
-- added to the list of businesses they can reach. That is deliberately the whole change: every write rule
-- asks `private.has_permission`, which answers no for someone who holds no role there, so read-only is a
-- property of the rules rather than a promise made in a screen.
create or replace function private.accessible_workspace_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wm.workspace_id from app.workspace_memberships wm where wm.user_id = auth.uid()
  union
  select w.id from app.workspaces w
  join app.organization_memberships om on om.organization_id = w.organization_id
  where om.user_id = auth.uid()
  union
  select v.workspace_id from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  where v.staff_user_id = auth.uid() and v.ended_at is null and v.expires_at > now()
$$;

-- The session the signed-in person has open for one business, for the API to recognise the look-up. It
-- answers about the caller and nobody else, which is why it takes no user.
create or replace function private.my_view_as(p_ws uuid)
returns table (session_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select v.id, v.organization_id
  from platform.view_as_sessions v
  join platform.staff s on s.user_id = v.staff_user_id and s.status = 'active'
  where v.staff_user_id = auth.uid() and v.workspace_id = p_ws
    and v.ended_at is null and v.expires_at > now()
$$;

revoke all on function private.my_view_as(uuid) from public;
grant execute on function private.my_view_as(uuid) to authenticated, service_actor;
