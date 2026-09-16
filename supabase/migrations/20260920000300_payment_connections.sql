-- =============================================================================
-- 0046 · The accounts money is paid into. One row per account a business has
--        connected, so a business can have several at once — including two of
--        the same provider — and choose which one each document is paid into.
--        Stripe and Square are connected by signing in; PayPal, NMI and
--        Authorize.net are named in the provider type now so the seam is the
--        same when they arrive. Tokens are sealed by the worker and never
--        readable by `authenticated`, exactly like mailboxes (0012) and
--        calendars (0017). People rename an account, choose the default and
--        disconnect one; everything the provider decides is the worker's.
--        Credentials are found again by (provider, account id), never by the
--        connection row and never filtered by status: a bank transfer settles
--        days after a disconnect, and reconnecting the same account restores
--        the ability to refund every old payment.
-- =============================================================================

-- All five now: the two that ship, and the three that follow on the same seam.
create type app.payment_provider as enum ('stripe', 'square', 'paypal', 'nmi', 'authorize_net');
-- A test account so the first real payment isn't a client's.
create type app.payment_environment as enum ('live', 'test');
create type app.payment_connection_status as enum ('pending', 'active', 'reauth_required', 'error', 'disconnected');

create table app.payment_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  provider app.payment_provider not null,
  environment app.payment_environment not null default 'live',
  status app.payment_connection_status not null default 'pending',
  -- The provider's own id for the account (Stripe's acct_…, Square's merchant id) and, for Square, the
  -- location money is taken at.
  external_account_id text check (external_account_id is null or length(btrim(external_account_id)) between 1 and 200),
  location_id text check (location_id is null or length(btrim(location_id)) between 1 and 200),
  -- What the business calls it ("Main account"), and what the provider calls it.
  label text check (label is null or length(btrim(label)) between 1 and 60),
  display_name text check (display_name is null or length(btrim(display_name)) between 1 and 200),
  is_default boolean not null default false,
  -- What this account can do: card, bank transfer, subscriptions, refunds.
  capabilities jsonb not null default '{}'::jsonb
    check (jsonb_typeof(capabilities) = 'object' and pg_column_size(capabilities) <= 16384),
  scopes text[] not null default '{}',
  -- The sign-in: a one-time state (hashed) and the PKCE verifier, both sealed and both gone once it finishes.
  oauth_state_hash text unique,
  oauth_state_expires_at timestamptz,
  pkce_verifier_enc text,
  token_enc text,
  token_key_id text,
  token_expires_at timestamptz,
  -- Square's token expires in 30 days, so a per-connection refresh runs weekly with an hourly re-arm.
  next_refresh_at timestamptz,
  failures integer not null default 0 check (failures between 0 and 1000000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  -- Why it ended: a person disconnected it, the provider revoked it (Square) or deauthorized it (Stripe), it
  -- failed too often, or a reconnect of the same account replaced it.
  disconnected_reason text check (disconnected_reason is null
    or disconnected_reason in ('person', 'revoked', 'deauthorized', 'failed', 'replaced')),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'disconnected') = (disconnected_at is not null)),
  check (disconnected_at is not null or disconnected_reason is null),
  -- A disconnected account is never the one new documents are paid into.
  check (not is_default or status <> 'disconnected')
);
-- One live connection per account: reconnecting the same account disconnects the old row first. Unfinished
-- sign-ins have no account id yet and may pile up until they expire.
create unique index payment_connections_live_account on app.payment_connections
  (workspace_id, provider, environment, external_account_id)
  where status <> 'disconnected' and external_account_id is not null;
-- One default per business and environment.
create unique index payment_connections_one_default on app.payment_connections (workspace_id, environment)
  where is_default and status <> 'disconnected';
-- The weekly token refresh.
create index payment_connections_refresh_idx on app.payment_connections (next_refresh_at) where status = 'active';
-- Routing a webhook, and finding the credentials for a refund years later.
create index payment_connections_account_idx on app.payment_connections (provider, external_account_id)
  where external_account_id is not null;
create trigger payment_connections_updated_at before update on app.payment_connections for each row
  execute function private.set_updated_at();
create trigger payment_connections_immutable before update on app.payment_connections for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'provider', 'environment', 'created_by');

