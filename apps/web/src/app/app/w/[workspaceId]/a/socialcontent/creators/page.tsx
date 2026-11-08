import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { CreatorsPage } from '@/addons/socialcontent/creators-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Creators · AI Social Media Content Creator' };

/**
 * Creators (docs/socialcontent.md): the niches searched and the creators found, studied and skipped. It opens through
 * the gate: "not available here" while the add-on is off, and not found for someone without `socialcontent.use`.
 */
export default async function Page({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'socialcontent', 'socialcontent.use', async () => {
    const { api } = await apiServer();
    const [overview, niches, creators] = await Promise.all([
      api.POST('/v1/queries/socialcontent.overview', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/socialcontent.niche.list', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/socialcontent.creator.list', { body: { workspaceId } })
        .then(unwrapPage),
    ]);
    return (
      <CreatorsPage
        workspaceId={workspaceId}
        overview={overview}
        niches={niches.niches}
        creators={creators.creators}
      />
    );
  });
}
