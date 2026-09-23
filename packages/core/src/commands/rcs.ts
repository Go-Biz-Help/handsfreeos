/**
 * A business's RCS sender (0101).
 *
 * **Made at Twilio, connected here.** Twilio creates and onboards RCS senders only in its own console — the
 * brand's name, logo and colours, the carriers' review — so a business (or Go Biz Help for it) makes the sender
 * in the business's own Twilio account and connects it here by its id. Connecting it puts it on the business's
 * messaging service, and from then on every text goes RCS first, falling back to SMS or MMS by itself.
 *
 * **Shaped like a number port** (commands/port.ts), because it is the same machine: a person asks, the worker
 * talks to Twilio in a job, the carriers take their time, a job asks again. A person connects, pauses, asks for a
 * fresh look and lets go; `rcs_sender.record_state` is the worker's alone, and
 * `private.guard_rcs_sender_update()` holds that line in the database whoever runs a command.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { phoneNumbers, rcsSenders } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { currentRcsSender, SENDABLE_STATUSES } from '../messaging/store';
import {
  RcsSenderConnectInput,
  RcsSenderRecordStateInput,
  RcsSenderRefOutput,
  RcsSenderUpdateInput,
  RcsSenderWorkspaceInput,
  type RcsSenderStatus,
} from '../schemas/rcs-sender';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type SenderRow = typeof rcsSenders.$inferSelect;

const refOf = (s: Pick<SenderRow, 'id' | 'status'>) => ({ rcsSenderId: s.id, status: s.status });

/** The business's sender, or a plain refusal saying there isn't one. */
async function requireSender(ctx: CommandContext): Promise<SenderRow> {
  const s = await currentRcsSender(ctx.tx, ctx.scope.workspaceId!);
  if (!s) throw HfosError.notFound('This business has no RCS sender connected.');
  return s;
}

/** A line of this business's that can send: where a customer's first RCS message may start its thread. */
async function assertLine(ctx: CommandContext, phoneNumberId: string): Promise<void> {
  const [n] = await ctx.tx
    .select({ id: phoneNumbers.id })
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.id, phoneNumberId),
        eq(phoneNumbers.workspaceId, ctx.scope.workspaceId!),
        inArray(phoneNumbers.status, [...SENDABLE_STATUSES]),
      ),
    );
  if (!n) throw HfosError.notFound('Pick one of this business’s numbers.');
}

export const rcsSenderConnect = defineCommand({
  name: 'rcs_sender.connect',
  description:
    'Connect the RCS sender made for this business at Twilio, by its id. Once the carriers approve it, texts go as RCS where the customer’s phone can show it and as SMS or MMS where it can’t.',
  risk: 2,
  input: RcsSenderConnectInput,
  output: RcsSenderRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['rcs_sender.connect_requested'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    // RCS rides on texting: the sender lives in the business's own Twilio account, which its first number made,
    // and every phone that can't show RCS is sent an ordinary text from one of its numbers instead.
    const [live] = await ctx.tx
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.workspaceId, workspaceId),
          inArray(phoneNumbers.status, [...SENDABLE_STATUSES]),
        ),
      )
      .limit(1);
    if (!live)
      throw HfosError.rule(
        'no_number',
        409,
        'Get a business number first. Phones that can’t show RCS get your messages as texts from it.',
      );
    if (input.phoneNumberId) await assertLine(ctx, input.phoneNumberId);

    const current = await currentRcsSender(ctx.tx, workspaceId);
    if (current && current.status !== 'failed') {
      // Asking again for the sender that is already here is a double click, not a second sender.
      if (current.senderId.toLowerCase() === input.senderId.toLowerCase()) return refOf(current);
      throw HfosError.rule(
        'rcs_sender_exists',
        409,
        'This business already has an RCS sender. Disconnect it before connecting another.',
      );
    }

    let row: SenderRow;
    if (current) {
      // It could not be connected last time: the same row tries again, with whatever id the person gave now.
      const [again] = await ctx.tx
        .update(rcsSenders)
        .set({
          senderId: input.senderId,
          status: 'connecting',
          lastError: null,
          ...(input.phoneNumberId !== undefined ? { phoneNumberId: input.phoneNumberId } : {}),
        })
        .where(eq(rcsSenders.id, current.id))
        .returning();
      row = again!;
    } else {
      const [made] = await ctx.tx
        .insert(rcsSenders)
        .values({
          workspaceId,
          senderId: input.senderId,
          phoneNumberId: input.phoneNumberId ?? null,
          createdBy: userIdOf(ctx.actor),
        })
        .returning();
      if (!made) throw HfosError.forbidden();
      row = made;
    }
    await ctx.emit({
      type: 'rcs_sender.connect_requested',
      entityType: 'rcs_sender',
      entityId: row.id,
      payload: { senderId: row.senderId, retry: !!current },
      ...(current ? { before: { senderId: current.senderId, status: current.status } } : {}),
      after: { senderId: row.senderId, status: 'connecting' },
    });
    return refOf(row);
  },
});

