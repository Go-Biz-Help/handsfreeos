/**
 * Reading the founding offers (0091).
 *
 * Three readers, deliberately kept apart because they are owed different amounts of truth:
 *
 * - `founding.counts` is what the **website** prints. Four numbers an offer, and no applicant, no business
 *   and no email anywhere in it. It runs as the system actor because the worker serves it to people who are
 *   signed out, over a route with no token at all.
 * - `platform.founding` is the **admin** page: the queue, the seats and the reasons. Staff only.
 * - `founding.mine` is what a **business** may know about itself: which plan it is on and, if its seat was
 *   taken back, the date that matters. Never why — the reason was written for us.
 * - `platform.founding.business` is one business's seat, for its page under /admin/businesses, where a seat can
 *   be given to any business on the list. Staff only, like the admin page.
 * - `founding.code_preview` is what a discount or trial code takes off each plan, for the plan page before Pay
 *   (20261027014300), for whoever may buy the business's spot.
 */
import { rows, sql } from '@hfos/db/client';
import { defineQuery } from '../kernel/define';
import { HfosError } from '../errors';
import { codeRefusal, hashClaimToken } from '../commands/founding';
import {
  FoundingCheckoutStatusInput,
  FoundingCheckoutStatusOutput,
  FoundingClaimPreviewInput,
  FoundingClaimPreviewOutput,
  FoundingCodePreviewInput,
  FoundingCodePreviewOutput,
  FoundingBusinessInput,
  FoundingBusinessOutput,
  FoundingCountsInput,
  FoundingCountsOutput,
  FoundingMineInput,
  FoundingMineOutput,
  FoundingQueueInput,
  FoundingQueueOutput,
} from '../schemas/founding';

const onPlatform = () => ({ kind: 'platform' as const });
const iso = (d: Date | string | null): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

type CountRow = {
  id: string;
  name: string;
  blurb: string;
  status: 'draft' | 'open' | 'closed';
  price_cents: number;
  seat_cap: number;
  claimed: number | string;
  remaining: number | string;
  billing: 'once' | 'yearly' | 'monthly';
};

export const foundingCounts = defineQuery({
  name: 'founding.counts',
  description:
    'How many spots each public offer has left, and what it costs. The only founding read that reaches somebody signed out, and it carries nothing but numbers.',
  input: FoundingCountsInput,
  output: FoundingCountsOutput,
  permission: null,
  /**
   * `none`, not `platform`: a machine actor may only address the tenant it belongs to, and the staff scope is
   * shut to it outright (`resolveMachineScope`). This carries no tenant data at all, so it needs no scope.
   * The worker's signed-out route reads the same view directly — one view, so the website and the app can
   * never print different numbers.
   */
  scope: () => ({ kind: 'none' as const }),
  actors: ['human'],
  async handler(ctx) {
    const found = await rows<CountRow & { show_counter: boolean; superseded: boolean }>(
      ctx.tx,
      sql`select id, name, blurb, status::text as status, price_cents, seat_cap, claimed, remaining,
            billing, show_counter, superseded
          from platform.founding_counts order by sort, id`,
    );
    return {
      offers: found.map((o) => ({
        offerId: o.id,
        name: o.name,
        blurb: o.blurb,
        status: o.status,
        priceCents: o.price_cents,
        seatCap: o.seat_cap,
        claimed: Number(o.claimed),
        remaining: Number(o.remaining),
        billing: o.billing,
        showCounter: o.show_counter,
        superseded: o.superseded,
      })),
      generatedAt: new Date().toISOString(),
    };
  },
});

