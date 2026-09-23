/**
 * What starts the AI teammate (plan M7, "What starts a run"). `withTeammate(handlers)` adds these to the
 * worker's event handlers, ahead of the workflow dispatcher, in the same outbox transaction (so each is safe to
 * run again):
 * - `message.received` (text, email and chat): the teammate replies when it's on, answers that channel and is
 *   working now; the conversation is its own, or nobody's and unassigned; the message isn't a carrier keyword
 *   or an automatic email; no loop with another bot shows; and today's reply cap isn't reached. A pending draft
 *   no longer fits (the customer wrote again), so it's dropped, and one debounced `ai_teammate.reply` job per
 *   conversation is queued. A plain-language opt-out ("stop texting me") opts them out instead, in any
 *   conversation, the way STOP does (message.record_opt_out).
 * - `conversation.handed_to_ai`: it answers what's waiting (a workflow's hand-over carries its loop guard).
 * - `ai_teammate.draft_decided`: an approved draft goes out (drafts.ts).
 * - `lead.created`: a first message to the new lead, after the Respond skill's delay (outreach.ts).
 * - `conversation.handed_off`: the team's email, the urgent alert, M3's unanswered alert and the budget notice
 *   (escalation.ts).
 * A website chat gets replies only when its widget names the teammate (gates.ts widgetAnswers).
 */
import { eq } from 'drizzle-orm';
import {
  executeCommandIn,
  HfosError,
  loadTeammate,
  messageRecordOptOut,
  openHoursOf,
  optOutPhrase,
  smsKeyword,
  type AiEmployeeOrigin,
  type RequestMeta,
  type TeammateChannel,
  type TeammateConfig,
  type TeammateRow,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import {
  handlersFor,
  type EventHandler,
  type EventRow,
  type HandlerContext,
  type HandlerMap,
} from '../handlers/types';
import { scheduleDebouncedJob } from '../jobs';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { answersChannel, runtimeConfigOf } from './config';
import { REPLY_CEILING_MS, REPLY_DELAY_MS, replyJobKey, TEAMMATE_JOBS } from './constants';
import { unansweredMessages } from './context';
import { onDraftDecided } from './drafts';
import { onHandedOff } from './escalation';
import { isAutomaticEmail, loopReason, repliesToday, widgetAnswers, workingNow } from './gates';
import { handOffAsSystem } from './handoff';
import { onLeadCreated } from './outreach';
import { originOf } from './run';

type Conversation = typeof conversations.$inferSelect;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const scopeOf = (e: EventRow): TenantScope | null =>
  e.workspaceId && e.organizationId
    ? { workspaceId: e.workspaceId, organizationId: e.organizationId }
    : null;

/**
 * Queues the conversation's reply (one pending per conversation). Each new message pushes it back to the
 * channel's delay from now, but never past 90 seconds after the first message it will answer; a run in progress
 * runs again when it finishes (scheduleDebouncedJob).
 */
export async function scheduleReply(
  tx: Tx,
  input: {
    readonly scope: TenantScope;
    readonly conversationId: string;
    readonly channel: TeammateChannel;
    /** When the first unanswered message was sent. */
    readonly firstAt: number;
    readonly trigger: string;
    /** The workflow run that handed the conversation over: its loop guard, for the run. */
    readonly origin?: AiEmployeeOrigin | null;
    /** "Try again": the person's reason and the draft they rejected, for the run's context. */
    readonly retry?: { readonly reason: string | null; readonly draft: string | null } | null;
  },
): Promise<Date> {
  const runAt = new Date(
    Math.min(Date.now() + REPLY_DELAY_MS[input.channel], input.firstAt + REPLY_CEILING_MS),
  );
  await scheduleDebouncedJob(tx, {
    kind: TEAMMATE_JOBS.reply,
    dedupeKey: replyJobKey(input.conversationId),
    runAt,
    payload: {
      conversationId: input.conversationId,
      trigger: input.trigger,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.retry ? { retry: input.retry } : {}),
    },
    workspaceId: input.scope.workspaceId,
    organizationId: input.scope.organizationId,
    // A retry's reason goes on a reply that was already waiting, too.
    mergePayload: !!input.retry,
  });
  return runAt;
}

/**
 * Moves the conversation's answered-through mark back to just before the messages this run answered, so the
 * next run answers them again (a dropped draft, or a person's "Try again").
 */
