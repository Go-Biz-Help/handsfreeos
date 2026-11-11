/**
 * A job's daily report (docs/contractor.md, "The AI helpers"): what the crew left on a job in one day (typed and
 * voice notes, photos, the checklist items ticked, who was on the clock), written up by the AI for the office.
 *
 * - **On its own.** A note landing on a job queues that day's report for 6 PM where the business is (or half an
 *   hour on, once it's past six), one per job per day. A voice note's words arriving does the same, so a report
 *   written before they came is written again with them. The business can turn this off in Settings.
 * - **On a press.** Write today's report on the job's page, and the Assistant's tool.
 * - **A person's words win.** A report someone changed is never written over, unless they ask.
 * - **It reaches nobody.** The report is the office's own record. Its update for the customer goes only when a
 *   person sends it (`contractor.report.send`, in core).
 * - **No money.** The AI is given hours, never what they cost.
 */
import {
  checkedReport,
  REPORT_LIMITS,
  REPORT_SCHEMA,
  REPORT_SYSTEM,
  reportAsk,
  ReportAnswer,
  reportDayWords,
  reportDueAt,
  reportHasEnough,
  type ReportSource,
} from '@hfos/core/addons/contractor/daily-report';
import { reportKeep, reportSource } from '@hfos/core/addons/contractor/ops/reports';
import { REFUSALS } from '@hfos/core/addons/contractor/words';
import {
  executeCommand,
  executeQuery,
  HfosError,
  localDateOf,
  type SystemActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { AiAskError, askStructured } from '../../ai/ask';
import type { JobResult } from '../../jobs';
import { scheduleAddonJob } from '../queue';
import type {
  AddonEventContext,
  AddonJobContext,
  AddonScopeContext,
  AddonWorkerAction,
} from '../types';
import { aiRefusal, photosForAi, usageOf } from './ai';

export const REPORT_WRITE = 'contractor.report_write';
export const REPORT_ACTION = 'contractor.report.write';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A note landed on a job, or a voice note got its words: that day's report is queued for the evening, or for half
 * an hour on when the evening has come. One pending per job and day, so a busy afternoon queues it once.
 */
export async function noteForReport(ctx: AddonEventContext): Promise<void> {
  const noteId = str(((ctx.event.payload ?? {}) as Record<string, unknown>)['noteId']);
  if (!noteId) return;
  const [note] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ record_id: string; noted_at: Date; timezone: string | null; reports: string | null }>(
      tx,
      sql`select n.record_id, n.noted_at, w.timezone, i.settings ->> 'dailyReports' as reports
          from addon_contractor.notes n
          join app.workspaces w on w.id = n.workspace_id
          left join app.addon_installations i on i.workspace_id = n.workspace_id and i.addon_id = 'contractor'
          where n.id = ${noteId}::uuid and n.workspace_id = ${ctx.scope.workspaceId}::uuid`,
    ),
  );
  // Taken off meanwhile, or the business writes its reports by hand.
  if (!note || note.reports === 'false') return;
  const zone = note.timezone || 'America/Chicago';
  const day = localDateOf(new Date(note.noted_at).getTime(), zone);
  const runAt = new Date(
    Math.max(reportDueAt(day, zone).getTime(), Date.now() + REPORT_LIMITS.settleMinutes * 60_000),
  );
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: REPORT_WRITE,
        dedupeKey: `report:${note.record_id}:${day}`,
        runAt,
        payload: { jobId: note.record_id, day },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

type Wrote =
  | { readonly status: 'written'; readonly reportId: string; readonly day: string }
  /** Nothing with words or a picture that day; `waiting` when a voice note's words are still on their way. */
  | { readonly status: 'nothing' | 'waiting'; readonly day: string }
  /** A person changed the day's report, so it was left as theirs. */
  | { readonly status: 'edited'; readonly day: string }
  /** The business writes its reports by hand, and this wasn't a person asking. */
  | { readonly status: 'off'; readonly day: string }
  /** The AI answered with nothing usable. */
  | { readonly status: 'failed'; readonly day: string };

