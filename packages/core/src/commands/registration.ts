import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  registrationChecks,
  registrationDrafts,
  registrationReviews,
  telephonyRegistrations,
  textingFees,
  workspaces,
} from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { checkDraft, draftFromProfile } from '../messaging/a2p';
import { confirmationsFor } from '../messaging/preflight';
import {
  refuseUnwritable,
  websiteFixFactsFrom,
  websiteFixSourcesOf,
} from '../messaging/web-person';
import {
  WEB_PERSON_EMAILS_A_DAY,
  WEBSITE_FIX_IDS,
  WEBSITE_FIXES,
} from '../messaging/website-fixes';
import {
  REGISTRATION_CHECK_TTL_MS,
  registrationFingerprint,
} from '../messaging/registration-fingerprint';
import {
  arrivingNumber,
  carrierHasDetails,
  FAMILY_KINDS,
  familyFor,
  latestByKind,
  defaultNumber,
  loadRegistrations,
  textingFeesPaidFor,
  unsettledTextingFee,
} from '../messaging/store';
import { money } from '../money/format';
import { textingFeeLines, textingFeeTotal } from '../money/texting-fees';
import {
  BusinessProfile,
  RegistrationRecordCheckInput,
  RegistrationRecordCheckOutput,
  RegistrationRequestReviewInput,
  RegistrationRequestReviewOutput,
  RegistrationReviewDecideInput,
  RegistrationReviewDecideOutput,
  RegistrationReviewSendBackInput,
  RegistrationSaveDraftInput,
  RegistrationSaveDraftOutput,
  RegistrationSendReviewedInput,
  RegistrationSendReviewedOutput,
  RegistrationSubmitInput,
  RegistrationSubmitOutput,
  RegistrationUpdateStatusInput,
  RegistrationUpdateStatusOutput,
  RegistrationEmailWebPersonInput,
  RegistrationEmailWebPersonOutput,
} from '../schemas/telephony';
import { replyOnTicket } from './support';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type Family = 'a2p_10dlc' | 'toll_free_verification';

/**
 * Why this business can't send a registration of this kind now, thrown as the refusal the screens show: no number for
 * a toll-free one, the wrong kind for its number, already with the carriers, or already approved. Shared by sending and
 * by asking HandsFreeOS to check it, so neither gets as far as a ticket that couldn't be sent anyway.
 */
async function refuseUnsendable(ctx: CommandContext, workspaceId: string, kind: Family) {
  const number = await defaultNumber(ctx.tx, workspaceId);
  // **A local number's registration is the business's, not the number's.** The 10DLC brand and campaign name
  // the business and how it texts, and every local number on its messaging service is covered once they are
  // approved. So a business moving its own number here registers while the number is on its way, and texts
  // the day it lands rather than weeks after. Toll-free verification is for one toll-free number, and Twilio
  // asks for that number, so it still waits for it.
  const coming = number ? null : await arrivingNumber(ctx.tx, workspaceId);
  if (!number && kind !== 'a2p_10dlc')
    throw HfosError.rule(
      'no_number',
      409,
      'Toll-free verification is for the toll-free number itself, so it can only be sent once you have it. Get one under Get a business number in Settings → Texting & calls first.',
    );
  if (number && familyFor(number.numberType) !== kind)
    throw HfosError.rule(
      'registration_kind_mismatch',
      400,
      number.numberType === 'toll_free'
        ? `${formatPhone(number.e164)} is a toll-free number, so it needs toll-free verification instead. Refresh Settings → Texting & calls and start it there.`
        : `${formatPhone(number.e164)} is a local number, so it needs the 10DLC brand and campaign registration instead. Refresh Settings → Texting & calls and start it there.`,
    );
  if (coming && familyFor(coming.numberType) !== kind)
    throw HfosError.rule(
      'registration_kind_mismatch',
      400,
      `${formatPhone(coming.e164)} is a toll-free number, so it needs toll-free verification, which can only be sent once the number is here. Nothing needs sending until then.`,
    );
  const kinds = FAMILY_KINDS[kind];
  const latest = latestByKind(
    (await loadRegistrations(ctx.tx, workspaceId)).filter((r) => kinds.includes(r.kind)),
  );
  const chain = kinds.map((k) => latest.get(k));
  // Only what the carrier has is under review; a step still waiting to be sent can change.
  if (
    chain.some(
      (r) => r && (r.status === 'submitted' || r.status === 'in_review') && carrierHasDetails(r),
    )
  )
    throw HfosError.rule(
      'registration_in_review',
      409,
      'The carriers are still reviewing this registration, so it can’t change yet. Owners and admins get an email when they answer, and you can send changes then.',
    );
  if (chain.every((r) => r?.status === 'approved'))
    throw HfosError.rule(
      'registration_approved',
      409,
      number
        ? `Texting is already approved for ${formatPhone(number.e164)}, so there’s nothing more to send.`
        : 'Texting is already approved for this business, so there’s nothing more to send. Its numbers can text as soon as they’re here.',
    );
  return { number, coming, kinds, latest };
}

