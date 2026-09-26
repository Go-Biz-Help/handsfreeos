/**
 * Bringing a number that already lives in Twilio (20261011000100).
 *
 * A person says which number and where it is today; the worker watches the workspace's own subaccount and
 * finishes the import the moment the number arrives there. **Nothing is claimed while waiting** — a waiting
 * import proves nothing, because anybody can type anybody's number. The number turning up in *this
 * workspace's subaccount* is the proof, since only its owner could have sent it there, and that is when it
 * becomes one of the business's numbers. `private.guard_number_import()` keeps everything the worker learns
 * the worker's to write.
 *
 * **Setting the number up is not registering it for texting.** `number_import.complete` makes the number live —
 * calls ring, texts arrive — and says nothing about the carrier registration, which lives on
 * app.telephony_registrations and which a HighLevel number does not bring with it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { numberImports, numberPorts, phoneNumbers, twilioConnections } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { liveNumberCount, MAX_NUMBERS_PER_WORKSPACE } from '../messaging/store';
import { assertWalletHasRoom } from '../money/wallet-gate';
import {
  NumberImportCancelInput,
  NumberImportCheckNowInput,
  NumberImportCompleteInput,
  NumberImportCompleteOutput,
  NumberImportFailInput,
  NumberImportRecordCheckInput,
  NumberImportRefOutput,
  NumberImportStartInput,
} from '../schemas/number-import';
import { moveMigratedNumberStep } from './port';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type ImportRow = typeof numberImports.$inferSelect;

async function loadImport(ctx: CommandContext, importId: string): Promise<ImportRow> {
  const [row] = await ctx.tx
    .select()
    .from(numberImports)
    .where(
      and(eq(numberImports.id, importId), eq(numberImports.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!row) throw HfosError.notFound('No number on its way here with that id.');
  return row;
}

const refOf = (r: ImportRow) => ({ importId: r.id, status: r.status });

const SOURCE_WORDS = { twilio: 'a Twilio account', highlevel: 'HighLevel' } as const;

export const numberImportStart = defineCommand({
  name: 'number_import.start',
  description:
    'Start bringing a number that is already in Twilio — the business’s own Twilio account, or GoHighLevel / LeadConnector — into this business. The number keeps its public number; HandsFreeOS sets it up the moment it arrives.',
  risk: 2,
  input: NumberImportStartInput,
  output: NumberImportRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['number_import.started', 'migration.task_changed'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;

    // Asking twice is a mistake, not a second request.
    const [open] = await ctx.tx
      .select()
      .from(numberImports)
      .where(
        and(
          eq(numberImports.workspaceId, workspaceId),
          eq(numberImports.e164, input.e164),
          eq(numberImports.status, 'waiting'),
        ),
      );
    if (open) return refOf(open);

    const [mine] = await ctx.tx
      .select({ status: phoneNumbers.status })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.workspaceId, workspaceId),
          eq(phoneNumbers.e164, input.e164),
          inArray(phoneNumbers.status, ['provisioning', 'porting', 'active', 'releasing']),
        ),
      );
    if (mine)
      throw HfosError.rule(
        'number_already_yours',
        409,
        mine.status === 'porting'
          ? 'This number is already on its way here from its carrier.'
          : 'You already have this number, so there is nothing to bring over.',
      );
    // A carrier port and an account transfer of one number would race each other, and only one can win.
    const [ported] = await ctx.tx
      .select({ id: numberPorts.id })
      .from(numberPorts)
      .where(
        and(
          eq(numberPorts.workspaceId, workspaceId),
          eq(numberPorts.e164, input.e164),
          inArray(numberPorts.status, ['draft', 'submitted', 'carrier_review', 'scheduled']),
        ),
      );
    if (ported)
      throw HfosError.rule(
        'number_port_open',
        409,
        'There is already a carrier port started for this number. Call that off first, or let it finish.',
      );

    // The same ceiling and the same wallet check as buying one: a number that arrives costs what a bought one
    // does, from the month it lands. Numbers still on their way count, or ten waiting imports would let a
    // business end the month with twenty numbers.
    const [{ waiting } = { waiting: 0 }] = await rows<{ waiting: number }>(
      ctx.tx,
      sql`select count(*)::int as waiting from app.number_imports
          where workspace_id = ${workspaceId} and status = 'waiting'`,
    );
    if ((await liveNumberCount(ctx.tx, workspaceId)) + waiting >= MAX_NUMBERS_PER_WORKSPACE)
      throw HfosError.rule(
        'number_limit',
        409,
        `That is ${MAX_NUMBERS_PER_WORKSPACE} numbers, which is as many as one business can have. Release one you are not using first.`,
      );
    await assertWalletHasRoom(ctx.tx, workspaceId, 'number');

    // A connected account is the organization's, and only its owners and admins can see one (RLS), so a
    // connection this person cannot see is one they cannot bring numbers from.
    let sourceAccountSid = input.sourceAccountSid ?? null;
    if (input.connectionId) {
      const [c] = await ctx.tx
        .select({
          accountSid: twilioConnections.accountSid,
          status: twilioConnections.status,
          organizationId: twilioConnections.organizationId,
        })
        .from(twilioConnections)
        .where(eq(twilioConnections.id, input.connectionId));
      if (!c || c.organizationId !== ctx.scope.organizationId)
        throw HfosError.notFound('That Twilio account is not connected here.');
      if (c.status !== 'active')
        throw HfosError.rule(
          'twilio_connection_inactive',
          409,
          'That Twilio account is no longer connected. Connect it again to bring numbers from it.',
        );
      sourceAccountSid ??= c.accountSid;
    }

    const [made] = await ctx.tx
      .insert(numberImports)
      .values({
        workspaceId,
        e164: input.e164,
        source: input.source,
        connectionId: input.connectionId ?? null,
        sourceAccountSid,
        sourceNumberSid: input.sourceNumberSid ?? null,
        createdBy: userIdOf(ctx.actor),
      })
      .returning();
    await ctx.emit({
      type: 'number_import.started',
      entityType: 'number_import',
      entityId: made!.id,
      payload: { e164: input.e164, source: input.source },
      after: { number: formatPhone(input.e164), from: SOURCE_WORDS[input.source] },
    });
    // A GoHighLevel migration writes each number it found as a setup step. Bringing it over *is* that step.
    await moveMigratedNumberStep(ctx, input.e164, ['todo', 'blocked'], 'in_progress');
    return refOf(made!);
  },
});

export const numberImportCancel = defineCommand({
  name: 'number_import.cancel',
  description:
    'Stop watching for a number to arrive. Nothing changes where the number is today; ask for the transfer to be called off too if it was requested.',
  risk: 2,
  input: NumberImportCancelInput,
  output: NumberImportRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['number_import.cancelled', 'migration.task_changed'],
  async handler(ctx, input) {
    const r = await loadImport(ctx, input.importId);
    if (r.status === 'cancelled') return refOf(r);
    if (r.status === 'complete')
      throw HfosError.rule(
        'number_import_complete',
        409,
        'That number has already arrived. Release it from your numbers if you no longer want it.',
      );
    await ctx.tx
      .update(numberImports)
      .set({ status: 'cancelled' })
      .where(eq(numberImports.id, r.id));
    await ctx.emit({
      type: 'number_import.cancelled',
      entityType: 'number_import',
      entityId: r.id,
      payload: { e164: r.e164 },
      before: { status: r.status },
      after: { status: 'cancelled', number: formatPhone(r.e164) },
    });
    await moveMigratedNumberStep(ctx, r.e164, ['in_progress'], 'todo');
    return { importId: r.id, status: 'cancelled' as const };
  },
});

/** "It should be there now": look straight away rather than at the next scheduled check. */
export const numberImportCheckNow = defineCommand({
  name: 'number_import.check_now',
  description:
    'Look for a number that is on its way here right now, rather than at the next check.',
  risk: 1,
  input: NumberImportCheckNowInput,
  output: NumberImportRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['number_import.check_requested'],
  async handler(ctx, input) {
    const r = await loadImport(ctx, input.importId);
    if (r.status !== 'waiting') return refOf(r);
    await ctx.emit({
      type: 'number_import.check_requested',
      entityType: 'number_import',
      entityId: r.id,
      payload: { e164: r.e164 },
      broadcast: false,
    });
    return refOf(r);
  },
});

