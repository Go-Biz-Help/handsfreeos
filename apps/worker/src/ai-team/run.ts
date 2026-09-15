/**
 * The reply job, `ai_teammate.reply` (plan M7, "Worker runtime"): one run answers everything the customer wrote
 * since the teammate last answered.
 *
 * 1. Start: one run per conversation (the database's unique index; a second job finds it and leaves). The batch
 *    is every unanswered customer message; the run keeps the conversation's ai_epoch. An unhandled conversation
 *    nobody is assigned is picked up for the teammate here. A job retried after a busy provider resumes its run.
 * 2. Immediate hand-offs, before any model call: emergencies, sensitive topics, asking for a person, and
 *    frustration (when its settings say so).
 * 3. Budget: the workspace's daily limit and the teammate's share of it.
 * 4. Context (context.ts, prompt.ts), then 5. the tool loop (tools.ts).
 * 6. Finish, with the conversation locked: superseded when it changed hands, a person replied, or the customer
 *    wrote again (the debounce already queued the next run). Otherwise the reply passes checkTeammateReply (one
 *    rewrite allowed, then a person), and goes out (automatic: held changes, then message.send) or becomes one
 *    draft (training). Then the knowledge used and any gap are recorded.
 * 7. A model that ends with plain words: those are the reply. 8. A busy provider retries the job; running out
 *    of retries, or any other error, hands the conversation to a person.
 */
