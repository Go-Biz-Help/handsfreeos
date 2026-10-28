/**
 * The founding offers' writes (0091): applying, approving, claiming, and taking a seat back.
 *
 * **Nothing in this file counts seats to decide whether there is one.** `private.guard_founding_seat` locks
 * the offer's row and refuses the insert when the offer is full, so every path here writes and then turns a
 * refusal into words somebody can act on. Counting first and inserting second is the race the whole design
 * exists to avoid, and a handler that "helpfully" pre-checked would reintroduce it — two requests would both
 * pass the check and one would still be refused, only later and with a worse message.
 *
 * **Who may do what:**
 *
 * - A **person** does nothing here without `platform.founding.manage`, which only a staff admin has. Approving
 *   is giving the product away for life and revoking is taking it back; neither belongs to whoever is
 *   answering tickets today.
 * - **Claiming** is the one thing somebody outside HandsFreeOS does here, and they do it signed in: the link
 *   proves the seat was approved, `workspace.update` proves they have any business attaching it to this
 *   workspace. A link forwarded to a colleague cannot be spent by somebody who is only a member.
 *
 * **Applying is not here.** It is `private.founding_apply`, called straight from the worker's public route,
 * because an applicant has no workspace and no organization — and the kernel's machine actor is *defined* by
 * the tenant it may address. There is nothing honest to pass it, and a made-up workspace would be a lie told
 * to every audit row afterwards. Deciding queue-or-waitlist in the same statement as the insert closes a gap
 * besides: the last seat can go between a count and an insert.
 *
 * **Revoking frees the seat and does not touch the business.** The grant goes `revoked` — so `remaining` goes
 * up at once and the next applicant can be approved this afternoon — and the workspace's plan goes to `grace`
 * with a date. Until that date nothing about their account changes. Those are two facts and they are written
 * as two.
 *
 * **The $497 seat is paid by the year** (20261027009500). The first year is paid at Checkout, which keeps the card;
 * the worker charges it when the year is up (`founding.record_renewal`). A refused card is not tried again: the
 * business pays that year with another card (`founding.pay_renewal`), and the seat stays on meanwhile. A business
 * may stop it renewing (`founding.set_renewing`), and the seat goes back when the year it paid for is over.
 *
 * **First come, first served** (20261027012700). Nobody applies any more: a business that signs up buys its own spot
 * (`founding.buy`), $497 a year or $97 a month, before it sets up. The monthly spot renews each month the way the
 * yearly one renews each year. Applying, approving and claim links stay for what was already under way.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  foundingApplications,
  foundingCheckouts,
  foundingGrants,
  foundingOffers,
  organizations,
  workspacePlans,
  workspaces,
} from '@hfos/db/schema';
import { giveBackOnRefund, notePlanPayment, takeBackOnRefund } from '../affiliates/earn';
import { formatUtcDate } from '../crm/format';
import { HfosError } from '../errors';
import { foundingPriceWords } from '../support/founding-words';
import { defineCommand } from '../kernel/define';
import {
  FoundingApplicationOutput,
  FoundingApproveInput,
  FoundingApproveOutput,
  FoundingBuyInput,
  FoundingCheckoutRecordOutput,
  FoundingClaimInput,
  FoundingClaimOutput,
  FoundingDecideInput,
  FoundingGiveInput,
  FoundingGiveOutput,
  FoundingRecordCheckoutClosedInput,
  FoundingRecordCheckoutOpenedInput,
  FoundingRecordCheckoutPaidInput,
  FoundingRecordRefundInput,
  FoundingRecordRefundOutput,
  FoundingRecordRenewalInput,
  FoundingRecordRenewalOutput,
  FoundingPayRenewalInput,
  FoundingSetRenewingInput,
  FoundingSetRenewingOutput,
  FoundingStartCheckoutInput,
  FoundingStartCheckoutOutput,
  FoundingGrantOutput,
  FoundingRestoreInput,
  FoundingRevokeInput,
  FoundingSetCapInput,
  FoundingSetStatusInput,
  FoundingOfferOutput,
} from '../schemas/founding';
import type { CommandContext } from '../kernel/types';

/** Staff act on HandsFreeOS, not inside a business — the only scope that resolves a staff role. */
const onPlatform = () => ({ kind: 'platform' as const });
const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const DAY_MS = 86_400_000;

/** The claim link. 32 random bytes as hex: long enough that guessing is not a strategy. */
const newClaimToken = (): string => randomBytes(32).toString('hex');
export const hashClaimToken = (token: string): Buffer =>
  createHash('sha256').update(token).digest();

/**
 * Postgres's own refusal, in words for the person who caused it.
 *
 * The `detail` on every raise in 0091 is the contract: the message may be reworded whenever, the detail may
 * not. Anything unrecognised is rethrown — swallowing an unexpected database error here would turn a bug into
 * a shrug.
 */
function asRefusal(err: unknown): never {
  const { detail, constraint } = refusalOf(err);
  if (detail === 'founding_offer_full')
    throw HfosError.rule(
      'founding_offer_full',
      409,
      'Every seat in this offer is taken. Raise the cap first, or free one by revoking a seat somebody is not using.',
    );
  if (detail === 'founding_offer_closed')
    throw HfosError.rule(
      'founding_offer_closed',
      409,
      'This offer is not taking anybody new. Open it first.',
    );
  if (detail === 'founding_offer_not_seats')
    throw HfosError.rule(
      'founding_offer_not_seats',
      409,
      'The monthly plan has no seats to hand out. People sign up for it; nobody is approved into it.',
    );
  if (detail === 'founding_cap_below_held')
    throw HfosError.rule(
      'founding_cap_below_held',
      409,
      'There are already more seats out than that. Revoke one before lowering the cap.',
    );
  // Following a claim link (0093). "No such link", "used" and "expired" are one refusal on purpose; the page the
  // link opens has already told its holder which, from private.founding_seat_by_token.
  if (detail === 'founding_claim_invalid')
    throw HfosError.rule(
      'founding_claim_invalid',
      404,
      'That link has expired or has already been used. Ask us for a new one.',
    );
  if (detail === 'founding_claim_not_yours')
    throw HfosError.rule(
      'founding_claim_not_yours',
      403,
      'Only an owner or an admin of this business can put a founding seat on it. Ask one of them to open the link, or pick a business you own or run.',
    );
  if (detail === 'founding_claim_wrong_business')
    throw HfosError.rule(
      'founding_claim_wrong_business',
      409,
      'This seat was approved for a different business. Pick one of its workspaces, or sign in with the account that applied.',
    );
  if (detail === 'founding_claim_needs_checkout')
    throw HfosError.rule(
      'founding_claim_needs_checkout',
      409,
      'This seat is paid for at checkout. Press Pay to take it up.',
    );
  if (detail === 'founding_claim_is_free')
    throw HfosError.rule(
      'founding_claim_is_free',
      409,
      'This seat is free — there is nothing to pay. Take it up instead.',
    );
  if (detail === 'founding_checkout_elsewhere')
    throw HfosError.rule(
      'founding_checkout_elsewhere',
      409,
      'You already started paying for this seat on another workspace. Finish that payment, or start again here after it lapses tomorrow.',
    );
  if (detail === 'founding_checkout_missing')
    throw HfosError.notFound('There is no checkout by that id.');
  // The yearly seat (20261027009500): a business stopping it renewing, or paying a refused renewal.
  if (detail === 'founding_renewal_not_yours')
    throw HfosError.rule(
      'founding_renewal_not_yours',
      403,
      'Only somebody who manages money for this business can change how its founding seat is paid. Ask an owner of the business.',
    );
  if (detail === 'founding_not_yearly')
    throw HfosError.rule(
      'founding_not_yearly',
      409,
      'This business’s founding seat isn’t paid by the year, so there’s nothing to renew. Refresh Settings → Usage & balance to see where it stands.',
    );
  if (detail === 'founding_year_over')
    throw HfosError.rule(
      'founding_year_over',
      409,
      'The year you paid for is already over, so it can’t be set to renew. Ask us about getting the seat back.',
    );
  if (detail === 'founding_renewal_not_due')
    throw HfosError.rule(
      'founding_renewal_not_due',
      409,
      'There’s no renewal waiting to be paid. Refresh Settings → Usage & balance to see where your founding seat stands.',
    );
  // Approve checks the business first (aBusiness); this is one deleted in between.
  if (constraint === 'founding_grants_organization_id_fkey')
    throw HfosError.rule(
      'founding_business_missing',
      404,
      'That business isn’t there anymore. Refresh and try again.',
    );
  if (constraint === 'founding_grants_one_live_per_org' || detail === 'founding_org_has_a_seat')
    throw HfosError.rule(
      'founding_org_has_a_seat',
      409,
      'This business already holds a founding seat.',
    );
  throw err;
}

