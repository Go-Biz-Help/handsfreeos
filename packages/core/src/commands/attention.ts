/**
 * The Action Center's commands (M8). People snooze, dismiss and assign items and bring them back (Undo), and hand
 * them to HandsFreeOS; owners and admins save its settings; the worker records what it did on its own.
 * - Assign changes the real owner (the lead, the conversation or the task) through that record's own command, as
 *   the person; an appointment's or an approval's item is assigned on the item alone.
 * - Let HandsFreeOS Handle runs an ask-first choice (hand to the AI teammate, reply, set a next action) as the
 *   person, and marks the item handled; a safe one (a confirmation request, a follow-up nudge) is queued for the
 *   worker (`attention.handle_requested`), which alone schedules and sends it (attention.record_auto).
 * Approval items are only for the people who can decide them, whatever else they may do.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { attentionItems, workspaces } from '@hfos/db/schema';
import { conversationForItem, planAutoAction } from '../attention/auto-plan';
import { chipsOf, decidableApprovals, mayAct } from '../attention/items';
import {
  ATTENTION_KIND_LABELS,
  AUTO_KINDS,
  autoActionOf,
  isLeadKind,
  letHandleModeOf,
  letHandleRefusal,
  type AttentionAction,
  type AttentionKind,
} from '../attention/kinds';
import { loadAttentionContext, type AttentionItemRow } from '../attention/load';
import { checkNudgeTemplate, type NudgeCheckContext } from '../attention/nudge';
import { attentionSettingsOf, type AttentionSettings } from '../attention/settings';
import { formatPhone } from '../crm/phone';
import { userRef } from '../crm/records';
import { HfosError } from '../errors';
import { FRESH_MINUTES } from '../mobile';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import { changedSince, logLaterChange } from '../kernel/later-change';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import { workspaceAddresses } from '../messaging/email';
import { isSocialChannel, SOCIAL_CHANNEL_NAMES } from '../messaging/social';
import { isWorkspaceUser, defaultNumber } from '../messaging/store';
import {
  AttentionAssignInput,
  AttentionAssignOutput,
  AttentionCancelAutoOutput,
  AttentionDismissInput,
  AttentionItemRefInput,
  AttentionItemStateOutput,
  AttentionLetHandleInput,
  AttentionLetHandleOutput,
  AttentionRecordAutoInput,
  AttentionRecordAutoOutput,
  AttentionSaveSettingsInput,
  AttentionSaveSettingsOutput,
  AttentionSnoozeInput,
  type AttentionAskAction,
} from '../schemas/attention';
import { conversationAssign } from './conversation';
import { conversationHandToAi } from './conversation-handling';
import { leadSetNextAction } from './lead.set_next_action';
import { leadUpdate } from './lead.update';
import { messageSend } from './message';
import { taskUpdate } from './task';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const MIN = 60_000;
const DAY = 86_400_000;
/** Core offers snoozes up to 30 days (the database allows 31). */
const SNOOZE_MAX_DAYS = 30;

