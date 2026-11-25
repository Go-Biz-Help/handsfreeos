/**
 * Questions on a schedule (the owner, 25 Nov 2026: "Every Monday, text me who owes money"): the Assistant asks a
 * person's question for them at the time they set, answers it in the question's own chat, and sends the answer to
 * their phone (`assistant_answer`), and to their email when they said so.
 *
 * - **As the person.** It runs as them, so the answer holds only what their screens show, with look-ups only: nothing
 *   is changed, sent or booked by a question nobody is there for. The business pays for it as for any question, and
 *   the daily AI limit counts it.
 * - **Armed from the routine's change** (`assistant_routine.changed`), and again after each answer. The job reads the
 *   routine when it runs: paused, deleted or moved since, it waits or stops.
 * - **Someone who can no longer ask** (left the business, lost the Assistant, or took back their OK to send questions
 *   to an AI service): it pauses, and their Notifications list says so.
 */
import { randomUUID } from 'node:crypto';
import {
  answerPreview,
  assistantConsentOf,
  cadenceWords,
  executeCommandIn,
  nextRoutineRun,
  RoutineCadence,
  assistantRoutineRecordRun,
  scheduleJob,
  type HumanActor,
} from '@hfos/core/server';
import { asUser, asWorker, rows, sql } from '@hfos/db/client';
import { questionContext } from '../assistant/context';
import { ask } from '../assistant/runtime';
import { routineAnswerEmail } from '../emails/templates';
import type { EventHandler } from '../handlers/types';
import type { JobContext, JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { queuePush } from '../push/queue';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

export const ROUTINE_QUESTION_JOB = 'assistant_routine.ask';
export const routineQuestionKey = (routineId: string): string => `routine:${routineId}`;
/** Due this long ago (the worker was down): that time is skipped, and it's asked at the next one. */
export const ROUTINE_LATE_MS = 6 * 60 * 60_000;
/** The longest one answer may take before it's stopped. */
export const ROUTINE_ANSWER_MS = 4 * 60_000;
const EARLY_MS = 30_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

interface Routine extends Record<string, unknown> {
  user_id: string;
  question: string | null;
  cadence: unknown;
  email: boolean;
  thread_id: string | null;
  thread_open: boolean;
  next_run_at: Date | null;
  paused_at: Date | null;
  kind: string;
  timezone: string | null;
  business: string;
}

/** A routine made or changed: its question's next run, when it has one. */
export const onRoutineChanged: EventHandler = async (ctx) => {
  const routineId = ctx.event.entityId;
  if (!routineId) return;
  const scope = tenantOf(ctx.scope);
  const [r] = await rows<{ next_run_at: Date | null }>(
    ctx.tx,
    sql`select next_run_at from app.assistant_routines
        where id = ${routineId} and workspace_id = ${scope.workspaceId}
          and kind = 'question' and paused_at is null`,
  );
  if (!r?.next_run_at) return;
  await armQuestion(ctx.tx, scope, routineId, new Date(r.next_run_at));
};

async function armQuestion(
  tx: Parameters<typeof scheduleJob>[0],
  scope: TenantScope,
  routineId: string,
  runAt: Date,
): Promise<void> {
  await scheduleJob(
    tx,
    {
      kind: ROUTINE_QUESTION_JOB,
      dedupeKey: routineQuestionKey(routineId),
      runAt,
      payload: { routineId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

/** Its answer, or why there's none, as `ask` streamed it. */
interface Answered {
  threadId: string | null;
  text: string;
  error: string | null;
}

async function answer(
  ctx: JobContext,
  scope: TenantScope,
  actor: HumanActor,
  r: Routine,
  when: string,
): Promise<Answered> {
  const assistant = ctx.assistant!;
  const context = await questionContext(
    ctx.db,
    actor,
    scope.workspaceId,
    null,
    randomUUID(),
    new Date(ctx.now),
    {
      modules: assistant.addons,
      catalog: assistant.addonCatalog,
      workerModules: assistant.workerAddons,
    },
  );
  // Look-ups only: nothing is changed by a question nobody is there to answer for.
  const reads = assistant.tools.reads?.bind(assistant.tools);
  const tools = reads ? context.tools.filter((t) => t.autonomy === 'auto' && reads(t)) : [];
  const out: Answered = { threadId: null, text: '', error: null };
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ROUTINE_ANSWER_MS);
  try {
    await ask(
      {
        db: ctx.db,
        provider: assistant.provider,
        tools: assistant.tools,
        wallet: ctx.wallet,
        log: ctx.log,
      },
      {
        actor,
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
        ...(r.thread_id && r.thread_open ? { threadId: r.thread_id } : {}),
        text: r.question!,
        page: null,
        tools,
        prompt: { ...context.prompt, scheduled: { when } },
      },
      (event) => {
        if (event.type === 'run') out.threadId = event.threadId;
        else if (event.type === 'text') out.text += event.delta;
        else if (event.type === 'error') out.error = event.message;
      },
      stop.signal,
    );
  } finally {
    clearTimeout(timer);
  }
  return out;
}

export const routineQuestionJob: JobHandler = async (ctx) => {
  const routineId = str((ctx.job.payload ?? {})['routineId']);
  if (!routineId) return;
  const scope = tenantOf(ctx.scope);
  const [r] = await asWorker(ctx.db, scope, (tx) =>
    rows<Routine>(
      tx,
      sql`select r.user_id, r.question, r.cadence, r.email, r.thread_id, r.next_run_at, r.paused_at,
            r.kind::text as kind, w.timezone, w.name as business,
            coalesce((select t.archived_at is null from app.assistant_threads t where t.id = r.thread_id), false)
              as thread_open
          from app.assistant_routines r join app.workspaces w on w.id = r.workspace_id
          where r.id = ${routineId} and r.workspace_id = ${scope.workspaceId}`,
    ),
  );
  if (!r || r.kind !== 'question' || r.paused_at || !r.next_run_at || !r.question) return;
  const cadence = RoutineCadence.safeParse(r.cadence);
  if (!cadence.success) return;
  const due = new Date(r.next_run_at).getTime();
  if (ctx.now < due - EARLY_MS) return { rescheduleAt: new Date(due) };
  const tz = r.timezone || 'UTC';
  const next = new Date(nextRoutineRun(cadence.data, Math.max(ctx.now, due), tz));
  const record = (threadId: string | null, nextRunAt: Date | null) =>
    asWorker(ctx.db, scope, async (tx) => {
      await executeCommandIn(
        tx,
        assistantRoutineRecordRun,
        {
          workspaceId: scope.workspaceId,
          routineId,
          threadId,
          ranAt: new Date(ctx.now).toISOString(),
          nextRunAt: nextRunAt?.toISOString() ?? null,
        },
        systemActor(scope),
        workerMeta(),
      );
      if (nextRunAt) await armQuestion(tx, scope, routineId, nextRunAt);
    });

  // Missed by hours (the worker was down): that one is skipped, and the next one comes as usual.
  if (ctx.now - due > ROUTINE_LATE_MS) return void (await record(null, next));
  if (!ctx.assistant) {
    ctx.log.warn({ routineId }, 'a scheduled question came due with no Assistant set up');
    return void (await record(null, next));
  }

  const [me] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ email: string; settings: unknown }>(
      tx,
      sql`select email, settings from app.users where id = ${r.user_id} and deleted_at is null`,
    ),
  );
  const actor: HumanActor = {
    type: 'human',
    userId: r.user_id,
    email: me?.email ?? '',
    claims: { sub: r.user_id, ...(me?.email ? { email: me.email } : {}) },
  };
  const [may] = me
    ? await asUser(ctx.db, actor.claims, (tx) =>
        rows<{ ok: boolean }>(
          tx,
          sql`select private.has_permission(${scope.workspaceId}::uuid, 'assistant.use') as ok`,
        ),
      )
    : [];
  // They can't ask anymore: it pauses rather than answering for someone who isn't there.
  if (!may?.ok || assistantConsentOf(me?.settings).needed) return void (await record(null, null));

  const when = cadenceWords(cadence.data);
  let got: Answered;
  try {
    got = await answer(ctx, scope, actor, r, when);
  } catch (e) {
    ctx.log.warn({ err: errorMessage(e), routineId }, 'a scheduled question could not be asked');
    got = {
      threadId: null,
      text: '',
      error: 'Something went wrong asking it. It’ll be asked again next time.',
    };
  }
  const threadId = got.threadId ?? (r.thread_open ? r.thread_id : null);
  await record(threadId, next);

  const said = got.text.trim() || got.error || 'No answer came back this time.';
  const link = threadId
    ? `/app/w/${scope.workspaceId}/assistant?chat=${threadId}`
    : `/app/w/${scope.workspaceId}/assistant`;
  await asWorker(ctx.db, scope, (tx) =>
    queuePush(tx, scope, {
      key: `routine:${routineId}:${due}`,
      category: 'assistant_answer',
      userIds: [r.user_id],
      title: r.question!.length > 60 ? `${r.question!.slice(0, 59)}…` : r.question!,
      about: 'Assistant',
      body: answerPreview(said),
      path: link,
      refs: {},
      collapseId: `routine-${routineId}`,
    }),
  );
  if (r.email && me?.email && got.text.trim()) {
    const mail = routineAnswerEmail({
      business: r.business,
      question: r.question,
      when,
      answer: got.text,
      link: `${ctx.webUrl}${link}`,
      manage: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings#notifications`,
    });
    try {
      await ctx.mailer.send({ to: me.email, ...mail });
    } catch (e) {
      // The push went and the chat has it: a mail server's bad minute isn't worth asking the AI again.
      ctx.log.warn({ err: errorMessage(e), routineId }, 'a scheduled answer’s email did not send');
    }
  }
};