/**
 * The database's `detail` and constraint on a refusal. Drizzle wraps the driver's error, so they are on the innermost
 * cause — the same walk the kernel's translateDbError makes. Reading only the outer error missed every one of them.
 */
function refusalOf(err: unknown): { detail: string; constraint: string } {
  let pg: unknown = err;
  while (pg instanceof Error && pg.cause instanceof Error) pg = pg.cause;
  return {
    detail: (pg as { detail?: string })?.detail ?? '',
    constraint: (pg as { constraint_name?: string })?.constraint_name ?? '',
  };
}

/**
 * A buyer's refusals (`founding.buy`), in words for somebody picking a plan rather than for staff: the offer by its
 * price, and what to do instead. Anything else is `asRefusal`'s.
 */
const asBuyRefusal =
  (found: OfferRow) =>
  (err: unknown): never => {
    const { detail, constraint } = refusalOf(err);
    const plan = foundingPriceWords(found.priceCents, billingOf(found));
    if (detail === 'founding_offer_full')
      throw HfosError.rule(
        'founding_offer_full',
        409,
        `Every spot at ${plan} was just taken. Refresh to see what’s left.`,
      );
    if (detail === 'founding_offer_closed')
      throw HfosError.rule(
        'founding_offer_closed',
        409,
        `Spots at ${plan} aren’t on sale right now. Refresh to see the ones that are.`,
      );
    if (detail === 'founding_offer_missing')
      throw HfosError.rule(
        'founding_offer_missing',
        404,
        'That plan isn’t on sale. Refresh to see the ones that are.',
      );
    if (detail === 'founding_offer_not_for_sale')
      throw HfosError.rule(
        'founding_offer_not_for_sale',
        409,
        'That plan can’t be bought. Pick one with a price.',
      );
    if (detail === 'founding_buy_not_yours')
      throw HfosError.rule(
        'founding_buy_not_yours',
        403,
        'Only somebody who manages money for this business can pick its plan. Ask an owner of the business.',
      );
    if (constraint === 'founding_grants_one_live_per_org' || detail === 'founding_org_has_a_seat')
      throw HfosError.rule(
        'founding_org_has_a_seat',
        409,
        'This business already has its founding spot, so there’s nothing to buy. Refresh to carry on.',
      );
    if (detail === 'founding_checkout_elsewhere')
      throw HfosError.rule(
        'founding_checkout_elsewhere',
        409,
        'You started paying for this spot on another of your businesses. Finish paying there, or start again here in an hour, when that payment page has closed.',
      );
    return asRefusal(err);
  };

type OfferRow = typeof foundingOffers.$inferSelect;

async function offer(ctx: CommandContext, id: string): Promise<OfferRow> {
  const [found] = await ctx.tx.select().from(foundingOffers).where(eq(foundingOffers.id, id));
  if (!found)
    throw HfosError.notFound('That founding offer isn’t there anymore. Refresh and try again.');
  return found;
}

/** How many seats are out, read after the fact so a caller can say "seven left" having just taken one. */
async function remainingOn(ctx: CommandContext, id: string): Promise<number> {
  const [row] = await rows<{ remaining: number | string }>(
    ctx.tx,
    sql`select greatest(o.seat_cap - private.founding_seats_held(o.id), 0) as remaining
        from platform.founding_offers o where o.id = ${id}`,
  );
  return Number(row?.remaining ?? 0);
}

/** How an offer is paid, in the app's words: a seat paid each year is still billed `once` in the table. */
const billingOf = (o: OfferRow): 'once' | 'yearly' | 'monthly' =>
  o.paidYearly ? 'yearly' : (o.billing as 'once' | 'monthly');

/** The plan a spot puts a workspace on: free, monthly, or the founding seat (yearly, or once). */
const planOf = (o: OfferRow): 'founding_free' | 'founding_lifetime' | 'monthly' =>
  o.priceCents === 0 ? 'founding_free' : o.billing === 'monthly' ? 'monthly' : 'founding_lifetime';

const offerOut = (o: OfferRow, claimed: number) => ({
  offerId: o.id,
  name: o.name,
  status: o.status,
  seatCap: o.seatCap,
  claimed,
  remaining: Math.max(o.seatCap - claimed, 0),
  priceCents: o.priceCents,
  // A seat paid each year is still billed `once` in the table; the app calls it `yearly` (20261027009500).
  billing: billingOf(o),
  opensAfterOfferId: o.opensAfterOfferId,
  opensAfterCount: o.opensAfterCount,
  openedAt: o.openedAt?.toISOString() ?? null,
});

const PICK_THEIRS = 'Pick their business from the list in Approve.';

/**
 * The id is a business's, not a workspace's. Approve's list sends the right one; this is for anything else that
 * calls the command. A workspace's id is not resolved to its business quietly: that would hold the seat for
 * whichever business the workspace sits in, which need not be the applicant's (an agency's workspace named
 * after a client, say), so this names both and asks instead.
 */
async function aBusiness(ctx: CommandContext, id: string): Promise<void> {
  const [org] = await ctx.tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, id));
  if (org) return;
  const [ws] = await ctx.tx
    .select({ name: workspaces.name, business: organizations.name })
    .from(workspaces)
    .leftJoin(organizations, eq(organizations.id, workspaces.organizationId))
    .where(eq(workspaces.id, id));
  if (ws)
    throw HfosError.rule(
      'founding_not_a_business',
      422,
      `That’s the id of the workspace “${ws.name}”${ws.business ? `, in the business “${ws.business}”` : ''}, not a business id. ${PICK_THEIRS}`,
    );
  throw HfosError.rule(
    'founding_business_missing',
    404,
    `No business has that id. Check they’ve signed up with the email they applied with. ${PICK_THEIRS}`,
  );
}