/** Writes one day's report for a job: reads the day, asks the AI, keeps what it wrote. */
async function writeReport(
  ctx: AddonScopeContext,
  actor: SystemActor,
  input: {
    readonly jobId: string;
    readonly day?: string;
    readonly replace: boolean;
    /** Written on its own that evening, not on a person's press: only when the business has that on. */
    readonly onItsOwn: boolean;
  },
): Promise<Wrote> {
  const workspaceId = ctx.scope.workspaceId;
  const found = await executeQuery(
    ctx.db,
    reportSource,
    { workspaceId, jobId: input.jobId, ...(input.day ? { day: input.day } : {}) },
    actor,
    ctx.meta,
  );
  const day = found.day;
  if (input.onItsOwn && !found.onItsOwn) return { status: 'off', day };
  if (found.existing?.edited && !input.replace) return { status: 'edited', day };
  const photos = await photosForAi(ctx, found.photoFileIds, REPORT_LIMITS.photos);
  const source: ReportSource = {
    job: found.job,
    business: found.business,
    day: found.dayWords,
    notes: found.notes,
    ticked: found.ticked,
    crew: found.crew,
    visits: found.visits,
    photos: photos.length,
  };
  if (!reportHasEnough(source)) return { status: found.waitingWords ? 'waiting' : 'nothing', day };
  const { value } = await askStructured(ctx, ctx.scope, {
    system: REPORT_SYSTEM,
    messages: [{ role: 'user', content: [...photos, { type: 'text', text: reportAsk(source) }] }],
    schema: REPORT_SCHEMA,
    zod: ReportAnswer,
    maxTokens: 3000,
    usage: usageOf(ctx),
  });
  const body = checkedReport(value);
  if (!body) return { status: 'failed', day };
  const { output } = await executeCommand(
    ctx.db,
    reportKeep,
    {
      workspaceId,
      jobId: input.jobId,
      day,
      body: {
        summary: body.summary,
        done: [...body.done],
        issues: [...body.issues],
        materials: [...body.materials],
        next: [...body.next],
        forCustomer: body.forCustomer,
      },
      crew: found.crew.slice(0, 50),
      photoFileIds: found.photoFileIds,
      notesRead: found.notes.length,
      photosRead: photos.length,
      replace: input.replace,
    },
    actor,
    ctx.meta,
  );
  return output.kept && output.reportId
    ? { status: 'written', reportId: output.reportId, day }
    : { status: 'edited', day };
}

/** `contractor.report_write`: the day's report for one job, the evening of a day with notes. */
export async function reportWriteJob(ctx: AddonJobContext): Promise<JobResult> {
  const jobId = str(ctx.job.payload['jobId']);
  const day = str(ctx.job.payload['day']);
  if (!jobId || !day || !DAY.test(day)) return;
  try {
    const out = await writeReport(ctx, ctx.actor, { jobId, day, replace: false, onItsOwn: true });
    // `waiting`: a voice note's words are still coming, and their arrival queues the day again.
    if (out.status !== 'written')
      ctx.log.info({ jobId, day, status: out.status }, 'no daily report was written');
  } catch (e) {
    // The job was archived or deleted meanwhile: nothing to write up.
    if (e instanceof HfosError && e.status === 404) return;
    if (!(e instanceof AiAskError)) throw e;
    // A busy model is worth another try. Out of AI budget, or off: the day can be written by hand with a press.
    if (e.retryable && ctx.attempt < 3) throw e;
    ctx.log.info({ code: e.code, jobId, day }, 'a daily report waits for the AI');
  }
}

const WriteInput = z.strictObject({
  jobId: z.uuid(),
  /** The business's own day, `YYYY-MM-DD`; today when left out. */
  day: z.iso.date().optional(),
  /** Write over a report a person changed. */
  replace: z.boolean().default(false),
});

/** Write today's report, from the job's Daily reports card. */
export const writeReportNow: AddonWorkerAction<z.output<typeof WriteInput>> = {
  permission: 'contractor.use',
  ai: {
    tool: 'contractor_write_report',
    description:
      'Have the AI write a job’s daily report now (jobId; day as YYYY-MM-DD, today when left out) from that day’s notes from the field, their photos, the checklist items ticked and who was on the clock: a summary, what got done, what needs a look, materials, what’s next, and a short update for the customer. It’s the office’s own record and reaches nobody: the customer’s update goes only when a person sends it (contractor_send_report). Refused when the day has no note with words and no photo, and when a person already changed that day’s report, unless replace is true (only when they ask for it to be written again).',
    autonomy: 'auto',
    keywords: ['daily report', 'write the report', 'job report', 'daily log'],
  },
  input: WriteInput,
  async run(ctx, input) {
    let out: Wrote;
    try {
      out = await writeReport(
        ctx,
        // The worker does this for the person who pressed it: the report says who asked.
        { ...ctx.actor, onBehalfOf: ctx.userId },
        { jobId: input.jobId, day: input.day, replace: input.replace, onItsOwn: false },
      );
    } catch (e) {
      throw e instanceof AiAskError ? aiRefusal(e, 'The AI couldn’t write that just now.') : e;
    }
    switch (out.status) {
      case 'written':
        return { reportId: out.reportId, jobId: input.jobId, day: out.day };
      case 'waiting':
        throw HfosError.rule('contractor_report_words_waiting', 409, REFUSALS.reportWordsWaiting);
      case 'edited':
        throw HfosError.rule('contractor_report_edited', 409, REFUSALS.reportEdited(null));
      case 'failed':
        throw HfosError.rule(
          'ai_failed',
          502,
          'The AI couldn’t write that just now. Try again in a minute.',
        );
      default:
        throw HfosError.rule(
          'contractor_report_nothing',
          409,
          REFUSALS.reportNothing(reportDayWords(out.day)),
        );
    }
  },
};
