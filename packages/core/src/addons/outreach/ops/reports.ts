/**
 * What the extension saw (../reports.ts, docs/outreach.md decision 74): the person's computer saves a note of each
 * page a job read, with the page's outline when something was missing. Each person's own, on the database too; an
 * ask's notes go with it, and the day's steps' after a week (the worker's `outreach.live_prune`).
 */
import { and, eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { defineAddonCommand } from '../../server';
import { outreachAddon } from '../manifest';
import { PageReport, ReportSaveInput, ReportSaveOutput } from '../reports';
import { asks, reports } from '../tables';
import { inWorkspace } from './common';

export const reportSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.report.save',
  description:
    'The browser extension saves a note of a page a job read: its kind and address with people’s parts hidden, whether its window was in front, what it found there (counts, never words), and the page’s outline when something was missing. The person’s own; kept a week.',
  risk: 0,
  input: ReportSaveInput,
  output: ReportSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // A note, sent once a page; a repeat is only another note.
  receipt: false,
  emits: ['outreach.report.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const report = PageReport.parse(input.report);
    if (report.askId) {
      const [ask] = await ctx.tx
        .select({ id: asks.id })
        .from(asks)
        .where(and(eq(asks.workspaceId, ws), eq(asks.userId, me), eq(asks.id, report.askId)));
      if (!ask)
        throw HfosError.notFound(
          'That ask isn’t yours, or it’s gone, so its note wasn’t kept. Nothing needs doing.',
        );
    }
    const [row] = await ctx.tx
      .insert(reports)
      .values({
        workspaceId: ws,
        userId: me,
        askId: report.askId,
        platform: report.platform,
        job: report.job,
        version: report.version,
        page: report.page,
        path: report.path,
        shown: report.shown,
        found: report.found,
        note: report.note,
        outline: report.outline,
      })
      .returning({ id: reports.id });
    await ctx.emit({
      type: 'outreach.report.saved',
      entityType: 'outreach_report',
      entityId: row!.id,
      // Never the outline or what was found: the note itself stays the person's own.
      payload: { userId: me, platform: report.platform, job: report.job, page: report.page },
    });
    return { reportId: row!.id };
  },
});

export const reportCommands = [reportSave] as const;