// ---------- turning a seat on ----------

/**
 * The workspace a seat goes on: the one named, which has to be the business's own, or else the business's only
 * workspace. A business with several is asked about rather than having one picked for it.
 */
async function seatWorkspace(
  ctx: CommandContext,
  organizationId: string,
  workspaceId: string | undefined,
): Promise<string> {
  const [org] = await ctx.tx
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const business = org?.name || 'This business';
  const theirs = await ctx.tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(eq(workspaces.organizationId, organizationId), isNull(workspaces.deletionRequestedAt)),
    );
  if (workspaceId) {
    if (theirs.some((w) => w.id === workspaceId)) return workspaceId;
    throw HfosError.rule(
      'founding_workspace_elsewhere',
      422,
      `That workspace isn’t one of ${business}’s. Pick one of its own workspaces.`,
    );
  }
  const [only, ...more] = theirs;
  if (!only)
    throw HfosError.rule(
      'founding_no_workspace',
      409,
      `${business} has no workspace to put the seat on yet. Ask them to finish signing up, then try again.`,
    );
  if (more.length)
    throw HfosError.rule(
      'founding_pick_workspace',
      409,
      `${business} has ${theirs.length} workspaces. Press Give a seat, find the business, and pick the workspace the seat covers.`,
    );
  return only.id;
}

/**
 * A seat on a workspace now, for good. The same writes a claim makes (0093's `private.founding_activate`): the seat
 * goes `active`, the workspace gets its founding plan, and the offer's starting credit lands. Here staff decide it,
 * so there is no link to follow and nothing that runs out. Only revoking takes it back.
 *
 * A seat the business is already holding is the one turned on, so this never takes a second seat. One that lapsed
 * is used again, which takes it out of "given back"; it passes the cap's guard on the way, like any seat coming
 * back into use. Anything else is a new seat, and the guard decides whether there is one.
 */
async function turnOn(
  ctx: CommandContext,
  found: OfferRow,
  seat: {
    organizationId: string;
    workspaceId: string;
    applicationId: string | null;
    why: string;
  },
): Promise<{
  grantId: string;
  plan: 'founding_free' | 'founding_lifetime' | 'monthly';
  creditedCents: number;
}> {
  const by = ctx.actor.type === 'human' ? ctx.actor.userId : null;
  const now = new Date();
  const theirs = await ctx.tx
    .select()
    .from(foundingGrants)
    .where(
      and(
        eq(foundingGrants.organizationId, seat.organizationId),
        inArray(foundingGrants.status, ['reserved', 'active', 'expired']),
      ),
    )
    .orderBy(desc(foundingGrants.reservedAt));

  const live = theirs.find((g) => g.status === 'reserved' || g.status === 'active');
  if (live && (live.status === 'active' || live.offerId !== found.id)) {
    const [held] = await ctx.tx
      .select({ name: foundingOffers.name })
      .from(foundingOffers)
      .where(eq(foundingOffers.id, live.offerId));
    throw HfosError.rule(
      'founding_org_has_a_seat',
      409,
      live.status === 'active'
        ? `This business already has a ${held?.name ?? 'founding'} seat. It keeps it until you revoke it.`
        : `This business is holding a ${held?.name ?? 'founding'} seat it hasn’t taken up. Revoke that one under Seats out first, then try again.`,
    );
  }

  let grantId: string;
  const again = live ?? theirs.find((g) => g.status === 'expired' && g.offerId === found.id);
  if (again) {
    await ctx.tx
      .update(foundingGrants)
      .set({
        status: 'active',
        workspaceId: seat.workspaceId,
        activatedAt: now,
        expiresAt: null,
        grantedBy: again.grantedBy ?? by,
        applicationId: again.applicationId ?? seat.applicationId,
      })
      .where(eq(foundingGrants.id, again.id))
      .catch(asRefusal);
    // A payment started on a seat that is now simply on stops being one, as when a seat is revoked. Money that
    // arrives through a page still open is recorded and flagged for a refund (0093), never charged for twice.
    await ctx.tx
      .update(foundingCheckouts)
      .set({
        status: 'failed',
        closedAt: now,
        problem: 'The seat was turned on before it was paid for.',
      })
      .where(
        and(
          eq(foundingCheckouts.grantId, again.id),
          dsql`${foundingCheckouts.status} in ('pending', 'open')`,
        ),
      );
    grantId = again.id;
  } else {
    // The insert is where the seat is taken. If there is none, this throws and nothing else here has run.
    const [made] = await ctx.tx
      .insert(foundingGrants)
      .values({
        offerId: found.id,
        organizationId: seat.organizationId,
        workspaceId: seat.workspaceId,
        applicationId: seat.applicationId,
        status: 'active',
        activatedAt: now,
        grantedBy: by,
      })
      .returning({ id: foundingGrants.id })
      .catch(asRefusal);
    if (!made) throw HfosError.internal();
    grantId = made.id;
  }

  const plan = planOf(found);
  // A workspace that already had a plan is moved onto the founding one, as private.founding_activate does. A seat
  // staff give is a gift, even a yearly or monthly one: no date, no price and no card, so nothing ever renews or is
  // charged.
  await ctx.tx
    .insert(workspacePlans)
    .values({
      workspaceId: seat.workspaceId,
      organizationId: seat.organizationId,
      plan,
      status: 'active',
      grantId,
      priceCents: 0,
    })
    .onConflictDoUpdate({
      target: workspacePlans.workspaceId,
      set: {
        plan,
        status: 'active',
        grantId,
        priceCents: 0,
        graceEndsAt: null,
        canceledAt: null,
        currentPeriodEnd: null,
        stripeCardId: null,
        renewalStoppedAt: null,
        renewalStoppedBy: null,
        renewalCount: 0,
        renewalProblem: null,
        renewalFailedAt: null,
      },
    });

  // Keyed on the seat in the ledger, so a seat turned on, taken back and turned on again credits once.
  const [credit] = await rows<{ credited_cents: number | string }>(
    ctx.tx,
    sql`select credited_cents from private.founding_credit_wallet(${grantId}::uuid)`,
  );

  await ctx.emit({
    type: 'founding.claimed',
    entityType: 'founding_grant',
    entityId: grantId,
    payload: { offerId: found.id, workspaceId: seat.workspaceId, plan, byStaff: true },
    after: seat.why ? { plan, why: seat.why } : { plan },
  });

  return { grantId, plan, creditedCents: Number(credit?.credited_cents ?? 0) };
}

export const foundingGive = defineCommand({
  name: 'founding.give',
  description:
    'Give a business a founding seat, whether or not it applied. Its workspace is on the founding plan at once, with the starting credit, and keeps it until somebody revokes it.',
  risk: 4,
  input: FoundingGiveInput,
  output: FoundingGiveOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['founding.claimed'],
  async handler(ctx, input) {
    await aBusiness(ctx, input.organizationId);
    const found = await offer(ctx, input.offerId);
    const workspaceId = await seatWorkspace(ctx, input.organizationId, input.workspaceId);
    const on = await turnOn(ctx, found, {
      organizationId: input.organizationId,
      workspaceId,
      applicationId: null,
      why: input.note,
    });
    return {
      grantId: on.grantId,
      offerId: found.id,
      organizationId: input.organizationId,
      workspaceId,
      plan: on.plan,
      creditedCents: on.creditedCents,
      remaining: await remainingOn(ctx, found.id),
    };
  },
});