export const platformFounding = defineQuery({
  name: 'platform.founding',
  description:
    'The founding offers, the applications waiting on a decision, and who holds a seat. Staff only.',
  input: FoundingQueueInput,
  output: FoundingQueueOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  async handler(ctx, input) {
    const offerFilter = input.offerId ?? null;
    const statusFilter = input.status ?? null;

    const [offers, applications, grants] = await Promise.all([
      rows<
        CountRow & {
          opens_after_offer_id: string | null;
          opens_after_count: number | null;
          opened_at: Date | string | null;
        }
      >(
        ctx.tx,
        sql`select o.id, o.name, o.blurb, o.status::text as status, o.price_cents, o.seat_cap,
              private.founding_seats_held(o.id) as claimed,
              greatest(o.seat_cap - private.founding_seats_held(o.id), 0) as remaining,
              case when o.paid_yearly then 'yearly' else o.billing end as billing,
              o.opens_after_offer_id, o.opens_after_count, o.opened_at
            from platform.founding_offers o order by o.sort, o.id`,
      ),
      rows<{
        id: string;
        offer_id: string;
        business_name: string;
        contact_name: string;
        email: string;
        phone: string | null;
        website: string | null;
        industry: string | null;
        team_size: string | null;
        note: string;
        source: string;
        status: string;
        decision_note: string;
        created_at: Date;
        reviewed_at: Date | null;
        their_businesses: {
          workspace_id: string;
          workspace_name: string;
          organization_id: string;
          organization_name: string;
          role: 'owner' | 'admin';
        }[];
      }>(
        ctx.tx,
        // Their businesses are matched on the email they applied with, which is why the page tells staff to
        // have them sign up with it. Only an owner's or an admin's: nobody else can take the seat up. Lowered
        // by hand: citext's own = is not on this login's search path, and text = on its own minds the case.
        sql`select a.id, a.offer_id, a.business_name, a.contact_name, a.email::text as email, a.phone,
              a.website, a.industry, a.team_size, a.note, a.source, a.status::text as status,
              a.decision_note, a.created_at, a.reviewed_at,
              coalesce((
                select json_agg(json_build_object(
                  'workspace_id', w.id, 'workspace_name', w.name,
                  'organization_id', o.id, 'organization_name', o.name, 'role', m.role
                ) order by m.role, w.name)
                from app.users u
                join app.workspace_memberships m on m.user_id = u.id and m.role in ('owner', 'admin')
                join app.workspaces w on w.id = m.workspace_id and w.deletion_requested_at is null
                join app.organizations o on o.id = w.organization_id
                where lower(u.email::text) = lower(a.email::text)
              ), '[]'::json) as their_businesses
            from platform.founding_applications a
            where (${offerFilter}::text is null or a.offer_id = ${offerFilter})
              and (${statusFilter}::text is null or a.status::text = ${statusFilter})
            order by a.created_at desc
            limit ${input.limit}`,
      ),
      rows<{
        id: string;
        offer_id: string;
        organization_id: string;
        organization_name: string | null;
        workspace_id: string | null;
        status: string;
        reserved_at: Date;
        expires_at: Date | null;
        activated_at: Date | null;
        revoked_at: Date | null;
        revoke_reason: string;
        grace_ends_at: Date | null;
        checkout_status: 'pending' | 'open' | 'paid' | 'expired' | 'failed' | null;
        checkout_problem: string | null;
        paid_through: Date | null;
        renewal_stopped_at: Date | null;
        renewal_problem: string | null;
        self_serve: boolean;
      }>(
        ctx.tx,
        // The plan is joined in for `grace_ends_at` alone: the page has to show how long a revoked business
        // has left, and that date lives with the plan rather than with the seat.
        // The latest checkout rides along too (0093): "paying now", and the one that matters most — paid, with
        // no seat to turn on, which somebody has to refund or fix. A yearly seat's year comes from its plan.
        sql`select g.id, g.offer_id, g.organization_id, org.name as organization_name, g.workspace_id,
              g.status::text as status, g.reserved_at, g.expires_at, g.activated_at, g.revoked_at,
              g.revoke_reason, p.grace_ends_at, g.self_serve,
              c.status::text as checkout_status, c.problem as checkout_problem,
              case when p.grant_id = g.id then p.current_period_end end as paid_through,
              case when p.grant_id = g.id then p.renewal_stopped_at end as renewal_stopped_at,
              case when p.grant_id = g.id then p.renewal_problem end as renewal_problem
            from platform.founding_grants g
            left join app.organizations org on org.id = g.organization_id
            left join app.workspace_plans p on p.workspace_id = g.workspace_id
            left join lateral (
              select c.status, c.problem from platform.founding_checkouts c
              where c.grant_id = g.id order by c.created_at desc limit 1
            ) c on true
            where (${offerFilter}::text is null or g.offer_id = ${offerFilter})
            order by g.reserved_at desc
            limit ${input.limit}`,
      ),
    ]);

    return {
      offers: offers.map((o) => ({
        offerId: o.id,
        name: o.name,
        status: o.status,
        seatCap: o.seat_cap,
        claimed: Number(o.claimed),
        remaining: Number(o.remaining),
        priceCents: o.price_cents,
        billing: o.billing,
        opensAfterOfferId: o.opens_after_offer_id,
        opensAfterCount: o.opens_after_count === null ? null : Number(o.opens_after_count),
        openedAt: iso(o.opened_at),
      })),
      applications: applications.map((a) => ({
        applicationId: a.id,
        offerId: a.offer_id,
        businessName: a.business_name,
        contactName: a.contact_name,
        email: a.email,
        phone: a.phone,
        website: a.website,
        industry: a.industry,
        teamSize: a.team_size,
        note: a.note,
        source: a.source,
        status: a.status as 'pending',
        decisionNote: a.decision_note,
        createdAt: iso(a.created_at)!,
        reviewedAt: iso(a.reviewed_at),
        theirBusinesses: a.their_businesses.map((b) => ({
          workspaceId: b.workspace_id,
          workspaceName: b.workspace_name,
          organizationId: b.organization_id,
          organizationName: b.organization_name,
          role: b.role,
        })),
      })),
      grants: grants.map((g) => ({
        grantId: g.id,
        offerId: g.offer_id,
        organizationId: g.organization_id,
        organizationName: g.organization_name,
        workspaceId: g.workspace_id,
        status: g.status as 'reserved',
        reservedAt: iso(g.reserved_at)!,
        expiresAt: iso(g.expires_at),
        activatedAt: iso(g.activated_at),
        revokedAt: iso(g.revoked_at),
        revokeReason: g.revoke_reason,
        graceEndsAt: iso(g.grace_ends_at),
        checkoutStatus: g.checkout_status,
        checkoutProblem: g.checkout_problem ?? '',
        paidThrough: iso(g.paid_through),
        renewing: g.paid_through !== null && g.renewal_stopped_at === null,
        renewalProblem: g.renewal_problem,
        selfServe: g.self_serve,
      })),
    };
  },
});