/** The ask-first choices each kind offers. */
const ASK_ACTIONS: Readonly<Partial<Record<AttentionKind, readonly AttentionAskAction[]>>> = {
  hot_lead: ['hand_to_ai', 'reply'],
  unanswered_lead: ['hand_to_ai', 'reply'],
  customer_waiting: ['hand_to_ai', 'reply'],
  missing_next_action: ['set_next_action'],
  // Money offers the reply and nothing else. Handing a conversation about a bill to the AI teammate is a
  // different conversation, and one Chris hasn't had.
  estimate_waiting: ['reply'],
  invoice_overdue: ['reply'],
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const CLEAR_SNOOZE = { snoozedUntil: null, snoozedAt: null, snoozedBy: null } as const;
const CLEAR_DISMISS = { dismissedAt: null, dismissedBy: null, dismissReason: null } as const;

async function loadItem(ctx: CommandContext, itemId: string): Promise<AttentionItemRow> {
  const [row] = await ctx.tx
    .select()
    .from(attentionItems)
    .where(
      and(eq(attentionItems.id, itemId), eq(attentionItems.workspaceId, ctx.scope.workspaceId!)),
    )
    .for('update');
  if (!row)
    throw HfosError.notFound('That item isn’t there anymore. Refresh to see what still needs you.');
  return row;
}

/** A person may take this action on this item: its permissions, and for an approval, deciding it. */
async function assertMay(ctx: CommandContext, row: AttentionItemRow, action: AttentionAction) {
  if (ctx.actor.type !== 'human') return;
  const who = {
    role: ctx.scope.workspaceRole,
    permissions: ctx.scope.workspacePermissions ?? null,
  };
  const decidable =
    row.kind === 'ai_approval'
      ? await decidableApprovals(ctx.tx, ctx.scope.workspaceId!, who, ctx.actor.userId, [
          row.subjectId,
        ])
      : new Set<string>();
  if (!mayAct({ userId: ctx.actor.userId, ...who, decidable }, row, action))
    throw row.kind === 'ai_approval' && !decidable.has(row.subjectId)
      ? HfosError.forbidden(
          'This approval is for someone else to decide. Only the people it was sent to can act on it.',
          'not_an_approver',
        )
      : HfosError.forbidden();
}

function notOpen(row: AttentionItemRow): HfosError {
  const message =
    row.state === 'resolved'
      ? 'This was already taken care of.'
      : row.state === 'handled'
        ? 'This was already handled.'
        : row.state === 'dismissed'
          ? 'This was dismissed. Bring it back first.'
          : 'This isn’t open.';
  return HfosError.rule('attention_not_open', 409, message);
}

const stateOut = (row: AttentionItemRow, changed: boolean) => ({
  itemId: row.id,
  state: row.state,
  snoozedUntil: iso(row.snoozedUntil),
  changed,
});

/**
 * A snooze or a dismissal a later change overtook: after it was made (on a phone, perhaps long before it had signal),
 * the item came back with something new, or someone snoozed or dismissed it. That stands, and the timeline says so.
 * True when it was overtaken.
 */
async function overtaken(ctx: CommandContext, row: AttentionItemRow, verb: 'snooze' | 'dismiss') {
  const later = [
    { at: row.openedAt, did: null, by: null },
    ...(row.state === 'snoozed' ? [{ at: row.snoozedAt, did: 'snoozed', by: row.snoozedBy }] : []),
    ...(row.state === 'dismissed'
      ? [{ at: row.dismissedAt, did: 'dismissed', by: row.dismissedBy }]
      : []),
  ]
    .filter((c) => changedSince(ctx.meta, c.at))
    .sort((a, b) => b.at!.getTime() - a.at!.getTime())[0];
  if (!later) return false;
  const who = later.by ? (await userRef(ctx.tx, later.by))?.fullName : null;
  await logLaterChange(
    ctx,
    {
      key: 'state',
      tried: `${verb} the “${ATTENTION_KIND_LABELS[row.kind as AttentionKind]}” card`,
      because: later.did
        ? `${who ? `${who} ${later.did} it` : `it was ${later.did}`} after that`
        : 'it came back with something new after that',
      changedAt: later.at,
    },
    { type: 'attention_item', id: row.id },
    { personId: row.personId, leadId: row.leadId },
  );
  return true;
}

/** An event on the item, carrying what it's about (the worker and the audit log read these). */
function emitItem(
  ctx: CommandContext,
  type: string,
  row: AttentionItemRow,
  payload: Record<string, unknown>,
  change: { before?: Record<string, unknown> | null; after?: Record<string, unknown> } = {},
): Promise<string> {
  return ctx.emit({
    type,
    entityType: 'attention_item',
    entityId: row.id,
    payload: {
      itemId: row.id,
      kind: row.kind,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      personId: row.personId,
      leadId: row.leadId,
      conversationId: row.conversationId,
      ...payload,
    },
    before: change.before ?? null,
    after: {
      item: row.title,
      kind: ATTENTION_KIND_LABELS[row.kind as AttentionKind],
      ...(change.after ?? {}),
    },
  });
}

/** A person's snooze or dismissal also stops the automatic action waiting to go out. */
const cancelWaiting = (row: AttentionItemRow, me: string, at: Date) =>
  row.autoState === 'scheduled'
    ? { autoState: 'cancelled', autoCancelledBy: me, autoDoneAt: at }
    : {};

async function update(ctx: CommandContext, row: AttentionItemRow, patch: Record<string, unknown>) {
  const [out] = await ctx.tx
    .update(attentionItems)
    .set(patch)
    .where(eq(attentionItems.id, row.id))
    .returning();
  return out!;
}

// ---------- snooze, dismiss and Undo ----------

export const attentionSnooze = defineCommand({
  name: 'attention.snooze',
  description:
    'Put an attention item out of sight until a time (up to 30 days). It comes back then, or sooner if its facts change.',
  risk: 0,
  input: AttentionSnoozeInput,
  output: AttentionItemStateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['attention.snoozed'],
  offline: 'anytime',
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const row = await loadItem(ctx, input.itemId);
    await assertMay(ctx, row, 'snooze');
    if (row.state === 'dismissed' && (await overtaken(ctx, row, 'snooze')))
      return { ...stateOut(row, false), notApplied: ['state'] };
    if (row.state !== 'open' && row.state !== 'snoozed') throw notOpen(row);
    const until = new Date(input.until);
    // Measured from when the person snoozed it ("Snooze 1 hour" pressed with no signal counts from the press).
    const at = changeMoment(ctx.meta);
    const madeAt = at.getTime();
    if (until.getTime() < madeAt + MIN)
      throw HfosError.validation([{ path: 'until', message: 'Pick a time in the future.' }]);
    if (until.getTime() > madeAt + SNOOZE_MAX_DAYS * DAY)
      throw HfosError.validation([
        { path: 'until', message: `Snooze for ${SNOOZE_MAX_DAYS} days at most.` },
      ]);
    // A snooze that ran out before it arrived has nothing left to do.
    if (until.getTime() <= Date.now()) return stateOut(row, false);
    if (await overtaken(ctx, row, 'snooze'))
      return { ...stateOut(row, false), notApplied: ['state'] };
    const out = await update(ctx, row, {
      state: 'snoozed',
      snoozedUntil: until,
      snoozedAt: at,
      snoozedBy: me,
      ...cancelWaiting(row, me, at),
    });
    await emitItem(
      ctx,
      'attention.snoozed',
      out,
      {
        until: until.toISOString(),
        previousState: row.state,
        previousUntil: iso(row.snoozedUntil),
        autoCancelled: row.autoState === 'scheduled',
      },
      {
        before: { state: row.state, snoozedUntil: iso(row.snoozedUntil) },
        after: { state: 'snoozed', snoozedUntil: until.toISOString() },
      },
    );
    return stateOut(out, true);
  },
});