export const rcsSenderUpdate = defineCommand({
  name: 'rcs_sender.update',
  description:
    'Switch RCS off or back on (off sends every text as SMS or MMS and keeps the sender), or choose the number a customer’s first RCS message starts its thread on.',
  risk: 2,
  input: RcsSenderUpdateInput,
  output: RcsSenderRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['rcs_sender.updated'],
  async handler(ctx, input) {
    const s = await requireSender(ctx);
    if (s.status === 'disconnecting')
      throw HfosError.rule('rcs_sender_leaving', 409, 'This RCS sender is being disconnected.');
    if (input.phoneNumberId) await assertLine(ctx, input.phoneNumberId);
    const patch: Partial<typeof rcsSenders.$inferInsert> = {};
    if (input.enabled !== undefined && input.enabled !== s.enabled) patch.enabled = input.enabled;
    if (input.phoneNumberId !== undefined && input.phoneNumberId !== s.phoneNumberId)
      patch.phoneNumberId = input.phoneNumberId;
    if (Object.keys(patch).length === 0) return refOf(s);
    await ctx.tx.update(rcsSenders).set(patch).where(eq(rcsSenders.id, s.id));
    await ctx.emit({
      type: 'rcs_sender.updated',
      entityType: 'rcs_sender',
      entityId: s.id,
      payload: { fields: Object.keys(patch) },
      before: {
        ...(patch.enabled !== undefined ? { rcs: s.enabled ? 'on' : 'off' } : {}),
        ...(patch.phoneNumberId !== undefined ? { phoneNumberId: s.phoneNumberId } : {}),
      },
      after: {
        ...(patch.enabled !== undefined ? { rcs: patch.enabled ? 'on' : 'off' } : {}),
        ...(patch.phoneNumberId !== undefined ? { phoneNumberId: patch.phoneNumberId } : {}),
      },
    });
    return refOf(s);
  },
});

export const rcsSenderRefresh = defineCommand({
  name: 'rcs_sender.refresh',
  description:
    'Ask Twilio where the RCS sender stands now, instead of waiting for the next check: after the carriers approve it, or after fixing something in the Twilio console.',
  risk: 1,
  input: RcsSenderWorkspaceInput,
  output: RcsSenderRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['rcs_sender.refresh_requested'],
  async handler(ctx) {
    const s = await requireSender(ctx);
    if (s.status === 'disconnecting' || s.status === 'failed')
      throw HfosError.rule(
        'rcs_sender_not_connected',
        409,
        s.status === 'failed'
          ? 'This RCS sender isn’t connected. Connect it again.'
          : 'This RCS sender is being disconnected.',
      );
    await ctx.emit({
      type: 'rcs_sender.refresh_requested',
      entityType: 'rcs_sender',
      entityId: s.id,
      payload: { senderId: s.senderId },
      after: { senderId: s.senderId },
    });
    return refOf(s);
  },
});