export const foundingMine = defineQuery({
  name: 'founding.mine',
  description:
    'What this workspace is on, and — if its founding seat was taken back — the date its plan changes.',
  input: FoundingMineInput,
  output: FoundingMineOutput,
  permission: 'workspace.read',
  scope: (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  }),
  async handler(ctx, input) {
    // `revoke_reason` is not selected here and must never be: it is written for us, about them.
    const [found] = await rows<{
      plan: string | null;
      status: string | null;
      price_cents: number | null;
      grace_ends_at: Date | null;
      offer_name: string | null;
      current_period_end: Date | null;
      renewal_stopped_at: Date | null;
      renewal_problem: string | null;
      next_charge_cents: number | null;
      trial_ends_at: Date | null;
    }>(
      ctx.tx,
      // The next charge is private.founding_charge_cents's sum, read from the row this person may see.
      sql`select p.plan::text as plan, p.status::text as status, p.price_cents, p.grace_ends_at,
            o.name as offer_name, p.current_period_end, p.renewal_stopped_at, p.renewal_problem,
            greatest(p.price_cents
                     - case when p.discount_cents > 0
                             and (p.discount_until is null or p.current_period_end < p.discount_until)
                            then p.discount_cents else 0 end, 0) as next_charge_cents,
            -- The trial is over when it ends, or once its first charge is paid.
            case when p.trial_ends_at > now() and p.renewal_count = 0 then p.trial_ends_at end as trial_ends_at
          from app.workspace_plans p
          left join platform.founding_grants g on g.id = p.grant_id
          left join platform.founding_offers o on o.id = g.offer_id
          where p.workspace_id = ${input.workspaceId}`,
    );
    return {
      workspaceId: input.workspaceId,
      plan: (found?.plan ?? null) as 'monthly' | null,
      status: (found?.status ?? null) as 'active' | null,
      priceCents: Number(found?.price_cents ?? 0),
      graceEndsAt: iso(found?.grace_ends_at ?? null),
      offerName: found?.offer_name ?? null,
      paidThrough: iso(found?.current_period_end ?? null),
      renewing: !!found?.current_period_end && !found.renewal_stopped_at,
      renewalProblem: found?.renewal_problem ?? null,
      nextChargeCents: Number(found?.next_charge_cents ?? found?.price_cents ?? 0),
      trialEndsAt: iso(found?.trial_ends_at ?? null),
    };
  },
});