// ---------- deciding ----------

export const foundingApprove = defineCommand({
  name: 'founding.approve',
  description:
    'Approve an application. A free seat goes on their workspace at once and stays until somebody revokes it. A paid seat is held, and the claim link to pay for it is returned once.',
  risk: 4,
  input: FoundingApproveInput,
  output: FoundingApproveOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['founding.approved', 'founding.claimed'],
  /** The link is the one thing here worth stealing, so it never reaches a stored command receipt. */
  shownOnce: ['claimToken'],
  async handler(ctx, input) {
    const [application] = await ctx.tx
      .select()
      .from(foundingApplications)
      .where(eq(foundingApplications.id, input.applicationId));
    if (!application)
      throw HfosError.notFound('That application isn’t there anymore. Refresh and try again.');
    if (application.status !== 'pending' && application.status !== 'waitlisted')
      throw HfosError.rule(
        'founding_application_decided',
        409,
        `That application was already ${application.status}. Refresh to see where it stands.`,
      );

    await aBusiness(ctx, input.organizationId);

    const found = await offer(ctx, application.offerId);
    const by = ctx.actor.type === 'human' ? ctx.actor.userId : null;

    /**
     * A free seat is on from the moment it is approved. A link they had to follow, and that ran out when they
     * didn't, lost seats the owner had given; nothing about a free seat needs them to do anything first.
     */
    if (found.priceCents === 0) {
      const workspaceId = await seatWorkspace(ctx, input.organizationId, input.workspaceId);
      const on = await turnOn(ctx, found, {
        organizationId: input.organizationId,
        workspaceId,
        applicationId: application.id,
        why: input.note,
      });
      await ctx.tx
        .update(foundingApplications)
        .set({
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: by,
          decisionNote: input.note,
          grantId: on.grantId,
        })
        .where(eq(foundingApplications.id, application.id));
      await ctx.emit({
        type: 'founding.approved',
        entityType: 'founding_grant',
        entityId: on.grantId,
        payload: {
          offerId: found.id,
          organizationId: input.organizationId,
          applicationId: application.id,
          workspaceId,
        },
        after: { business: application.businessName, offer: found.name },
      });
      return {
        grantId: on.grantId,
        offerId: found.id,
        status: 'active' as const,
        workspaceId,
        expiresAt: null,
        claimToken: null,
        remaining: await remainingOn(ctx, found.id),
      };
    }

    const token = newClaimToken();
    const expiresAt = new Date(Date.now() + found.claimDays * DAY_MS);

    // The insert is where the seat is taken. If there is none, this throws and nothing else here has run.
    const [grant] = await ctx.tx
      .insert(foundingGrants)
      .values({
        offerId: found.id,
        organizationId: input.organizationId,
        applicationId: application.id,
        status: 'reserved',
        expiresAt,
        grantedBy: by,
      })
      .returning({ id: foundingGrants.id })
      .catch(asRefusal);
    if (!grant) throw HfosError.internal();

    await ctx.tx
      .update(foundingApplications)
      .set({
        status: 'approved',
        reviewedAt: new Date(),
        reviewedBy: by,
        decisionNote: input.note,
        claimTokenHash: hashClaimToken(token),
        claimExpiresAt: expiresAt,
        grantId: grant.id,
      })
      .where(eq(foundingApplications.id, application.id));

    await ctx.emit({
      type: 'founding.approved',
      entityType: 'founding_grant',
      entityId: grant.id,
      payload: {
        offerId: found.id,
        organizationId: input.organizationId,
        applicationId: application.id,
      },
      after: { business: application.businessName, offer: found.name },
    });

    return {
      grantId: grant.id,
      offerId: found.id,
      status: 'reserved' as const,
      workspaceId: null,
      expiresAt: expiresAt.toISOString(),
      claimToken: token,
      remaining: await remainingOn(ctx, found.id),
    };
  },
});

/** Decline and waitlist are the same write with a different word, so they share one handler. */
const decide = (status: 'declined' | 'waitlisted') =>
  async function handler(ctx: CommandContext, input: { applicationId: string; note: string }) {
    const by = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const [updated] = await ctx.tx
      .update(foundingApplications)
      .set({ status, reviewedAt: new Date(), reviewedBy: by, decisionNote: input.note })
      .where(
        and(
          eq(foundingApplications.id, input.applicationId),
          dsql`${foundingApplications.status} in ('pending', 'waitlisted')`,
        ),
      )
      .returning({ id: foundingApplications.id, status: foundingApplications.status });
    if (!updated)
      throw HfosError.rule(
        'founding_application_decided',
        409,
        'That application has already been decided, or it isn’t there anymore. Refresh to see where it stands.',
      );
    await ctx.emit({
      type: `founding.${status}`,
      entityType: 'founding_application',
      entityId: updated.id,
      payload: { status },
    });
    return { applicationId: updated.id, status: updated.status };
  };

export const foundingDecline = defineCommand({
  name: 'founding.decline',
  description: 'Turn an application down, with a note only staff ever see.',
  risk: 2,
  input: FoundingDecideInput,
  output: FoundingApplicationOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['founding.declined'],
  handler: decide('declined'),
});

export const foundingWaitlist = defineCommand({
  name: 'founding.waitlist',
  description: 'Put an application on the waitlist, to be approved if a seat frees up.',
  risk: 1,
  input: FoundingDecideInput,
  output: FoundingApplicationOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['founding.waitlisted'],
  handler: decide('waitlisted'),
});

// ---------- claiming ----------

export const foundingClaim = defineCommand({
  name: 'founding.claim',
  description:
    'Take up an approved free seat: this workspace gets its founding plan and its starting usage credit. A paid seat is taken up by paying for it (founding.start_checkout).',
  risk: 4,
  input: FoundingClaimInput,
  output: FoundingClaimOutput,
  /**
   * Whoever runs a workspace, not whoever holds the link. The link proves the seat was approved; this proves
   * the person attaching it has any business attaching it to *this* workspace. A link forwarded to a
   * colleague cannot be spent against a workspace they are only a member of.
   */
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: ['founding.claimed'],
  async handler(ctx, input) {
    /**
     * All of it in one function (0093), because the person pressing the button can read none of the founding
     * tables: they are staff-only, and 0091's claim — which read them here — refused everybody. The function
     * finds the seat by the link's hash, checks the person runs this workspace and that it is in the business
     * the seat was approved for, and takes it up under the seat's row lock: two tabs, one seat.
     */
    const [done] = await rows<{
      grant_id: string;
      offer_id: string;
      plan: 'founding_free' | 'founding_lifetime';
      credited_cents: number | string;
    }>(
      ctx.tx,
      sql`select * from private.founding_claim_free(${hashClaimToken(input.token)}, ${input.workspaceId}::uuid)`,
    ).catch(asRefusal);
    if (!done) throw HfosError.internal();

    await ctx.emit({
      type: 'founding.claimed',
      entityType: 'founding_grant',
      entityId: done.grant_id,
      payload: { offerId: done.offer_id, workspaceId: input.workspaceId, plan: done.plan },
      after: { plan: done.plan },
    });

    return {
      grantId: done.grant_id,
      offerId: done.offer_id,
      workspaceId: input.workspaceId,
      plan: done.plan,
      creditedCents: Number(done.credited_cents),
    };
  },
});

