-- =============================================================================
-- 0047 · Payments and refunds. Every payment belongs to an invoice — a quick
--        payment or a setup fee makes one and pays it in the same action — so
--        there is one ledger, and tax, reporting and refunds have one code
--        path. Card and bank transfer go through the business's own connected
--        account (0046); cash and cheques are recorded by hand, by a person,
--        in their own name. An idempotency key is written on the row before
--        the provider is called, with a unique index behind it, so a
--        double-clicked button charges once.
--        Status only ever moves forward — requires_payment, processing,
--        succeeded or failed — because providers retry and reorder their
--        callbacks and a late event must never un-pay an invoice. 'processing'
--        is the days a bank transfer takes: an honest status instead of
--        looking overdue. A decline comes back from the call, not from a
--        webhook, because Square has no "payment failed" event.
--        What an invoice has been paid and refunded is rolled up here from the
--        rows that succeeded, never written by hand.
-- =============================================================================

create type app.payment_method as enum ('card', 'ach', 'cash', 'check', 'other');
create type app.payment_status as enum ('requires_payment', 'processing', 'succeeded', 'failed');
create type app.refund_status as enum ('pending', 'succeeded', 'failed');

create table app.payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  invoice_id uuid not null references app.invoices (id) on delete cascade,
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  method app.payment_method not null,
  -- Null for cash, a cheque or anything else taken off the system.
  provider app.payment_provider,
  connection_id uuid references app.payment_connections (id) on delete set null,
  provider_payment_id text check (provider_payment_id is null or length(btrim(provider_payment_id)) between 1 and 200),
  -- The provider's own word for where it is ('requires_capture', 'pending'), kept beside ours.
  provider_status text check (provider_status is null or length(btrim(provider_status)) between 1 and 80),
  status app.payment_status not null default 'requires_payment',
  failure_code text check (failure_code is null or length(btrim(failure_code)) between 1 and 80),
  -- What the provider kept, and what actually lands in the business's bank.
  fee_cents bigint check (fee_cents is null or fee_cents between 0 and 100000000000),
  net_cents bigint check (net_cents is null or net_cents between 0 and 100000000000),
  received_at timestamptz,
  -- The person who recorded a cash or cheque payment.
  recorded_by uuid references app.users (id) on delete set null,
  -- Written before the provider is called; the unique index below is what makes charging twice impossible.
  idempotency_key text check (idempotency_key is null or length(btrim(idempotency_key)) between 8 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A provider row and an off-system row are different things: exactly one of them, every time.
  check ((provider is null) = (method in ('cash', 'check', 'other'))),
  check (failure_code is null or status = 'failed'),
  check ((status = 'succeeded') = (received_at is not null))
);
-- One key, one charge: cash rows have no connection, so nulls are compared rather than ignored.
create unique index payments_idempotency_unique on app.payments (workspace_id, connection_id, idempotency_key)
  nulls not distinct where idempotency_key is not null;
-- A webhook finds the payment it is about.
create unique index payments_provider_unique on app.payments (provider, provider_payment_id)
  where provider_payment_id is not null;
create index payments_invoice_idx on app.payments (invoice_id, created_at desc, id desc);
-- The Payments list and "what did we collect this month?".
create index payments_collected_idx on app.payments (workspace_id, received_at desc) where status = 'succeeded';
create trigger payments_updated_at before update on app.payments for each row execute function private.set_updated_at();
create trigger payments_immutable before update on app.payments for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'invoice_id', 'amount_cents', 'currency',
    'method', 'provider', 'recorded_by');

create table app.refunds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  payment_id uuid not null references app.payments (id) on delete cascade,
  -- Kept beside the payment so the roll-up and the Money tab never have to join through it.
  invoice_id uuid not null references app.invoices (id) on delete cascade,
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  reason text check (reason is null or length(reason) <= 500),
  provider app.payment_provider,
  connection_id uuid references app.payment_connections (id) on delete set null,
  provider_refund_id text check (provider_refund_id is null or length(btrim(provider_refund_id)) between 1 and 200),
  provider_status text check (provider_status is null or length(btrim(provider_status)) between 1 and 80),
  status app.refund_status not null default 'pending',
  failure_code text check (failure_code is null or length(btrim(failure_code)) between 1 and 80),
  refunded_at timestamptz,
  requested_by uuid references app.users (id) on delete set null,
  idempotency_key text check (idempotency_key is null or length(btrim(idempotency_key)) between 8 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (failure_code is null or status = 'failed'),
  check ((status = 'succeeded') = (refunded_at is not null))
);
create unique index refunds_idempotency_unique on app.refunds (workspace_id, connection_id, idempotency_key)
  nulls not distinct where idempotency_key is not null;
