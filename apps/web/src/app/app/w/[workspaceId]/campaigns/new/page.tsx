import type { Metadata } from 'next';
import { NewCampaign } from '@/components/campaigns/new-campaign';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'New campaign' };

export default async function NewCampaignPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [tags, pipelines] = await Promise.all([
    api.POST('/v1/queries/tag.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/pipeline.list', { body: { workspaceId } }).then(unwrapPage),
  ]);
  return (
    <>
      <PageHeader
        title="New campaign"
        description="Pick who, say what it’s for, and the AI writes each text for you to read first."
      />
      <NewCampaign workspaceId={workspaceId} tags={tags.tags} pipelines={pipelines.pipelines} />
    </>
  );
}
