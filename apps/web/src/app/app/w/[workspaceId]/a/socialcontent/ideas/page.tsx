import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { IdeasPage } from '@/addons/socialcontent/ideas-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Ideas · AI Social Media Content Creator' };

/**
 * Ideas (docs/socialcontent.md, part 3): posts the AI suggests the business makes, from the Playbook and its
 * profile, to save, mark used or skip. It opens through the gate like every add-on page.
 */
export default async function Page({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'socialcontent', 'socialcontent.use', async () => {
    const { api } = await apiServer();
    const [found, book] = await Promise.all([
      api.POST('/v1/queries/socialcontent.idea.list', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/socialcontent.playbook.get', { body: { workspaceId } })
        .then(unwrapPage),
    ]);
    return (
      <IdeasPage
        workspaceId={workspaceId}
        ideas={found.ideas}
        examples={found.examples}
        hasPlaybook={book.playbook.writtenAt !== null}
      />
    );
  });
}
