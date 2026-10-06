import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { PlaybookBuilder } from '@/addons/outreach/playbook-builder';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { builderData } from '../load';

export const metadata: Metadata = { title: 'Change a playbook' };

/**
 * A playbook being changed: the builder opens on its summary, where each part has its own Change. Owners and admins
 * (`outreach.manage`) write them; for anyone else it's not found, and so is a playbook that isn't there.
 */
export default async function PlaybookPage({
  params,
}: {
  params: Promise<{ workspaceId: string; playbookId: string }>;
}) {
  const { workspaceId, playbookId } = await params;
  return addonPage(workspaceId, 'outreach', 'outreach.manage', async () => {
    const { api } = await apiServer();
    const [list, data] = await Promise.all([
      api.POST('/v1/queries/outreach.playbook.list', { body: { workspaceId } }).then(unwrapPage),
      builderData(workspaceId),
    ]);
    const playbook = list.playbooks.find((p) => p.id === playbookId);
    if (!playbook) notFound();
    return (
      <PlaybookBuilder
        key={playbook.id}
        workspaceId={workspaceId}
        playbook={playbook}
        template={null}
        {...data}
      />
    );
  });
}
