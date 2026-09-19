import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { ReviewsBoard } from '@/components/reviews/reviews-board';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Reviews' };

/**
 * What customers said in public.
 *
 * These are not HandsFreeOS's reviews and never will be: they belong to Google and Facebook, which is the
 * good news — a business that leaves any system, this one included, takes none of them away. This screen
 * reads them from where they live and gives somewhere to answer.
 */
export default async function ReviewsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const canManage = hasWorkspacePermission(got.workspace.role, 'reviews.manage');
  const list = unwrapPage(await api.POST('/v1/queries/review.list', { body: { workspaceId } }));
  return (
    <>
      <PageHeader
        title="Reviews"
        description="What customers said about you on Google and Facebook, and somewhere to answer them. The reviews stay where people read them — this reads them from there."
      />
      <ReviewsBoard
        workspaceId={workspaceId}
        reviews={list.reviews}
        connections={list.connections}
        summary={list.summary}
        canManage={canManage}
      />
    </>
  );
}
