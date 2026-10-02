import { and, eq } from 'drizzle-orm';
import {
  registrationDrafts,
  telephonyRegistrations,
  textingFees,
  workspaces,
} from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
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
  RegistrationSaveDraftInput,
  RegistrationSaveDraftOutput,
  RegistrationSubmitInput,
  RegistrationSubmitOutput,
  RegistrationUpdateStatusInput,
  RegistrationUpdateStatusOutput,
} from '../schemas/telephony';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const registrationSubmit = defineCommand({
  name: 'registration.submit',
  description:
    'Send the business details the carriers need before texts can go out: toll-free verification, or the 10DLC brand and campaign for a local number. After the carriers turn one down, send the corrected details again: a toll-free request is edited or replaced and a campaign is registered again. A local number’s business profile and brand are checked against what HandsFreeOS support corrected with the carriers, so changed details there apply to the campaign only. A local (10DLC) registration can be sent before the business has a number, for example while its own number is being moved here: once approved, every local number that joins the business is covered. Toll-free verification waits for the toll-free number. A local registration costs what the carriers charge for it (the brand’s fees once, the campaign’s review each time it is sent), and its steps wait until that is paid: the output’s fee says how much, and phone.setup_status where to pay it.',
  risk: 3,
  input: RegistrationSubmitInput,
  output: RegistrationSubmitOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['registration.submitted', 'texting_fee.due'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const number = await defaultNumber(ctx.tx, workspaceId);
    // **A local number's registration is the business's, not the number's.** The 10DLC brand and campaign name
    // the business and how it texts, and every local number on its messaging service is covered once they are
    // approved. So a business moving its own number here registers while the number is on its way, and texts
    // the day it lands rather than weeks after. Toll-free verification is for one toll-free number, and Twilio
    // asks for that number, so it still waits for it.
    const coming = number ? null : await arrivingNumber(ctx.tx, workspaceId);
    if (!number && input.kind !== 'a2p_10dlc')
      throw HfosError.rule(
        'no_number',
        409,
        'Toll-free verification is for the toll-free number itself, so it can only be sent once you have it. Get one under Get a business number in Settings → Texting & calls first.',
      );
    if (number && familyFor(number.numberType) !== input.kind)
      throw HfosError.rule(
        'registration_kind_mismatch',
        400,
        number.numberType === 'toll_free'
          ? `${formatPhone(number.e164)} is a toll-free number, so it needs toll-free verification instead. Refresh Settings → Texting & calls and start it there.`
          : `${formatPhone(number.e164)} is a local number, so it needs the 10DLC brand and campaign registration instead. Refresh Settings → Texting & calls and start it there.`,
      );
    if (coming && familyFor(coming.numberType) !== input.kind)
      throw HfosError.rule(
        'registration_kind_mismatch',
        400,
        `${formatPhone(coming.e164)} is a toll-free number, so it needs toll-free verification, which can only be sent once the number is here. Nothing needs sending until then.`,
      );
    const forNumber = number?.e164 ?? coming?.e164 ?? null;
    const kinds = FAMILY_KINDS[input.kind];
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
    // asking again on the form would only give it a second answer to disagree with.
    const [ws] = await ctx.tx
      .select({ industry: workspaces.industry })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const submission = {
      ...input.business,
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
          createdBy: userIdOf(ctx.actor),
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
            requestedBy: userIdOf(ctx.actor),
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
