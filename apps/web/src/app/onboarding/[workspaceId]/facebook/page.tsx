import {
  can,
  facebookSetupContextFrom,
  facebookSetupScreen,
  FACEBOOK_SETUP_WORDS,
} from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  FacebookSetupFlow,
  FacebookSetupTest,
} from '@/components/facebook-setup/facebook-setup-flow';
import { apiServer, getMe, getSetupWorkspace, unwrapPage } from '@/lib/api/server';
import { metaResultOf } from '@/lib/meta-connect';

export const metadata: Metadata = { title: FACEBOOK_SETUP_WORDS.pageTitle };

/**
 * The guided Facebook & Instagram setup (the owner, 24 Nov 2026: F1 a to F4 a): Settings → Facebook & Instagram opens
 * it (Start while nothing is connected, Change, Go through the questions again). One question at a time on a page of
 * its own, saved as it's answered, and nothing changed before Check it over. `?at=<question>` is Settings' Change for
 * one answer; `?step=test` is Send yourself a test message, where Facebook's sign-in comes back to (with `?meta=`,
 * through setup-return.ts), and Settings' Send a test message opens. Only someone who can change the business's
 * channels comes here; anyone else goes Home.
 */
export default async function FacebookSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const home = `/app/w/${workspaceId}`;
  const { api, email } = await apiServer();
  // The person's own business, or one the founder is working in as its owner.
  const mine = await getSetupWorkspace(workspaceId);
  if (!mine) notFound();
  if (!can(mine.ws.permissions, 'channels.manage')) redirect(home);
  const query = await searchParams;
  const body = { body: { workspaceId } };
  const [list, intake, me] = await Promise.all([
    api.POST('/v1/queries/meta_account.list', body).then(unwrapPage),
    api.POST('/v1/queries/intake.list', body).then(unwrapPage),
    getMe(),
  ]);
  const ctx = facebookSetupContextFrom({
    accounts: list.accounts,
    connections: list.connections,
    sources: intake.sources,
    pipelines: intake.pipelines,
  });
  const businessName = mine.ws.name;

  if (query['step'] === 'test')
    return (
      <FacebookSetupTest
        workspaceId={workspaceId}
        businessName={businessName}
        email={email}
        accounts={ctx.accounts}
        result={metaResultOf(query)}
        instagramAsked={query['ig'] === '1'}
      />
    );

  // The web ships a little before the API: a draft it can't read yet is no draft.
  const draft = await api
    .POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'facebook' } })
    .then((r) => r.data ?? { answers: null, savedAt: null })
    .catch(() => ({ answers: null, savedAt: null }));
  const at = facebookSetupScreen.safeParse(query['at']);
  return (
    <FacebookSetupFlow
      workspaceId={workspaceId}
      businessName={businessName}
      email={email}
      firstName={me.user.fullName.trim().split(/\s+/)[0] || null}
      ctx={ctx}
      draft={{ answers: draft.answers, savedAt: draft.savedAt }}
      at={at.success ? at.data : null}
    />
  );
}