export const attentionUnsnooze = defineCommand({
  name: 'attention.unsnooze',
  description:
    'Bring a snoozed attention item back now. The worker runs it when a snooze runs out (and leaves one that was snoozed again for later).',
  risk: 0,
  input: AttentionItemRefInput,
  output: AttentionItemStateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['attention.unsnoozed'],
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    const row = await loadItem(ctx, input.itemId);
    await assertMay(ctx, row, 'snooze');
    if (row.state === 'open') return stateOut(row, false);
    if (row.state !== 'snoozed') throw notOpen(row);
    // The worker's job for an earlier snooze time: someone snoozed it again since.
    if (ctx.actor.type !== 'human' && row.snoozedUntil && row.snoozedUntil.getTime() > Date.now())
      return stateOut(row, false);
    const out = await update(ctx, row, { state: 'open', ...CLEAR_SNOOZE });
    await emitItem(
      ctx,
      'attention.unsnoozed',
      out,
      { by: ctx.actor.type === 'human' ? 'person' : 'time' },
      {
        before: { state: 'snoozed', snoozedUntil: iso(row.snoozedUntil) },
        after: { state: 'open' },
      },
    );
    return stateOut(out, true);
  },
});

export const attentionDismiss = defineCommand({
  name: 'attention.dismiss',
  description:
    'Say an attention item doesn’t need doing, with an optional reason. It comes back only if its facts change.',
  risk: 0,
  input: AttentionDismissInput,
  output: AttentionItemStateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['attention.dismissed'],
  offline: 'anytime',
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const row = await loadItem(ctx, input.itemId);
    await assertMay(ctx, row, 'dismiss');
    if (row.state === 'dismissed') return stateOut(row, false);
    if (row.state !== 'open' && row.state !== 'snoozed') throw notOpen(row);
    if (await overtaken(ctx, row, 'dismiss'))
      return { ...stateOut(row, false), notApplied: ['state'] };
    const reason = input.reason?.trim() || null;
    const at = changeMoment(ctx.meta);
    const out = await update(ctx, row, {
      state: 'dismissed',
      dismissedAt: at,
      dismissedBy: me,
      dismissReason: reason,
      ...CLEAR_SNOOZE,
      ...cancelWaiting(row, me, at),
    });
    await emitItem(
      ctx,
      'attention.dismissed',
      out,
      {
        reason,
        previousState: row.state,
        previousUntil: iso(row.snoozedUntil),
        autoCancelled: row.autoState === 'scheduled',
      },
      { before: { state: row.state }, after: { state: 'dismissed', reason } },
    );
    return stateOut(out, true);
  },
});

