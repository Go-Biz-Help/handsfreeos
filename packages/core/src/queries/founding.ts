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
 */
import { rows, sql } from '@hfos/db/client';
import { defineQuery } from '../kernel/define';
import { HfosError } from '../errors';
import { hashClaimToken } from '../commands/founding';
import {
  FoundingCheckoutStatusInput,
  FoundingCheckoutStatusOutput,
  FoundingClaimPreviewInput,
  FoundingClaimPreviewOutput,
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
  billing: 'once' | 'monthly';
};

export const foundingCounts = defineQuery({
  name: 'founding.counts',
  description:
    'How many seats each public offer has left. The only founding read that reaches somebody signed out, and it carries nothing but numbers.',
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
              o.billing, o.opens_after_offer_id, o.opens_after_count, o.opened_at
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
      }>(
        ctx.tx,
        sql`select id, offer_id, business_name, contact_name, email::text as email, phone, website,
              industry, team_size, note, source, status::text as status, decision_note,
              created_at, reviewed_at
            from platform.founding_applications
            where (${offerFilter}::text is null or offer_id = ${offerFilter})
              and (${statusFilter}::text is null or status::text = ${statusFilter})
            order by created_at desc
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
      }>(
        ctx.tx,
        // The plan is joined in for `grace_ends_at` alone: the page has to show how long a revoked business
        // has left, and that date lives with the plan rather than with the seat.
        // The latest checkout rides along too (0093): "paying now", and the one that matters most — paid, with
        // no seat to turn on, which somebody has to refund or fix.
        sql`select g.id, g.offer_id, g.organization_id, org.name as organization_name, g.workspace_id,
              g.status::text as status, g.reserved_at, g.expires_at, g.activated_at, g.revoked_at,
              g.revoke_reason, p.grace_ends_at,
              c.status::text as checkout_status, c.problem as checkout_problem
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
    }>(
      ctx.tx,
      sql`select p.plan::text as plan, p.status::text as status, p.price_cents, p.grace_ends_at,
            o.name as offer_name
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
    }>(ctx.tx, sql`select * from private.founding_seat_by_token(${hashClaimToken(input.token)})`);
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
    }>(ctx.tx, sql`select * from private.founding_checkout_view(${input.checkoutId}::uuid)`);
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
    };
  },
});

export const foundingQueries = [
  foundingCounts,
  platformFounding,
  foundingMine,
  foundingClaimPreview,
  foundingCheckoutStatus,
];