export const platformFoundingBusiness = defineQuery({
  name: 'platform.founding.business',
  description:
    'One business’s founding seat — the one it holds, or the last it held — and the offers a seat could come from. Staff only.',
  input: FoundingBusinessInput,
  output: FoundingBusinessOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  async handler(ctx, input) {
    const [ws] = await rows<{ organization_id: string }>(
      ctx.tx,
      sql`select organization_id from app.workspaces where id = ${input.workspaceId}::uuid`,
    );
    if (!ws)
      throw HfosError.notFound(
        'That business isn’t there anymore. It may have been deleted. Search for it again.',
      );
    const [offers, seats] = await Promise.all([
      rows<
        CountRow & {
          opens_after_offer_id: string | null;
          opens_after_count: number | null;
          opened_at: Date | string | null;
        }
      >(
        ctx.tx,
        sql`select o.id, o.name, o.blurb, o.status::text as status, o.price_cents, o.seat_cap,
              private.founding_seats_held(o.id) as claimed,
              greatest(o.seat_cap - private.founding_seats_held(o.id), 0) as remaining,
              case when o.paid_yearly then 'yearly' else o.billing end as billing,
              o.opens_after_offer_id, o.opens_after_count, o.opened_at
            from platform.founding_offers o order by o.sort, o.id`,
      ),
      // A seat is the business's, so it is looked for across all its workspaces: the one it holds now, or else
      // the last one it had.
      rows<{
        id: string;
        offer_id: string;
        offer_name: string;
        status: 'reserved' | 'active' | 'revoked' | 'expired';
        workspace_id: string | null;
        workspace_name: string | null;
        reserved_at: Date;
        expires_at: Date | null;
        activated_at: Date | null;
        revoked_at: Date | null;
        revoke_reason: string;
        grace_ends_at: Date | null;
        paid_through: Date | null;
        renewal_stopped_at: Date | null;
        renewal_problem: string | null;
        checkout_status: 'pending' | 'open' | 'paid' | 'expired' | 'failed' | null;
        checkout_problem: string | null;
        self_serve: boolean;
      }>(
        ctx.tx,
        sql`select g.id, g.offer_id, o.name as offer_name, g.status::text as status, g.workspace_id,
              w.name as workspace_name, g.reserved_at, g.expires_at, g.activated_at, g.revoked_at,
              g.revoke_reason, p.grace_ends_at, g.self_serve,
              c.status::text as checkout_status, c.problem as checkout_problem,
              case when p.grant_id = g.id then p.current_period_end end as paid_through,
              case when p.grant_id = g.id then p.renewal_stopped_at end as renewal_stopped_at,
              case when p.grant_id = g.id then p.renewal_problem end as renewal_problem
            from platform.founding_grants g
            join platform.founding_offers o on o.id = g.offer_id
            left join app.workspaces w on w.id = g.workspace_id
            left join app.workspace_plans p on p.workspace_id = g.workspace_id
            left join lateral (
              select c.status, c.problem from platform.founding_checkouts c
              where c.grant_id = g.id order by c.created_at desc limit 1
            ) c on true
            where g.organization_id = ${ws.organization_id}::uuid
            order by (g.status in ('reserved', 'active')) desc, g.reserved_at desc
            limit 1`,
      ),
    ]);
    const g = seats[0];
    return {
      workspaceId: input.workspaceId,
      organizationId: ws.organization_id,
      seat: g
        ? {
            grantId: g.id,
            offerId: g.offer_id,
            offerName: g.offer_name,
            status: g.status,
            workspaceId: g.workspace_id,
            workspaceName: g.workspace_name,
            reservedAt: iso(g.reserved_at)!,
            expiresAt: iso(g.expires_at),
            activatedAt: iso(g.activated_at),
            revokedAt: iso(g.revoked_at),
            revokeReason: g.revoke_reason,
            graceEndsAt: iso(g.grace_ends_at),
            checkoutStatus: g.checkout_status,
            checkoutProblem: g.checkout_problem ?? '',
            paidThrough: iso(g.paid_through),
            renewing: g.paid_through !== null && g.renewal_stopped_at === null,
            renewalProblem: g.renewal_problem,
            selfServe: g.self_serve,
          }
        : null,
      offers: offers.map((o) => ({
        offerId: o.id,
        name: o.name,
        status: o.status,
        seatCap: o.seat_cap,
        claimed: Number(o.claimed),
        remaining: Number(o.remaining),
        priceCents: o.price_cents,
        billing: o.billing,
        opensAfterOfferId: o.opens_after_offer_id,
        opensAfterCount: o.opens_after_count === null ? null : Number(o.opens_after_count),
        openedAt: iso(o.opened_at),
      })),
    };
  },
});

