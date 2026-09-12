import { and, eq, lte, or, isNull } from 'drizzle-orm';
import { sql } from '@hfos/db/client';
import { activities, calls, conversations, phoneNumbers } from '@hfos/db/schema';
import { logChannelActivity } from '../crm/activities';
import { formatPhone } from '../crm/phone';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  findOrCreateConversation,
  liveNumber,
  loadConversation,
  matchPersonByPhone,
} from '../messaging/store';
import {
  CallAttachRecordingInput,
  CallAttachTranscriptInput,
  CallRecordInput,
  CallRecordOutput,
  CallRefOutput,
  CallStartInput,
  CallStartOutput,
  CallUpdateStatusInput,
  CallUpdateStatusOutput,
  type CallStatus,
} from '../schemas/call';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type Call = typeof calls.$inferSelect;
const FINAL: ReadonlySet<CallStatus> = new Set([
  'completed',
  'no_answer',
  'busy',
  'failed',
  'canceled',
]);
/** Mirrors private.call_status_rank: statuses only move forward. */
const rank = (s: CallStatus) =>
  s === 'initiated' ? 0 : s === 'ringing' ? 1 : s === 'in_progress' ? 2 : 3;
const clock = (seconds: number | null | undefined) => {
  const s = Math.max(0, seconds ?? 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** What the conversation list says about a call. */
export function callPreview(c: {
  direction: 'inbound' | 'outbound';
  answeredAt: Date | null;
  durationSeconds: number | null;
  isVoicemail: boolean;
  recordingSeconds: number | null;
  transcript: string | null;
}): string {
  if (c.isVoicemail) {
    const base = `Voicemail, ${clock(c.recordingSeconds)}`;
    return c.transcript ? `${base}: “${c.transcript.slice(0, 120)}”` : base;
  }
  if (c.answeredAt) return `Call · ${clock(c.durationSeconds)}`;
  return c.direction === 'inbound' ? 'Missed call' : 'Call not answered';
}

async function loadCall(
  ctx: CommandContext,
  ref: { callId?: string | undefined; providerSid?: string | undefined },
): Promise<Call> {
  const workspaceId = ctx.scope.workspaceId!;
  const [c] = await ctx.tx
    .select()
    .from(calls)
    .where(
      and(
        eq(calls.workspaceId, workspaceId),
        ref.callId ? eq(calls.id, ref.callId) : eq(calls.providerSid, ref.providerSid!),
      ),
    );
  // A status callback can beat the record of the call itself; the worker retries on not-found.
  if (!c) throw HfosError.notFound('Call not found.');
  return c;
}

/** The customer's side of the call: who we talked to (or missed), for sentences and the conversation. */
const counterpartOf = (c: Pick<Call, 'direction' | 'fromE164' | 'toE164'>) =>
  (c.direction === 'inbound' ? c.fromE164 : c.toE164) ?? '';

export const callStart = defineCommand({
  name: 'call.start',
  description:
    'Call a customer from the browser. Returns what the browser dials with; customers see the business number.',
  risk: 1,
  input: CallStartInput,
  output: CallStartOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['call.started'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const number = await liveNumber(ctx.tx, workspaceId);
    if (!number || number.status !== 'active')
      throw HfosError.rule('no_number', 409, 'Get a business number to call customers.');

    let to: string;
    let personId: string | null;
    let conversationId: string | null = null;
    if (input.conversationId) {
      const c = await loadConversation(ctx, input.conversationId);
      if (c.channel !== 'sms')
        throw HfosError.rule(
          'channel_mismatch',
          400,
          'This conversation is email. Call the customer from their page.',
        );
      to = c.counterpart;
      personId = c.personId;
      conversationId = c.id;
    } else if (input.personId) {
      const p = await requirePerson(ctx.tx, workspaceId, input.personId);
      if (p.archivedAt)
        throw HfosError.rule('person_archived', 409, 'Restore this customer before calling them.');
      if (!p.phoneE164)
        throw HfosError.rule('no_phone', 400, 'Add a phone number to call this customer.');
      to = p.phoneE164;
      personId = p.id;
    } else {
      to = input.toPhone!;
      personId = await matchPersonByPhone(ctx.tx, workspaceId, to);
    }
    if (to === number.e164)
      throw HfosError.rule('own_number', 400, 'That is the business number itself.');
    if (!conversationId) {
      const { conversation } = await findOrCreateConversation(ctx, {
        channel: 'sms',
        counterpart: to,
        personId,
        phoneNumberId: number.id,
      });
      conversationId = conversation.id;
    }
    const [row] = await ctx.tx
      .insert(calls)
      .values({
        workspaceId,
        conversationId,
        phoneNumberId: number.id,
        personId,
        direction: 'outbound',
        fromE164: number.e164,
        toE164: to,
        status: 'initiated',
        placedBy: me,
      })
      .returning({ id: calls.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'call.started',
      entityType: 'call',
      entityId: row.id,
      payload: { conversationId, personId, direction: 'outbound' },
      after: { to: formatPhone(to) },
    });
    return { callId: row.id, conversationId, to, params: { To: to, CallId: row.id } };
  },
});

export const callRecord = defineCommand({
  name: 'call.record',
  description:
    'Worker: a customer called the business number, or a call placed from the browser connected. Files it in the customer’s conversation.',
  risk: 1,
  input: CallRecordInput,
  output: CallRecordOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['call.received'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const existing = async () =>
      (
        await ctx.tx
          .select({ id: calls.id, conversationId: calls.conversationId })
          .from(calls)
          .where(and(eq(calls.workspaceId, workspaceId), eq(calls.providerSid, input.providerSid)))
      )[0];
    const dup = await existing();
    if (dup) return { callId: dup.id, conversationId: dup.conversationId, duplicate: true };

    if (input.callId) {
      const c = await loadCall(ctx, { callId: input.callId });
      await ctx.tx
        .update(calls)
        .set({ providerSid: input.providerSid, status: input.status })
        .where(eq(calls.id, c.id));
      return { callId: c.id, conversationId: c.conversationId, duplicate: false };
    }

    const customer = input.direction === 'inbound' ? input.from : input.to;
    const ours = input.direction === 'inbound' ? input.to : input.from;
    const [n] = await ctx.tx
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.e164, ours)))
      .limit(1);
    const matched = await matchPersonByPhone(ctx.tx, workspaceId, customer);
    const { conversation } = await findOrCreateConversation(ctx, {
      channel: 'sms',
      counterpart: customer,
      personId: matched,
      phoneNumberId: n?.id ?? null,
    });
    const personId = conversation.personId ?? matched;
    const [row] = await ctx.tx
      .insert(calls)
      .values({
        workspaceId,
        conversationId: conversation.id,
        phoneNumberId: n?.id ?? null,
        personId,
        direction: input.direction,
        fromE164: input.from,
        toE164: input.to,
        providerSid: input.providerSid,
        status: input.status,
        startedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: calls.id });
    if (!row) {
      const raced = await existing();
      if (!raced) throw HfosError.forbidden();
      return { callId: raced.id, conversationId: raced.conversationId, duplicate: true };
    }
    if (input.direction === 'inbound')
      await ctx.emit({
        type: 'call.received',
        entityType: 'call',
        entityId: row.id,
        payload: { conversationId: conversation.id, personId },
        after: { from: formatPhone(input.from) },
      });
    return { callId: row.id, conversationId: conversation.id, duplicate: false };
  },
});