// ---------- paying for a seat ----------

export const foundingStartCheckout = defineCommand({
  name: 'founding.start_checkout',
  description:
    'Start paying for an approved paid seat, or pick up the payment already under way. The worker makes the Stripe page; ask founding.checkout_status for its address.',
  risk: 3,
  input: FoundingStartCheckoutInput,
  output: FoundingStartCheckoutOutput,
  // The same person founding.claim asks for, for the same reason: the seat goes on this workspace once paid.
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: ['founding.checkout_requested'],
  async handler(ctx, input) {
    const [started] = await rows<{
      checkout_id: string;
      status: 'pending' | 'open';
      session_url: string | null;
      created: boolean;
    }>(
      ctx.tx,
      sql`select * from private.founding_open_checkout(${hashClaimToken(input.token)}, ${input.workspaceId}::uuid)`,
    ).catch(asRefusal);
    if (!started) throw HfosError.internal();

    // Only a new checkout needs a page made. One picked back up already has one, or has its job queued.
    if (started.created)
      await ctx.emit({
        type: 'founding.checkout_requested',
        entityType: 'founding_checkout',
        entityId: started.checkout_id,
        payload: { checkoutId: started.checkout_id },
        after: { status: 'pending' },
      });

    return {
      checkoutId: started.checkout_id,
      status: started.status,
      url: started.session_url,
      created: started.created,
    };
  },
});

export const foundingBuy = defineCommand({
  name: 'founding.buy',
  description:
    'Buy a founding spot for this business, first come, first served: hold one in the offer picked and start paying for it, or pick up the payment already under way. The worker makes the Stripe page; ask founding.checkout_status for its address. Picking another offer before paying gives the first hold back.',
  risk: 3,
  input: FoundingBuyInput,
  output: FoundingStartCheckoutOutput,
  // Whoever manages what the business pays us: the people on Settings → Usage & balance.
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['founding.checkout_requested'],
  async handler(ctx, input) {
    // Read for its words only. Whether there is a spot is the database's to say, under the cap's lock.
    const [found] = await ctx.tx
      .select()
      .from(foundingOffers)
      .where(eq(foundingOffers.id, input.offerId));
    if (!found || found.status === 'draft')
      throw HfosError.rule(
        'founding_offer_missing',
        404,
        'That plan isn’t on sale. Refresh to see the ones that are.',
      );
    // In one function (20261027012700), because nobody in a business can read the founding tables: it checks
    // money.manage for itself, holds the spot under the cap's lock, and starts the payment, or finds the one under way.
    const [started] = await rows<{
      checkout_id: string;
      grant_id: string;
      status: 'pending' | 'open';
      session_url: string | null;
      created: boolean;
    }>(
      ctx.tx,
      sql`select * from private.founding_buy(${input.workspaceId}::uuid, ${input.offerId})`,
    ).catch(asBuyRefusal(found));
    if (!started) throw HfosError.internal();

    // The same page a claim link's payment gets, made by the same job.
    if (started.created)
      await ctx.emit({
        type: 'founding.checkout_requested',
        entityType: 'founding_checkout',
        entityId: started.checkout_id,
        payload: { checkoutId: started.checkout_id, offerId: found.id, bought: true },
        after: { status: 'pending', offer: found.name },
      });

    return {
      checkoutId: started.checkout_id,
      status: started.status,
      url: started.session_url,
      created: started.created,
    };
  },
});

/**
 * The worker's three writes. Each is one function in 0093 that only moves a checkout forward, so Stripe sending
 * an event twice — which it does — is answered `unchanged` or `already` rather than done again.
 */
export const foundingRecordCheckoutOpened = defineCommand({
  name: 'founding.record_checkout_opened',
  description: "Worker: Stripe's page for a checkout is made. Written once.",
  risk: 1,
  input: FoundingRecordCheckoutOpenedInput,
  output: FoundingCheckoutRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const [row] = await rows<{ opened: boolean }>(
      ctx.tx,
      sql`select private.founding_checkout_opened(${input.checkoutId}::uuid, ${input.sessionRef},
            ${input.url}, ${input.expiresAt}::timestamptz) as opened`,
    );
    return {
      checkoutId: input.checkoutId,
      outcome: row?.opened ? ('opened' as const) : ('unchanged' as const),
    };
  },
});

export const foundingRecordCheckoutPaid = defineCommand({
  name: 'founding.record_checkout_paid',
  description:
    'Worker: Stripe says a founding seat was paid for. The seat goes active on its workspace, with its plan and its credit (and, paid by the month or the year, the card for the next one); a refused renewal paid with another card moves the month or year on. A payment that finds no seat to turn on is kept and flagged for staff.',
  risk: 3,
  input: FoundingRecordCheckoutPaidInput,
  output: FoundingCheckoutRecordOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['founding.paid', 'founding.claimed', 'founding.renewed', 'founding.payment_stranded'],
  async handler(ctx, input) {
    const [done] = await rows<{
      outcome: 'activated' | 'renewed' | 'already' | 'no_seat';
      grant_id: string;
      offer_id: string;
      plan: 'founding_free' | 'founding_lifetime' | 'monthly' | null;
    }>(
      ctx.tx,
      sql`select * from private.founding_checkout_paid(${input.checkoutId}::uuid, ${input.sessionRef},
            ${input.paymentRef}, ${input.paidCents}, ${input.customerRef}, ${input.cardRef})`,
    ).catch(asRefusal);
    if (!done) throw HfosError.internal();
    if (done.outcome === 'already')
      return { checkoutId: input.checkoutId, outcome: 'already' as const };

    await ctx.emit({
      type: 'founding.paid',
      entityType: 'founding_checkout',
      entityId: input.checkoutId,
      payload: {
        grantId: done.grant_id,
        offerId: done.offer_id,
        paidCents: input.paidCents,
        paymentRef: input.paymentRef,
      },
      after: { paid: `${(input.paidCents / 100).toFixed(2)}` },
    });
    if (done.outcome === 'activated')
      await ctx.emit({
        type: 'founding.claimed',
        entityType: 'founding_grant',
        entityId: done.grant_id,
        payload: { offerId: done.offer_id, workspaceId: input.workspaceId, plan: done.plan },
        after: { plan: done.plan },
      });
    else if (done.outcome === 'renewed') {
      const until = await paidThroughOf(ctx, input.workspaceId);
      await ctx.emit({
        type: 'founding.renewed',
        entityType: 'founding_grant',
        entityId: done.grant_id,
        payload: {
          offerId: done.offer_id,
          paidCents: input.paidCents,
          paymentRef: input.paymentRef,
          paidThrough: until?.toISOString() ?? null,
          withAnotherCard: true,
        },
        after: { paid: `${(input.paidCents / 100).toFixed(2)}`, until: until ? day(until) : '' },
      });
    } else
      // Paid, and no seat to turn on: somebody has to refund it or find one. Said as an event of its own so it
      // can be noticed rather than read out of a column.
      await ctx.emit({
        type: 'founding.payment_stranded',
        entityType: 'founding_checkout',
        entityId: input.checkoutId,
        payload: { grantId: done.grant_id, offerId: done.offer_id, paymentRef: input.paymentRef },
      });
    if (done.outcome !== 'no_seat') await keepCheckoutPayment(ctx, input.checkoutId);
    return { checkoutId: input.checkoutId, outcome: done.outcome };
  },
});