/**
 * The page a claim link opens (0093). Anybody signed in may ask, and the answer is only ever about the seat whose
 * token they sent: a person holding a link is who the link was for, the same as an invitation's.
 *
 * `none`, not a workspace: the person may not have picked one yet, and the seat says which business's
 * workspaces it can go on. The authority is the token, checked in the database.
 */
export const foundingClaimPreview = defineQuery({
  name: 'founding.claim_preview',
  description:
    'What a founding claim link is for: the offer, its price, the business it was approved for, and whether it can still be taken up.',
  input: FoundingClaimPreviewInput,
  output: FoundingClaimPreviewOutput,
  permission: null,
  scope: () => ({ kind: 'none' as const }),
  actors: ['human'],
  async handler(ctx, input) {
    const [seat] = await rows<{
      offer_id: string;
      offer_name: string;
      price_cents: number;
      organization_id: string;
      business_name: string;
      state: 'ready' | 'claimed' | 'expired' | 'gone';
      expires_at: Date | string | null;
      checkout_id: string | null;
      checkout_workspace_id: string | null;
      billing: 'once' | 'yearly' | 'monthly';
    }>(
      ctx.tx,
      sql`select s.*, private.founding_offer_billing(s.offer_id) as billing
          from private.founding_seat_by_token(${hashClaimToken(input.token)}) s`,
    );
    if (!seat)
      throw HfosError.notFound(
        'That link doesn’t work. It may have been copied wrong or replaced. Ask us for a new one.',
      );
    return {
      state: seat.state,
      offerId: seat.offer_id,
      offerName: seat.offer_name,
      priceCents: Number(seat.price_cents),
      organizationId: seat.organization_id,
      businessName: seat.business_name,
      expiresAt: iso(seat.expires_at),
      checkoutId: seat.checkout_id,
      checkoutWorkspaceId: seat.checkout_workspace_id,
      billing: seat.billing,
    };
  },
});

