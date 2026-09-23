/**
 * The AI teammate's runs (plan M7, "Worker runtime"): answering everything the customer wrote since it last
 * answered (`ai_teammate.reply`), a first message (outreach.ts, and a workflow's hand-over), or a nudge when they
 * went quiet (follow-up.ts).
 *
 * 1. Start: one run per conversation (the database's unique index; a second job finds it and leaves). The batch
 *    is every unanswered customer message; the run keeps the conversation's ai_epoch. An unhandled conversation
 *    nobody is assigned is picked up for the teammate here (conversation.pick_up). A job retried after a busy
 *    provider resumes its run. A first message to someone with no conversation has none yet: its send starts one,
 *    and the run records it.
 * 2. Immediate hand-offs, before any model call: emergencies, sensitive topics, asking for a person, and
 *    frustration (when its settings say so).
 * 3. Budget: the workspace's daily limit and the teammate's share of it.
 * 4. Context (context.ts, prompt.ts, turns.ts), then 5. the tool loop (tools.ts).
 * 6. Finish, with the conversation locked: superseded when it changed hands, a person replied, or the customer
 *    wrote again (the debounce already queued the next run). Otherwise the reply passes checkTeammateReply (one
 *    rewrite allowed, then a person), and goes out (automatic: held changes, then message.send) or becomes one
 *    draft (training). Then the knowledge used and any gap are recorded, and a question that went out arms a
 *    follow-up nudge (nudges.ts).
 * 7. A model that ends with plain words: those are the reply. 8. A busy provider retries the job; running out of
 *    retries, or any other error, hands the conversation to a person.
 * A workflow that handed the customer over puts its loop guard on the run (`origin`, carried in the job's
 * payload), so everything the teammate does in it carries the guard; its goal and note go into the context.
 */
import { eq } from 'drizzle-orm';
import type { AiContent, AiMessage, AiUsage } from '@hfos/ai';
import {
  AI_TEAMMATE_GOALS,
  asksForPerson,
  asksIfHuman,
  runHeldAction,
  briefFromProfile,
  checkTeammateReply,
  conversationPickUp,
  disclosesAi,
  emergencyKind,
  executeCommandIn,
  HfosError,
  knowledgeItemRecordUse,
  loadTeammate,
  looksFrustrated,
  messageSend,
  plainSmsText,
  REPLY_RULES,
  sensitiveTopic,
  TeammateDraftPreview,
  teammateTools,
  TEAMMATE_TURN_ENDERS,
  uuidArray,
  walletRoom,
  workspaceMessaging,
  type AiEmployeeActor,
  type AiEmployeeOrigin,
  type ConversationHandoffReason,
  type EmergencyKind,
  type ReplyCheck,
  type RequestMeta,
  type SensitiveKind,
  type TeammateChannel,
  type TeammateConfig,
  type TeammateRow,
  type TeammateTool,
  type TeammateToolName,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { aiBudget, recordAndChargeAi } from '../ai/budget';
import { runToolLoop, type ToolLoopResult } from '../ai/tool-loop';
import { clockLabel } from '../assistant/calendar-format';
import { quietEndAt } from '../booking/deliver';
import { STOP_WORDING } from '../booking/messages';
import type { JobContext, JobHandler, JobResult } from '../jobs';
import { proposeGap } from '../knowledge/gaps';
import { errorMessage, MAX_ATTEMPTS } from '../outbox';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { questionIn } from '../workflows/ai-runner';
import { answersChannel, runtimeConfigOf } from './config';
import { MAX_TOKENS, QUIET_GRACE_MS } from './constants';
import {
  loadRunContext,
  messagesById,
  unansweredMessages,
  type BatchMessage,
  type RunContext,
} from './context';
import { scheduleExpirySweep } from './expiry';
import { loopReason, widgetAnswers } from './gates';
import { handOffAsAi, handOffAsSystem } from './handoff';
import { scheduleFollowUp, type OfferedSlot } from './nudges';
import { contextText, conversationTurn, rewriteFeedback, TEAMMATE_SYSTEM } from './prompt';
import { chatCodeSender } from './chat-code';
import { photoBlocks, photoLines, pickPhotos } from './photos';
import { createExecutor, newRunState, toolDefinition, type RunEnd, type RunState } from './tools';
import {
  firstMessageTurn,
  handoverLines,
  nudgeTurn,
  retryLines,
  taskTurn,
  type Handover,
  type Retry,
} from './turns';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Thrown when the provider was busy and the job has tries left: the job runs again with backoff and resumes. */
class ProviderBusy extends Error {
  constructor(cause: unknown) {
    super('The AI provider is busy; the reply will try again.', { cause });
    this.name = 'ProviderBusy';
  }
}

/**
 * What a run is for: answering what they wrote, a first message (answering anything waiting too), a nudge, or
 * a task an automation gave it (a thank-you after a job): one message, written first, with no follow-ups after.
 */
export type RunKind = 'reply' | 'first' | 'nudge' | 'task';

/** A task an automation gave the teammate: what to write, and about what. */
export interface TaskSpec {
  readonly purpose: 'thank_you';
  /** The job it's about ("AC tune-up"). */
  readonly visit: string;
  /** When the job was marked done. */
  readonly doneAt: number;
}

/** Whom a first message with no conversation goes to, and how (outreach.ts chose the channel by consent). */
export interface FirstTarget {
  readonly personId: string;
  readonly leadId: string | null;
  readonly channel: TeammateChannel;
  /** The first text to this number: it ends with the STOP wording, as every first text does. */
  readonly stopWording: boolean;
}

/** A follow-up: which one on the ladder, the message it follows up, and what that message offered. */
export interface NudgeSpec {
  readonly n: number;
  /** When the message they didn't answer went out. */
  readonly lastAt: number;
  /** How many the ladder has in all (the steps, then the monthly ones). */
  readonly total: number;
  /** Past the ladder's steps: one of the monthly check-ins. */
  readonly monthly: boolean;
  /** They never wrote in this conversation: it follows up the teammate's first message, from what they sent. */
  readonly neverWrote: boolean;
  /** The times that message offered, and whether each is still open. */
  readonly offered: readonly {
    readonly label: string;
    readonly startsAt: string;
    readonly open: boolean;
  }[];
}

/** How a job starts its run. */
export interface RunSpec {
  readonly kind: RunKind;
  /** What started it (the run's triggered_by): an event type, 'workflow', or the follow-up job. */
  readonly trigger: string;
  /** The workflow run that handed the customer over: its loop guard. */
  readonly origin: AiEmployeeOrigin | null;
  /** The workflow's goal and note. */
  readonly handover: Handover | null;
  /** A nudge: which one, and what it follows up. */
  readonly nudge?: NudgeSpec | null;
  /** A person's "Try again": their reason and the draft they rejected. */
  readonly retry?: Retry | null;
  /** A task run's task. */
  readonly task?: TaskSpec | null;
}

interface StartedRun extends RunSpec {
  readonly id: string;
  readonly scope: TenantScope;
  readonly teammate: TeammateRow;
  readonly config: TeammateConfig;
  /** Null for a first message to someone with no conversation yet (`target`): its send starts one. */
  readonly conversationId: string | null;
  readonly target: FirstTarget | null;
  /** The conversation's ai_epoch when it started: another one at the finish means it changed hands. */
  readonly epoch: number;
  readonly batch: readonly BatchMessage[];
  readonly startedAt: Date;
}

interface HandOff {
  readonly reason: ConversationHandoffReason;
  readonly note: string;
  /** An emergency: the customer gets its safety text instead of the usual hand-off line. */
  readonly emergency?: EmergencyKind;
}

const REASON_WORDS: Readonly<Record<ConversationHandoffReason, string>> = {
  asked_for_person: 'asked for a person',
  frustrated: 'sounds frustrated',
  cant_answer: 'a question it couldn’t answer',
  sensitive: 'a sensitive topic',
  emergency: 'an emergency',
  legal: 'a legal threat',
  complaint: 'a complaint',
  refund: 'a refund',
  cancellation: 'cancelling service',
  limit: 'a limit was reached',
  budget: 'the AI limit was reached',
  wallet: 'the balance ran out',
  error: 'something went wrong',
  draft_expired: 'nobody decided its draft in time',
  loop: 'a loop with another bot',
  other: 'needs a person',
};

const SENSITIVE_REASONS: Readonly<Record<SensitiveKind, ConversationHandoffReason>> = {
  legal_threat: 'legal',
  complaint: 'complaint',
  refund: 'refund',
  cancel_service: 'cancellation',
  custom: 'sensitive',
};

const EMERGENCY_WORDS: Readonly<Record<EmergencyKind, string>> = {
  gas: 'a gas smell',
  carbon_monoxide: 'carbon monoxide',
  fire: 'fire or smoke',
  flooding: 'flooding',
  injury: 'someone hurt',
};

const TAKEN_OVER = 'The conversation changed hands while it worked.';
const OPTED_OUT = 'They’ve opted out of texts, so it didn’t reply.';

// ---- What a job carries ----

const triggerOf = (v: unknown): string => {
  const t = str(v);
  return t && t.length <= 80 && /^[a-z_]+(\.[a-z_]+)*$/.test(t) ? t : 'message.received';
};

/** A workflow's loop guard, as a job carries it; null when there's none (or it's unreadable). */
export function originOf(v: unknown): AiEmployeeOrigin | null {
  if (!isRecord(v)) return null;
  const runId = str(v['runId']);
  const workflowId = str(v['workflowId']);
  if (!runId || !workflowId) return null;
  return {
    runId,
    workflowId,
    depth: typeof v['depth'] === 'number' ? v['depth'] : 0,
    originRunId: str(v['originRunId']),
  };
}

/** A person's "Try again", as a job carries it. */
export function retryOf(v: unknown): Retry | null {
  if (!isRecord(v)) return null;
  return {
    reason: str(v['reason'])?.slice(0, 1000) ?? null,
    draft: str(v['draft'])?.slice(0, 4000) ?? null,
  };
}

/** A workflow's goal and note, as a job carries them. */
export function handoverOf(p: Readonly<Record<string, unknown>>): Handover | null {
  const goal = AI_TEAMMATE_GOALS.find((g) => g === p['goal']);
  return goal ? { goal, note: typeof p['note'] === 'string' ? p['note'].slice(0, 500) : '' } : null;
}

// ---- The jobs ----

/** `ai_teammate.reply`: answers a conversation (a workflow's hand-over may ask it to write first). */
export const teammateReplyJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.job.payload;
  const conversationId = str(p['conversationId']);
  if (!conversationId) return;
  const run = await startRun(ctx, scope, conversationId, {
    kind: p['first'] === true ? 'first' : 'reply',
    trigger: triggerOf(p['trigger']),
    origin: originOf(p['origin']),
    handover: handoverOf(p),
    retry: retryOf(p['retry']),
  });
  if (!run) return;
  return runIt(ctx, run);
};