/**
 * **All green, or not sent** (the owner, 2026-11-05). The details have to be the ones the worker's checks last found
 * all green, within the day, and every tick only the business can give has to be ticked. Otherwise the business asks
 * HandsFreeOS to check it (`registration.request_review`), and an approved one is sent by `registration.send_reviewed`.
 */
async function refuseUnlessAllGreen(
  ctx: CommandContext,
  workspaceId: string,
  kind: Family,
  business: BusinessProfile,
) {
  const ask =
    'Fix it on the registration’s last step in Settings → Texting & calls, or press “Ask HandsFreeOS to check it” there.';
  const unticked = confirmationsFor({
    optInPath: business.optInPath ?? null,
    optInUrl: business.optInUrl ?? null,
    otherWays: business.otherWays ?? [],
    issues: checkDraft(draftFromProfile(business), business.displayName ?? business.legalName),
    legalName: business.legalName,
  }).find((c) => !(business.confirmed ?? []).includes(c.id));
  if (unticked)
    throw HfosError.rule(
      'registration_not_green',
      409,
      `This registration can’t go yet: “${unticked.label}” isn’t ticked. Tick it on the registration’s last step in Settings → Texting & calls once it’s true, or press “Ask HandsFreeOS to check it” there.`,
    );
  const [check] = await ctx.tx
    .select()
    .from(registrationChecks)
    .where(eq(registrationChecks.workspaceId, workspaceId));
  const fresh = !!check && Date.now() - check.checkedAt.getTime() <= REGISTRATION_CHECK_TTL_MS;
  if (!check || !fresh || check.fingerprint !== registrationFingerprint(kind, business))
    throw HfosError.rule(
      'registration_not_checked',
      409,
      check && check.fingerprint === registrationFingerprint(kind, business)
        ? 'These details were checked more than a day ago, so they need checking again before they go. Open the registration in Settings → Texting & calls and go to its last step, which checks them again.'
        : 'These details haven’t been checked as they are now. Open the registration in Settings → Texting & calls and go to its last step, which checks your website, policy, terms and sign-up page before anything is sent.',
    );
  if (!check.allGreen)
    throw HfosError.rule(
      'registration_not_green',
      409,
      `Not everything on this registration is green yet${check.notGreen[0] ? `: ${check.notGreen[0]}` : '.'} ${ask}`,
    );
}

/**
 * Sends a registration's details: the steps the carriers need, in order, and what it costs. What `registration.submit`
 * does once the details are all green, and what `registration.send_reviewed` does once HandsFreeOS approved them.
 */