export const attentionRestore = defineCommand({
  name: 'attention.restore',
  description: 'Undo a snooze or a dismissal: the item is open again.',
  risk: 0,
  input: AttentionItemRefInput,
  output: AttentionItemStateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['attention.restored'],
  offline: 'anytime',
  async handler(ctx, input) {
    requireHuman(ctx);
    const row = await loadItem(ctx, input.itemId);
    await assertMay(ctx, row, row.state === 'dismissed' ? 'dismiss' : 'snooze');
    if (row.state === 'open') return stateOut(row, false);
    if (row.state !== 'snoozed' && row.state !== 'dismissed')
      throw HfosError.rule(
        'attention_not_restorable',
        409,
        row.state === 'resolved'
          ? 'This was already taken care of.'
          : 'This was already handled, so there’s nothing to bring back.',
      );
    const out = await update(ctx, row, { state: 'open', ...CLEAR_SNOOZE, ...CLEAR_DISMISS });
    await emitItem(
      ctx,
      'attention.restored',
      out,
      { from: row.state },
      { before: { state: row.state }, after: { state: 'open' } },
    );
    return stateOut(out, true);
  },
});

// ---------- assign ----------

export const attentionAssign = defineCommand({
  name: 'attention.assign',
  description:
    'Give an attention item to a teammate, or leave it for anyone. For a lead, a conversation or a task it changes who owns that record; an appointment’s or an approval’s item is assigned on its own.',
  risk: 1,
  input: AttentionAssignInput,
  output: AttentionAssignOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['attention.assigned'],
  offline: 'anytime',
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const row = await loadItem(ctx, input.itemId);
    await assertMay(ctx, row, 'assign');
    if (row.state === 'resolved') throw notOpen(row);
    const to = input.assigneeUserId;
    if (to && !(await isWorkspaceUser(ctx.tx, ws, to)))
      throw HfosError.validation([
        {
          path: 'assigneeUserId',
          message: 'That person isn’t on this business’s team. Pick someone else.',
        },
      ]);
    const kind = row.kind as AttentionKind;
    const passedTo = isLeadKind(kind)
      ? ('lead' as const)
      : kind === 'customer_waiting'
        ? ('conversation' as const)
        : kind === 'overdue_task'
          ? ('task' as const)
          : null;
    const previous = row.assigneeUserId;
    if (previous === to)
      return {
        itemId: row.id,
        assigneeUserId: to,
        previousAssigneeUserId: previous,
        passedTo,
        changed: false,
      };
    // The real owner changes through its own command, as this person (its rules, events and audit).
    if (passedTo === 'lead')
      await executeCommandWithin(ctx, leadUpdate, {
        workspaceId: ws,
        leadId: row.subjectId,
        assigneeUserId: to,
      });
    else if (passedTo === 'conversation')
      await executeCommandWithin(ctx, conversationAssign, {
        workspaceId: ws,
        conversationId: row.subjectId,
        assigneeUserId: to,
      });
    else if (passedTo === 'task')
      await executeCommandWithin(ctx, taskUpdate, {
        workspaceId: ws,
        taskId: row.subjectId,
        assigneeUserId: to,
      });
    const out = await update(ctx, row, { assigneeUserId: to });
    const [before, after] = await Promise.all([userRef(ctx.tx, previous), userRef(ctx.tx, to)]);
    await emitItem(
      ctx,
      'attention.assigned',
      out,
      { assigneeUserId: to, previousAssigneeUserId: previous, passedTo },
      {
        before: { assignee: before?.fullName ?? null },
        after: { assignee: after?.fullName ?? null },
      },
    );
    return {
      itemId: row.id,
      assigneeUserId: to,
      previousAssigneeUserId: previous,
      passedTo,
      changed: true,
    };
  },
});

