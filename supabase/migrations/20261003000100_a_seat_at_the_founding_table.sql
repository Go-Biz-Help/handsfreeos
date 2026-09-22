-- =============================================================================
-- 0091 · The founding offers: twenty-five seats, then a hundred, and a count
--        that cannot be talked past.
--
--        Phase 1 and Phase 2 of the growth plan. A business applies, somebody
--        here approves it, and that approval is what takes a seat — not a
--        sign-up, not a payment. So the cap is enforced where the approval
--        lands, and nowhere else has to remember it.
--
--        **The cap is a row, not a constant.** Twenty-five is a decision, and
--        decisions change: a twenty-sixth founding partner worth having should
--        cost one edit in /admin and an audit row, not a deploy. The same
--        reason the rate card (0071) is a table.
--
--        **Oversold is the failure that matters.** Count-then-insert is a race:
--        two approvals read twenty-four at the same moment, both write, and
--        twenty-six people have been promised twenty-five free accounts. There
--        is no apology for that which keeps the person. So the count is taken
--        by a trigger that locks the offer's own row first, and every path that
--        could take a seat goes through it — staff, support, the worker, a
--        migration. There is no system actor bypass here, deliberately: a cap
--        somebody can step around is not a cap.
--
--        **A revoked seat frees at once; the business keeps its grace.** These
--        are two different facts and they live in two different places. The
--        grant goes `revoked` immediately, so remaining goes up by one and the
--        next applicant can be approved this afternoon. The workspace's plan
--        goes to `grace` with a date, and until that date nothing about their
--        account changes. Trying to hold both in one status is what would make
--        a seat unfillable for a fortnight for no reason.
--
--        **Where things live.** The offers, the applications and the grants are
--        HandsFreeOS's own, so they sit in `platform`, beside the support desk
--        and the rate card. What a *workspace* is entitled to is a tenant fact
--        that the app reads on every gate, so `app.workspace_plans` sits in
--        `app` under ordinary tenant RLS. That split is also what keeps
--        `revoke_reason` — written for us, not for them — out of any policy a
--        business can read through.
--
--        Nothing here reads the usage wallet and the wallet reads nothing here,
--        for the reason 0072's header gives: one spends a prepaid balance, the
--        other says what a workspace may use at all. A founding partner's $10
--        of credit is an ordinary wallet ledger row put there by support.
-- =============================================================================

-- ---------- what an offer is ----------
-- `draft` is being written and is invisible; `open` takes applications and grants seats; `closed` still shows
-- its count on the website and still holds everyone already in it, but grants nothing new.
create type platform.founding_offer_status as enum ('draft', 'open', 'closed');

-- `reserved` and `active` are the two that **hold a seat**. A reservation is an approval that has not been
-- taken up yet: the seat is theirs and nobody else can have it until it expires. `revoked` and `expired` hold
-- nothing, which is what makes a revocation free a seat the instant it is written.
create type platform.founding_grant_status as enum ('reserved', 'active', 'revoked', 'expired');

create type platform.founding_application_status as enum (
  'pending', 'approved', 'declined', 'waitlisted', 'expired', 'withdrawn');

