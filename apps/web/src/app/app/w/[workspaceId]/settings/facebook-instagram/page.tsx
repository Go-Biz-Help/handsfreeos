import {
  can,
  facebookSettingsLines,
  facebookSetupContextFrom,
  metaAccountTrouble,
} from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FacebookInstagramOverview } from '@/components/settings/facebook-instagram-overview';
import { FacebookInstagramPage } from '@/components/settings/facebook-instagram-page';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { metaResultOf } from '@/lib/meta-connect';

export const metadata: Metadata = { title: 'Facebook & Instagram' };

/**
 * Settings → Facebook & Instagram (channels.manage: owners and admins): one simple card (the owner, 24 Nov 2026, F3 a)
 * with what's connected, Send a test message and Connect more, and the guided setup's answers, each with Change; with
 * nothing connected, Start opens the guided setup (F1 a). Under All settings, as before, the Pages and Instagram
 * accounts whose messages come to the inbox, their lead ads, and their Facebook sign-in. Coming back from Facebook
 * carries `?meta=`, which opens All settings with what happened; `?all=1` opens it for settings search.
 */
export default async function FacebookInstagramSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { api } = await apiServer();
  const body = { body: { workspaceId } };
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', body));
  if (!can(got.workspace.permissions, 'channels.manage')) notFound();
  const [data, intake, draft] = await Promise.all([
    api.POST('/v1/queries/meta_account.list', body).then(unwrapPage),
    api.POST('/v1/queries/intake.list', body).then(unwrapPage),
    // The web ships a little before the API: a draft it can't read yet is no draft.
    api
      .POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'facebook' } })
      .then((r) => r.data?.answers ?? null)
      .catch(() => null),
  ]);
  const result = metaResultOf(q);
  const ctx = facebookSetupContextFrom({
    accounts: data.accounts,
    connections: data.connections,
    sources: intake.sources,
    pipelines: intake.pipelines,
  });
  const live = data.accounts.filter((a) => a.status !== 'disconnected');
  const needsFixing =
    live.some((a) => metaAccountTrouble(a) !== null) ||
    data.connections.some((c) => c.status === 'needs_attention');
  return (
    <FacebookInstagramOverview
      workspaceId={workspaceId}
      accounts={live}
      lines={ctx.mode === 'again' ? facebookSettingsLines(ctx) : []}
      started={draft !== null}
      openAll={q['all'] === '1' || result !== null}
      needsFixing={needsFixing}
    >
      <FacebookInstagramPage workspaceId={workspaceId} data={data} result={result} />
    </FacebookInstagramOverview>
  );
}
