-- =============================================================================
-- 0044 · The catalogue a business sells from. app.products is what goes on a
--        line of an estimate or an invoice: parts, labour, call-out fees, each
--        with a unit price, what the unit is called and whether it is taxed.
--        A product may point at a bookable app.services row, so "AC tune-up"
--        is one price in two places; services stay what they are (time,
--        buffers, staff) and keep their display-only price_cents.
--        app.plans is what a maintenance plan costs and what it includes; a
--        subscription (0048) takes a copy of one at the moment it is sold.
--        Neither is ever deleted: archiving keeps old documents readable.
--        Owners and admins (money.manage) change both; everyone with
--        money.read sees them. Grants and the foreign-key indexes are in 0050
--        (20260920000700_money_grants.sql), with the two permissions.
-- =============================================================================

-- What a line is: a part, work done, or a charge like a call-out or a card fee.
create type app.product_kind as enum ('product', 'service', 'fee');
-- How often a plan bills. interval_count multiplies it ("every 3 months" is month x 3).
create type app.plan_interval as enum ('month', 'quarter', 'year');

-- ---------- products: one sellable thing ----------
create table app.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  description text check (description is null or length(description) <= 2000),
  -- The business's own code for it, shown on the document when it has one.
  sku text check (sku is null or length(btrim(sku)) between 1 and 64),
  kind app.product_kind not null default 'product',
  -- The price of one unit, in cents. Zero is allowed: a line can be there for nothing.
  unit_price_cents bigint not null default 0 check (unit_price_cents between 0 and 100000000000),
  -- What one is called on the line: "hour", "each", "sq ft".
  unit_label text not null default 'each' check (length(btrim(unit_label)) between 1 and 40),
  taxable boolean not null default true,
  -- The bookable service this is the price of, if any: one product per service.
  service_id uuid references app.services (id) on delete set null,
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Names and codes are unique among what is still sold; an archived one keeps its name for old documents.
create unique index products_name_unique on app.products (workspace_id, lower(name)) where archived_at is null;
create unique index products_sku_unique on app.products (workspace_id, lower(sku))
  where sku is not null and archived_at is null;
create unique index products_service_unique on app.products (service_id)
  where service_id is not null and archived_at is null;
-- The catalogue list, and the picker in the document editor.
create index products_catalog_idx on app.products (workspace_id, lower(name)) where archived_at is null;
create trigger products_updated_at before update on app.products for each row execute function private.set_updated_at();
create trigger products_immutable before update on app.products for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- plans: what a maintenance plan costs, and what it includes ----------
create table app.plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  description text check (description is null or length(description) <= 2000),
  price_cents bigint not null default 0 check (price_cents between 0 and 100000000000),
  interval app.plan_interval not null default 'month',
  interval_count integer not null default 1 check (interval_count between 1 and 36),
  taxable boolean not null default true,
  -- The lines of "what you get", as plain strings the plan page prints.
  includes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(includes) = 'array' and pg_column_size(includes) <= 16384),
  archived_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index plans_name_unique on app.plans (workspace_id, lower(name)) where archived_at is null;
create index plans_catalog_idx on app.plans (workspace_id, lower(name)) where archived_at is null;
create trigger plans_updated_at before update on app.plans for each row execute function private.set_updated_at();
create trigger plans_immutable before update on app.plans for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'created_by');

-- ---------- references stay inside the workspace, whoever writes ----------
-- Foreign keys don't see RLS, so without this a service or a user id copied from another business would still
-- be accepted. On an update only the references that changed are checked, so someone leaving the business
-- doesn't freeze the products they created. An update once the workspace is gone is its deletion cascading.
create or replace function private.check_money_catalog_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'products' then
    v_ok := (new.service_id is null or (tg_op = 'UPDATE' and new.service_id is not distinct from old.service_id)
      or exists (select 1 from app.services s where s.id = new.service_id and s.workspace_id = new.workspace_id));
  end if;
  v_ok := v_ok and (new.created_by is null or (tg_op = 'UPDATE' and new.created_by is not distinct from old.created_by)
    or private.workspace_has_user(new.workspace_id, new.created_by));
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger products_check_refs before insert or update of service_id, created_by on app.products
  for each row execute function private.check_money_catalog_refs();
create trigger plans_check_refs before insert or update of created_by on app.plans
  for each row execute function private.check_money_catalog_refs();

-- ---------- RLS: everyone allowed to see money reads the catalogue; owners and admins change it ----------
alter table app.products enable row level security;
alter table app.plans enable row level security;

create policy products_select on app.products for select to authenticated
  using (private.has_permission(workspace_id, 'money.read'));
create policy products_insert on app.products for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and created_by = (select auth.uid()));
create policy products_update on app.products for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy products_service_all on app.products for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy plans_select on app.plans for select to authenticated
  using (private.has_permission(workspace_id, 'money.read'));
create policy plans_insert on app.plans for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and created_by = (select auth.uid()));
create policy plans_update on app.plans for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy plans_service_all on app.plans for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- function privileges ----------
revoke all on function private.check_money_catalog_refs() from public;
grant execute on function private.check_money_catalog_refs() to authenticated, service_actor;