export async function rewindToRun(tx: Tx, conversationId: string, runId: string): Promise<void> {
  await tx.execute(
    sql`update app.conversations c set ai_answered_through = b.before
        from (select min(m.occurred_at) - interval '1 millisecond' as before
              from app.ai_teammate_runs r cross join unnest(r.message_ids) as x (id)
              join app.messages m on m.id = x.id
              where r.id = ${runId}) b
        where c.id = ${conversationId} and b.before is not null`,
  );
}

/**
 * Drops the conversation's pending reply draft (the customer wrote again, or asked to stop): 'system' decided
 * it. With `rewind`, the next run answers what the dropped draft answered too: the conversation's
 * answered-through mark goes back to just before that draft's messages. Returns whether one was dropped.
 */
export async function dropPendingDraft(
  tx: Tx,
  conversationId: string,
  reason: string,
  opts: { readonly rewind?: boolean } = {},
): Promise<boolean> {
  const dropped = await rows<{ run_id: string | null }>(
    tx,
    sql`update app.ai_teammate_drafts
        set status = 'cancelled', decided_at = now(), via = 'system', reason = ${reason}
        where conversation_id = ${conversationId} and status = 'pending' and kind = 'reply'
        returning run_id`,
  );
  const runId = dropped[0]?.run_id;
  if (opts.rewind && runId) await rewindToRun(tx, conversationId, runId);
  return dropped.length > 0;
}

async function answeredThroughOf(tx: Tx, conversationId: string): Promise<Date | null> {
  const [c] = await rows<{ at: Date | string | null }>(
    tx,
    sql`select ai_answered_through as at from app.conversations where id = ${conversationId}`,
  );
  return c?.at ? new Date(c.at) : null;
}

async function teammateOn(
  tx: Tx,
  scope: TenantScope,
): Promise<{ teammate: TeammateRow; config: TeammateConfig } | null> {
  const teammate = await loadTeammate(tx, scope.workspaceId);
  if (!teammate || teammate.status === 'off') return null;
  return { teammate, config: runtimeConfigOf(teammate.config) };
}

async function workspaceClock(tx: Tx, workspaceId: string) {
  const [w] = await rows<{ timezone: string | null; settings: unknown }>(
    tx,
    sql`select timezone, settings from app.workspaces where id = ${workspaceId}`,
  );
  return {
    timeZone: w?.timezone || 'UTC',
    openHours: openHoursOf(w?.settings as Record<string, unknown> | null),
  };
}

/** Whether this customer said STOP to texts (their number, or their record). */
async function textsStopped(tx: Tx, workspaceId: string, conv: Conversation): Promise<boolean> {
  const [r] = await rows<{ out: boolean }>(
    tx,
    sql`select exists (select 1 from app.opt_outs o
              where o.workspace_id = ${workspaceId} and o.counterpart_e164 = ${conv.counterpart} and o.opted_out)
            or exists (select 1 from app.people p where p.id = ${conv.personId} and p.sms_consent = 'opted_out') as out`,
  );
  return r?.out ?? false;
}

/**
 * "Stop texting me" opts them out the way STOP does (message.record_opt_out: their number, and their customer
 * record when there is one). A website chat's visitor isn't verified and an email may have nobody on file, so
 * when nothing could be recorded, or it wasn't a text, a person takes over the teammate's conversation, with a
 * note saying what to do. Either way the customer gets no hand-off line: they asked not to be contacted.
 */
async function optOut(
  ctx: HandlerContext,
  scope: TenantScope,
  conv: Conversation,
  messageId: string,
  phrase: string,
  mine: boolean,
  meta: RequestMeta,
): Promise<void> {
  let recorded = false;
  try {
    const { output } = await executeCommandIn(
      ctx.tx,
      messageRecordOptOut,
      { workspaceId: scope.workspaceId, messageId },
      systemActor(scope),
      meta,
    );
    recorded = output.number !== null || output.personId !== null;
  } catch (e) {
    if (!(e instanceof HfosError)) throw e;
    ctx.log.warn(
      { err: e.message, rule: e.rule, conversationId: conv.id },
      'could not record a plain-language opt-out',
    );
  }
  // Texts are refused from now on; any other channel (or an opt-out nobody could record) goes to a person.
  if (mine && (!recorded || conv.channel !== 'sms'))
    await handOffAsSystem(
      ctx.tx,
      scope,
      conv.id,
      'other',
      `They asked not to be contacted (“${phrase.slice(0, 120)}”).${recorded ? '' : ' Record their opt-out.'}`,
      meta,
      { line: 'none' },
    );
}