/** A nudge in the conversation (follow-up.ts decided it should go). */
export async function runNudge(
  ctx: JobContext,
  scope: TenantScope,
  conversationId: string,
  nudge: NudgeSpec,
  trigger: string,
): Promise<JobResult> {
  const run = await startRun(ctx, scope, conversationId, {
    kind: 'nudge',
    trigger,
    origin: null,
    handover: null,
    nudge,
  });
  if (!run) return;
  return runIt(ctx, run);
}

/**
 * A first message to someone with no conversation yet (outreach.ts chose the channel and checked the hours).
 * Another first message to them still running: this one tries again in a minute (and then finds them taken).
 */
export async function runFirstMessage(
  ctx: JobContext,
  scope: TenantScope,
  target: FirstTarget,
  spec: RunSpec,
): Promise<JobResult> {
  const run = await startFirstRun(ctx, scope, target, spec);
  if (run === 'busy') return { rescheduleAt: new Date(Date.now() + 60_000) };
  if (!run) return;
  return runIt(ctx, run);
}

async function runIt(ctx: JobContext, run: StartedRun): Promise<JobResult> {
  try {
    return await answer(ctx, run);
  } catch (e) {
    if (e instanceof ProviderBusy) throw e;
    ctx.log.error({ err: e, runId: run.id }, 'the AI teammate couldn’t finish a run');
    await failRun(ctx, run, e);
  }
}

/** A retry of this job (a busy provider) resumes this run instead of leaving it behind. */
async function rememberRun(tx: Tx, jobId: string, runId: string): Promise<void> {
  await tx.execute(
    sql`update app.scheduled_jobs set payload = payload || ${JSON.stringify({ _runId: runId })}::jsonb
        where id = ${jobId}`,
  );
}

function aiActorOf(run: {
  readonly id: string;
  readonly scope: TenantScope;
  readonly teammate: TeammateRow;
  readonly conversationId: string | null;
  readonly origin: AiEmployeeOrigin | null;
}): AiEmployeeActor {
  return {
    type: 'ai_employee',
    workspaceId: run.scope.workspaceId,
    organizationId: run.scope.organizationId,
    teammateId: run.teammate.id,
    teammateName: run.teammate.name,
    runId: run.id,
    conversationId: run.conversationId,
    approvedBy: null,
    origin: run.origin,
    // Never true here: commands don't simulate, so only the test console may, without calling them.
    test: false,
  };
}

