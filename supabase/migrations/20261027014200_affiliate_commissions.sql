-- =============================================================================
-- Affiliates, part 2 (HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md): what they earn.
--
--        Each time a business an affiliate sent pays for its plan in its
--        first 12 months, the affiliate earns their share of what it paid
--        (decisions 1 to 3): $38.80 on a full $97 month at 40%. A refund takes
--        the share of what went back, never more than was earned.
--
--        HandsFreeOS's own plan payments weren't kept anywhere a refund could
--        find them: a founding checkout keeps its first payment, but a
--        renewal charged to the card only moved the paid month on. So each
--        one is kept now, in `plan_payments`, as the founding commands record
--        it (founding.record_checkout_paid, founding.record_renewal). A refund
--        made in Stripe's dashboard arrives on our own account's webhook and
--        is kept in `plan_refunds` (founding.record_refund). Only payments
--        kept here have refunds kept: an RCS request's or a texting fee's
--        money goes through the same account and is passed over.
--
--        `affiliate_commissions` is each share earned, taken back by a
--        refund, or given back when a refund failed after it went through.
--        A commission stays the affiliate's when staff move the business to
--        somebody else, and stays when the business is deleted for good.
--        Each is free to pay out 30 days after it's earned (decision 8);
--        payouts are part 4.
--
--        Staff who run the program read all of it. An affiliate reads their
--        own commissions, the names of the businesses that earned them
--        through `private.affiliate_my_businesses()`, and how many signed up
--        through `private.affiliate_my_signups()`, never anybody else's.
--
-- Only adds: three tables and two functions. PowerSync copies nothing again.
-- =============================================================================

-- ---------- what businesses paid us for their plan ----------
create table platform.plan_payments (
  id uuid primary key default gen_random_uuid(),
  -- Null once the business is deleted for good: what it paid stays.
  organization_id uuid references app.organizations (id) on delete set null,
  workspace_id uuid references app.workspaces (id) on delete set null,
  offer_id text references platform.founding_offers (id) on delete set null,
  -- The first payment on a checkout page, a renewal charged to the card kept, or one paid on a page of its own.
  how text not null check (how in ('checkout', 'renewal', 'renewal_page')),
  checkout_id uuid references platform.founding_checkouts (id) on delete set null,
  -- Stripe's `pi_…`: what a refund names.
  payment_ref text not null unique check (length(payment_ref) between 1 and 255),
  amount_cents integer not null check (amount_cents > 0),
  -- The start of the month or year it pays for: a business's first 12 months are counted from its first one.
  period_from timestamptz not null,
  paid_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index plan_payments_organization on platform.plan_payments (organization_id, period_from);

-- ---------- what went back ----------
create table platform.plan_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references platform.plan_payments (id) on delete cascade,
  -- Stripe's `re_…`.
  refund_ref text not null unique check (length(refund_ref) between 1 and 255),
  amount_cents integer not null check (amount_cents > 0),
  -- Stripe's word for it. Succeeded can still turn failed, when the customer's bank turns it down later.
  status text not null check (status in ('pending', 'succeeded', 'failed', 'canceled')),
  refunded_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger plan_refunds_updated_at before update on platform.plan_refunds
  for each row execute function private.set_updated_at();
create index plan_refunds_payment on platform.plan_refunds (payment_id);

-- ---------- what affiliates earned ----------
create table platform.affiliate_commissions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references platform.affiliates (id) on delete cascade,
  -- The business it's from. Null once it's deleted for good; what it earned stays.
  organization_id uuid references app.organizations (id) on delete set null,
  payment_id uuid not null references platform.plan_payments (id) on delete cascade,
  -- The refund that took it back, or that failed and gave it back.
  refund_id uuid references platform.plan_refunds (id) on delete cascade,
  kind text not null check (kind in ('earned', 'taken_back', 'given_back')),
  -- What it was worked out on (what was paid, or refunded), and the share then.
  base_cents bigint not null check (base_cents > 0),
  rate_bp integer not null check (rate_bp between 1 and 10000),
  -- Negative when taken back.
  amount_cents bigint not null check (amount_cents <> 0),
  earned_at timestamptz not null,
  -- Free to pay out 30 days after it's earned. One taken back comes off with what it takes from.
  payable_at timestamptz not null,
  created_at timestamptz not null default now(),
  check ((kind = 'taken_back') = (amount_cents < 0)),
  check ((kind = 'earned') = (refund_id is null))
);
-- A payment earns once; a refund takes back once, and gives back once.
create unique index affiliate_commissions_earned on platform.affiliate_commissions (payment_id)
  where kind = 'earned';
create unique index affiliate_commissions_by_refund on platform.affiliate_commissions (refund_id, kind)
  where refund_id is not null;
create index affiliate_commissions_affiliate on platform.affiliate_commissions (affiliate_id, earned_at desc);

-- ---------- who sees what ----------
alter table platform.plan_payments enable row level security;
alter table platform.plan_refunds enable row level security;
alter table platform.affiliate_commissions enable row level security;

create policy plan_payments_staff on platform.plan_payments for select to authenticated
  using (private.staff_can('platform.affiliates.manage'));
create policy plan_payments_service on platform.plan_payments for all to service_actor
  using (true) with check (true);

create policy plan_refunds_staff on platform.plan_refunds for select to authenticated
  using (private.staff_can('platform.affiliates.manage'));
create policy plan_refunds_service on platform.plan_refunds for all to service_actor
  using (true) with check (true);

create policy affiliate_commissions_own on platform.affiliate_commissions for select to authenticated
  using (exists (select 1 from platform.affiliates a
                 where a.id = affiliate_id and a.user_id = auth.uid()));
create policy affiliate_commissions_staff on platform.affiliate_commissions for select to authenticated
  using (private.staff_can('platform.affiliates.manage'));
create policy affiliate_commissions_service on platform.affiliate_commissions for all to service_actor
  using (true) with check (true);

grant select on platform.plan_payments, platform.plan_refunds, platform.affiliate_commissions to authenticated;
grant select, insert, update on platform.plan_payments, platform.plan_refunds, platform.affiliate_commissions
  to service_actor;
revoke all on platform.plan_payments, platform.plan_refunds, platform.affiliate_commissions from anon;

-- ---------- an affiliate's own businesses ----------
/**
 * The businesses that earned the signed-in affiliate something, by name (decision 13), with what each earned them.
 * Businesses aren't theirs to read, so only the name comes through, and only for a business that paid while it was
 * theirs. A business deleted for good comes back with no name.
 */
create or replace function private.affiliate_my_businesses()
returns table (organization_id uuid, name text, first_paid_at timestamptz, earned_cents bigint)
language sql stable security definer set search_path = '' as $$
  select c.organization_id, o.name::text, min(c.earned_at) filter (where c.kind = 'earned'),
         sum(c.amount_cents)::bigint
  from platform.affiliate_commissions c
  join platform.affiliates a on a.id = c.affiliate_id and a.user_id = auth.uid()
  left join app.organizations o on o.id = c.organization_id
  group by c.organization_id, o.name
  order by min(c.earned_at) desc
$$;

revoke all on function private.affiliate_my_businesses() from public;
grant execute on function private.affiliate_my_businesses() to authenticated;

/** How many businesses are credited to the signed-in affiliate (decision 13), paying or not. Only the count. */
create or replace function private.affiliate_my_signups()
returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer
  from platform.affiliate_referrals r
  join platform.affiliates a on a.id = r.affiliate_id and a.user_id = auth.uid()
$$;

revoke all on function private.affiliate_my_signups() from public;
grant execute on function private.affiliate_my_signups() to authenticated;
