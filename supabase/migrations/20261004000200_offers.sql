-- =============================================================================
-- 0093 · Current offers (M18 step 2). What the business is running right now —
--        "$50 off a furnace tune-up through October" — as a short list the
--        owner types in: a name, the details, and when it starts and ends.
--        The AI teammate shares the ones running today and never invents one.
--        An offer is words, not money: taking it off a bill is still a person's
--        (or an approved draft's) doing.
-- =============================================================================

create table app.offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  details text not null default '' check (length(details) <= 1000),
  -- Local dates in the business's time zone, both inclusive; null is open-ended.
  starts_on date,
  ends_on date,
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_on is null or ends_on is null or ends_on >= starts_on)
);
create index offers_list_idx on app.offers (workspace_id, archived_at, ends_on);
create trigger offers_updated_at before update on app.offers for each row execute function private.set_updated_at();
create trigger offers_immutable before update on app.offers for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

alter table app.offers enable row level security;
create policy offers_select on app.offers for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy offers_insert on app.offers for insert to authenticated
  with check (private.has_permission(workspace_id, 'knowledge.manage') and created_by = (select auth.uid()));
create policy offers_update on app.offers for update to authenticated
  using (private.has_permission(workspace_id, 'knowledge.manage'))
  with check (private.has_permission(workspace_id, 'knowledge.manage'));
create policy offers_service_all on app.offers for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, update on app.offers to authenticated;
grant select, insert, update on app.offers to service_actor;
revoke all on app.offers from anon;