// ---------- Let HandsFreeOS Handle ----------

export const attentionLetHandle = defineCommand({
  name: 'attention.let_handle',
  description:
    'Let HandsFreeOS handle an attention item. A confirmation request or a follow-up nudge is queued (it goes after a short cancel window); for anything else, pick what to do (hand the conversation to the AI teammate, reply, or set the next action) and it’s done in your name.',
  risk: 2,
  input: AttentionLetHandleInput,
  output: AttentionLetHandleOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['attention.handle_requested', 'attention.handled'],
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const row = await loadItem(ctx, input.itemId);
    await assertMay(ctx, row, 'let_handle');
    if (row.state !== 'open' && row.state !== 'snoozed') throw notOpen(row);
    const kind = row.kind as AttentionKind;
    const reasons = chipsOf(row);
    const mode = letHandleModeOf(kind, reasons);
    if (mode === 'none')
      throw HfosError.rule(
        'let_handle_not_offered',
        409,
        letHandleRefusal(kind) ??
          'HandsFreeOS doesn’t handle this kind of item. Open it to take care of it.',
      );

    if (mode === 'auto') {
      const action = autoActionOf(kind, reasons)!;
      if (input.action)
        throw HfosError.validation([
          {
            path: 'action',
            message: 'HandsFreeOS handles this one on its own. Leave out the action.',
          },
        ]);
      const result = {
        itemId: row.id,
        mode: 'auto' as const,
        action,
        state: row.state,
        conversationId: null,
        messageId: null,
      };
      if (row.autoState === 'scheduled')
        return {
          ...result,
          status: 'already_scheduled' as const,
          scheduledFor: iso(row.autoScheduledFor),
        };
      const plan = await planAutoAction(
        ctx.tx,
        await loadAttentionContext(ctx.tx, ws),
        row,
        new Date(),
      );
      if (plan?.blocked)
        throw new HfosError(
          'rule_violation',
          409,
          plan.blocked.message,
          { reason: plan.blocked.code },
          plan.blocked.code,
        );
      await emitItem(ctx, 'attention.handle_requested', row, {
        action,
        fingerprint: row.fingerprint,
        requestedBy: me,
        channel: plan?.channel ?? null,
        sendAt: plan?.sendAt ?? null,
      });
      return { ...result, status: 'requested' as const, scheduledFor: null };
    }

    // Ask first: the person's own choice, carried out as them.
    const allowed = ASK_ACTIONS[kind] ?? [];
    if (!input.action)
      throw HfosError.validation([{ path: 'action', message: 'Pick what HandsFreeOS should do.' }]);
    if (!allowed.includes(input.action))
      throw HfosError.validation([
        { path: 'action', message: 'That isn’t one of the choices for this item.' },
      ]);
    let conversationId: string | null = null;
    let messageId: string | null = null;
    switch (input.action) {
      case 'hand_to_ai': {
        const conv = await conversationForItem(ctx.tx, ws, row);
        if (!conv)
          throw HfosError.rule(
            'no_conversation',
            409,
            'There’s no conversation with them yet. Reply to start one.',
          );
        await executeCommandWithin(ctx, conversationHandToAi, {
          workspaceId: ws,
          conversationId: conv.id,
        });
        conversationId = conv.id;
        break;
      }
      case 'reply': {
        if (!input.body)
          throw HfosError.validation([{ path: 'body', message: 'Write a message.' }]);
        const conv = await conversationForItem(ctx.tx, ws, row);
        const channel = input.channel ?? conv?.channel ?? 'sms';
        const to =
          conv && conv.channel === channel
            ? { conversationId: conv.id }
            : row.personId &&
                channel !== 'chat' &&
                channel !== 'portal' &&
                !isSocialChannel(channel)
              ? { personId: row.personId }
              : null;
        if (!to)
          throw HfosError.rule(
            'no_contact',
            409,
            channel === 'chat'
              ? 'There’s no website chat with them to reply in. Reply by text or email instead.'
              : channel === 'portal'
                ? 'There’s no portal thread with them to reply in. Reply by text or email instead.'
                : isSocialChannel(channel)
                  ? `There’s no ${SOCIAL_CHANNEL_NAMES[channel]} thread with them to reply in. Reply by text or email instead.`
                  : conv
                    ? `There’s no customer on this item to reach by ${channel === 'email' ? 'email' : 'text'}. Reply by ${conv.channel === 'email' ? 'email' : conv.channel === 'chat' ? 'website chat' : conv.channel === 'portal' ? 'their portal' : isSocialChannel(conv.channel) ? SOCIAL_CHANNEL_NAMES[conv.channel] : 'text'} instead, where they wrote.`
                    : 'There’s no customer on this item to send a message to. Open it to see who it’s about.',
          );
        const sent = await executeCommandWithin(ctx, messageSend, {
          workspaceId: ws,
          ...to,
          channel,
          body: input.body,
          ...(input.subject ? { subject: input.subject } : {}),
          acknowledgeQuietHours: input.acknowledgeQuietHours,
        });
        conversationId = sent.output.conversationId;
        messageId = sent.output.messageId;
        break;
      }
      case 'set_next_action': {
        if (!row.leadId)
          throw HfosError.rule(
            'no_lead',
            409,
            'This item has no lead to set a next action on. Pick another way to handle it.',
          );
        if (!input.text)
          throw HfosError.validation([{ path: 'text', message: 'Say what to do next.' }]);
        await executeCommandWithin(ctx, leadSetNextAction, {
          workspaceId: ws,
          leadId: row.leadId,
          text: input.text,
          dueAt: input.dueAt ?? null,
        });
        break;
      }
    }
    const out = await update(ctx, row, {
      state: 'handled',
      handledAt: changeMoment(ctx.meta),
      handledBy: me,
      handledVia: 'let_handle',
      // Money is the one kind a follow-up doesn't settle: the invoice is still owed and the estimate still
      // unanswered, so its card rests a week rather than for good. `handled_until` is the worker's column
      // (0039's guard is explicit about it), and the worker sets it when it sees this item handled.
      ...CLEAR_SNOOZE,
    });
    await emitItem(
      ctx,
      'attention.handled',
      out,
      { via: 'let_handle', action: input.action, conversationId, messageId },
      { before: { state: row.state }, after: { state: 'handled', action: input.action } },
    );
    return {
      itemId: row.id,
      mode: 'ask' as const,
      action: input.action,
      status: 'done' as const,
      state: out.state,
      scheduledFor: null,
      conversationId,
      messageId,
    };
  },
});

