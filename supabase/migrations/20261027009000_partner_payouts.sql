-- =============================================================================
-- Paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3; decisions 8 and 16 to 18).
--
--        Once a month, HandsFreeOS adds up what a business owes its
--        partners for payments at least 30 days old, charges the
--        business's card for it on HandsFreeOS's own Stripe account, and
--        pays each partner through Stripe. Stripe's fees are the
--        business's, each on its own line of the month's statement.
--
--        `partner_payout_billing` is the business's side: whether staff
--        have opened payouts for it (one business at a time, nothing is
--        charged or paid before), the card it pays with, and the last month
--        its payout was worked out. `partner_payout_accounts` is a
--        partner's bank, as a Stripe Express account they set up with
--        Stripe's own form: their bank, tax and identity details are
--        Stripe's, never ours. `partner_payouts` is a month's payout: what
--        was owed, Stripe's fees, the charge and its tries.
--        `partner_payout_lines` is each partner's part of it and the
--        transfer that paid them, and each commission names the line that
--        paid it.
--
--        A partner owed less than the smallest payout, or with no bank set
--        up yet, gets no line: what they're owed waits for next month's.
--        Only the worker writes any of it, apart from a person with
--        money.manage taking the card off and staff opening payouts.
--        Whoever holds partners.manage sees it, and whoever holds
--        money.manage the card.
--
-- Only adds: four tables, a column, a staff permission, two staff functions, three worker look-ups, and four portal
-- look-ups. portal.partner_earnings() keeps its columns, and now leaves out what a payout has taken.
-- =============================================================================

-- ---------- the staff permission: opening payouts for a business ----------
insert into app.role_permissions (role, permission) values
  ('staff_admin', 'platform.partner_payouts.manage');

-- ---------- the business's side ----------
create table app.partner_payout_billing (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  -- Set by staff (private.set_partner_payouts_open). Until then nothing is charged, and nobody is paid.
  opened_at timestamptz,
  -- The card, on HandsFreeOS's own Stripe account as the usage wallet's is: their customer, their token, and the
  -- brand, last four and expiry. Never the number.
  provider app.payment_provider,
  customer_ref text check (customer_ref is null or length(btrim(customer_ref)) between 1 and 200),
  method_token text check (method_token is null or length(btrim(method_token)) between 1 and 4000),
  card_brand text check (card_brand is null or length(btrim(card_brand)) between 1 and 40),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_expiry_month smallint check (card_expiry_month is null or card_expiry_month between 1 and 12),
  card_expiry_year smallint check (card_expiry_year is null or card_expiry_year between 2000 and 2100),
  card_saved_at timestamptz,
  -- The month (its first day) whose payout was last worked out, paid or not: once a month at most.
  last_month date check (last_month is null or extract(day from last_month) = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partner_payout_billing_card_check check ((card_brand is null) = (card_last4 is null)),
  constraint partner_payout_billing_token_check check (method_token is null or customer_ref is not null)
);
create trigger partner_payout_billing_updated_at before update on app.partner_payout_billing
  for each row execute function private.set_updated_at();
create trigger partner_payout_billing_immutable before update on app.partner_payout_billing
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'organization_id');

-- A person may only take the card off. Everything else is HandsFreeOS's: the card Stripe handed back, whether
-- payouts are open, and the months worked out. The worker and staff write under the business's own system scope.
create or replace function private.guard_partner_payout_billing()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if new.opened_at is distinct from old.opened_at
    or new.provider is distinct from old.provider
    or new.customer_ref is distinct from old.customer_ref
    or new.card_saved_at is distinct from old.card_saved_at
    or new.last_month is distinct from old.last_month
    or (new.method_token is not null and new.method_token is distinct from old.method_token)
    or (new.card_brand is not null and new.card_brand is distinct from old.card_brand)
    or (new.card_last4 is not null and new.card_last4 is distinct from old.card_last4)
    or (new.card_expiry_month is not null and new.card_expiry_month is distinct from old.card_expiry_month)
    or (new.card_expiry_year is not null and new.card_expiry_year is distinct from old.card_expiry_year) then
    raise exception 'Only HandsFreeOS puts a card on partner payouts or opens them; a person can only take the card off'
      using errcode = '42501', detail = 'partner_payout_billing_is_ours';
  end if;
  return new;
