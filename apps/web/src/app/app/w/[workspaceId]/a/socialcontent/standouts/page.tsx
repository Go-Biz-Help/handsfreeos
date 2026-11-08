import { CONTENT_NETWORKS, type ContentNetwork } from '@hfos/core/addons/socialcontent/networks';
import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { STANDOUTS_PAGE_SIZE, StandoutsPage } from '@/addons/socialcontent/standouts-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Standouts · AI Social Media Content Creator' };

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * Standouts (docs/socialcontent.md): studied creators' posts that beat the posts around them, newest first, kept to
 * one network with `?network=` or one creator with `?creator=`. It opens through the gate like every add-on page.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const askedNetwork = one(sp['network']);
  const network = CONTENT_NETWORKS.includes(askedNetwork as ContentNetwork)
    ? (askedNetwork as ContentNetwork)
    : null;
  const askedCreator = one(sp['creator']);
  const creatorId = askedCreator && /^[0-9a-f-]{36}$/i.test(askedCreator) ? askedCreator : null;
  return addonPage(workspaceId, 'socialcontent', 'socialcontent.use', async () => {
    const { api } = await apiServer();
    const [found, studied] = await Promise.all([
      api
        .POST('/v1/queries/socialcontent.post.list', {
          body: {
            workspaceId,
            standoutsOnly: true,
            limit: STANDOUTS_PAGE_SIZE,
            ...(network ? { network } : {}),
            ...(creatorId ? { creatorId } : {}),
          },
        })
        .then(unwrapPage),
      api
        .POST('/v1/queries/socialcontent.creator.list', {
          body: { workspaceId, state: 'studying' },
        })
        .then(unwrapPage),
    ]);
    return (
      <StandoutsPage
        key={`${network ?? ''}:${creatorId ?? ''}`}
        workspaceId={workspaceId}
        posts={found.posts}
        more={found.more}
        creators={studied.creators}
        network={network}
        creatorId={creatorId}
      />
    );
  });
}
