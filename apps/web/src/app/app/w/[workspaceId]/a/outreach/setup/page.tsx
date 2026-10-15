import { setupOpenAt } from '@hfos/core/addons/outreach/setup';
import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { SetupView } from '@/addons/outreach/setup-view';
import { apiServer, getMe, getWorkspaceShell, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Set up Social Outreach' };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * Social Outreach's setup (docs/outreach.md, decisions 36, 45 and 63), a page of its own like the main app's onboarding:
 * a welcome until a step is finished, then a step at a time. Where the person got to opens unless a step is asked
 * for (`?step=`), saying so; Set up again (`?again=1`) opens the first; the extension's first sign-in opens it with
 * `?from=extension`. Anyone with `outreach.use`; owners and admins also set the team's rules.
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
    const [business, asks, readiness] = await Promise.all([
      setup.canManage
        ? api
            .POST('/v1/queries/addon.settings', { body: { workspaceId, addonId: 'outreach' } })
            .then(unwrapPage)
        : null,
      // The groups step asks the computer to save the person's groups (decision 43); Get ready to read their profile
      // and put a bio in (decision 64).
      at === 'groups' || at === 'ready'
        ? api
            .POST('/v1/queries/outreach.asks', {
              body: {
                workspaceId,
                kinds: at === 'groups' ? ['groups'] : ['profile_read', 'profile_edit'],
              },
            })
            .then(unwrapPage)
        : null,
      // The Get ready step's items (decision 63).
      at === 'ready'
        ? api.POST('/v1/queries/outreach.readiness', { body: { workspaceId } }).then(unwrapPage)
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
        // Opened where they'd left off, with some steps finished before.
        resumed={!one(sp.step) && one(sp.again) !== '1' && !!setup.reached && !setup.finishedAt}
        setup={setup}
        me={mine}
        business={setup.canManage ? (business?.settings ?? {}) : null}
        asks={asks}
        readiness={readiness}
      />
    );
  });
}
