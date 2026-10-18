-- =============================================================================
-- Payment disputes (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2b).
--
--        A customer's bank taking a payment back, as Stripe and Square tell
--        the worker (`payment.record_dispute`). Until now the webhook's
--        delivery row was the only record. Now each dispute is kept with how
--        it stands: open while the business answers it at the provider, then
--        won, lost, or closed (an inquiry that ended with no money taken).
--        A disputed payment is still a payment that was made: nothing here
--        un-pays an invoice.
--
--        What a partner earned on a disputed payment waits while the dispute
--        is open, is taken back when it's lost (`partner_commissions.
--        dispute_id`), and is theirs again when it's won or closed.
--
--        Whoever manages money sees every dispute; anyone else who sees
--        money sees the ones on the invoices they can see, as with refunds.
--
-- Only adds: a table, and a column on partner_commissions with its check widened to allow it.
-- =============================================================================

create table app.payment_disputes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  payment_id uuid not null references app.payments (id) on delete cascade,
  -- Kept beside the payment, as a refund's is, so who may see it is the invoice's.
  invoice_id uuid not null references app.invoices (id) on delete cascade,
  provider app.payment_provider not null,
  provider_dispute_id text not null check (length(btrim(provider_dispute_id)) between 1 and 200),
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  reason text check (reason is null or length(btrim(reason)) between 1 and 200),
  status text not null default 'open' check (status in ('open', 'won', 'lost', 'closed')),
  provider_status text check (provider_status is null or length(btrim(provider_status)) between 1 and 80),
  -- When the business's answer is due at the provider.
  respond_by timestamptz,
  opened_at timestamptz not null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'open') = (closed_at is null))
);
create unique index payment_disputes_provider_unique on app.payment_disputes (provider, provider_dispute_id);
create index payment_disputes_payment_idx on app.payment_disputes (payment_id);
create index payment_disputes_open_idx on app.payment_disputes (workspace_id) where status = 'open';
create trigger payment_disputes_updated_at before update on app.payment_disputes
  for each row execute function private.set_updated_at();
create trigger payment_disputes_immutable before update on app.payment_disputes for each row
  execute function private.forbid_tenant_column_change('workspace_id', 'payment_id', 'invoice_id', 'provider',
    'provider_dispute_id');

-- A dispute belongs to its payment, and to the invoice that payment paid.
create or replace function private.check_dispute_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.payments p
      where p.id = new.payment_id and p.workspace_id = new.workspace_id and p.invoice_id = new.invoice_id) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger payment_disputes_check_refs before insert on app.payment_disputes
  for each row execute function private.check_dispute_refs();

-- A dispute settles once: a late "still open" is kept quietly, as a refund's late callback is.
create or replace function private.guard_dispute_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status <> 'open' and new.status is distinct from old.status then
    new.status := old.status;
    new.closed_at := old.closed_at;
  end if;
  return new;
end $$;
create trigger payment_disputes_status_guard before update of status on app.payment_disputes
  for each row execute function private.guard_dispute_update();

alter table app.payment_disputes enable row level security;
create policy payment_disputes_manage_select on app.payment_disputes for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.manage')));
create policy payment_disputes_member_select on app.payment_disputes for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read'))
    and workspace_id not in (select private.workspaces_with_permission('money.manage'))
    and private.money_invoice_visible(workspace_id, invoice_id));
create policy payment_disputes_service_all on app.payment_disputes for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.payment_disputes to authenticated;
grant select, insert, update on app.payment_disputes to service_actor;
revoke all on app.payment_disputes from anon;

revoke all on function private.check_dispute_refs(), private.guard_dispute_update() from public;
grant execute on function private.check_dispute_refs(), private.guard_dispute_update() to service_actor;

-- ---------- a lost dispute takes back what a partner earned on the payment ----------
alter table app.partner_commissions
  add column dispute_id uuid references app.payment_disputes (id) on delete cascade;
-- Taken back by a refund or a lost dispute, never both; earned by neither.
alter table app.partner_commissions drop constraint partner_commissions_check1;
alter table app.partner_commissions add constraint partner_commissions_taken_by check (
  (kind = 'earned') = (refund_id is null and dispute_id is null) and (refund_id is null or dispute_id is null));
create unique index partner_commissions_dispute on app.partner_commissions (dispute_id)
  where dispute_id is not null;