/** Starts the conversation's run (or resumes this job's), or null when there's nothing for it to do. */
async function startRun(
  ctx: JobContext,
  scope: TenantScope,
  conversationId: string,
  spec: RunSpec,
): Promise<StartedRun | null> {
  const resumeId = str(ctx.job.payload['_runId']);
  return asWorker(ctx.db, scope, async (tx) => {
    const teammate = await loadTeammate(tx, scope.workspaceId);
    if (!teammate || teammate.status === 'off') return null;
    const config = runtimeConfigOf(teammate.config);
    const base = { ...spec, scope, teammate, config, conversationId, target: null };
    if (resumeId) {
      const [r] = await rows<{
        id: string;
        ai_epoch: number | null;
        message_ids: string[];
        started_at: Date | string;
      }>(
        tx,
        sql`select id, ai_epoch, message_ids, started_at from app.ai_teammate_runs
            where id = ${resumeId} and teammate_id = ${teammate.id} and conversation_id = ${conversationId}
              and status = 'running'`,
      );
      if (r)
        return {
          ...base,
          id: r.id,
          epoch: r.ai_epoch ?? 0,
          batch: await messagesById(tx, conversationId, r.message_ids),
          startedAt: new Date(r.started_at),
        };
    }
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update');
    if (!conv || !answersChannel(config, conv.channel)) return null;
    if (!(await widgetAnswers(tx, conv, teammate.id))) return null;
    const mine = conv.handledBy === 'ai' && conv.aiTeammateId === teammate.id;
    const free = conv.handledBy === 'none' && !conv.assigneeUserId;
    // A nudge or a workflow's first message is only ever for a conversation that's already the teammate's.
    if (!mine && (!free || spec.kind !== 'reply')) return null;
    const batch = await unansweredMessages(tx, conv.id, conv.aiAnsweredThrough);
    if (!batch.length && spec.kind === 'reply') return null;
    const loop = await loopReason(tx, conv.id);
    if (loop) {
      if (mine)
        await handOffAsSystem(tx, scope, conv.id, 'loop', loop, workerMeta(null, ctx.job.id));
      return null;
    }
    const epoch = free ? conv.aiEpoch + 1 : conv.aiEpoch;
    const [made] = await rows<{ id: string; started_at: Date | string }>(
      tx,
      sql`insert into app.ai_teammate_runs
            (workspace_id, teammate_id, conversation_id, person_id, triggered_by, ai_epoch, message_ids, model)
          values (${scope.workspaceId}, ${teammate.id}, ${conv.id}, ${conv.personId},
            ${spec.trigger}, ${epoch}, ${uuidArray(batch.map((b) => b.id))},
            ${ctx.ai.provider?.model.slice(0, 100) ?? null})
          on conflict (conversation_id) where status = 'running' do nothing
          returning id, started_at`,
    );
    if (!made) return null;
    if (free) {
      // Nobody answers it and nobody has it: the teammate picks it up (and a person's reply takes it back).
      const picked = await executeCommandIn(
        tx,
        conversationPickUp,
        { workspaceId: scope.workspaceId, conversationId: conv.id },
        aiActorOf({ id: made.id, scope, teammate, conversationId: conv.id, origin: spec.origin }),
        { correlationId: made.id, causationId: ctx.job.id, channel: 'ai_employee' },
      );
      if (picked.output.aiEpoch !== epoch)
        await tx.execute(
          sql`update app.ai_teammate_runs set ai_epoch = ${picked.output.aiEpoch} where id = ${made.id}`,
        );
    }
    await rememberRun(tx, ctx.job.id, made.id);
    return { ...base, id: made.id, epoch, batch, startedAt: new Date(made.started_at) };
  });
}

/** Starts a first message's run, with no conversation yet (or resumes this job's). */
async function startFirstRun(
  ctx: JobContext,
  scope: TenantScope,
  target: FirstTarget,
  spec: RunSpec,
): Promise<StartedRun | 'busy' | null> {
  const resumeId = str(ctx.job.payload['_runId']);
  return asWorker(ctx.db, scope, async (tx) => {
    const teammate = await loadTeammate(tx, scope.workspaceId);
    if (!teammate || teammate.status === 'off') return null;
    const config = runtimeConfigOf(teammate.config);
    const base = {
      ...spec,
      scope,
      teammate,
      config,
      conversationId: null,
      target,
      epoch: 0,
      batch: [],
    };
    if (resumeId) {
      const [r] = await rows<{ id: string; started_at: Date | string }>(
        tx,
        sql`select id, started_at from app.ai_teammate_runs
            where id = ${resumeId} and teammate_id = ${teammate.id} and conversation_id is null
              and status = 'running'`,
      );
      if (r) return { ...base, id: r.id, startedAt: new Date(r.started_at) };
    }
    // One first message per customer at a time: another job for them waits for this one, then finds them taken.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai-first:${target.personId}`}))`);
    const [busy] = await rows(
      tx,
      sql`select 1 from app.ai_teammate_runs
          where teammate_id = ${teammate.id} and person_id = ${target.personId} and conversation_id is null
            and status = 'running' and not is_test
          limit 1`,
    );
    if (busy) return 'busy';
    const [made] = await rows<{ id: string; started_at: Date | string }>(
      tx,
      sql`insert into app.ai_teammate_runs
            (workspace_id, teammate_id, person_id, lead_id, triggered_by, message_ids, model)
          values (${scope.workspaceId}, ${teammate.id}, ${target.personId}, ${target.leadId},
            ${spec.trigger}, ${uuidArray([])}, ${ctx.ai.provider?.model.slice(0, 100) ?? null})
          returning id, started_at`,
    );
    await rememberRun(tx, ctx.job.id, made!.id);
    return { ...base, id: made!.id, startedAt: new Date(made!.started_at) };
  });
}

// ---- One run ----

const VERIFIED_LINES = [
  'They just typed back the right code, so this chat is theirs now: their bookings, bills and quotes are open to you. Answer what they asked before the code.',
];

/** Tools a first message (no conversation yet) and a nudge may use: look things up, then write. */
const FIRST_TOOLS: ReadonlySet<TeammateToolName> = new Set<TeammateToolName>([
  'search_knowledge',
  'reply',
  'no_reply',
]);
const NUDGE_TOOLS: ReadonlySet<TeammateToolName> = new Set<TeammateToolName>([
  'search_knowledge',
  'find_times',
  'reply',
  'no_reply',
  'hand_off',
]);

function toolsFor(run: StartedRun, rc: RunContext): TeammateTool[] {
  const all = teammateTools(rc.config, { unverifiedChat: rc.unverifiedChat });
  const only = !run.conversationId ? FIRST_TOOLS : run.kind === 'nudge' ? NUDGE_TOOLS : null;
  return only ? all.filter((t) => only.has(t.name as TeammateToolName)) : all;
}

/** The message the model answers: the conversation and their new messages, a first message, or a nudge. */
function turnOf(run: StartedRun, rc: RunContext): string {
  if (run.kind === 'task' && run.task) return taskTurn(rc, run.task);
  if (run.kind === 'nudge' && run.nudge) return nudgeTurn(rc, run.nudge);
  if (rc.batch.length) return conversationTurn(rc);
  return firstMessageTurn(rc, run.trigger === 'lead.created' ? 'new_lead' : 'workflow');
}

/**
 * `verified`: this is the second pass of a run whose chat visitor typed back the right code in the first (M18).
 * It starts over as theirs, with their bookings, bills and quotes, and answers what they asked.
 */
