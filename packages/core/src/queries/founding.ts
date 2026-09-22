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
import {
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
      }>(
        ctx.tx,
        // The plan is joined in for `grace_ends_at` alone: the page has to show how long a revoked business
        // has left, and that date lives with the plan rather than with the seat.
        sql`select g.id, g.offer_id, g.organization_id, org.name as organization_name, g.workspace_id,
              g.status::text as status, g.reserved_at, g.expires_at, g.activated_at, g.revoked_at,
              g.revoke_reason, p.grace_ends_at
            from platform.founding_grants g
            left join app.organizations org on org.id = g.organization_id
            left join app.workspace_plans p on p.workspace_id = g.workspace_id
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

export const foundingQueries = [foundingCounts, platformFounding, foundingMine];