export const attentionCancelAuto = defineCommand({
  name: 'attention.cancel_auto',
  description:
    'Stop an automatic message (a confirmation request or a follow-up nudge) that is waiting to go out.',
  risk: 0,
  input: AttentionItemRefInput,
  output: AttentionCancelAutoOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['attention.auto_cancelled'],
  offline: 'anytime',
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const row = await loadItem(ctx, input.itemId);
    await assertMay(ctx, row, 'snooze');
    if (row.autoState === 'cancelled')
      return { itemId: row.id, autoState: 'cancelled' as const, changed: false };
    if (row.autoState === 'sent')
      throw HfosError.rule(
        'auto_already_sent',
        409,
        'That message already went out, so it can’t be stopped.',
      );
    if (row.autoState !== 'scheduled')
      throw HfosError.rule('auto_not_scheduled', 409, 'Nothing is waiting to go out for this.');
    const out = await update(ctx, row, {
      autoState: 'cancelled',
      autoCancelledBy: me,
      autoDoneAt: changeMoment(ctx.meta),
    });
    await emitItem(
      ctx,
      'attention.auto_cancelled',
      out,
      {
        action: autoActionOf(row.kind as AttentionKind, chipsOf(row)),
        scheduledFor: iso(row.autoScheduledFor),
      },
      { before: { autoState: 'scheduled' }, after: { autoState: 'cancelled' } },
    );
    return { itemId: row.id, autoState: 'cancelled' as const, changed: true };
  },
});