import { eq } from 'drizzle-orm';
import type { AiContent, AiMessage, AiUsage } from '@hfos/ai';
import {
  appointmentBookForCustomer,
  asksForPerson,
  asksIfHuman,
  attendeeCancelForCustomer,
  attendeeRescheduleForCustomer,
  briefFromProfile,
  checkTeammateReply,
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
  workspaceMessaging,
  type AiEmployeeActor,
  type ConversationHandoffReason,
  type DraftAction,
  type EmergencyKind,
  type ReplyCheck,
  type RequestMeta,
  type SensitiveKind,
  type TeammateConfig,
  type TeammateRow,
  type TeammateToolName,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { aiBudget, recordAiUsage } from '../ai/budget';
import { runToolLoop, type ToolLoopResult } from '../ai/tool-loop';
import { clockLabel } from '../assistant/calendar-format';
import { quietEndAt } from '../booking/deliver';
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
import { loopReason } from './gates';
import { handOffAsAi, handOffAsSystem } from './handoff';
import { contextText, conversationTurn, rewriteFeedback, TEAMMATE_SYSTEM } from './prompt';
import {
  createExecutor,
  newRunState,
  toolDefinition,
  type Discount,
  type RunEnd,
  type RunState,
} from './tools';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Thrown when the provider was busy and the job has tries left: the job runs again with backoff and resumes. */
class ProviderBusy extends Error {
  constructor(cause: unknown) {
    super('The AI provider is busy; the reply will try again.', { cause });
    this.name = 'ProviderBusy';
  }
}

interface StartedRun {
  readonly id: string;
  readonly scope: TenantScope;
  readonly teammate: TeammateRow;
  readonly config: TeammateConfig;
  readonly conversationId: string;
  /** The conversation's ai_epoch when it started: another one at the finish means it changed hands. */
  readonly epoch: number;
  readonly batch: readonly BatchMessage[];
  readonly startedAt: Date;
}

interface HandOff {
  readonly reason: ConversationHandoffReason;
  readonly note: string;
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

// ---- The job ----

export const teammateReplyJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const conversationId = str(ctx.job.payload['conversationId']);
  if (!conversationId) return;
  const run = await startRun(ctx, scope, conversationId);
  if (!run) return;
  try {
    return await answer(ctx, run);
  } catch (e) {
    if (e instanceof ProviderBusy) throw e;
    ctx.log.error({ err: e, runId: run.id }, 'the AI teammate couldn’t finish a reply');
    await failRun(ctx, run, e);
  }
};

const triggerOf = (v: unknown): string => {
  const t = str(v);
  return t && t.length <= 80 && /^[a-z_]+(\.[a-z_]+)*$/.test(t) ? t : 'message.received';
};

/** Starts the conversation's run (or resumes this job's), or null when there's nothing for it to do. */
async function startRun(
  ctx: JobContext,
  scope: TenantScope,
  conversationId: string,
): Promise<StartedRun | null> {
  const resumeId = str(ctx.job.payload['_runId']);
  return asWorker(ctx.db, scope, async (tx) => {
    const teammate = await loadTeammate(tx, scope.workspaceId);
    if (!teammate || teammate.status === 'off') return null;
    const config = runtimeConfigOf(teammate.config);
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
          id: r.id,
          scope,
          teammate,
          config,
          conversationId,
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
    const mine = conv.handledBy === 'ai' && conv.aiTeammateId === teammate.id;
    const free = conv.handledBy === 'none' && !conv.assigneeUserId;
    if (!mine && !free) return null;
    const batch = await unansweredMessages(tx, conv.id, conv.aiAnsweredThrough);
    if (!batch.length) return null;
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
            ${triggerOf(ctx.job.payload['trigger'])}, ${epoch}, ${uuidArray(batch.map((b) => b.id))},
            ${ctx.ai.provider?.model.slice(0, 100) ?? null})
          on conflict (conversation_id) where status = 'running' do nothing
          returning id, started_at`,
    );
    if (!made) return null;
    if (free) {
      // Nobody answers it and nobody has it: the teammate picks it up (and a person's reply takes it back).
      await tx
        .update(conversations)
        .set({ handledBy: 'ai', aiTeammateId: teammate.id, aiEpoch: epoch })
        .where(eq(conversations.id, conv.id));
      await recordSystemEvent(tx, {
        type: 'ai_teammate.picked_up',
        action: 'ai_teammate.reply',
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        entityType: 'conversation',
        entityId: conv.id,
        payload: {
          conversationId: conv.id,
          personId: conv.personId,
          teammateId: teammate.id,
          runId: made.id,
        },
        before: { handledBy: 'none' },
        after: { handledBy: 'ai', teammate: teammate.name },
        correlationId: made.id,
        causationId: ctx.job.id,
      });
    }
    // A retry of this job (a busy provider) resumes this run instead of leaving it behind.
    await tx.execute(
      sql`update app.scheduled_jobs set payload = payload || ${JSON.stringify({ _runId: made.id })}::jsonb
          where id = ${ctx.job.id}`,
    );
    return {
      id: made.id,
      scope,
      teammate,
      config,
      conversationId: conv.id,
      epoch,
      batch,
      startedAt: new Date(made.started_at),
    };
  });
}

function aiActorOf(run: StartedRun): AiEmployeeActor {
  return {
    type: 'ai_employee',
    workspaceId: run.scope.workspaceId,
    organizationId: run.scope.organizationId,
    teammateId: run.teammate.id,
    teammateName: run.teammate.name,
    runId: run.id,
    conversationId: run.conversationId,
    approvedBy: null,
    origin: null,
    // Never true here: commands don't simulate, so only the test console (step 7) may, without calling them.
    test: false,
  };
}

async function answer(ctx: JobContext, run: StartedRun): Promise<JobResult> {
  const { scope } = run;
  const rc = await asWorker(ctx.db, scope, (tx) =>
    loadRunContext(tx, {
      scope,
      teammate: run.teammate,
      config: run.config,
      conversationId: run.conversationId,
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
  const leadId = rc.lead?.id ?? null;
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

  const state = newRunState();
  const tools = teammateTools(rc.config, { unverifiedChat: rc.unverifiedChat });
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
    log: ctx.log,
  });
  const onTurnUsage = (usage: AiUsage) =>
    asWorker(ctx.db, scope, (tx) =>
      recordAiUsage(tx, {
        source: 'teammate',
        teammateId: run.teammate.id,
        teammateRunId: run.id,
        model: provider.model,
        usage,
      }),
    );
  const base = {
    provider,
    system: TEAMMATE_SYSTEM,
    context: contextText(rc),
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

  const loop = await runToolLoop({
    ...base,
    messages: [{ role: 'user', content: conversationTurn(rc) }],
    tools: tools.map(toolDefinition),
    maxRounds: rc.config.limits.toolRounds,
  });
  steps += loop.rounds;
  const first = await settle(loop, [], null);
  if (first) return first.value;
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
      return { reason: 'emergency', note: `An emergency (${EMERGENCY_WORDS[kind]}): ${quote(t)}` };
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

function checkReply(rc: RunContext, state: RunState, text: string): ReplyCheck {
  const { profile, business } = rc.grounding;
  return checkTeammateReply(text, {
    channel: rc.conversation.channel,
    disclosure: rc.config.identity.disclosure,
    firstMessage: rc.firstAiMessage,
    askedIfHuman: rc.batch.some((b) => asksIfHuman(b.text)),
    allowed: { ...rc.allowed, urls: [] },
    allowPrices: profile.allowPrices,
    knowledge: [
      briefFromProfile(profile, business),
      ...rc.matches.map((m) => `${m.title}\n${m.body}`),
      ...[...state.found.values()].map((f) => `${f.title}\n${f.body}`),
    ],
    done: {
      booked: state.held.some((a) => a.kind === 'book'),
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
async function closeRun(tx: Tx, runId: string, c: Closing): Promise<void> {
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

const knowledgeOf = (state: RunState) =>
  [...state.found.values()].map((f) => ({ itemId: f.id, title: f.title }));

const snippet = (rc: RunContext) => {
  const t = (rc.batch[rc.batch.length - 1]?.text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};
const handedOffSummary = (reason: ConversationHandoffReason, note: string) =>
  `Handed to a person (${REASON_WORDS[reason]}): ${note}`;
const repliedSummary = (rc: RunContext) => `Replied to “${snippet(rc)}”`;
const draftedSummary = (rc: RunContext, state: RunState) =>
  `Drafted a reply to “${snippet(rc)}”${state.held.length ? `, holding: ${state.held.map((a) => a.summary || a.kind).join('; ')}` : ''}`;
const noReplySummary = (state: RunState) =>
  `No reply needed${state.end?.kind === 'no_reply' ? `: ${state.end.reason}` : ''}`;

/** Hands the conversation to a person as the teammate and closes the run (superseded if a person took it). */
async function endHandedOff(
  ctx: JobContext,
  run: StartedRun,
  ai: AiEmployeeActor,
  meta: RequestMeta,
  h: HandOff,
  extra: Partial<Closing>,
): Promise<JobResult> {
  await asWorker(ctx.db, run.scope, async (tx) => {
    const handed = await handOffAsAi(tx, ai, meta, h.reason, h.note);
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
      await markAnswered(tx, run.conversationId, throughOf(rc), false);
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
    const handed = await handOffAsAi(tx, aiActorOf(run), meta, 'error', note);
    await closeRun(tx, run.id, {
      status: 'failed',
      outcome: handed ? 'handed_off' : null,
      summary: handed ? handedOffSummary('error', note) : `It stopped: ${note}`,
      error: errorMessage(e),
    });
  });
}

const throughOf = (rc: RunContext) => new Date(Math.max(...rc.batch.map((b) => b.at)));

/** The newest message it answered; and, when this reply said it's an AI, that it has. */
async function markAnswered(
  tx: Tx,
  conversationId: string,
  through: Date,
  disclosed: boolean,
): Promise<void> {
  await tx.execute(
    sql`update app.conversations
        set ai_answered_through = greatest(coalesce(ai_answered_through, '-infinity'::timestamptz),
          ${through.toISOString()}::timestamptz)
          ${disclosed ? sql`, ai_disclosed_at = coalesce(ai_disclosed_at, now())` : sql``}
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
  const earliest = new Date(Math.min(...run.batch.map((b) => b.at))).toISOString();
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

async function runHeld(
  tx: Tx,
  ai: AiEmployeeActor,
  meta: RequestMeta,
  a: DraftAction,
  clientId: string,
): Promise<void> {
  const workspaceId = ai.workspaceId;
  if (a.kind === 'book')
    await executeCommandIn(
      tx,
      appointmentBookForCustomer,
      {
        workspaceId,
        calendarId: a.calendarId,
        startsAt: a.startsAt,
        serviceId: a.serviceId,
        ...(a.durationMinutes ? { durationMinutes: a.durationMinutes } : {}),
        sessionId: a.sessionId,
        notes: a.notes,
        clientId,
      },
      ai,
      meta,
    );
  else if (a.kind === 'reschedule')
    await executeCommandIn(
      tx,
      attendeeRescheduleForCustomer,
      { workspaceId, appointmentId: a.appointmentId, startsAt: a.startsAt, sessionId: a.sessionId },
      ai,
      meta,
    );
  else
    await executeCommandIn(
      tx,
      attendeeCancelForCustomer,
      { workspaceId, appointmentId: a.appointmentId, reason: a.reason },
      ai,
      meta,
    );
}

/** Replaces the conversation's pending reply draft with this run's. */
async function makeDraft(
  tx: Tx,
  ctx: JobContext,
  run: StartedRun,
  rc: RunContext,
  state: RunState,
  body: string | null,
  latest: BatchMessage,
): Promise<void> {
  await tx.execute(
    sql`update app.ai_teammate_drafts
        set status = 'cancelled', decided_at = now(), via = 'system', reason = 'A newer reply from the teammate replaced it.'
        where conversation_id = ${rc.conversation.id} and status = 'pending' and kind = 'reply'`,
  );
  const preview = TeammateDraftPreview.parse({
    message:
      body === null
        ? null
        : { channel: rc.conversation.channel, body, subject: null, inReplyToMessageId: latest.id },
    actions: state.held,
    discount: null,
  });
  await insertDraft(tx, ctx, run, rc, 'reply', preview, `ai:${run.id}`, body);
}

/** A discount waits for a manager in any mode: its own approval draft. */
async function makeApproval(
  tx: Tx,
  ctx: JobContext,
  run: StartedRun,
  rc: RunContext,
  discount: Discount,
): Promise<void> {
  const channel = rc.conversation.channel;
  const body = channel === 'sms' ? plainSmsText(discount.message) : discount.message.trim();
  const preview = TeammateDraftPreview.parse({
    message: { channel, body, subject: null, inReplyToMessageId: null },
    actions: [],
    discount: { percent: discount.percent, reason: discount.reason.slice(0, 300) },
  });
  await insertDraft(tx, ctx, run, rc, 'approval', preview, `ai:${run.id}:d`, body);
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
  const [d] = await rows<{ id: string }>(
    tx,
    sql`insert into app.ai_teammate_drafts
          (workspace_id, teammate_id, run_id, conversation_id, person_id, lead_id, kind, preview, expires_at, client_id)
        values (${rc.workspace.id}, ${run.teammate.id}, ${run.id}, ${rc.conversation.id}, ${rc.conversation.personId},
          ${rc.lead?.id ?? null}, ${kind}, ${JSON.stringify(preview)}::jsonb,
          now() + make_interval(mins => ${rc.config.autonomy.draftExpiresMinutes}), ${clientId})
        returning id`,
  );
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

function sendInput(rc: RunContext, runId: string, body: string, latest: BatchMessage) {
  const channel = rc.conversation.channel;
  return {
    workspaceId: rc.workspace.id,
    conversationId: rc.conversation.id,
    channel,
    body,
    ...(channel === 'email' && rc.config.channels.emailAddressId
      ? { emailAddressId: rc.config.channels.emailAddressId }
      : {}),
    // Quiet hours let it answer only the customer's latest text, soon after it came in.
    ...(channel === 'sms' ? { inReplyToMessageId: latest.id } : {}),
    clientId: `ai:${runId}`,
  };
}

type Finished = {
  readonly outcome: 'replied' | 'drafted' | 'no_reply' | 'other';
  readonly waitUntil: Date | null;
};

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
  const channel = rc.conversation.channel;
  const body = text === null ? null : channel === 'sms' ? plainSmsText(text) : text.trim();
  const latest = rc.batch[rc.batch.length - 1]!;
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
      .where(eq(conversations.id, run.conversationId))
      .for('update');
    const teammate = await loadTeammate(tx, run.scope.workspaceId, { teammateId: run.teammate.id });
    const why = await supersededWhy(tx, run, conv, teammate);
    if (why) {
      await closeRun(tx, run.id, { ...common, status: 'superseded', summary: why });
      return none;
    }
    if (teammate!.status === 'training') {
      const drafted = body !== null || state.held.length > 0;
      if (drafted) await makeDraft(tx, ctx, run, rc, state, body, latest);
      if (state.discount) await makeApproval(tx, ctx, run, rc, state.discount);
      await markAnswered(tx, run.conversationId, through, false);
      const outcome = drafted ? 'drafted' : 'no_reply';
      await closeRun(tx, run.id, {
        ...common,
        status: 'done',
        outcome,
        summary: drafted ? draftedSummary(rc, state) : noReplySummary(state),
      });
      return { outcome, waitUntil: null };
    }
    try {
      // The held changes and the message are one unit: a refusal of either undoes both.
      await tx.transaction(async (sp) => {
        for (const [i, a] of state.held.entries())
          await runHeld(sp, ai, meta, a, `ai:${run.id}:${i + 1}`);
        if (body !== null)
          await executeCommandIn(sp, messageSend, sendInput(rc, run.id, body, latest), ai, meta);
      });
    } catch (e) {
      if (!(e instanceof HfosError)) throw e;
      if (e.rule === 'quiet_hours') {
        // Past the reply window (or a first text): it answers again once quiet hours end.
        const m = await workspaceMessaging(tx, run.scope.workspaceId);
        const end =
          quietEndAt(m.settings.quietHours, m.timezone, Date.now()) ?? Date.now() + 5 * 60_000;
        await closeRun(tx, run.id, {
          ...common,
          status: 'done',
          outcome: 'no_reply',
          summary: `Quiet hours: it answers once they end, at ${clockLabel(end, m.timezone)}.`,
        });
        return { outcome: 'other', waitUntil: new Date(end + QUIET_GRACE_MS) };
      }
      if (e.rule === 'not_handled_by_ai') {
        await closeRun(tx, run.id, { ...common, status: 'superseded', summary: TAKEN_OVER });
        return none;
      }
      if (e.rule === 'opted_out') {
        await markAnswered(tx, run.conversationId, through, false);
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
    await markAnswered(tx, run.conversationId, through, body !== null && disclosesAi(body));
    if (state.discount) await makeApproval(tx, ctx, run, rc, state.discount);
    const outcome = body !== null ? 'replied' : 'no_reply';
    await closeRun(tx, run.id, {
      ...common,
      status: 'done',
      outcome,
      summary: outcome === 'replied' ? repliedSummary(rc) : noReplySummary(state),
    });
    return { outcome, waitUntil: null };
  });
  if (result.outcome !== 'other') await bookkeeping(ctx, run, rc, state, false);
  return result.waitUntil ? { rescheduleAt: result.waitUntil } : undefined;
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
