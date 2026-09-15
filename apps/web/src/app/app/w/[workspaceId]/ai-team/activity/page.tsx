import type { Metadata } from 'next';
import { TeammateActivityTab } from '@/components/ai-team/activity-tab';
import { teammateGetOf } from '@/lib/ai-team/types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'AI teammate activity' };

/** The Activity tab: today's counts, every run (newest first) and a sheet per run. */
export default async function AiTeamActivityPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [got, activity] = await Promise.all([
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
    api.POST('/v1/queries/ai_teammate.activity', { body: { workspaceId } }),
  ]);
  const data = teammateGetOf(unwrapPage(got));
  return (
    <TeammateActivityTab
      workspaceId={workspaceId}
      data={data}
      activity={data.teammate ? unwrapPage(activity) : null}
    />
  );
}