async function answer(ctx: JobContext, run: StartedRun, verified = false): Promise<JobResult> {
  const { scope } = run;
  const rc = await asWorker(ctx.db, scope, (tx) =>
    loadRunContext(tx, {
      scope,
      teammate: run.teammate,
      config: run.config,
      conversationId: run.conversationId,
      target: run.target,
      batch: run.batch,
      webUrl: ctx.webUrl,
      now: Date.now(),
    }),
  );
  const ai = aiActorOf(run);
  const meta: RequestMeta = {
    correlationId: run.id,
    causationId: ctx.job.id,
    channel: 'ai_employee',
  };
  const leadId = rc.lead?.id ?? run.target?.leadId ?? null;
  const end = (h: HandOff, extra: Partial<Closing> = {}) =>
    endHandedOff(ctx, run, ai, meta, h, { leadId, ...extra });

  const immediate = immediateHandOff(rc);
  if (immediate) return end(immediate);

  const provider = ctx.ai.provider;
  if (!provider)
    return end(
      {
        reason: 'error',
        note: 'The AI isn’t set up for this business yet, so it couldn’t answer.',
      },
      { status: 'failed', error: 'no AI provider' },
    );
  const hasRoom = () =>
    aiBudget.teammateHasRoom(ctx.db, scope, {
      teammateId: run.teammate.id,
      dailyTokens: ctx.ai.dailyTokens,
      sharePercent: rc.config.limits.dailySharePercent,
      timeZone: rc.workspace.timeZone,
    });
  const budget: HandOff = {
    reason: 'budget',
    note: 'It reached its share of today’s AI limit, so it stopped. The limit resets at midnight.',
  };
  if (!(await hasRoom())) return end(budget);
  // The other way it runs out of room to spend. A customer is waiting on this conversation, so a dry balance
  // hands it to a person rather than erroring — the teammate never says "no money" to a customer.
  const money = await asWorker(ctx.db, scope, (tx) =>
    walletRoom(tx, scope.workspaceId, 'ai', (m, e) => ctx.log.error({ err: e }, m)),
  );
  if (!money.allowed)
    return end({
      reason: 'wallet',
      note: 'The balance ran out, so the AI paused. Top up and it starts answering again.',
    });

  const state = newRunState();
  const tools = toolsFor(run, rc);
  const enders = tools.filter((t) => TEAMMATE_TURN_ENDERS.has(t.name as TeammateToolName));
  const execute = createExecutor({
    db: ctx.db,
    scope,
    runId: run.id,
    ai,
    meta,
    rc,
    state,
    tools,
    training: run.teammate.status === 'training',
    moneyLinks: ctx.moneyLinks,
    chatCodes: chatCodeSender(ctx),
    geocoder: ctx.geocoder,
    ...(verified ? { callPrefix: 'verified:' } : {}),
    log: ctx.log,
  });
  const onTurnUsage = (usage: AiUsage) =>
    recordAndChargeAi(ctx, scope, {
      source: 'teammate',
      teammateId: run.teammate.id,
      teammateRunId: run.id,
      model: provider.model,
      usage,
    });
  const base = {
    provider,
    system: TEAMMATE_SYSTEM,
    context: [
      contextText(rc),
      ...(run.handover ? handoverLines(run.handover) : []),
      ...(run.retry ? retryLines(run.retry) : []),
      ...(verified ? VERIFIED_LINES : []),
    ].join('\n'),
    maxTokens: MAX_TOKENS,
    execute,
    onTurnUsage,
    checkBudget: hasRoom,
  };
  let steps = 0;

  /** The run ends here when the loop failed, a tool ended it, or it hit the budget or the round cap. */
  const settle = async (
    res: ToolLoopResult,
    checks: readonly unknown[],
    replyText: string | null,
  ): Promise<{ readonly value: JobResult } | null> => {
    if (res.stoppedBy === 'error' || res.stoppedBy === 'aborted') {
      if (res.retryable && ctx.attempt < MAX_ATTEMPTS) throw new ProviderBusy(res.error);
      return {
        value: await end(
          { reason: 'error', note: 'The AI couldn’t answer just now.' },
          { status: 'failed', error: errorMessage(res.error), checks, toolSteps: steps, replyText },
        ),
      };
    }
    if (state.abort) {
      await closeAborted(ctx, run, rc, state, { checks, toolSteps: steps, replyText, leadId });
      return { value: undefined };
    }
    const handed = state.end;
    if (handed?.kind === 'hand_off') {
      await asWorker(ctx.db, scope, (tx) =>
        closeRun(tx, run.id, {
          status: 'done',
          outcome: 'handed_off',
          summary: handedOffSummary(handed.reason, handed.note),
          checks,
          toolSteps: steps,
          replyText,
          leadId,
          knowledge: knowledgeOf(state),
        }),
      );
      if (handed.reason === 'cant_answer') await bookkeeping(ctx, run, rc, state, true);
      return { value: undefined };
    }
    if (res.stoppedBy === 'budget')
      return { value: await end(budget, { checks, toolSteps: steps, replyText }) };
    if (res.stoppedBy === 'max_rounds')
      return {
        value: await end(
          {
            reason: 'limit',
            note: `It needed more than ${rc.config.limits.toolRounds} tool steps to answer.`,
          },
          { checks, toolSteps: steps, replyText },
        ),
      };
    return null;
  };

  // M18: the newest few of their photos go in as pictures, when its settings let it look.
  const pick = rc.config.photos.enabled && rc.batch.length ? pickPhotos(rc.batch) : null;
  const images = pick ? await photoBlocks(ctx.store, pick.shown, ctx.log) : [];
  state.photos = images.length;
  const said = [turnOf(run, rc), ...(pick ? photoLines(pick, images.length) : [])].join('\n');
  const loop = await runToolLoop({
    ...base,
    messages: [
      { role: 'user', content: images.length ? [{ type: 'text', text: said }, ...images] : said },
    ],
    tools: tools.map(toolDefinition),
    maxRounds: rc.config.limits.toolRounds,
  });
  steps += loop.rounds;
  const first = await settle(loop, [], null);
  if (first) return first.value;
  if (state.verified && !verified) return answer(ctx, run, true);
  if (state.end?.kind === 'no_reply') return finish(ctx, run, rc, ai, meta, state, null, [], steps);
  let text = state.end?.kind === 'reply' ? state.end.message : finalText(loop.messages);
  if (!text.trim())
    return end(
      { reason: 'cant_answer', note: 'It didn’t come up with a reply.' },
      { toolSteps: steps },
    );

  const checks: unknown[] = [];
  let verdict = checkReply(rc, state, text);
  if (!verdict.ok) {
    checks.push(...checkRows(1, verdict, false));
    if (!(await hasRoom())) return end(budget, { checks, toolSteps: steps, replyText: text });
    // One rewrite, told what the check found. Only the turn-ending tools: nothing else changes now.
    state.end = null;
    const redo = await runToolLoop({
      ...base,
      messages: withFeedback(loop.messages, verdict),
      tools: enders.map(toolDefinition),
      maxRounds: 1,
    });
    steps += redo.rounds;
    const second = await settle(redo, checks, text);
    if (second) return second.value;
    const rewritten = endOf(state);
    if (rewritten?.kind === 'no_reply')
      return finish(ctx, run, rc, ai, meta, state, null, checks, steps);
    text = rewritten?.kind === 'reply' ? rewritten.message : finalText(redo.messages);
    verdict = checkReply(rc, state, text);
    checks.push(...checkRows(2, verdict, true));
    // A reply that fails again, one claiming to be a person included, never goes out.
    if (!verdict.ok)
      return end(
        {
          reason: 'cant_answer',
          note: `Its reply didn’t pass the safety check: ${verdict.problems.map((p) => p.message).join('; ')}.`,
        },
        { checks, toolSteps: steps, replyText: text },
      );
  } else checks.push(...checkRows(1, verdict, true));
  return finish(ctx, run, rc, ai, meta, state, text, checks, steps);
}

// ---- Immediate hand-offs ----

const quote = (s: string) => `“${s.replace(/\s+/g, ' ').trim().slice(0, 160)}”`;

/** What in the new messages goes straight to a person, most urgent first; null when nothing does. */
export function immediateHandOff(rc: RunContext): HandOff | null {
  const texts = rc.batch.map((b) => (b.subject ? `${b.subject}\n${b.text}` : b.text));
  for (const t of texts) {
    const kind = emergencyKind(t);
    if (kind)
      return {
        reason: 'emergency',
        note: `An emergency (${EMERGENCY_WORDS[kind]}): ${quote(t)}`,
        emergency: kind,
      };
  }
  for (const t of texts) {
    const topic = sensitiveTopic(t, rc.config.handOff.sensitiveTopics);
    if (topic)
      return {
        reason: SENSITIVE_REASONS[topic.kind],
        note: `${topic.label.charAt(0).toUpperCase()}${topic.label.slice(1)}: ${quote(t)}`,
      };
  }
  for (const t of texts)
    if (asksForPerson(t))
      return { reason: 'asked_for_person', note: `They asked for a person: ${quote(t)}` };
  if (rc.config.handOff.onFrustration)
    for (const t of texts)
      if (looksFrustrated(t))
        return { reason: 'frustrated', note: `They sound frustrated: ${quote(t)}` };
  return null;
}

