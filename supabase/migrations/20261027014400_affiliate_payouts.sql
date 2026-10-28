-- =============================================================================
-- Affiliates, part 4 (HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md): payouts.
--
--        Once a month, what an affiliate has ready (each share 30 days after
--        it was earned, less what refunds took back) is sent to their bank by
--        Stripe (decisions 7 to 10): a Stripe Express account of HandsFreeOS's
--        platform, set up on Stripe's own form from their affiliate page, US
--        only, paid by a transfer from HandsFreeOS's own balance. $25 at
--        least; less waits for next month. HandsFreeOS pays Stripe's fees, so
--        they get all of it.
--
--        **Off until staff turn it on** (`affiliate_settings.payouts_on`),
--        once the terms are read (the plan's "Before payouts go live").
--        Until then affiliates can set up their bank, and what they're owed
--        keeps.
--
--        One payout an affiliate a month, worked out from the 1st (UTC). Its
--        shares are tied to it (`affiliate_commissions.payout_id`), so a
--        share is paid once. A share taken back after it was paid comes off
--        the next one. A payout Stripe won't send (their account can't take
--        it now) is held, and sent once it can. Paused and ended affiliates
--        are paid what they earned.
--
--        The worker does all of it, through the functions here: there's no
--        business to run a command in, as with counting clicks. A person
--        reads their own account and payouts; staff read everyone's; nobody
--        but the worker writes them.
--
-- Only adds. PowerSync copies nothing again: no synced table changes.
-- =============================================================================

alter table platform.affiliate_settings
  -- Staff turn payouts on once the terms are read. Until then nothing is sent.
  add column payouts_on boolean not null default false;

-- ---------- an affiliate's bank, at Stripe ----------
create table platform.affiliate_payout_accounts (
  affiliate_id uuid primary key references platform.affiliates (id) on delete cascade,
  -- Stripe's `acct_…`, an Express account of HandsFreeOS's platform.
  account_ref text not null unique check (length(account_ref) between 1 and 255),
  -- Made with a test key: it only ever takes test money.
  livemode boolean not null,
  -- They finished Stripe's form.
  details_submitted boolean not null default false,
  -- Stripe pays what we send them out to their bank.
  payouts_enabled boolean not null default false,
  -- We can send them money.
  transfers_active boolean not null default false,
  -- Why Stripe stopped it, in Stripe's words, and what it still needs, by its own field names.
  disabled_reason text,
  due text[] not null default '{}',
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger affiliate_payout_accounts_updated_at before update on platform.affiliate_payout_accounts
  for each row execute function private.set_updated_at();

-- ---------- a month's payout ----------
create table platform.affiliate_payouts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references platform.affiliates (id) on delete cascade,
  -- The month it's for: the first of it, UTC. One a month each.
  month date not null check (extract(day from month) = 1),
  amount_cents integer not null check (amount_cents > 0),
  livemode boolean not null,
  -- sending: to be sent now. held: Stripe won't take it for them yet, sent once it can. paid: sent.
  status text not null default 'sending' check (status in ('sending', 'held', 'paid')),
  account_ref text not null,
  transfer_ref text unique,
  paid_at timestamptz,
  -- When they were told it was sent.
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (affiliate_id, month),
  check ((status = 'paid') = (transfer_ref is not null and paid_at is not null))
);
create trigger affiliate_payouts_updated_at before update on platform.affiliate_payouts
  for each row execute function private.set_updated_at();
create index affiliate_payouts_open on platform.affiliate_payouts (created_at) where status <> 'paid';

alter table platform.affiliate_commissions
  -- The payout that paid it out, once one has.
  add column payout_id uuid references platform.affiliate_payouts (id) on delete set null;
create index affiliate_commissions_unpaid on platform.affiliate_commissions (affiliate_id, payable_at)
  where payout_id is null;
create index affiliate_commissions_payout on platform.affiliate_commissions (payout_id)
  where payout_id is not null;

alter table platform.affiliate_payout_accounts enable row level security;
alter table platform.affiliate_payouts enable row level security;
create policy affiliate_payout_accounts_own on platform.affiliate_payout_accounts for select to authenticated
  using (exists (select 1 from platform.affiliates a where a.id = affiliate_id and a.user_id = auth.uid()));
create policy affiliate_payout_accounts_staff on platform.affiliate_payout_accounts for select to authenticated
  using (private.staff_can('platform.affiliates.manage'));
