/**
 * The support desk's Problem reports (schemas/problem-report.ts): what our own tools saw when something didn't go,
 * from every business, newest first; and one report with its outline. Read through definers that check
 * `platform.health.read` for themselves (20261027008100), as Health's are.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import {
  ProblemReportGetInput,
  ProblemReportGetOutput,
  ProblemReportListInput,
  ProblemReportListOutput,
  type ProblemSource,
} from '../schemas/problem-report';

const onPlatform = () => ({ kind: 'platform' as const });

type Row = {
  id: string;
  created_at: string | Date;
  workspace_id: string;
  business: string;
  addon_id: string | null;
  source: ProblemSource;
  area: string;
  job: string;
  ref: string | null;
  version: string | null;
  page: string;
  path: string;
  shown: boolean | null;
  note: string | null;
  handled_at: string | Date | null;
};

const iso = (at: string | Date) => new Date(at).toISOString();

const fields = (r: Row) => ({
  reportId: r.id,
  at: iso(r.created_at),
  workspaceId: r.workspace_id,
  business: r.business,
  addonId: r.addon_id,
  source: r.source,
  area: r.area,
  job: r.job,
  ref: r.ref,
  version: r.version,
  page: r.page,
  path: r.path,
  shown: r.shown,
  note: r.note,
  handledAt: r.handled_at ? iso(r.handled_at) : null,
});

export const platformProblemReportList = defineQuery({
  name: 'platform.problem_report.list',
  description:
    'Support: what HandsFreeOS’s own tools saw when something didn’t go, from every business, newest first: open, handled or both, on one area or all.',
  input: ProblemReportListInput,
  output: ProblemReportListOutput,
  permission: 'platform.health.read',
  scope: onPlatform,
  async handler(ctx, input) {
    const open = input.state === 'all' ? null : input.state === 'open';
    const found = await rows<Row & { has_outline: boolean }>(
      ctx.tx,
      sql`select * from private.admin_problem_reports(${open}::boolean, ${input.area}::text,
        ${input.before}::timestamptz, ${input.limit + 1})`,
    );
    const areas = await rows<{ area: string; open: number }>(
      ctx.tx,
      sql`select * from private.admin_problem_report_areas()`,
    );
    const page = found.slice(0, input.limit);
    return {
      reports: page.map((r) => ({ ...fields(r), hasOutline: r.has_outline })),
      nextBefore: found.length > input.limit ? iso(page[page.length - 1]!.created_at) : null,
      areas: areas.map((a) => ({ area: a.area, open: Number(a.open) })),
    };
  },
});

export const platformProblemReportGet = defineQuery({
  name: 'platform.problem_report.get',
  description:
    'Support: one problem report, with what the tool found and the page’s outline (everything a person wrote masked).',
  input: ProblemReportGetInput,
  output: ProblemReportGetOutput,
  permission: 'platform.health.read',
  scope: onPlatform,
  async handler(ctx, input) {
    const [r] = await rows<
      Row & {
        found: Record<string, unknown>;
        outline: string | null;
        handled_by_name: string | null;
      }
    >(ctx.tx, sql`select * from private.admin_problem_report(${input.reportId}::uuid)`);
    if (!r)
      throw HfosError.notFound(
        'That report isn’t there anymore. Reports go after 30 days. Go back to Problem reports and pick another.',
      );
    return { ...fields(r), found: r.found, outline: r.outline, handledBy: r.handled_by_name };
  },
});

export const problemReportQueries = [platformProblemReportList, platformProblemReportGet];