interface Received {
  readonly channel: TeammateChannel;
  /** The message.received payload. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly subject: string | null;
  readonly from: string | null;
}

/**
 * Why the teammate never answers this message, whatever else holds, or null: a carrier keyword (STOP, START,
 * HELP: message.receive handled it) or an automatic email. One place for each channel's own check.
 */
export function neverAnswered(m: Received): string | null {
  if (str(m.payload['keyword']) || (m.channel === 'sms' && smsKeyword(m.body))) return 'keyword';
  if (m.channel === 'email' && isAutomaticEmail({ from: m.from, subject: m.subject, body: m.body }))
    return 'automatic_email';
  // A chat message the human check couldn't vouch for (Cloudflare down) lands in the inbox; the teammate stays out.
  if (m.channel === 'chat' && m.payload['aiReply'] === false) return 'unverified_chat';
  return null;
}

/** `message.received`: a customer wrote. */
export const onCustomerMessage: EventHandler = async (ctx) => {
  const e = ctx.event;
  const scope = scopeOf(e);
  const p = isRecord(e.payload) ? e.payload : {};
  const conversationId = str(p['conversationId']);
  const channel = str(p['channel']);
  if (!scope || !conversationId || !e.entityId) return;
  if (channel !== 'sms' && channel !== 'email' && channel !== 'chat') return;
  const found = await teammateOn(ctx.tx, scope);
  if (!found) return;
  const { teammate, config } = found;
  const [conv] = await ctx.tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conv) return;
  const [m] = await rows<{
    body_text: string | null;
    subject: string | null;
    from_address: string | null;
    direction: string;
  }>(
    ctx.tx,
    sql`select body_text, subject, from_address, direction::text as direction
        from app.messages where id = ${e.entityId}`,
  );
  if (!m || m.direction !== 'inbound') return;
  const body = m.body_text ?? '';
  const meta = workerMeta(e.correlationId, e.id);
  if (neverAnswered({ channel, payload: p, body, subject: m.subject, from: m.from_address }))
    return;
  const mine = conv.handledBy === 'ai' && conv.aiTeammateId === teammate.id;
  // Any reasonable request to stop counts, whoever has the conversation: it's recorded the way STOP is.
  const phrase = optOutPhrase(body);
  if (phrase) {
    await dropPendingDraft(ctx.tx, conv.id, 'They asked not to be contacted.');
    await optOut(ctx, scope, conv, e.entityId, phrase, mine, meta);
    return;
  }
  if (!answersChannel(config, channel)) return;
  const free = conv.handledBy === 'none' && !conv.assigneeUserId;
  if (!mine && !free) return;
  if (!(await widgetAnswers(ctx.tx, conv, teammate.id))) return;
  if (channel === 'sms' && (await textsStopped(ctx.tx, scope.workspaceId, conv))) return;
  const clock = await workspaceClock(ctx.tx, scope.workspaceId);
  // A lead's own message is answered right away, whatever the teammate's hours (Automations, "New lead
  // greeting"); anyone else waits for them.
  if (
    !workingNow(config, clock.openHours, clock.timeZone, Date.now()) &&
    !(await hasOpenLead(ctx.tx, scope.workspaceId, conv.personId))
  )
    return;
  const loop = await loopReason(ctx.tx, conv.id);
  if (loop) {
    if (mine) await handOffAsSystem(ctx.tx, scope, conv.id, 'loop', loop, meta);
    return;
  }
  const cap = config.limits.repliesPerConversationPerDay;
  if ((await repliesToday(ctx.tx, conv.id, clock.timeZone)) >= cap) {
    if (mine)
      await handOffAsSystem(
        ctx.tx,
        scope,
        conv.id,
        'limit',
        `It reached today’s limit of ${cap} ${cap === 1 ? 'reply' : 'replies'} in this conversation.`,
        meta,
      );
    return;
  }
  // The customer wrote again, so a reply waiting for someone's OK may not fit: the next run answers everything.
  const dropped = await dropPendingDraft(ctx.tx, conv.id, 'The customer wrote again.', {
    rewind: true,
  });
  const batch = await unansweredMessages(
    ctx.tx,
    conv.id,
    dropped ? await answeredThroughOf(ctx.tx, conv.id) : conv.aiAnsweredThrough,
  );
  if (!batch.length) return;
  await scheduleReply(ctx.tx, {
    scope,
    conversationId: conv.id,
    channel,
    firstAt: batch[0]!.at,
    trigger: e.eventType,
  });
};

