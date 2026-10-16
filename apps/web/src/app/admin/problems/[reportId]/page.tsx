import { ProblemReportView } from '@/components/admin/problem-reports';
import { apiServer, unwrapPage } from '@/lib/api/server';

/** One problem report: what the tool found, the page's outline, and handing it to Claude. */
export default async function ProblemPage({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const { api } = await apiServer();
  const report = await api
    .POST('/v1/queries/platform.problem_report.get', { body: { reportId } })
    .then(unwrapPage);
  return <ProblemReportView report={report} />;
}