export const rcsSenderDisconnect = defineCommand({
  name: 'rcs_sender.disconnect',
  description:
    'Let the RCS sender go: it comes off the business’s messaging service and every text goes as SMS or MMS again. The sender itself stays at Twilio.',
  risk: 2,
  input: RcsSenderWorkspaceInput,
  output: RcsSenderRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['rcs_sender.disconnect_requested'],
  async handler(ctx) {
    const s = await requireSender(ctx);
    if (s.status === 'disconnecting') return refOf(s);
    await ctx.tx.update(rcsSenders).set({ status: 'disconnecting' }).where(eq(rcsSenders.id, s.id));
    await ctx.emit({
      type: 'rcs_sender.disconnect_requested',
      entityType: 'rcs_sender',
      entityId: s.id,
      payload: { senderId: s.senderId, providerSid: s.providerSid, inService: s.inService },
      before: { status: s.status },
      after: { status: 'disconnecting' },
    });
    return { rcsSenderId: s.id, status: 'disconnecting' as const };
  },
});

/** Where a sender may go from where it is, as the worker sees it. */
const LEAVING: ReadonlySet<RcsSenderStatus> = new Set(['disconnecting', 'disconnected']);

/** Worker: what Twilio said about the sender, and when to ask again. */
export const rcsSenderRecordState = defineCommand({
  name: 'rcs_sender.record_state',
  description: 'Worker: record where the RCS sender stands with Twilio and the carriers.',
  risk: 1,
  input: RcsSenderRecordStateInput,
  output: RcsSenderRefOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['rcs_sender.state_changed', 'rcs_sender.service_changed'],
  actors: ['system'],
  async handler(ctx, input) {
    const [s] = await ctx.tx
      .select()
      .from(rcsSenders)
      .where(
        and(
          eq(rcsSenders.id, input.rcsSenderId),
          eq(rcsSenders.workspaceId, ctx.scope.workspaceId!),
        ),
      )
      .orderBy(desc(rcsSenders.createdAt));
    if (!s) throw HfosError.notFound('No RCS sender with that id.');
    // A sender somebody let go while Twilio was answering stays let go: a late answer about a sender nobody
    // wants any more must not quietly put it back on the messaging service. Only finishing the job moves it.
    if (LEAVING.has(s.status) && input.status !== 'disconnected') return refOf(s);
    if (s.status === 'disconnected') return refOf(s);
    const now = new Date();
    await ctx.tx
      .update(rcsSenders)
      .set({
        status: input.status,
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        ...(input.providerSid !== undefined ? { providerSid: input.providerSid } : {}),
        ...(input.providerStatus !== undefined ? { providerStatus: input.providerStatus } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.inService !== undefined ? { inService: input.inService } : {}),
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
        nextPollAt: input.nextPollAt ? new Date(input.nextPollAt) : null,
        checkedAt: now,
        pollCount: s.pollCount + 1,
        ...(input.status === 'active' && !s.connectedAt ? { connectedAt: now } : {}),
        ...(input.status === 'disconnected' ? { disconnectedAt: now, inService: false } : {}),
      })
      .where(eq(rcsSenders.id, s.id));
    if (s.status !== input.status)
      await ctx.emit({
        type: 'rcs_sender.state_changed',
        entityType: 'rcs_sender',
        entityId: s.id,
        payload: { senderId: s.senderId, status: input.status, from: s.status },
        before: { status: s.status },
        after: {
          status: input.status,
          ...(input.lastError ? { reason: input.lastError.slice(0, 200) } : {}),
        },
      });
    else if (input.inService !== undefined && input.inService !== s.inService)
      // The same sender put on the messaging service or taken off it — RCS switched back on, paused, or the pool
      // put right — which is whether texts go RCS first. Nothing to email anybody about, but Settings shows it.
      await ctx.emit({
        type: 'rcs_sender.service_changed',
        entityType: 'rcs_sender',
        entityId: s.id,
        payload: { senderId: s.senderId, inService: input.inService },
        before: { inService: s.inService },
        after: { inService: input.inService },
      });
    return { rcsSenderId: s.id, status: input.status };
  },
});

export const rcsCommands = [
  rcsSenderConnect,
  rcsSenderUpdate,
  rcsSenderRefresh,
  rcsSenderDisconnect,
  rcsSenderRecordState,
];