/** Worker: what one look found. Quiet unless something a person would see has changed. */
export const numberImportRecordCheck = defineCommand({
  name: 'number_import.record_check',
  description: 'Worker: record one look for a number on its way here.',
  risk: 1,
  input: NumberImportRecordCheckInput,
  output: NumberImportRefOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['number_import.checked'],
  actors: ['system'],
  async handler(ctx, input) {
    const r = await loadImport(ctx, input.importId);
    // Called off, or finished, while the worker was looking: a late answer must not bring it back.
    if (r.status !== 'waiting') return refOf(r);
    const learnedCarrier = !!input.carrier && r.lookedUpAt === null;
    const learnedDestination =
      !!input.destination && r.destinationAccountSid !== input.destination.accountSid;
    await ctx.tx
      .update(numberImports)
      .set({
        ...(learnedCarrier
          ? {
              carrierName: input.carrier!.name,
              hostedInTwilio: input.carrier!.hostedInTwilio,
              lookedUpAt: new Date(),
            }
          : {}),
        ...(input.destination
          ? {
              accountId: input.destination.accountId,
              destinationAccountSid: input.destination.accountSid,
            }
          : {}),
        lastError: input.lastError,
        nextPollAt: input.nextPollAt ? new Date(input.nextPollAt) : null,
        pollCount: r.pollCount + 1,
        lastCheckedAt: new Date(),
      })
      .where(eq(numberImports.id, r.id));
    if (learnedCarrier || learnedDestination || (input.lastError ?? null) !== r.lastError)
      await ctx.emit({
        type: 'number_import.checked',
        entityType: 'number_import',
        entityId: r.id,
        payload: { e164: r.e164, hostedInTwilio: input.carrier?.hostedInTwilio ?? null },
        after: {
          ...(learnedCarrier ? { carrier: input.carrier!.name ?? 'unknown' } : {}),
          ...(learnedDestination ? { sendTo: input.destination!.accountSid } : {}),
          ...(input.lastError ? { problem: input.lastError } : {}),
        },
      });
    return refOf(r);
  },
});

