import type { Metadata } from 'next';
import { TeammateInstructionsTab } from '@/components/ai-team/instructions-tab';
import { teammateGetOf } from '@/lib/ai-team/types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'AI teammate instructions' };

/**
 * The Instructions tab: the rules the AI teammate reads in full on every reply, call and test
 * (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md).
 */
export default async function AiTeamInstructionsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [got, list] = await Promise.all([
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
    api.POST('/v1/queries/teammate_instruction.list', { body: { workspaceId } }),
  ]);
  return (
    <TeammateInstructionsTab
      workspaceId={workspaceId}
      data={teammateGetOf(unwrapPage(got))}
      initial={unwrapPage(list)}
    />
  );
}
