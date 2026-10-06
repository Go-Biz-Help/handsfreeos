import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AiQuickSetup } from '@/components/ai-setup/quick-setup';
import { AiTeamIntro } from '@/components/ai-team/teammate-tab';
import { loadAiSetup } from '@/lib/ai-setup/load';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Quick setup' };

/**
 * Quick setup for the AI teammate (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7): where the AI teammate page
 * sends owners and admins (ai_team.manage) until the business has a teammate, and where running it again starts.
 * `?at=try` opens on the test chat after Save. Anyone else goes to the AI teammate page.
 */
export default async function AiQuickSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const team = `/app/w/${workspaceId}/ai-team`;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'ai_team.manage')) redirect(team);
  const [data, query] = await Promise.all([loadAiSetup(api, workspaceId), searchParams]);
  return (
    <div className="max-w-[1080px]">
      <AiTeamIntro />
      <AiQuickSetup
        data={data}
        myselfHref={`${team}?myself=1`}
        settingsHref={team}
        doneHref={team}
        startAt={query['at'] === 'try' ? 'try' : null}
      />
    </div>
  );
}
