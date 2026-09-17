-- =============================================================================
-- 0064 · Moving a business here from the CRM it uses today. One connection to
--        the old system, one migration, and one row per sub-account it holds
--        ("a scope"), each pointed at the business here that receives it.
--
--        The shape is deliberately not "a GoHighLevel importer": the source is
--        named by `source_system`, and everything after the read is the same
--        whichever system it came from. GoHighLevel is the first one; HubSpot,
--        Jobber and the rest are another adapter, not another set of tables.
--
--        Order of the day:
--          connect  → the agency or the single sub-account authorizes us, and
--                     the tokens are sealed by the worker exactly as mailboxes
--                     (0012), calendars (0017) and payment accounts (0046) are;
--          scan     → read-only. It counts what is there, says how sure each
--                     count is, and writes a finding wherever the old system
--                     holds something this one cannot hold the same way;
--          choose   → which sub-accounts, which businesses they land in, and
--                     which categories. Everything importable starts chosen;
--          import   → the engine (0065), which never runs before this is done.
--
--        Chris chose (2026-09-17) that several old sub-accounts may land in one
--        business here — so `migration_scopes` has no one-workspace rule, and
--        the page says plainly what that mixes together.
-- =============================================================================

-- ---------- what a source is ----------
-- The systems an adapter exists for, or is being written for. A row's adapter is found by this name, so a
-- name lands here before its adapter ships and the scan reports it as not ready.
create type app.migration_source as enum (
  'gohighlevel', 'hubspot', 'salesforce', 'jobber', 'housecall_pro', 'servicetitan', 'follow_up_boss'
);
-- An agency sign-in reaches many sub-accounts; a location sign-in reaches exactly one.
create type app.migration_install_kind as enum ('agency', 'location');
create type app.migration_connection_status as enum (
  'pending', 'active', 'reauth_required', 'error', 'disconnected'
);

-- Where a migration is, as a person reads it. `transition` is the one-way catch-up after the first import,
-- while the old system is still the one the business works in.
create type app.migration_status as enum (
  'draft', 'connected', 'scanning', 'scanned', 'ready', 'importing', 'paused', 'verifying',
  'imported', 'transition', 'finalizing', 'completed', 'needs_attention', 'failed',
  'cancelling', 'cancelled', 'rolling_back', 'rolled_back'
);
-- One sub-account's own state inside a migration. The whole never hides a part that went wrong.
create type app.migration_scope_status as enum (
  'discovered', 'skipped', 'mapped', 'scanning', 'scanned', 'ready', 'importing', 'paused',
  'verifying', 'imported', 'transition', 'completed', 'needs_attention', 'failed',
  'rolling_back', 'rolled_back'
);

-- How sure a count is. The difference matters: nothing found because there is nothing is not the same
-- answer as nothing found because we were not allowed to look.
create type app.migration_count_quality as enum (
  'complete',            -- enumerated, or the source gave its own total
  'estimated',           -- sampled or extrapolated
  'permission_limited',  -- the sign-in does not reach it
  'not_enumerable',      -- the source exposes no way to count it
  'unknown'
);

