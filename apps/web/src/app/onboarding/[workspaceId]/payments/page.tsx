import {
  addressLines,
  businessAddressOf,
  can,
  isConnectableProvider,
  paymentsSetupAccountOf,
  paymentsSetupContextFrom,
  paymentsSetupScreen,
  PAYMENTS_SETUP_WORDS,
} from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  PaymentsSetupDone,
  PaymentsSetupFlow,
} from '@/components/payments-setup/payments-setup-flow';
import { apiServer, getMe, getSetupWorkspace, unwrapPage } from '@/lib/api/server';
import { publicEnv } from '@/lib/env';

export const metadata: Metadata = { title: PAYMENTS_SETUP_WORDS.pageTitle };

/**
 * The guided payments setup (the owner, 23 Nov 2026, "a" on picks P1 to P4): Getting started's Connect payments
 * (`?from=setup`) and Settings → Payments open it. One question at a time on a page of its own, saved as it's
 * answered, and nothing changed before Check it over. `?at=<question>` is Settings' Change for one answer; `?done=1`
 * is Done, after Save and after the Stripe or Square sign-in (`?provider=`, `?payments=`). Only someone who can
 * change the business's payments comes here; anyone else goes Home.
 */
export default async function PaymentsSetupPage({
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
  if (!can(mine.ws.permissions, 'money.manage')) redirect(home);
  const query = await searchParams;
  const from = query['from'] === 'setup' ? 'setup' : 'settings';
  const [got, money, connections, me] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/money.settings', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/payment_connection.list', { body: { workspaceId } })
      .then((r) => unwrapPage(r).connections),
    getMe(),
  ]);

  if (query['done'] === '1') {
    const tried = typeof query['provider'] === 'string' ? query['provider'] : '';
    return (
      <PaymentsSetupDone
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        email={email}
        settings={money.settings}
        account={paymentsSetupAccountOf(connections)}
        tried={isConnectableProvider(tried) ? tried : null}
        result={typeof query['payments'] === 'string' ? query['payments'] : null}
        from={from}
      />
    );
  }

  // The web ships a little before the API: a draft it can't read yet is no draft.
  const draft = await api
    .POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'payments' } })
    .then((r) => r.data ?? { answers: null, savedAt: null })
    .catch(() => ({ answers: null, savedAt: null }));
  const address = businessAddressOf((got.workspace.settings ?? {}) as Record<string, unknown>);
  const ctx = paymentsSetupContextFrom({
    connections,
    payPalOpen: publicEnv.payPalEnabled,
    money,
    setupAddress: address ? addressLines(address) : null,
  });
  const at = paymentsSetupScreen.safeParse(query['at']);
  return (
    <PaymentsSetupFlow
      workspaceId={workspaceId}
      businessName={got.workspace.name}
      email={email}
      firstName={me.user.fullName.trim().split(/\s+/)[0] || null}
      industry={got.workspace.industry}
      ctx={ctx}
      draft={{ answers: draft.answers, savedAt: draft.savedAt }}
      at={at.success ? at.data : null}
      from={from}
    />
  );
}
