/**
 * Problem reports (schemas/problem-report.ts): one of HandsFreeOS's own tools sends what it saw when something
 * didn't go, on the person's behalf (`problem_report.send`), and staff mark it handled on the support desk
 * (`problem_report.set_handled`).
 *
 * Anyone who works in the business may send one: it's the person's own, on the database too. Marking one handled is
 * platform-scoped, like everything staff do, and the SQL behind it (`private.set_problem_reports_handled`) checks
 * `platform.health.read` for itself rather than trusting this caller.
 */
import { and, count, eq, gt } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { problemReports } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  PROBLEM_REPORTS_A_DAY,
  ProblemReport,
  ProblemReportSendInput,
  ProblemReportSendOutput,
  ProblemReportSetHandledInput,
  ProblemReportSetHandledOutput,
  LearnedWaySetRemovedInput,
  LearnedWaySetRemovedOutput,
} from '../schemas/problem-report';

const onPlatform = () => ({ kind: 'platform' as const });

export const problemReportSend = defineCommand({
  name: 'problem_report.send',
  description:
    'One of HandsFreeOS’s own tools (the browser extension) sends what it saw when something didn’t go: what it was doing and where, what it found (counts, never words), and the page’s outline with everything a person wrote masked. Read by HandsFreeOS staff; kept 30 days.',
  risk: 0,
  input: ProblemReportSendInput,
  output: ProblemReportSendOutput,
  // Anyone who works in the business: it's their own tool telling us it went wrong.
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  // A report, sent once; a repeat is only another report.
  receipt: false,
  emits: ['problem_report.sent'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const report = ProblemReport.parse(input.report);
    const [today] = await ctx.tx
      .select({ n: count() })
      .from(problemReports)
      .where(
        and(
          eq(problemReports.userId, me),
          gt(problemReports.createdAt, new Date(Date.now() - 24 * 60 * 60_000)),
        ),
      );
    if ((today?.n ?? 0) >= PROBLEM_REPORTS_A_DAY)
      throw HfosError.rule(
        'problem_reports_full',
        429,
        `Your tools have sent ${PROBLEM_REPORTS_A_DAY} problem reports today, so this one wasn’t kept. Nothing needs doing: HandsFreeOS has plenty to look at already.`,
      );
    const [row] = await ctx.tx
      .insert(problemReports)
      .values({
        workspaceId: ws,
        userId: me,
        addonId: report.addonId,
        source: report.source,
        area: report.area,
        job: report.job,
        ref: report.ref,
        version: report.version,
        page: report.page,
        path: report.path,
        shown: report.shown,
        found: report.found,
        note: report.note,
        outline: report.outline,
        helper: report.helper,
      })
      .returning({ id: problemReports.id });
    await ctx.emit({
      type: 'problem_report.sent',
      entityType: 'problem_report',
      entityId: row!.id,
      // Never the outline or what was found: the report itself stays on the desk.
      payload: {
        addonId: report.addonId,
        source: report.source,
        area: report.area,
        job: report.job,
        page: report.page,
      },
    });
    return { reportId: row!.id };
  },
});

export const problemReportSetHandled = defineCommand({
  name: 'problem_report.set_handled',
  description:
    'Support: mark problem reports handled, or open again. One already as asked is left alone.',
  risk: 1,
  input: ProblemReportSetHandledInput,
  output: ProblemReportSetHandledOutput,
  permission: 'platform.health.read',
  scope: onPlatform,
  emits: ['problem_report.handled', 'problem_report.reopened'],
  async handler(ctx, input) {
    const ids = [...new Set(input.reportIds)];
    const changed = (
      await rows<{ id: string }>(
        ctx.tx,
        sql`select id from private.set_problem_reports_handled(${`{${ids.join(',')}}`}::uuid[], ${input.handled})`,
      )
    ).map((r) => r.id);
    if (changed.length)
      await ctx.emit({
        type: input.handled ? 'problem_report.handled' : 'problem_report.reopened',
        entityType: 'problem_report',
        entityId: changed[0]!,
        payload: { reportIds: changed },
        before: { handled: !input.handled },
        after: { handled: input.handled },
      });
    return { changed };
  },
});

/**
 * Support: set learned ways aside, or bring them back (decision 142). One set aside is never tried again, and the
 * same find is never learned again; the SQL behind it checks `platform.health.read` for itself.
 */
export const learnedWaySetRemoved = defineCommand({
  name: 'learned_way.set_removed',
  description:
    'Support: set aside ways the AI helper learned to find a step’s button (so no computer tries them again), or bring them back.',
  risk: 1,
  input: LearnedWaySetRemovedInput,
  output: LearnedWaySetRemovedOutput,
  permission: 'platform.health.read',
  scope: onPlatform,
  emits: ['learned_way.removed', 'learned_way.restored'],
  async handler(ctx, input) {
    const ids = [...new Set(input.wayIds)];
    const changed = (
      await rows<{ id: string }>(
        ctx.tx,
        sql`select id from private.set_learned_ways_removed(${`{${ids.join(',')}}`}::uuid[], ${input.removed})`,
      )
    ).map((r) => r.id);
    if (changed.length)
      await ctx.emit({
        type: input.removed ? 'learned_way.removed' : 'learned_way.restored',
        entityType: 'learned_way',
        entityId: changed[0]!,
        payload: { wayIds: changed },
        before: { removed: !input.removed },
        after: { removed: input.removed },
      });
    return { changed };
  },
});

export const problemReportCommands = [
  problemReportSend,
  problemReportSetHandled,
  learnedWaySetRemoved,
];