-- What this system can do with a category, which is not the same question as whether a job succeeded.
-- Every one of these implies a different answer for the person reading it, so they never fold into "warning".
create type app.migration_capability as enum (
  'ready',                -- comes across whole
  'needs_review',         -- comes across, with something named that does not fit exactly
  'action_required',      -- the history comes across; something must be reconnected for it to work live
  'port_required',        -- a phone number: discovered here, moved by the carrier
  'not_available',        -- the source will not give it to us (its API, or this sign-in's reach)
  'not_supported',        -- the source has it and HandsFreeOS has nowhere to put it yet
  'not_imported',         -- left out on purpose (automations)
  'not_in_release'        -- detected and counted, not built yet (websites, funnels)
);

-- How serious a finding is. `blocking` is rare and always names what to do about it.
create type app.migration_finding_severity as enum ('info', 'review', 'action', 'blocking');

-- ---------- the connection ----------
-- One authorized sign-in to the old system. Tokens are the worker's; `authenticated` may never read them,
-- which the column grants at the bottom hold as well as the policies.
create table app.migration_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  source_system app.migration_source not null,
  install_kind app.migration_install_kind not null default 'location',
  status app.migration_connection_status not null default 'pending',
  -- What the source calls the account this reaches: an agency id, or one sub-account's id.
  external_account_id text check (external_account_id is null or length(btrim(external_account_id)) between 1 and 200),
  display_name text check (display_name is null or length(btrim(display_name)) between 1 and 200),
  -- What the sign-in was actually granted, and what an all-categories import would want. The difference is
  -- what the scan turns into "permission_limited", and what "Reconnect with more access" asks for.
  scopes text[] not null default '{}',
  missing_scopes text[] not null default '{}',
  -- The sign-in: a one-time state (hashed) and the PKCE verifier, both sealed, both gone once it finishes.
  oauth_state_hash text unique,
  oauth_state_expires_at timestamptz,
  pkce_verifier_enc text,
  token_enc text,
  token_key_id text,
  token_expires_at timestamptz,
  next_refresh_at timestamptz,
  -- The adapter build that last spoke to this connection, so a payload read months ago can be read back
  -- through the mapping that produced it.
  adapter_version text check (adapter_version is null or length(btrim(adapter_version)) between 1 and 40),
  failures integer not null default 0 check (failures between 0 and 1000000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  disconnected_reason text check (disconnected_reason is null
    or disconnected_reason in ('person', 'revoked', 'failed', 'replaced', 'finalized')),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'disconnected') = (disconnected_at is not null)),
  check (disconnected_at is not null or disconnected_reason is null)
);
-- One live connection per account. Reconnecting the same one disconnects the old row first; unfinished
-- sign-ins have no account id yet and may pile up until they expire.
create unique index migration_connections_live_account on app.migration_connections
  (organization_id, source_system, external_account_id)
  where status <> 'disconnected' and external_account_id is not null;
create index migration_connections_org_idx on app.migration_connections (organization_id, created_at desc);
create index migration_connections_refresh_idx on app.migration_connections (next_refresh_at)
  where status = 'active';
create trigger migration_connections_updated_at before update on app.migration_connections
  for each row execute function private.set_updated_at();
create trigger migration_connections_immutable before update on app.migration_connections
  for each row execute function private.forbid_tenant_column_change('organization_id', 'source_system', 'created_by');

-- While a connection is live, the only thing a person changes is its name; the only other move they may make
-- is to disconnect it, and the secrets go on the way out. Everything else is the worker's.
create or replace function private.guard_migration_connection_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_organization() = new.organization_id, false) then
    return new;
  end if;
  if new.status is not distinct from old.status then
    if old.status = 'disconnected' then
      raise exception 'A disconnected source cannot be renamed'
        using errcode = '42501', detail = 'migration_connection_disconnected';
    end if;
    return new;
  end if;
  if old.status = 'disconnected' or new.status <> 'disconnected' then
    raise exception 'People can only disconnect a source'
      using errcode = '42501', detail = 'migration_connection_status_transition';
  end if;
  new.disconnected_at := now();
  new.disconnected_reason := 'person';
  new.next_refresh_at := null;
  new.token_enc := null;
  new.token_key_id := null;
  new.pkce_verifier_enc := null;
  new.oauth_state_hash := null;
  new.oauth_state_expires_at := null;
  return new;
end $$;
create trigger migration_connections_update_guard before update on app.migration_connections
  for each row execute function private.guard_migration_connection_update();