/** An ended call lands on the timeline and in the conversation's preview; a missed inbound call waits for a reply. */
async function settleCall(ctx: CommandContext, c: Call, at: Date): Promise<void> {
  const answered = !!c.answeredAt;
  const subtype =
    c.direction === 'outbound'
      ? answered
        ? 'outbound'
        : 'outbound_missed'
      : c.isVoicemail
        ? 'voicemail'
        : answered
          ? 'answered'
          : 'missed';
  const preview = callPreview(c);
  const eventId = await ctx.emit({
    type: answered ? 'call.completed' : 'call.missed',
    entityType: 'call',
    entityId: c.id,
    payload: {
      conversationId: c.conversationId,
      personId: c.personId,
      direction: c.direction,
      durationSeconds: c.durationSeconds,
      answeredVia: c.answeredVia,
    },
    after: {
      with: formatPhone(counterpartOf(c)),
      direction: c.direction,
      ...(answered ? { duration: clock(c.durationSeconds) } : {}),
    },
  });
  if (!c.activityId) {
    const activityId = await logChannelActivity(ctx, {
      kind: 'call',
      subtype,
      personId: c.personId,
      body: c.transcript,
      occurredAt: c.startedAt,
      eventId,
      // A call a teammate placed reads "Dale Ramsey called" on the customer's timeline.
      authorUserId: c.direction === 'outbound' ? c.placedBy : null,
      meta: {
        direction: c.direction,
        callId: c.id,
        conversationId: c.conversationId,
        status: c.status,
        durationSeconds: c.durationSeconds,
        answeredVia: c.answeredVia,
        answeredByUserId: c.answeredByUserId,
        placedBy: c.placedBy,
        voicemail: c.isVoicemail,
        recordingSeconds: c.recordingSeconds,
        recordingPath: c.recordingObjectPath,
      },
    });
    if (activityId) await ctx.tx.update(calls).set({ activityId }).where(eq(calls.id, c.id));
  }
  if (!c.conversationId) return;
  const needsReply = c.direction === 'inbound' && !answered;
  await ctx.tx
    .update(conversations)
    .set({
      lastMessageAt: at,
      lastPreview: preview,
      lastDirection: c.direction,
      ...(c.direction === 'inbound' ? { lastInboundAt: at } : { lastOutboundAt: at }),
      ...(needsReply
        ? {
            unreadCount: sql`${conversations.unreadCount} + 1`,
            status: 'open' as const,
            snoozedUntil: null,
            closedAt: null,
            closedBy: null,
            awaitingReplySince: sql`coalesce(${conversations.awaitingReplySince}, ${at.toISOString()}::timestamptz)`,
          }
        : { awaitingReplySince: null }),
    })
    .where(eq(conversations.id, c.conversationId));
}

