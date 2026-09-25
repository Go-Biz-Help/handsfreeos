/**
 * Moving a number a business already owns to us (M17).
 *
 * **Shaped exactly like a carrier registration**, because it is the same problem: paperwork goes to a
 * carrier, the carrier takes its time, a job asks it where things stand, and the answer comes back. A person
 * drafts and sends; the worker records. `private.guard_number_port_update()` enforces that split
 * independently, so a command that got it wrong would be refused rather than obeyed.
 *
 * **`number_port.submit` is the risky one**, and the only risk-4 here. A full port moves a business's calls,
 * and a business that has told its customers a number for eleven years is trusting us with it. So the details
 * and the signed authorisation are both checked before anything is sent, and the provider call itself is a
 * job — never an outbox handler — so it retries with backoff instead of losing a submission to a blip.
 *
 * **The account number and PIN never come back out.** They are the losing carrier's credentials, not ours to
 * spread: `NumberPortOut` says which fields are *filled*, never what they say.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { files, migrationReconnectTasks, numberPorts, phoneNumbers } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { safeFileName } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { liveNumberCount, MAX_NUMBERS_PER_WORKSPACE } from '../messaging/store';
import { assertWalletHasRoom } from '../money/wallet-gate';
import {
  NumberPortAttachInput,
  NumberPortBeginUploadInput,
  NumberPortBeginUploadOutput,
  NumberPortCancelInput,
  NumberPortCompleteInput,
  NumberPortCompleteOutput,
  NumberPortRecordStateInput,
  NumberPortRefOutput,
  NumberPortSaveInput,
  NumberPortStartInput,
  NumberPortSubmitInput,
} from '../schemas/port';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type PortRow = typeof numberPorts.$inferSelect;

async function loadPort(ctx: CommandContext, portId: string): Promise<PortRow> {
  const [p] = await ctx.tx
    .select()
    .from(numberPorts)
    .where(and(eq(numberPorts.id, portId), eq(numberPorts.workspaceId, ctx.scope.workspaceId!)));
  if (!p) throw HfosError.notFound('No port with that id.');
  return p;
}

/** Everything the losing carrier asks for, filled in. */
const detailsReady = (submission: Record<string, unknown>): boolean =>
  ['accountNumber', 'pin', 'authorizedBy', 'serviceAddress'].every(
    (k) => typeof submission[k] === 'string' && (submission[k] as string).trim().length > 0,
  );

const refOf = (p: PortRow) => ({ portId: p.id, status: p.status });

/** A person may still change it: a draft, or one the carrier turned down that they are fixing. */
function assertEditable(p: PortRow): void {
  if (p.status === 'draft' || p.status === 'rejected' || p.status === 'failed') return;
  throw HfosError.rule(
    'port_with_carrier',
    409,
    'This number is already with the carrier, so it cannot be changed. Call it off first if something is wrong.',
  );
}

/**
 * Claim the number while the carrier thinks about it.
 *
 * **A `phone_numbers` row in `porting` is the claim**, and `phone_numbers_live_e164` is what makes it one:
 * without it two businesses could both send the same number to the carrier and the second would find it
 * taken on the day it landed. It is also why the number shows in Settings as "Moving to us" the whole time,
 * and why a port in flight counts against the ten-number ceiling.
 *
 * It cannot send — `porting` is deliberately absent from `SENDABLE_STATUSES` and from the partial index the
 * default is kept by — so nothing routes to it and nobody can make it the number new conversations go out
 * from until it is really ours.
 */
/**
 * Take the number off the market, and hand back the row that now holds it.
 *
 * **The database does this, not us.** Claiming means writing `porting` onto a phone number, and later
 * `released` with the timestamp that goes with it — states that four separate rules say only HandsFreeOS
 * writes: the insert policy pins a person's new number to `provisioning`, and
 * `private.guard_phone_number_update()` lets a person move one only as far as `releasing`. Those rules are
 * what stop anyone conjuring a number that routes real calls, so rather than widening them for the one
 * command that needs more, `private.port_claim_number` is HandsFreeOS doing it on the business's behalf —
 * asking `channels.manage` for itself rather than trusting this caller, exactly as
 * `private.staff_credit_wallet` does for a support credit.
 *
 * It also stamps `number_ports.phone_number_id`, which is why no command writes that column any more.
 */