-- ---------- the migration ----------
create table app.migrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  connection_id uuid not null references app.migration_connections (id) on delete cascade,
  source_system app.migration_source not null,
  status app.migration_status not null default 'draft',
  -- What the business calls this move ("Lone Star off GoHighLevel").
  name text not null check (length(btrim(name)) between 1 and 120),
  -- Chosen at the review step and then fixed: bring the history once, or keep catching up until cutover.
  transition_enabled boolean not null default true,
  -- Chris chose 30 days, extendable, with a reminder at 7 left. Null until the first import finishes.
  transition_ends_at timestamptz,
  transition_extended_count integer not null default 0 check (transition_extended_count between 0 and 100),
  -- The advanced switch: bring records the old system has in its trash. Off by default.
  include_deleted boolean not null default false,
  -- Where the whole stands, rolled up from the scopes by the engine (never written by a person).
  totals jsonb not null default '{}'::jsonb
    check (jsonb_typeof(totals) = 'object' and pg_column_size(totals) <= 65536),
  adapter_version text check (adapter_version is null or length(btrim(adapter_version)) between 1 and 40),
  mapping_version integer not null default 1 check (mapping_version between 1 and 1000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  started_at timestamptz,
  imported_at timestamptz,
  finalized_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index migrations_org_idx on app.migrations (organization_id, created_at desc);
create index migrations_connection_idx on app.migrations (connection_id);
-- The nightly check on transition windows about to close.
create index migrations_transition_idx on app.migrations (transition_ends_at)
  where status = 'transition';
create trigger migrations_updated_at before update on app.migrations
  for each row execute function private.set_updated_at();
create trigger migrations_immutable before update on app.migrations
  for each row execute function private.forbid_tenant_column_change(
    'organization_id', 'connection_id', 'source_system', 'created_by');

-- The connection a migration names belongs to the same organization.
create or replace function private.check_migration_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.migration_connections c
                 where c.id = new.connection_id and c.organization_id = new.organization_id) then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  if new.created_by is not null and not exists (
       select 1 from app.organization_memberships m
       where m.organization_id = new.organization_id and m.user_id = new.created_by) then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  return new;
end $$;
create trigger migrations_check_refs before insert on app.migrations
  for each row execute function private.check_migration_refs();

-- ---------- one sub-account ----------
-- A scope is one sub-account of the old system, and the business here it lands in. Several scopes may point
-- at one business (Chris's choice): the review step says what that mixes, and the merge rules in 0065 are
-- what keep one person from arriving twice.
create table app.migration_scopes (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  -- Null until the sub-account is mapped (or when it is skipped). Everything the engine writes is keyed to a
  -- scope, so nothing at all can be written for a sub-account nobody pointed anywhere.
  workspace_id uuid references app.workspaces (id) on delete cascade,
  -- The source's own id and name for the sub-account.
  external_scope_id text not null check (length(btrim(external_scope_id)) between 1 and 200),
  name text not null check (length(btrim(name)) between 1 and 200),
  timezone text check (timezone is null or private.is_timezone(timezone)),
  -- Enough to recognize it in a list of forty: the address line and the country the source gave.
  descriptor jsonb not null default '{}'::jsonb
    check (jsonb_typeof(descriptor) = 'object' and pg_column_size(descriptor) <= 16384),
  status app.migration_scope_status not null default 'discovered',
  -- Whether this sub-account creates the business here, or lands in one that already exists. Written when the
  -- mapping is saved, and kept so the report can say which businesses this migration made.
  creates_workspace boolean not null default false,
  selected boolean not null default true,
  totals jsonb not null default '{}'::jsonb
    check (jsonb_typeof(totals) = 'object' and pg_column_size(totals) <= 65536),
  last_error text check (last_error is null or length(last_error) <= 2000),
  scanned_at timestamptz,
  started_at timestamptz,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Anything past the mapping step has somewhere to land.
  check (workspace_id is not null
    or status in ('discovered', 'skipped', 'scanning', 'scanned')),
  check (selected or status in ('discovered', 'skipped'))
);
-- One row per sub-account per migration. Re-scanning finds the same ones and updates them.
create unique index migration_scopes_source on app.migration_scopes (migration_id, external_scope_id);
create index migration_scopes_workspace_idx on app.migration_scopes (workspace_id)
  where workspace_id is not null;
create index migration_scopes_migration_idx on app.migration_scopes (migration_id, status);
create trigger migration_scopes_updated_at before update on app.migration_scopes
  for each row execute function private.set_updated_at();
create trigger migration_scopes_immutable before update on app.migration_scopes
  for each row execute function private.forbid_tenant_column_change(
    'migration_id', 'organization_id', 'external_scope_id');

-- A scope's business belongs to the migration's organization, and its migration to the same one.
create or replace function private.check_migration_scope_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.migrations m
                 where m.id = new.migration_id and m.organization_id = new.organization_id) then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  if new.workspace_id is not null
     and private.workspace_organization(new.workspace_id) is distinct from new.organization_id then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  return new;