/**
 * A paid checkout's payment, kept for refunds and its affiliate's share (20261027014200). A first payment pays for the
 * month or year starting now; a renewal paid on a page of its own, for the one it was opened for.
 */
async function keepCheckoutPayment(ctx: CommandContext, checkoutId: string): Promise<void> {
  const [paid] = await rows<{
    organization_id: string;
    workspace_id: string;
    offer_id: string;
    payment_ref: string | null;
    paid_cents: number | null;
    paid_at: Date | string;
    renewal_for: Date | string | null;
  }>(
    ctx.tx,
    sql`select organization_id, workspace_id, offer_id, payment_ref, paid_cents, paid_at, renewal_for
        from platform.founding_checkouts where id = ${checkoutId}::uuid and status = 'paid'`,
  );
  if (!paid) return;
  const paidAt = new Date(paid.paid_at);
  await notePlanPayment(ctx, {
    organizationId: paid.organization_id,
    workspaceId: paid.workspace_id,
    offerId: paid.offer_id,
    how: paid.renewal_for ? 'renewal_page' : 'checkout',
    checkoutId,
    paymentRef: paid.payment_ref,
    amountCents: paid.paid_cents ?? 0,
    periodFrom: paid.renewal_for ? new Date(paid.renewal_for) : paidAt,
    paidAt,
  });
}

export const foundingRecordCheckoutClosed = defineCommand({
  name: 'founding.record_checkout_closed',
  description:
    "Worker: a checkout will not be paid — Stripe's page lapsed, or it could not be made. The seat stays reserved until its own deadline.",
  risk: 1,
  input: FoundingRecordCheckoutClosedInput,
  output: FoundingCheckoutRecordOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const [row] = await rows<{ closed: boolean }>(
      ctx.tx,
      sql`select private.founding_checkout_closed(${input.checkoutId}::uuid, ${input.status},
            ${input.problem}) as closed`,
    );
    return {
      checkoutId: input.checkoutId,
      outcome: row?.closed ? ('closed' as const) : ('unchanged' as const),
    };
  },
});

// ---------- the renewal: each year, or each month ----------

/** "Oct 19, 2027": a renewal can be a year away, so it needs its year. */
const day = formatUtcDate;

async function paidThroughOf(ctx: CommandContext, workspaceId: string): Promise<Date | null> {
  const [plan] = await ctx.tx
    .select({ until: workspacePlans.currentPeriodEnd })
    .from(workspacePlans)
    .where(eq(workspacePlans.workspaceId, workspaceId));
  return plan?.until ?? null;
}

export const foundingSetRenewing = defineCommand({
  name: 'founding.set_renewing',
  description:
    'Stop this business’s founding seat renewing each month or year, or start it again while that is still paid for. Stopped, the seat stays until the month or year paid for is over, then goes back.',
  risk: 3,
  input: FoundingSetRenewingInput,
  output: FoundingSetRenewingOutput,
  // Whoever manages what the business pays us: the people on Settings → Usage & balance, where this is.
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['founding.renewal_stopped', 'founding.renewal_resumed'],
  async handler(ctx, input) {
    // In one function, because nobody in a business writes its plan: it checks money.manage for itself.
    const [done] = await rows<{
      paid_through: Date | string;
      renewing: boolean;
      changed: boolean;
    }>(
      ctx.tx,
      sql`select * from private.founding_set_renewing(${input.workspaceId}::uuid, ${input.renewing})`,
    ).catch(asRefusal);
    if (!done) throw HfosError.internal();
    const paidThrough = new Date(done.paid_through);
    if (done.changed)
      await ctx.emit({
        type: done.renewing ? 'founding.renewal_resumed' : 'founding.renewal_stopped',
        entityType: 'workspace_plan',
        entityId: input.workspaceId,
        payload: { workspaceId: input.workspaceId, paidThrough: paidThrough.toISOString() },
        before: { renews: done.renewing ? 'no' : 'yes' },
        after: { renews: done.renewing ? 'yes' : 'no', until: day(paidThrough) },
      });
    return {
      workspaceId: input.workspaceId,
      renewing: done.renewing,
      paidThrough: paidThrough.toISOString(),
    };
  },
});

export const foundingPayRenewal = defineCommand({
  name: 'founding.pay_renewal',
  description:
    'Pay the founding seat’s renewal with another card, after the card on file refused it, or pick up the payment already under way. The worker makes the Stripe page; ask founding.checkout_status for its address. The new card is the one charged from then on.',
  risk: 3,
  input: FoundingPayRenewalInput,
  output: FoundingStartCheckoutOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['founding.checkout_requested'],
  async handler(ctx, input) {
    const [started] = await rows<{
      checkout_id: string;
      status: 'pending' | 'open';
      session_url: string | null;
      created: boolean;
    }>(
      ctx.tx,
      sql`select * from private.founding_open_renewal_checkout(${input.workspaceId}::uuid)`,
    ).catch(asRefusal);
    if (!started) throw HfosError.internal();
    // The same page a first payment gets, made by the same job.
    if (started.created)
      await ctx.emit({
        type: 'founding.checkout_requested',
        entityType: 'founding_checkout',
        entityId: started.checkout_id,
        payload: { checkoutId: started.checkout_id, renewal: true },
        after: { status: 'pending' },
      });
    return {
      checkoutId: started.checkout_id,
      status: started.status,
      url: started.session_url,
      created: started.created,
    };
  },
});

