-- =============================================================================
-- Bringing a number that already lives in Twilio.
--
--        Two places a business's number is usually sitting before it comes
--        here, and neither is a carrier port:
--
--          twilio     the business's own Twilio account (often the one a
--                     GoHighLevel agency plugged in as "bring your own
--                     Twilio"). They connect it, we list what is in it, and
--                     they say which workspace each number is for.
--          highlevel  a GoHighLevel / LeadConnector "LC Phone" number, which
--                     is a Twilio number in HighLevel's own Twilio account.
--
--        Either way the number moves **account to account inside Twilio**:
--        the public number never changes, no losing carrier is asked, and it
--        takes days rather than the weeks a port does. What moves it is a
--        request the owner makes (to Twilio, or to HighLevel's support) to
--        transfer it into the workspace's own subaccount — the one every
--        number here lives in (parent account → one subaccount per workspace
--        → that workspace's numbers). Twilio's API only moves numbers between
--        accounts under one parent, so a number in somebody else's account
--        cannot be pulled; it has to be sent.
--
--        So HandsFreeOS's half is to **watch for it**. An import is written
--        down, the worker looks in the workspace's subaccount every few
--        minutes, and the moment the number is there it is pointed at our
--        webhooks, put on the messaging service and made one of the
--        business's numbers. Nobody presses anything when it lands.
--
--        **The number is claimed when it lands, not before.** A `porting`
--        row would take the number off the market while we wait, and a
--        waiting import proves nothing: anybody can type anybody's number.
--        The number arriving in *this workspace's own subaccount* is the
--        proof, because only its owner could have sent it there. Until then
--        an import holds nothing, exactly as a port's draft holds nothing.
--
--        **Setting the number up is not registering it for texting.** An
--        import finishes when calls and texts reach the inbox; whether the
--        carriers will let texts *out* (A2P 10DLC, or toll-free
--        verification) is app.telephony_registrations, and stays there. A
--        HighLevel number's registration belongs to HighLevel's brand and
--        does not move with it. The two are shown side by side, never merged.
--
--        **A connected account's secret is sealed by the worker** and no
--        person can select it, as with a subaccount's token. A connection
--        belongs to the organization, because one Twilio account commonly
--        holds numbers for several of its businesses, and only the
--        organization's owners and admins can see one: listing what is in
--        it lists every business's numbers.
-- =============================================================================

create type app.number_import_source as enum ('twilio', 'highlevel');
create type app.number_import_status as enum ('waiting', 'complete', 'failed', 'cancelled');
create type app.twilio_connection_status as enum ('active', 'broken', 'disconnected');

-- ---------- a Twilio account a business connected, so we can see what is in it ----------
create table app.twilio_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  account_sid text not null check (account_sid ~ '^AC[A-Za-z0-9]{8,40}$'),
  friendly_name text check (friendly_name is null or length(friendly_name) <= 200),
  -- The API key they gave us (SK…), or null when they gave the account's own auth token. A key is the better
  -- thing to give: they can revoke it in Twilio without touching anything else.
  api_key_sid text check (api_key_sid is null or api_key_sid ~ '^SK[A-Za-z0-9]{8,40}$'),
  -- The auth token or the key's secret, sealed by the worker. Cleared when the connection is let go.
  secret_enc text,
  key_id text,
  status app.twilio_connection_status not null default 'active',
  last_error text check (last_error is null or length(last_error) <= 2000),
  checked_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, account_sid)
);

comment on table app.twilio_connections is
  'A Twilio account a business connected so HandsFreeOS can list its numbers and bring them in. The secret is '
  'sealed by the worker and never selectable by a person; only the organization''s owners and admins see a row.';

create trigger twilio_connections_updated_at before update on app.twilio_connections
  for each row execute function private.set_updated_at();
create trigger twilio_connections_immutable before update on app.twilio_connections
  for each row execute function private.forbid_tenant_column_change('organization_id', 'account_sid', 'created_by');

alter table app.twilio_connections enable row level security;

-- Owners and admins of the organization, and nobody else: what is in the account is every business's numbers.
create policy twilio_connections_select on app.twilio_connections for select to authenticated
  using (private.org_role(organization_id) in ('owner', 'admin'));
-- Every write is the worker's: connecting means checking the credentials with Twilio and sealing them, and
-- letting go means wiping the secret. A person asks for both through the worker's own routes.
create policy twilio_connections_service_all on app.twilio_connections for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

revoke all on app.twilio_connections from public;
grant select (id, organization_id, account_sid, friendly_name, api_key_sid, status, last_error, checked_at,
  created_by, created_at, updated_at) on app.twilio_connections to authenticated;
