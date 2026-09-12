-- =============================================================================
-- 0012 · Email. Every workspace can send from an address on the shared
--        subdomain (mail.handsfreeos.com) from the moment it exists. A workspace
--        can add its own domain; once Postmark verifies DKIM and Return-Path, its
--        addresses can live there. Connected mailboxes (Outlook, Gmail) keep their
--        tokens sealed by the worker. Suppressions record bounces and complaints,
--        mail from people we don't know waits to be claimed, and a short reply
--        token threads a customer's answer back to its conversation.
-- =============================================================================

create type app.email_domain_status as enum ('pending', 'verified', 'failed');
create type app.mailbox_provider as enum ('microsoft', 'google');
create type app.mailbox_status as enum ('pending', 'active', 'reauth_required', 'error', 'disconnected');
create type app.suppression_reason as enum ('hard_bounce', 'spam_complaint', 'manual');

-- The shared subdomain every workspace sends from until its own domain is verified.
create or replace function private.shared_mail_domain()
returns text language sql immutable set search_path = '' as $$
  select 'mail.handsfreeos.com'::text
$$;

-- Names on the shared subdomain that would read as HandsFreeOS itself (a workspace's own domain may use any).
create or replace function private.email_local_part_reserved(p_local text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(p_local) = any (array[
    'abuse', 'admin', 'administrator', 'alerts', 'billing', 'bounce', 'bounces', 'hello', 'help',
    'hostmaster', 'inbound', 'info', 'mail', 'mailer-daemon', 'no-reply', 'noreply', 'postmaster',
    'replies', 'reply', 'root', 'security', 'support', 'team', 'webmaster', 'www'])
$$;

-- ---------- a workspace's own sending domain ----------
create table app.email_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  domain text not null unique
    check (domain = lower(domain) and length(domain) <= 253
      and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
      and domain !~ '(^|\.)handsfreeos\.com$'),
  provider_domain_id text,
  dkim_host text,
  dkim_value text,
  return_path_host text,
  return_path_value text,
  status app.email_domain_status not null default 'pending',
  dkim_verified_at timestamptz,
  return_path_verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index email_domains_workspace_idx on app.email_domains (workspace_id, created_at);
create trigger email_domains_updated_at before update on app.email_domains for each row execute function private.set_updated_at();
create trigger email_domains_immutable before update on app.email_domains for each row execute function private.forbid_tenant_column_change('workspace_id', 'domain', 'created_by');

-- ---------- sending addresses (the shared subdomain when email_domain_id is null) ----------
create table app.email_addresses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  email_domain_id uuid references app.email_domains (id) on delete cascade,
  local_part text not null
    check (local_part ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$' and local_part !~ '[._-]{2}'),
  address text not null unique check (address = lower(address) and position('@' in address) > 1),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  is_default boolean not null default false,
  verified_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index email_addresses_one_default on app.email_addresses (workspace_id) where is_default;
create index email_addresses_workspace_idx on app.email_addresses (workspace_id, created_at);
create trigger email_addresses_updated_at before update on app.email_addresses for each row execute function private.set_updated_at();
create trigger email_addresses_immutable before update on app.email_addresses for each row execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- The address follows from its name and domain. Addresses on a workspace domain wait for verification; one
-- that has sent mail keeps its name (replies and threads point at it).
create or replace function private.guard_email_address()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_domain text;
  v_status app.email_domain_status;
  v_workspace uuid;
begin
  if new.email_domain_id is null then
    if private.email_local_part_reserved(new.local_part) then
      raise exception 'That address is reserved' using errcode = '23514', detail = 'email_local_part_reserved';
    end if;
    v_domain := private.shared_mail_domain();
  else
    select d.domain, d.status, d.workspace_id into v_domain, v_status, v_workspace
    from app.email_domains d where d.id = new.email_domain_id;
    if v_workspace is distinct from new.workspace_id then
      raise exception 'Domain must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
    if v_status is distinct from 'verified' and (tg_op = 'INSERT' or new.is_default
        or old.email_domain_id is distinct from new.email_domain_id) then
      raise exception 'Verify the domain before sending from it' using errcode = '23514', detail = 'email_domain_unverified';
    end if;
  end if;
  new.address := new.local_part || '@' || v_domain;
  if tg_op = 'UPDATE' and (old.local_part is distinct from new.local_part or old.email_domain_id is distinct from new.email_domain_id)
     and exists (select 1 from app.messages m where m.email_address_id = old.id) then
    raise exception 'An address that has sent mail keeps its name' using errcode = '23514', detail = 'email_address_in_use';
  end if;
  return new;
end $$;

-- ---------- connected mailboxes ----------
create table app.mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  provider app.mailbox_provider not null,
  account_email text check (account_email is null or (account_email = lower(account_email) and position('@' in account_email) > 1)),
  display_name text check (display_name is null or length(display_name) <= 200),
  user_id uuid references app.users (id) on delete set null,
  shared boolean not null default false,
  scopes text[] not null default '{}',
  status app.mailbox_status not null default 'pending',
  oauth_state_hash text unique,
  oauth_state_expires_at timestamptz,
  pkce_verifier_enc text,
  token_enc text,
  token_key_id text,
  token_expires_at timestamptz,
  sync_cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(sync_cursor) = 'object'),
  subscription_id text unique,
  subscription_expires_at timestamptz,
  subscription_client_state_hash text,
  next_sync_at timestamptz,
  last_synced_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live connection per account in a workspace (a reconnect replaces the old one).
create unique index mailbox_connections_live_account on app.mailbox_connections (workspace_id, provider, account_email)
  where status <> 'disconnected' and account_email is not null;
create index mailbox_connections_sync_idx on app.mailbox_connections (next_sync_at) where status = 'active';
create trigger mailbox_connections_updated_at before update on app.mailbox_connections for each row execute function private.set_updated_at();
create trigger mailbox_connections_immutable before update on app.mailbox_connections for each row execute function private.forbid_tenant_column_change('workspace_id', 'provider', 'created_by');

-- People disconnect a mailbox; signing in, tokens and syncing are the worker's.
create or replace function private.guard_mailbox_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.status = 'disconnected' or new.status is distinct from 'disconnected' then
    raise exception 'People can only disconnect a mailbox' using errcode = '42501', detail = 'mailbox_status_transition';
  end if;
  new.disconnected_at := now();
  new.token_enc := null;
  new.pkce_verifier_enc := null;
  new.next_sync_at := null;
  return new;
end $$;
create trigger mailbox_connections_update_guard before update on app.mailbox_connections for each row execute function private.guard_mailbox_update();

-- ---------- suppressions: addresses that bounced, complained, or were stopped by hand ----------
create table app.email_suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  address text not null check (address = lower(address) and position('@' in address) > 1),
  reason app.suppression_reason not null,
  origin text check (origin is null or length(origin) <= 200),
  message_id uuid references app.messages (id) on delete set null,
  provider_ref text,
  released_at timestamptz,
  released_by uuid references app.users (id) on delete set null,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index email_suppressions_active on app.email_suppressions (workspace_id, address) where released_at is null;
create trigger email_suppressions_updated_at before update on app.email_suppressions for each row execute function private.set_updated_at();
create trigger email_suppressions_immutable before update on app.email_suppressions for each row execute function private.forbid_tenant_column_change('workspace_id', 'address', 'reason', 'created_by');

-- ---------- mail from someone we don't know, kept whole until it is claimed or dismissed ----------
create table app.email_inbound_unmatched (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  email_address_id uuid references app.email_addresses (id) on delete set null,
  delivery_id uuid references app.webhook_deliveries (id) on delete set null,
  from_address text not null check (from_address = lower(from_address) and position('@' in from_address) > 1),
  from_name text check (from_name is null or length(from_name) <= 200),
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text check (subject is null or length(subject) <= 998),
  snippet text check (snippet is null or length(snippet) <= 300),
  body_text text check (body_text is null or length(body_text) <= 100000),
  body_html text check (body_html is null or length(body_html) <= 1000000),
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  message_id_header text,
  in_reply_to_header text,
  references_headers text[] not null default '{}',
  received_at timestamptz not null default now(),
  resolved_person_id uuid references app.people (id) on delete set null,
  resolved_message_id uuid references app.messages (id) on delete set null,
  resolved_at timestamptz,
  resolved_by uuid references app.users (id) on delete set null,
  dismissed_at timestamptz,
  dismissed_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, message_id_header)
);
create index email_inbound_unmatched_open_idx on app.email_inbound_unmatched (workspace_id, received_at desc)
  where resolved_at is null and dismissed_at is null;
create trigger email_inbound_unmatched_updated_at before update on app.email_inbound_unmatched for each row execute function private.set_updated_at();
create trigger email_inbound_unmatched_immutable before update on app.email_inbound_unmatched for each row execute function private.forbid_tenant_column_change('workspace_id', 'from_address', 'message_id_header');

-- ---------- conversations and messages learn email ----------
alter table app.conversations
  add column email_address_id uuid references app.email_addresses (id) on delete set null,
  add column email_reply_token text unique check (email_reply_token is null or email_reply_token ~ '^[a-z2-7]{10}$');
alter table app.messages
  add column email_address_id uuid references app.email_addresses (id) on delete set null,
  add column mailbox_connection_id uuid references app.mailbox_connections (id) on delete set null;
-- Email bodies run longer than texts (core still caps a text at its own limit).
alter table app.messages drop constraint messages_body_text_check;
alter table app.messages add constraint messages_body_text_check check (body_text is null or length(body_text) <= 100000);
alter table app.messages add constraint messages_body_html_check check (body_html is null or length(body_html) <= 1000000);
create index messages_message_id_header_idx on app.messages (workspace_id, message_id_header) where message_id_header is not null;

-- Every email conversation gets a reply token (10 base32 characters): Reply-To carries it as the mailbox
-- hash, so a customer's answer finds its conversation whatever their mail program does to the headers.
create or replace function private.set_email_reply_token()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_token text := '';
begin
  if new.channel = 'email' and new.email_reply_token is null then
    for i in 0..9 loop
      v_token := v_token || substr(v_alphabet, (get_byte(v_bytes, i * 3) % 32) + 1, 1);
    end loop;
    new.email_reply_token := v_token;
  end if;
  return new;
end $$;
create trigger conversations_reply_token before insert on app.conversations for each row execute function private.set_email_reply_token();
create trigger conversations_reply_token_immutable before update on app.conversations for each row execute function private.forbid_tenant_column_change('email_reply_token');

-- ---------- references stay inside the workspace, whoever writes ----------
create or replace function private.check_email_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name in ('conversations', 'messages') then
    if new.email_address_id is not null and not exists (
        select 1 from app.email_addresses a where a.id = new.email_address_id and a.workspace_id = new.workspace_id) then
      raise exception 'Address must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
    if tg_table_name = 'messages' then
      if new.mailbox_connection_id is not null and not exists (
          select 1 from app.mailbox_connections mc where mc.id = new.mailbox_connection_id and mc.workspace_id = new.workspace_id) then
        raise exception 'Mailbox must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
      end if;
    end if;
  elsif tg_table_name = 'email_suppressions' then
    if new.message_id is not null and not exists (
        select 1 from app.messages m where m.id = new.message_id and m.workspace_id = new.workspace_id) then
      raise exception 'Message must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  elsif tg_table_name = 'email_inbound_unmatched' then
    if (new.email_address_id is not null and not exists (
          select 1 from app.email_addresses a where a.id = new.email_address_id and a.workspace_id = new.workspace_id))
       or (new.resolved_person_id is not null and not exists (
          select 1 from app.people p where p.id = new.resolved_person_id and p.workspace_id = new.workspace_id))
       or (new.resolved_message_id is not null and not exists (
          select 1 from app.messages m where m.id = new.resolved_message_id and m.workspace_id = new.workspace_id)) then
      raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
    end if;
  end if;
  return new;
end $$;
create trigger conversations_check_email_refs before insert or update of email_address_id on app.conversations for each row execute function private.check_email_refs();
create trigger messages_check_email_refs before insert or update of email_address_id, mailbox_connection_id on app.messages for each row execute function private.check_email_refs();
create trigger email_suppressions_check_refs before insert or update on app.email_suppressions for each row execute function private.check_email_refs();
create trigger email_inbound_unmatched_check_refs before insert or update on app.email_inbound_unmatched for each row execute function private.check_email_refs();
create trigger email_addresses_guard before insert or update on app.email_addresses for each row execute function private.guard_email_address();

-- A domain that holds the default address stays until another address is the default. Deleting the
-- workspace takes everything with it.
create or replace function private.guard_email_domain_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from app.workspaces w where w.id = old.workspace_id)
     and exists (select 1 from app.email_addresses a where a.email_domain_id = old.id and a.is_default) then
    raise exception 'Make another address the default before removing this domain' using errcode = '23514', detail = 'email_domain_in_use';
  end if;
  return old;