create policy affiliate_payout_accounts_service on platform.affiliate_payout_accounts for all to service_actor
  using (true) with check (true);
create policy affiliate_payouts_own on platform.affiliate_payouts for select to authenticated
  using (exists (select 1 from platform.affiliates a where a.id = affiliate_id and a.user_id = auth.uid()));
create policy affiliate_payouts_staff on platform.affiliate_payouts for select to authenticated
  using (private.staff_can('platform.affiliates.manage'));
create policy affiliate_payouts_service on platform.affiliate_payouts for all to service_actor
  using (true) with check (true);
grant select on platform.affiliate_payout_accounts, platform.affiliate_payouts to authenticated;
grant select, insert, update on platform.affiliate_payout_accounts, platform.affiliate_payouts to service_actor;
revoke all on platform.affiliate_payout_accounts, platform.affiliate_payouts from anon;

-- ---------- the worker's functions ----------
/**
 * What Stripe says of an affiliate's account, kept: the first time, the account made for them. Answers whether it
 * can be paid now.
 */
create or replace function private.affiliate_payout_account_record(
  p_affiliate uuid,
  p_account text,
  p_livemode boolean,
  p_details_submitted boolean,
  p_payouts_enabled boolean,
  p_transfers_active boolean,
  p_disabled_reason text,
  p_due text[]
)
returns boolean
language sql security definer set search_path = '' as $$
  insert into platform.affiliate_payout_accounts
    (affiliate_id, account_ref, livemode, details_submitted, payouts_enabled, transfers_active, disabled_reason,
     due, checked_at)
  values (p_affiliate, p_account, p_livemode, p_details_submitted, p_payouts_enabled, p_transfers_active,
          p_disabled_reason, coalesce(p_due, '{}'), now())
  on conflict (affiliate_id) do update
    set account_ref = excluded.account_ref, livemode = excluded.livemode,
        details_submitted = excluded.details_submitted, payouts_enabled = excluded.payouts_enabled,
        transfers_active = excluded.transfers_active, disabled_reason = excluded.disabled_reason,
        due = excluded.due, checked_at = now()
  returning payouts_enabled and transfers_active
$$;

revoke all on function private.affiliate_payout_account_record(uuid, text, boolean, boolean, boolean, boolean, text,
  text[]) from public;
grant execute on function private.affiliate_payout_account_record(uuid, text, boolean, boolean, boolean, boolean,
  text, text[]) to service_actor;

/**
 * This month's payouts, made: one for each affiliate owed at least `p_min` whose bank at Stripe, made with a key of
 * the same mode, can take it, and who has none this month yet. What's owed is every share free to pay out that no
 * payout has taken, less what was taken back; each is tied to the payout. Nothing while staff have payouts off.
 */
