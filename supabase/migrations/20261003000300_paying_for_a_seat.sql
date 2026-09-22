-- =============================================================================
-- 0093 · Taking up a seat, and paying for one.
--
--        **The claim link works for the people it is sent to.** 0091's
--        claim ran as the person following the link, and every founding
--        table is staff-only to a signed-in person — so it found no
--        application for any token and told everybody their link had
--        expired. The link is the authority here, the way an invitation's
--        is: the functions below find the seat by the token's hash, then
--        check the two things about the person that matter. They run the
--        workspace the seat is going on, and that workspace belongs to the
--        business the seat was approved for. Nothing else about them is
--        consulted, and nothing a person can pass points them at somebody
--        else's seat.
--
--        **A paid seat is paid for at Stripe Checkout.** Following the link
--        to a $497 seat starts a checkout instead of taking the seat up: a
--        row here, `pending`, which the worker turns into a Stripe page and
--        then into `paid` when Stripe says the money is in. The seat stays
--        reserved the whole time — it was held the moment staff approved it
--        — so a slow card cannot lose somebody the place they were promised.
--        One live checkout per seat, and the reservation is stretched to
--        outlast the page, so the seat cannot lapse under somebody who is
--        typing their card number.
--
--        **One way to take a seat up.** Free or paid, the seat goes active,
--        the workspace gets its plan and the starting credit lands through
--        `private.founding_activate`, so the two paths cannot drift.
--
--        **An unpaid reservation lapses.** 0091 wrote a deadline on every
--        reservation and nothing ever read it: a seat approved for somebody
--        who never came back was held for ever, and counted against the cap
--        and the chain (0092). `private.founding_expire_reservations` gives
--        those seats back, hourly, from the worker — never one with a
--        checkout still open on it.
-- =============================================================================

-- ---------- the checkouts ----------
create type platform.founding_checkout_status as enum ('pending', 'open', 'paid', 'expired', 'failed');

create table platform.founding_checkouts (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references platform.founding_grants (id) on delete cascade,
  offer_id text not null references platform.founding_offers (id),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  /** The workspace the seat goes on when the money is in. Chosen by the person paying, checked against the grant. */
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  /** The offer's price when the checkout started. A price changed afterwards does not move a page already open. */
  amount_cents integer not null check (amount_cents > 0),
  status platform.founding_checkout_status not null default 'pending',
  /** Stripe's `cs_…`, once the worker has made the page. */
  session_ref text unique check (length(session_ref) <= 255),
  session_url text check (length(session_url) <= 2000),
  session_expires_at timestamptz,
  /** Stripe's `pi_…`: what a refund, if there is ever one, is made against. */
  payment_ref text check (length(payment_ref) <= 255),
  paid_cents integer check (paid_cents is null or paid_cents >= 0),
  requested_by uuid references app.users (id) on delete set null,
  /**
   * Why it did not go through, or — on a `paid` row — why the seat did not go active with it. A payment that
   * lands on a seat somebody revoked meanwhile is recorded, never refused: the money is real, and staff decide.
   */
  problem text not null default '' check (length(problem) <= 1000),
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  paid_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint founding_checkouts_open_has_page
    check (status <> 'open' or (session_ref is not null and session_url is not null)),
  constraint founding_checkouts_paid_has_date check (status <> 'paid' or paid_at is not null)
);

/** One live checkout per seat: a second press of "Pay" picks the first one back up instead of making another. */
create unique index founding_checkouts_one_live_per_grant on platform.founding_checkouts (grant_id)
  where status in ('pending', 'open');
create index founding_checkouts_workspace_idx on platform.founding_checkouts (workspace_id);

create trigger founding_checkouts_updated_at before update on platform.founding_checkouts
  for each row execute function private.set_updated_at();

comment on table platform.founding_checkouts is
  'One row per attempt to pay for a founding seat. `pending` has no Stripe page yet, `open` is waiting on the '
  'person, `paid` is the money in. Staff read all of it; the worker reads its own workspace''s; a person reads '
  'theirs only through private.founding_checkout_view.';

alter table platform.founding_checkouts enable row level security;

create policy founding_checkouts_staff on platform.founding_checkouts for all to authenticated
  using (private.staff_can('platform.founding.manage'))
  with check (private.staff_can('platform.founding.manage'));
create policy founding_checkouts_service on platform.founding_checkouts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select, insert, update, delete on platform.founding_checkouts to authenticated, service_actor;