/**
 * Worker: the number is in the workspace's subaccount, pointed at our webhooks and on the messaging service.
 * It becomes one of the business's numbers.
 *
 * Nothing here *promotes* it to the default: a business that brought its long-standing number almost certainly
 * wants new conversations to go out from it, but that is theirs to say. (A business whose only live number this
 * is still gets it as the default — `private.phone_numbers_keep_default` never leaves one without.)
 */
export const numberImportComplete = defineCommand({
  name: 'number_import.complete',
  description:
    'Worker: the number arrived and is set up. It becomes one of the business’s numbers.',
  risk: 2,
  input: NumberImportCompleteInput,
  output: NumberImportCompleteOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['number_import.completed', 'phone_number.imported', 'migration.task_changed'],
  actors: ['system'],
  async handler(ctx, input) {
    const r = await loadImport(ctx, input.importId);
    if (r.status === 'complete' && r.phoneNumberId)
      return { importId: r.id, phoneNumberId: r.phoneNumberId };
    if (r.status !== 'waiting')
      throw HfosError.rule(
        'number_import_not_waiting',
        409,
        'This import is not waiting any more.',
      );

    const workspaceId = ctx.scope.workspaceId!;
    // A row this business already holds for the number (the same number bought, released and come back) is
    // taken again rather than left beside a new one. A live one means it is already theirs.
    const [held] = await ctx.tx
      .select()
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.e164, r.e164)))
      .orderBy(sql`(${phoneNumbers.status} = 'active') desc, ${phoneNumbers.createdAt} desc`)
      .limit(1);
    const values = {
      status: 'active' as const,
      accountId: input.accountId,
      providerSid: input.providerSid,
      numberType: input.numberType,
      capabilities: input.capabilities,
      purchasedAt: new Date(),
      releasedAt: null,
      lastError: null,
    };
    let numberId: string;
    if (held && held.status !== 'failed') {
      await ctx.tx.update(phoneNumbers).set(values).where(eq(phoneNumbers.id, held.id));
      numberId = held.id;
    } else {
      const [made] = await ctx.tx
        .insert(phoneNumbers)
        .values({ workspaceId, e164: r.e164, createdBy: r.createdBy, ...values })
        .returning({ id: phoneNumbers.id });
      numberId = made!.id;
    }
    await ctx.tx
      .update(numberImports)
      .set({
        status: 'complete',
        accountId: input.accountId,
        providerSid: input.providerSid,
        phoneNumberId: numberId,
        numberType: input.numberType,
        lastError: null,
        nextPollAt: null,
        completedAt: new Date(),
      })
      .where(eq(numberImports.id, r.id));

    await ctx.emit({
      type: 'number_import.completed',
      entityType: 'number_import',
      entityId: r.id,
      payload: { e164: r.e164, phoneNumberId: numberId, source: r.source },
      before: { status: r.status },
      after: { status: 'complete', number: formatPhone(r.e164) },
    });
    // Its own event, because what happens next is a number's business rather than an import's.
    await ctx.emit({
      type: 'phone_number.imported',
      entityType: 'phone_number',
      entityId: numberId,
      payload: { e164: r.e164, numberType: input.numberType, source: r.source },
      after: { number: formatPhone(r.e164) },
    });
    await moveMigratedNumberStep(ctx, r.e164, ['todo', 'in_progress', 'blocked'], 'done');
    return { importId: r.id, phoneNumberId: numberId };
  },
});

/** Worker: it cannot finish, and the business is told why in words it can act on. */
export const numberImportFail = defineCommand({
  name: 'number_import.fail',
  description: 'Worker: a number on its way here cannot be set up.',
  risk: 1,
  input: NumberImportFailInput,
  output: NumberImportRefOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['number_import.failed', 'migration.task_changed'],
  actors: ['system'],
  async handler(ctx, input) {
    const r = await loadImport(ctx, input.importId);
    if (r.status !== 'waiting') return refOf(r);
    await ctx.tx
      .update(numberImports)
      .set({ status: 'failed', lastError: input.reason, nextPollAt: null })
      .where(eq(numberImports.id, r.id));
    await ctx.emit({
      type: 'number_import.failed',
      entityType: 'number_import',
      entityId: r.id,
      payload: { e164: r.e164 },
      before: { status: r.status },
      after: { status: 'failed', number: formatPhone(r.e164), why: input.reason },
    });
    await moveMigratedNumberStep(ctx, r.e164, ['in_progress'], 'todo');
    return { importId: r.id, status: 'failed' as const };
  },
});

export const numberImportCommands = [
  numberImportStart,
  numberImportCancel,
  numberImportCheckNow,
  numberImportRecordCheck,
  numberImportComplete,
  numberImportFail,
];