end $$;
create trigger partner_payout_billing_guard before update on app.partner_payout_billing
  for each row execute function private.guard_partner_payout_billing();

-- ---------- a partner's bank: their Stripe Express account ----------
create table app.partner_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  partner_id uuid not null unique references app.partners (id) on delete cascade,
  provider app.payment_provider not null default 'stripe',
  -- Stripe's `acct_…`.
  account_ref text not null unique check (length(btrim(account_ref)) between 1 and 200),
  -- Made with a test key: never paid from live money, nor live from test.
  livemode boolean not null,
  -- What Stripe says of it: whether they finished its form, whether it can be sent money and pay it out to
  -- their bank, and what Stripe still needs from them.
  details_submitted boolean not null default false,
  payouts_enabled boolean not null default false,
  transfers_active boolean not null default false,
  disabled_reason text check (disabled_reason is null or length(disabled_reason) <= 200),
  due text[] not null default '{}' check (cardinality(due) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index partner_payout_accounts_workspace on app.partner_payout_accounts (workspace_id);
create trigger partner_payout_accounts_updated_at before update on app.partner_payout_accounts
  for each row execute function private.set_updated_at();

-- ---------- a month's payout ----------
create table app.partner_payouts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  -- The month it's paid in (its first day): one a month.
  month date not null check (extract(day from month) = 1),
  livemode boolean not null,
  -- charging: the card is being charged, or waits to be tried again; paying: charged, partners being paid;
  -- paid: every partner paid; failed: the card never went through, and what was owed waits for next month's.
  status text not null default 'charging' check (status in ('charging', 'paying', 'paid', 'failed')),
  -- What the partners are owed, then Stripe's fees, each its own line (decision 16).
  owed_cents bigint not null check (owed_cents > 0),
  account_fees_cents bigint not null check (account_fees_cents >= 0),
  payout_fees_cents bigint not null check (payout_fees_cents >= 0),
  card_fee_cents bigint not null check (card_fee_cents >= 0),
  charge_cents bigint not null,
  -- The card it was charged to, as it was then.
  card_brand text check (card_brand is null or length(btrim(card_brand)) between 1 and 40),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  -- The charge: how many tries, when the next is, and what Stripe said.
  attempts integer not null default 0 check (attempts between 0 and 20),
  next_try_at timestamptz,
  payment_ref text check (payment_ref is null or length(btrim(payment_ref)) between 1 and 200),
  charge_ref text check (charge_ref is null or length(btrim(charge_ref)) between 1 and 200),
  failure_code text check (failure_code is null or length(failure_code) <= 100),
  failure_message text check (failure_message is null or length(failure_message) <= 500),
  charged_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, month),
  check (charge_cents = owed_cents + account_fees_cents + payout_fees_cents + card_fee_cents),
  check ((status in ('paying', 'paid')) = (charged_at is not null)),
  check ((status = 'paid') = (paid_at is not null)),
  check ((status = 'failed') = (failed_at is not null))
);
create trigger partner_payouts_updated_at before update on app.partner_payouts
  for each row execute function private.set_updated_at();
create trigger partner_payouts_immutable before update on app.partner_payouts
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'organization_id');

