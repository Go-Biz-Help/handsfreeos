-- =============================================================================
-- Partners: the payout loose ends (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md,
-- stage 5).
--
--        **Stripe's fee for each partner's 1099.** Stripe files a 1099-NEC
--        for each partner account a business paid enough in a year, and
--        charges for each form. Those are Stripe's fees, so they're the
--        business's (decision 16): its first payout after the year ends
--        carries them on a line of their own. `partner_tax_forms` keeps
--        each form once, by the partner's account and the year, with the
--        payout that charged it; a payout that fails lets its forms go to
--        the next one. `partner_payouts.tax_forms_cents` is that line, and
--        the payout's charge counts it.
--
--        **Money held for a partner deleted for good.** Their held line is
--        given back to the business: refunded to its card from the month's
--        charge, the line cancelled, with when, how much and Stripe's refund
--        (`given_back_at`, `given_back_cents`, `refund_ref`).
--        `private.partner_payouts_unfinished` finds such a line for the
--        worker.
--
--        **A refund that fails after it went through.** The client's bank
--        can turn a refund down days after it succeeded.
--        `private.guard_refund_update` now lets a refund go from succeeded
--        to failed, and nowhere else backwards, so the invoice counts the
--        money as the business's again. The partner's share it took back is
--        theirs again: the take-back stays, as commissions are kept as they
--        happened, and a commission of its own, `given_back`, positive and
--        tied to the refund, gives it back, once.
--
-- Removes and remakes three checks and an index, so it needs a person's OK on
-- the connector: the payout's charge (it counts the tax forms), and the
-- commission's kind, sign and one-per-refund index (they take `given_back`).
-- Everything else only adds.
-- =============================================================================

-- ---------- tax forms ----------
alter table app.partner_payouts
  add column tax_forms_cents bigint not null default 0 check (tax_forms_cents >= 0);
alter table app.partner_payouts drop constraint partner_payouts_check;
alter table app.partner_payouts add constraint partner_payouts_charge_adds_up check (
  charge_cents = owed_cents + account_fees_cents + payout_fees_cents + tax_forms_cents + card_fee_cents);

create table app.partner_tax_forms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- The partner's Stripe account the form is for, and the partner while they're kept.
  account_ref text not null check (length(btrim(account_ref)) between 1 and 200),
  partner_id uuid references app.partners (id) on delete set null,
  tax_year integer not null check (tax_year between 2026 and 2200),
  -- What the business paid them that year, and Stripe's fee for the form.
  paid_cents bigint not null check (paid_cents > 0),
  fee_cents bigint not null check (fee_cents > 0),
  -- The payout that charged the business for it.
  payout_id uuid not null references app.partner_payouts (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (workspace_id, account_ref, tax_year)
);
create index partner_tax_forms_payout on app.partner_tax_forms (payout_id);
create index partner_tax_forms_partner on app.partner_tax_forms (partner_id) where partner_id is not null;
alter table app.partner_tax_forms enable row level security;
create policy partner_tax_forms_select on app.partner_tax_forms for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('partners.manage')));
create policy partner_tax_forms_service on app.partner_tax_forms for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.partner_tax_forms to authenticated;
grant select, insert, update, delete on app.partner_tax_forms to service_actor;
revoke all on app.partner_tax_forms from anon;

-- ---------- a deleted partner's held line, given back ----------
alter table app.partner_payout_lines
  add column given_back_at timestamptz,
  add column given_back_cents bigint check (given_back_cents is null or given_back_cents > 0),
  add column refund_ref text check (refund_ref is null or length(btrim(refund_ref)) between 1 and 200),
  add constraint partner_payout_lines_given_back check (
    (given_back_at is null) = (given_back_cents is null) and (given_back_at is null) = (refund_ref is null)
    and (given_back_at is null or status = 'cancelled'));

-- The payouts with something left to do: a charge to try (now, or at its next try), or partners to pay, a held
-- one once their account, as it is now, can take it, and a held one whose partner was deleted for good, to give
-- back.
create or replace function private.partner_payouts_unfinished(p_limit integer)
returns table (workspace_id uuid, organization_id uuid, payout_id uuid, status text)
language sql stable security definer set search_path = '' as $$
  select p.workspace_id, p.organization_id, p.id, p.status
  from app.partner_payouts p
  where (p.status = 'charging' and (p.next_try_at is null or p.next_try_at <= now()))
    or (p.status = 'paying' and exists (
      select 1 from app.partner_payout_lines l
      left join app.partner_payout_accounts a on a.partner_id = l.partner_id
      where l.payout_id = p.id
        and (l.status = 'pending'
          or (l.status = 'held' and (l.partner_id is null or (a.payouts_enabled and a.transfers_active))))))
  order by p.created_at
  limit greatest(1, least(p_limit, 500))
$$;

-- ---------- a refund that fails after it went through ----------
-- A refund moves forward (pending, then failed or succeeded), and from succeeded to failed when the client's bank
-- turns it down afterwards. Anything else backwards is kept quietly, as before.
create or replace function private.guard_refund_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status is distinct from new.status
     and private.refund_status_rank(new.status) < private.refund_status_rank(old.status)
     and not (old.status = 'succeeded' and new.status = 'failed') then
    new.status := old.status;
    new.failure_code := old.failure_code;
    new.refunded_at := old.refunded_at;
  end if;
  return new;
end $$;

alter table app.partner_commissions drop constraint partner_commissions_kind_check;
alter table app.partner_commissions add constraint partner_commissions_kind_check
  check (kind in ('earned', 'taken_back', 'given_back'));
alter table app.partner_commissions drop constraint partner_commissions_check;
alter table app.partner_commissions add constraint partner_commissions_sign
  check ((kind = 'taken_back') = (amount_cents < 0));
-- A refund takes back once, and gives back once.
drop index app.partner_commissions_refund;
create unique index partner_commissions_refund on app.partner_commissions (refund_id, kind)
  where refund_id is not null;
comment on column app.partner_commissions.kind is
  'earned: a share of a payment. taken_back: a refund''s or a lost dispute''s share, negative. given_back: a '
  'refund''s share taken back, back when the refund failed afterwards.';