// ---- The safety check ----

/** checkTeammateReply with this run's context: its links, numbers, knowledge and what it did. */
export function checkReply(rc: RunContext, state: RunState, text: string): ReplyCheck {
  const { profile, business } = rc.grounding;
  return checkTeammateReply(text, {
    channel: rc.conversation.channel,
    disclosure: rc.config.identity.disclosure,
    firstMessage: rc.firstAiMessage,
    askedIfHuman: rc.batch.some((b) => asksIfHuman(b.text)),
    allowed: { ...rc.allowed, urls: [] },
    // M18: a reply to a photo says a price only where the owner lets it give ranges from photos.
    allowPrices: profile.allowPrices && (!state.photos || rc.config.photos.priceRanges),
    knowledge: [
      briefFromProfile(profile, business),
      ...rc.matches.map((m) => `${m.title}\n${m.body}`),
      ...[...state.found.values()].map((f) => `${f.title}\n${f.body}`),
    ],
    done: {
      booked: state.held.some((a) => a.kind === 'book' || a.kind === 'book_series'),
      rescheduled: state.held.some((a) => a.kind === 'reschedule'),
      cancelled: state.held.some((a) => a.kind === 'cancel'),
    },
    discountPercent: state.discount?.percent ?? null,
  });
}

/** For the Activity view: a failed attempt's problems; the final attempt's verdict on every rule. */
function checkRows(attempt: number, verdict: ReplyCheck, final: boolean): unknown[] {
  if (!final)
    return verdict.problems.map((p) => ({ rule: p.rule, ok: false, message: p.message, attempt }));
  const failed = new Map(verdict.problems.map((p) => [p.rule, p.message]));
  return REPLY_RULES.map((rule) =>
    failed.has(rule)
      ? { rule, ok: false, message: failed.get(rule), attempt }
      : { rule, ok: true, attempt },
  );
}

/** The conversation with the check's problems added for the one rewrite. */
function withFeedback(messages: readonly AiMessage[], verdict: ReplyCheck): AiMessage[] {
  const out = [...messages];
  const note: AiContent = { type: 'text', text: rewriteFeedback(verdict.problems) };
  const last = out[out.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content))
    out[out.length - 1] = { role: 'user', content: [...last.content, note] };
  else out.push({ role: 'user', content: [note] });
  return out;
}

/** How the tools ended the turn so far (read through a call: the loop's tools change it). */
const endOf = (state: RunState): RunEnd | null => state.end;

/** The model's own last words, when it ended its turn without a tool. */
function finalText(messages: readonly AiMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return '';
  return typeof last.content === 'string'
    ? last.content.trim()
    : last.content
        .flatMap((c) => (c.type === 'text' ? [c.text] : []))
        .join('\n')
        .trim();
}

// ---- Finishing ----

interface Closing {
  readonly status: 'done' | 'superseded' | 'failed';
  readonly outcome?: 'replied' | 'drafted' | 'handed_off' | 'no_reply' | null;
  readonly summary: string;
  readonly replyText?: string | null;
  readonly knowledge?: readonly { itemId: string; title: string }[];
  readonly checks?: readonly unknown[];
  readonly toolSteps?: number;
  readonly error?: string | null;
  readonly leadId?: string | null;
}

/** Closes a run once, with its tokens summed from ai_usage (a resumed run's earlier tries included). */
export async function closeRun(tx: Tx, runId: string, c: Closing): Promise<void> {
  await tx.execute(
    sql`update app.ai_teammate_runs r
        set status = ${c.status}, outcome = ${c.outcome ?? null},
          reply_text = ${c.replyText ? c.replyText.slice(0, 10000) : null}, summary = ${c.summary.slice(0, 2000)},
          knowledge = ${JSON.stringify(c.knowledge ?? [])}::jsonb, checks = ${JSON.stringify(c.checks ?? [])}::jsonb,
          tool_steps = ${c.toolSteps ?? 0}, error = ${c.error ? c.error.slice(0, 2000) : null},
          lead_id = coalesce(r.lead_id, ${c.leadId ?? null}::uuid),
          input_tokens = u.input_tokens, output_tokens = u.output_tokens,
          cache_read_tokens = u.cache_read_tokens, cache_write_tokens = u.cache_write_tokens,
          ended_at = now()
        from (select coalesce(sum(input_tokens), 0)::int as input_tokens,
                coalesce(sum(output_tokens), 0)::int as output_tokens,
                coalesce(sum(cache_read_tokens), 0)::int as cache_read_tokens,
                coalesce(sum(cache_write_tokens), 0)::int as cache_write_tokens
              from app.ai_usage where teammate_run_id = ${runId}) u
        where r.id = ${runId} and r.status = 'running'`,
  );
}

/** The times find_times showed in this run, as a follow-up job carries them (a chase needs them). */
const shownTimes = (state: RunState): OfferedSlot[] =>
  [...state.offered.values()].map((o) => ({
    calendarId: o.calendarId,
    startsAt: o.startsAt,
    label: o.label,
    serviceId: o.serviceId,
    durationMinutes: o.durationMinutes,
  }));

const knowledgeOf = (state: RunState) =>
  [...state.found.values()].map((f) => ({ itemId: f.id, title: f.title }));