async function claimNumber(ctx: CommandContext, p: PortRow): Promise<string> {
  const [row] = await rows<{ port_claim_number: string }>(
    ctx.tx,
    sql`select private.port_claim_number(${p.id}::uuid)`,
  );
  if (!row) throw HfosError.forbidden();
  return row.port_claim_number;
}

/**
 * Let the number go again.
 *
 * A port that is off — called off, turned down, failed — must not keep another business from trying for the
 * same number, and must not keep counting against this one's ceiling. Marking it `released` rather than
 * deleting the row keeps the history: a business that tried to move a number and could not should be able to
 * see that it tried.
 */
async function releaseClaim(ctx: CommandContext, p: PortRow): Promise<void> {
  if (!p.phoneNumberId) return;
  await rows(ctx.tx, sql`select private.port_release_number(${p.id}::uuid)`);
}

export const numberPortStart = defineCommand({
  name: 'number_port.start',
  description: 'Begin moving a number the business already owns to HandsFreeOS.',
  risk: 2,
  input: NumberPortStartInput,
  output: NumberPortRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['number_port.started'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    // A ported number costs the same as a bought one from the month it lands, and counts against the same
    // ceiling — otherwise the cap on buying would just be a cap on buying.
    if ((await liveNumberCount(ctx.tx, workspaceId)) >= MAX_NUMBERS_PER_WORKSPACE)
      throw HfosError.rule(
        'number_limit',
        409,
        `That is ${MAX_NUMBERS_PER_WORKSPACE} numbers, which is as many as one business can have. Release one you are not using first.`,
      );
    await assertWalletHasRoom(ctx.tx, workspaceId, 'number');

    // Asking twice for the same number is a mistake, not a second request — and the database says so too.
    const [live] = await ctx.tx
      .select()
      .from(numberPorts)
      .where(and(eq(numberPorts.workspaceId, workspaceId), eq(numberPorts.e164, input.e164)))
      .orderBy(desc(numberPorts.createdAt))
      .limit(1);
    if (live && ['draft', 'submitted', 'carrier_review', 'scheduled'].includes(live.status))
      return refOf(live);

    const [made] = await ctx.tx
      .insert(numberPorts)
      .values({
        workspaceId,
        e164: input.e164,
        kind: input.kind,
        createdBy: userIdOf(ctx.actor),
      })
      .returning();
    await ctx.emit({
      type: 'number_port.started',
      entityType: 'number_port',
      entityId: made!.id,
      payload: { e164: input.e164, kind: input.kind },
      after: { number: formatPhone(input.e164), kind: input.kind },
    });
    return refOf(made!);
  },
});

export const numberPortSave = defineCommand({
  name: 'number_port.save',
  description:
    'Put in what the old carrier needs: the account number, the PIN, who is authorising it.',
  risk: 2,
  input: NumberPortSaveInput,
  output: NumberPortRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['number_port.saved'],
  async handler(ctx, input) {
    const p = await loadPort(ctx, input.portId);
    assertEditable(p);
    await ctx.tx
      .update(numberPorts)
      .set({ submission: input.submission, status: 'draft' })
      .where(eq(numberPorts.id, p.id));
    // Deliberately says only that the details are in. The account number and PIN are the losing carrier's
    // credentials, and the audit log is read by people who have no business seeing them.
    await ctx.emit({
      type: 'number_port.saved',
      entityType: 'number_port',
      entityId: p.id,
      payload: { e164: p.e164 },
      after: { details: 'filled in' },
    });
    return { portId: p.id, status: 'draft' as const };
  },
});

/**
 * Reserve a place for one of the papers, then upload to the path it gives back and confirm it with
 * `file.confirm` — **the two-step every other upload here uses**, not one invented for ports. What is
 * different is the permission (`channels.manage`, the same as the port itself) and the record type: a
 * signed authorisation belongs to the business and to this port, not to any customer, so nothing about it
 * reaches a customer's timeline. `app.record_type` got a `port` value for exactly this (0081, 0082).
 */