/** `conversation.handed_to_ai`: a person handed it back, so the teammate answers what's waiting. */
/** They have an open lead: a lead is answered at once, whatever the teammate's hours. */
async function hasOpenLead(tx: Tx, workspaceId: string, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  const [r] = await rows<{ yes: boolean }>(
    tx,
    sql`select exists (select 1 from app.leads l where l.workspace_id = ${workspaceId}
          and l.person_id = ${personId} and l.status = 'open' and l.archived_at is null) as yes`,
  );
  return !!r?.yes;
}

export const onHandedToAi: EventHandler = async (ctx) => {
  const e = ctx.event;
  const scope = scopeOf(e);
  const p = isRecord(e.payload) ? e.payload : {};
  const conversationId = str(p['conversationId']) ?? e.entityId;
  if (!scope || !conversationId) return;
  const found = await teammateOn(ctx.tx, scope);
  if (!found) return;
  const [conv] = await ctx.tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (
    !conv ||
    conv.handledBy !== 'ai' ||
    conv.aiTeammateId !== found.teammate.id ||
    !answersChannel(found.config, conv.channel) ||
    !(await widgetAnswers(ctx.tx, conv, found.teammate.id))
  )
    return;
  const clock = await workspaceClock(ctx.tx, scope.workspaceId);
  if (!workingNow(found.config, clock.openHours, clock.timeZone, Date.now())) return;
  const batch = await unansweredMessages(ctx.tx, conv.id, conv.aiAnsweredThrough);
  if (!batch.length) return;
  await scheduleReply(ctx.tx, {
    scope,
    conversationId: conv.id,
    channel: conv.channel as TeammateChannel,
    firstAt: batch[0]!.at,
    trigger: e.eventType,
    // A workflow step handed it over: its run's loop guard (the kernel put it on the event) goes with the run.
    origin: originOf(p['_workflow']),
  });
};

/**
 * `ai_teammate.retry_requested` (a person's "Try again" on a draft they rejected): the teammate answers the same
 * messages again, with their reason. A person asked for it, so the teammate's working hours don't hold it back
 * (what it writes still waits for an OK).
 */
export const onRetryRequested: EventHandler = async (ctx) => {
  const e = ctx.event;
  const scope = scopeOf(e);
  const p = isRecord(e.payload) ? e.payload : {};
  const conversationId = str(p['conversationId']);
  if (!scope || !conversationId) return;
  const found = await teammateOn(ctx.tx, scope);
  if (!found) return;
  const [conv] = await ctx.tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (
    !conv ||
    conv.handledBy !== 'ai' ||
    conv.aiTeammateId !== found.teammate.id ||
    !answersChannel(found.config, conv.channel) ||
    !(await widgetAnswers(ctx.tx, conv, found.teammate.id))
  )
    return;
  const runId = str(p['runId']);
  if (runId) await rewindToRun(ctx.tx, conv.id, runId);
  const batch = await unansweredMessages(ctx.tx, conv.id, await answeredThroughOf(ctx.tx, conv.id));
  if (!batch.length) return;
  const draftId = str(p['draftId']);
  const [rejected] = draftId
    ? await rows<{ body: string | null }>(
        ctx.tx,
        sql`select preview #>> '{message,body}' as body from app.ai_teammate_drafts where id = ${draftId}`,
      )
    : [];
  await scheduleReply(ctx.tx, {
    scope,
    conversationId: conv.id,
    channel: conv.channel as TeammateChannel,
    firstAt: batch[0]!.at,
    trigger: e.eventType,
    retry: { reason: str(p['reason']), draft: rejected?.body ?? null },
  });
};

const TEAMMATE_HANDLERS: Readonly<Record<string, EventHandler>> = {
  'message.received': onCustomerMessage,
  'conversation.handed_to_ai': onHandedToAi,
  'ai_teammate.retry_requested': onRetryRequested,
  'ai_teammate.draft_decided': onDraftDecided,
  'lead.created': onLeadCreated,
  'conversation.handed_off': onHandedOff,
};

/** The handler map with the teammate's handlers after each event's own (and before withWorkflows adds its own). */
export function withTeammate(handlers: HandlerMap): HandlerMap {
  const out: Record<string, EventHandler | readonly EventHandler[]> = { ...handlers };
  for (const [type, handler] of Object.entries(TEAMMATE_HANDLERS))
    out[type] = [...handlersFor(handlers, type), handler];
  return out;
}
