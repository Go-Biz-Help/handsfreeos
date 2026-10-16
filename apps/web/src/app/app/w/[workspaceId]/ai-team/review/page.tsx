import type { Metadata } from 'next';
import { TeammateReviewTab } from '@/components/ai-team/review-tab';
import { teammateGetOf } from '@/lib/ai-team/types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'AI teammate review' };

/**
 * The Review tab: what the AI teammate sent on its own, to rate (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md).
 * Only the ones nobody rated yet, unless the address says `?show=all`.
 */
export default async function AiTeamReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const show = (await searchParams).show === 'all' ? 'all' : 'unrated';
  const { api } = await apiServer();
  const [got, review] = await Promise.all([
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
    api.POST('/v1/queries/ai_teammate.review', { body: { workspaceId, show } }),
  ]);
  const data = teammateGetOf(unwrapPage(got));
  return (
    <TeammateReviewTab
      key={show}
      workspaceId={workspaceId}
      data={data}
      show={show}
      // What it sent is inbox business: someone the business keeps out of the inbox sees why it's empty.
      initial={data.teammate && review.response.status !== 403 ? unwrapPage(review) : null}
    />
  );
}