-- ---------- what people may change ----------
-- While an account is connected, people rename it and choose the default. Otherwise the only move they may
-- make is to disconnect it, and the secrets go on the way out — which is exactly why refunds resolve
-- credentials by account id instead. Everything else (signing in, tokens, capabilities, failures, the
-- provider's own answers) is the worker's; the column grants below hold the same line.
create or replace function private.guard_payment_connection_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if new.status is not distinct from old.status then
    if old.status <> 'active' then
      raise exception 'Only a connected account can be renamed or made the default'
        using errcode = '42501', detail = 'payment_connection_not_active';
    end if;
    return new;
  end if;
  if old.status = 'disconnected' or new.status <> 'disconnected' then
    raise exception 'People can only disconnect a payment account'
      using errcode = '42501', detail = 'payment_connection_status_transition';
  end if;
  new.disconnected_at := now();
  new.disconnected_reason := 'person';
  new.is_default := false;
  new.next_refresh_at := null;
  new.token_enc := null;
  new.token_key_id := null;
  new.pkce_verifier_enc := null;
  new.oauth_state_hash := null;
  new.oauth_state_expires_at := null;
  return new;
end $$;
create trigger payment_connections_update_guard before update on app.payment_connections for each row
  execute function private.guard_payment_connection_update();

-- ---------- references stay inside the workspace, whoever writes ----------
create or replace function private.check_payment_connection_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if new.created_by is not null and not private.workspace_has_user(new.workspace_id, new.created_by) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger payment_connections_check_refs before insert on app.payment_connections for each row
  execute function private.check_payment_connection_refs();

-- ---------- the account an invoice is paid into (the column is declared in 0045) ----------
alter table app.invoices
  add constraint invoices_connection_id_fkey
  foreign key (connection_id) references app.payment_connections (id) on delete set null;

-- An invoice is paid into an account of its own business.
create or replace function private.check_invoice_connection()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.connection_id is not null and not exists (
       select 1 from app.payment_connections c
       where c.id = new.connection_id and c.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger invoices_check_connection before insert or update of connection_id on app.invoices
  for each row execute function private.check_invoice_connection();

-- ---------- RLS: only owners and admins ever see a connected account ----------
alter table app.payment_connections enable row level security;

create policy payment_connections_select on app.payment_connections for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage'));
-- Starting a sign-in. The insert is granted on the whole table, so the policy keeps tokens and results out.
create policy payment_connections_insert on app.payment_connections for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and created_by = (select auth.uid())
    and status = 'pending' and external_account_id is null and pkce_verifier_enc is null and token_enc is null
    and token_key_id is null and token_expires_at is null and next_refresh_at is null and connected_at is null
    and disconnected_at is null and failures = 0 and not is_default);
create policy payment_connections_update on app.payment_connections for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy payment_connections_service_all on app.payment_connections for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
-- People see an account's state, never its sealed token or its sign-in secrets. RETURNING must name columns
-- from this list (a bare RETURNING * would ask for the token and be refused).
grant select (id, workspace_id, provider, environment, status, external_account_id, location_id, label,
  display_name, is_default, capabilities, scopes, token_expires_at, next_refresh_at, failures, last_error,
  disconnected_reason, connected_at, disconnected_at, created_by, created_at, updated_at)
  on app.payment_connections to authenticated;
grant insert on app.payment_connections to authenticated;
grant update (status, label, is_default) on app.payment_connections to authenticated;
grant select, insert, update, delete on app.payment_connections to service_actor;
revoke all on app.payment_connections from anon;

-- ---------- lookups for the worker's HTTP routes (the tenant is not known yet) ----------
-- Which business an event or a refund belongs to, by the account it names. Deliberately not filtered by
-- status: a bank transfer settles days after a disconnect, a dispute arrives weeks later, and a refund of an
-- old payment must still find its way home. A reconnected account has a live row and an old disconnected one,
-- so the live row comes first.
create or replace function private.payment_connection_by_account(p_provider text, p_external_id text)
returns table (connection_id uuid, workspace_id uuid, organization_id uuid, environment text)
language sql stable security definer set search_path = '' as $$
  select pc.id, pc.workspace_id, w.organization_id, pc.environment::text
  from app.payment_connections pc join app.workspaces w on w.id = pc.workspace_id
  where pc.provider::text = p_provider and pc.external_account_id = p_external_id
  order by pc.disconnected_at nulls first, pc.created_at desc
$$;

-- The pending mailbox, calendar or payment sign-in a one-time state (hashed) belongs to. All three share
-- /oauth/:provider/callback. A payment account belongs to the business, not to a person, so user_id is null.
create or replace function private.oauth_connection_by_state(p_state_hash text)
returns table (kind text, connection_id uuid, workspace_id uuid, organization_id uuid, provider text,
  status text, user_id uuid, state_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'mailbox', mc.id, mc.workspace_id, w.organization_id, mc.provider::text, mc.status::text, mc.user_id,
    mc.oauth_state_expires_at
  from app.mailbox_connections mc join app.workspaces w on w.id = mc.workspace_id
  where mc.oauth_state_hash = p_state_hash
  union all
  select 'calendar', cc.id, cc.workspace_id, w.organization_id, cc.provider::text, cc.status::text, cc.user_id,
    cc.oauth_state_expires_at
  from app.calendar_connections cc join app.workspaces w on w.id = cc.workspace_id
  where cc.oauth_state_hash = p_state_hash
  union all
  select 'payment', pc.id, pc.workspace_id, w.organization_id, pc.provider::text, pc.status::text, null::uuid,
    pc.oauth_state_expires_at
  from app.payment_connections pc join app.workspaces w on w.id = pc.workspace_id
  where pc.oauth_state_hash = p_state_hash
$$;

-- ---------- function privileges ----------
revoke all on function
  private.guard_payment_connection_update(), private.check_payment_connection_refs(),
  private.check_invoice_connection(), private.payment_connection_by_account(text, text)
  from public;
grant execute on function
  private.guard_payment_connection_update(), private.check_payment_connection_refs(),
  private.check_invoice_connection()
  to authenticated, service_actor;
grant execute on function private.payment_connection_by_account(text, text) to service_actor;
grant execute on function private.oauth_connection_by_state(text) to service_actor;