-- ---------- the starting credit, safe inside the worker's own transaction ----------
/**
 * 0091's credit, with one change: the system scope it borrows for the ledger insert is **put back** afterwards
 * rather than blanked. Blanking was harmless while only a signed-in person called this. The worker calls it now
 * too — recording a payment, inside a transaction whose every later write (the events, the outbox, the audit)
 * is allowed by that same scope — and a blank one would have refused the very event that says the seat is
 * theirs.
 */
create or replace function private.founding_credit_wallet(p_grant uuid)
returns table (credited_cents bigint, recorded boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_org uuid;
  v_amount bigint;
  v_offer text;
  v_entry uuid;
  v_scope text := current_setting('app.system_scope.workspace_id', true);
begin
  select g.workspace_id, g.organization_id, o.starting_credit_cents, o.name
    into v_ws, v_org, v_amount, v_offer
  from platform.founding_grants g
  join platform.founding_offers o on o.id = g.offer_id
  where g.id = p_grant and g.status = 'active';

  -- No seat, no workspace on it, or an offer that grants nothing: not an error, simply nothing to do.
  if v_ws is null or coalesce(v_amount, 0) <= 0 then
    return query select 0::bigint, false;
    return;
  end if;

  insert into app.usage_wallets (workspace_id, organization_id)
  values (v_ws, v_org)
  on conflict (workspace_id) do nothing;

  perform set_config('app.system_scope.workspace_id', v_ws::text, true);

  insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, subject,
    idempotency_key, meta, occurred_at)
  values (v_ws, v_org, 'credit'::app.usage_entry_kind, v_amount,
    left('Founding starting credit (' || v_offer || ')', 300),
    'credit:founding:' || p_grant::text,
    jsonb_build_object('reason', 'founding starting credit', 'grant_id', p_grant, 'offer', v_offer),
    now())
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_entry;

  perform set_config('app.system_scope.workspace_id', coalesce(v_scope, ''), true);

  return query select case when v_entry is null then 0::bigint else v_amount end, v_entry is not null;
end $$;

-- ---------- taking a seat up ----------
/**
 * The seat goes active on a workspace, the workspace gets its founding plan, and the offer's starting credit
 * lands. The one path for both a free claim and a paid checkout.
 *
 * A reservation that lapsed can still be taken up — somebody who paid the day after it ran out has paid — but
 * only through the cap's own guard (0091): moving a seat back into `active` is a new seat to that trigger, and
 * it refuses it with `founding_offer_full` if the place went to somebody else. A revoked seat is never taken up
 * here; that is staff's decision, and `founding.restore` is where it is made.
 *
 * Granted to nobody. It is reached only from the functions below, which have already decided who may.
 */