end $$;
create trigger email_domains_delete_guard before delete on app.email_domains for each row execute function private.guard_email_domain_delete();

-- ---------- every workspace gets its shared-subdomain address ----------
create or replace function private.ensure_default_email_address(p_workspace uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_slug text;
  v_name text;
  v_base text;
  v_local text;
  v_n int := 1;
begin
  select a.id into v_id from app.email_addresses a where a.workspace_id = p_workspace and a.is_default;
  if v_id is not null then
    return v_id;
  end if;
  select w.slug, w.name into v_slug, v_name from app.workspaces w where w.id = p_workspace;
  v_base := btrim(left(regexp_replace(lower(coalesce(v_slug, '')), '[^a-z0-9]+', '-', 'g'), 48), '-');
  if v_base = '' or private.email_local_part_reserved(v_base) then
    v_base := 'team-' || coalesce(nullif(v_base, ''), 'mail');
  end if;
  v_local := v_base;
  loop
    insert into app.email_addresses (workspace_id, local_part, address, display_name, is_default, verified_at)
    values (p_workspace, v_local, v_local || '@' || private.shared_mail_domain(), left(btrim(v_name), 120), true, now())
    on conflict (address) do nothing
    returning id into v_id;
    exit when v_id is not null;
    v_n := v_n + 1;
    v_local := v_base || '-' || v_n;
  end loop;
  return v_id;
end $$;

create or replace function private.handle_workspace_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.ensure_default_pipeline(new.id);
  perform private.ensure_default_email_address(new.id);
  return new;
end $$;

select private.ensure_default_email_address(w.id) from app.workspaces w order by w.created_at;

-- ---------- RLS ----------
alter table app.email_domains enable row level security;
alter table app.email_addresses enable row level security;
alter table app.mailbox_connections enable row level security;
alter table app.email_suppressions enable row level security;
alter table app.email_inbound_unmatched enable row level security;

create policy email_domains_select on app.email_domains for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy email_domains_insert on app.email_domains for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid())
    and status = 'pending' and provider_domain_id is null and dkim_verified_at is null and return_path_verified_at is null);