async function sendRegistration(
  ctx: CommandContext,
  workspaceId: string,
  kind: Family,
  business: BusinessProfile,
  createdBy: string | null,
): Promise<{ registrationIds: string[]; fee: { id: string; amountCents: number } | null }> {
  const { number, coming, kinds, latest } = await refuseUnsendable(ctx, workspaceId, kind);
  const forNumber = number?.e164 ?? coming?.e164 ?? null;
  const input = { kind, business };
  /*
   * **What sending it costs (0105), worked out before anything changes**, from what was sent and paid for
   * before: the brand's fees until it has gone, the campaign's review when it is new, was turned down, or an
   * unpaid earlier send already owes it. The 10DLC steps wait in the worker until it is paid.
   */
  const owed =
    input.kind === 'a2p_10dlc'
      ? await unsettledTextingFee(ctx.tx, workspaceId, 'registration')
      : null;
  const feeLines =
    input.kind === 'a2p_10dlc'
      ? textingFeeLines({
          ...(await textingFeesPaidFor(ctx.tx, workspaceId)),
          monthlyVolume: input.business.monthlyVolume,
        })
      : [];

  // The kind of business goes with it, for the carrier's industry: the workspace already knows it, and
  // asking again on the form would only give it a second answer to disagree with. So does the name customers
  // know when the sender didn't give one (the Assistant asks only for the legal name): with a DBA, the
  // carriers are told both names, and HELP replies carry the one customers know.
  const [ws] = await ctx.tx
    .select({ industry: workspaces.industry, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const submission = {
    ...input.business,
    ...(!input.business.displayName && ws?.name ? { displayName: ws.name } : {}),
    ...(forNumber ? { forNumber } : {}),
    industry: ws?.industry ?? null,
  };
  const phoneNumberId = number?.id ?? coming?.id ?? null;
  const now = new Date();
  const ids: string[] = [];
  let previous: string | null = null;
  // Approved steps stay approved; anything else in the chain is (re)sent in order. A step the carrier turned
  // down keeps its provider id: the worker edits or replaces that request with these details.
  for (const kind of kinds) {
    const existing = latest.get(kind);
    if (existing?.status === 'approved') {
      ids.push(existing.id);
      previous = existing.id;
      continue;
    }
    if (existing) {
      await ctx.tx
        .update(telephonyRegistrations)
        .set({ status: 'submitted', submission, submittedAt: now, phoneNumberId })
        .where(eq(telephonyRegistrations.id, existing.id));
      ids.push(existing.id);
      previous = existing.id;
      continue;
    }
    const inserted: { id: string }[] = await ctx.tx
      .insert(telephonyRegistrations)
      .values({
        workspaceId,
        kind,
        status: 'submitted',
        submission,
        submittedAt: now,
        phoneNumberId,
        dependsOnId: previous,
        createdBy,
      })
      .returning({ id: telephonyRegistrations.id });
    const row = inserted[0];
    if (!row) throw HfosError.forbidden();
    ids.push(row.id);
    previous = row.id;
  }
  // What was being typed is now what was sent; the wizard starts from the submission next time.
  await ctx.tx.delete(registrationDrafts).where(eq(registrationDrafts.workspaceId, workspaceId));

  // What it costs. An earlier send's unpaid fee with the same lines stays, page and all; one this send changes
  // (a vetting added by a bigger volume, say) is put aside, and the new fee carries its lines.
  let fee: { id: string; amountCents: number } | null = null;
  const amountCents = textingFeeTotal(feeLines);
  const sameLines =
    !!owed &&
    owed.amountCents === amountCents &&
    owed.lines.map((l) => l.key).join() === feeLines.map((l) => l.key).join();
  if (owed && sameLines) fee = { id: owed.id, amountCents: owed.amountCents };
  else {
    if (owed)
      await ctx.tx
        .update(textingFees)
        .set({ status: 'cancelled', closedAt: now })
        .where(eq(textingFees.id, owed.id));
    if (feeLines.length) {
      const [made] = await ctx.tx
        .insert(textingFees)
        .values({
          workspaceId,
          purpose: 'registration',
          lines: feeLines.map(({ key, name, cents }) => ({ key, name, cents })),
          amountCents,
          requestedBy: createdBy,
        })
        .returning({ id: textingFees.id });
      if (!made) throw HfosError.forbidden();
      fee = { id: made.id, amountCents };
      await ctx.emit({
        type: 'texting_fee.due',
        entityType: 'texting_fee',
        entityId: made.id,
        payload: { textingFeeId: made.id, amountCents, purpose: 'registration' },
        after: {
          owed: money(amountCents),
          for: feeLines.map((l) => l.name).join(', '),
        },
      });
    }
  }
  await ctx.emit({
    type: 'registration.submitted',
    entityType: 'registration',
    entityId: ids[ids.length - 1]!,
    payload: { kind: input.kind, registrationIds: ids, legalName: input.business.legalName },
    after: {
      kind: input.kind,
      legalName: input.business.legalName,
      useCase: input.business.useCase,
      monthlyVolume: input.business.monthlyVolume,
      ...(forNumber ? { number: formatPhone(forNumber) } : {}),
    },
  });
  return { registrationIds: ids, fee };
}

export const registrationSubmit = defineCommand({
  name: 'registration.submit',
  description:
    'Send the business details the carriers need before texts can go out: toll-free verification, or the 10DLC brand and campaign for a local number. Only details the registration’s last step in Settings → Texting & calls found all green in the last day go (every check passed, every tick ticked); anything else is refused, and the person either fixes it there or asks HandsFreeOS to check it (registration.request_review). After the carriers turn one down, send the corrected details again: a toll-free request is edited or replaced and a campaign is registered again. A local number’s business profile and brand are checked against what HandsFreeOS support corrected with the carriers, so changed details there apply to the campaign only. A local (10DLC) registration can be sent before the business has a number, for example while its own number is being moved here: once approved, every local number that joins the business is covered. Toll-free verification waits for the toll-free number. A local registration costs what the carriers charge for it (the brand’s fees once, the campaign’s review each time it is sent), and its steps wait until that is paid: the output’s fee says how much, and phone.setup_status where to pay it.',
  risk: 3,
  input: RegistrationSubmitInput,
  output: RegistrationSubmitOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['registration.submitted', 'texting_fee.due'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    await refuseUnsendable(ctx, workspaceId, input.kind);
    await refuseUnlessAllGreen(ctx, workspaceId, input.kind, input.business);
    const sent = await sendRegistration(
      ctx,
      workspaceId,
      input.kind,
      input.business,
      userIdOf(ctx.actor),
    );
    // Sent all green: a check by HandsFreeOS still waiting isn't needed any more.
    await withdrawWaiting(ctx, workspaceId);
    return sent;
  },
});

// ---------- all green, or checked by HandsFreeOS ----------

export const registrationRecordCheck = defineCommand({
  name: 'registration.record_check',
  description:
    'Worker: what the texting registration’s last step found for exactly these details, so a send of them can be let through when it was all green.',
  risk: 1,
  input: RegistrationRecordCheckInput,
  output: RegistrationRecordCheckOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const allGreen = input.notGreen.length === 0;
    const row = {
      fingerprint: input.fingerprint,
      allGreen,
      notGreen: input.notGreen,
      checks: input.checks as never,
      checkedAt: new Date(),
    };
    await ctx.tx
      .insert(registrationChecks)
      .values({ workspaceId, ...row })
      .onConflictDoUpdate({ target: registrationChecks.workspaceId, set: row });
    return { allGreen };
  },
});

/** Withdraws the business's waiting review, when it has one: asking again, or sending it all green. */
async function withdrawWaiting(ctx: CommandContext, workspaceId: string) {
  await ctx.tx
    .update(registrationReviews)
    .set({ status: 'withdrawn' })
    .where(
      and(
        eq(registrationReviews.workspaceId, workspaceId),
        eq(registrationReviews.status, 'waiting'),
      ),
    );
}

/** "• a" lines, the way a ticket lists things. */
const bullets = (items: readonly string[]) => items.map((i) => `• ${i}`).join('\n');

export const registrationRequestReview = defineCommand({
  name: 'registration.request_review',
  description:
    'Ask HandsFreeOS to check the texting registration by hand, when not everything on its last step is green. Opens a support ticket listing what isn’t green and the note; HandsFreeOS then approves it, and it’s sent to the carriers exactly as it is (with their fees, as usual), or sends it back saying what to change. Either way the person gets an email. Asking again replaces a check still waiting.',
  risk: 2,
  input: RegistrationRequestReviewInput,
  output: RegistrationRequestReviewOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['support_ticket.opened', 'registration_review.requested'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    await refuseUnsendable(ctx, workspaceId, input.kind);
    await withdrawWaiting(ctx, workspaceId);
    const reviewId = randomUUID();
    const [ws] = await ctx.tx
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const who = input.business.legalName;
    const body = [
      `Please check our texting registration before it goes to the carriers. Not everything on its last step was green${input.notGreen.length ? ':' : '.'}`,
      ...(input.notGreen.length ? ['', bullets(input.notGreen)] : []),
      ...(input.note ? ['', `Our note: ${input.note}`] : []),
      '',
      `${ws?.name ?? who} (${who}), ${input.kind === 'a2p_10dlc' ? 'local number (10DLC)' : 'toll-free number'}.`,
    ].join('\n');
    const [ticket] = await rows<{ ticket_id: string; ticket_number: string }>(
      ctx.tx,
      sql`select ticket_id, ticket_number from private.open_support_ticket(
        ${workspaceId}, ${`Check our texting registration: ${who}`}, ${body},
        ${JSON.stringify({ kind: 'registration_review', reviewId })}::jsonb)`,
    );
    if (!ticket)
      throw HfosError.notFound(
        'That business isn’t there, or you’re no longer in it, so nothing was sent. Pick a business from your list and try again.',
      );
    const ticketNumber = Number(ticket.ticket_number);
    await ctx.tx.insert(registrationReviews).values({
      id: reviewId,
      workspaceId,
      kind: input.kind,
      submission: input.business as never,
      fingerprint: registrationFingerprint(input.kind, input.business),
      notGreen: input.notGreen,
      note: input.note || null,
      ticketId: ticket.ticket_id,
      ticketNumber,
      requestedBy: userIdOf(ctx.actor),
    });
    await ctx.emit({
      type: 'support_ticket.opened',
      entityType: 'support_ticket',
      entityId: ticket.ticket_id,
      payload: { number: ticketNumber, channel: 'in_app' },
    });
    await ctx.emit({
      type: 'registration_review.requested',
      entityType: 'registration_review',
      entityId: reviewId,
      payload: { reviewId, kind: input.kind, ticketNumber },
      after: { kind: input.kind, notGreen: input.notGreen.length, ticket: ticketNumber },
    });
    return { reviewId, ticketNumber };
  },
});

const onPlatform = () => ({ kind: 'platform' as const });

/** Decides a review as the support person (the SQL checks support.reply), or says why it couldn't. */
async function decide(
  ctx: CommandContext,
  reviewId: string,
  status: 'approved' | 'sent_back',
  note: string | undefined,
) {
  const [row] = await rows<{
    workspace_id: string;
    organization_id: string;
    ticket_id: string | null;
    status: 'waiting' | 'approved' | 'sent_back' | 'withdrawn';
    decided: boolean;
  }>(
    ctx.tx,
    sql`select * from private.decide_registration_review(${reviewId}::uuid, ${status}::app.registration_review_status, ${note ?? null})`,
  );
  if (!row)
    throw HfosError.notFound('That registration check isn’t there anymore. Refresh the ticket.');
  if (!row.decided)
    throw HfosError.rule(
      'registration_review_decided',
      409,
      row.status === 'withdrawn'
        ? 'The business changed its registration since asking (it sent it, or asked again), so there’s nothing to decide here. Refresh the ticket.'
        : `This check was already ${row.status === 'approved' ? 'approved' : 'sent back'}. Refresh the ticket to see it.`,
    );
  return row;
}

export const registrationReviewApprove = defineCommand({
  name: 'registration.review.approve',
  description:
    'Support: approve a business’s texting registration after checking it by hand. It’s sent to the carriers exactly as the business left it (their fees as usual), and the business is told on the ticket.',
  risk: 3,
  input: RegistrationReviewDecideInput,
  output: RegistrationReviewDecideOutput,
  permission: 'support.reply',
  scope: onPlatform,
  emits: ['support_ticket.replied', 'platform.registration_review_decided'],
  async handler(ctx, input) {
    const row = await decide(ctx, input.reviewId, 'approved', input.note);
    if (row.ticket_id)
      await replyOnTicket(ctx, {
        ticketId: row.ticket_id,
        internal: false,
        status: 'solved',
        body: [
          'We checked your texting registration and approved it, so it’s on its way to the carriers now. If they charge a fee for it, Settings → Texting & calls shows it, and it goes to them once that’s paid. The carriers usually answer within three to seven working days.',
          ...(input.note ? ['', input.note] : []),
        ].join('\n'),
      });
    await ctx.emit({
      type: 'platform.registration_review_decided',
      entityType: 'registration_review',
      entityId: input.reviewId,
      payload: {
        reviewId: input.reviewId,
        workspaceId: row.workspace_id,
        organizationId: row.organization_id,
        status: 'approved',
      },
      after: { status: 'approved' },
    });
    return { reviewId: input.reviewId, status: 'approved' as const };
  },
});

export const registrationReviewSendBack = defineCommand({
  name: 'registration.review.send_back',
  description:
    'Support: send a business’s texting registration back after checking it by hand, saying what to change. Nothing goes to the carriers; the business is told on the ticket.',
  risk: 2,
  input: RegistrationReviewSendBackInput,
  output: RegistrationReviewDecideOutput,
  permission: 'support.reply',
  scope: onPlatform,
  emits: ['support_ticket.replied', 'platform.registration_review_decided'],
  async handler(ctx, input) {
    const row = await decide(ctx, input.reviewId, 'sent_back', input.note);
    if (row.ticket_id)
      await replyOnTicket(ctx, {
        ticketId: row.ticket_id,
        internal: false,
        body: [
          'We checked your texting registration, and it needs a change before it goes to the carriers:',
          '',
          input.note,
          '',
          'Open it in Settings → Texting & calls, change it, and send it from the last step. If something still isn’t green there, ask us to check it again.',
        ].join('\n'),
      });
    await ctx.emit({
      type: 'platform.registration_review_decided',
      entityType: 'registration_review',
      entityId: input.reviewId,
      payload: {
        reviewId: input.reviewId,
        workspaceId: row.workspace_id,
        organizationId: row.organization_id,
        status: 'sent_back',
      },
      after: { status: 'sent_back' },
    });
    return { reviewId: input.reviewId, status: 'sent_back' as const };
  },
});

export const registrationSendReviewed = defineCommand({
  name: 'registration.send_reviewed',
  description:
    'Worker: send a texting registration HandsFreeOS approved, exactly as the business left it, as though they had pressed Send.',
  risk: 1,
  input: RegistrationSendReviewedInput,
  output: RegistrationSendReviewedOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['registration.submitted', 'texting_fee.due'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [review] = await ctx.tx
      .select()
      .from(registrationReviews)
      .where(
        and(
          eq(registrationReviews.id, input.reviewId),
          eq(registrationReviews.workspaceId, workspaceId),
        ),
      );
    if (!review || review.status !== 'approved' || review.sentAt)
      return { registrationIds: [], sent: false };
    const kind = review.kind as Family;
    const business = BusinessProfile.parse(review.submission);
    let registrationIds: string[] = [];
    try {
      registrationIds = (
        await sendRegistration(ctx, workspaceId, kind, business, review.requestedBy)
      ).registrationIds;
    } catch (err) {
      // Already with the carriers, or approved, since it was asked about: nothing left to send.
      const rule = err instanceof HfosError ? err.rule : null;
      if (rule !== 'registration_in_review' && rule !== 'registration_approved') throw err;
    }
    await ctx.tx
      .update(registrationReviews)
      .set({ sentAt: new Date(), registrationIds })
      .where(eq(registrationReviews.id, review.id));
    // What was being typed is what HandsFreeOS sent; the wizard starts from it next time.
    return { registrationIds, sent: registrationIds.length > 0 };
  },
});

export const registrationSaveDraft = defineCommand({
  name: 'registration.save_draft',
  description:
    'Keep the texting registration’s answers while they are being filled in, so a refresh or coming back later picks up where it was left. Nothing goes to the carriers until it is sent.',
  risk: 1,
  input: RegistrationSaveDraftInput,
  output: RegistrationSaveDraftOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const now = new Date();
    await ctx.tx
      .insert(registrationDrafts)
      .values({ workspaceId, answers: input.answers, updatedBy: userIdOf(ctx.actor) })
      .onConflictDoUpdate({
        target: registrationDrafts.workspaceId,
        set: { answers: input.answers, updatedBy: userIdOf(ctx.actor), updatedAt: now },
      });
    return { savedAt: now.toISOString() };
  },
});