const snippet = (rc: RunContext) => {
  const t = (rc.batch[rc.batch.length - 1]?.text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};
const whom = (rc: RunContext) =>
  rc.customer ? `${rc.customer.firstName} ${rc.customer.lastName}`.trim() || 'them' : 'them';
const handedOffSummary = (reason: ConversationHandoffReason, note: string) =>
  `Handed to a person (${REASON_WORDS[reason]}): ${note}`;
function repliedSummary(run: StartedRun, rc: RunContext): string {
  if (run.kind === 'nudge') return `Followed up (${run.nudge?.n ?? 1} of ${run.nudge?.total ?? 1})`;
  if (run.kind === 'task') return `Thanked ${whom(rc)} after the job`;
  return rc.batch.length ? `Replied to “${snippet(rc)}”` : `Wrote first to ${whom(rc)}`;
}
function draftedSummary(run: StartedRun, rc: RunContext, state: RunState): string {
  const what =
    run.kind === 'nudge'
      ? 'Drafted a follow-up'
      : run.kind === 'task'
        ? `Drafted a thank-you to ${whom(rc)}`
        : rc.batch.length
          ? `Drafted a reply to “${snippet(rc)}”`
          : `Drafted a first message to ${whom(rc)}`;
  return `${what}${state.held.length ? `, holding: ${state.held.map((a) => a.summary || a.kind).join('; ')}` : ''}`;
}
const noReplySummary = (state: RunState) =>
  `No reply needed${state.end?.kind === 'no_reply' ? `: ${state.end.reason}` : ''}`;

/**
 * Hands the conversation to a person as the teammate (the customer hears the line first) and closes the run,
 * superseded if a person took it. A first message has no conversation to hand over: the run just says why.
 */
async function endHandedOff(
  ctx: JobContext,
  run: StartedRun,
  ai: AiEmployeeActor,
  meta: RequestMeta,
  h: HandOff,
  extra: Partial<Closing>,
): Promise<JobResult> {
  await asWorker(ctx.db, run.scope, async (tx) => {
    if (!run.conversationId) {
      await closeRun(tx, run.id, {
        ...extra,
        status: extra.status ?? 'done',
        outcome: extra.status === 'failed' ? null : 'no_reply',
        summary: `It didn’t write to them: ${h.note}`,
      });
      return;
    }
    const handed = await handOffAsAi(tx, ai, meta, h.reason, h.note, {
      line: h.emergency ? { emergency: h.emergency } : 'usual',
    });
    await closeRun(
      tx,
      run.id,
      handed
        ? {
            status: 'done',
            outcome: 'handed_off',
            summary: handedOffSummary(h.reason, h.note),
            ...extra,
          }
        : { ...extra, status: 'superseded', outcome: null, summary: TAKEN_OVER },
    );
  });
  return undefined;
}

async function closeAborted(
  ctx: JobContext,
  run: StartedRun,
  rc: RunContext,
  state: RunState,
  extra: Partial<Closing>,
): Promise<void> {
  await asWorker(ctx.db, run.scope, async (tx) => {
    if (state.abort === 'opted_out') {
      if (run.conversationId) await markAnswered(tx, run.conversationId, throughOf(rc), false);
      await closeRun(tx, run.id, {
        ...extra,
        status: 'done',
        outcome: 'no_reply',
        summary: OPTED_OUT,
      });
    } else if (state.abort === 'outside')
      await closeRun(tx, run.id, {
        ...extra,
        status: 'failed',
        summary: 'It tried to act outside its conversation, so it stopped.',
        error: 'outside_its_conversation',
      });
    else await closeRun(tx, run.id, { ...extra, status: 'superseded', summary: TAKEN_OVER });
  });
}

async function failRun(ctx: JobContext, run: StartedRun, e: unknown): Promise<void> {
  const note = 'Something went wrong while it was answering.';
  const meta: RequestMeta = {
    correlationId: run.id,
    causationId: ctx.job.id,
    channel: 'ai_employee',
  };
  await asWorker(ctx.db, run.scope, async (tx) => {
    const handed = run.conversationId
      ? await handOffAsAi(tx, aiActorOf(run), meta, 'error', note)
      : false;
    await closeRun(tx, run.id, {
      status: 'failed',
      outcome: handed ? 'handed_off' : null,
      summary: handed ? handedOffSummary('error', note) : `It stopped: ${note}`,
      error: errorMessage(e),
    });
  });
}

/** The newest message it answered; null when it answered none (a first message, a nudge). */
const throughOf = (rc: RunContext): Date | null =>
  rc.batch.length ? new Date(Math.max(...rc.batch.map((b) => b.at))) : null;

/** The newest message it answered (when it answered some), and, when this message said it's an AI, that it has. */
async function markAnswered(
  tx: Tx,
  conversationId: string,
  through: Date | null,
  disclosed: boolean,
): Promise<void> {
  if (!through && !disclosed) return;
  const answered = through
    ? sql`ai_answered_through = greatest(coalesce(ai_answered_through, '-infinity'::timestamptz),
          ${through.toISOString()}::timestamptz)`
    : sql`ai_answered_through = ai_answered_through`;
  await tx.execute(
    sql`update app.conversations
        set ${answered} ${disclosed ? sql`, ai_disclosed_at = coalesce(ai_disclosed_at, now())` : sql``}
        where id = ${conversationId}`,
  );
}

/** Why the run's work no longer fits the conversation, or null when it still does. */
async function supersededWhy(
  tx: Tx,
  run: StartedRun,
  conv: typeof conversations.$inferSelect | undefined,
  teammate: TeammateRow | null,
): Promise<string | null> {
  if (!conv) return 'The conversation is gone.';
  if (!teammate || teammate.status === 'off') return 'Its teammate was turned off while it worked.';
  if (
    conv.aiEpoch !== run.epoch ||
    conv.handledBy !== 'ai' ||
    conv.aiTeammateId !== run.teammate.id
  )
    return TAKEN_OVER;
  const started = run.startedAt.toISOString();
  const earliest = new Date(
    run.batch.length ? Math.min(...run.batch.map((b) => b.at)) : run.startedAt.getTime(),
  ).toISOString();
  const [x] = await rows<{ person: boolean; customer: boolean }>(
    tx,
    sql`select
          exists (select 1 from app.messages m where m.conversation_id = ${conv.id} and m.direction = 'outbound'
            and m.sent_by is not null and m.created_at > ${started}::timestamptz) as person,
          exists (select 1 from app.messages m where m.conversation_id = ${conv.id} and m.direction = 'inbound'
            and not (m.id = any(${uuidArray(run.batch.map((b) => b.id))}))
            and (m.created_at > ${started}::timestamptz or m.occurred_at >= ${earliest}::timestamptz)) as customer`,
  );
  if (x?.person) return 'A person replied while it worked.';
  if (x?.customer)
    return 'The customer wrote again, so the next reply answers everything together.';
  return null;
}

/** Replaces the conversation's pending reply draft with this run's. */
async function makeDraft(
  tx: Tx,
  ctx: JobContext,
  run: StartedRun,
  rc: RunContext,
  state: RunState,
  message: { readonly body: string; readonly subject: string | null } | null,
  latest: BatchMessage | null,
): Promise<void> {
  if (rc.conversation.id)
    await tx.execute(
      sql`update app.ai_teammate_drafts
          set status = 'cancelled', decided_at = now(), via = 'system', reason = 'A newer reply from the teammate replaced it.'
          where conversation_id = ${rc.conversation.id} and status = 'pending' and kind = 'reply'`,
    );
  const preview = TeammateDraftPreview.parse({
    message:
      message === null
        ? null
        : {
            channel: rc.conversation.channel,
            body: message.body,
            subject: message.subject,
            inReplyToMessageId: latest?.id ?? null,
          },
    actions: state.held,
    discount: null,
  });
  await insertDraft(tx, ctx, run, rc, 'reply', preview, `ai:${run.id}`, message?.body ?? null);
}

/**
 * What waits for a manager in any mode, each in its own approval draft: a discount, and (M18) a request with
 * money in it — a bill, a quote, an answer to a quote, a plan, or the link to pay or answer one already sent.
 */
async function makeApprovals(
  tx: Tx,
  ctx: JobContext,
  run: StartedRun,
  rc: RunContext,
  state: RunState,
): Promise<void> {
  const channel = rc.conversation.channel;
  const bodyOf = (text: string) => (channel === 'sms' ? plainSmsText(text) : text.trim());
  if (state.discount) {
    const body = bodyOf(state.discount.message);
    const preview = TeammateDraftPreview.parse({
      message: { channel, body, subject: null, inReplyToMessageId: null },
      actions: [],
      discount: {
        percent: state.discount.percent,
        reason: state.discount.reason.slice(0, 300),
      },
    });
    await insertDraft(tx, ctx, run, rc, 'approval', preview, `ai:${run.id}:d`, body);
  }
  if (state.moneyAsk) {
    const body = bodyOf(state.moneyAsk.message);
    const preview = TeammateDraftPreview.parse({
      message: { channel, body, subject: null, inReplyToMessageId: null },
      actions: state.moneyAsk.actions,
      discount: null,
    });
    await insertDraft(tx, ctx, run, rc, 'approval', preview, `ai:${run.id}:m`, body);
  }
}

async function insertDraft(
  tx: Tx,
  ctx: JobContext,
  run: StartedRun,
  rc: RunContext,
  kind: 'reply' | 'approval',
  preview: TeammateDraftPreview,
  clientId: string,
  body: string | null,
): Promise<void> {
  const expiresAt = new Date(Date.now() + rc.config.autonomy.draftExpiresMinutes * 60_000);
  const [d] = await rows<{ id: string }>(
    tx,
    sql`insert into app.ai_teammate_drafts
          (workspace_id, teammate_id, run_id, conversation_id, person_id, lead_id, kind, preview, expires_at, client_id)
        values (${rc.workspace.id}, ${run.teammate.id}, ${run.id}, ${rc.conversation.id}, ${rc.conversation.personId},
          ${rc.lead?.id ?? run.target?.leadId ?? null}, ${kind}, ${JSON.stringify(preview)}::jsonb,
          ${expiresAt.toISOString()}::timestamptz, ${clientId})
        returning id`,
  );
  // Nobody deciding it in time hands the conversation to a person: the business's sweep comes round then.
  await scheduleExpirySweep(tx, run.scope, expiresAt);
  await recordSystemEvent(tx, {
    type: 'ai_teammate.drafted',
    action: 'ai_teammate.reply',
    organizationId: run.scope.organizationId,
    workspaceId: run.scope.workspaceId,
    entityType: 'ai_teammate_draft',
    entityId: d!.id,
    payload: {
      draftId: d!.id,
      kind,
      teammateId: run.teammate.id,
      runId: run.id,
      conversationId: rc.conversation.id,
      personId: rc.conversation.personId,
      actions: preview.actions.map((a) => a.kind),
    },
    after: {
      teammate: run.teammate.name,
      preview: body ? body.slice(0, 80) : null,
      actions: preview.actions.length,
    },
    correlationId: run.id,
    causationId: ctx.job.id,
  });
}

function sendInput(
  rc: RunContext,
  conversationId: string,
  runId: string,
  body: string,
  latest: BatchMessage | null,
) {
  const channel = rc.conversation.channel;
  return {
    workspaceId: rc.workspace.id,
    conversationId,
    channel,
    body,
    ...(channel === 'email' && rc.config.channels.emailAddressId
      ? { emailAddressId: rc.config.channels.emailAddressId }
      : {}),
    // Quiet hours let it answer only the customer's latest text, soon after it came in.
    ...(channel === 'sms' && latest ? { inReplyToMessageId: latest.id } : {}),
    clientId: `ai:${runId}`,
  };
}

type Finished = {
  readonly outcome: 'replied' | 'drafted' | 'no_reply' | 'other';
  readonly waitUntil: Date | null;
};

/** When quiet hours end (and a little after), for whatever they held back. */
async function afterQuietHours(tx: Tx, workspaceId: string): Promise<{ end: number; tz: string }> {
  const m = await workspaceMessaging(tx, workspaceId);
  const end = quietEndAt(m.settings.quietHours, m.timezone, Date.now()) ?? Date.now() + 5 * 60_000;
  return { end, tz: m.timezone };
}

/** The finish, with the conversation locked: supersede, or send (automatic) or draft (training). */
async function finish(
  ctx: JobContext,
  run: StartedRun,
  rc: RunContext,
  ai: AiEmployeeActor,
  meta: RequestMeta,
  state: RunState,
  text: string | null,
  checks: readonly unknown[],
  steps: number,
): Promise<JobResult> {
  if (!run.conversationId) return finishFirst(ctx, run, rc, ai, meta, state, text, checks, steps);
  const conversationId = run.conversationId;
  const channel = rc.conversation.channel;
  const body = text === null ? null : channel === 'sms' ? plainSmsText(text) : text.trim();
  const latest = rc.batch[rc.batch.length - 1] ?? null;
  const through = throughOf(rc);
  const common = {
    replyText: body,
    checks,
    toolSteps: steps,
    knowledge: knowledgeOf(state),
    leadId: rc.lead?.id ?? null,
  };
  const result = await asWorker(ctx.db, run.scope, async (tx): Promise<Finished> => {
    const none: Finished = { outcome: 'other', waitUntil: null };
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update');
    const teammate = await loadTeammate(tx, run.scope.workspaceId, { teammateId: run.teammate.id });
    const why = await supersededWhy(tx, run, conv, teammate);
    if (why) {
      await closeRun(tx, run.id, { ...common, status: 'superseded', summary: why });
      return none;
    }
    if (teammate!.status === 'training') {
      const drafted = body !== null || state.held.length > 0;
      if (drafted)
        await makeDraft(
          tx,
          ctx,
          run,
          rc,
          state,
          body === null ? null : { body, subject: null },
          latest,
        );
      await makeApprovals(tx, ctx, run, rc, state);
      await markAnswered(tx, conversationId, through, false);
      if (drafted && body !== null) await markReferralThanked(tx, rc);
      const outcome = drafted ? 'drafted' : 'no_reply';
      await closeRun(tx, run.id, {
        ...common,
        status: 'done',
        outcome,
        summary: drafted ? draftedSummary(run, rc, state) : noReplySummary(state),
      });
      return { outcome, waitUntil: null };
    }
    try {
      // The held changes and the message are one unit: a refusal of either undoes both.
      await tx.transaction(async (sp) => {
        for (const [i, a] of state.held.entries())
          await runHeldAction(sp, ai, meta, a, `ai:${run.id}:${i + 1}`);
        if (body !== null)
          await executeCommandIn(
            sp,
            messageSend,
            sendInput(rc, conversationId, run.id, body, latest),
            ai,
            meta,
          );
      });
    } catch (e) {
      if (!(e instanceof HfosError)) throw e;
      if (e.rule === 'quiet_hours') {
        // Past the reply window (or nothing to reply to): it writes again once quiet hours end.
        const q = await afterQuietHours(tx, run.scope.workspaceId);
        await closeRun(tx, run.id, {
          ...common,
          status: 'done',
          outcome: 'no_reply',
          summary: `Quiet hours: it answers once they end, at ${clockLabel(q.end, q.tz)}.`,
        });
        return { outcome: 'other', waitUntil: new Date(q.end + QUIET_GRACE_MS) };
      }
      if (e.rule === 'not_handled_by_ai') {
        await closeRun(tx, run.id, { ...common, status: 'superseded', summary: TAKEN_OVER });
        return none;
      }
      if (e.rule === 'opted_out') {
        await markAnswered(tx, conversationId, through, false);
        await closeRun(tx, run.id, {
          ...common,
          status: 'done',
          outcome: 'no_reply',
          summary: OPTED_OUT,
        });
        return none;
      }
      // Anything else (the time was taken meanwhile, the address stopped taking mail): a person picks it up.
      const note = `Its reply couldn’t go out: ${e.message}`;
      const handed = await handOffAsAi(tx, ai, meta, 'error', note);
      await closeRun(
        tx,
        run.id,
        handed
          ? {
              ...common,
              status: 'done',
              outcome: 'handed_off',
              summary: handedOffSummary('error', note),
              error: e.message,
            }
          : { ...common, status: 'superseded', summary: TAKEN_OVER },
      );
      return none;
    }
    await markAnswered(tx, conversationId, through, body !== null && disclosesAi(body));
    await makeApprovals(tx, ctx, run, rc, state);
    const outcome = body !== null ? 'replied' : 'no_reply';
    if (body !== null) await markReferralThanked(tx, rc);
    await closeRun(tx, run.id, {
      ...common,
      status: 'done',
      outcome,
      summary: outcome === 'replied' ? repliedSummary(run, rc) : noReplySummary(state),
    });
    // It asked them something: a nudge waits in case they go quiet.
    if (body !== null)
      await scheduleFollowUp(
        tx,
        run.scope,
        conversationId,
        rc.config,
        body,
        Date.now(),
        shownTimes(state),
      );
    return { outcome, waitUntil: null };
  });
  if (result.outcome !== 'other') await bookkeeping(ctx, run, rc, state, false);
  return result.waitUntil ? { rescheduleAt: result.waitUntil } : undefined;
}

/**
 * A first message's finish: no conversation yet, so its send (automatic) starts one, which the teammate then
 * handles, and the run records it; in training it's a draft that starts the conversation once approved. A first
 * text carries the STOP wording. Quiet hours hold a text back until they end.
 */
async function finishFirst(
  ctx: JobContext,
  run: StartedRun,
  rc: RunContext,
  ai: AiEmployeeActor,
  meta: RequestMeta,
  state: RunState,
  text: string | null,
  checks: readonly unknown[],
  steps: number,
): Promise<JobResult> {
  const t = run.target!;
  const channel = t.channel;
  const clean = text === null ? null : channel === 'sms' ? plainSmsText(text) : text.trim();
  const body =
    clean !== null && channel === 'sms' && t.stopWording
      ? plainSmsText(`${clean} ${STOP_WORDING}`)
      : clean;
  const subject =
    channel === 'email'
      ? `A message from ${rc.grounding.business.name || rc.workspace.name}`
      : null;
  const common = {
    replyText: body,
    checks,
    toolSteps: steps,
    knowledge: knowledgeOf(state),
    leadId: t.leadId ?? rc.lead?.id ?? null,
  };
  const result = await asWorker(ctx.db, run.scope, async (tx): Promise<Finished> => {
    const none: Finished = { outcome: 'other', waitUntil: null };
    const teammate = await loadTeammate(tx, run.scope.workspaceId, { teammateId: run.teammate.id });
    if (!teammate || teammate.status === 'off') {
      await closeRun(tx, run.id, {
        ...common,
        status: 'superseded',
        summary: 'Its teammate was turned off while it worked.',
      });
      return none;
    }
    if (body === null) {
      await closeRun(tx, run.id, {
        ...common,
        status: 'done',
        outcome: 'no_reply',
        summary: noReplySummary(state),
      });
      return { outcome: 'no_reply', waitUntil: null };
    }
    if (teammate.status === 'training') {
      await makeDraft(tx, ctx, run, rc, state, { body, subject }, null);
      await closeRun(tx, run.id, {
        ...common,
        status: 'done',
        outcome: 'drafted',
        summary: draftedSummary(run, rc, state),
      });
      return { outcome: 'drafted', waitUntil: null };
    }
    try {
      const sent = await executeCommandIn(
        tx,
        messageSend,
        {
          workspaceId: run.scope.workspaceId,
          personId: t.personId,
          channel,
          body,
          ...(subject ? { subject } : {}),
          ...(channel === 'email' && rc.config.channels.emailAddressId
            ? { emailAddressId: rc.config.channels.emailAddressId }
            : {}),
          clientId: `ai:${run.id}`,
        },
        ai,
        meta,
      );
      const conversationId = sent.output.conversationId;
      await tx.execute(
        sql`update app.ai_teammate_runs set conversation_id = ${conversationId} where id = ${run.id}`,
      );
      // Nothing older in that conversation waits for the teammate now.
      await markAnswered(tx, conversationId, new Date(), disclosesAi(body));
      await closeRun(tx, run.id, {
        ...common,
        status: 'done',
        outcome: 'replied',
        summary: repliedSummary(run, rc),
      });
      // A thank-you asks nothing, so there's nothing to follow up.
      if (run.kind !== 'task')
        await scheduleFollowUp(
          tx,
          run.scope,
          conversationId,
          rc.config,
          body,
          Date.now(),
          shownTimes(state),
        );
      return { outcome: 'replied', waitUntil: null };
    } catch (e) {
      if (!(e instanceof HfosError)) throw e;
      if (e.rule === 'quiet_hours') {
        const q = await afterQuietHours(tx, run.scope.workspaceId);
        await closeRun(tx, run.id, {
          ...common,
          status: 'done',
          outcome: 'no_reply',
          summary: `Quiet hours: it writes once they end, at ${clockLabel(q.end, q.tz)}.`,
        });
        return { outcome: 'other', waitUntil: new Date(q.end + QUIET_GRACE_MS) };
      }
      if (e.rule === 'opted_out') {
        await closeRun(tx, run.id, {
          ...common,
          status: 'done',
          outcome: 'no_reply',
          summary: OPTED_OUT,
        });
        return none;
      }
      if (e.rule === 'not_handled_by_ai' || e.rule === 'outside_its_conversation') {
        await closeRun(tx, run.id, {
          ...common,
          status: 'superseded',
          summary: 'Someone on the team is talking to them already, so it didn’t write.',
        });
        return none;
      }
      await closeRun(tx, run.id, {
        ...common,
        status: 'failed',
        summary: `Its first message couldn’t go out: ${e.message}`,
        error: e.message,
      });
      return none;
    }
  });
  if (result.outcome !== 'other') await bookkeeping(ctx, run, rc, state, false);
  return result.waitUntil ? { rescheduleAt: result.waitUntil } : undefined;
}

/** The referral the reply thanked them for is thanked (whoever approves the draft, the words are in it). */
async function markReferralThanked(tx: Tx, rc: RunContext): Promise<void> {
  if (!rc.referral) return;
  await tx.execute(
    sql`update app.referrals set thanked_at = coalesce(thanked_at, now()) where id = ${rc.referral.id}`,
  );
}

/**
 * Bookkeeping, as the worker: the knowledge it looked up counts as used, and a question it couldn't answer
 * becomes a knowledge gap (the same proposer workflow AI steps use). Never fails the run.
 */
async function bookkeeping(
  ctx: JobContext,
  run: StartedRun,
  rc: RunContext,
  state: RunState,
  unsure: boolean,
): Promise<void> {
  const itemIds = [...state.found.keys()];
  const asked = rc.batch.map((b) => b.text).join(' ');
  const gap = unsure || (state.searched && state.found.size === 0);
  const question = gap && asked.includes('?') ? questionIn(asked) : null;
  if (!itemIds.length && !question) return;
  const actor = systemActor(run.scope);
  const meta = workerMeta(run.id, ctx.job.id);
  try {
    await asWorker(ctx.db, run.scope, async (tx) => {
      if (itemIds.length)
        await executeCommandIn(
          tx,
          knowledgeItemRecordUse,
          { workspaceId: run.scope.workspaceId, itemIds },
          actor,
          meta,
        );
      if (question)
        await proposeGap(tx, actor, { question, context: { teammateRunId: run.id } }, meta);
    });
  } catch (e) {
    ctx.log.warn({ err: e, runId: run.id }, 'could not record the knowledge the AI teammate used');
  }
}