// ---------- settings ----------

const hostOf = (u: string): string => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).host;
  } catch {
    return '';
  }
};

/** The business's own name, number, addresses and sites: the only ones a nudge may give. */
export async function nudgeCheckContext(
  ctx: CommandContext,
  businessName: string,
): Promise<NudgeCheckContext> {
  const ws = ctx.scope.workspaceId!;
  const number = await defaultNumber(ctx.tx, ws);
  const addresses = await workspaceAddresses(ctx.tx, ws);
  const [w] = await rows<{ origins: string[] | null }>(
    ctx.tx,
    sql`select array_agg(o) as origins from app.chat_widgets cw, unnest(cw.allowed_origins) o
        where cw.workspace_id = ${ws}`,
  );
  const domains = [...(w?.origins ?? []).map(hostOf), ...addresses.map((a) => a.domain)].filter(
    Boolean,
  );
  return {
    businessName,
    businessPhone: number ? formatPhone(number.e164) : null,
    allowed: {
      domains: [...new Set(domains)],
      urlPrefixes: [],
      phones: number ? [number.e164] : [],
      emails: addresses.map((a) => a.address),
    },
  };
}

export const attentionSaveSettings = defineCommand({
  name: 'attention.save_settings',
  description:
    'Save the Action Center’s settings: which kinds are on, thresholds, the typical job value, stale days per stage, the automatic switches, the follow-up message and replying C to confirm. Turning nudges on (“Looks good, turn on”) records that the message was read.',
  risk: 2,
  input: AttentionSaveSettingsInput,
  output: AttentionSaveSettingsOutput,
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: ['attention.settings_saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const [w] = await ctx.tx
      .select({ name: workspaces.name, settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    if (!w)
      throw HfosError.notFound(
        'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
      );
    const stored = (w.settings ?? {}) as Record<string, unknown>;
    const current = attentionSettingsOf(stored);
    // "Looks good, turn on": the first review stands, on the server's clock.
    const reviewed =
      input.settings.auto.nudgeReviewedAt === null
        ? null
        : (current.auto.nudgeReviewedAt ?? new Date().toISOString());
    const next: AttentionSettings = {
      ...input.settings,
      auto: { ...input.settings.auto, nudgeReviewedAt: reviewed },
    };
    // A nudge gives only the business's own links and numbers, never an amount (the schema checks the slots).
    const check = checkNudgeTemplate(next.nudge.template, await nudgeCheckContext(ctx, w.name));
    if (!check.ok)
      throw HfosError.validation(
        check.problems.map((p) => ({ path: 'settings.nudge.template', message: p.message })),
        check.problems[0]?.code === 'empty'
          ? 'The follow-up message is empty. Write it, then save.'
          : check.problems.length === 1
            ? `The follow-up message needs a change. ${check.problems[0]!.message}`
            : 'The follow-up message needs a few changes. Fix what’s marked under it, then save.',
      );
    const changed = JSON.stringify(stored['attention'] ?? null) !== JSON.stringify(next);
    if (!changed) return { workspaceId: ws, settings: next, changed: false };
    const [row] = await ctx.tx
      .update(workspaces)
      .set({ settings: { ...stored, attention: next } })
      .where(eq(workspaces.id, ws))
      .returning({ id: workspaces.id });
    if (!row) throw HfosError.forbidden();
    const fields = (Object.keys(next) as (keyof AttentionSettings)[]).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]),
    );
    await ctx.emit({
      type: 'attention.settings_saved',
      entityType: 'workspace',
      entityId: ws,
      payload: {
        fields,
        nudgesTurnedOn: next.auto.nudges && !current.auto.nudges,
        nudgeReviewed: !current.auto.nudgeReviewedAt && !!reviewed,
      },
      before: { attention: current },
      after: { attention: next },
    });
    return { workspaceId: ws, settings: next, changed: true };
  },
});

