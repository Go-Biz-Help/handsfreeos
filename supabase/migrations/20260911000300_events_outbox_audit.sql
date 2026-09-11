-- =============================================================================
-- 0003 · The nervous system: immutable events, the outbox the worker consumes,
--        and the append-only audit log. Written in the same transaction as the
--        change they describe (transactional outbox). organization_id may be
--        null only for account-level events (a user editing their own profile).
-- =============================================================================

create table app.events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references app.organizations (id) on delete restrict,
  workspace_id uuid references app.workspaces (id) on delete restrict,
  event_type text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  actor_type app.actor_type not null,
  actor_id uuid,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  correlation_id uuid not null,
  causation_id uuid,
  created_at timestamptz not null default now(),
  check (organization_id is not null or workspace_id is null)
);
create index events_workspace_created_idx on app.events (workspace_id, created_at desc);
create index events_organization_created_idx on app.events (organization_id, created_at desc);
create index events_actor_created_idx on app.events (actor_id, created_at desc);
create index events_correlation_idx on app.events (correlation_id);
create index events_entity_idx on app.events (entity_type, entity_id);

create type app.outbox_status as enum ('pending', 'done', 'failed');

create table app.outbox (
  event_id uuid primary key references app.events (id) on delete cascade,
  organization_id uuid,
  workspace_id uuid,
  event_type text not null,
  status app.outbox_status not null default 'pending',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbox_pending_idx on app.outbox (next_attempt_at) where status = 'pending';
create trigger outbox_updated_at before update on app.outbox
  for each row execute function private.set_updated_at();

create table app.audit_logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references app.events (id) on delete restrict,
  organization_id uuid references app.organizations (id) on delete restrict,
  workspace_id uuid references app.workspaces (id) on delete restrict,
  actor_type app.actor_type not null,
  actor_id uuid,
  actor_role text,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  channel text not null default 'web',
  ip inet,
  user_agent text,
  correlation_id uuid not null,
  causation_id uuid,
  created_at timestamptz not null default now(),
  check (organization_id is not null or workspace_id is null)
);
create index audit_logs_workspace_created_idx on app.audit_logs (workspace_id, created_at desc);
create index audit_logs_organization_created_idx on app.audit_logs (organization_id, created_at desc);
create index audit_logs_actor_created_idx on app.audit_logs (actor_id, created_at desc);
create index audit_logs_entity_idx on app.audit_logs (entity_type, entity_id);

-- Append-only, for every role including the table owner.
create or replace function private.forbid_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '%.% is append-only', tg_table_schema, tg_table_name using errcode = '42501';
end $$;
create trigger events_append_only before update or delete on app.events
  for each row execute function private.forbid_change();
create trigger audit_logs_append_only before update or delete on app.audit_logs
  for each row execute function private.forbid_change();

-- ---------- grants ----------
grant select, insert on app.events, app.audit_logs to authenticated;
grant insert on app.outbox to authenticated;
grant select, insert on app.events, app.audit_logs to service_actor;
grant select, insert, update on app.outbox to service_actor;
revoke all on app.events, app.outbox, app.audit_logs from anon;
