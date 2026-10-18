-- =============================================================================
-- The partner's page (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2c).
--
--        A partner is a contact of the business, so they sign in to its
--        portal as any client does (`portal_access`). Their page there
--        (`portal.partner`) shows their link, the clients they sent by
--        first name and last initial, and what they earned: what's waiting
--        its 30 days, what's free to pay out, and what a dispute holds.
--        They accept the business's partner terms there
--        (`portal.partner_accept_terms`, a customer command, which runs as
--        the worker and checks the partner is them).
--
--        portal_actor never reaches `private`, nor the partner tables, nor
--        the business's settings, nor other customers' names. These look-ups
--        hand back only the signed-in partner's own, and only the columns
--        their page shows. What's earned is worked out as the business's own
--        Partners page works it out (packages/core/src/queries/partners.ts):
--        payments in a provider's test mode never count, and an open dispute
--        holds its payment's share.
--
-- Only adds: five portal functions.
-- =============================================================================

-- Their partner record, when the signed-in person is a partner of the business.
create or replace function portal.partner()
returns table (id uuid, code text, rate_bp integer, status text, terms_version integer,
  terms_accepted_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select pa.id, pa.code, pa.rate_bp, pa.status, pa.terms_version, pa.terms_accepted_at, pa.created_at
  from app.partners pa
  where pa.workspace_id = portal.workspace() and pa.person_id = portal.person()
$$;

-- The business's partner settings, for its partners only: the share they earn unless they have their own, the
-- terms they accept and their version, and the smallest payout.
create or replace function portal.partner_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(w.settings -> 'partners', '{}'::jsonb) from app.workspaces w
  where w.id = portal.workspace() and exists (select 1 from portal.partner())
$$;

-- The calendar their link books: the one the settings name while it takes bookings, else the first that does.
create or replace function portal.partner_link_calendar()
returns uuid language sql stable security definer set search_path = '' as $$
  select c.id from app.calendars c
  where c.workspace_id = portal.workspace() and c.public and c.status = 'active'
    and exists (select 1 from portal.partner())
  order by (c.id::text = coalesce((select w.settings -> 'partners' ->> 'calendarId' from app.workspaces w
      where w.id = portal.workspace()), '')) desc, c.created_at, c.id
  limit 1
$$;

-- The clients they sent, the newest first, by first name and last initial only: nobody's full name, email or
-- number. A client deleted for good, or in the Deleted bin, has no name here.
create or replace function portal.partner_clients()
returns table (referral_id uuid, first_name text, last_initial text, how text, referred_at timestamptz,
  first_paid_at timestamptz, earned_cents bigint)
language sql stable security definer set search_path = '' as $$
  select r.id,
    case when p.bin_item_id is null and p.erased_at is null then nullif(btrim(p.first_name), '') end,
    case when p.bin_item_id is null and p.erased_at is null then upper(left(nullif(btrim(p.last_name), ''), 1)) end,
    r.how, r.referred_at, r.first_paid_at,
    coalesce((select sum(c.amount_cents) from app.partner_commissions c
      where c.referral_id = r.id and not c.test), 0)::bigint
  from app.partner_referrals r
  join app.partners pa on pa.id = r.partner_id
  left join app.people p on p.id = r.person_id
  where pa.workspace_id = portal.workspace() and pa.person_id = portal.person()
  order by r.referred_at desc, r.id
$$;

-- What they earned: everything less what was taken back, what's waiting its 30 days, what's free to pay out, and
-- what an open dispute holds.
create or replace function portal.partner_earnings()
returns table (earned_cents bigint, waiting_cents bigint, payable_cents bigint, held_cents bigint)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(c.amount_cents), 0)::bigint,
    coalesce(sum(c.amount_cents) filter (where not h.held and c.payable_at > now()), 0)::bigint,
    coalesce(sum(c.amount_cents) filter (where not h.held and c.payable_at <= now()), 0)::bigint,
    coalesce(sum(c.amount_cents) filter (where h.held), 0)::bigint
  from app.partner_commissions c
  join app.partners pa on pa.id = c.partner_id
  cross join lateral (select exists (select 1 from app.payment_disputes d
      where d.payment_id = c.payment_id and d.status = 'open') as held) h
  where pa.workspace_id = portal.workspace() and pa.person_id = portal.person() and not c.test
$$;

revoke all on function portal.partner(), portal.partner_settings(), portal.partner_link_calendar(),
  portal.partner_clients(), portal.partner_earnings() from public;
grant execute on function portal.partner(), portal.partner_settings(), portal.partner_link_calendar(),
  portal.partner_clients(), portal.partner_earnings() to portal_actor;
