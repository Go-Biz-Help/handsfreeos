/**
 * Handing a conversation to a person (plan M7, "Handing to a person"): as the teammate, in the conversation it's
 * answering, or as the worker (a loop, the daily reply cap, an expired draft, an approved draft that couldn't go
 * out).
 *
 * While the teammate still has the conversation it first tells the customer, as itself: the business's hand-off
 * line with {expectation} filled in from its open hours, or for an emergency the fixed safety text. It's the
 * business's own wording, never AI-written, so it goes out at once (never as a draft) and once per hand-off
 * (clientId handoff:<conversation>:<epoch>), after budget and error hand-offs too. It answers their latest
 * message, so the quiet-hours reply window applies. Past the window a text's line goes by email when they have
 * an address, and otherwise when quiet hours end (the handoff_line job), unless a person has written by then.
 * Core refuses the teammate's messages once a person has the conversation, so the line goes first, in the
 * hand-off's transaction. What the team hears follows the event (escalation.ts).
 */
import { eq } from 'drizzle-orm';
import {
  conversationHandOff,
  EMERGENCY_SAFETY_TEXT,
  emergencyKind,
  executeCommandIn,
  HfosError,
  loadTeammate,
  messageSend,
  openHoursOf,
  outsideItsConversation,
  plainSmsText,
  scheduleJob,
  workspaceMessaging,
  type AiEmployeeActor,
  type ConversationHandoffReason,
  type EmergencyKind,
  type RequestMeta,
  type WorkspaceMessaging,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { quietEndAt } from '../booking/deliver';
import type { JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { runtimeConfigOf } from './config';
import { handoffClientId, handoffLineJobKey, QUIET_GRACE_MS, TEAMMATE_JOBS } from './constants';
import { handoffExpectation, handoffLine } from './hours';

const NOTE_MAX = 500;

type Conversation = typeof conversations.$inferSelect;

/**
 * What the customer is told as their conversation goes to a person: the business's line, the safety text for an
 * emergency, or nothing (a loop with another bot, which a line would only feed; they asked not to be contacted).
 */
export type HandoffLine = 'usual' | 'none' | { readonly emergency: EmergencyKind };

const lineFor = (reason: ConversationHandoffReason): HandoffLine =>
  reason === 'loop' ? 'none' : 'usual';

/** The first emergency these messages describe (a hand-off the model made with reason emergency). */
export function emergencyIn(texts: readonly string[]): EmergencyKind | null {
  for (const t of texts) {
    const kind = emergencyKind(t);
    if (kind) return kind;
  }
  return null;
}

/** What the line says: the business's words with {expectation} filled in, or the safety text. */
export function lineText(
  line: Exclude<HandoffLine, 'none'>,
  template: string,
  m: WorkspaceMessaging,
  now: number,
): string {
  if (line !== 'usual') return EMERGENCY_SAFETY_TEXT[line.emergency];
  const tz = m.timezone || 'UTC';
  return handoffLine(template, handoffExpectation(openHoursOf(m.rawSettings), tz, now));
}

/** Tells the customer, as the teammate, while it still has the conversation (see the top of the file). */
async function tellCustomer(
  tx: Tx,
  scope: TenantScope,
  conversationId: string,
  line: HandoffLine,
  meta: RequestMeta,
  ai: AiEmployeeActor | null,
): Promise<void> {
  if (line === 'none') return;
  const [conv] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update');
  // Only the teammate's own conversation: once a person has it, they do the talking.
  if (!conv || conv.handledBy !== 'ai' || !conv.aiTeammateId) return;
  if (ai && conv.aiTeammateId !== ai.teammateId) return;
  const teammate = await loadTeammate(tx, scope.workspaceId, { teammateId: conv.aiTeammateId });
  if (!teammate) return;
  const config = runtimeConfigOf(teammate.config);
  const m = await workspaceMessaging(tx, scope.workspaceId);
  const text = lineText(line, config.handOff.tellCustomer, m, Date.now());
  const channel = conv.channel as 'sms' | 'email' | 'chat';
  const body = channel === 'sms' ? plainSmsText(text) : text;
  const clientId = handoffClientId(conv.id, conv.aiEpoch + 1);
  const [latest] =
    channel === 'sms'
      ? await rows<{ id: string }>(
          tx,
          sql`select id from app.messages where conversation_id = ${conv.id} and direction = 'inbound'
              order by occurred_at desc, created_at desc limit 1`,
        )
      : [];
  const actor: AiEmployeeActor = ai ?? {
    type: 'ai_employee',
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
    teammateId: teammate.id,
    teammateName: teammate.name,
    runId: null,
    conversationId: conv.id,
    approvedBy: null,
    origin: null,
    test: false,
  };
  try {
    await executeCommandIn(
      tx,
      messageSend,
      {
        workspaceId: scope.workspaceId,
        conversationId: conv.id,
        channel,
        body,
        clientId,
        // It still waits for a person: unread, and the unanswered alert keeps counting.
        keepConversationStatus: true,
        ...(latest ? { inReplyToMessageId: latest.id } : {}),
        ...(channel === 'email' && config.channels.emailAddressId
          ? { emailAddressId: config.channels.emailAddressId }
          : {}),
      },
      actor,
      { ...meta, channel: 'ai_employee' },
    );
  } catch (e) {
    if (!(e instanceof HfosError)) throw e;
    if (e.rule === 'quiet_hours') await sendLater(tx, scope, conv, body, clientId, m, meta);
    // Anything else (they opted out, the address stopped taking mail): whoever picks it up writes to them.
  }
}

/** A text's line past the quiet-hours reply window: by email now when they have an address, else after quiet hours. */
async function sendLater(
  tx: Tx,
  scope: TenantScope,
  conv: Conversation,
  body: string,
  clientId: string,
  m: WorkspaceMessaging,
  meta: RequestMeta,
): Promise<void> {
  const [person] = conv.personId
    ? await rows<{ email: string | null }>(
        tx,
        sql`select email from app.people where id = ${conv.personId}`,
      )
    : [];
  if (conv.personId && person?.email)
    try {
      await executeCommandIn(
        tx,
        messageSend,
        {
          workspaceId: scope.workspaceId,
          personId: conv.personId,
          channel: 'email',
          subject: `A message from ${m.name}`,
          body,
          clientId: `${clientId}:email`,
          keepConversationStatus: true,
        },
        systemActor(scope),
        workerMeta(meta.correlationId, meta.causationId),
      );
      return;
    } catch (e) {
      if (!(e instanceof HfosError)) throw e;
      // No address to send from, or theirs stopped taking mail: the text waits for the morning instead.
    }
  const end = quietEndAt(m.settings.quietHours, m.timezone, Date.now()) ?? Date.now() + 5 * 60_000;
  await scheduleJob(tx, {
    kind: TEAMMATE_JOBS.handoffLine,
    dedupeKey: handoffLineJobKey(conv.id),
    runAt: new Date(end + QUIET_GRACE_MS),
    payload: { conversationId: conv.id, clientId, body },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
}

/**
 * `ai_teammate.handoff_line`: a line quiet hours held back, once they end, as the worker (a person has the
 * conversation now). Skipped when someone on the team has written to them or taken it over since.
 */
export const handoffLineJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.job.payload;
  const conversationId = typeof p['conversationId'] === 'string' ? p['conversationId'] : null;
  const clientId = typeof p['clientId'] === 'string' ? p['clientId'] : null;
  const body = typeof p['body'] === 'string' ? p['body'] : null;
  if (!conversationId || !clientId || !body) return;
  return asWorker(ctx.db, scope, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!conv || conv.handledBy !== 'person' || !conv.needsPersonSince || conv.takenOverBy) return;
    const [wrote] = await rows(
      tx,
      sql`select 1 from app.messages where conversation_id = ${conv.id} and direction = 'outbound'
            and sent_by is not null and created_at >= ${conv.needsPersonSince.toISOString()}::timestamptz
          limit 1`,
    );
    if (wrote) return;
    try {
      await executeCommandIn(
        tx,
        messageSend,
        {
          workspaceId: scope.workspaceId,
          conversationId: conv.id,
          channel: conv.channel,
          body,
          clientId,
          keepConversationStatus: true,
        },
        systemActor(scope),
        workerMeta(null, ctx.job.id),
      );
    } catch (e) {
      if (!(e instanceof HfosError)) throw e;
      if (e.rule === 'quiet_hours') {
        const m = await workspaceMessaging(tx, scope.workspaceId);
        const end =
          quietEndAt(m.settings.quietHours, m.timezone, Date.now()) ?? Date.now() + 5 * 60_000;
        return { rescheduleAt: new Date(end + QUIET_GRACE_MS) };
      }
      ctx.log.warn(
        { err: e.message, rule: e.rule, conversationId },
        'a hand-off line couldn’t go out',
      );
    }
    return undefined;
  });
};

export interface HandOffOptions {
  /** What the customer is told first (default: nothing for a loop, the usual line otherwise). */
  readonly line?: HandoffLine;
}

/** As the worker: the customer hears the line first while the teammate still has the conversation. */
export async function handOffAsSystem(
  tx: Tx,
  scope: TenantScope,
  conversationId: string,
  reason: ConversationHandoffReason,
  note: string,
  meta: RequestMeta,
  opts: HandOffOptions = {},
): Promise<void> {
  await tellCustomer(tx, scope, conversationId, opts.line ?? lineFor(reason), meta, null);
  await executeCommandIn(
    tx,
    conversationHandOff,
    { workspaceId: scope.workspaceId, conversationId, reason, note: note.slice(0, NOTE_MAX) },
    systemActor(scope),
    meta,
  );
}

/**
 * As the teammate, in the conversation it's answering: the line, then the hand-off. Throws the kernel's refusal
 * when it isn't the teammate's to hand off anymore (a person took it over while it worked).
 */
export async function handOffInConversation(
  tx: Tx,
  ai: AiEmployeeActor,
  meta: RequestMeta,
  reason: ConversationHandoffReason,
  note: string,
  opts: HandOffOptions = {},
): Promise<void> {
  if (!ai.conversationId) throw outsideItsConversation();
  const scope = { workspaceId: ai.workspaceId, organizationId: ai.organizationId };
  await tellCustomer(tx, scope, ai.conversationId, opts.line ?? lineFor(reason), meta, ai);
  await executeCommandIn(
    tx,
    conversationHandOff,
    {
      workspaceId: ai.workspaceId,
      conversationId: ai.conversationId,
      reason,
      note: note.slice(0, NOTE_MAX),
    },
    ai,
    meta,
  );
}

/**
 * As the teammate, in the conversation it's answering. False when it isn't its to hand off anymore (a person
 * took it over while it worked): the run is then superseded, quietly.
 */
export async function handOffAsAi(
  tx: Tx,
  ai: AiEmployeeActor,
  meta: RequestMeta,
  reason: ConversationHandoffReason,
  note: string,
  opts: HandOffOptions = {},
): Promise<boolean> {
  if (!ai.conversationId) return false;
  try {
    await handOffInConversation(tx, ai, meta, reason, note, opts);
    return true;
  } catch (e) {
    if (
      e instanceof HfosError &&
      (e.rule === 'not_handled_by_ai' || e.rule === 'outside_its_conversation')
    )
      return false;
    throw e;
  }
}