create unique index refunds_provider_unique on app.refunds (provider, provider_refund_id)
  where provider_refund_id is not null;
create index refunds_payment_idx on app.refunds (payment_id, created_at desc, id desc);
create index refunds_invoice_idx on app.refunds (invoice_id, created_at desc, id desc);
create trigger refunds_updated_at before update on app.refunds for each row execute function private.set_updated_at();
create trigger refunds_immutable before update on app.refunds for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'payment_id', 'invoice_id',
    'amount_cents', 'currency', 'provider', 'requested_by');

-- ---------- status only moves forward ----------
-- The same shape as private.message_status_rank (0011): a late callback is kept silently rather than raising,
-- so the worker's delivery does not fail and retry forever. succeeded is the top, so nothing un-pays an
-- invoice; failed sits under it, so a bank transfer that eventually settles after a soft failure still can.
create or replace function private.payment_status_rank(p app.payment_status)
returns int language sql immutable set search_path = '' as $$
  select case p when 'requires_payment' then 0 when 'processing' then 1 when 'failed' then 2
    when 'succeeded' then 3 else 0 end
$$;

create or replace function private.guard_payment_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status is distinct from new.status
     and private.payment_status_rank(new.status) < private.payment_status_rank(old.status) then
    new.status := old.status;
    new.failure_code := old.failure_code;
    new.received_at := old.received_at;
  end if;
  return new;
end $$;
create trigger payments_status_guard before update of status on app.payments for each row
  execute function private.guard_payment_update();

create or replace function private.refund_status_rank(p app.refund_status)
returns int language sql immutable set search_path = '' as $$
  select case p when 'pending' then 0 when 'failed' then 1 when 'succeeded' then 2 else 0 end
$$;

create or replace function private.guard_refund_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status is distinct from new.status
     and private.refund_status_rank(new.status) < private.refund_status_rank(old.status) then
    new.status := old.status;
    new.failure_code := old.failure_code;
    new.refunded_at := old.refunded_at;
  end if;
  return new;
end $$;
create trigger refunds_status_guard before update of status on app.refunds for each row
  execute function private.guard_refund_update();

-- ---------- what an invoice has been paid ----------
-- app.invoices.amount_paid_cents and amount_refunded_cents are the sum of what actually succeeded, recounted
-- here whenever a payment or a refund lands, changes or goes. That is what makes them "the worker's alone"
-- true and still lets a person record a cash payment: nobody writes the numbers, the database derives them.
-- The invoice row is locked first, so two payments arriving at once cannot lose each other. SECURITY DEFINER:
-- it writes columns no role is granted, and the document guard (0045) steps aside for it.
create or replace function private.money_roll_up_invoice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_invoice uuid;
  v_paid bigint;
  v_refunded bigint;
  v_total bigint;
  v_voided timestamptz;
  v_status app.invoice_status;
begin
  if tg_op = 'DELETE' then v_invoice := old.invoice_id; else v_invoice := new.invoice_id; end if;
  select i.total_cents, i.voided_at, i.status into v_total, v_voided, v_status
    from app.invoices i where i.id = v_invoice for update;
  if not found then
    return null;
  end if;
  select coalesce(sum(p.amount_cents), 0) into v_paid
    from app.payments p where p.invoice_id = v_invoice and p.status = 'succeeded';
  select coalesce(sum(r.amount_cents), 0) into v_refunded
    from app.refunds r where r.invoice_id = v_invoice and r.status = 'succeeded';
  update app.invoices i set
    amount_paid_cents = v_paid,
    amount_refunded_cents = v_refunded,
    paid_at = case
      when v_voided is not null then i.paid_at
      when v_total > 0 and v_paid - v_refunded >= v_total then coalesce(i.paid_at, now()) end,
    status = case
      when v_voided is not null or v_status = 'draft' then v_status
      when v_total > 0 and v_paid - v_refunded >= v_total then 'paid'::app.invoice_status
      when v_paid - v_refunded > 0 then 'partly_paid'::app.invoice_status
      when v_status in ('paid', 'partly_paid') then 'sent'::app.invoice_status
      else v_status end
  where i.id = v_invoice;
  return null;