create policy email_domains_delete on app.email_domains for delete to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy email_domains_service_all on app.email_domains for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy email_addresses_select on app.email_addresses for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy email_addresses_insert on app.email_addresses for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid()));
create policy email_addresses_update on app.email_addresses for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy email_addresses_service_all on app.email_addresses for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy mailbox_connections_select on app.mailbox_connections for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy mailbox_connections_insert on app.mailbox_connections for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid())
    and user_id = (select auth.uid()) and status = 'pending');
create policy mailbox_connections_update on app.mailbox_connections for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy mailbox_connections_service_all on app.mailbox_connections for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy email_suppressions_select on app.email_suppressions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy email_suppressions_insert on app.email_suppressions for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid())
    and reason = 'manual' and released_at is null);
create policy email_suppressions_update on app.email_suppressions for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy email_suppressions_service_all on app.email_suppressions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy email_inbound_unmatched_select on app.email_inbound_unmatched for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy email_inbound_unmatched_update on app.email_inbound_unmatched for update to authenticated
  using (private.has_permission(workspace_id, 'inbox.use'))
  with check (private.has_permission(workspace_id, 'inbox.use'));
create policy email_inbound_unmatched_service_all on app.email_inbound_unmatched for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
grant select, insert, delete on app.email_domains to authenticated;
grant select, insert on app.email_addresses to authenticated;
grant update (local_part, email_domain_id, display_name, is_default) on app.email_addresses to authenticated;
-- Members see a mailbox's state, never its sealed tokens or sign-in secrets.
grant select (id, workspace_id, provider, account_email, display_name, user_id, shared, scopes, status,
  token_expires_at, next_sync_at, last_synced_at, last_error, connected_at, disconnected_at, created_by,
  created_at, updated_at) on app.mailbox_connections to authenticated;
