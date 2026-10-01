import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import {
  activities,
  aiTeammateRuns,
  appointmentAttendees,
  conversations,
  files,
  messages,
  optOuts,
  people,
  phoneNumbers,
  type ButtonReply,
  type MediaRef,
  type RichText,
} from '@hfos/db/schema';
import { optOutPhrase } from '../ai-team/guardrails';
import { chatIdentityUnverified, notHandledByAi, outsideItsConversation } from '../ai-team/reach';
import { attentionSettingsOf } from '../attention/settings';
import { requireAppointment } from '../calendar/appointments';
import { workspaceZone } from '../calendar/load';
import { logChannelActivity } from '../crm/activities';
import { intakeFromChannel, isOwnNumber, notALead, type IntakeResult } from '../crm/intake';
import { formatBytes } from '../crm/format';
import { formatPhone } from '../crm/phone';
import { fullName, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { FRESH_MINUTES } from '../mobile';
import { aiEmployeeOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { AiEmployeeActor, CommandContext } from '../kernel/types';
import {
  activeSuppression,
  emailAttachments,
  emailDedupeKey,
  emailPreview,
  newMessageIdHeader,
  pickFromAddress,
  replySubject,
  resolveEmailConversation,
  sendableAddresses,
  sendableMailboxes,
  SHARED_MAIL_DOMAIN,
  suppressionMessage,
  threadHeaders,
  workspaceAddresses,
} from '../messaging/email';
import { claimOnReply, personTakesOver, takeOver } from '../messaging/handling';
import {
  CANCELLED_TEXT,
  formatClock,
  QUIET_FIRST_MESSAGE_WINDOW_MS,
  QUIET_FOLLOW_UP_WINDOW_MS,
  QUIET_REPLY_LIMIT,
  QUIET_REPLY_WINDOW_MS,
  quietHoursEndAt,
  quietHoursState,
  quietPeriodStart,
  SCHEDULED_TEXT,
  scheduledForOf,
  type QuietHoursState,
} from '../messaging/quiet-hours';
import { assertWalletHasRoom } from '../money/wallet-gate';
import {
  buildRichText,
  buttonForTap,
  buttonReplyOf,
  choiceForText,
  RCS_LIMITS,
  replyChoices,
} from '../messaging/rcs';
import { confirmWord, messagePreview, smsKeyword, smsSegments, yesWord } from '../messaging/sms';
import {
  findOrCreateConversation,
  isOptedOut,
  conversationNumber,
  defaultNumber,
  latestConversation,
  loadConversation,
  loadRegistrations,
  matchPersonByPhone,
  preferredLane,
  rcsLine,
  readiness,
  scheduleJob,
  workspaceMessaging,
  type WorkspaceMessaging,
} from '../messaging/store';
import {
  MessageAttachMediaInput,
  MessageAttachMediaOutput,
  MessageCancelScheduledInput,
  MessageCancelScheduledOutput,
  MessageReceiveInput,
  MessageReceiveOutput,
  MessageRecordOptOutInput,
  MessageRecordOptOutOutput,
  MessageReleaseScheduledInput,
  MessageReleaseScheduledOutput,
  MessageRetryInput,
  MessageRetryOutput,
  MessageSendInput,
  MessageSendOutput,
  MessageUpdateStatusInput,
  MessageUpdateStatusOutput,
  PersonSetSmsConsentInput,
  PersonSetSmsConsentOutput,
} from '../schemas/message';
import type { RichInput } from '../schemas/rcs';
import { announceConfirmed } from './attendee-confirm';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Types every US carrier delivers as a picture message, and the total size they accept. */
const MMS_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
const MMS_MAX_BYTES = 5 * 1024 * 1024;
/** Twilio: the recipient replied STOP to this sender. */
const UNSUBSCRIBED_ERROR = '21610';

/** private.message_status_rank (0103), for the one decision made here rather than in the database. */
const STATUS_RANK: Readonly<Record<string, number>> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  undelivered: 5,
  failed: 5,
  bounced: 6,
  complained: 7,
};
const statusRank = (status: string): number => STATUS_RANK[status] ?? 0;

type Conversation = typeof conversations.$inferSelect;

/** What a thread is, in a sentence: "a text thread", "a client’s portal thread". */
const THREAD_WORDS: Readonly<Record<Conversation['channel'], string>> = {
  sms: 'a text thread',
  email: 'an email thread',
  chat: 'a website chat',
  portal: 'a client’s portal thread',
};

async function resolveSmsConversation(
  ctx: CommandContext,
  input: { conversationId?: string; personId?: string; toPhone?: string },
): Promise<{ conversation: Conversation; created: boolean }> {
  const workspaceId = ctx.scope.workspaceId!;
  if (input.conversationId) {
    const c = await loadConversation(ctx, input.conversationId);
    if (c.channel !== 'sms')
      throw HfosError.rule(
        'channel_mismatch',
        400,
        `This conversation is ${THREAD_WORDS[c.channel]}. Open the customer’s texts to send a text.`,
      );
    return { conversation: c, created: false };
  }
  // Which of the business's lines this goes out on when the caller named no thread (0089): the line this
  // customer has most recently been talking on, and only for a customer with no thread at all the business's
  // default. Reaching for the default first is what would split a customer who has been texting the dispatch
  // line into a second thread on the front desk, which is the thing lines exist to stop.
  const lineFor = async (counterpart: string): Promise<string | null> =>
    (await preferredLane(ctx.tx, workspaceId, 'sms', counterpart))?.phoneNumberId ??
    (await defaultNumber(ctx.tx, workspaceId))?.id ??
    null;
  if (input.personId) {
    const p = await requirePerson(ctx.tx, workspaceId, input.personId);
    const who = fullName(p.firstName, p.lastName) || 'This customer';
    if (p.archivedAt)
      throw HfosError.rule(
        'person_archived',
        409,
        `${who} is archived. Restore them on their page, then text them.`,
      );
    if (!p.phoneE164)
      throw HfosError.rule(
        'no_phone',
        400,
        `${who} has no mobile number. Add one on their page to text them.`,
      );
    return findOrCreateConversation(ctx, {
      channel: 'sms',
      counterpart: p.phoneE164,
      personId: p.id,
      phoneNumberId: await lineFor(p.phoneE164),
    });
  }
  const to = input.toPhone!;
  return findOrCreateConversation(ctx, {
    channel: 'sms',
    counterpart: to,
    personId: await matchPersonByPhone(ctx.tx, workspaceId, to),
    phoneNumberId: await lineFor(to),
  });
}

async function customerOptedOut(ctx: CommandContext, conv: Conversation): Promise<boolean> {
  if (await isOptedOut(ctx.tx, ctx.scope.workspaceId!, conv.counterpart)) return true;
  if (!conv.personId) return false;
  const [p] = await ctx.tx
    .select({ consent: people.smsConsent })
    .from(people)
    .where(eq(people.id, conv.personId));
  return p?.consent === 'opted_out';
}

/**
 * The number, carrier approval, opt-out and quiet-hours checks every outbound text passes. STOP always wins.
 * `quietHours` says when the AI teammate's reply window let a text through during quiet hours; `holdUntil` when a
 * person's text waits for quiet hours to end instead (they asked for that).
 */
async function assertCanText(
  ctx: CommandContext,
  conv: Conversation,
  opts: {
    acknowledgeQuietHours: boolean;
    skipQuietHours?: boolean;
    /** A person's "Send at 8:00 AM": in quiet hours the text waits for them to end. */
    sendAfterQuietHours?: boolean;
    /** The AI teammate's reply window: the customer's text it answers. */
    inReplyToMessageId?: string;
    /** This send starts the conversation (never allowed in quiet hours for the AI teammate). */
    created?: boolean;
  },
) {
  const workspaceId = ctx.scope.workspaceId!;
  // The conversation's own number, not the business's default — whoever types, the reply goes out from the
  // number the customer wrote to, so their thread never splits in two (M17). A thread that has no number, or
  // whose number was released, falls back to the default rather than failing.
  const number = await conversationNumber(ctx.tx, workspaceId, conv.phoneNumberId);
  if (!number || number.status !== 'active')
    throw HfosError.rule('no_number', 409, noNumberMessage(number?.status ?? null));
  const ready = readiness(number, await loadRegistrations(ctx.tx, workspaceId));
  if (!ready.messagingReady)
    throw HfosError.rule(
      'messaging_not_ready',
      409,
      ready.nextStep === 'submit_registration'
        ? 'Texting needs your business registered with the carriers first. Finish the registration in Settings → Texting & calls.'
        : ready.nextStep === 'rejected'
          ? 'The carriers turned down your texting registration. Fix it and send it again in Settings → Texting & calls.'
          : 'Texting turns on when the carriers approve your registration. Settings → Texting & calls shows where it is.',
    );
  /**
   * After the number and carrier checks, before opt-out. Order matters both ways: a business with no number
   * should be told that rather than about money, and STOP must always win — a customer who opted out is never
   * texted, whatever the balance says, so the opt-out check stays last of the three.
   */
  await assertWalletHasRoom(ctx.tx, workspaceId, 'text');
  if (await customerOptedOut(ctx, conv))
    throw HfosError.rule(
      'opted_out',
      409,
      'This customer texted STOP. They can text START to get texts again.',
    );
  let quietHours: 'reply_window' | null = null;
  let holdUntil: Date | null = null;
  if (!opts.skipQuietHours) {
    const m = await workspaceMessaging(ctx.tx, workspaceId);
    const q = quietHoursState(m.settings.quietHours, m.timezone);
    if (q.quiet && ctx.actor.type === 'ai_employee') {
      // The AI teammate may answer a customer's own text that just came in, a few times a night; never first.
      await assertQuietReply(ctx, conv, q, m, opts);
      quietHours = 'reply_window';
    } else if (q.quiet && ctx.actor.type === 'human' && opts.sendAfterQuietHours)
      holdUntil = quietHoursEndAt(m.settings.quietHours, m.timezone);
    else if (q.quiet && (ctx.actor.type !== 'human' || !opts.acknowledgeQuietHours))
      // Only a person can confirm a text in quiet hours. The system and workflows never can.
      throw new HfosError(
        'rule_violation',
        409,
        `It’s ${formatClock(q.localTime)} where the business is. Quiet hours end at ${formatClock(q.endsAt!)}.`,
        { localTime: q.localTime, endsAt: q.endsAt },
        'quiet_hours',
      );
  }
  return { number, quietHours, holdUntil };
}

/** Why a conversation's number can't text, and what to do, from the number's status (none when there isn't one). */
function noNumberMessage(status: string | null): string {
  if (status === 'provisioning')
    return 'Your business number is still being set up. Try again in a few minutes.';
  if (status === 'porting')
    return 'Your number is still moving over from its old carrier. Texting starts once it arrives.';
  if (status === 'releasing')
    return 'This number is being released, so it can’t text anymore. Get another one in Settings → Texting & calls.';
  return 'This business has no number to text from yet. Get one in Settings → Texting & calls.';
}

/**
 * The AI teammate's quiet-hours reply window: a direct reply to the latest text in this conversation, within
 * QUIET_REPLY_WINDOW_MS of its arrival, or a follow-up close behind its own unanswered text (quickFollowUp), and
 * at most QUIET_REPLY_LIMIT of them in one quiet period. Every refusal is rule quiet_hours, with
 * `details.reason`, so the worker waits for the morning.
 */
async function assertQuietReply(
  ctx: CommandContext,
  conv: Conversation,
  q: QuietHoursState,
  m: WorkspaceMessaging,
  opts: { inReplyToMessageId?: string; created?: boolean },
): Promise<void> {
  const refuse = (reason: string, why: string) =>
    new HfosError(
      'rule_violation',
      409,
      `It’s ${formatClock(q.localTime)} where the business is, and quiet hours end at ${formatClock(q.endsAt!)}. ${why}`,
      { localTime: q.localTime, endsAt: q.endsAt, reason },
      'quiet_hours',
    );
  const underLimit = async () => {
    const since = quietPeriodStart(m.settings.quietHours, m.timezone) ?? new Date();
    const [sent] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.messages
          where conversation_id = ${conv.id} and direction = 'outbound' and channel = 'sms'
            and sent_by_teammate_id is not null and occurred_at >= ${since.toISOString()}::timestamptz`,
    );
    if ((sent?.n ?? 0) >= QUIET_REPLY_LIMIT)
      throw refuse(
        'reply_limit',
        `The AI teammate already answered ${QUIET_REPLY_LIMIT} texts here, so the next reply waits.`,
      );
  };
  if (opts.created || !opts.inReplyToMessageId) {
    // A lead that just came in on its own gets its greeting at once, whatever the hour.
    if (ctx.actor.type === 'ai_employee' && (await freshLeadGreeting(ctx, ctx.actor.runId))) return;
    // So does a follow-up close behind its own unanswered text, while the conversation is live.
    if (
      ctx.actor.type === 'ai_employee' &&
      !opts.created &&
      (await quickFollowUp(ctx, ctx.actor.runId, conv.id))
    )
      return underLimit();
    throw refuse('first_text', 'Until then the AI teammate only answers a text that just came in.');
  }
  const [latest] = await ctx.tx
    .select({ id: messages.id, occurredAt: messages.occurredAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        eq(messages.direction, 'inbound'),
        eq(messages.channel, 'sms'),
      ),
    )
    .orderBy(desc(messages.occurredAt), desc(messages.createdAt))
    .limit(1);
  if (!latest || latest.id !== opts.inReplyToMessageId)
    throw refuse('not_latest', 'The AI teammate only answers the customer’s latest text.');
  if (Date.now() - latest.occurredAt.getTime() > QUIET_REPLY_WINDOW_MS)
    throw refuse(
      'reply_window_passed',
      'That text came in more than 15 minutes ago, so the reply waits.',
    );
  await underLimit();
}

/**
 * Whether this AI run is greeting a lead that came in on its own (nobody typed it in) within
 * QUIET_FIRST_MESSAGE_WINDOW_MS: the one first text quiet hours let through.
 */
async function freshLeadGreeting(ctx: CommandContext, runId: string | null): Promise<boolean> {
  if (!runId) return false;
  const since = new Date(Date.now() - QUIET_FIRST_MESSAGE_WINDOW_MS).toISOString();
  const [r] = await rows<{ fresh: boolean }>(
    ctx.tx,
    sql`select exists (
          select 1 from app.ai_teammate_runs r join app.leads l on l.id = r.lead_id
          where r.id = ${runId} and r.triggered_by = 'lead.created'
            and l.created_by is null and l.created_at >= ${since}::timestamptz) as fresh`,
  );
  return !!r?.fresh;
}

/**
 * Whether this AI run is a follow-up (Automations, "Follow-ups after silence") within QUIET_FOLLOW_UP_WINDOW_MS
 * of the teammate's own text they haven't answered: its first since the customer last wrote. The follow-up job
 * only sends one in quiet hours when its step is QUIET_FOLLOW_UP_MINUTES or less; this is the backstop.
 */
async function quickFollowUp(
  ctx: CommandContext,
  runId: string | null,
  conversationId: string,
): Promise<boolean> {
  if (!runId) return false;
  const since = new Date(Date.now() - QUIET_FOLLOW_UP_WINDOW_MS).toISOString();
  const [r] = await rows<{ quick: boolean }>(
    ctx.tx,
    sql`with last_in as (
          select max(i.occurred_at) as at from app.messages i
          where i.conversation_id = ${conversationId} and i.direction = 'inbound')
        select exists (
            select 1 from app.ai_teammate_runs r
            where r.id = ${runId} and r.conversation_id = ${conversationId}
              and r.triggered_by = 'ai_teammate.follow_up')
          and (select min(m.occurred_at) from app.messages m
            where m.conversation_id = ${conversationId} and m.direction = 'outbound'
              and m.sent_by_teammate_id is not null and coalesce(m.client_id, '') not like 'handoff:%'
              and m.occurred_at > coalesce((select at from last_in), '-infinity'::timestamptz))
            >= ${since}::timestamptz as quick`,
  );
  return !!r?.quick;
}

/**
 * The AI teammate writes only in the conversation it's answering, while it handles it, or starts one with its
 * run's own new lead (a first message). Returns whether this send makes it the one handling the conversation.
 */
async function assertAiMaySend(
  ctx: CommandContext,
  ai: AiEmployeeActor,
  conv: Conversation,
  created: boolean,
): Promise<boolean> {
  if (ai.conversationId) {
    if (conv.id !== ai.conversationId) throw outsideItsConversation();
    if (conv.handledBy !== 'ai' || conv.aiTeammateId !== ai.teammateId) throw notHandledByAi();
    return false;
  }
  const [run] = ai.runId
    ? await ctx.tx
        .select({
          personId: aiTeammateRuns.personId,
          conversationId: aiTeammateRuns.conversationId,
        })
        .from(aiTeammateRuns)
        .where(and(eq(aiTeammateRuns.id, ai.runId), eq(aiTeammateRuns.teammateId, ai.teammateId)))
    : [];
  if (!run?.personId || run.conversationId || conv.personId !== run.personId)
    throw outsideItsConversation();
  // A first message never cuts across a person: not a conversation someone has, nor one assigned to someone.
  if (
    conv.handledBy === 'person' ||
    (conv.handledBy === 'ai' && conv.aiTeammateId !== ai.teammateId) ||
    (!created && conv.handledBy === 'none' && conv.assigneeUserId !== null)
  )
    throw notHandledByAi();
  return conv.handledBy !== 'ai';
}

/** Who sent it: a person, nobody (the system, a workflow), or the AI teammate with its run and whose OK sent it. */
function senderColumns(ctx: CommandContext) {
  const ai = aiEmployeeOf(ctx.actor);
  if (ai)
    return {
      sentBy: null,
      sentByTeammateId: ai.teammateId,
      aiRunId: ai.runId,
      approvedBy: ai.approvedBy,
    };
  return { sentBy: ctx.actor.type === 'human' ? ctx.actor.userId : null };
}

async function attachmentMedia(
  ctx: CommandContext,
  fileIds: readonly string[],
): Promise<MediaRef[]> {
  if (fileIds.length === 0) return [];
  const unique = [...new Set(fileIds)];
  const list = await ctx.tx
    .select()
    .from(files)
    .where(
      and(
        eq(files.workspaceId, ctx.scope.workspaceId!),
        inArray(files.id, unique),
        isNull(files.deletedAt),
      ),
    );
  if (list.length !== unique.length || list.some((f) => f.status !== 'ready'))
    throw HfosError.validation(
      [{ path: 'attachmentFileIds', message: 'Attach photos that finished uploading.' }],
      'A photo on this text hasn’t finished uploading, or was removed. Wait for it to finish, or attach it again.',
    );
  const notAPhoto = list.find((f) => !MMS_TYPES.has(f.mimeType ?? ''));
  if (notAPhoto)
    throw HfosError.rule(
      'attachment_type',
      400,
      `“${notAPhoto.name}” can’t go in a text. Texts carry JPG, PNG or GIF photos, so attach one of those, or send the file by email.`,
    );
  const total = list.reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
  if (total > MMS_MAX_BYTES)
    throw HfosError.rule(
      'attachment_too_large',
      400,
      `These photos add up to ${formatBytes(total)}, and one text carries 5 MB at most. Take one off, or send smaller photos.`,
    );
  const byId = new Map(list.map((f) => [f.id, f]));
  return unique.map((id) => {
    const f = byId.get(id)!;
    return {
      bucket: f.bucket,
      objectPath: f.objectPath,
      contentType: f.mimeType ?? 'application/octet-stream',
      sizeBytes: f.sizeBytes ?? 0,
      name: f.name,
      fileId: f.id,
    };
  });
}

/**
 * A carousel's pictures (0103), one per card, in card order. The same checks as a photo on a text — uploaded,
 * finished, a type every phone shows — but counted one at a time: a carousel goes over RCS, not as one picture
 * message, and a phone without RCS gets its words, not ten photos.
 */
async function cardPictures(ctx: CommandContext, fileIds: readonly string[]): Promise<MediaRef[]> {
  const unique = [...new Set(fileIds)];
  const list = await ctx.tx
    .select()
    .from(files)
    .where(
      and(
        eq(files.workspaceId, ctx.scope.workspaceId!),
        inArray(files.id, unique),
        isNull(files.deletedAt),
      ),
    );
  if (list.length !== unique.length || list.some((f) => f.status !== 'ready'))
    throw HfosError.validation([
      { path: 'rich.cards', message: 'Add a picture to every card, and wait for it to upload.' },
    ]);
  const notAPicture = list.find((f) => !MMS_TYPES.has(f.mimeType ?? ''));
  if (notAPicture)
    throw HfosError.rule(
      'attachment_type',
      400,
      `“${notAPicture.name}” can’t go on a card. Cards carry JPG, PNG or GIF pictures, so pick one of those.`,
    );
  const tooBig = list.find((f) => (f.sizeBytes ?? 0) > MMS_MAX_BYTES);
  if (tooBig)
    throw HfosError.rule(
      'attachment_too_large',
      400,
      `“${tooBig.name}” is ${formatBytes(tooBig.sizeBytes)}, and a card’s picture can be 5 MB at most. Pick a smaller one.`,
    );
  const byId = new Map(list.map((f) => [f.id, f]));
  return fileIds.map((id) => {
    const f = byId.get(id)!;
    return {
      bucket: f.bucket,
      objectPath: f.objectPath,
      contentType: f.mimeType ?? 'application/octet-stream',
      sizeBytes: f.sizeBytes ?? 0,
      name: f.name,
      fileId: f.id,
    };
  });
}

/**
 * What a text carries besides its words (0103), as the message stores it: every button with its id, and the
 * words a phone without RCS gets instead. A message with buttons or a card keeps its one photo in the message's
 * own `media`, like any picture message; a carousel's pictures ride on its cards.
 */
async function richFor(
  ctx: CommandContext,
  messageId: string,
  body: string,
  input: RichInput,
  media: readonly MediaRef[],
): Promise<RichText> {
  let rich: RichText;
  if (input.kind === 'carousel') {
    if (media.length)
      throw HfosError.validation(
        [{ path: 'attachmentFileIds', message: 'A carousel carries its pictures on its cards.' }],
        'A carousel carries its pictures on its cards. Take the photo off the message and put it on a card.',
      );
    const pictures = await cardPictures(
      ctx,
      input.cards.map((c) => c.mediaFileId),
    );
    rich = buildRichText(messageId, body, {
      kind: 'carousel',
      cards: input.cards.map((c, i) => ({ ...c, media: pictures[i]! })),
    });
  } else {
    if (media.length > 1)
      throw HfosError.validation(
        [{ path: 'attachmentFileIds', message: 'A message with buttons carries one photo.' }],
        `A message with buttons carries one photo, and this one has ${media.length}. Take the others off.`,
      );
    if (media.length === 1 && input.buttons.length > RCS_LIMITS.cardButtons)
      throw HfosError.validation([
        {
          path: 'rich.buttons',
          message: `With a photo, a message holds ${RCS_LIMITS.cardButtons} buttons at most.`,
        },
      ]);
    rich = buildRichText(messageId, body, input);
  }
  if (rich.smsText.length > RCS_LIMITS.smsText)
    throw HfosError.validation([
      {
        path: 'body',
        message:
          'With the choices written out for phones without RCS, this is over 1,600 characters. Shorten the words or take a button off.',
      },
    ]);
  return rich;
}

/** Records an opt-out or opt-in for a customer number (and on the person, when there is one). */
async function setConsent(
  ctx: CommandContext,
  input: {
    counterpart: string | null;
    personId: string | null;
    optedOut: boolean;
    source: 'keyword' | 'manual' | 'carrier_error';
    keyword?: string | null;
    phoneNumberId?: string | null;
    at: Date;
  },
) {
  const workspaceId = ctx.scope.workspaceId!;
  if (input.counterpart) {
    await ctx.tx
      .insert(optOuts)
      .values({
        workspaceId,
        counterpartE164: input.counterpart,
        phoneNumberId: input.phoneNumberId ?? null,
        optedOut: input.optedOut,
        source: input.source,
        lastKeyword: input.keyword ?? null,
        optedOutAt: input.optedOut ? input.at : null,
        optedInAt: input.optedOut ? null : input.at,
        createdBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
      })
      .onConflictDoUpdate({
        target: [optOuts.workspaceId, optOuts.counterpartE164],
        set: {
          optedOut: input.optedOut,
          source: input.source,
          lastKeyword: input.keyword ?? null,
          ...(input.optedOut ? { optedOutAt: input.at } : { optedInAt: input.at }),
        },
      });
  }
  if (input.personId)
    await ctx.tx
      .update(people)
      .set({
        smsConsent: input.optedOut ? 'opted_out' : 'opted_in',
        smsConsentAt: input.at,
        smsConsentSource: input.source,
      })
      .where(eq(people.id, input.personId));
}

/**
 * How an outbound message leaves its conversation. People's messages reopen it and mark it read and answered.
 * HandsFreeOS's own (booking confirmations and reminders, `keepConversationStatus`) leave its status, unread
 * count and the customer's waiting time alone, and a conversation one of them starts begins closed: nothing
 * waits on it until the customer replies, which opens it.
 */
function afterOutbound(keep: boolean, created: boolean, now: Date) {
  if (!keep)
    return {
      awaitingReplySince: null,
      unreadCount: 0,
      status: 'open' as const,
      snoozedUntil: null,
      closedAt: null,
      closedBy: null,
    };
  return created ? { status: 'closed' as const, closedAt: now } : {};
}

/**
 * Email from a workspace address (the worker sends it through Postmark) or a connected mailbox. Threads under
 * the conversation's last email, and refuses addresses that bounced, complained or were stopped.
 */
async function sendEmail(ctx: CommandContext, input: z.infer<typeof MessageSendInput>) {
  const workspaceId = ctx.scope.workspaceId!;
  const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
  // A person's own address (M19) sends for them alone, and only in their own mail.
  const addresses = await workspaceAddresses(ctx.tx, workspaceId);
  const chosen = input.emailAddressId
    ? addresses.find((a) => a.id === input.emailAddressId)
    : undefined;
  if (chosen?.ownerUserId && chosen.ownerUserId !== me)
    throw HfosError.rule(
      'email_address_private',
      403,
      me
        ? `${chosen.address} is someone else’s own address, so only they can send from it. Pick a team address instead.`
        : `${chosen.address} is someone’s own address, and HandsFreeOS sends only from the team’s. Pick a team address.`,
    );
  const { conversation: conv, created } = await resolveEmailConversation(
    ctx,
    input,
    chosen?.ownerUserId ? chosen : null,
  );
  // Their own mail: only they see it, and nothing copies it anywhere the team can read (M19).
  const sealed = conv.privateTo !== null;
  if (chosen?.ownerUserId && !sealed)
    throw HfosError.rule(
      'email_address_private_thread',
      409,
      `${chosen.address} is your own address, so it sends only in your own mailbox. Pick a team address to answer here.`,
    );
  if (input.clientId) {
    const [dup] = await ctx.tx
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.clientId, input.clientId)));
    if (dup)
      return { messageId: dup.id, conversationId: conv.id, status: dup.status, duplicate: true };
  }
  const ai = aiEmployeeOf(ctx.actor);
  const claim = ai ? await assertAiMaySend(ctx, ai, conv, created) : false;
  const stopped = await activeSuppression(ctx.tx, workspaceId, conv.counterpart);
  if (stopped)
    throw HfosError.rule('recipient_suppressed', 409, suppressionMessage(stopped.reason));
  for (const address of input.cc)
    if (await activeSuppression(ctx.tx, workspaceId, address))
      throw HfosError.validation(
        [{ path: 'cc', message: `Email to ${address} is stopped. Take it out of Cc.` }],
        `Email to ${address} is stopped. Take it out of Cc, or unblock it under Blocked addresses in Settings → Email.`,
      );

  let from: {
    address: string;
    domain: string;
    emailAddressId: string | null;
    mailboxConnectionId: string | null;
    provider: string;
  };
  if (input.mailboxConnectionId && sealed)
    throw HfosError.rule(
      'email_address_private_thread',
      409,
      'This is your own mail, so the answer goes from your own address, not a connected mailbox.',
    );
  if (input.mailboxConnectionId) {
    const mailbox = (await sendableMailboxes(ctx.tx, workspaceId, null)).find(
      (m) => m.id === input.mailboxConnectionId,
    );
    if (!mailbox?.accountEmail)
      throw HfosError.rule(
        'mailbox_not_active',
        409,
        'This mailbox isn’t connected anymore. Reconnect it under Connected mailboxes in Settings → Email to send from it.',
      );
    // A workflow or the AI teammate works for the business, so it sends from shared mailboxes only, never
    // from someone's own.
    if (!mailbox.shared && (me ? mailbox.userId !== me : ctx.actor.type !== 'system'))
      throw HfosError.rule(
        'mailbox_not_shared',
        403,
        me
          ? `${mailbox.accountEmail} is someone else’s own mailbox, so only they can send from it. Send from a shared mailbox or a business address instead.`
          : `${mailbox.accountEmail} is someone’s own mailbox, and workflows and the AI teammate send only from shared ones. Pick a shared mailbox or a business address.`,
      );
    from = {
      address: mailbox.accountEmail,
      domain: mailbox.accountEmail.split('@')[1] ?? SHARED_MAIL_DOMAIN,
      emailAddressId: null,
      mailboxConnectionId: mailbox.id,
      provider: mailbox.provider,
    };
  } else {
    // Someone else's own address is never a fallback: a team thread on it (one they shared) answers from the team's.
    const list = sendableAddresses(addresses, me);
    if (input.emailAddressId) {
      const wanted = list.find((a) => a.id === input.emailAddressId);
      if (!wanted)
        throw HfosError.notFound(
          'That sending address isn’t there anymore. It may have been removed. Pick another address.',
        );
      if (!wanted.usable)
        throw HfosError.rule(
          'email_domain_unverified',
          409,
          `${wanted.domain} isn’t verified yet, so ${wanted.address} can’t send. Finish verifying it in Settings → Email, or send from another address.`,
        );
    }
    const a = pickFromAddress(list, [input.emailAddressId, conv.emailAddressId]);
    if (!a)
      throw HfosError.rule(
        'no_email_address',
        409,
        'This business has no email address to send from yet. Set one up in Settings → Email.',
      );
    // Private mail goes from its own address or not at all, never quietly from the team's.
    if (sealed && a.id !== conv.emailAddressId) {
      const own = addresses.find((x) => x.id === conv.emailAddressId);
      throw HfosError.rule(
        'email_address_private_thread',
        409,
        own && !own.usable
          ? `${own.address} can’t send until ${own.domain} is verified. Finish verifying it in Settings → Email.`
          : 'This is your own mail, so the answer goes from your own address. Send it from there.',
      );
    }
    from = {
      address: a.address,
      domain: a.domain,
      emailAddressId: a.id,
      mailboxConnectionId: null,
      provider: 'postmark',
    };
  }

  const thread = await threadHeaders(ctx.tx, conv.id);
  const subject = input.subject?.trim() || replySubject(thread.subject);
  if (!subject)
    throw HfosError.validation(
      [{ path: 'subject', message: 'Add a subject.' }],
      'This email has no subject. Add one, then send it.',
    );
  const media = await emailAttachments(ctx, input.attachmentFileIds);
  const messageId = randomUUID();
  const now = new Date();
  const header = newMessageIdHeader(from.domain);
  const preview = emailPreview(subject, input.body, media.length);
  // Private mail keeps who and what out of the history owners read, and wakes only the worker that sends it.
  if (created)
    await ctx.emit({
      type: 'conversation.created',
      entityType: 'conversation',
      entityId: conv.id,
      payload: { channel: 'email', personId: conv.personId, ...(sealed ? { private: true } : {}) },
      after: sealed ? { channel: 'email' } : { with: conv.counterpart, channel: 'email' },
    });
  const eventId = await ctx.emit({
    type: sealed ? 'email.private_queued' : 'message.queued',
    entityType: 'message',
    entityId: messageId,
    payload: {
      conversationId: conv.id,
      personId: conv.personId,
      channel: 'email',
      mediaCount: media.length,
      via: from.mailboxConnectionId ? 'mailbox' : 'address',
    },
    after: sealed
      ? { mediaCount: media.length }
      : { to: conv.counterpart, from: from.address, subject, mediaCount: media.length },
  });
  const activityId = sealed
    ? null
    : await logChannelActivity(ctx, {
        kind: 'email',
        subtype: 'outbound',
        personId: conv.personId,
        body: input.body,
        occurredAt: now,
        eventId,
        meta: {
          direction: 'outbound',
          messageId,
          conversationId: conv.id,
          status: 'queued',
          subject,
          from: from.address,
          mediaCount: media.length,
          attachments: media.map(({ name, bucket, objectPath }) => ({ name, bucket, objectPath })),
        },
      });
  await ctx.tx.insert(messages).values({
    id: messageId,
    workspaceId,
    conversationId: conv.id,
    channel: 'email',
    direction: 'outbound',
    status: 'queued',
    fromAddress: from.address,
    toAddresses: [conv.counterpart],
    ccAddresses: input.cc,
    subject,
    bodyText: input.body,
    media,
    provider: from.provider,
    dedupeKey: emailDedupeKey(header),
    messageIdHeader: header,
    inReplyToHeader: thread.inReplyTo,
    referencesHeaders: thread.references,
    emailAddressId: from.emailAddressId,
    mailboxConnectionId: from.mailboxConnectionId,
    ...senderColumns(ctx),
    clientId: input.clientId ?? null,
    occurredAt: now,
    activityId,
    campaignRecipientId: input.campaignRecipientId ?? null,
  });
  await ctx.tx
    .update(conversations)
    .set({
      lastMessageAt: now,
      lastOutboundAt: now,
      lastPreview: preview,
      lastDirection: 'outbound',
      ...afterOutbound(input.keepConversationStatus, created, now),
      ...(!conv.emailAddressId && from.emailAddressId
        ? { emailAddressId: from.emailAddressId }
        : {}),
      ...(claim && ai ? { handledBy: 'ai' as const, aiTeammateId: ai.teammateId } : {}),
    })
    .where(eq(conversations.id, conv.id));
  if (!sealed) {
    if (personTakesOver(ctx, conv)) await takeOver(ctx, conv, 'reply');
    await claimOnReply(ctx, conv);
  }
  return { messageId, conversationId: conv.id, status: 'queued', duplicate: false };
}

/**
 * A reply in a website chat: no number, carrier or quiet hours. The chat window shows it from the live feed
 * (private.chat_feed) as soon as it's saved, so it goes out as `message.sent`, never `message.queued` (the
 * worker texts or emails queued messages). People's rows start queued (the messages insert policy) until the
 * chat worker marks them; the AI teammate's and the system's are sent at once. No attachments in chat yet.
 */
async function sendChat(ctx: CommandContext, input: z.infer<typeof MessageSendInput>) {
  const workspaceId = ctx.scope.workspaceId!;
  const conv = await loadConversation(ctx, input.conversationId!);
  if (conv.channel !== 'chat')
    throw HfosError.rule(
      'channel_mismatch',
      400,
      `This conversation is ${THREAD_WORDS[conv.channel]}, not a website chat. Reply there instead.`,
    );
  if (input.clientId) {
    const [dup] = await ctx.tx
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.clientId, input.clientId)));
    if (dup)
      return { messageId: dup.id, conversationId: conv.id, status: dup.status, duplicate: true };
  }
  const ai = aiEmployeeOf(ctx.actor);
  if (ai) await assertAiMaySend(ctx, ai, conv, false);
  if (input.attachmentFileIds.length)
    throw HfosError.validation(
      [{ path: 'attachmentFileIds', message: 'Website chat doesn’t carry attachments yet.' }],
      'Website chat doesn’t carry attachments yet. Take the attachment off, or send it by text or email.',
    );
  const messageId = randomUUID();
  const now = new Date();
  const status = ctx.actor.type === 'human' ? ('queued' as const) : ('sent' as const);
  const preview = messagePreview(input.body, 0);
  const eventId = await ctx.emit({
    type: 'message.sent',
    entityType: 'message',
    entityId: messageId,
    payload: { conversationId: conv.id, personId: conv.personId, channel: 'chat', status },
    after: { to: 'Website chat', preview: preview.slice(0, 80) },
  });
  const activityId = await logChannelActivity(ctx, {
    kind: 'chat',
    subtype: 'outbound',
    personId: conv.personId,
    body: input.body,
    occurredAt: now,
    eventId,
    meta: { direction: 'outbound', messageId, conversationId: conv.id, status },
  });
  await ctx.tx.insert(messages).values({
    id: messageId,
    workspaceId,
    conversationId: conv.id,
    channel: 'chat',
    direction: 'outbound',
    status,
    toAddresses: [conv.counterpart],
    bodyText: input.body,
    ...senderColumns(ctx),
    clientId: input.clientId ?? null,
    occurredAt: now,
    sentAt: status === 'sent' ? now : null,
    activityId,
  });
  await ctx.tx
    .update(conversations)
    .set({
      lastMessageAt: now,
      lastOutboundAt: now,
      lastPreview: preview,
      lastDirection: 'outbound',
      ...afterOutbound(input.keepConversationStatus, false, now),
    })
    .where(eq(conversations.id, conv.id));
  if (personTakesOver(ctx, conv)) await takeOver(ctx, conv, 'reply');
  await claimOnReply(ctx, conv);
  return { messageId, conversationId: conv.id, status, duplicate: false };
}

/**
 * A reply in a client's portal (Real Estate round two): no number, carrier or quiet hours, and never the AI teammate,
 * which doesn't answer portals. The client reads it in their portal, so it goes out as `message.sent`, never
 * `message.queued` (the worker texts or emails queued messages). People's rows start queued (the messages insert
 * policy) until the worker marks them sent and, if the client hasn't read it ten minutes later, emails them a link.
 * A file goes to their portal with file.share_to_portal, not in a message.
 */
async function sendPortal(ctx: CommandContext, input: z.infer<typeof MessageSendInput>) {
  const workspaceId = ctx.scope.workspaceId!;
  const conv = await loadConversation(ctx, input.conversationId!);
  if (conv.channel !== 'portal')
    throw HfosError.rule(
      'channel_mismatch',
      400,
      `This conversation is ${THREAD_WORDS[conv.channel]}, not a client’s portal. Reply there instead.`,
    );
  if (ctx.actor.type === 'ai_employee' || ctx.actor.type === 'workflow')
    throw HfosError.forbidden(
      'Only the people on a client’s deal answer them in their portal.',
      'portal_people_only',
    );
  if (input.clientId) {
    const [dup] = await ctx.tx
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.clientId, input.clientId)));
    if (dup)
      return { messageId: dup.id, conversationId: conv.id, status: dup.status, duplicate: true };
  }
  if (input.attachmentFileIds.length)
    throw HfosError.validation(
      [{ path: 'attachmentFileIds', message: 'Portal messages don’t carry attachments.' }],
      'Portal messages don’t carry attachments. Show the file in their portal from the customer’s files instead.',
    );
  const messageId = randomUUID();
  const now = new Date();
  const status = ctx.actor.type === 'human' ? ('queued' as const) : ('sent' as const);
  const preview = messagePreview(input.body, 0);
  const eventId = await ctx.emit({
    type: 'message.sent',
    entityType: 'message',
    entityId: messageId,
    payload: { conversationId: conv.id, personId: conv.personId, channel: 'portal', status },
    after: { to: 'Client portal', preview: preview.slice(0, 80) },
  });
  const activityId = await logChannelActivity(ctx, {
    kind: 'portal',
    subtype: 'outbound',
    personId: conv.personId,
    customRecordId: conv.customRecordId,
    body: input.body,
    occurredAt: now,
    eventId,
    meta: { direction: 'outbound', messageId, conversationId: conv.id, status },
  });
  await ctx.tx.insert(messages).values({
    id: messageId,
    workspaceId,
    conversationId: conv.id,
    channel: 'portal',
    direction: 'outbound',
    status,
    toAddresses: [conv.counterpart],
    bodyText: input.body,
    ...senderColumns(ctx),
    clientId: input.clientId ?? null,
    occurredAt: now,
    sentAt: status === 'sent' ? now : null,
    activityId,
  });
  await ctx.tx
    .update(conversations)
    .set({
      lastMessageAt: now,
      lastOutboundAt: now,
      lastPreview: preview,
      lastDirection: 'outbound',
      ...afterOutbound(input.keepConversationStatus, false, now),
    })
    .where(eq(conversations.id, conv.id));
  await claimOnReply(ctx, conv);
  return { messageId, conversationId: conv.id, status, duplicate: false };
}

export const messageSend = defineCommand({
  name: 'message.send',
  description:
    'Text, email or chat with a customer: a text from the business number, an email from a workspace address or a connected mailbox, or a reply in a website chat. Texts and emails are queued here and the worker sends them. A person writing in a conversation the AI teammate is answering takes it over.',
  risk: 2,
  input: MessageSendInput,
  output: MessageSendOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: [
    'message.queued',
    'message.sent',
    'message.scheduled',
    'conversation.created',
    'conversation.taken_over',
    // An email from a person's own mailbox (M19): only the worker that sends it hears of it.
    'email.private_queued',
  ],
  actors: ['human', 'system', 'workflow', 'ai_employee'],
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    // Only HandsFreeOS's own messages (the system's, a workflow's) may leave the conversation as it was.
    if (input.keepConversationStatus && ctx.actor.type === 'human')
      throw HfosError.validation([
        {
          path: 'keepConversationStatus',
          message: 'Only HandsFreeOS itself sends without reopening the conversation.',
        },
      ]);
    // Only HandsFreeOS's own campaign sender marks an email as a campaign email.
    if (input.campaignRecipientId && (ctx.actor.type !== 'system' || input.channel !== 'email'))
      throw HfosError.validation([
        {
          path: 'campaignRecipientId',
          message: 'Only HandsFreeOS itself sends a campaign email.',
        },
      ]);
    // Only a person chooses to send when quiet hours end; HandsFreeOS's own texts wait for them on their own.
    if (input.sendAfterQuietHours && ctx.actor.type !== 'human')
      throw HfosError.validation([
        {
          path: 'sendAfterQuietHours',
          message: 'Only a person chooses to send a text when quiet hours end.',
        },
      ]);
    // Every message the AI teammate sends has its own clientId, so a retried job never sends it twice.
    if (ctx.actor.type === 'ai_employee' && !input.clientId)
      throw HfosError.validation([
        { path: 'clientId', message: 'The AI teammate sends every message with a clientId.' },
      ]);
    // The AI teammate writes to its customer alone, from the business: nobody copied in, no files, and never
    // through someone's connected mailbox.
    if (ctx.actor.type === 'ai_employee') {
      const refused = [
        ...(input.cc.length
          ? [{ path: 'cc', message: 'The AI teammate doesn’t copy anyone in.' }]
          : []),
        ...(input.attachmentFileIds.length
          ? [{ path: 'attachmentFileIds', message: 'The AI teammate doesn’t attach files.' }]
          : []),
        ...(input.mailboxConnectionId
          ? [
              {
                path: 'mailboxConnectionId',
                message: 'The AI teammate sends from the business’s addresses, never a mailbox.',
              },
            ]
          : []),
        // Its replies are words a person can read and approve as they stand; buttons are the team's to add.
        ...(input.rich
          ? [{ path: 'rich', message: 'The AI teammate doesn’t send buttons or cards.' }]
          : []),
      ];
      if (refused.length)
        throw HfosError.validation(
          refused,
          `${refused.map((r) => r.message).join(' ')} Send the message without ${refused.length === 1 ? 'it' : 'them'}.`,
        );
    }
    if (input.channel === 'email') return sendEmail(ctx, input);
    if (input.channel === 'chat') return sendChat(ctx, input);
    if (input.channel === 'portal') return sendPortal(ctx, input);
    const workspaceId = ctx.scope.workspaceId!;
    const { conversation: conv, created } = await resolveSmsConversation(ctx, input);
    if (input.clientId) {
      const [dup] = await ctx.tx
        .select({
          id: messages.id,
          status: messages.status,
          errorCode: messages.errorCode,
          occurredAt: messages.occurredAt,
        })
        .from(messages)
        .where(and(eq(messages.conversationId, conv.id), eq(messages.clientId, input.clientId)));
      if (dup) {
        const scheduledFor = scheduledForOf(dup);
        return {
          messageId: dup.id,
          conversationId: conv.id,
          status: dup.status,
          duplicate: true,
          ...(scheduledFor ? { scheduledFor } : {}),
        };
      }
    }
    const ai = aiEmployeeOf(ctx.actor);
    const claim = ai ? await assertAiMaySend(ctx, ai, conv, created) : false;
    const { number, quietHours, holdUntil } = await assertCanText(ctx, conv, {
      acknowledgeQuietHours: input.acknowledgeQuietHours,
      sendAfterQuietHours: input.sendAfterQuietHours,
      inReplyToMessageId: input.inReplyToMessageId,
      created,
    });
    const media = await attachmentMedia(ctx, input.attachmentFileIds);
    const messageId = randomUUID();
    const rich = input.rich ? await richFor(ctx, messageId, input.body, input.rich, media) : null;
    const now = new Date();
    // A rich text is counted by its plain face: that is what a phone without RCS is sent, segment by segment.
    const segments = smsSegments(rich ? rich.smsText : input.body).segments;
    const preview = messagePreview(input.body, media.length);
    const to = formatPhone(conv.counterpart);
    if (created)
      await ctx.emit({
        type: 'conversation.created',
        entityType: 'conversation',
        entityId: conv.id,
        payload: { channel: 'sms', personId: conv.personId },
        after: { with: to, channel: 'sms' },
      });
    if (holdUntil) {
      // "Send at 8:00 AM": the text waits in the conversation, scheduled and cancellable. Nothing reaches the
      // timeline or the conversation's preview until it goes; the worker sends it then (message.release_scheduled).
      const sendAt = holdUntil.toISOString();
      await ctx.emit({
        type: 'message.scheduled',
        entityType: 'message',
        entityId: messageId,
        payload: {
          conversationId: conv.id,
          personId: conv.personId,
          channel: 'sms',
          mediaCount: media.length,
          ...(rich ? { rich: rich.kind } : {}),
          sendAt,
        },
        after: { to, preview: preview.slice(0, 80), segments, mediaCount: media.length, sendAt },
      });
      await ctx.tx.insert(messages).values({
        id: messageId,
        workspaceId,
        conversationId: conv.id,
        channel: 'sms',
        direction: 'outbound',
        status: 'queued',
        fromAddress: number.e164,
        toAddresses: [conv.counterpart],
        bodyText: input.body,
        media,
        rich,
        segments,
        ...senderColumns(ctx),
        clientId: input.clientId ?? null,
        errorCode: SCHEDULED_TEXT,
        occurredAt: holdUntil,
        went: false,
      });
      if (!conv.phoneNumberId)
        await ctx.tx
          .update(conversations)
          .set({ phoneNumberId: number.id })
          .where(eq(conversations.id, conv.id));
      // The person answered it themselves: the AI teammate stops answering it now, not in the morning.
      if (personTakesOver(ctx, conv)) await takeOver(ctx, conv, 'reply');
      await claimOnReply(ctx, conv);
      return {
        messageId,
        conversationId: conv.id,
        status: 'queued',
        duplicate: false,
        scheduledFor: sendAt,
      };
    }
    const eventId = await ctx.emit({
      type: 'message.queued',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId: conv.personId,
        channel: 'sms',
        mediaCount: media.length,
        ...(rich ? { rich: rich.kind } : {}),
        ...(quietHours ? { quietHours } : {}),
      },
      after: {
        to,
        preview: preview.slice(0, 80),
        segments,
        mediaCount: media.length,
        ...(rich ? { rich: rich.kind } : {}),
      },
    });
    const activityId = await logChannelActivity(ctx, {
      kind: 'sms',
      subtype: 'outbound',
      personId: conv.personId,
      body: input.body,
      occurredAt: now,
      eventId,
      meta: {
        direction: 'outbound',
        messageId,
        conversationId: conv.id,
        status: 'queued',
        mediaCount: media.length,
        ...(rich ? { rich: rich.kind } : {}),
      },
    });
    await ctx.tx.insert(messages).values({
      id: messageId,
      workspaceId,
      conversationId: conv.id,
      channel: 'sms',
      direction: 'outbound',
      status: 'queued',
      fromAddress: number.e164,
      toAddresses: [conv.counterpart],
      bodyText: input.body,
      media,
      rich,
      segments,
      ...senderColumns(ctx),
      clientId: input.clientId ?? null,
      occurredAt: now,
      activityId,
    });
    await ctx.tx
      .update(conversations)
      .set({
        lastMessageAt: now,
        lastOutboundAt: now,
        lastPreview: preview,
        lastDirection: 'outbound',
        ...afterOutbound(input.keepConversationStatus, created, now),
        phoneNumberId: conv.phoneNumberId ?? number.id,
        ...(claim && ai ? { handledBy: 'ai' as const, aiTeammateId: ai.teammateId } : {}),
      })
      .where(eq(conversations.id, conv.id));
    if (personTakesOver(ctx, conv)) await takeOver(ctx, conv, 'reply');
    await claimOnReply(ctx, conv);
    return { messageId, conversationId: conv.id, status: 'queued', duplicate: false };
  },
});

/**
 * A held text going for the first time (`went` was false): from this moment it is the conversation's latest, with
 * or without a customer, and on the customer's timeline (a conversation without one gets the entry when it's
 * linked). message.release_scheduled does this when quiet hours end, credited to whoever wrote it; message.retry
 * does it for a held text that was refused then (the customer opted out overnight), credited to the person who
 * pressed Retry, since a person only ever writes their own timeline entries.
 */
async function goesFirstTime(
  ctx: CommandContext,
  m: typeof messages.$inferSelect,
  conv: typeof conversations.$inferSelect,
  eventId: string,
  now: Date,
  whenQuietHoursEnded: boolean,
) {
  const activityId = await logChannelActivity(ctx, {
    kind: 'sms',
    subtype: 'outbound',
    personId: conv.personId,
    body: m.bodyText,
    occurredAt: now,
    eventId,
    ...(ctx.actor.type === 'human' ? {} : { authorUserId: m.sentBy }),
    meta: {
      direction: 'outbound',
      messageId: m.id,
      conversationId: conv.id,
      status: 'queued',
      mediaCount: m.media.length,
      ...(whenQuietHoursEnded ? { scheduled: true } : {}),
    },
  });
  await ctx.tx
    .update(messages)
    .set({ occurredAt: now, activityId, went: true })
    .where(eq(messages.id, m.id));
  await ctx.tx
    .update(conversations)
    .set({
      lastMessageAt: now,
      lastOutboundAt: now,
      lastPreview: messagePreview(m.bodyText, m.media.length),
      lastDirection: 'outbound',
      ...afterOutbound(false, false, now),
    })
    .where(eq(conversations.id, conv.id));
}

export const messageRetry = defineCommand({
  name: 'message.retry',
  description: 'Send a text or email that did not go out one more time.',
  risk: 2,
  input: MessageRetryInput,
  output: MessageRetryOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.queued', 'message.scheduled'],
  async handler(ctx, input) {
    const [m] = await ctx.tx
      .select()
      .from(messages)
      .where(
        and(eq(messages.id, input.messageId), eq(messages.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!m)
      throw HfosError.notFound(
        'That message isn’t there anymore. Refresh the conversation and try again.',
      );
    if (m.direction !== 'outbound' || (m.status !== 'failed' && m.status !== 'undelivered'))
      throw HfosError.rule(
        'message_not_failed',
        409,
        m.direction !== 'outbound'
          ? 'That message came from the customer, so there’s nothing to send again.'
          : m.status === 'queued' || m.status === 'sending'
            ? 'This message is still on its way, so there’s nothing to send again yet.'
            : m.status === 'bounced'
              ? 'This email bounced, so sending it again won’t reach them. Check the address with the customer, then send a new email.'
              : 'This message already went out, so there’s nothing to send again.',
      );
    const conv = await loadConversation(ctx, m.conversationId);
    let holdUntil: Date | null = null;
    if (m.channel === 'email') {
      const stopped = await activeSuppression(ctx.tx, ctx.scope.workspaceId!, conv.counterpart);
      if (stopped)
        throw HfosError.rule('recipient_suppressed', 409, suppressionMessage(stopped.reason));
    } else
      // A text tried again in quiet hours never goes at night: it waits for them to end, like "Send at 8:00 AM".
      ({ holdUntil } = await assertCanText(ctx, conv, {
        acknowledgeQuietHours: false,
        sendAfterQuietHours: true,
      }));
    if (holdUntil) {
      // Held the way message.send holds a text: queued, cancellable, going at `occurred_at`. The worker's release
      // runs every check again then and sends it in place of the attempt that failed. That attempt is kept, so
      // cancelling puts the text back as it was (message.cancel_scheduled).
      const sendAt = holdUntil.toISOString();
      await ctx.tx
        .update(messages)
        .set({
          status: 'queued',
          errorCode: SCHEDULED_TEXT,
          errorMessage: null,
          occurredAt: holdUntil,
          failedAttempt: {
            status: m.status,
            errorCode: m.errorCode,
            errorMessage: m.errorMessage,
            occurredAt: m.occurredAt.toISOString(),
          },
        })
        .where(eq(messages.id, m.id));
      await ctx.emit({
        type: 'message.scheduled',
        entityType: 'message',
        entityId: m.id,
        payload: {
          conversationId: conv.id,
          personId: conv.personId,
          channel: 'sms',
          mediaCount: m.media.length,
          retry: true,
          sendAt,
        },
        before: { status: m.status, errorCode: m.errorCode },
        after: { to: formatPhone(conv.counterpart), status: 'queued', retry: true, sendAt },
      });
      return { messageId: m.id, scheduledFor: sendAt };
    }
    await ctx.tx
      .update(messages)
      .set({ status: 'queued', errorCode: null, errorMessage: null })
      .where(eq(messages.id, m.id));
    const eventId = await ctx.emit({
      type: 'message.queued',
      entityType: 'message',
      entityId: m.id,
      payload: {
        conversationId: conv.id,
        personId: conv.personId,
        channel: m.channel,
        retry: true,
        // The attempt that failed may have reached the carrier and left its provider id behind. The worker sends
        // this message again despite that id, and the new send's id replaces it (message.update_status).
        replacesProviderMessageId: m.providerMessageId,
      },
      before: { status: m.status, errorCode: m.errorCode },
      after: {
        to: m.channel === 'sms' ? formatPhone(conv.counterpart) : conv.counterpart,
        status: 'queued',
        retry: true,
      },
    });
    // A held text refused when quiet hours ended never went. This is its first time, so it becomes the
    // conversation's latest and gets its timeline entry now. One that went before keeps its place and its entry.
    if (!m.went) await goesFirstTime(ctx, m, conv, eventId, new Date(), false);
    return { messageId: m.id };
  },
});

export const messageCancelScheduled = defineCommand({
  name: 'message.cancel_scheduled',
  description:
    'Cancel a text waiting for quiet hours to end. It never goes: a new text leaves the conversation, and a failed text that was tried again goes back as it was, not delivered.',
  risk: 1,
  input: MessageCancelScheduledInput,
  output: MessageCancelScheduledOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.schedule_cancelled'],
  // Cancelling only ever keeps a text from going, so it can wait on a phone; once the text went, it says so.
  offline: 'anytime',
  async handler(ctx, input) {
    const [m] = await ctx.tx
      .select()
      .from(messages)
      .where(
        and(eq(messages.id, input.messageId), eq(messages.workspaceId, ctx.scope.workspaceId!)),
      )
      .for('update');
    if (!m)
      throw HfosError.notFound(
        'That text isn’t there anymore. Refresh the conversation and try again.',
      );
    if (m.errorCode === CANCELLED_TEXT && m.direction === 'outbound')
      return { messageId: m.id, changed: false, stays: false };
    // It didn't go and isn't going: a retry cancelled already, or refused when quiet hours ended.
    if (m.direction === 'outbound' && (m.status === 'failed' || m.status === 'undelivered'))
      return { messageId: m.id, changed: false, stays: true };
    if (m.errorCode !== SCHEDULED_TEXT || m.status !== 'queued')
      throw HfosError.rule(
        'not_scheduled',
        409,
        'This text isn’t waiting any more: it already went, so it can’t be cancelled.',
      );
    // A failed text tried again (message.retry) was in the conversation, not delivered, before it waited: it goes
    // back as it was, reason and place and all, to be tried again later. A new text never went, so it leaves.
    const was = m.failedAttempt;
    await ctx.tx
      .update(messages)
      .set(
        was
          ? {
              status: was.status,
              errorCode: was.errorCode,
              errorMessage: was.errorMessage,
              occurredAt: new Date(was.occurredAt),
              failedAttempt: null,
            }
          : { errorCode: CANCELLED_TEXT, errorMessage: 'Cancelled before it went.' },
      )
      .where(eq(messages.id, m.id));
    const sendAt = m.occurredAt.toISOString();
    await ctx.emit({
      type: 'message.schedule_cancelled',
      entityType: 'message',
      entityId: m.id,
      payload: { conversationId: m.conversationId, sendAt, ...(was ? { retry: true } : {}) },
      before: { sendAt },
      after: { cancelled: true, ...(was ? { status: was.status } : {}) },
    });
    return { messageId: m.id, changed: true, stays: !!was };
  },
});

/**
 * How long a scheduled text waits when the balance is empty. An hour, because that is how often `wallet.plan`
 * sweeps: a shorter wait would just re-read the same balance, and a longer one would leave a text sitting after
 * the top-up that funded it went through.
 */
const WALLET_WAIT_MS = 60 * 60_000;

export const messageReleaseScheduled = defineCommand({
  name: 'message.release_scheduled',
  description:
    'Worker: quiet hours ended, and a text held for them goes: every check a text passes runs again first, and one that can’t go says why.',
  risk: 2,
  input: MessageReleaseScheduledInput,
  output: MessageReleaseScheduledOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.queued', 'message.failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const outcome = (
      o: 'sent' | 'waiting' | 'cancelled' | 'refused' | 'gone',
      retryAt: Date | null = null,
    ) => ({ messageId: input.messageId, outcome: o, retryAt: retryAt?.toISOString() ?? null });
    const [m] = await ctx.tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, input.messageId), eq(messages.workspaceId, workspaceId)))
      .for('update');
    if (!m || m.direction !== 'outbound' || m.channel !== 'sms') return outcome('gone');
    if (m.errorCode === CANCELLED_TEXT) {
      // Cancelled before it went: it ends there.
      if (m.status === 'queued')
        await ctx.tx.update(messages).set({ status: 'failed' }).where(eq(messages.id, m.id));
      return outcome('cancelled');
    }
    if (m.errorCode !== SCHEDULED_TEXT || m.status !== 'queued') return outcome('gone');
    const now = new Date();
    if (m.occurredAt.getTime() > now.getTime() + 1000) return outcome('waiting', m.occurredAt);
    const conv = await loadConversation(ctx, m.conversationId);
    const settings = await workspaceMessaging(ctx.tx, workspaceId);
    // Quiet hours again (their times changed, or this ran very late): it waits for these to end too.
    const again = quietHoursEndAt(settings.settings.quietHours, settings.timezone, now);
    if (again) {
      await ctx.tx.update(messages).set({ occurredAt: again }).where(eq(messages.id, m.id));
      return outcome('waiting', again);
    }
    try {
      await assertCanText(ctx, conv, { acknowledgeQuietHours: true, skipQuietHours: true });
    } catch (e) {
      if (!(e instanceof HfosError) || e.status >= 500) throw e;
      const errorCode = e.rule ?? e.code;
      // An empty balance is the one refusal that undoes itself. STOP and a switched-off number are decisions;
      // this is a card that hasn't been charged yet, so the text keeps its place in the queue, says why it is
      // still waiting, and goes on its own once the balance is topped up.
      if (errorCode === 'wallet_empty') {
        const later = new Date(now.getTime() + WALLET_WAIT_MS);
        await ctx.tx
          .update(messages)
          .set({ occurredAt: later, errorMessage: e.message })
          .where(eq(messages.id, m.id));
        return outcome('waiting', later);
      }
      // The customer texted STOP overnight, or texting was switched off: it doesn't go, and says why.
      await ctx.tx
        .update(messages)
        .set({ status: 'failed', errorCode, errorMessage: e.message, failedAttempt: null })
        .where(eq(messages.id, m.id));
      await ctx.emit({
        type: 'message.failed',
        entityType: 'message',
        entityId: m.id,
        payload: { conversationId: m.conversationId, status: 'failed', errorCode },
        before: { status: 'queued' },
        after: { status: 'failed', channel: 'sms', errorCode, errorMessage: e.message },
      });
      return outcome('refused');
    }
    // It goes now: from this moment it is on the timeline and in the conversation, and the worker sends it.
    const preview = messagePreview(m.bodyText, m.media.length);
    // A failed text tried again in quiet hours (message.retry) goes in place of the attempt that failed. One held
    // before that attempt was kept is known by its timeline entry.
    const retry = m.failedAttempt !== null || m.activityId !== null;
    const eventId = await ctx.emit({
      type: 'message.queued',
      entityType: 'message',
      entityId: m.id,
      payload: {
        conversationId: conv.id,
        personId: conv.personId,
        channel: 'sms',
        mediaCount: m.media.length,
        scheduled: true,
        // Like message.retry's own: the worker sends it despite the provider id the failed attempt left.
        ...(retry ? { retry: true, replacesProviderMessageId: m.providerMessageId } : {}),
      },
      after: {
        to: formatPhone(conv.counterpart),
        preview: preview.slice(0, 80),
        segments: m.segments,
        mediaCount: m.media.length,
      },
    });
    await ctx.tx
      .update(messages)
      .set({ errorCode: null, occurredAt: now, failedAttempt: null })
      .where(eq(messages.id, m.id));
    // A text that went before is in the conversation already, and on the timeline (or joins it when the conversation
    // is linked). One that never went (held from the start, or refused when quiet hours ended and tried again) gets
    // both now.
    if (!m.went) await goesFirstTime(ctx, m, conv, eventId, now, true);
    return outcome('sent');
  },
});

/**
 * The sender's bookings HandsFreeOS asked them to confirm that are still ahead (locked): a reply of C confirms
 * the ones not yet confirmed. By the number the booking gave (the ask went there).
 */
async function askedSeats(ctx: CommandContext, phone: string, at: Date) {
  return rows<{ id: string; appointment_id: string; confirmed: boolean }>(
    ctx.tx,
    sql`select a.id, a.appointment_id, a.confirmed_at is not null as confirmed
        from app.appointment_attendees a join app.appointments p on p.id = a.appointment_id
        where a.workspace_id = ${ctx.scope.workspaceId!} and a.contact_phone_e164 = ${phone}
          and a.confirm_asked_at is not null and a.status = 'booked'
          and p.status = 'scheduled' and p.starts_at > ${at.toISOString()}::timestamptz
        order by p.starts_at, a.id
        for update of a`,
  );
}

/** How long a list the business texted stays answerable by number: a week, the life of an ordinary ask. */
const CHOICE_WINDOW_MS = 7 * 86_400_000;

/**
 * Which button a customer's reply came from (0103), when it came from one.
 *
 * - **A tap on RCS** carries the id we gave the button (`ButtonPayload`), and the id names its message, so an
 *   old message's button is found as surely as the newest one's. A button that could not carry an id comes
 *   back with its name instead, and is matched on that.
 * - **A choice texted back** to the list a phone without RCS got — "2", or the button's own name — answers the
 *   latest rich text in the thread, for a week. A number only counts when that text did not go over RCS: an RCS
 *   phone showed buttons, not numbers, so a "2" from one is just a 2.
 *
 * The reply's words stay what the customer sent (the button's name, for a tap), so everything that reads a
 * message's text reads it as what they chose.
 */
async function buttonReplyFor(
  ctx: CommandContext,
  conversationId: string,
  input: z.infer<typeof MessageReceiveInput>,
  mediaCount: number,
  at: Date,
): Promise<ButtonReply | null> {
  if (!input.button && (mediaCount > 0 || !input.body.trim())) return null;
  const recent = await ctx.tx
    .select({
      id: messages.id,
      rich: messages.rich,
      transport: messages.transport,
      occurredAt: messages.occurredAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        isNotNull(messages.rich),
      ),
    )
    .orderBy(desc(messages.occurredAt))
    .limit(20);
  if (input.button) {
    const payload = input.button.payload;
    const tag = payload && /^[0-9a-f]{8}\./.test(payload) ? payload.slice(0, 8) : null;
    const theirs = tag ? recent.filter((m) => m.id.replace(/-/g, '').startsWith(tag)) : [];
    for (const m of [...theirs, ...recent]) {
      const b = m.rich && buttonForTap(m.rich, payload, input.button.text ?? input.body);
      if (b) return buttonReplyOf(b, m.id, 'tap');
    }
    // A button we did not make (a template sent from somewhere else): still a tap, named by what it said.
    const title = (input.button.text || input.body || payload || '').trim().slice(0, 120);
    if (!title) return null;
    const kind = (input.button.type ?? '').toUpperCase();
    const type = /URL|LINK/.test(kind) ? 'link' : /PHONE|CALL/.test(kind) ? 'call' : 'reply';
    return { type, title, id: payload?.slice(0, 200) || null, messageId: null, via: 'tap' };
  }
  const latest = recent[0];
  if (!latest?.rich || at.getTime() - latest.occurredAt.getTime() > CHOICE_WINDOW_MS) return null;
  if (latest.transport === 'rcs' && /^\s*#?\s*\d/.test(input.body)) return null;
  const choice = replyChoices(latest.rich).length ? choiceForText(latest.rich, input.body) : null;
  return choice ? buttonReplyOf(choice.button, latest.id, 'text') : null;
}

export const messageReceive = defineCommand({
  name: 'message.receive',
  description:
    'Worker: a customer texted the business number, or wrote to its RCS sender. Files it in the conversation, notes which button it came from, handles STOP and START, confirms their appointments when they reply C (or YES while asked), and starts the reply reminder.',
  risk: 1,
  input: MessageReceiveInput,
  output: MessageReceiveOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: [
    'message.received',
    // A customer tapped a link or call button on an RCS message (0103): noted, never a reply to answer.
    'message.action_tapped',
    'conversation.linked',
    // A number nobody knows becomes a customer and a lead here (M14), unless the business turned that off.
    'person.created',
    'lead.created',
    'person.opted_out',
    'person.opted_in',
    'attendee.confirmed',
  ],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [dup] = await ctx.tx
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .where(
        and(eq(messages.workspaceId, workspaceId), eq(messages.dedupeKey, input.providerMessageId)),
      );
    if (dup)
      return {
        messageId: dup.id,
        conversationId: dup.conversationId,
        duplicate: true,
        keyword: null,
        confirmedAttendeeIds: [],
      };

    // An RCS message comes to the business's sender rather than to one of its numbers (0103).
    const viaRcs = input.via === 'rcs';
    const [ours] = viaRcs
      ? []
      : await ctx.tx
          .select({ id: phoneNumbers.id })
          .from(phoneNumbers)
          .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.e164, input.to)))
          .limit(1);
    const at = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const mediaCount = Math.max(input.media.length, input.mediaCount);
    const smsWord = mediaCount === 0 ? smsKeyword(input.body) : null;
    let matched = await matchPersonByPhone(ctx.tx, workspaceId, input.from);
    // Nobody we know: lead intake (M14) makes the customer and their lead, so the workflows, the AI
    // teammate and the Action Center that wait on a new lead all start from this first text. A STOP, a HELP
    // or "please stop texting me" is an instruction rather than a lead, and our own numbers and the team's
    // cells are never one.
    let intake: IntakeResult | null = null;
    if (
      !matched &&
      !notALead(smsWord, input.body) &&
      !(await isOwnNumber(ctx.tx, workspaceId, input.from))
    ) {
      intake = await intakeFromChannel(
        ctx,
        { kind: 'text', phone: input.from, how: 'texted in', at },
        await workspaceZone(ctx.tx, workspaceId),
      );
      matched = intake?.personId ?? null;
    }
    /*
     * **An RCS message joins the thread the customer already has.** Their phone shows the business's RCS
     * messages as one thread whichever of its numbers the words came from, so a reply belongs with whatever
     * they last talked about — which is `findOrCreateConversation`'s own rule when no line is named. Only a
     * customer nobody has texted starts a thread, on the line the business chose for its sender.
     */
    const line = viaRcs
      ? (await latestConversation(ctx.tx, workspaceId, 'sms', input.from))
        ? null
        : await rcsLine(ctx.tx, workspaceId)
      : (ours?.id ?? null);
    const { conversation: conv, created } = await findOrCreateConversation(ctx, {
      channel: 'sms',
      counterpart: input.from,
      personId: matched,
      phoneNumberId: line,
    });
    const autoLink = !created && !conv.personId && !!matched;
    const buttonReply = await buttonReplyFor(ctx, conv.id, input, mediaCount, at);
    // A link or a number tapped on an RCS card is something the customer did, not something they said: it is
    // noted in the thread and never waits for a reply, reopens the conversation or wakes anybody up.
    const actionTap = !!buttonReply && buttonReply.type !== 'reply';
    const personId = conv.personId ?? matched;
    const wasOut = await customerOptedOut(ctx, { ...conv, personId });
    const consentChange =
      smsWord === 'stop' && !wasOut
        ? 'opted_out'
        : smsWord === 'start' && wasOut
          ? 'opted_in'
          : null;
    const m = await workspaceMessaging(ctx.tx, workspaceId);
    // Confirming by reply (M8): C, CONFIRM or CONFIRMED confirms the sender's bookings HandsFreeOS asked about,
    // and so does YES while one is waiting (YES is still START: it opts them in as before). CANCEL is STOP.
    // A button called Confirm confirms however it was chosen: tapped (its words are the body) or texted back
    // by number to the list a phone without RCS got (0103).
    const cWord =
      mediaCount === 0 &&
      (confirmWord(input.body) ||
        (buttonReply?.type === 'reply' && confirmWord(buttonReply.title)));
    // A YES that is a button on some other message ("Want us to add a filter? Yes / No") answers that message,
    // not the ask to confirm a visit. A button called Confirm still confirms: it says so.
    const yes = smsWord === 'start' && yesWord(input.body) && !buttonReply;
    const asked =
      (cWord || yes) && attentionSettingsOf(m.rawSettings).replyToConfirm
        ? await askedSeats(ctx, input.from, at)
        : [];
    const toConfirm = asked.filter((a) => !a.confirmed);
    // A C is a confirmation while they have an ask (a second C changes nothing); a YES only while one is waiting.
    const confirming = cWord ? asked.length > 0 : yes && toConfirm.length > 0;
    const keyword = cWord && confirming ? ('confirm' as const) : smsWord;
    // A STOP and a confirmation aren't questions for the team; everything else waits for a reply. A confirmation
    // doesn't reopen the conversation either: it's recorded on the booking.
    const needsReply = smsWord !== 'stop' && !confirming && !actionTap;
    // Neither a confirmation nor a tapped link reopens the conversation: both are recorded where they belong.
    const quietly = confirming || actionTap;
    const preview = messagePreview(input.body, mediaCount);
    const messageId = randomUUID();
    const transport = viaRcs ? 'rcs' : mediaCount > 0 ? 'mms' : 'sms';

    const eventId = await ctx.emit({
      type: actionTap ? 'message.action_tapped' : 'message.received',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId,
        channel: 'sms',
        mediaCount,
        keyword,
        reopened: !quietly && conv.status !== 'open',
        transport,
        ...(buttonReply
          ? {
              button: {
                title: buttonReply.title,
                type: buttonReply.type,
                id: buttonReply.id,
                messageId: buttonReply.messageId,
                via: buttonReply.via,
              },
            }
          : {}),
        ...(confirming ? { confirmedAttendeeIds: toConfirm.map((a) => a.id) } : {}),
      },
      after: {
        from: formatPhone(input.from),
        preview: preview.slice(0, 80),
        ...(viaRcs ? { via: 'RCS' } : {}),
        ...(buttonReply ? { button: buttonReply.title } : {}),
      },
    });
    const activityId = await logChannelActivity(ctx, {
      kind: 'sms',
      subtype: 'inbound',
      personId,
      body: input.body || preview,
      occurredAt: at,
      eventId,
      meta: {
        direction: 'inbound',
        messageId,
        conversationId: conv.id,
        mediaCount,
        transport,
        ...(keyword ? { keyword } : {}),
        ...(buttonReply ? { button: buttonReply.title } : {}),
      },
    });
    await ctx.tx.insert(messages).values({
      id: messageId,
      workspaceId,
      conversationId: conv.id,
      channel: 'sms',
      direction: 'inbound',
      status: 'received',
      fromAddress: input.from,
      toAddresses: [input.to],
      bodyText: input.body || null,
      media: input.media,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      dedupeKey: input.providerMessageId,
      segments: input.body ? smsSegments(input.body).segments : 0,
      occurredAt: at,
      activityId,
      transport,
      buttonReply,
    });
    await ctx.tx
      .update(conversations)
      .set({
        lastMessageAt: at,
        lastInboundAt: at,
        lastPreview: preview || null,
        lastDirection: 'inbound',
        ...(quietly
          ? {}
          : {
              unreadCount: sql`${conversations.unreadCount} + 1`,
              status: 'open' as const,
              snoozedUntil: null,
              closedAt: null,
              closedBy: null,
            }),
        ...(needsReply
          ? {
              awaitingReplySince: sql`coalesce(${conversations.awaitingReplySince}, ${at.toISOString()}::timestamptz)`,
            }
          : {}),
        ...(autoLink ? { personId } : {}),
        ...(!conv.phoneNumberId && ours ? { phoneNumberId: ours.id } : {}),
      })
      .where(eq(conversations.id, conv.id));

    if (autoLink && personId) {
      const [p] = await ctx.tx
        .select({ firstName: people.firstName, lastName: people.lastName })
        .from(people)
        .where(eq(people.id, personId));
      await ctx.emit({
        type: 'conversation.linked',
        entityType: 'conversation',
        entityId: conv.id,
        payload: { personId, previousPersonId: null, phoneAdded: false, auto: true },
        before: { person: null },
        after: {
          person: p ? fullName(p.firstName, p.lastName) : null,
          with: formatPhone(input.from),
        },
      });
    }
    if (consentChange) {
      const optedOut = consentChange === 'opted_out';
      await setConsent(ctx, {
        counterpart: input.from,
        personId,
        optedOut,
        source: 'keyword',
        keyword: input.body.trim().slice(0, 40),
        phoneNumberId: ours?.id ?? null,
        at,
      });
      await ctx.emit({
        type: optedOut ? 'person.opted_out' : 'person.opted_in',
        entityType: personId ? 'person' : 'conversation',
        entityId: personId ?? conv.id,
        payload: { conversationId: conv.id, source: 'keyword', keyword: smsWord },
        after: { number: formatPhone(input.from), smsConsent: consentChange },
      });
    }
    const confirmedAttendeeIds: string[] = [];
    if (confirming)
      for (const a of toConfirm) {
        const [seat] = await ctx.tx
          .update(appointmentAttendees)
          .set({ confirmedAt: at, confirmedVia: 'sms', confirmedBy: null })
          .where(eq(appointmentAttendees.id, a.id))
          .returning({ id: appointmentAttendees.id, personId: appointmentAttendees.personId });
        if (!seat) continue;
        const appt = await requireAppointment(ctx.tx, workspaceId, a.appointment_id);
        await announceConfirmed(ctx, appt, seat, 'sms', { messageId, conversationId: conv.id });
        confirmedAttendeeIds.push(seat.id);
      }
    const reminderMs = input.reminderAfterMs ?? m.settings.unansweredReminderMinutes * 60_000;
    if (needsReply && reminderMs > 0)
      await scheduleJob(ctx.tx, {
        kind: 'conversation.unanswered_check',
        dedupeKey: `unanswered:${conv.id}`,
        runAt: new Date(at.getTime() + reminderMs),
        payload: { conversationId: conv.id },
        workspaceId,
        organizationId: m.organizationId,
      });
    return {
      messageId,
      conversationId: conv.id,
      duplicate: false,
      keyword,
      confirmedAttendeeIds,
    };
  },
});

export const messageUpdateStatus = defineCommand({
  name: 'message.update_status',
  description:
    'Worker: the carrier or mail service reported where a message is (sent, delivered, read, failed, bounced or marked as spam), and which way a text actually went.',
  risk: 1,
  input: MessageUpdateStatusInput,
  output: MessageUpdateStatusOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: [
    'message.sent',
    'message.delivered',
    // RCS: the customer opened it (0103).
    'message.read',
    'message.failed',
    'message.bounced',
    'message.complained',
    'person.opted_out',
  ],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [m] = input.messageId
      ? await ctx.tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, input.messageId), eq(messages.workspaceId, workspaceId)))
      : await ctx.tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.workspaceId, workspaceId),
              eq(messages.providerMessageId, input.providerMessageId!),
            ),
          )
          .limit(1);
    if (!m) throw HfosError.notFound('Message not found.');
    if (m.direction !== 'outbound')
      throw HfosError.rule(
        'message_status_transition',
        409,
        'Received messages keep their status.',
      );
    const now = new Date();
    /*
     * A retry's send (message.retry) is a new attempt. The one that failed left its provider id behind; the new
     * id takes its place, so the carrier's reports on the new attempt find this message, and the failed
     * attempt's times, template and way it went are forgotten with it. Only while the message still carries
     * that exact id, so a late record of an earlier attempt never undoes a later one.
     */
    const retried =
      !!input.messageId &&
      !!input.providerMessageId &&
      !!input.replacesProviderMessageId &&
      input.replacesProviderMessageId === m.providerMessageId;
    const fresh = {
      providerMessageId: null,
      contentSid: null,
      transport: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
    };
    const attempt = retried ? fresh : m;
    const patch: Partial<typeof messages.$inferInsert> = {
      status: input.status,
      ...(retried ? fresh : {}),
    };
    if (input.errorCode !== undefined) patch.errorCode = input.errorCode;
    if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage;
    if (input.segments !== undefined) patch.segments = input.segments;
    if (input.messageIdHeader && input.messageIdHeader !== m.messageIdHeader) {
      patch.messageIdHeader = input.messageIdHeader;
      patch.dedupeKey = emailDedupeKey(input.messageIdHeader);
    }
    if (input.messageId && input.providerMessageId && !attempt.providerMessageId) {
      patch.providerMessageId = input.providerMessageId;
      if (!m.dedupeKey) patch.dedupeKey = input.providerMessageId;
    }
    if (input.contentSid && m.channel === 'sms' && !attempt.contentSid)
      patch.contentSid = input.contentSid;
    const reached = input.status === 'delivered' || input.status === 'read';
    if ((input.status === 'sent' || reached) && !attempt.sentAt) patch.sentAt = now;
    if (reached && !attempt.deliveredAt) patch.deliveredAt = now;
    if (input.status === 'read' && !attempt.readAt) patch.readAt = now;
    /*
     * Which way it went (0103). An RCS-first text learns it from its callbacks: `rcs:` in their `From` when it
     * went over RCS, the thread's number when Twilio fell back to SMS or MMS. Callbacks arrive out of order, so a
     * callback only says which way it went when it is at least as far along as what we know — a late RCS `sent`
     * must not relabel a text that was delivered as an SMS.
     */
    if (
      m.channel === 'sms' &&
      input.transport &&
      input.transport !== attempt.transport &&
      (!attempt.transport || statusRank(input.status) >= statusRank(m.status))
    )
      patch.transport = input.transport;
    const [after] = await ctx.tx
      .update(messages)
      .set(patch)
      .where(eq(messages.id, m.id))
      .returning({ status: messages.status });
    const status = after?.status ?? m.status;
    const changed = status !== m.status;
    if (changed) {
      const failed = status === 'failed' || status === 'undelivered';
      const type =
        status === 'delivered'
          ? 'message.delivered'
          : status === 'read'
            ? 'message.read'
            : status === 'bounced'
              ? 'message.bounced'
              : status === 'complained'
                ? 'message.complained'
                : failed
                  ? 'message.failed'
                  : status === 'sent'
                    ? 'message.sent'
                    : null;
      if (type)
        await ctx.emit({
          type,
          entityType: 'message',
          entityId: m.id,
          payload: { conversationId: m.conversationId, status, errorCode: input.errorCode ?? null },
          before: { status: m.status },
          after: {
            status,
            channel: m.channel,
            errorCode: input.errorCode ?? null,
            errorMessage: input.errorMessage ?? null,
          },
          // "sent" is a waypoint: only the outcome refreshes open screens. Mail sent through a connected
          // mailbox gets no delivery report, so for it "sent" is the outcome.
          broadcast: type !== 'message.sent' || m.mailboxConnectionId !== null,
        });
      if (
        m.activityId &&
        (failed ||
          status === 'delivered' ||
          status === 'read' ||
          status === 'bounced' ||
          status === 'complained')
      )
        await ctx.tx
          .update(activities)
          .set({ meta: sql`${activities.meta} || ${JSON.stringify({ status })}::jsonb` })
          .where(eq(activities.id, m.activityId));
    }
    if (m.channel === 'sms' && input.errorCode === UNSUBSCRIBED_ERROR && m.toAddresses[0]) {
      const conv = await loadConversation(ctx, m.conversationId);
      if (!(await customerOptedOut(ctx, conv))) {
        await setConsent(ctx, {
          counterpart: m.toAddresses[0],
          personId: conv.personId,
          optedOut: true,
          source: 'carrier_error',
          at: now,
        });
        await ctx.emit({
          type: 'person.opted_out',
          entityType: conv.personId ? 'person' : 'conversation',
          entityId: conv.personId ?? conv.id,
          payload: { conversationId: conv.id, source: 'carrier_error' },
          after: { number: formatPhone(m.toAddresses[0]), smsConsent: 'opted_out' },
        });
      }
    }
    return { messageId: m.id, status, changed };
  },
});

export const messageAttachMedia = defineCommand({
  name: 'message.attach_media',
  description: 'Worker: photos from a picture message were copied into HandsFreeOS storage.',
  risk: 1,
  input: MessageAttachMediaInput,
  output: MessageAttachMediaOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.media_attached'],
  actors: ['system'],
  async handler(ctx, input) {
    const [m] = await ctx.tx
      .select()
      .from(messages)
      .where(
        and(eq(messages.id, input.messageId), eq(messages.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!m) throw HfosError.notFound('Message not found.');
    const known = new Set(m.media.map((x) => x.objectPath));
    const added = input.media.filter((x) => !known.has(x.objectPath));
    if (added.length === 0) return { messageId: m.id };
    const media = [...m.media, ...added].slice(0, 10);
    await ctx.tx.update(messages).set({ media }).where(eq(messages.id, m.id));
    await ctx.emit({
      type: 'message.media_attached',
      entityType: 'message',
      entityId: m.id,
      payload: { conversationId: m.conversationId, count: media.length },
      after: { photos: media.length },
    });
    return { messageId: m.id };
  },
});

export const personSetSmsConsent = defineCommand({
  name: 'person.set_sms_consent',
  description:
    'Record that a customer asked not to be texted (or agreed to texts again) outside of a STOP or START text.',
  risk: 1,
  input: PersonSetSmsConsentInput,
  output: PersonSetSmsConsentOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['person.opted_out', 'person.opted_in'],
  async handler(ctx, input) {
    const person = await requirePerson(ctx.tx, ctx.scope.workspaceId!, input.personId);
    if (person.smsConsent === input.consent) return { personId: person.id, consent: input.consent };
    const optedOut = input.consent === 'opted_out';
    await setConsent(ctx, {
      counterpart: person.phoneE164,
      personId: person.id,
      optedOut,
      source: 'manual',
      at: new Date(),
    });
    await ctx.emit({
      type: optedOut ? 'person.opted_out' : 'person.opted_in',
      entityType: 'person',
      entityId: person.id,
      payload: { source: 'manual' },
      before: { smsConsent: person.smsConsent },
      after: { name: fullName(person.firstName, person.lastName), smsConsent: input.consent },
    });
    return { personId: person.id, consent: input.consent };
  },
});

/**
 * A customer asked in their own words not to be contacted ("stop texting me", "unsubscribe"): any reasonable
 * request to stop counts. Recorded exactly as a STOP text is: their number can't be texted (opt_outs, which
 * works for someone with no customer record), and their customer record says opted out when the conversation
 * has one. It only ever opts out, and the message itself must say so, so it can't be pointed at anyone else. An
 * email's opt-out stops texts to the customer on file too. A website chat's visitor isn't verified (anyone can
 * type someone's number), so a chat's opt-out goes to a person instead.
 */
export const messageRecordOptOut = defineCommand({
  name: 'message.record_opt_out',
  description:
    'Worker: a customer asked in their own words to stop getting texts (“stop texting me”). Records it the way a STOP text is recorded. It only ever opts out.',
  risk: 1,
  input: MessageRecordOptOutInput,
  output: MessageRecordOptOutOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['person.opted_out'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [m] = await ctx.tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, input.messageId), eq(messages.workspaceId, workspaceId)));
    if (!m) throw HfosError.notFound('Message not found.');
    const words = m.direction === 'inbound' ? optOutPhrase(m.bodyText ?? '') : null;
    if (!words)
      throw HfosError.rule(
        'not_an_opt_out',
        409,
        'Only a customer’s own message asking to stop can opt them out.',
      );
    const conv = await loadConversation(ctx, m.conversationId);
    if (conv.channel === 'chat') throw chatIdentityUnverified();
    const [person] = conv.personId
      ? await ctx.tx
          .select({ phone: people.phoneE164, consent: people.smsConsent })
          .from(people)
          .where(eq(people.id, conv.personId))
      : [];
    const number = conv.channel === 'sms' ? conv.counterpart : (person?.phone ?? null);
    const unchanged = { conversationId: conv.id, personId: conv.personId, number, changed: false };
    if (!number && !person) return unchanged;
    const numberOut = number ? await isOptedOut(ctx.tx, workspaceId, number) : true;
    if (numberOut && (!person || person.consent === 'opted_out')) return unchanged;
    await setConsent(ctx, {
      counterpart: number,
      personId: person ? conv.personId : null,
      optedOut: true,
      source: 'keyword',
      keyword: words.slice(0, 40),
      phoneNumberId: conv.phoneNumberId,
      at: new Date(),
    });
    await ctx.emit({
      type: 'person.opted_out',
      entityType: person ? 'person' : 'conversation',
      entityId: person ? conv.personId : conv.id,
      payload: { conversationId: conv.id, messageId: m.id, source: 'keyword', keyword: null },
      after: {
        number: number ? formatPhone(number) : null,
        smsConsent: 'opted_out',
        words: words.slice(0, 120),
      },
    });
    return { conversationId: conv.id, personId: conv.personId, number, changed: true };
  },
});
