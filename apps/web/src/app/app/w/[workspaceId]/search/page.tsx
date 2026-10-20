import { managesAnAgency, SEARCH_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { SearchPage } from '@/components/search/search-page';
import { apiServer, getMe, getPlatformMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: SEARCH_WORDS.page };

/**
 * The Search page, `/search#q=…&kind=…` (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, decision 37): only the frame comes
 * from here. What's typed lives after `#`, which a browser never sends, so this reads no `searchParams` and asks the
 * API for no results: the page asks for them from the browser. What it does fetch is about the business, for the
 * Settings group: its name, clock and settings, and who has the notification rows only some people do.
 */
export default async function SearchRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  // Recent searches are the signed-in person's own, even while viewing the app as a teammate.
  const { api, signedInAs } = await apiServer();
  const [got, me, platform] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    getMe(),
    getPlatformMe(),
  ]);
  return (
    <SearchPage
      business={{
        workspaceId,
        userId: signedInAs,
        name: got.workspace.name,
        timeZone: got.workspace.timezone,
        settings: got.workspace.settings,
        staff: Boolean(platform?.staff),
        agency: managesAnAgency({ organizations: me.organizations, businesses: me.workspaces }),
      }}
    />
  );
}
