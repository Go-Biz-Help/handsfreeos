import { paymentBlockOf } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PaymentWall } from '@/components/billing/payment-wall';
import { PlanSignOut } from '@/components/founding/pick-plan';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { apiServer, getMe, unwrap } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Your payment didn’t go through' };

/**
 * The failed-payment page (20261027023600, the owner's call of 2026-11-08), in front of the CRM while a plan payment
 * is owed: pay it, add a card, or ask for more time. It can be skipped for a day until 72 hours after the payment
 * failed. Someone who can't fix it is told who can. Nothing owed (or more time given) goes straight back in.
 */
export default async function PaymentPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api, email } = await apiServer();
  const me = await getMe();
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  if (!ws) notFound();
  const home = `/app/w/${workspaceId}`;
  const status = unwrap(await api.POST('/v1/queries/billing.status', { body: { workspaceId } }));
  // Skipping is this device's, so the page checks only that something is owed; it offers Skip itself.
  const block = paymentBlockOf(status.owed, new Date(), null);
  if (!status.owed || !block) redirect(home);
  const billing = status.canManage
    ? unwrap(await api.POST('/v1/queries/billing.get', { body: { workspaceId } }))
    : null;
  return (
    <SetupPage
      business={{ name: ws.name, home }}
      email={email}
      settingUp={ws.name}
      finishLater={<PlanSignOut />}
    >
      <PaymentWall
        workspaceId={workspaceId}
        owed={status.owed}
        block={block}
        canManage={status.canManage}
        askWho={status.askWho}
        cardCount={billing?.cards.length ?? 0}
        others={me.workspaces
          .filter((w) => w.id !== workspaceId)
          .map((w) => ({ id: w.id, name: w.name }))}
      />
    </SetupPage>
  );
}
