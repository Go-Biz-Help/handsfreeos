import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { PlaybookPage } from '@/addons/socialcontent/playbook-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Playbook · AI Social Media Content Creator' };

/**
 * The Playbook (docs/socialcontent.md, part 3): what works for the creators studied, written by the AI from its notes
 * on their standouts. It opens through the gate like every add-on page.
 */
export default async function Page({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'socialcontent', 'socialcontent.use', async () => {
    const { api } = await apiServer();
    const found = await api
      .POST('/v1/queries/socialcontent.playbook.get', { body: { workspaceId } })
      .then(unwrapPage);
    return (
      <PlaybookPage workspaceId={workspaceId} playbook={found.playbook} examples={found.examples} />
    );
  });
}