create or replace function private.affiliate_payouts_build(p_min integer, p_livemode boolean)
returns table (payout_id uuid, affiliate_id uuid, amount_cents integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
  v record;
  v_id uuid;
begin
  if not coalesce((select s.payouts_on from platform.affiliate_settings s where s.id), false) then
    return;
  end if;
  for v in
    select a.affiliate_id, a.account_ref, sum(c.amount_cents)::integer as owed
    from platform.affiliate_payout_accounts a
    join platform.affiliate_commissions c
      on c.affiliate_id = a.affiliate_id and c.payout_id is null and c.payable_at <= now()
    where a.livemode = p_livemode and a.payouts_enabled and a.transfers_active
      and not exists (select 1 from platform.affiliate_payouts p
                      where p.affiliate_id = a.affiliate_id and p.month = v_month)
    group by a.affiliate_id, a.account_ref
    having sum(c.amount_cents) >= p_min
    order by a.affiliate_id
    limit 200
  loop
    -- Their shares, locked, so a payout built beside this one takes none of them.
    perform 1 from platform.affiliates x where x.id = v.affiliate_id for update;
    insert into platform.affiliate_payouts (affiliate_id, month, amount_cents, livemode, account_ref)
    select v.affiliate_id, v_month, sum(c.amount_cents)::integer, p_livemode, v.account_ref
    from platform.affiliate_commissions c
    where c.affiliate_id = v.affiliate_id and c.payout_id is null and c.payable_at <= now()
    having sum(c.amount_cents) >= p_min
    on conflict on constraint affiliate_payouts_affiliate_id_month_key do nothing
    returning id into v_id;
    continue when v_id is null;
    update platform.affiliate_commissions c set payout_id = v_id
     where c.affiliate_id = v.affiliate_id and c.payout_id is null and c.payable_at <= now();
    return query select p.id, p.affiliate_id, p.amount_cents from platform.affiliate_payouts p where p.id = v_id;
  end loop;
end $$;

revoke all on function private.affiliate_payouts_build(integer, boolean) from public;
grant execute on function private.affiliate_payouts_build(integer, boolean) to service_actor;

/**
 * Payouts to send: each one not sent yet, and each one held whose bank at Stripe can take it now, with the account
 * to send to. While staff have payouts off, none.
 */
create or replace function private.affiliate_payouts_to_send(p_livemode boolean, p_limit integer)
returns table (payout_id uuid, affiliate_id uuid, amount_cents integer, month date, status text,
               account_ref text, ready boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.affiliate_id, p.amount_cents, p.month, p.status, coalesce(a.account_ref, p.account_ref),
         coalesce(a.payouts_enabled and a.transfers_active, false)
  from platform.affiliate_payouts p
  left join platform.affiliate_payout_accounts a on a.affiliate_id = p.affiliate_id
  cross join platform.affiliate_settings s
  where s.id and s.payouts_on and p.livemode = p_livemode
    and (p.status = 'sending'
         or (p.status = 'held' and coalesce(a.payouts_enabled and a.transfers_active, false)))
  order by p.created_at
  limit p_limit
$$;

revoke all on function private.affiliate_payouts_to_send(boolean, integer) from public;
grant execute on function private.affiliate_payouts_to_send(boolean, integer) to service_actor;

/**
 * Accounts to ask Stripe about again: one that can't be paid yet, of an affiliate with a payout held or owed at
 * least `p_min`, not asked in the last six hours. Stripe's word comes when they finish its form and come back to
 * their page; this catches the ones who didn't come back.
 */
create or replace function private.affiliate_payout_accounts_to_check(p_min integer, p_livemode boolean,
  p_limit integer)
returns table (affiliate_id uuid, account_ref text)
language sql stable security definer set search_path = '' as $$
  select a.affiliate_id, a.account_ref
  from platform.affiliate_payout_accounts a
  cross join platform.affiliate_settings s
  where s.id and s.payouts_on and a.livemode = p_livemode
    and not (a.payouts_enabled and a.transfers_active)
    and a.checked_at < now() - interval '6 hours'
    and (exists (select 1 from platform.affiliate_payouts p where p.affiliate_id = a.affiliate_id and p.status = 'held')
         or (select coalesce(sum(c.amount_cents), 0) from platform.affiliate_commissions c
             where c.affiliate_id = a.affiliate_id and c.payout_id is null and c.payable_at <= now()) >= p_min)
  order by a.checked_at
  limit p_limit
$$;

revoke all on function private.affiliate_payout_accounts_to_check(integer, boolean, integer) from public;
grant execute on function private.affiliate_payout_accounts_to_check(integer, boolean, integer) to service_actor;

/**
 * What became of sending a payout: sent, with Stripe's transfer, or held because Stripe won't take it for them yet.
 * A payout already sent stays sent. Answers whether this changed it.
 */
create or replace function private.affiliate_payout_record(p_payout uuid, p_transfer text, p_account text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_transfer is not null then
    update platform.affiliate_payouts
       set status = 'paid', transfer_ref = p_transfer, account_ref = coalesce(p_account, account_ref),
           paid_at = now()
     where id = p_payout and status <> 'paid';
  else
    update platform.affiliate_payouts set status = 'held' where id = p_payout and status = 'sending';
  end if;
  return found;
end $$;

revoke all on function private.affiliate_payout_record(uuid, text, text) from public;
grant execute on function private.affiliate_payout_record(uuid, text, text) to service_actor;

/** A sent payout, claimed for its email: true once, so they're told once. */
create or replace function private.affiliate_payout_claim_email(p_payout uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update platform.affiliate_payouts set emailed_at = now()
   where id = p_payout and status = 'paid' and emailed_at is null;
  return found;
end $$;

revoke all on function private.affiliate_payout_claim_email(uuid) from public;
grant execute on function private.affiliate_payout_claim_email(uuid) to service_actor;