create table platform.founding_offers (
  /** Stable and readable, because it is in URLs, in emails and in the website's own markup. */
  id text primary key check (id ~ '^[a-z][a-z0-9_]{2,40}$'),
  name text not null check (length(name) between 1 and 80),
  /**
   * How many seats exist. Raising it opens exactly that many more; lowering it below what is already held is
   * refused by private.guard_founding_offer, because the alternative is deciding which existing partner to
   * throw out by accident.
   */
  seat_cap integer not null check (seat_cap between 0 and 100000),
  /** What the seat costs, once. 0 is Phase 1. 49700 is Phase 2. A cycle price is not this column. */
  price_cents integer not null default 0 check (price_cents >= 0),
  status platform.founding_offer_status not null default 'draft',
  /** Whether the public counter prints this offer's numbers. A draft offer is never published by this alone. */
  show_counter boolean not null default true,
  /** What a seat comes with in the usage wallet, in cents. Phase 1 is 1000; Phase 2 is 0. */
  starting_credit_cents integer not null default 0 check (starting_credit_cents >= 0),
  /** How long an approval is held before the seat goes back in the pool. */
  claim_days integer not null default 14 check (claim_days between 1 and 365),
  /** How long a revoked business goes on working before its plan converts. */
  grace_days integer not null default 14 check (grace_days between 0 and 365),
  sort integer not null default 0,
  blurb text not null default '' check (length(blurb) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger founding_offers_updated_at before update on platform.founding_offers
  for each row execute function private.set_updated_at();

comment on table platform.founding_offers is
  'A capped promotional offer: how many seats it has, what a seat costs once, and whether it is taking '
  'applications. The cap is a row rather than a constant so that raising it is an edit with an audit trail.';

-- ---------- who holds a seat ----------
create table platform.founding_grants (
  id uuid primary key default gen_random_uuid(),
  offer_id text not null references platform.founding_offers (id),
  /** A seat belongs to a **business**, not a person and not a workspace. */
  organization_id uuid not null references app.organizations (id) on delete cascade,
  /** The one workspace the deal covers. Null until they claim: an approval can precede a sign-up. */
  workspace_id uuid references app.workspaces (id) on delete set null,
  status platform.founding_grant_status not null default 'reserved',
  application_id uuid,
  reserved_at timestamptz not null default now(),
  /** When the reservation lapses. Null once activated: an active seat does not expire. */
  expires_at timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.users (id) on delete set null,
  /** Ours to read, never theirs. Kept forever, so a decision can still be explained a year later. */
  revoke_reason text not null default '' check (length(revoke_reason) <= 1000),
  granted_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint founding_grants_reserved_has_deadline
    check (status <> 'reserved' or expires_at is not null),
  constraint founding_grants_active_has_workspace
    check (status <> 'active' or (workspace_id is not null and activated_at is not null)),
  constraint founding_grants_revoked_has_reason
    check (status <> 'revoked' or (revoked_at is not null and length(revoke_reason) > 0))
);

/**
 * One business, one seat. The partial index is over exactly the two statuses that hold one, so a business
 * whose seat was revoked may be given another later without the index arguing about the old row.
 */
create unique index founding_grants_one_live_per_org on platform.founding_grants (organization_id)
  where status in ('reserved', 'active');
create index founding_grants_offer_idx on platform.founding_grants (offer_id, status);
create index founding_grants_workspace_idx on platform.founding_grants (workspace_id)
  where workspace_id is not null;
create index founding_grants_expiry_idx on platform.founding_grants (expires_at)
  where status = 'reserved';

create trigger founding_grants_updated_at before update on platform.founding_grants
  for each row execute function private.set_updated_at();

comment on table platform.founding_grants is
  'One row per business holding a founding seat. `reserved` and `active` hold a seat against the offer''s cap; '
  '`revoked` and `expired` do not, which is why revoking frees the seat the moment it is written.';

-- ---------- the applications, and the waitlist ----------
create table platform.founding_applications (
  id uuid primary key default gen_random_uuid(),
  offer_id text not null references platform.founding_offers (id),
  business_name text not null check (length(business_name) between 1 and 200),
  contact_name text not null check (length(contact_name) between 1 and 200),
  email extensions.citext not null check (length(email) between 3 and 320),
  phone text check (length(phone) <= 40),
  website text check (length(website) <= 500),
  industry text check (length(industry) <= 120),
  team_size text check (length(team_size) <= 40),
  /** Their words, kept as sent. What Phase 1 is actually for is reading these. */
  note text not null default '' check (length(note) <= 4000),
  status platform.founding_application_status not null default 'pending',
  /** Where they came from, so Phase 3 can tell which channels brought the businesses worth having. */
  source text not null default '' check (length(source) <= 300),
  reviewed_at timestamptz,
  reviewed_by uuid references app.users (id) on delete set null,
  /** Staff-only. Never shown to the applicant, which is what lets it be honest. */
  decision_note text not null default '' check (length(decision_note) <= 2000),
  /**
   * Only the sha256 of the claim link is stored, the way an invitation's is (0004). The token itself is shown
   * once, to the person sending the email, and is never readable again from here — which matters more here
   * than for an invitation, because this link is worth a free account for life.
   */
  claim_token_hash bytea unique,
  claim_expires_at timestamptz,
  grant_id uuid references platform.founding_grants (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/** One live application per address per offer. A declined or withdrawn one never blocks a second try. */
create unique index founding_applications_one_live_per_email
  on platform.founding_applications (offer_id, email)
  where status in ('pending', 'approved', 'waitlisted');
create index founding_applications_queue_idx
  on platform.founding_applications (offer_id, status, created_at);

create trigger founding_applications_updated_at before update on platform.founding_applications
  for each row execute function private.set_updated_at();

alter table platform.founding_grants
  add constraint founding_grants_application_fk
  foreign key (application_id) references platform.founding_applications (id) on delete set null;

comment on table platform.founding_applications is
  'Applications for a founding seat, and the waitlist once an offer is full. `decision_note` is staff-only and '
  'no tenant policy reaches this table at all.';

-- ---------- what a workspace is entitled to ----------
create type app.plan_kind as enum ('founding_free', 'founding_lifetime', 'monthly');

-- `grace` is a revoked founding deal still working out its notice. `past_due` is the grace having run out with
-- nothing to bill. Neither is `canceled`, which is them leaving rather than us.
create type app.plan_status as enum ('active', 'grace', 'past_due', 'canceled');

create table app.workspace_plans (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  organization_id uuid not null references app.organizations (id) on delete cascade,
  plan app.plan_kind not null,
  status app.plan_status not null default 'active',
  /** The seat this plan came from, when it came from one. Null for anyone who simply paid. */
  grant_id uuid references platform.founding_grants (id) on delete set null,
  /** What this workspace is billed on a cycle, in cents. A founding plan is 0 and always will be. */
  price_cents integer not null default 0 check (price_cents >= 0),
  /** When a `grace` ends. The one date in here a business is shown and warned about. */
  grace_ends_at timestamptz,
  canceled_at timestamptz,
  /** Stripe lives here in Phase 2. Nothing in Phase 1 writes either column. */
  stripe_customer_id text check (length(stripe_customer_id) <= 100),
  stripe_subscription_id text check (length(stripe_subscription_id) <= 100),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_plans_grace_has_a_date check (status <> 'grace' or grace_ends_at is not null)
);

create index workspace_plans_org_idx on app.workspace_plans (organization_id);
create index workspace_plans_grace_idx on app.workspace_plans (grace_ends_at)
  where status = 'grace';

create trigger workspace_plans_updated_at before update on app.workspace_plans
  for each row execute function private.set_updated_at();

comment on table app.workspace_plans is
  'What one workspace may use, and why. Every gate in the app reads this row. A founding deal covers exactly '
  'one workspace: a second workspace under the same organization gets its own row at the monthly price.';

-- ---------- the cap ----------
/**
 * How many seats an offer has out. `reserved` and `active`, and nothing else.
 *
 * Every reader goes through this rather than writing the status list again — the one that writes it again is
 * the one that forgets `reserved` and oversells by however many approvals are outstanding.
 */
create or replace function private.founding_seats_held(p_offer text)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from platform.founding_grants g
  where g.offer_id = p_offer and g.status in ('reserved', 'active')
$$;

/**
 * The cap, enforced where a seat is actually taken.
 *
 * `for update` on the offer's own row is the whole of it. Two approvals arriving together serialise there: the
 * first counts twenty-four, writes, and commits; the second then counts twenty-five and is refused. Without
 * the lock both read twenty-four and both write, and the promise is broken quietly.
 *
 * It fires on insert **and** on any update that moves a grant into a seat-holding status, which is what makes
 * restoring a revoked grant safe: if the seat was given away in the meantime, the restore is refused rather
 * than silently making twenty-six.
 *
 * There is no system-actor bypass. The worker cannot step around this, and neither can a migration.
 */
create or replace function private.guard_founding_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_cap integer;
  v_status platform.founding_offer_status;
  v_held integer;
  v_was_held boolean := tg_op = 'UPDATE' and old.status in ('reserved', 'active');
begin
  -- Leaving a seat, or never in one, needs no permission from the cap.
  if new.status not in ('reserved', 'active') or v_was_held then
    return new;
  end if;

  select o.seat_cap, o.status into v_cap, v_status
  from platform.founding_offers o where o.id = new.offer_id for update;

  if v_cap is null then
    raise exception 'There is no offer called %', new.offer_id
      using errcode = '23503', detail = 'founding_offer_missing';
  end if;
  if v_status <> 'open' then
    raise exception 'The % offer is not taking anybody new', new.offer_id
      using errcode = '23514', detail = 'founding_offer_closed';
  end if;

  v_held := private.founding_seats_held(new.offer_id);
  if v_held >= v_cap then
    raise exception 'Every seat in % is taken (% of %)', new.offer_id, v_held, v_cap
      using errcode = '23514', detail = 'founding_offer_full';
  end if;
  return new;
end $$;

create trigger founding_grants_cap before insert or update on platform.founding_grants
  for each row execute function private.guard_founding_seat();

/**
 * A cap may be raised whenever you like. Lowering it below what is already out is refused, because the only
 * ways to honour it would be to throw somebody out at random or to let the number lie.
 */
create or replace function private.guard_founding_offer()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_held integer;
begin
  if new.seat_cap < old.seat_cap then
    v_held := private.founding_seats_held(new.id);
    if new.seat_cap < v_held then
      raise exception 'There are already % seats out in %; the cap cannot go below that', v_held, new.id
        using errcode = '23514', detail = 'founding_cap_below_held';
    end if;
  end if;
  return new;
end $$;

create trigger founding_offers_guard before update on platform.founding_offers
  for each row execute function private.guard_founding_offer();

/**
 * What the website prints, and the only founding read that is open to the world.
 *
 * Four numbers per offer and nothing else: no applicant, no business, no name. `remaining` is clamped at zero
 * so that raising a cap and lowering it again can never show a negative.
 */
create or replace view platform.founding_counts as
  select o.id, o.name, o.blurb, o.status, o.price_cents, o.seat_cap,
         private.founding_seats_held(o.id) as claimed,
         greatest(o.seat_cap - private.founding_seats_held(o.id), 0) as remaining,
         o.sort
  from platform.founding_offers o
  where o.show_counter and o.status <> 'draft';

comment on view platform.founding_counts is
  'The four numbers the marketing site prints. No applicant and no business is reachable through it.';

-- ---------- the starting credit ----------
/**
 * Put an offer's starting credit in a workspace's wallet.
 *
 * `private.staff_credit_wallet` (0076) cannot be used for this: it asks whether the **caller** is staff with
 * `platform.wallets.adjust`, and the caller here is the worker running a claim for somebody who has just
 * followed a link. So the authority comes from the grant instead — an active seat, on an offer that grants a
 * credit, is itself the permission. Nothing about the caller is consulted and nothing about the caller needs
 * to be, because there is no argument to point this at another business: the workspace and the amount are
 * both read off the grant.
 *
 * Idempotent by the ledger's own key, so a link followed twice credits once. That is the same guarantee the
 * support credit has, by the same means.
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

  -- For this insert only, exactly as 0076 does it, and cleared before anything else in the transaction runs.
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

  perform set_config('app.system_scope.workspace_id', '', true);

  return query select case when v_entry is null then 0::bigint else v_amount end, v_entry is not null;
end $$;

grant execute on function private.founding_credit_wallet(uuid) to authenticated, service_actor;

-- ---------- who may see what ----------
alter table platform.founding_offers enable row level security;
alter table platform.founding_grants enable row level security;
alter table platform.founding_applications enable row level security;
alter table app.workspace_plans enable row level security;

-- The offers are read by any signed-in person: the app's own upgrade screens say "seven seats left" with the
-- same number the website does, and one of them being stale is how somebody is told a seat exists that doesn't.
create policy founding_offers_read on platform.founding_offers for select to authenticated
  using (status <> 'draft');
create policy founding_offers_write on platform.founding_offers for all to authenticated
  using (private.staff_can('platform.founding.manage'))
  with check (private.staff_can('platform.founding.manage'));
create policy founding_offers_service on platform.founding_offers for all to service_actor
  using (true) with check (true);

-- Grants and applications are staff-only. A business learns what it holds from app.workspace_plans, which is
-- why `revoke_reason` and `decision_note` need no policy carve-out: nothing a tenant can select reaches them.
create policy founding_grants_staff on platform.founding_grants for all to authenticated
  using (private.staff_can('platform.founding.manage'))
  with check (private.staff_can('platform.founding.manage'));
create policy founding_grants_service on platform.founding_grants for all to service_actor
  using (true) with check (true);

create policy founding_applications_staff on platform.founding_applications for all to authenticated
  using (private.staff_can('platform.founding.manage'))
  with check (private.staff_can('platform.founding.manage'));
-- The worker writes an application for somebody who is signed out and has no account at all: the form on the
-- website is the only way into this table that is not a member of staff.
create policy founding_applications_service on platform.founding_applications for all to service_actor
  using (true) with check (true);

-- A workspace's own plan, read by anyone in it — `workspace.read` is the one permission every role has, and
-- the billing screen is for members as much as owners. Nobody in a business writes it: the plan is what
-- HandsFreeOS says they may use, and a tenant that could write it could give itself a founding deal.
create policy workspace_plans_read on app.workspace_plans for select to authenticated
  using (private.has_permission(workspace_id, 'workspace.read')
         or private.staff_can('platform.founding.manage'));
create policy workspace_plans_staff on app.workspace_plans for all to authenticated
  using (private.staff_can('platform.founding.manage'))
  with check (private.staff_can('platform.founding.manage'));
create policy workspace_plans_service on app.workspace_plans for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on platform.founding_offers, platform.founding_counts to authenticated;
grant insert, update, delete on platform.founding_offers to authenticated;
grant select, insert, update, delete on platform.founding_grants to authenticated;
grant select, insert, update, delete on platform.founding_applications to authenticated;
grant select on app.workspace_plans to authenticated;
grant insert, update, delete on app.workspace_plans to authenticated;

grant select, insert, update, delete on platform.founding_offers, platform.founding_grants,
  platform.founding_applications, app.workspace_plans to service_actor;
grant select on platform.founding_counts to service_actor;

-- ---------- who, among staff ----------
-- Admins only. Approving a founding partner is giving away a product forever, and revoking one is taking it
-- back; neither belongs to the person answering tickets. Mirrored in core's ROLE_PERMISSIONS.
insert into app.role_permissions (role, permission) values
  ('staff_admin', 'platform.founding.manage');

-- ---------- the two offers ----------
-- Both start `draft`: the tables exist and the admin page works before anything is visible to anybody. Opening
-- Phase 1 is somebody deciding to, the same way WALLET_MODE is.
insert into platform.founding_offers
  (id, name, seat_cap, price_cents, status, starting_credit_cents, sort, blurb) values
  ('founding_partner', 'Founding Partner', 25, 0, 'draft', 1000, 1,
    'Free for life, in exchange for telling us the truth about what is missing. Texts, calls and AI are billed for what you use.'),
  ('founding_lifetime', 'Founding Customer', 100, 49700, 'draft', 0, 2,
    'Pay once, use it for as long as HandsFreeOS exists. Texts, calls and AI are billed for what you use.');