create or replace function private.founding_activate(p_grant uuid, p_workspace uuid)
returns table (plan app.plan_kind, credited_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_price integer;
  v_plan app.plan_kind;
  v_credited bigint;
begin
  select g.organization_id, o.price_cents into v_org, v_price
  from platform.founding_grants g
  join platform.founding_offers o on o.id = g.offer_id
  where g.id = p_grant;

  update platform.founding_grants
     set status = 'active', workspace_id = p_workspace, activated_at = now(), expires_at = null
   where id = p_grant and status in ('reserved', 'expired');
  if not found then
    raise exception 'Grant % cannot be taken up', p_grant
      using errcode = '23514', detail = 'founding_claim_invalid';
  end if;

  v_plan := case when v_price = 0 then 'founding_free'::app.plan_kind else 'founding_lifetime'::app.plan_kind end;

  -- A workspace that somehow already had a plan is moved onto the founding one rather than refused: the seat
  -- was approved by a person, and the alternative is a support ticket to fix a row.
  insert into app.workspace_plans (workspace_id, organization_id, plan, status, grant_id, price_cents)
  values (p_workspace, v_org, v_plan, 'active', p_grant, 0)
  on conflict (workspace_id) do update
    set plan = excluded.plan, status = 'active', grant_id = excluded.grant_id, price_cents = 0,
        grace_ends_at = null, canceled_at = null;

  select c.credited_cents into v_credited from private.founding_credit_wallet(p_grant) c;

  return query select v_plan, coalesce(v_credited, 0::bigint);
end $$;

revoke all on function private.founding_activate(uuid, uuid) from public;

/**
 * The seat a claim link points at, for the page the link opens. Anybody signed in may ask; the answer is only
 * ever about the seat whose token they hold.
 *
 * `state` is `ready` (take it up, or pay for it), `claimed` (already active), `expired` (the link ran out) or
 * `gone` (revoked, or lapsed and given back). `checkout_id` is a checkout already under way on this seat, so
 * the page can pick it up rather than start another.
 */
create or replace function private.founding_seat_by_token(p_token_hash bytea)
returns table (
  grant_id uuid,
  offer_id text,
  offer_name text,
  price_cents integer,
  organization_id uuid,
  business_name text,
  state text,
  expires_at timestamptz,
  checkout_id uuid,
  checkout_workspace_id uuid
)
language sql stable security definer set search_path = '' as $$
  select g.id, o.id, o.name, o.price_cents, g.organization_id, a.business_name,
         case
           when g.status = 'active' then 'claimed'
           when g.status <> 'reserved' then 'gone'
           when a.claim_expires_at is not null and a.claim_expires_at < now() then 'expired'
           else 'ready'
         end,
         a.claim_expires_at,
         c.id, c.workspace_id
  from platform.founding_applications a
  join platform.founding_grants g on g.id = a.grant_id
  join platform.founding_offers o on o.id = g.offer_id
  left join platform.founding_checkouts c on c.grant_id = g.id and c.status in ('pending', 'open')
  where a.claim_token_hash = p_token_hash
$$;

grant execute on function private.founding_seat_by_token(bytea) to authenticated;

/**
 * Everything a person following a link must be, checked in one place and in one order, returning the seat with
 * its row locked. The lock is what makes the link single-use: a second tab pressing the same button waits here,
 * then finds the seat already taken up.
 */
create or replace function private.founding_seat_for_person(p_token_hash bytea, p_workspace uuid)
returns table (grant_id uuid, offer_id text, organization_id uuid, price_cents integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_grant uuid;
  v_offer text;
  v_org uuid;
  v_price integer;
  v_status platform.founding_grant_status;
  v_deadline timestamptz;
begin
  select g.id, g.offer_id, g.organization_id, o.price_cents, g.status, a.claim_expires_at
    into v_grant, v_offer, v_org, v_price, v_status, v_deadline
  from platform.founding_applications a
  join platform.founding_grants g on g.id = a.grant_id
  join platform.founding_offers o on o.id = g.offer_id
  where a.claim_token_hash = p_token_hash
  for update of g;

  -- One refusal for "no such link", "already used" and "expired": the page that opens it says which, from
  -- private.founding_seat_by_token, to the person holding it. Here it only has to be refused.
  if v_grant is null or v_status <> 'reserved' or (v_deadline is not null and v_deadline < now()) then
    raise exception 'That claim link cannot be used'
      using errcode = '23514', detail = 'founding_claim_invalid';
  end if;
  if not private.has_permission(p_workspace, 'workspace.update') then
    raise exception 'Only somebody who runs workspace % can put a seat on it', p_workspace
      using errcode = '42501', detail = 'founding_claim_not_yours';
  end if;
  if private.workspace_organization(p_workspace) is distinct from v_org then
    raise exception 'Workspace % is not in the business this seat was approved for', p_workspace
      using errcode = '23514', detail = 'founding_claim_wrong_business';
  end if;

  return query select v_grant, v_offer, v_org, v_price;
end $$;

revoke all on function private.founding_seat_for_person(bytea, uuid) from public;

/** A free seat, taken up from its link. A paid one is refused: it is taken up by paying for it. */
create or replace function private.founding_claim_free(p_token_hash bytea, p_workspace uuid)
returns table (grant_id uuid, offer_id text, plan app.plan_kind, credited_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_seat record;
  v_done record;
begin
  select * into v_seat from private.founding_seat_for_person(p_token_hash, p_workspace);
  if v_seat.price_cents > 0 then
    raise exception 'Seat % is paid for at checkout', v_seat.grant_id
      using errcode = '23514', detail = 'founding_claim_needs_checkout';
  end if;

  select * into v_done from private.founding_activate(v_seat.grant_id, p_workspace);
  return query select v_seat.grant_id, v_seat.offer_id, v_done.plan, v_done.credited_cents;
end $$;

grant execute on function private.founding_claim_free(bytea, uuid) to authenticated;

/**
 * Start paying for a paid seat, or pick up the checkout already under way on it.
 *
 * A checkout already open for **another** workspace is refused rather than replaced: its page may be open in
 * somebody's browser right now, and taking the money for one workspace while the seat goes on another is the
 * mistake this avoids. It lapses by itself within a day.
 *
 * The reservation is stretched to two days from now, whatever was left of it: Stripe keeps a page open for a
 * day, and a seat that lapsed under somebody typing their card would be taken back at the worst moment.
 */
create or replace function private.founding_open_checkout(p_token_hash bytea, p_workspace uuid)
returns table (checkout_id uuid, status text, session_url text, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_seat record;
  v_live record;
  v_id uuid;
begin
  select * into v_seat from private.founding_seat_for_person(p_token_hash, p_workspace);
  if v_seat.price_cents <= 0 then
    raise exception 'Seat % is free; there is nothing to pay', v_seat.grant_id
      using errcode = '23514', detail = 'founding_claim_is_free';
  end if;

  select c.id, c.workspace_id, c.status, c.session_url into v_live
  from platform.founding_checkouts c
  where c.grant_id = v_seat.grant_id and c.status in ('pending', 'open');

  if v_live.id is not null then
    if v_live.workspace_id <> p_workspace then
      raise exception 'Seat % is already being paid for on workspace %', v_seat.grant_id, v_live.workspace_id
        using errcode = '23514', detail = 'founding_checkout_elsewhere';
    end if;
    return query select v_live.id, v_live.status::text, v_live.session_url, false;
    return;
  end if;

  insert into platform.founding_checkouts
    (grant_id, offer_id, organization_id, workspace_id, amount_cents, requested_by)
  values
    (v_seat.grant_id, v_seat.offer_id, v_seat.organization_id, p_workspace, v_seat.price_cents, auth.uid())
  returning id into v_id;

  update platform.founding_grants
     set expires_at = greatest(expires_at, now() + interval '2 days')
   where id = v_seat.grant_id;

  return query select v_id, 'pending'::text, null::text, true;
end $$;

grant execute on function private.founding_open_checkout(bytea, uuid) to authenticated;

/**
 * One checkout, for the page somebody comes back to from Stripe. Only for somebody who runs the workspace it is
 * for; anybody else is told nothing, not even that it exists.
 */
create or replace function private.founding_checkout_view(p_checkout uuid)
returns table (
  checkout_id uuid,
  workspace_id uuid,
  offer_name text,
  amount_cents integer,
  status text,
  session_url text,
  session_expires_at timestamptz,
  seat_active boolean,
  problem text
)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, o.name, c.amount_cents, c.status::text, c.session_url, c.session_expires_at,
         g.status = 'active' and g.workspace_id = c.workspace_id,
         c.problem
  from platform.founding_checkouts c
  join platform.founding_offers o on o.id = c.offer_id
  join platform.founding_grants g on g.id = c.grant_id
  where c.id = p_checkout and private.has_permission(c.workspace_id, 'workspace.update')
$$;

grant execute on function private.founding_checkout_view(uuid) to authenticated;

-- ---------- the worker's half ----------
/**
 * Where a checkout lives, for a Stripe event that arrives with nothing but the checkout's id. The webhook route
 * has no tenant until it has asked — the same shape as private.payment_connection_by_account.
 */
create or replace function private.founding_checkout_route(p_checkout uuid)
returns table (workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.workspace_id, c.organization_id from platform.founding_checkouts c where c.id = p_checkout
$$;

revoke all on function private.founding_checkout_route(uuid) from public;
grant execute on function private.founding_checkout_route(uuid) to service_actor;

/**
 * The payment is in. Idempotent: Stripe sends an event more than once, and the second is a no-op that says so.
 *
 * `outcome` is `activated` (the seat is theirs), `already` (this was recorded before), or `no_seat` — the money
 * is in but the seat is not theirs to have: revoked meanwhile, or lapsed and given to somebody else. That is
 * written on the checkout for staff, who refund it or find a seat; the person paid, and is never told the
 * payment "failed".
 */
create or replace function private.founding_checkout_paid(
  p_checkout uuid,
  p_session_ref text,
  p_payment_ref text,
  p_paid_cents integer
)
returns table (outcome text, grant_id uuid, offer_id text, plan app.plan_kind, credited_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_c record;
  v_done record;
begin
  select c.id, c.status, c.grant_id, c.offer_id, c.workspace_id, c.amount_cents into v_c
  from platform.founding_checkouts c
  where c.id = p_checkout
  for update;

  if v_c.id is null then
    raise exception 'There is no checkout %', p_checkout
      using errcode = '23503', detail = 'founding_checkout_missing';
  end if;
  if v_c.status = 'paid' then
    return query select 'already'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
    return;
  end if;

  update platform.founding_checkouts
     set status = 'paid', paid_at = now(), closed_at = now(),
         session_ref = coalesce(session_ref, p_session_ref), payment_ref = p_payment_ref,
         paid_cents = p_paid_cents
   where id = p_checkout;

  if coalesce(p_paid_cents, 0) < v_c.amount_cents then
    update platform.founding_checkouts
       set problem = format('Stripe says %s cents were paid; the seat costs %s. The seat was not turned on.',
                            coalesce(p_paid_cents, 0), v_c.amount_cents)
     where id = p_checkout;
    return query select 'no_seat'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
    return;
  end if;

  begin
    select * into v_done from private.founding_activate(v_c.grant_id, v_c.workspace_id);
  exception when check_violation then
    -- Revoked meanwhile (founding_claim_invalid), or lapsed and given away (founding_offer_full): the money is
    -- in and the seat is not. Recorded, for staff; nothing is undone. Only the seat's own refusals land here —
    -- anything else (a deadlock, a dropped connection) rolls the whole thing back and Stripe's event is tried
    -- again, rather than being written down as a seat that could not be had.
    update platform.founding_checkouts
       set problem = left('Paid, but the seat could not be turned on: ' || sqlerrm, 1000)
     where id = p_checkout;
    return query select 'no_seat'::text, v_c.grant_id, v_c.offer_id, null::app.plan_kind, 0::bigint;
    return;
  end;

  return query select 'activated'::text, v_c.grant_id, v_c.offer_id, v_done.plan, v_done.credited_cents;
end $$;

revoke all on function private.founding_checkout_paid(uuid, text, text, integer) from public;
grant execute on function private.founding_checkout_paid(uuid, text, text, integer) to service_actor;

/** The worker made the Stripe page. Written once; a retry that made the same page again changes nothing. */
create or replace function private.founding_checkout_opened(
  p_checkout uuid,
  p_session_ref text,
  p_session_url text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update platform.founding_checkouts
     set status = 'open', session_ref = p_session_ref, session_url = p_session_url,
         session_expires_at = p_expires_at, opened_at = now()
   where id = p_checkout and status = 'pending';
  return found;
end $$;

revoke all on function private.founding_checkout_opened(uuid, text, text, timestamptz) from public;
grant execute on function private.founding_checkout_opened(uuid, text, text, timestamptz) to service_actor;

/** A checkout that will not be paid: Stripe's page lapsed, or the page could not be made at all. */
create or replace function private.founding_checkout_closed(p_checkout uuid, p_status text, p_problem text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('expired', 'failed') then
    raise exception 'A checkout closes as expired or failed, not %', p_status
      using errcode = '22023', detail = 'founding_checkout_bad_status';
  end if;
  update platform.founding_checkouts
     set status = p_status::platform.founding_checkout_status, closed_at = now(),
         problem = left(coalesce(p_problem, ''), 1000)
   where id = p_checkout and status in ('pending', 'open');
  return found;
end $$;

revoke all on function private.founding_checkout_closed(uuid, text, text) from public;
grant execute on function private.founding_checkout_closed(uuid, text, text) to service_actor;

-- ---------- reservations run out ----------
/**
 * Give back every seat whose reservation ran out and has nothing under way on it. A checkout counts as under way
 * until an hour after its page lapsed at Stripe — the hour is for the event that says so, which closes it
 * properly — and a checkout still `pending` a day after it was asked for is a page that was never made.
 *
 * Returns how many seats went back. Run hourly by the worker.
 */
create or replace function private.founding_expire_reservations()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update platform.founding_checkouts c
     set status = 'expired', closed_at = now(),
         problem = case when c.status = 'pending' then 'The payment page was never made.' else c.problem end
   where c.status in ('pending', 'open')
     and coalesce(c.session_expires_at, c.created_at + interval '1 day') < now() - interval '1 hour';

  with lapsed as (
    update platform.founding_grants g
       set status = 'expired'
     where g.status = 'reserved'
       and g.expires_at < now()
       and not exists (select 1 from platform.founding_checkouts c
                        where c.grant_id = g.id and c.status in ('pending', 'open'))
    returning g.id)
  select count(*) into v_count from lapsed;
  return v_count;
end $$;

revoke all on function private.founding_expire_reservations() from public;
grant execute on function private.founding_expire_reservations() to service_actor;