grant insert (workspace_id, provider, user_id, shared, status, oauth_state_hash, oauth_state_expires_at, created_by)
  on app.mailbox_connections to authenticated;
grant update (status) on app.mailbox_connections to authenticated;
grant select, insert on app.email_suppressions to authenticated;
grant update (released_at, released_by) on app.email_suppressions to authenticated;
grant select on app.email_inbound_unmatched to authenticated;
grant update (resolved_person_id, resolved_at, resolved_by, dismissed_at, dismissed_by) on app.email_inbound_unmatched to authenticated;

grant select, insert, update, delete on app.email_domains, app.email_addresses, app.mailbox_connections,
  app.email_suppressions, app.email_inbound_unmatched to service_actor;
revoke all on app.email_domains, app.email_addresses, app.mailbox_connections, app.email_suppressions,
  app.email_inbound_unmatched from anon;

-- ---------- lookups for the worker's HTTP routes (the tenant is not known yet) ----------
-- Inbound mail: which workspace owns the address it was sent to.
create or replace function private.email_address_route(p_address text)
returns table (email_address_id uuid, workspace_id uuid, organization_id uuid, address text, display_name text)
language sql stable security definer set search_path = '' as $$
  select a.id, a.workspace_id, w.organization_id, a.address, a.display_name
  from app.email_addresses a join app.workspaces w on w.id = a.workspace_id
  where a.address = lower(p_address)
