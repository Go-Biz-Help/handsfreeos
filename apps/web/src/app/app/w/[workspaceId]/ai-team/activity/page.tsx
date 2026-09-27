import type { Metadata } from 'next';
import { TeammateActivityTab } from '@/components/ai-team/activity-tab';
import { activityPeriodOf, teammateGetOf } from '@/lib/ai-team/types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'AI teammate activity' };

/**
 * The Activity tab: today's counts, the runs of one period (newest first) and a sheet per run. The period is
 * in the address (`?period=7d`), so a live refresh keeps it.
 */
export default async function AiTeamActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const period = activityPeriodOf((await searchParams).period);
  const { api } = await apiServer();
  const [got, activity] = await Promise.all([
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
    api.POST('/v1/queries/ai_teammate.activity', { body: { workspaceId, since: period } }),
  ]);
  const data = teammateGetOf(unwrapPage(got));
  return (
    <TeammateActivityTab
      workspaceId={workspaceId}
      data={data}
      period={period}
      // What the teammate did is inbox business: someone the business keeps out of the inbox sees the tab empty.
      activity={data.teammate && activity.response.status !== 403 ? unwrapPage(activity) : null}
    />
  );
}
