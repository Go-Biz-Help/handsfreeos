import { PLATFORM_KEYS } from '@hfos/core/addons/outreach/networks';
import { outreachSetupPath } from '@hfos/core/addons/outreach/setup';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { PlaybookBuilder } from '@/addons/outreach/playbook-builder';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { builderData } from '../load';

export const metadata: Metadata = { title: 'Change a playbook' };

/**
 * A playbook being changed: the builder opens on its summary, where each part has its own Change. Owners and admins
 * (`outreach.manage`) write them; for anyone else it's not found, and so is a playbook that isn't there. Opened from
 * Social Outreach's setup (`?from=setup`), it opens on the step asked for (`&open=video`, `&open=where`) and saving goes
 * back to the setup's step it came from (`&net=linkedin` for a network's playbook step).
 */
export default async function PlaybookPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; playbookId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, playbookId } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const fromSetup = one(sp.from) === 'setup';
  const net = PLATFORM_KEYS.find((p) => p === one(sp.net) && p !== 'facebook') ?? null;
  const open = one(sp.open) === 'video' ? 'video' : one(sp.open) === 'where' ? 'where' : undefined;
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
        openAt={fromSetup ? open : undefined}
        doneHref={
          fromSetup
            ? outreachSetupPath(workspaceId, {
                step: net
                  ? { net, step: 'playbook' }
                  : { net: null, step: open === 'video' ? 'video' : 'playbook' },
              })
            : undefined
        }
        {...data}
      />
    );
  });
}