/**
 * "Email your web person" (the owner, 2026-11-12): what the business's website needs before the carriers approve its
 * texting, each fix in its own text file, emailed to whoever looks after the site. The worker writes the files and
 * sends it (from HandsFreeOS, in the business's name, replies to whoever sent it, who gets a copy). Refused here when a
 * file couldn't be written as it would go, so the person reads why while they can still fix it.
 */
export const registrationEmailWebPerson = defineCommand({
  name: 'registration.email_web_person',
  description:
    'Email whoever looks after the business’s website the changes it needs before the carriers approve its texting, each in its own text file: add the sign-up form (one of the business’s published forms, or the box and its words for a form of their own), the privacy policy and terms’ part about texts, and the website chat’s code. Sent from HandsFreeOS in the business’s name; replies go to the person sending it, who gets a copy.',
  risk: 2,
  input: RegistrationEmailWebPersonInput,
  output: RegistrationEmailWebPersonOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['registration.web_person_emailed'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const userId = userIdOf(ctx.actor);
    const fixes = WEBSITE_FIX_IDS.filter((id) => input.fixes.includes(id));
    // A few a day each: it goes from HandsFreeOS's own address, to anyone.
    const [sent] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.events
          where workspace_id = ${workspaceId} and event_type = 'registration.web_person_emailed'
            and actor_id = ${userId} and created_at > now() - interval '1 day'`,
    );
    if ((sent?.n ?? 0) >= WEB_PERSON_EMAILS_A_DAY)
      throw HfosError.rule(
        'web_person_limit',
        429,
        `You’ve sent ${WEB_PERSON_EMAILS_A_DAY} of these today for this business, which is the most for a day. Try again tomorrow, or reply on one you’ve sent.`,
      );
    const sources = await websiteFixSourcesOf(ctx.tx, workspaceId, fixes, input.formId);
    // The addresses don't change what can be written, only where its links point.
    refuseUnwritable(
      websiteFixFactsFrom(sources, { app: 'https://app.invalid', pages: 'https://app.invalid' }),
      fixes,
    );
    const files = fixes.map((id) => WEBSITE_FIXES[id].filename);
    await ctx.emit({
      type: 'registration.web_person_emailed',
      entityType: 'workspace',
      entityId: workspaceId,
      payload: {
        to: input.to,
        name: input.name || null,
        fixes,
        // The form the worker writes about: the one checked here, or null for a form of their own.
        formId: fixes.includes('form') ? (sources.form?.id ?? null) : null,
        note: input.note || null,
      },
      after: { to: input.to, files },
    });
    return { sentTo: input.to, files };
  },
});

export const registrationUpdateStatus = defineCommand({
  name: 'registration.update_status',
  description: 'Worker: record what the carrier said about a registration.',
  risk: 1,
  input: RegistrationUpdateStatusInput,
  output: RegistrationUpdateStatusOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['registration.status_changed'],
  actors: ['system'],
  async handler(ctx, input) {
    const [reg] = await ctx.tx
      .select()
      .from(telephonyRegistrations)
      .where(
        and(
          eq(telephonyRegistrations.id, input.registrationId),
          eq(telephonyRegistrations.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!reg) throw HfosError.notFound('Registration not found.');
    const changed = input.status !== reg.status;
    const patch: Partial<typeof telephonyRegistrations.$inferInsert> = {
      status: input.status,
      pollCount: changed ? 0 : reg.pollCount + 1,
    };
    if (input.providerSid !== undefined) patch.providerSid = input.providerSid;
    if (input.providerStatus !== undefined) patch.providerStatus = input.providerStatus;
    if (input.rejectionReason !== undefined) patch.rejectionReason = input.rejectionReason;
    else if (input.status !== 'rejected' && input.status !== 'failed') patch.rejectionReason = null;
    if (input.nextPollAt !== undefined)
      patch.nextPollAt = input.nextPollAt ? new Date(input.nextPollAt) : null;
    if (input.carrierSubmittedAt !== undefined)
      patch.carrierSubmittedAt = input.carrierSubmittedAt
        ? new Date(input.carrierSubmittedAt)
        : null;
    if (input.status === 'approved' && !reg.approvedAt) patch.approvedAt = new Date();
    await ctx.tx
      .update(telephonyRegistrations)
      .set(patch)
      .where(eq(telephonyRegistrations.id, reg.id));
    if (changed)
      await ctx.emit({
        type: 'registration.status_changed',
        entityType: 'registration',
        entityId: reg.id,
        payload: { kind: reg.kind, from: reg.status, to: input.status },
        before: { status: reg.status },
        after: {
          kind: reg.kind,
          status: input.status,
          rejectionReason: patch.rejectionReason ?? null,
        },
      });
    return { registrationId: reg.id, status: input.status, changed };
  },
});