-- ---------- each partner's part of it ----------
create table app.partner_payout_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  payout_id uuid not null references app.partner_payouts (id) on delete cascade,
  -- Null once the partner is deleted for good: what the business was charged stays on its statement.
  partner_id uuid references app.partners (id) on delete set null,
  -- Where it's sent: their account at Stripe when the payout was worked out, or the one it was sent to.
  account_ref text not null check (length(btrim(account_ref)) between 1 and 200),
  amount_cents bigint not null check (amount_cents > 0),
  account_fee_cents bigint not null check (account_fee_cents >= 0),
  payout_fee_cents bigint not null check (payout_fee_cents >= 0),
  -- pending: waiting for the charge, or its transfer; paid: sent; held: Stripe wouldn't take it for them yet,
  -- tried again once their account can take it; cancelled: the charge failed, and it waits for next month's.
  status text not null default 'pending' check (status in ('pending', 'paid', 'held', 'cancelled')),
  transfer_ref text unique check (transfer_ref is null or length(btrim(transfer_ref)) between 1 and 200),
  held_reason text check (held_reason is null or length(held_reason) <= 500),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payout_id, partner_id),
  check ((status = 'paid') = (paid_at is not null and transfer_ref is not null)),
  check ((status = 'held') = (held_reason is not null))
);
create index partner_payout_lines_payout on app.partner_payout_lines (payout_id);
create index partner_payout_lines_partner on app.partner_payout_lines (partner_id);
create trigger partner_payout_lines_updated_at before update on app.partner_payout_lines
  for each row execute function private.set_updated_at();

-- ---------- the line that paid each commission ----------
alter table app.partner_commissions
  add column payout_line_id uuid references app.partner_payout_lines (id) on delete set null;
create index partner_commissions_payout_line on app.partner_commissions (payout_line_id)
  where payout_line_id is not null;
comment on column app.partner_commissions.payout_line_id is
  'The payout line that pays it, while that line is pending, held or paid. A cancelled line lets go of its '
  'commissions, so they''re in next month''s payout.';

-- ---------- who sees it: partners.manage, money.manage for the card, and the worker ----------
alter table app.partner_payout_billing enable row level security;
alter table app.partner_payout_accounts enable row level security;
alter table app.partner_payouts enable row level security;
alter table app.partner_payout_lines enable row level security;

create policy partner_payout_billing_select on app.partner_payout_billing for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('partners.manage'))
    or workspace_id in (select private.workspaces_with_permission('money.manage')));
-- Taking the card off. The guard above is where the rule lives; this only says who may try.
create policy partner_payout_billing_update on app.partner_payout_billing for update to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.manage')))
  with check (workspace_id in (select private.workspaces_with_permission('money.manage')));
create policy partner_payout_billing_service on app.partner_payout_billing for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy partner_payout_accounts_select on app.partner_payout_accounts for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('partners.manage')));
create policy partner_payout_accounts_service on app.partner_payout_accounts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy partner_payouts_select on app.partner_payouts for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('partners.manage')));
create policy partner_payouts_service on app.partner_payouts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

create policy partner_payout_lines_select on app.partner_payout_lines for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('partners.manage')));
create policy partner_payout_lines_service on app.partner_payout_lines for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, update on app.partner_payout_billing to authenticated;
grant select on app.partner_payout_accounts, app.partner_payouts, app.partner_payout_lines to authenticated;
grant select, insert, update on app.partner_payout_billing, app.partner_payout_accounts, app.partner_payouts,
  app.partner_payout_lines to service_actor;
revoke all on app.partner_payout_billing, app.partner_payout_accounts, app.partner_payouts,
  app.partner_payout_lines from anon;