export const callUpdateStatus = defineCommand({
  name: 'call.update_status',
  description:
    'Worker: a call rang, was answered or ended. Statuses move forward only; an ended call lands on the timeline.',
  risk: 0,
  input: CallUpdateStatusInput,
  output: CallUpdateStatusOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['call.completed', 'call.missed'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadCall(ctx, input);
    // An ended call is settled: the parent call's own "completed" (or a leg that lost the race) arrives after
    // the leg that carried the conversation, and must not change the status or the length.
    if (FINAL.has(c.status)) return { callId: c.id, status: c.status, changed: false };
    const at = input.at ? new Date(input.at) : new Date();
    const patch: Partial<typeof calls.$inferInsert> = {};
    if (rank(input.status) > rank(c.status)) patch.status = input.status;
    if (input.answeredVia) patch.answeredVia = input.answeredVia;
    if (input.answeredByUserId !== undefined) patch.answeredByUserId = input.answeredByUserId;
    if (input.answeredNumber !== undefined) patch.answeredNumber = input.answeredNumber;
    // Twilio marks a call in progress as soon as it runs our instructions, before anyone picks up, so only
    // an explicit "who answered" (a browser, a forwarding phone, or the customer we dialed) counts.
    if ((input.answeredVia || input.answeredNumber) && !c.answeredAt) patch.answeredAt = at;
    if (input.durationSeconds !== undefined) patch.durationSeconds = input.durationSeconds;
    const ending = FINAL.has(input.status) && !FINAL.has(c.status);
    if (ending) patch.endedAt = at;
    if (Object.keys(patch).length === 0) return { callId: c.id, status: c.status, changed: false };
    await ctx.tx.update(calls).set(patch).where(eq(calls.id, c.id));
    const next = { ...c, ...patch } as Call;
    if (ending) await settleCall(ctx, next, at);
    return { callId: c.id, status: next.status, changed: true };
  },
});

/** Keep the preview in step with the call unless someone wrote since it ended. */
async function refreshPreview(ctx: CommandContext, c: Call): Promise<void> {
  if (!c.conversationId || !c.endedAt) return;
  await ctx.tx
    .update(conversations)
    .set({ lastPreview: callPreview(c) })
    .where(
      and(
        eq(conversations.id, c.conversationId),
        or(isNull(conversations.lastMessageAt), lte(conversations.lastMessageAt, c.endedAt)),
      ),
    );
}

export const callAttachRecording = defineCommand({
  name: 'call.attach_recording',
  description:
    'Worker: the voicemail a caller left is stored. It shows in the thread and on the timeline.',
  risk: 0,
  input: CallAttachRecordingInput,
  output: CallRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['call.voicemail_left'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadCall(ctx, input);
    const patch = {
      recordingSid: input.recordingSid,
      recordingObjectPath: input.objectPath,
      recordingSeconds: input.seconds,
      isVoicemail: input.voicemail || c.isVoicemail,
    };
    await ctx.tx.update(calls).set(patch).where(eq(calls.id, c.id));
    const next = { ...c, ...patch };
    if (c.activityId)
      await ctx.tx
        .update(activities)
        .set({
          ...(next.isVoicemail ? { subtype: 'voicemail' } : {}),
          meta: sql`${activities.meta} || ${JSON.stringify({ voicemail: next.isVoicemail, recordingSeconds: input.seconds, recordingPath: input.objectPath })}::jsonb`,
        })
        .where(eq(activities.id, c.activityId));
    await refreshPreview(ctx, next);
    if (next.isVoicemail)
      await ctx.emit({
        type: 'call.voicemail_left',
        entityType: 'call',
        entityId: c.id,
        payload: { conversationId: c.conversationId, personId: c.personId, seconds: input.seconds },
        after: { with: formatPhone(counterpartOf(c)), seconds: input.seconds },
      });
    return { callId: c.id };
  },
});

export const callAttachTranscript = defineCommand({
  name: 'call.attach_transcript',
  description:
    'Worker: a voicemail was transcribed. The words show under the recording and in the inbox.',
  risk: 0,
  input: CallAttachTranscriptInput,
  output: CallRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['call.transcribed'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadCall(ctx, input);
    const transcript = input.status === 'completed' ? input.transcript || null : null;
    await ctx.tx
      .update(calls)
      .set({ transcript, transcriptStatus: input.status })
      .where(eq(calls.id, c.id));
    const next = { ...c, transcript };
    if (c.activityId && transcript)
      await ctx.tx
        .update(activities)
        .set({ body: transcript })
        .where(eq(activities.id, c.activityId));
    await refreshPreview(ctx, next);
    await ctx.emit({
      type: 'call.transcribed',
      entityType: 'call',
      entityId: c.id,
      payload: { conversationId: c.conversationId, status: input.status },
      after: { with: formatPhone(counterpartOf(c)), status: input.status },
      broadcast: !!transcript,
    });
    return { callId: c.id };
  },
});
