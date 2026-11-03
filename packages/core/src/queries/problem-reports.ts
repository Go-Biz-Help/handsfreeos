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
  LearnedWayListInput,
  LearnedWayListOutput,
  LearnedWayShape,
  PROBLEM_STEP_DAYS,
  ProblemHelper,
  type HelperResult,
  type HelperVerdict,
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
    const found = await rows<
      Row & {
        has_outline: boolean;
        helper_verdict: HelperVerdict | null;
        helper_result: HelperResult | null;
      }
    >(
      ctx.tx,
      sql`select * from private.admin_problem_reports(${open}::boolean, ${input.area}::text,
        ${input.before}::timestamptz, ${input.limit + 1})`,
    );
    const areas = await rows<{ area: string; open: number }>(
      ctx.tx,
      sql`select * from private.admin_problem_report_areas()`,
    );
    const steps = await rows<{
      area: string;
      job: string;
      reports: number;
      open: number;
      in_the_way: number;
      moved: number;
      refused: number;
      fixed: number;
      done_by_helper: number;
    }>(
      ctx.tx,
      sql`select * from private.admin_problem_report_steps(${new Date(
        Date.now() - PROBLEM_STEP_DAYS * 86_400_000,
      ).toISOString()}::timestamptz)`,
    );
    const page = found.slice(0, input.limit);
    return {
      reports: page.map((r) => ({
        ...fields(r),
        hasOutline: r.has_outline,
        helper:
          r.helper_verdict && r.helper_result
            ? { verdict: r.helper_verdict, result: r.helper_result }
            : null,
      })),
      nextBefore: found.length > input.limit ? iso(page[page.length - 1]!.created_at) : null,
      areas: areas.map((a) => ({ area: a.area, open: Number(a.open) })),
      steps: steps.map((t) => ({
        area: t.area,
        job: t.job,
        reports: Number(t.reports),
        open: Number(t.open),
        inTheWay: Number(t.in_the_way),
        moved: Number(t.moved),
        refused: Number(t.refused),
        fixed: Number(t.fixed),
        doneByHelper: Number(t.done_by_helper),
      })),
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
        helper: unknown;
      }
    >(ctx.tx, sql`select * from private.admin_problem_report(${input.reportId}::uuid)`);
    if (!r)
      throw HfosError.notFound(
        'That report isn’t there anymore. Reports go after 30 days. Go back to Problem reports and pick another.',
      );
    // A helper's note kept in an older shape is shown as none rather than refusing the report.
    const helper = r.helper ? ProblemHelper.safeParse(r.helper) : null;
    return {
      ...fields(r),
      found: r.found,
      outline: r.outline,
      handledBy: r.handled_by_name,
      helper: helper?.success ? helper.data : null,
    };
  },
});

/** The support desk's learned ways (decision 142): how the AI helper found steps' buttons in new places. */
export const platformLearnedWayList = defineQuery({
  name: 'platform.learned_way.list',
  description:
    'Support: the ways the AI helper learned to find a step’s button in a new place, across every business: how each is found, how often it worked and failed, and whether every computer tries it.',
  input: LearnedWayListInput,
  output: LearnedWayListOutput,
  permission: 'platform.health.read',
  scope: onPlatform,
  async handler(ctx, input) {
    const found = await rows<{
      id: string;
      addon_id: string | null;
      area: string;
      button: string;
      way: unknown;
      worked: number;
      failed: number;
      businesses: number;
      trusted_at: string | Date | null;
      removed_at: string | Date | null;
      first_at: string | Date;
      last_worked_at: string | Date | null;
      last_failed_at: string | Date | null;
    }>(ctx.tx, sql`select * from private.admin_learned_ways(${input.area}::text)`);
    const when = (at: string | Date | null) => (at ? iso(at) : null);
    return {
      ways: found.flatMap((w) => {
        const way = LearnedWayShape.safeParse(w.way);
        if (!way.success) return [];
        return [
          {
            wayId: w.id,
            addonId: w.addon_id,
            area: w.area,
            button: w.button,
            way: way.data,
            worked: Number(w.worked),
            failed: Number(w.failed),
            businesses: Number(w.businesses),
            trustedAt: when(w.trusted_at),
            removedAt: when(w.removed_at),
            firstAt: iso(w.first_at),
            lastWorkedAt: when(w.last_worked_at),
            lastFailedAt: when(w.last_failed_at),
          },
        ];
      }),
    };
  },
});

export const problemReportQueries = [
  platformProblemReportList,
  platformProblemReportGet,
  platformLearnedWayList,
];