export const foundingRecordRenewal = defineCommand({
  name: 'founding.record_renewal',
  description:
    'Worker: what the monthly or yearly charge for a founding seat did. Renewed moves the paid month or year on; a refused card is written down for the business to pay with another card, and nothing is charged again until it does. The seat stays on either way.',
  risk: 3,
  input: FoundingRecordRenewalInput,
  output: FoundingRecordRenewalOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['founding.renewed', 'founding.renewal_failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    // Locked, so a retry arriving beside the first answer waits and then finds the year already moved.
    const [plan] = await rows<{
      grant_id: string | null;
      current_period_end: Date | string | null;
      renewal_failed_at: Date | string | null;
      renewal_count: number;
      price_cents: number;
      offer_id: string | null;
    }>(
      ctx.tx,
      sql`select p.grant_id, p.current_period_end, p.renewal_failed_at, p.renewal_count, p.price_cents,
                 (select g.offer_id from platform.founding_grants g where g.id = p.grant_id) as offer_id
          from app.workspace_plans p where p.workspace_id = ${workspaceId}::uuid for update of p`,
    );
    if (!plan || plan.grant_id !== input.grantId || !plan.current_period_end)
      return { grantId: input.grantId, outcome: 'unchanged' as const };
    const paidThrough = new Date(plan.current_period_end);
    // The year this answer is about has already moved on: a retry, or an answer arriving twice.
    if (paidThrough.toISOString() !== new Date(input.forPaidThrough).toISOString())
      return { grantId: input.grantId, outcome: 'already' as const };

    if (input.outcome === 'renewed') {
      // A month or a year on, by the seat's offer, in the database's own arithmetic: the same as a renewal paid on a
      // page of its own (20261027012700).
      const [moved] = await rows<{ current_period_end: Date | string }>(
        ctx.tx,
        sql`update app.workspace_plans
               set current_period_end = current_period_end + coalesce(
                     private.founding_period((select g.offer_id from platform.founding_grants g
                                               where g.id = ${input.grantId}::uuid)),
                     interval '1 year'),
                   renewal_count = renewal_count + 1, renewal_problem = null, renewal_failed_at = null,
                   status = 'active'
             where workspace_id = ${workspaceId}::uuid
            returning current_period_end`,
      );
      const next = new Date(moved!.current_period_end);
      await ctx.emit({
        type: 'founding.renewed',
        entityType: 'founding_grant',
        entityId: input.grantId,
        payload: {
          paidCents: input.paidCents,
          paymentRef: input.paymentRef,
          paidThrough: next.toISOString(),
          withAnotherCard: false,
        },
        after: {
          paid: `${((input.paidCents ?? plan.price_cents) / 100).toFixed(2)}`,
          until: day(next),
        },
      });
      // Kept for refunds and its affiliate's share: it pays for the month or year from the old paid-through date.
      await notePlanPayment(ctx, {
        organizationId: ctx.scope.organizationId!,
        workspaceId,
        offerId: plan.offer_id,
        how: 'renewal',
        checkoutId: null,
        paymentRef: input.paymentRef,
        amountCents: input.paidCents ?? plan.price_cents,
        periodFrom: paidThrough,
        paidAt: new Date(),
      });
      return { grantId: input.grantId, outcome: 'recorded' as const };
    }

    if (plan.renewal_failed_at) return { grantId: input.grantId, outcome: 'already' as const };
    const problem = input.problem ?? 'The card was declined.';
    // Past due, not off: the seat stays on until staff decide, as the owner asked.
    await ctx.tx
      .update(workspacePlans)
      .set({ renewalProblem: problem, renewalFailedAt: new Date(), status: 'past_due' })
      .where(eq(workspacePlans.workspaceId, workspaceId));
    await ctx.emit({
      type: 'founding.renewal_failed',
      entityType: 'founding_grant',
      entityId: input.grantId,
      payload: { problem, paidThrough: paidThrough.toISOString(), amountCents: plan.price_cents },
      after: { renewal: 'refused', reason: problem.slice(0, 200) },
    });
    return { grantId: input.grantId, outcome: 'recorded' as const };
  },
});

// ---------- a refund ----------

/** Where a refund may go from where it is: a pending one anywhere, one that went through only to failed. */
const REFUND_NEXT: Record<string, readonly string[]> = {
  pending: ['succeeded', 'failed', 'canceled'],
  succeeded: ['failed'],
  failed: [],
  canceled: [],
};