end $$;
create trigger migration_scopes_check_refs before insert or update of workspace_id on app.migration_scopes
  for each row execute function private.check_migration_scope_refs();

-- ---------- the scan ----------
-- Read-only, and safe to run again. Each run is its own row, so a second scan can be compared with the first
-- and the counts a person agreed to are the counts they saw.
create table app.migration_scans (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  -- Null while the scan is still finding the sub-accounts themselves.
  scope_id uuid references app.migration_scopes (id) on delete cascade,
  status app.migration_scope_status not null default 'scanning',
  adapter_version text check (adapter_version is null or length(btrim(adapter_version)) between 1 and 40),
  -- The moment the source was read as of. The first import runs up to this, and the catch-up starts here,
  -- which is what keeps a change made while the import ran from falling between the two.
  watermark_at timestamptz,
  -- What the adapter says this sign-in can actually do, category by category (the capability manifest).
  manifest jsonb not null default '{}'::jsonb
    check (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) <= 262144),
  estimated_bytes bigint not null default 0 check (estimated_bytes >= 0),
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes between 0 and 100000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  requested_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index migration_scans_migration_idx on app.migration_scans (migration_id, started_at desc);
create index migration_scans_scope_idx on app.migration_scans (scope_id) where scope_id is not null;
create trigger migration_scans_updated_at before update on app.migration_scans
  for each row execute function private.set_updated_at();