-- ---------- staff open payouts, one business at a time ----------
-- Partners are paid only once staff open payouts for the business, after Chris has checked the terms with his
-- accountant or lawyer (the plan's "Before stage 3 goes live"). Closing them stops what hasn't been charged yet;
-- a payout already charged still pays its partners.
create or replace function private.set_partner_payouts_open(p_workspace uuid, p_open boolean)
returns table (was_open boolean, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_was boolean;
  v_org uuid;
begin
  if not private.staff_can('platform.partner_payouts.manage') then
    raise exception 'You cannot open or close partner payouts for a business'
      using errcode = '42501', detail = 'partner_payouts_manage';
  end if;
  select w.organization_id into v_org from app.workspaces w where w.id = p_workspace;
  if v_org is null then
    return;
  end if;
  -- This business's own scope, for the two writes below and nothing else.
  perform set_config('app.system_scope.workspace_id', p_workspace::text, true);
  insert into app.partner_payout_billing (workspace_id, organization_id) values (p_workspace, v_org)
    on conflict (workspace_id) do nothing;
  select b.opened_at is not null into v_was from app.partner_payout_billing b where b.workspace_id = p_workspace
    for update;
  if v_was is distinct from p_open then
    update app.partner_payout_billing set opened_at = case when p_open then now() end
      where workspace_id = p_workspace;
  end if;
  perform set_config('app.system_scope.workspace_id', '', true);
  return query select v_was, v_was is distinct from p_open;
end $$;
revoke all on function private.set_partner_payouts_open(uuid, boolean) from public;
grant execute on function private.set_partner_payouts_open(uuid, boolean) to authenticated;

-- What staff see of a business's partner payouts on /admin: whether they're open, whether there's a card, how many
-- payouts it has had and how the latest went. Nothing about the card itself.
create or replace function private.staff_partner_payouts(p_workspace uuid)
returns table (open boolean, has_card boolean, payouts integer, latest_status text)
language sql stable security definer set search_path = '' as $$
  select coalesce(b.opened_at is not null, false), coalesce(b.method_token is not null, false),
    (select count(*)::int from app.partner_payouts p where p.workspace_id = w.id),
    (select p.status from app.partner_payouts p where p.workspace_id = w.id order by p.created_at desc limit 1)
  from app.workspaces w
  left join app.partner_payout_billing b on b.workspace_id = w.id
  where w.id = p_workspace and private.staff_can('platform.businesses.read')
$$;
revoke all on function private.staff_partner_payouts(uuid) from public;
grant execute on function private.staff_partner_payouts(uuid) to authenticated;

-- ---------- what the worker looks up across businesses ----------
-- The businesses whose payout for this month, in their own time zone, hasn't been worked out yet: open, with a
-- card, and something earned that no payout has taken. A time zone Postgres doesn't know is read as UTC.
create or replace function private.partner_payouts_due(p_limit integer)
returns table (workspace_id uuid, organization_id uuid, month date)
language sql stable security definer set search_path = '' as $$
  with zones as (select name from pg_catalog.pg_timezone_names)
  select b.workspace_id, b.organization_id, m.month
  from app.partner_payout_billing b
  join app.workspaces w on w.id = b.workspace_id
  left join zones z on z.name = w.timezone
  cross join lateral (
    select date_trunc('month', now() at time zone coalesce(z.name, 'UTC'))::date as month) m
  where b.opened_at is not null and b.method_token is not null
    and (b.last_month is null or b.last_month < m.month)
    and exists (select 1 from app.partner_commissions c
      where c.workspace_id = b.workspace_id and c.payout_line_id is null)
  order by b.workspace_id
  limit greatest(1, least(p_limit, 500))
$$;

-- The payouts with something left to do: a charge to try (now, or at its next try), or partners to pay, a held
-- one once their account, as it is now, can take it.
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
          or (l.status = 'held' and a.payouts_enabled and a.transfers_active))))
  order by p.created_at
  limit greatest(1, least(p_limit, 500))
$$;