export const numberPortBeginUpload = defineCommand({
  name: 'number_port.begin_upload',
  description:
    'Reserve a place for the signed authorisation or a recent bill (10 MB at most). Upload it to the returned path, then confirm it with file.confirm and attach it.',
  risk: 1,
  input: NumberPortBeginUploadInput,
  output: NumberPortBeginUploadOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const p = await loadPort(ctx, input.portId);
    assertEditable(p);
    const fileId = randomUUID();
    const objectPath = `${workspaceId}/port/${p.id}/${fileId}/${safeFileName(input.name)}`;
    const [row] = await ctx.tx
      .insert(files)
      .values({
        id: fileId,
        workspaceId,
        recordType: 'port',
        recordId: p.id,
        bucket: 'attachments',
        objectPath,
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        createdBy: requireHuman(ctx).userId,
      })
      .returning({ id: files.id });
    if (!row) throw HfosError.forbidden();
    return { fileId, bucket: 'attachments' as const, objectPath };
  },
});

export const numberPortAttach = defineCommand({
  name: 'number_port.attach_document',
  description: 'Record that a signed authorisation or a recent bill has been uploaded for a port.',
  risk: 1,
  input: NumberPortAttachInput,
  output: NumberPortRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['number_port.document_attached'],
  async handler(ctx, input) {
    const p = await loadPort(ctx, input.portId);
    assertEditable(p);
    // The file has to be this port's, and finished. A path taken on trust from the caller would be a way to
    // point a carrier submission at any object in the bucket.
    const [f] = await ctx.tx
      .select()
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ctx.scope.workspaceId!)));
    if (!f || f.deletedAt || f.recordType !== 'port' || f.recordId !== p.id)
      throw HfosError.notFound('That file is not one of this port’s papers.');
    if (f.status !== 'ready')
      throw HfosError.rule('file_not_uploaded', 409, 'The file has not finished uploading.');
    // Which papers are in, and where. Never what they say.
    const documents = {
      ...(p.documents as Record<string, unknown>),
      [input.document]: { fileId: f.id, objectPath: f.objectPath, name: f.name },
    };
    await ctx.tx.update(numberPorts).set({ documents }).where(eq(numberPorts.id, p.id));
    await ctx.emit({
      type: 'number_port.document_attached',
      entityType: 'number_port',
      entityId: p.id,
      payload: { e164: p.e164, document: input.document, fileId: f.id },
      after: { document: input.document === 'loa' ? 'signed authorisation' : 'a recent bill' },
    });
    return refOf(p);
  },
});

/**
 * Send it. **The one that can lose a business its calls**, so everything is checked here rather than
 * discovered by a carrier three days later.
 */
export const numberPortSubmit = defineCommand({
  name: 'number_port.submit',
  description:
    'Send the port to the carrier. A full port moves calls too, and takes two to four weeks.',
  risk: 4,
  input: NumberPortSubmitInput,
  output: NumberPortRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['number_port.submitted'],
  async handler(ctx, input) {
    const p = await loadPort(ctx, input.portId);
    assertEditable(p);
    if (!detailsReady(p.submission as Record<string, unknown>))
      throw HfosError.rule(
        'port_details_missing',
        409,
        'The old carrier needs the account number, the PIN, who is authorising it and the service address.',
      );
    if (!(p.documents as Record<string, unknown>)['loa'])
      throw HfosError.rule(
        'port_loa_missing',
        409,
        'Upload the signed authorisation before sending this. Carriers turn down a port without one.',
      );
    // A number this business already has and is already using. The database refuses to demote it — taking an
    // `active` number to `porting` would drop it off routing and every call to it would reach nobody — but
    // silence there would send papers to a carrier for no reason, so say it here where it can be said in
    // words.
    const [already] = await ctx.tx
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.workspaceId, ctx.scope.workspaceId!),
          eq(phoneNumbers.e164, p.e164),
          eq(phoneNumbers.status, 'active'),
        ),
      );
    if (already)
      throw HfosError.rule(
        'number_already_yours',
        409,
        'You already have this number, so there is nothing to move.',
      );
    // Claimed before it is sent, not after: between the two, another business could ask for the same number.
    // `claimNumber` writes `phone_number_id` itself, so this update is only what pressing Send means.
    await claimNumber(ctx, p);
    await ctx.tx
      .update(numberPorts)
      .set({ status: 'submitted', submittedAt: new Date(), rejectionReason: null })
      .where(eq(numberPorts.id, p.id));
    await ctx.emit({
      type: 'number_port.submitted',
      entityType: 'number_port',
      entityId: p.id,
      payload: { e164: p.e164, kind: p.kind },
      before: { status: p.status },
      after: { status: 'submitted', number: formatPhone(p.e164), kind: p.kind },
    });
    return { portId: p.id, status: 'submitted' as const };
  },
});