// ---------- what HandsFreeOS did on its own ----------

export const attentionRecordAuto = defineCommand({
  name: 'attention.record_auto',
  description:
    'Worker: records an automatic action for an attention item: scheduled (after the cancel window), sent (the item is handled), or skipped and why.',
  risk: 1,
  input: AttentionRecordAutoInput,
  output: AttentionRecordAutoOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['attention.auto_scheduled', 'attention.auto_sent', 'attention.auto_skipped'],
  actors: ['system'],
  async handler(ctx, input) {
    const row = await loadItem(ctx, input.itemId);
    const kind = row.kind as AttentionKind;
    if (!AUTO_KINDS[kind])
      throw HfosError.rule('auto_not_offered', 409, 'This kind of item has no automatic action.');
    const same = (changed: boolean, r: AttentionItemRow = row) => ({
      itemId: r.id,
      state: r.state,
      autoState: (r.autoState as 'scheduled' | 'sent' | 'skipped' | 'cancelled' | null) ?? null,
      changed,
    });
    const alreadySent = () => HfosError.rule('auto_already_sent', 409, 'It already went out.');
    const now = new Date();
    switch (input.outcome) {
      case 'scheduled': {
        if (input.fingerprint && input.fingerprint !== row.fingerprint)
          throw HfosError.rule(
            'attention_facts_changed',
            409,
            'The facts behind this item changed since it was planned.',
          );
        if (row.autoState === 'sent') throw alreadySent();
        if (row.state !== 'open') throw notOpen(row);
        const at = new Date(input.scheduledFor!);
        if (row.autoState === 'scheduled' && row.autoScheduledFor?.getTime() === at.getTime())
          return same(false);
        const out = await update(ctx, row, {
          autoState: 'scheduled',
          autoScheduledFor: at,
          autoDoneAt: null,
          autoSkipReason: null,
          autoCancelledBy: null,
        });
        await emitItem(
          ctx,
          'attention.auto_scheduled',
          out,
          {
            action: input.action,
            scheduledFor: at.toISOString(),
            requestedBy: input.requestedBy ?? null,
          },
          { after: { autoState: 'scheduled', scheduledFor: at.toISOString() } },
        );
        return same(true, out);
      }
      case 'sent': {
        if (row.autoState === 'sent') return same(false);
        const by = input.requestedBy ?? null;
        const out = await update(ctx, row, {
          autoState: 'sent',
          autoScheduledFor: row.autoScheduledFor ?? now,
          autoDoneAt: now,
          autoSkipReason: null,
          autoCancelledBy: null,
          state: 'handled',
          handledAt: now,
          handledVia: by ? 'let_handle' : 'auto',
          handledBy: by,
          handledUntil: input.handledUntil ? new Date(input.handledUntil) : null,
          resolvedAt: null,
          resolution: null,
          ...CLEAR_SNOOZE,
          ...CLEAR_DISMISS,
        });
        await emitItem(
          ctx,
          'attention.auto_sent',
          out,
          {
            action: input.action,
            channel: input.channel ?? null,
            messageId: input.messageId ?? null,
            requestedBy: by,
          },
          {
            before: { state: row.state },
            after: { state: 'handled', channel: input.channel ?? null },
          },
        );
        return same(true, out);
      }
      case 'skipped': {
        if (row.autoState === 'sent') throw alreadySent();
        if (row.autoState === 'skipped' && row.autoSkipReason === input.reason) return same(false);
        const out = await update(ctx, row, {
          autoState: 'skipped',
          autoSkipReason: input.reason!,
          autoDoneAt: now,
          autoCancelledBy: null,
        });
        await emitItem(
          ctx,
          'attention.auto_skipped',
          out,
          { action: input.action, reason: input.reason },
          { after: { autoState: 'skipped', reason: input.reason } },
        );
        return same(true, out);
      }
    }
  },
});
