/**
 * Learning from wins (round four, docs/salescoach.md).
 *
 * - **Wins.** A job booked, an estimate accepted, an invoice paid or a Pipeline deal won marks the customer's coached
 *   calls and conversations of the week before as won (`salescoach.win.note`).
 * - **Lessons.** Once a week (`salescoach.learn`, armed when the add-on turns on, from then), and whenever an owner
 *   asks (`salescoach.learn.now`), each playbook in use is looked at over the last 90 days: the AI writes better answers
 *   from the reps' winning ones and new objections from what kept coming up in wins, core holds them to the numbers
 *   (learn.ts), and `salescoach.lessons.put` keeps them for owners and admins to use or dismiss.
 */
import {
  checkedLessons,
  LEARN_EVERY_MS,
  LEARN_LOOKBACK_DAYS,
  LEARN_SCHEMA,
  LEARN_SYSTEM,
  LearnAnswer,
  learnPrompt,
  LESSON_MIN_WINS,
  NEW_MIN_WINS,
  newInWins,
  tallyObjections,
  type LearnRecord,
  type WinKind,
} from '@hfos/core/addons/salescoach/learn';
import { lessonsPut, winNote } from '@hfos/core/addons/salescoach/ops/learning';
import { PlaybookDetails } from '@hfos/core/addons/salescoach/playbooks';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type {
  AddonJobHandler,
  AddonScopeContext,
  AddonSubscriber,
  AddonWorkerAction,
} from '../types';

export const LEARN_JOB = 'salescoach.learn';

/** A win of this kind: the customers it's about, from the event, then their coached records marked. */
export function onWin(how: WinKind): AddonSubscriber {
  return async (ctx) => {
    const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
    let personIds: string[] = [];
    if (Array.isArray(p['personIds']))
      personIds = p['personIds'].filter((x): x is string => typeof x === 'string');
    else if (typeof p['personId'] === 'string') personIds = [p['personId']];
    else if (how === 'deal' && ctx.event.entityId) {
      const [lead] = await asWorker(ctx.db, ctx.scope, (tx) =>
        rows<{ person_id: string | null }>(
          tx,
          sql`select person_id from app.leads where id = ${ctx.event.entityId} and workspace_id = ${ctx.scope.workspaceId}`,
        ),
      );
      if (lead?.person_id) personIds = [lead.person_id];
    }
    if (personIds.length === 0) return;
    await executeCommand(
      ctx.db,
      winNote,
      {
        workspaceId: ctx.scope.workspaceId,
        personIds: [...new Set(personIds)].slice(0, 20),
        how,
        at: new Date(ctx.event.createdAt).toISOString(),
      },
      ctx.actor,
      ctx.meta,
    );
  };
}

/** Arms the weekly look, from now: nothing that came due while the add-on was off runs late. */
export async function armLearning(ctx: AddonScopeContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: LEARN_JOB,
        dedupeKey: `${LEARN_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(Date.now() + LEARN_EVERY_MS),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

const HeardObjection = z.object({
  said: z.string(),
  answered: z.boolean(),
  answer: z.string().default(''),
  objectionId: z.string().nullable().default(null),
});

/** What the coach learns for each playbook in use. How many lessons it kept. */
export async function learn(ctx: AddonScopeContext): Promise<number> {
  const ws = ctx.scope.workspaceId;
  const books = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ id: string; details: unknown }>(
      tx,
      sql`select id, details from addon_salescoach.playbooks where workspace_id = ${ws} and archived_at is null`,
    ),
  );
  let kept = 0;
  for (const book of books) {
    const parsed = PlaybookDetails.safeParse(book.details);
    if (!parsed.success) continue;
    const details = parsed.data;
    const found = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{ id: string; won: boolean; objections: unknown }>(
        tx,
        sql`select id, won_at is not null as won, coalesce(result -> 'objections', '[]'::jsonb) as objections
            from addon_salescoach.calls
            where workspace_id = ${ws} and playbook_id = ${book.id} and state = 'done'
              and started_at > now() - make_interval(days => ${LEARN_LOOKBACK_DAYS})`,
      ),
    );
    const records: LearnRecord[] = found.map((r) => ({
      id: r.id,
      won: r.won,
      objections: z.array(HeardObjection).catch([]).parse(r.objections),
    }));
    const tallies = tallyObjections(records, details);
    const fresh = newInWins(records);
    const worth =
      tallies.some((t) => t.wins >= LESSON_MIN_WINS && t.winningAnswers.length) ||
      new Set(fresh.map((f) => f.record)).size >= NEW_MIN_WINS;
    if (!worth) continue;
    let answer: LearnAnswer;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: LEARN_SYSTEM,
        messages: [{ role: 'user', content: learnPrompt({ playbook: details, tallies, fresh }) }],
        schema: LEARN_SCHEMA,
        zod: LearnAnswer,
        maxTokens: 2500,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      answer = value;
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      if (e.retryable) throw e;
      ctx.log.info({ code: e.code }, 'nothing learned from wins this time');
      continue;
    }
    const lessons = checkedLessons(answer, details, tallies, fresh);
    if (!lessons.length) continue;
    const { output } = await executeCommand(
      ctx.db,
      lessonsPut,
      {
        workspaceId: ws,
        playbookId: book.id,
        lessons: lessons.map((l) => ({ ...l, evidence: [...l.evidence].slice(0, 200) })),
      },
      ctx.actor,
      ctx.meta,
    );
    kept += output.kept;
  }
  return kept;
}

/** The weekly look; then the next one, a week on. */
export const learnWeekly: AddonJobHandler = async (ctx) => {
  await learn(ctx);
  return { rescheduleAt: new Date(ctx.now + LEARN_EVERY_MS) };
};

/** An owner or admin asked the coach to look again now (Playbooks → What’s working). */
export const learnNow: AddonWorkerAction<Record<string, never>> = {
  permission: 'salescoach.manage',
  ai: {
    tool: 'salescoach_learn_from_wins',
    description:
      "Have the Sales Coach look at the last 90 days of won calls and conversations now, rather than at its weekly time: the AI writes better answers from the reps' winning ones and new objections, kept for owners and admins to use or dismiss in Playbooks, What's working.",
    autonomy: 'auto',
    keywords: ['learn from wins', 'whats working', 'update the coach'],
  },
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async run(ctx) {
    return { kept: await learn(ctx) };
  },
};
