import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { MarketingPage } from '@/addons/realestate/marketing-page';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

export const metadata: Metadata = { title: 'Marketing' };

/** A listing's marketing: the MLS hold until it's live, then its public page, a campaign and social posts. */
export default async function RealestateMarketingPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [got, deal] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
    ]);
    if (deal.deal.side !== 'listing') notFound();
    const [{ listing }, marketing, documents, tags, pipelines, brandedOrigin] = await Promise.all([
      api.POST('/v1/queries/realestate.listing', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.listing.marketing', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.document.list', inDeal).then(unwrapPage),
      api.POST('/v1/queries/tag.list', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/pipeline.list', { body: { workspaceId } }).then(unwrapPage),
      brandedOriginFor(api, workspaceId),
    ]);
    return (
      <MarketingPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        listing={listing}
        marketing={marketing}
        mlsDocuments={documents.documents.filter(
          (d) => d.kind === 'mls_listing' && d.status !== 'void' && d.status !== 'superseded',
        )}
        tags={tags.tags}
        pipelines={pipelines.pipelines}
        brandedOrigin={brandedOrigin}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