export const numberPortCancel = defineCommand({
  name: 'number_port.cancel',
  description:
    'Call off a port. The carrier may already have moved it, in which case it is too late.',
  risk: 3,
  input: NumberPortCancelInput,
  output: NumberPortRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['number_port.cancelled'],
  async handler(ctx, input) {
    const p = await loadPort(ctx, input.portId);
    if (p.status === 'complete')
      throw HfosError.rule('port_complete', 409, 'That number has already moved.');
    if (p.status === 'cancelled') return refOf(p);
    await releaseClaim(ctx, p);
    await ctx.tx.update(numberPorts).set({ status: 'cancelled' }).where(eq(numberPorts.id, p.id));
    await ctx.emit({
      type: 'number_port.cancelled',
      entityType: 'number_port',
      entityId: p.id,
      payload: { e164: p.e164, providerSid: p.providerSid },
      before: { status: p.status },
      after: { status: 'cancelled' },
    });
    return { portId: p.id, status: 'cancelled' as const };
  },
});

/** Worker: what the carrier said, and when to ask again. */
export const numberPortRecordState = defineCommand({
  name: 'number_port.record_state',
  description: 'Worker: record where a port stands with the carrier.',
  risk: 1,
  input: NumberPortRecordStateInput,
  output: NumberPortRefOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['number_port.state_changed'],
  actors: ['system'],
  async handler(ctx, input) {
    const p = await loadPort(ctx, input.portId);
    // A port somebody called off while the carrier was thinking stays called off: a late answer about a
    // request nobody wants any more must not quietly restart it.
    if (p.status === 'cancelled' || p.status === 'complete') return refOf(p);
    // The carrier said no, or it broke. The number goes back on the market: somebody else may want it, and
    // this business should not keep paying a ceiling slot for a number it never got.
    if (input.status === 'rejected' || input.status === 'failed') await releaseClaim(ctx, p);
    await ctx.tx
      .update(numberPorts)
      .set({
        status: input.status,
        ...(input.providerSid ? { providerSid: input.providerSid } : {}),
        providerStatus: input.providerStatus,
        rejectionReason: input.rejectionReason,
        scheduledFor: input.scheduledFor,
        nextPollAt: input.nextPollAt ? new Date(input.nextPollAt) : null,
        ...(input.carrierSubmittedAt !== undefined
          ? {
              carrierSubmittedAt: input.carrierSubmittedAt
                ? new Date(input.carrierSubmittedAt)
                : null,
            }
          : {}),
        pollCount: p.pollCount + 1,
      })
      .where(eq(numberPorts.id, p.id));
    if (p.status !== input.status)
      await ctx.emit({
        type: 'number_port.state_changed',
        entityType: 'number_port',
        entityId: p.id,
        payload: { e164: p.e164, status: input.status, scheduledFor: input.scheduledFor },
        before: { status: p.status },
        after: {
          status: input.status,
          ...(input.scheduledFor ? { moves: input.scheduledFor } : {}),
        },
      });
    return { portId: p.id, status: input.status };
  },
});

/**
 * Worker: it landed.
 *
 * The number becomes the business's, in `active` rather than `porting`, and the worker adds it to the
 * messaging service the same way a bought one is. Nothing here *promotes* it: a business that ported its
 * long-standing number in almost certainly wants new conversations to go out from it, but moving that
 * quietly is not ours to decide. (A business whose only live number this is still gets it as the default —
 * `private.phone_numbers_keep_default` never leaves one with live numbers and none chosen.)
 *
 * **`providerSid` is the number's reference, or nothing.** A hosted-messaging port has no incoming-number
 * row of its own — the line stays with the old carrier and the messaging service is the whole arrangement —
 * and this used to write the *port's* reference there instead. Every reader of that column reads it as a
 * number's: releasing one passes it straight to the carrier, skipping the `findOwnedNumber` fallback that
 * exists for exactly this case, so a business would be told the number is gone while the carrier still
 * holds and bills it. Null says the honest thing, and that fallback then does its job.
 */
