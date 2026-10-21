import { readSetupStop, setupOpenAt } from '@hfos/core/addons/outreach/setup';
import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { SetupView } from '@/addons/outreach/setup-view';
import type { Setup } from '@/addons/outreach/types';
import { apiServer, getMe, getWorkspaceShell, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Set up Social Outreach' };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * Social Outreach's setup (docs/outreach.md, decisions 36, 45, 57 and 83), a page of its own like the main app's
 * onboarding: a welcome until it's started, then the main setup and each network's short one, a step at a time. The
 * first step left opens unless one is asked for (`?step=`, with `?net=` for a network's), saying so; Set up again
 * (`?again=1`) opens the first; the extension's first sign-in opens it with `?from=extension`. Anyone with
 * `outreach.use`; owners and admins also do the business's part. Each step loads only what it shows.
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
      // openapi-fetch's reading drops a key typed only `null` (a main step's `net`), though the answer has it.
      api
        .POST('/v1/queries/outreach.setup', { body: { workspaceId } })
        .then((r) => unwrapPage(r) as Setup),
      api.POST('/v1/queries/outreach.automation', { body: { workspaceId } }).then(unwrapPage),
    ]);
    const asked = readSetupStop(one(sp.step), one(sp.net));
    const again = one(sp.again) === '1';
    const at = setupOpenAt(setup, asked, again);
    const step = at === 'welcome' || at === 'done' ? null : at;
    // The network the step reads: a network's own, else Facebook's (the main setup's offer, playbook and messages).
    const platform = step?.net ?? 'facebook';
    const reads =
      step !== null &&
      (step.net !== null
        ? step.step === 'profile'
        : ['offer', 'messages', 'numbers'].includes(step.step));
    const [business, asks, readiness, live] = await Promise.all([
      setup.canManage
        ? api
            .POST('/v1/queries/addon.settings', { body: { workspaceId, addonId: 'outreach' } })
            .then(unwrapPage)
        : null,
      // A profile's read and its bio are asked of the person's computer (decision 64).
      step?.net && step.step === 'profile'
        ? api
            .POST('/v1/queries/outreach.asks', {
              body: { workspaceId, kinds: ['profile_read', 'profile_edit'] },
            })
            .then(unwrapPage)
        : null,
      reads
        ? api
            .POST('/v1/queries/outreach.readiness', { body: { workspaceId, platform } })
            .then(unwrapPage)
        : null,
      // A network's Start, and the end's first lists being read (decision 60).
      at === 'done' || (step?.net && step.step === 'start')
        ? api
            .POST('/v1/queries/outreach.live', { body: { workspaceId, platform } })
            .then((r) => r.data ?? null)
            .catch(() => null)
        : null,
    ]);
    const asking = one(sp.step) !== null || again;
    return (
      <SetupView
        // A step moved to starts its own forms afresh.
        key={JSON.stringify(at)}
        workspaceId={workspaceId}
        businessName={shell.current.name}
        email={me.user.email}
        firstName={me.user.fullName?.split(' ')[0] ?? null}
        at={at}
        fromExtension={one(sp.from) === 'extension'}
        // Opened where they'd left off, with some steps done before.
        resumed={!asking && !!setup.startedAt && setup.states.some((s) => s.state === 'done')}
        setup={setup}
        me={mine}
        business={setup.canManage ? (business?.settings ?? {}) : null}
        asks={asks}
        readiness={readiness}
        live={live}
      />
    );
  });
}