end $$;
create trigger payments_roll_up after insert or update or delete on app.payments for each row
  execute function private.money_roll_up_invoice();
create trigger refunds_roll_up after insert or update or delete on app.refunds for each row
  execute function private.money_roll_up_invoice();

-- ---------- references stay inside the workspace, whoever writes ----------
create or replace function private.check_payment_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  if tg_op = 'UPDATE' and not exists (select 1 from app.workspaces w where w.id = new.workspace_id) then
    return new;
  end if;
  v_ok := (new.connection_id is null or (tg_op = 'UPDATE' and new.connection_id is not distinct from old.connection_id)
      or exists (select 1 from app.payment_connections c
        where c.id = new.connection_id and c.workspace_id = new.workspace_id));
  if tg_table_name = 'payments' then
    v_ok := v_ok
      and exists (select 1 from app.invoices i where i.id = new.invoice_id and i.workspace_id = new.workspace_id)
      and (new.recorded_by is null or (tg_op = 'UPDATE' and new.recorded_by is not distinct from old.recorded_by)
        or private.workspace_has_user(new.workspace_id, new.recorded_by));
  else
    -- A refund belongs to its payment, and to the same invoice that payment paid.
    v_ok := v_ok
      and exists (select 1 from app.payments p
        where p.id = new.payment_id and p.workspace_id = new.workspace_id and p.invoice_id = new.invoice_id)
      and (new.requested_by is null or (tg_op = 'UPDATE' and new.requested_by is not distinct from old.requested_by)
        or private.workspace_has_user(new.workspace_id, new.requested_by));
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger payments_check_refs before insert or update of invoice_id, connection_id, recorded_by
  on app.payments for each row execute function private.check_payment_refs();
create trigger refunds_check_refs before insert or update of payment_id, invoice_id, connection_id, requested_by
  on app.refunds for each row execute function private.check_payment_refs();

-- ---------- RLS ----------
-- Owners and admins do everything. The rule that also lets a member see the payments of the jobs they are on
-- is a second SELECT policy, in 0050. Nobody updates a payment by hand: a mistake is refunded, and everything
-- the provider says is the worker's.
alter table app.payments enable row level security;
alter table app.refunds enable row level security;

create policy payments_manage_select on app.payments for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage'));
-- Cash, a cheque or something taken off the system, recorded by a person in their own name.
create policy payments_insert on app.payments for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and method in ('cash', 'check', 'other')
    and status = 'succeeded' and provider is null and connection_id is null and provider_payment_id is null
    and provider_status is null and fee_cents is null and net_cents is null
    and recorded_by = (select auth.uid()));
create policy payments_service_all on app.payments for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy refunds_manage_select on app.refunds for select to authenticated
  using (private.has_permission(workspace_id, 'money.manage'));
-- Asking for a refund; the worker calls the provider and records what came back.
create policy refunds_insert on app.refunds for insert to authenticated
  with check (private.has_permission(workspace_id, 'money.manage') and status = 'pending'
    and provider_refund_id is null and provider_status is null and refunded_at is null
    and requested_by = (select auth.uid()));
create policy refunds_service_all on app.refunds for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- function privileges ----------
revoke all on function
  private.payment_status_rank(app.payment_status), private.guard_payment_update(),
  private.refund_status_rank(app.refund_status), private.guard_refund_update(),
  private.money_roll_up_invoice(), private.check_payment_refs()
  from public;
grant execute on function
  private.payment_status_rank(app.payment_status), private.guard_payment_update(),
  private.refund_status_rank(app.refund_status), private.guard_refund_update(),
  private.money_roll_up_invoice(), private.check_payment_refs()
  to authenticated, service_actor;
