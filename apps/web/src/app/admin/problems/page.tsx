import { problemArea, problemState } from '@hfos/core';
import { ProblemReports } from '@/components/admin/problem-reports';
import { apiServer, unwrapPage } from '@/lib/api/server';

/** What our own tools saw when something didn't go, from every business: open first, a page at a time. */
export default async function ProblemsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; area?: string; before?: string }>;
}) {
  const params = await searchParams;
  const state = problemState(params.state);
  const area = problemArea(params.area);
  const before =
    params.before && !Number.isNaN(Date.parse(params.before))
      ? new Date(params.before).toISOString()
      : null;
  const { api } = await apiServer();
  const list = await api
    .POST('/v1/queries/platform.problem_report.list', {
      body: { state, area, before, limit: 25 },
    })
    .then(unwrapPage);
  return (
    <ProblemReports
      reports={list.reports}
      areas={list.areas}
      steps={list.steps}
      state={state}
      area={area}
      nextBefore={list.nextBefore}
      older={before !== null}
    />
  );
}
