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
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  foundingApplications,
  foundingGrants,
  foundingOffers,
  workspacePlans,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import {
  FoundingApplicationOutput,
  FoundingApproveInput,
  FoundingApproveOutput,
  FoundingClaimInput,
  FoundingClaimOutput,
  FoundingDecideInput,
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
  const detail = (err as { detail?: string })?.detail ?? '';
  const constraint = (err as { constraint_name?: string })?.constraint_name ?? '';
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
  if (detail === 'founding_cap_below_held')
    throw HfosError.rule(
      'founding_cap_below_held',
      409,
      'There are already more seats out than that. Revoke one before lowering the cap.',
    );
  if (constraint === 'founding_grants_one_live_per_org')
    throw HfosError.rule(
      'founding_org_has_a_seat',
      409,
      'This business already holds a founding seat.',
    );
  throw err;
}

type OfferRow = typeof foundingOffers.$inferSelect;

async function offer(ctx: CommandContext, id: string): Promise<OfferRow> {
  const [found] = await ctx.tx.select().from(foundingOffers).where(eq(foundingOffers.id, id));
  if (!found) throw HfosError.notFound('There is no offer by that name.');
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

const offerOut = (o: OfferRow, claimed: number) => ({
  offerId: o.id,
  name: o.name,
  status: o.status,
  seatCap: o.seatCap,
  claimed,
  remaining: Math.max(o.seatCap - claimed, 0),
  priceCents: o.priceCents,
});

// ---------- deciding ----------

export const foundingApprove = defineCommand({
  name: 'founding.approve',
  description:
    'Approve an application and hold a seat for that business. Returns the claim link, once. The seat is theirs until the link expires.',
  risk: 4,
  input: FoundingApproveInput,
  output: FoundingApproveOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['founding.approved'],
  /** The link is the one thing here worth stealing, so it never reaches a stored command receipt. */
  shownOnce: ['claimToken'],
  async handler(ctx, input) {
    const [application] = await ctx.tx
      .select()
      .from(foundingApplications)
      .where(eq(foundingApplications.id, input.applicationId));
    if (!application) throw HfosError.notFound('There is no application by that id.');
    if (application.status !== 'pending' && application.status !== 'waitlisted')
      throw HfosError.rule(
        'founding_application_decided',
        409,
        'That application has already been dealt with.',
      );

    const found = await offer(ctx, application.offerId);
    const token = newClaimToken();
    const expiresAt = new Date(Date.now() + found.claimDays * DAY_MS);
    const by = ctx.actor.type === 'human' ? ctx.actor.userId : null;

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
        'That application has already been dealt with, or there is no such application.',
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
    'Take up an approved seat: this workspace gets its founding plan and its starting usage credit.',
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
    const [application] = await ctx.tx
      .select()
      .from(foundingApplications)
      .where(eq(foundingApplications.claimTokenHash, hashClaimToken(input.token)));
    /**
     * One message for "no such link", "already used" and "expired" on purpose: a link that answers those
     * differently tells somebody guessing which of their guesses was close.
     */
    const dead = () =>
      HfosError.rule(
        'founding_claim_invalid',
        404,
        'That link has expired or has already been used. Ask us for a new one.',
      );
    if (!application?.grantId) throw dead();
    if (application.claimExpiresAt && application.claimExpiresAt.getTime() < Date.now())
      throw dead();

    const [grant] = await ctx.tx
      .select()
      .from(foundingGrants)
      .where(eq(foundingGrants.id, application.grantId));
    if (!grant || grant.status !== 'reserved') throw dead();

    const found = await offer(ctx, grant.offerId);
    const now = new Date();

    // `reserved` and `active` both hold a seat, so this transition never touches the cap. The guard lets it by.
    await ctx.tx
      .update(foundingGrants)
      .set({ status: 'active', workspaceId: input.workspaceId, activatedAt: now, expiresAt: null })
      .where(eq(foundingGrants.id, grant.id))
      .catch(asRefusal);

    const plan =
      found.priceCents === 0 ? ('founding_free' as const) : ('founding_lifetime' as const);
    await ctx.tx
      .insert(workspacePlans)
      .values({
        workspaceId: input.workspaceId,
        organizationId: grant.organizationId,
        plan,
        status: 'active',
        grantId: grant.id,
        priceCents: 0,
      })
      /**
       * A workspace that somehow already had a plan is upgraded onto the founding one rather than refused:
       * the seat was approved by a person, and the alternative is a support ticket to fix a row.
       */
      .onConflictDoUpdate({
        target: workspacePlans.workspaceId,
        set: {
          plan,
          status: 'active',
          grantId: grant.id,
          priceCents: 0,
          graceEndsAt: null,
          canceledAt: null,
        },
      });

    /**
     * The starting credit is an ordinary wallet ledger row. Nothing about plans is taught to the wallet and
     * nothing about wallets is taught to plans — 0072's header asks for exactly that, and this is the seam
     * where it would have been easiest to break.
     *
     * It cannot go through support's credit function, which asks whether the *caller* is staff; the caller
     * here is the worker acting for somebody who followed a link. `private.founding_credit_wallet` takes its
     * authority from the grant instead, reads the workspace and the amount off it, and is idempotent by the
     * ledger's own key — so a link followed twice credits once.
     */
    const [credited] = await rows<{ credited_cents: number | string; recorded: boolean }>(
      ctx.tx,
      sql`select * from private.founding_credit_wallet(${grant.id}::uuid)`,
    );
    const creditedCents = Number(credited?.credited_cents ?? 0);

    await ctx.emit({
      type: 'founding.claimed',
      entityType: 'founding_grant',
      entityId: grant.id,
      payload: { offerId: found.id, workspaceId: input.workspaceId, plan },
      after: { offer: found.name, plan },
    });

    return {
      grantId: grant.id,
      offerId: found.id,
      workspaceId: input.workspaceId,
      plan,
      creditedCents,
    };
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
    if (!grant) throw HfosError.notFound('There is no seat by that id.');
    if (grant.status !== 'reserved' && grant.status !== 'active')
      throw HfosError.rule('founding_grant_not_held', 409, 'That seat is not held by anybody.');

    const found = await offer(ctx, grant.offerId);
    const now = new Date();
    const by = ctx.actor.type === 'human' ? ctx.actor.userId : null;

    await ctx.tx
      .update(foundingGrants)
      .set({ status: 'revoked', revokedAt: now, revokedBy: by, revokeReason: input.reason })
      .where(eq(foundingGrants.id, grant.id));

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
    if (!grant) throw HfosError.notFound('There is no seat by that id.');
    if (grant.status !== 'revoked')
      throw HfosError.rule('founding_grant_not_revoked', 409, 'That seat was not revoked.');

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

    if (grant.workspaceId)
      await ctx.tx
        .update(workspacePlans)
        .set({ status: 'active', graceEndsAt: null })
        .where(eq(workspacePlans.workspaceId, grant.workspaceId));

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
      entityId: after.id,
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
        entityId: after.id,
        payload: { offerId: after.id, status: after.status },
        before: { status: before.status },
        after: { status: after.status },
      });
    return offerOut(after, claimed);
  },
});

export const foundingCommands = [
  foundingApprove,
  foundingDecline,
  foundingWaitlist,
  foundingClaim,
  foundingRevoke,
  foundingRestore,
  foundingSetCap,
  foundingSetStatus,
];