-- Whose a Stripe account is, for the Connect webhook's `account.updated`.
create or replace function private.partner_payout_account_by_ref(p_ref text)
returns table (workspace_id uuid, organization_id uuid, partner_id uuid, account_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.workspace_id, w.organization_id, a.partner_id, a.id
  from app.partner_payout_accounts a join app.workspaces w on w.id = a.workspace_id
  where a.account_ref = p_ref
$$;

revoke all on function private.partner_payouts_due(integer), private.partner_payouts_unfinished(integer),
  private.partner_payout_account_by_ref(text) from public;
grant execute on function private.partner_payouts_due(integer), private.partner_payouts_unfinished(integer),
  private.partner_payout_account_by_ref(text) to service_actor;

-- ---------- the partner's page ----------
-- What they earned: everything less what was taken back; and what's waiting its 30 days, free to pay out or held
-- by an open dispute, of what no payout has taken yet. Its columns are as they were, so it's replaced in place.
create or replace function portal.partner_earnings()
returns table (earned_cents bigint, waiting_cents bigint, payable_cents bigint, held_cents bigint)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(c.amount_cents), 0)::bigint,
    coalesce(sum(c.amount_cents) filter (where s.free and not s.held and c.payable_at > now()), 0)::bigint,
    coalesce(sum(c.amount_cents) filter (where s.free and not s.held and c.payable_at <= now()), 0)::bigint,
    coalesce(sum(c.amount_cents) filter (where s.free and s.held), 0)::bigint
  from app.partner_commissions c
  join app.partners pa on pa.id = c.partner_id
  left join app.partner_payout_lines l on l.id = c.payout_line_id
  cross join lateral (select l.id is null or l.status = 'cancelled' as free,
      exists (select 1 from app.payment_disputes d
        where d.payment_id = c.payment_id and d.status = 'open') as held) s
  where pa.workspace_id = portal.workspace() and pa.person_id = portal.person() and not c.test
$$;

-- What's on its way to them in a payout, and what's been paid.
create or replace function portal.partner_payout_totals()
returns table (paying_cents bigint, paid_cents bigint)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(c.amount_cents) filter (where l.status in ('pending', 'held')), 0)::bigint,
    coalesce(sum(c.amount_cents) filter (where l.status = 'paid'), 0)::bigint
  from app.partner_commissions c
  join app.partners pa on pa.id = c.partner_id
  join app.partner_payout_lines l on l.id = c.payout_line_id
  where pa.workspace_id = portal.workspace() and pa.person_id = portal.person() and not c.test
$$;

-- Their bank at Stripe: whether they've set it up, and whether Stripe can pay them. Never the account's id.
create or replace function portal.partner_payout_account()
returns table (details_submitted boolean, payouts_enabled boolean, transfers_active boolean,
  disabled_reason text, due_count integer)
language sql stable security definer set search_path = '' as $$
  select a.details_submitted, a.payouts_enabled, a.transfers_active, a.disabled_reason, cardinality(a.due)
  from app.partner_payout_accounts a join app.partners pa on pa.id = a.partner_id
  where pa.workspace_id = portal.workspace() and pa.person_id = portal.person()
$$;

-- Whether the business pays its partners through HandsFreeOS yet: staff opened payouts for it. Nothing about its
-- card.
create or replace function portal.partner_payouts_open()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from portal.partner())
    and exists (select 1 from app.partner_payout_billing b
      where b.workspace_id = portal.workspace() and b.opened_at is not null)
$$;

-- What they've been paid, and what's on its way, the newest first. A line whose charge failed isn't theirs to
-- see: what it held is free to pay out again, in next month's payout.
create or replace function portal.partner_payouts()
returns table (line_id uuid, month date, amount_cents bigint, status text, paid_at timestamptz,
  livemode boolean)
language sql stable security definer set search_path = '' as $$
  select l.id, p.month, l.amount_cents, l.status, l.paid_at, p.livemode
  from app.partner_payout_lines l
  join app.partner_payouts p on p.id = l.payout_id
  join app.partners pa on pa.id = l.partner_id
  where pa.workspace_id = portal.workspace() and pa.person_id = portal.person() and l.status <> 'cancelled'
  order by p.month desc, l.created_at desc
  limit 60
$$;

revoke all on function portal.partner_payout_totals(), portal.partner_payout_account(),
  portal.partner_payouts_open(), portal.partner_payouts() from public;
grant execute on function portal.partner_payout_totals(), portal.partner_payout_account(),
  portal.partner_payouts_open(), portal.partner_payouts() to portal_actor;
