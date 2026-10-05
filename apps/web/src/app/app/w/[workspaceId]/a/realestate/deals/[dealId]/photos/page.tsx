import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { ListingPhotosPage } from '@/addons/realestate/listing-photos-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Photos' };

/** A listing's photos: their order, captions and which the public page shows. */
export default async function RealestateListingPhotosPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const deal = await api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage);
    if (deal.deal.side !== 'listing') notFound();
    const [{ listing }, files] = await Promise.all([
      api.POST('/v1/queries/realestate.listing', inDeal).then(unwrapPage),
      api
        .POST('/v1/queries/file.list', {
          body: { workspaceId, recordType: 'custom_record', recordId: dealId },
        })
        .then(unwrapPage),
    ]);
    return (
      <ListingPhotosPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        listing={listing}
        files={files.files}
        sellers={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