-- ---------- what was found ----------
-- One row per category (and, where a category has pieces a person may pick through, per resource inside it).
-- This is the table the inventory screen reads, and the one the report checks its totals against.
create table app.migration_inventory (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  -- A category in the catalog shipped in core ('contacts', 'conversations', 'invoices'…). Text, not an enum:
  -- a new adapter adds categories without a database change, and core's catalog is what the screen reads.
  category text not null check (length(btrim(category)) between 1 and 60),
  -- Null for the category as a whole; set for one calendar, one pipeline, one form a person can pick.
  resource_id text check (resource_id is null or length(btrim(resource_id)) between 1 and 200),
  resource_name text check (resource_name is null or length(btrim(resource_name)) between 1 and 300),
  found_count bigint not null default 0 check (found_count >= 0),
  count_quality app.migration_count_quality not null default 'unknown',
  capability app.migration_capability not null default 'ready',
  estimated_bytes bigint not null default 0 check (estimated_bytes >= 0),
  -- Categories this one needs first, by name. The engine reads core's graph; this is what the screen shows
  -- when it explains an automatic choice.
  depends_on text[] not null default '{}',
  notes text check (notes is null or length(notes) <= 2000),
  scanned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One row per category or resource per sub-account; a re-scan updates it in place.
create unique index migration_inventory_key on app.migration_inventory
  (scope_id, category, coalesce(resource_id, ''));
create index migration_inventory_migration_idx on app.migration_inventory (migration_id, category);
create trigger migration_inventory_updated_at before update on app.migration_inventory
  for each row execute function private.set_updated_at();

-- ---------- what a person chose ----------
-- Saved as it is made, so someone can leave the wizard and come back to it. A row exists only where a choice
-- was actually made; a category with no row follows the default in the inventory.
create table app.migration_selections (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid not null references app.migration_scopes (id) on delete cascade,
  category text not null check (length(btrim(category)) between 1 and 60),
  resource_id text check (resource_id is null or length(btrim(resource_id)) between 1 and 200),
  selected boolean not null default true,
  -- True when the engine added this because something else needs it. The screen says so and locks it, and
  -- names what asked for it.
  auto_added boolean not null default false,
  required_by text[] not null default '{}',
  chosen_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index migration_selections_key on app.migration_selections
  (scope_id, category, coalesce(resource_id, ''));
create index migration_selections_migration_idx on app.migration_selections (migration_id);
create trigger migration_selections_updated_at before update on app.migration_selections
  for each row execute function private.set_updated_at();

-- ---------- what does not fit ----------
-- Every place the old system holds something this one cannot hold the same way, written in words a person can
-- act on, plus the technical detail underneath for support. A finding is never a stack trace.
create table app.migration_findings (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references app.migrations (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  scope_id uuid references app.migration_scopes (id) on delete cascade,
  category text check (category is null or length(btrim(category)) between 1 and 60),
  -- A stable name for this kind of finding ('calendar.round_robin_unsupported'), so the same gap across many
  -- businesses counts as the same gap when product looks at it.
  code text not null check (length(btrim(code)) between 1 and 80),
  capability app.migration_capability not null,
  severity app.migration_finding_severity not null default 'info',
  -- The source's own field or behaviour, and what it maps to here. Either may be absent.
  source_capability text check (source_capability is null or length(source_capability) <= 200),
  target_capability text check (target_capability is null or length(target_capability) <= 200),
  -- Plain English, and then the three answers a person actually wants.
  summary text not null check (length(btrim(summary)) between 1 and 300),
  what_imports text check (what_imports is null or length(what_imports) <= 1000),
  what_changes text check (what_changes is null or length(what_changes) <= 1000),
  recommended_action text check (recommended_action is null or length(recommended_action) <= 1000),
  blocks_import boolean not null default false,
  -- How many records this finding covers, so "3 of 18,421 contacts" reads as it should.
  affected_count bigint not null default 0 check (affected_count >= 0),
  -- The technical detail, kept out of the customer's report. Never a token, a signed URL or a message body.
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 65536),
  adapter_version text check (adapter_version is null or length(btrim(adapter_version)) between 1 and 40),
  mapping_version integer not null default 1 check (mapping_version between 1 and 1000),
  acknowledged_at timestamptz,
  acknowledged_by uuid references app.users (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The same gap found again counts up rather than filling the list.
create unique index migration_findings_key on app.migration_findings
  (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), code,
   coalesce(category, ''), coalesce(source_capability, ''));
create index migration_findings_list on app.migration_findings (migration_id, severity, category);
create trigger migration_findings_updated_at before update on app.migration_findings
  for each row execute function private.set_updated_at();

-- ---------- references stay inside the migration ----------
-- Every child names both the migration and its scope; this is the one check that they agree, and that the
-- organization is the migration's own.
create or replace function private.check_migration_child_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select m.organization_id into v_org from app.migrations m where m.id = new.migration_id;
  if v_org is null or v_org is distinct from new.organization_id then
    raise exception 'References must belong to the same organization'
      using errcode = '23514', detail = 'record_organization_mismatch';
  end if;
  if new.scope_id is not null and not exists (
       select 1 from app.migration_scopes s
       where s.id = new.scope_id and s.migration_id = new.migration_id) then
    raise exception 'References must belong to the same migration'
      using errcode = '23514', detail = 'record_migration_mismatch';
  end if;
  return new;
end $$;
create trigger migration_scans_check_refs before insert on app.migration_scans
  for each row execute function private.check_migration_child_refs();
create trigger migration_inventory_check_refs before insert on app.migration_inventory
  for each row execute function private.check_migration_child_refs();
create trigger migration_selections_check_refs before insert on app.migration_selections
  for each row execute function private.check_migration_child_refs();
create trigger migration_findings_check_refs before insert on app.migration_findings
  for each row execute function private.check_migration_child_refs();

-- ---------- RLS ----------
-- A migration reaches across the businesses of an organization and creates new ones, so it is the agency's
-- owners and admins who run it, under one permission: org.migrations.manage.
alter table app.migration_connections enable row level security;
alter table app.migrations enable row level security;
alter table app.migration_scopes enable row level security;
alter table app.migration_scans enable row level security;
alter table app.migration_inventory enable row level security;
alter table app.migration_selections enable row level security;
alter table app.migration_findings enable row level security;

create policy migration_connections_select on app.migration_connections for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
-- Starting a sign-in. The insert is granted on the whole table, so the policy is what keeps tokens out of it.
create policy migration_connections_insert on app.migration_connections for insert to authenticated
  with check (private.has_org_permission(organization_id, 'org.migrations.manage')
    and created_by = (select auth.uid()) and status = 'pending'
    and external_account_id is null and pkce_verifier_enc is null and token_enc is null
    and token_key_id is null and token_expires_at is null and next_refresh_at is null
    and connected_at is null and disconnected_at is null and failures = 0);
create policy migration_connections_update on app.migration_connections for update to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'))
  with check (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_connections_service_all on app.migration_connections for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migrations_select on app.migrations for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migrations_service_all on app.migrations for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_scopes_select on app.migration_scopes for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_scopes_service_all on app.migration_scopes for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_scans_select on app.migration_scans for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_scans_service_all on app.migration_scans for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_inventory_select on app.migration_inventory for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_inventory_service_all on app.migration_inventory for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_selections_select on app.migration_selections for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_selections_service_all on app.migration_selections for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

create policy migration_findings_select on app.migration_findings for select to authenticated
  using (private.has_org_permission(organization_id, 'org.migrations.manage'));
create policy migration_findings_service_all on app.migration_findings for all to service_actor
  using (organization_id = private.system_scope_organization())
  with check (organization_id = private.system_scope_organization());

-- ---------- grants ----------
-- People see a connection's state, never its sealed token or its sign-in secrets. RETURNING must name columns
-- from this list, exactly as payment accounts do (0046).
grant select (id, organization_id, source_system, install_kind, status, external_account_id, display_name,
  scopes, missing_scopes, token_expires_at, next_refresh_at, adapter_version, failures, last_error,
  disconnected_reason, connected_at, disconnected_at, created_by, created_at, updated_at)
  on app.migration_connections to authenticated;
grant insert on app.migration_connections to authenticated;
grant update (status, display_name) on app.migration_connections to authenticated;
grant select, insert, update, delete on app.migration_connections to service_actor;
revoke all on app.migration_connections from anon;

-- Everything else a person only ever reads: the commands in core do the writing, through the worker's scope,
-- so a half-written selection or a made-up count cannot come from a browser.
grant select on app.migrations, app.migration_scopes, app.migration_scans, app.migration_inventory,
  app.migration_selections, app.migration_findings to authenticated;
grant select, insert, update, delete on app.migrations, app.migration_scopes, app.migration_scans,
  app.migration_inventory, app.migration_selections, app.migration_findings to service_actor;
revoke all on app.migrations, app.migration_scopes, app.migration_scans, app.migration_inventory,
  app.migration_selections, app.migration_findings from anon;

-- ---------- the sign-in's one-time state ----------
-- The same shape as private.oauth_connection_by_state (0046), for a source rather than a mailbox, calendar or
-- payment account: a migration belongs to the organization, so there is no workspace and no user.
create or replace function private.migration_connection_by_state(p_state_hash text)
returns table (connection_id uuid, organization_id uuid, source_system text, install_kind text,
  status text, state_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select mc.id, mc.organization_id, mc.source_system::text, mc.install_kind::text, mc.status::text,
    mc.oauth_state_expires_at
  from app.migration_connections mc
  where mc.oauth_state_hash = p_state_hash
$$;

-- ---------- function privileges ----------
revoke all on function
  private.guard_migration_connection_update(), private.check_migration_refs(),
  private.check_migration_scope_refs(), private.check_migration_child_refs(),
  private.migration_connection_by_state(text)
  from public;
grant execute on function
  private.guard_migration_connection_update(), private.check_migration_refs(),
  private.check_migration_scope_refs(), private.check_migration_child_refs()
  to authenticated, service_actor;
grant execute on function private.migration_connection_by_state(text) to service_actor;

-- ---------- the permission ----------
insert into app.role_permissions (role, permission) values
  ('org_owner', 'org.migrations.manage'),
  ('org_admin', 'org.migrations.manage');