export const numberPortComplete = defineCommand({
  name: 'number_port.complete',
  description: 'Worker: the carrier moved the number. It becomes one of the business’s numbers.',
  risk: 2,
  input: NumberPortCompleteInput,
  output: NumberPortCompleteOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['number_port.completed', 'phone_number.ported_in', 'migration.task_changed'],
  actors: ['system'],
  async handler(ctx, input) {
    const p = await loadPort(ctx, input.portId);
    if (p.phoneNumberId && p.status === 'complete')
      return { portId: p.id, phoneNumberId: p.phoneNumberId };

    // The row is already there in `porting`, claimed when the port was sent. `claimNumber` is called again
    // rather than assumed, because a port that was turned down and sent again releases and re-takes it.
    const numberId = await claimNumber(ctx, p);
    await ctx.tx
      .update(phoneNumbers)
      .set({ status: 'active', providerSid: input.providerSid, purchasedAt: new Date() })
      .where(eq(phoneNumbers.id, numberId));
    await ctx.tx
      .update(numberPorts)
      .set({ status: 'complete', completedAt: new Date() })
      .where(eq(numberPorts.id, p.id));

    await ctx.emit({
      type: 'number_port.completed',
      entityType: 'number_port',
      entityId: p.id,
      payload: { e164: p.e164, phoneNumberId: numberId, kind: p.kind },
      before: { status: p.status },
      after: { status: 'complete', number: formatPhone(p.e164) },
    });
    // Its own event, because what happens next is a number's business rather than a port's: the messaging
    // service, the registration chain, and anything else that watches for a number arriving.
    await ctx.emit({
      type: 'phone_number.ported_in',
      entityType: 'phone_number',
      entityId: numberId,
      payload: { e164: p.e164, kind: p.kind },
      after: { number: formatPhone(p.e164) },
    });
    await tickOffMigratedNumber(ctx, p.e164);
    return { portId: p.id, phoneNumberId: numberId };
  },
});

/**
 * A migration that found this number asked for it to be moved (M11), and now it has been.
 *
 * The migration writes each number it finds as a setup step — "your customers know this number, so it moves" —
 * and those steps hold `migration.finalize` back until they are done. Moving the number is the step, so the
 * moment the carrier finishes, it is ticked off here rather than left for somebody to come back and tick off
 * by hand. By nobody (`completed_by` stays empty): HandsFreeOS saw it happen, no person claimed it.
 *
 * Only this business's own steps, and only open ones: a step somebody marked not needed stays that way.
 */
async function tickOffMigratedNumber(ctx: CommandContext, e164: string): Promise<void> {
  const open = await ctx.tx
    .select({
      id: migrationReconnectTasks.id,
      migrationId: migrationReconnectTasks.migrationId,
      workspaceId: migrationReconnectTasks.workspaceId,
      label: migrationReconnectTasks.label,
      state: migrationReconnectTasks.state,
    })
    .from(migrationReconnectTasks)
    .where(
      and(
        eq(migrationReconnectTasks.workspaceId, ctx.scope.workspaceId!),
        eq(migrationReconnectTasks.kind, 'messaging'),
        inArray(migrationReconnectTasks.state, ['todo', 'in_progress', 'blocked']),
        or(
          eq(migrationReconnectTasks.label, e164),
          sql`${migrationReconnectTasks.descriptor} ->> 'number' = ${e164}`,
        ),
      ),
    );
  if (!open.length) return;
  await ctx.tx
    .update(migrationReconnectTasks)
    .set({ state: 'done', completedAt: new Date(), completedBy: null })
    .where(
      inArray(
        migrationReconnectTasks.id,
        open.map((t) => t.id),
      ),
    );
  // The same event a person ticking it off writes, so the migration's history reads the same either way.
  for (const t of open)
    await ctx.emit({
      type: 'migration.task_changed',
      entityType: 'migration',
      entityId: t.migrationId,
      workspaceId: t.workspaceId,
      payload: { taskId: t.id, state: 'done' },
      before: { state: t.state },
      after: { step: t.label, state: 'done' },
      broadcast: false,
    });
}

export const portCommands = [
  numberPortStart,
  numberPortSave,
  numberPortBeginUpload,
  numberPortAttach,
  numberPortSubmit,
  numberPortCancel,
  numberPortRecordState,
  numberPortComplete,
];
