-- =============================================================================
-- 0048 · Maintenance plans that bill themselves. The cycles run at the
--        provider — Stripe Billing and Square Subscriptions — because that is
--        where the retries, the card-updater services and the SCA
--        re-authentication live, and those decide whether a plan keeps
--        earning. This table is our mirror of one: the plan as it was sold
--        (frozen, so repricing the catalogue never reprices a customer), who
--        it is for, the account it bills through, the provider's own id, where
--        it is in its cycle and how many cycles have failed.
--        'unmanaged' is the honest state for a plan whose account was
--        disconnected: it is still billing at the provider and we no longer
--        drive it, so the plan page says so. Each subscription has its own
--        public reference and pay_version, so the customer's plan page works
--        like every other customer link.
-- =============================================================================

create type app.subscription_status as enum ('draft', 'active', 'past_due', 'paused', 'cancelled', 'unmanaged');

create table app.subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The customer's plan page is /p/<public_ref><code>, signed over pay_version.
  public_ref text not null default private.new_public_ref() check (public_ref ~ '^[0-9A-Za-z]{8}$'),
  pay_version integer not null default 1 check (pay_version between 1 and 1000000),
  -- The catalogue row it came from, and the copy of it that was sold.
  plan_id uuid references app.plans (id) on delete set null,
  plan_name text not null check (length(btrim(plan_name)) between 1 and 160),
  price_cents bigint not null default 0 check (price_cents between 0 and 100000000000),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  interval app.plan_interval not null default 'month',
  interval_count integer not null default 1 check (interval_count between 1 and 36),
  taxable boolean not null default true,
  includes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(includes) = 'array' and pg_column_size(includes) <= 16384),
  person_id uuid not null references app.people (id),
  lead_id uuid references app.leads (id) on delete set null,
  connection_id uuid references app.payment_connections (id) on delete set null,
  provider app.payment_provider,
  external_subscription_id text
    check (external_subscription_id is null or length(btrim(external_subscription_id)) between 1 and 200),
  status app.subscription_status not null default 'draft',
  started_on date,
  current_period_start date,
  current_period_end date,
  next_billing_on date,
  paused_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 500),
  ended_on date,
  -- How many cycles in a row the card has failed; the provider's retries happen underneath this.
  failed_cycles integer not null default 0 check (failed_cycles between 0 and 1000),
  last_error text check (last_error is null or length(last_error) <= 2000),
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'paused') = (paused_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (cancelled_at is not null or cancel_reason is null),
  check (current_period_end is null or current_period_start is null
    or current_period_end >= current_period_start)
);
create unique index subscriptions_public_ref_key on app.subscriptions (public_ref);
create unique index subscriptions_external_unique on app.subscriptions (connection_id, external_subscription_id)
  where external_subscription_id is not null;
create index subscriptions_list_idx on app.subscriptions (workspace_id, status, created_at desc, id desc);
create index subscriptions_person_idx on app.subscriptions (person_id, created_at desc);
-- The cycle job, and the "your card is about to expire" nudge.
create index subscriptions_billing_idx on app.subscriptions (workspace_id, next_billing_on)
  where status in ('active', 'past_due');
create trigger subscriptions_updated_at before update on app.subscriptions for each row
  execute function private.set_updated_at();
create trigger subscriptions_immutable before update on app.subscriptions for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'public_ref', 'person_id', 'created_by');

-- ---------- the cycle an invoice came from (the column is declared in 0045) ----------
alter table app.invoices
  add constraint invoices_subscription_id_fkey
  foreign key (subscription_id) references app.subscriptions (id) on delete set null;

-- ---------- references stay inside the workspace, whoever writes ----------
create or replace function private.check_subscription_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  v_ok := (tg_op = 'UPDATE'
      or exists (select 1 from app.people p where p.id = new.person_id and p.workspace_id = new.workspace_id))
    and (new.plan_id is null or (tg_op = 'UPDATE' and new.plan_id is not distinct from old.plan_id)
      or exists (select 1 from app.plans pl where pl.id = new.plan_id and pl.workspace_id = new.workspace_id))
    and (new.lead_id is null or (tg_op = 'UPDATE' and new.lead_id is not distinct from old.lead_id)
      or exists (select 1 from app.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id))
    and (new.connection_id is null or (tg_op = 'UPDATE' and new.connection_id is not distinct from old.connection_id)
      or exists (select 1 from app.payment_connections c
        where c.id = new.connection_id and c.workspace_id = new.workspace_id))
    and (new.created_by is null or (tg_op = 'UPDATE' and new.created_by is not distinct from old.created_by)
      or private.workspace_has_user(new.workspace_id, new.created_by));
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger subscriptions_check_refs before insert or update of person_id, plan_id, lead_id, connection_id,
  created_by on app.subscriptions for each row execute function private.check_subscription_refs();

-- An invoice raised by a cycle belongs to the same business as the subscription.
create or replace function private.check_invoice_subscription()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.subscription_id is not null and not exists (
       select 1 from app.subscriptions s
       where s.id = new.subscription_id and s.workspace_id = new.workspace_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger invoices_check_subscription before insert or update of subscription_id on app.invoices
  for each row execute function private.check_invoice_subscription();

-- ---------- RLS ----------
-- A plan is money a business is owed every month: owners and admins only, like the accounts it bills through.
alter table app.subscriptions enable row level security;

create policy subscriptions_select on app.subscriptions for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage'));
create policy subscriptions_insert on app.subscriptions for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and created_by = (select auth.uid())
    and status = 'draft' and external_subscription_id is null and failed_cycles = 0
    and paused_at is null and cancelled_at is null);
create policy subscriptions_update on app.subscriptions for update to authenticated
  using (private.has_permission(workspace_id, 'money.manage'))
  with check (private.has_permission(workspace_id, 'money.manage'));
create policy subscriptions_service_all on app.subscriptions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- the customer's plan page (the tenant is not known yet) ----------
create or replace function private.subscription_link_lookup(p_ref text)
returns table (subscription_id uuid, workspace_id uuid, organization_id uuid, pay_version integer)
language sql stable security definer set search_path = '' as $$
  select s.id, s.workspace_id, w.organization_id, s.pay_version
  from app.subscriptions s join app.workspaces w on w.id = s.workspace_id
  where p_ref ~ '^[0-9A-Za-z]{8}$' and s.public_ref = p_ref
$$;

-- ---------- function privileges ----------
revoke all on function
  private.check_subscription_refs(), private.check_invoice_subscription(), private.subscription_link_lookup(text)
  from public;
grant execute on function private.check_subscription_refs(), private.check_invoice_subscription()
  to authenticated, service_actor;
grant execute on function private.subscription_link_lookup(text) to service_actor;