export const foundingRecordRefund = defineCommand({
  name: 'founding.record_refund',
  description:
    'Worker: Stripe says a plan payment was refunded, or what became of the refund. One that goes through takes back the affiliate’s share of it; one the bank turns down afterwards gives it back.',
  risk: 3,
  input: FoundingRecordRefundInput,
  output: FoundingRecordRefundOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['founding.refund_recorded'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [payment] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from platform.plan_payments
          where payment_ref = ${input.paymentRef} and workspace_id = ${workspaceId}::uuid`,
    );
    if (!payment) return { refundId: null, outcome: 'ignored' as const };
    // Locked, so the same refund's events arriving together are taken one after the other.
    const [was] = await rows<{ id: string; status: string; payment_id: string }>(
      ctx.tx,
      sql`select id, status, payment_id from platform.plan_refunds
          where refund_ref = ${input.refundRef} for update`,
    );
    if (was && was.payment_id !== payment.id)
      return { refundId: null, outcome: 'ignored' as const };
    if (was && !REFUND_NEXT[was.status]?.includes(input.status))
      return { refundId: was.id, outcome: 'unchanged' as const };
    const [row] = await rows<{ id: string }>(
      ctx.tx,
      was
        ? sql`update platform.plan_refunds set status = ${input.status}, amount_cents = ${input.amountCents}
              where id = ${was.id} returning id`
        : sql`insert into platform.plan_refunds (payment_id, refund_ref, amount_cents, status, refunded_at)
              values (${payment.id}, ${input.refundRef}, ${input.amountCents}, ${input.status},
                ${input.refundedAt}::timestamptz)
              on conflict (refund_ref) do nothing
              returning id`,
    );
    if (!row) return { refundId: null, outcome: 'unchanged' as const };
    if (input.status === 'succeeded') await takeBackOnRefund(ctx, row.id);
    else if (was?.status === 'succeeded') await giveBackOnRefund(ctx, row.id);
    await ctx.emit({
      type: 'founding.refund_recorded',
      entityType: 'workspace_plan',
      entityId: workspaceId,
      payload: {
        refundRef: input.refundRef,
        paymentRef: input.paymentRef,
        amountCents: input.amountCents,
        status: input.status,
      },
      before: was ? { refund: was.status } : null,
      after: { refund: input.status, amount: `${(input.amountCents / 100).toFixed(2)}` },
    });
    return { refundId: row.id, outcome: 'recorded' as const };
  },
});

// ---------- taking a seat back ----------

export const foundingRevoke = defineCommand({
  name: 'founding.revoke',
  description:
    'Take a founding seat back. The seat is free for somebody else at once; the business keeps working until its grace period ends.',
  risk: 4,
  input: FoundingRevokeInput,
  output: FoundingGrantOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['founding.revoked'],
  async handler(ctx, input) {
    const [grant] = await ctx.tx
      .select()
      .from(foundingGrants)
      .where(eq(foundingGrants.id, input.grantId));
    if (!grant) throw HfosError.notFound('That seat isn’t there anymore. Refresh and try again.');
    if (grant.status !== 'reserved' && grant.status !== 'active')
      throw HfosError.rule(
        'founding_grant_not_held',
        409,
        `Nobody holds that seat (it’s ${grant.status}), so there’s nothing to revoke. Refresh to see where it stands.`,
      );

    const found = await offer(ctx, grant.offerId);
    const now = new Date();
    const by = ctx.actor.type === 'human' ? ctx.actor.userId : null;

    await ctx.tx
      .update(foundingGrants)
      .set({ status: 'revoked', revokedAt: now, revokedBy: by, revokeReason: input.reason })
      .where(eq(foundingGrants.id, grant.id));

    // A payment under way on it stops being one. Stripe's page may still be open in somebody's browser; money
    // that arrives through it anyway is recorded and flagged for a refund (0093), never turned into a seat.
    await ctx.tx
      .update(foundingCheckouts)
      .set({
        status: 'failed',
        closedAt: now,
        problem: 'The seat was taken back before it was paid for.',
      })
      .where(
        and(
          eq(foundingCheckouts.grantId, grant.id),
          dsql`${foundingCheckouts.status} in ('pending', 'open')`,
        ),
      );

    /**
     * The seat and the notice are separate. Above, the seat went back in the pool. Here, the business is told
     * when its plan changes — and until that date nothing about their account is any different.
     *
     * A reservation nobody ever claimed has no workspace and so no notice to give: there is nobody to warn.
     */
    let graceEndsAt: Date | null = null;
    if (grant.workspaceId) {
      graceEndsAt = new Date(now.getTime() + found.graceDays * DAY_MS);
      await ctx.tx
        .update(workspacePlans)
        .set({ status: 'grace', graceEndsAt })
        .where(eq(workspacePlans.workspaceId, grant.workspaceId));
    }

    await ctx.emit({
      type: 'founding.revoked',
      entityType: 'founding_grant',
      entityId: grant.id,
      payload: {
        offerId: found.id,
        organizationId: grant.organizationId,
        workspaceId: grant.workspaceId,
        reason: input.reason,
        graceEndsAt: graceEndsAt?.toISOString() ?? null,
      },
      before: { status: grant.status },
      after: { status: 'revoked', why: input.reason },
    });

    return {
      grantId: grant.id,
      offerId: found.id,
      organizationId: grant.organizationId,
      status: 'revoked' as const,
      graceEndsAt: graceEndsAt?.toISOString() ?? null,
      remaining: await remainingOn(ctx, found.id),
    };
  },
});

export const foundingRestore = defineCommand({
  name: 'founding.restore',
  description:
    'Undo a revocation. Refused if the seat has since been given to somebody else — there is no room to put them back into.',
  risk: 4,
  input: FoundingRestoreInput,
  output: FoundingGrantOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['founding.restored'],
  async handler(ctx, input) {
    const [grant] = await ctx.tx
      .select()
      .from(foundingGrants)
      .where(eq(foundingGrants.id, input.grantId));
    if (!grant) throw HfosError.notFound('That seat isn’t there anymore. Refresh and try again.');
    if (grant.status !== 'revoked')
      throw HfosError.rule(
        'founding_grant_not_revoked',
        409,
        `That seat isn’t revoked (it’s ${grant.status}), so there’s nothing to restore. Refresh to see where it stands.`,
      );

    const found = await offer(ctx, grant.offerId);
    /**
     * Back to whatever it was: a seat somebody had taken up goes back to `active`, one they never claimed goes
     * back to `reserved` with a fresh deadline. The cap is checked by the trigger on the way, which is what
     * makes "the seat went to somebody else" a refusal rather than a twenty-sixth founding partner.
     */
    const wasActive = grant.workspaceId !== null && grant.activatedAt !== null;
    const expiresAt = wasActive ? null : new Date(Date.now() + found.claimDays * DAY_MS);
    await ctx.tx
      .update(foundingGrants)
      .set({
        status: wasActive ? 'active' : 'reserved',
        revokedAt: null,
        revokedBy: null,
        revokeReason: '',
        expiresAt,
      })
      .where(eq(foundingGrants.id, grant.id))
      .catch(asRefusal);

    if (grant.workspaceId) {
      await ctx.tx
        .update(workspacePlans)
        .set({ status: 'active', graceEndsAt: null, canceledAt: null })
        .where(eq(workspacePlans.workspaceId, grant.workspaceId));
      // A yearly seat that went back because they stopped it renewing comes back as a gift: charging the card they
      // asked us to stop charging is not ours to do, and a year that is over with renewing stopped would only be
      // taken back again by the next sweep.
      await ctx.tx
        .update(workspacePlans)
        .set({
          priceCents: 0,
          currentPeriodEnd: null,
          stripeCardId: null,
          renewalStoppedAt: null,
          renewalStoppedBy: null,
          renewalProblem: null,
          renewalFailedAt: null,
        })
        .where(
          and(
            eq(workspacePlans.workspaceId, grant.workspaceId),
            dsql`${workspacePlans.renewalStoppedAt} is not null`,
            dsql`${workspacePlans.currentPeriodEnd} <= now()`,
          ),
        );
    }

    await ctx.emit({
      type: 'founding.restored',
      entityType: 'founding_grant',
      entityId: grant.id,
      payload: { offerId: found.id, organizationId: grant.organizationId },
      before: { status: 'revoked', why: grant.revokeReason },
      after: { status: wasActive ? 'active' : 'reserved' },
    });

    return {
      grantId: grant.id,
      offerId: found.id,
      organizationId: grant.organizationId,
      status: wasActive ? ('active' as const) : ('reserved' as const),
      graceEndsAt: null,
      remaining: await remainingOn(ctx, found.id),
    };
  },
});

// ---------- the offer itself ----------

export const foundingSetCap = defineCommand({
  name: 'founding.set_cap',
  description:
    'Change how many seats an offer has. Raising it opens seats; it cannot go below the number already out.',
  risk: 4,
  input: FoundingSetCapInput,
  output: FoundingOfferOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['founding.cap_changed'],
  async handler(ctx, input) {
    const before = await offer(ctx, input.offerId);
    if (before.seatCap === input.seatCap) {
      const claimed = before.seatCap - (await remainingOn(ctx, before.id));
      return offerOut(before, claimed);
    }
    await ctx.tx
      .update(foundingOffers)
      .set({ seatCap: input.seatCap })
      .where(eq(foundingOffers.id, before.id))
      .catch(asRefusal);
    const after = await offer(ctx, before.id);
    const claimed = after.seatCap - (await remainingOn(ctx, after.id));
    await ctx.emit({
      type: 'founding.cap_changed',
      entityType: 'founding_offer',
      // An offer's id is a name like `founding_partner`, and an event's entity id is a uuid: it rides in the payload.
      entityId: null,
      payload: { offerId: after.id, seatCap: after.seatCap },
      before: { cap: before.seatCap },
      after: { cap: after.seatCap },
    });
    return offerOut(after, claimed);
  },
});

export const foundingSetStatus = defineCommand({
  name: 'founding.set_status',
  description:
    'Open an offer to applications, close it, or put it back in draft so nobody sees it at all.',
  risk: 4,
  input: FoundingSetStatusInput,
  output: FoundingOfferOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['founding.status_changed'],
  async handler(ctx, input) {
    const before = await offer(ctx, input.offerId);
    await ctx.tx
      .update(foundingOffers)
      .set({ status: input.status })
      .where(eq(foundingOffers.id, before.id));
    const after = await offer(ctx, before.id);
    const claimed = after.seatCap - (await remainingOn(ctx, after.id));
    if (before.status !== after.status)
      await ctx.emit({
        type: 'founding.status_changed',
        entityType: 'founding_offer',
        entityId: null,
        payload: { offerId: after.id, status: after.status },
        before: { status: before.status },
        after: { status: after.status },
      });
    return offerOut(after, claimed);
  },
});

export const foundingCommands = [
  foundingGive,
  foundingApprove,
  foundingDecline,
  foundingWaitlist,
  foundingClaim,
  foundingStartCheckout,
  foundingBuy,
  foundingRecordCheckoutOpened,
  foundingRecordCheckoutPaid,
  foundingRecordCheckoutClosed,
  foundingSetRenewing,
  foundingPayRenewal,
  foundingRecordRenewal,
  foundingRecordRefund,
  foundingRevoke,
  foundingRestore,
  foundingSetCap,
  foundingSetStatus,
];