/**
 * One checkout, for the page that waits for Stripe's address and the one Stripe sends somebody back to. Only for
 * whoever runs the workspace it is for; anybody else gets the same "not found" as a checkout that never existed.
 */
export const foundingCheckoutStatus = defineQuery({
  name: 'founding.checkout_status',
  description:
    "Where a founding seat's payment has got to: waiting for Stripe's page, open, paid, or lapsed — and whether the seat is on the workspace yet.",
  input: FoundingCheckoutStatusInput,
  output: FoundingCheckoutStatusOutput,
  permission: null,
  scope: () => ({ kind: 'none' as const }),
  actors: ['human'],
  async handler(ctx, input) {
    const [c] = await rows<{
      checkout_id: string;
      workspace_id: string;
      offer_name: string;
      amount_cents: number;
      status: 'pending' | 'open' | 'paid' | 'expired' | 'failed';
      session_url: string | null;
      session_expires_at: Date | string | null;
      seat_active: boolean;
      problem: string;
      renewal: boolean;
      billing: 'once' | 'yearly' | 'monthly';
      paid_through: Date | string | null;
      self_serve: boolean;
    }>(ctx.tx, sql`select * from private.founding_checkout_status(${input.checkoutId}::uuid)`);
    if (!c)
      throw HfosError.notFound(
        'We can’t find that payment. Sign in with the account that started it, or ask us for a new link.',
      );
    return {
      checkoutId: c.checkout_id,
      workspaceId: c.workspace_id,
      offerName: c.offer_name,
      amountCents: Number(c.amount_cents),
      status: c.status,
      // Only an open checkout has a page worth sending somebody to.
      url: c.status === 'open' ? c.session_url : null,
      expiresAt: iso(c.session_expires_at),
      seatActive: c.seat_active,
      problem: c.problem,
      renewal: c.renewal,
      billing: c.billing,
      paidThrough: iso(c.paid_through),
      selfServe: c.self_serve,
    };
  },
});

/**
 * What a discount or trial code takes off each plan on sale (20261027014300), so the plan page shows the price before
 * Pay. A code that isn't one, is off, or is the business's own affiliate's is refused, the way `founding.buy` would; one
 * for the other plan only says it doesn't apply to this one. The limit is applied as it stands now.
 */
export const foundingCodePreview = defineQuery({
  name: 'founding.code_preview',
  description:
    'What a discount or trial code takes off each founding plan on sale, before paying: the full price, what comes off each payment and for how many months, and any free trial. Refused for a code that isn’t one or is turned off.',
  input: FoundingCodePreviewInput,
  output: FoundingCodePreviewOutput,
  permission: 'money.manage',
  scope: (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  }),
  async handler(ctx, input) {
    const found = await rows<{
      offer_id: string;
      refusal: string | null;
      code: string;
      full_cents: number;
      discount_cents: number;
      discount_months: number | null;
      trial_days: number | null;
    }>(
      ctx.tx,
      sql`select * from private.affiliate_code_preview(${input.code}, ${input.workspaceId}::uuid)`,
    );
    // Not a code, or the business's own: the same for every plan, so it's the answer.
    const whole = found.find(
      (o) => o.refusal === 'affiliate_code_unknown' || o.refusal === 'affiliate_code_own',
    );
    if (whole?.refusal) throw codeRefusal(whole.refusal, input.code) ?? HfosError.internal();
    return {
      code: found[0]?.code ?? input.code.toLowerCase(),
      offers: found.map((o) => ({
        offerId: o.offer_id,
        applies: o.refusal === null,
        fullCents: Number(o.full_cents),
        discountCents: Number(o.discount_cents),
        discountMonths: o.discount_months,
        trialDays: o.trial_days,
      })),
    };
  },
});

export const foundingQueries = [
  foundingCounts,
  platformFounding,
  foundingMine,
  platformFoundingBusiness,
  foundingClaimPreview,
  foundingCheckoutStatus,
  foundingCodePreview,
];