$$;

-- Inbound mail: the conversation a Reply-To token names.
create or replace function private.conversation_by_reply_token(p_token text)
returns table (conversation_id uuid, workspace_id uuid, organization_id uuid, email_address_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, w.organization_id, c.email_address_id
  from app.conversations c join app.workspaces w on w.id = c.workspace_id
  where c.email_reply_token = lower(p_token)
$$;

-- Mailbox sign-in: the pending connection a one-time state (hashed) belongs to.
create or replace function private.mailbox_connection_by_state(p_state_hash text)
returns table (connection_id uuid, workspace_id uuid, organization_id uuid, provider app.mailbox_provider,
  status app.mailbox_status, user_id uuid, state_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select mc.id, mc.workspace_id, w.organization_id, mc.provider, mc.status, mc.user_id, mc.oauth_state_expires_at
  from app.mailbox_connections mc join app.workspaces w on w.id = mc.workspace_id
  where mc.oauth_state_hash = p_state_hash
$$;

-- Outlook change notifications: the connection a subscription belongs to.
create or replace function private.mailbox_connection_by_subscription(p_subscription_id text)
returns table (connection_id uuid, workspace_id uuid, organization_id uuid, client_state_hash text)
language sql stable security definer set search_path = '' as $$
  select mc.id, mc.workspace_id, w.organization_id, mc.subscription_client_state_hash
  from app.mailbox_connections mc join app.workspaces w on w.id = mc.workspace_id
  where mc.subscription_id = p_subscription_id and mc.status = 'active'
$$;

revoke all on function
  private.shared_mail_domain(), private.email_local_part_reserved(text), private.guard_email_address(),
  private.guard_mailbox_update(), private.set_email_reply_token(), private.check_email_refs(),
  private.guard_email_domain_delete(), private.ensure_default_email_address(uuid),
  private.email_address_route(text), private.conversation_by_reply_token(text),
  private.mailbox_connection_by_state(text), private.mailbox_connection_by_subscription(text)
  from public;
grant execute on function
  private.shared_mail_domain(), private.email_local_part_reserved(text), private.guard_email_address(),
  private.guard_mailbox_update(), private.set_email_reply_token(), private.check_email_refs(),
  private.guard_email_domain_delete()
  to authenticated, service_actor;
grant execute on function
  private.email_address_route(text), private.conversation_by_reply_token(text),
  private.mailbox_connection_by_state(text), private.mailbox_connection_by_subscription(text)
  to service_actor;
