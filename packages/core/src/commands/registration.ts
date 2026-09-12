import { and, eq } from 'drizzle-orm';
import { telephonyRegistrations } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  FAMILY_KINDS,
  familyFor,
  latestByKind,
  liveNumber,
  loadRegistrations,
} from '../messaging/store';
import {
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
    'Send the business details the carriers need before texts can go out: toll-free verification, or the 10DLC brand and campaign for a local number.',
  risk: 3,
  input: RegistrationSubmitInput,
  output: RegistrationSubmitOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['registration.submitted'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const number = await liveNumber(ctx.tx, workspaceId);
    if (!number) throw HfosError.rule('no_number', 409, 'Get a business number first.');
    if (familyFor(number.numberType) !== input.kind)
      throw HfosError.rule(
        'registration_kind_mismatch',
        400,
        number.numberType === 'toll_free'
          ? 'Toll-free numbers use toll-free verification.'
          : 'Local numbers use the 10DLC brand and campaign registration.',
      );
    const kinds = FAMILY_KINDS[input.kind];
    const latest = latestByKind(
      (await loadRegistrations(ctx.tx, workspaceId)).filter((r) => kinds.includes(r.kind)),
    );
    const chain = kinds.map((k) => latest.get(k));
    if (chain.some((r) => r && (r.status === 'submitted' || r.status === 'in_review')))
      throw HfosError.rule(
        'registration_in_review',
        409,
        'The carriers are reviewing this registration. Changes wait until they answer.',
      );
    if (chain.every((r) => r?.status === 'approved'))
      throw HfosError.rule(
        'registration_approved',
        409,
        'Texting is already approved for this number.',
      );

    const submission = { ...input.business, forNumber: number.e164 };
    const now = new Date();
    const ids: string[] = [];
    let previous: string | null = null;
    // Approved steps stay approved; anything else in the chain is (re)sent in order.
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
          .set({ status: 'submitted', submission, submittedAt: now, phoneNumberId: number.id })
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
          phoneNumberId: number.id,
          dependsOnId: previous,
          createdBy: userIdOf(ctx.actor),
        })
        .returning({ id: telephonyRegistrations.id });
      const row = inserted[0];
      if (!row) throw HfosError.forbidden();
      ids.push(row.id);
      previous = row.id;
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
        number: formatPhone(number.e164),
      },
    });
    return { registrationIds: ids };
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
