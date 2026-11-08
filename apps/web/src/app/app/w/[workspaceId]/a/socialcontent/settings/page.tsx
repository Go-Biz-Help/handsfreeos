import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { SettingsPage } from '@/addons/socialcontent/settings-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Settings · AI Social Media Content Creator' };

/**
 * AI Social Media Content Creator's Settings (docs/socialcontent.md): the networks studied, whose computer reads, and
 * what that computer was asked to do lately. Anyone who uses the add-on sees it; owners and admins change it.
 */
export default async function Page({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'socialcontent', 'socialcontent.use', async () => {
    const { api, userId } = await apiServer();
    const overview = await api
      .POST('/v1/queries/socialcontent.overview', { body: { workspaceId } })
      .then(unwrapPage);
    return <SettingsPage workspaceId={workspaceId} overview={overview} myUserId={userId} />;
  });
}