grant select, insert, update, delete on app.twilio_connections to service_actor;

-- ---------- a number on its way in, account to account ----------
create table app.number_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  source app.number_import_source not null,
  status app.number_import_status not null default 'waiting',

  -- ---- where it is today ----
  -- The connected account it was picked from, when it was picked rather than typed in.
  connection_id uuid references app.twilio_connections (id) on delete set null,
  -- The account holding it now (AC…) and its own id there (PN…). What the transfer request names.
  source_account_sid text check (source_account_sid is null or source_account_sid ~ '^AC[A-Za-z0-9]{8,40}$'),
  source_number_sid text check (source_number_sid is null or source_number_sid ~ '^PN[A-Za-z0-9]{8,40}$'),

  -- ---- who hosts it, by the carrier lookup: the worker's alone ----
  -- "Twilio - SMS/MMS-SVR" for a Twilio number, which is what says a HighLevel number can move account to
  -- account rather than needing a port.
  carrier_name text check (carrier_name is null or length(carrier_name) <= 200),
  hosted_in_twilio boolean,
  looked_up_at timestamptz,

  -- ---- where it is going, and what landed: the worker's alone ----
  account_id uuid references app.telephony_accounts (id) on delete set null,
  -- The workspace's own subaccount (AC…): the account the owner asks for it to be sent to.
  destination_account_sid text check (destination_account_sid is null
    or destination_account_sid ~ '^AC[A-Za-z0-9]{8,40}$'),
  -- The number's id in that subaccount once it is there (PN…).
  provider_sid text,
  phone_number_id uuid references app.phone_numbers (id) on delete set null,
  number_type app.phone_number_type,
  last_error text check (last_error is null or length(last_error) <= 2000),
  next_poll_at timestamptz,
  poll_count int not null default 0 check (poll_count >= 0),
  last_checked_at timestamptz,
  completed_at timestamptz,

  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table app.number_imports is
  'A number moving account to account inside Twilio (from the business''s own Twilio, or HighLevel''s). The '
  'worker watches the workspace''s subaccount and finishes it when the number arrives. Separate from carrier '
  'registration (app.telephony_registrations): a number can be here and working while texting still waits.';

-- One open import of a number per business: asking twice is a mistake, not a second request. Nothing is
-- global while waiting — see the header — so another business watching for the same number takes nothing
-- from this one. Only one of them can ever receive it.
create unique index number_imports_one_open on app.number_imports (workspace_id, e164) where status = 'waiting';
create index number_imports_workspace_idx on app.number_imports (workspace_id, created_at desc);
create index number_imports_poll_idx on app.number_imports (next_poll_at) where status = 'waiting';

create trigger number_imports_updated_at before update on app.number_imports
  for each row execute function private.set_updated_at();
create trigger number_imports_immutable before update on app.number_imports
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'e164', 'source', 'created_by');

-- ---------- what a person may write ----------
-- A person starts an import and may call it off. Everything the worker learns — who hosts the number, where it
-- is going, that it arrived — is the worker's, because a business that could write `provider_sid` or
-- `phone_number_id` could claim to have received a number it never did.
create or replace function private.guard_number_import()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'waiting' or new.carrier_name is not null or new.hosted_in_twilio is not null
       or new.looked_up_at is not null or new.account_id is not null or new.destination_account_sid is not null
       or new.provider_sid is not null or new.phone_number_id is not null or new.number_type is not null
       or new.last_error is not null or new.next_poll_at is not null or new.poll_count <> 0
       or new.last_checked_at is not null or new.completed_at is not null then
      raise exception 'Only HandsFreeOS records where a number is and whether it arrived'
        using errcode = '42501', detail = 'number_import_provider_fields';
    end if;
    return new;
  end if;
  if old.connection_id is distinct from new.connection_id
     or old.source_account_sid is distinct from new.source_account_sid
     or old.source_number_sid is distinct from new.source_number_sid
     or old.carrier_name is distinct from new.carrier_name
     or old.hosted_in_twilio is distinct from new.hosted_in_twilio
     or old.looked_up_at is distinct from new.looked_up_at
     or old.account_id is distinct from new.account_id
     or old.destination_account_sid is distinct from new.destination_account_sid
     or old.provider_sid is distinct from new.provider_sid
     or old.phone_number_id is distinct from new.phone_number_id
     or old.number_type is distinct from new.number_type
     or old.last_error is distinct from new.last_error
     or old.next_poll_at is distinct from new.next_poll_at
     or old.poll_count is distinct from new.poll_count
     or old.last_checked_at is distinct from new.last_checked_at
     or old.completed_at is distinct from new.completed_at then
    raise exception 'Only HandsFreeOS records where a number is and whether it arrived'
      using errcode = '42501', detail = 'number_import_provider_fields';
  end if;
  if old.status is distinct from new.status and not (old.status = 'waiting' and new.status = 'cancelled') then
    raise exception 'People can only call off a number that has not arrived yet'
      using errcode = '42501', detail = 'number_import_status_transition';
  end if;
  return new;
