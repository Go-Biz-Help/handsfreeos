/**
 * The workflow action "Hand to the AI teammate" (hand_to_ai_teammate {goal, firstMessage, channel, note}).
 * - The teammate takes the customer's conversation on that channel (or the one they used last):
 *   conversation.hand_to_ai as the workflow, so the run's loop guard rides on the event. A conversation a person
 *   has stays theirs.
 * - With firstMessage 'ai_writes' it writes to them first, its consent and quiet-hours rules applying: in that
 *   conversation, or, when they have none yet, a first message that starts one (outreach.ts). With 'none' it
 *   answers what's waiting and whatever they write next.
 * - Its runs carry the workflow's loop guard (origin, in the job's payload), so nothing the teammate does starts
 *   the same workflow again, and the goal and the note go into its context.
 * - Skipped with a reason when there's no teammate, it's off, or it doesn't answer that channel. A test run
 *   only says what it would do.
 */
import { eq } from 'drizzle-orm';
import {
  conversationHandToAi,
  executeCommandIn,
  loadTeammate,
  openHoursOf,
  scheduleJob,
  workspaceMessaging,
  type AiEmployeeOrigin,
  type AiTeammateGoal,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { scheduleDebouncedJob } from '../jobs';
import { isRefusal, refusedFrom, type ExecCtx, type Json, type Outcome } from '../workflows/types';
import { runtimeConfigOf } from './config';
import { outreachJobKey, replyJobKey, TEAMMATE_JOBS } from './constants';
import { unansweredMessages } from './context';
import { nextWorkingAt } from './hours';

type Conversation = typeof conversations.$inferSelect;
type HandChannel = 'sms' | 'email' | 'latest';

export interface HandToTeammate {
  readonly goal: AiTeammateGoal;
  readonly firstMessage: 'ai_writes' | 'none';
  readonly channel: HandChannel;
  /** The business's note, rendered. */
  readonly note: string;
}

const skipped = (reason: string, input: Json, output?: Json): Outcome => ({
  kind: 'skipped',
  reason,
  input,
  ...(output ? { output } : {}),
});

/** The customer's conversation on one of these channels: the run's own first, else the latest. */
async function conversationOn(
  ec: ExecCtx,
  channels: readonly ('sms' | 'email')[],
): Promise<Conversation | null> {
  const [c] = await rows<{ id: string }>(
    ec.tx,
    sql`select id from app.conversations
        where workspace_id = ${ec.scope.workspaceId} and person_id = ${ec.run.personId}
          and channel in (${sql.join(
            channels.map((ch) => sql`${ch}::app.channel`),
            sql`, `,
          )})
        order by (id = ${ec.run.conversationId ?? '00000000-0000-0000-0000-000000000000'}::uuid) desc,
          last_message_at desc nulls last
        limit 1`,
  );
  if (!c) return null;
  const [conv] = await ec.tx.select().from(conversations).where(eq(conversations.id, c.id));
  return conv ?? null;
}

export async function handToTeammate(ec: ExecCtx, cfg: HandToTeammate): Promise<Outcome> {
  const ws = ec.scope.workspaceId;
  const input: Json = {
    goal: cfg.goal,
    firstMessage: cfg.firstMessage,
    channel: cfg.channel,
    ...(cfg.note ? { note: cfg.note } : {}),
  };
  const teammate = await loadTeammate(ec.tx, ws);
  if (!teammate) return skipped('no_teammate', input);
  if (teammate.status === 'off') return skipped('teammate_off', input);
  const config = runtimeConfigOf(teammate.config);
  const answered = (['sms', 'email'] as const).filter((c) => config.channels[c]);
  if (cfg.channel !== 'latest' && !config.channels[cfg.channel])
    return skipped('channel_off', input);
  if (!answered.length) return skipped('channel_off', input);
  if (!ec.run.personId) return skipped('no_person', input);
  const conv = await conversationOn(ec, cfg.channel === 'latest' ? answered : [cfg.channel]);
  if (ec.testMode)
    return {
      kind: 'done',
      input,
      output: {
        simulated: true,
        conversationId: conv?.id ?? null,
        would: conv ? 'hand_over' : cfg.firstMessage === 'ai_writes' ? 'write_first' : 'wait',
      },
    };
  const origin: AiEmployeeOrigin = {
    runId: ec.run.id,
    workflowId: ec.run.workflowId,
    depth: ec.run.depth,
    originRunId: ec.run.originRunId,
  };
  const m = await workspaceMessaging(ec.tx, ws);
  const at = new Date(
    nextWorkingAt(config, openHoursOf(m.rawSettings), m.timezone || 'UTC', ec.now),
  );
  const carried = { goal: cfg.goal, note: cfg.note, origin };

  if (!conv) {
    // Nothing to hand over yet: it waits for them, or its first message starts the conversation.
    if (cfg.firstMessage === 'none')
      return { kind: 'done', input, output: { conversationId: null, waiting: true } };
    await scheduleJob(ec.tx, {
      kind: TEAMMATE_JOBS.outreach,
      dedupeKey: outreachJobKey(`wf:${ec.run.id}:${ec.stepKey}`),
      runAt: at,
      payload: {
        personId: ec.run.personId,
        leadId: ec.run.leadId,
        channel: cfg.channel === 'latest' ? null : cfg.channel,
        trigger: 'workflow',
        ...carried,
      },
      workspaceId: ws,
      organizationId: ec.scope.organizationId,
    });
    return {
      kind: 'done',
      input,
      output: { conversationId: null, writesFirstAt: at.toISOString() },
    };
  }

  if (conv.handledBy === 'person')
    return skipped('person_handling', input, { conversationId: conv.id });
  let eventIds: readonly string[] = [];
  try {
    const r = await executeCommandIn(
      ec.tx,
      conversationHandToAi,
      { workspaceId: ws, conversationId: conv.id },
      ec.actor,
      ec.meta,
    );
    eventIds = r.eventIds;
  } catch (e) {
    if (!isRefusal(e)) throw e;
    if (e.rule === 'teammate_off' || e.rule === 'channel_off' || e.rule === 'person_handling')
      return skipped(e.rule, input, { conversationId: conv.id });
    return refusedFrom(e, input);
  }
  const waiting = (await unansweredMessages(ec.tx, conv.id, conv.aiAnsweredThrough)).length > 0;
  const writes = cfg.firstMessage === 'ai_writes' || waiting;
  if (writes)
    await scheduleDebouncedJob(ec.tx, {
      kind: TEAMMATE_JOBS.reply,
      dedupeKey: replyJobKey(conv.id),
      runAt: at,
      payload: {
        conversationId: conv.id,
        trigger: 'workflow',
        first: cfg.firstMessage === 'ai_writes',
        ...carried,
      },
      workspaceId: ws,
      organizationId: ec.scope.organizationId,
      mergePayload: true,
    });
  return {
    kind: 'done',
    input,
    eventIds,
    output: {
      conversationId: conv.id,
      handedOver: true,
      ...(writes ? { writesAt: at.toISOString() } : { waiting: true }),
    },
    ...(ec.run.conversationId ? {} : { refs: { conversationId: conv.id } }),
  };
}
