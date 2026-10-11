import { setupOpenAt } from '@hfos/core/addons/outreach/setup';
import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { SetupView } from '@/addons/outreach/setup-view';
import { apiServer, getMe, getWorkspaceShell, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Set up Social Outreach' };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * Social Outreach's setup (docs/outreach.md, decisions 36 and 45), a step at a time: where the person got to opens
 * unless a step is asked for (`?step=`); Set up again (`?again=1`) opens the first; the extension's first sign-in
 * opens it with `?from=extension`. Anyone with `outreach.use`; owners and admins also set the team's rules.
 */
export default async function OutreachSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  return addonPage(workspaceId, 'outreach', 'outreach.use', async () => {
    const { api } = await apiServer();
    const [shell, me, setup, mine] = await Promise.all([
      getWorkspaceShell(workspaceId),
      getMe(),
      api.POST('/v1/queries/outreach.setup', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/outreach.automation', { body: { workspaceId } }).then(unwrapPage),
    ]);
    const at = setupOpenAt(setup, one(sp.step), one(sp.again) === '1');
    const [business, asks] = await Promise.all([
      setup.canManage
        ? api
            .POST('/v1/queries/addon.settings', { body: { workspaceId, addonId: 'outreach' } })
            .then(unwrapPage)
        : null,
      // The groups step asks the computer to save the person's groups (decision 43).
      at === 'groups'
        ? api
            .POST('/v1/queries/outreach.asks', { body: { workspaceId, kinds: ['groups'] } })
            .then(unwrapPage)
        : null,
    ]);
    return (
      <SetupView
        // A step moved to starts its own forms afresh.
        key={at}
        workspaceId={workspaceId}
        businessName={shell.current.name}
        email={me.user.email}
        at={at}
        fromExtension={one(sp.from) === 'extension'}
        setup={setup}
        me={mine}
        business={setup.canManage ? (business?.settings ?? {}) : null}
        asks={asks}
      />
    );
  });
}