end $$;
create trigger number_imports_guard before insert or update on app.number_imports
  for each row execute function private.guard_number_import();

-- ---------- references stay inside the business ----------
-- A connection is the organization's, so an import may point at one of its own organization's; the account and
-- the number are the workspace's own. The same rule private.check_messaging_refs keeps for the rest.
create or replace function private.check_number_import_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.connection_id is not null and not exists (
       select 1 from app.twilio_connections c join app.workspaces w on w.organization_id = c.organization_id
       where c.id = new.connection_id and w.id = new.workspace_id)
     or (new.account_id is not null and not exists (
       select 1 from app.telephony_accounts a where a.id = new.account_id and a.workspace_id = new.workspace_id))
     or (new.phone_number_id is not null and not exists (
       select 1 from app.phone_numbers n where n.id = new.phone_number_id and n.workspace_id = new.workspace_id)) then
    raise exception 'Reference crosses workspaces' using errcode = '23514', detail = 'cross_workspace_reference';
  end if;
  return new;
end $$;
create trigger number_imports_check_refs before insert or update on app.number_imports
  for each row execute function private.check_number_import_refs();

-- ---------- who may see it ----------
-- The same permission as buying, porting or releasing a number, because it is the same decision.
alter table app.number_imports enable row level security;

create policy number_imports_select on app.number_imports for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy number_imports_insert on app.number_imports for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = auth.uid());
create policy number_imports_update on app.number_imports for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'))
  with check (private.has_permission(workspace_id, 'channels.manage'));
create policy number_imports_service_all on app.number_imports for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.number_imports from public;
-- No delete: an import that was called off says so, like a port.
grant select, insert, update on app.number_imports to authenticated;
grant select, insert, update, delete on app.number_imports to service_actor;

-- ---------- which business already has a number, across businesses ----------
-- The worker's routes and jobs see one business at a time, and two questions need all of them: listing a
-- connected account ("this one is already in HandsFreeOS") and landing a number ("another business still holds
-- this"). Answers with the workspace, which the caller only ever shows by name inside the asker's own
-- organization. The worker's alone.
create or replace function private.number_held_by(p_e164 text)
returns table (workspace_id uuid, organization_id uuid, workspace_name text)
language sql stable security definer set search_path = '' as $$
  select n.workspace_id, w.organization_id, w.name
  from app.phone_numbers n join app.workspaces w on w.id = n.workspace_id
  where n.e164 = p_e164 and n.status in ('provisioning', 'porting', 'active', 'releasing')
$$;

-- Which of an organization's businesses are already waiting for which numbers, for listing a connected account
-- ("already on its way to Main Street"). The worker's scope is one business at a time; this is the one question
-- it asks about all of an organization's at once. The worker's alone.
create or replace function private.number_imports_waiting(p_org uuid)
returns table (e164 text, workspace_id uuid, workspace_name text)
language sql stable security definer set search_path = '' as $$
  select i.e164, i.workspace_id, w.name
  from app.number_imports i join app.workspaces w on w.id = i.workspace_id
  where w.organization_id = p_org and i.status = 'waiting'
$$;

-- Whether a user may connect a Twilio account to an organization, for the worker's routes (which cannot
-- switch to `authenticated`, so ask for a user by id — the twin of private.user_has_permission).
create or replace function private.user_manages_organization(p_user uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.organization_memberships om
    where om.organization_id = p_org and om.user_id = p_user and om.role in ('owner', 'admin')
  )
$$;

revoke all on function private.guard_number_import() from public;
revoke all on function private.check_number_import_refs() from public;
revoke all on function private.number_held_by(text) from public;
revoke all on function private.number_imports_waiting(uuid) from public;
revoke all on function private.user_manages_organization(uuid, uuid) from public;
grant execute on function private.number_held_by(text) to service_actor;
grant execute on function private.number_imports_waiting(uuid) to service_actor;
grant execute on function private.user_manages_organization(uuid, uuid) to service_actor;
