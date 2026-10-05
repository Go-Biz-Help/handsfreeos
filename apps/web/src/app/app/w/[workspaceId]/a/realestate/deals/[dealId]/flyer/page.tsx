import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { FlyerPage } from '@/addons/realestate/flyer-page';
import { ApiError, apiServer, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

export const metadata: Metadata = { title: 'Flyer' };

/** A listing's printable flyer, or why it can't be printed yet (not live on the MLS, no signed description). */
export default async function RealestateFlyerPage({
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
    const [flyer, { listing }, files, brandedOrigin] = await Promise.all([
      api
        .POST('/v1/queries/realestate.listing.flyer', inDeal)
        .then((r) => ({ flyer: unwrapPage(r), refusal: null }))
        .catch((e: unknown) => {
          // Its refusals are the hold's own words, shown with the way to Marketing.
          if (e instanceof ApiError && e.status === 409) return { flyer: null, refusal: e.message };
          throw e;
        }),
      api.POST('/v1/queries/realestate.listing', inDeal).then(unwrapPage),
      api
        .POST('/v1/queries/file.list', {
          body: { workspaceId, recordType: 'custom_record', recordId: dealId },
        })
        .then(unwrapPage),
      brandedOriginFor(api, workspaceId),
    ]);
    return (
      <FlyerPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        businessName={got.workspace.name}
        flyer={flyer.flyer}
        refusal={flyer.refusal}
        listing={listing}
        files={files.files}
        brandedOrigin={brandedOrigin}
      />
    );
  });
}
