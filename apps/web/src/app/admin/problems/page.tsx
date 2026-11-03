import { problemArea, problemJob, problemState } from '@hfos/core';
import { ProblemReports } from '@/components/admin/problem-reports';
import { apiServer, unwrapPage } from '@/lib/api/server';

/**
 * What our own tools saw when something didn't go, from every business. The open ones as two sections (20261027023100):
 * the limits each business hit, on top, and what needs a fix grouped by problem. One problem's reports, the handled
 * ones and all of them as a list, a page at a time.
 */
export default async function ProblemsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; area?: string; job?: string; before?: string }>;
}) {
  const params = await searchParams;
  const state = problemState(params.state);
  const area = problemArea(params.area);
  const job = problemJob(params.job);
  const before =
    params.before && !Number.isNaN(Date.parse(params.before))
      ? new Date(params.before).toISOString()
      : null;
  // The open ones with no problem picked are the two sections; the list still brings the areas and the week's steps.
  const grouped = state === 'open' && job === null && before === null;
  const { api } = await apiServer();
  const [list, groups] = await Promise.all([
    api
      .POST('/v1/queries/platform.problem_report.list', {
        body: { state, area, job, kind: null, before, limit: grouped ? 1 : 25 },
      })
      .then(unwrapPage),
    grouped
      ? api.POST('/v1/queries/platform.problem_report.groups', { body: { area } }).then(unwrapPage)
      : Promise.resolve(null),
  ]);
  return (
    <ProblemReports
      reports={grouped ? [] : list.reports}
      groups={groups}
      areas={list.areas}
      steps={list.steps}
      state={state}
      area={area}
      job={job}
      nextBefore={grouped ? null : list.nextBefore}
      older={before !== null}
    />
  );
}
