import { foundingPickable } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { PracticeBanner } from '@/components/practice/practice-banner';
import { PracticeCheckout } from '@/components/practice/practice-checkout';
import { apiServer, getMe, unwrap } from '@/lib/api/server';
import { foundingPlanHref } from '@/lib/founding-plan';

export const metadata: Metadata = { title: 'Checkout · Practice' };

/**
 * The stand-in for Stripe's page in a practice business (Admin → Try onboarding, 20261027027400), where the plan
 * page's Pay goes. `?offer=` is the plan picked, `?amount=` what its first charge would be in cents (less with a code)
 * and `?trial=` its days free. Only a practice business that still has to pick a plan comes here.
 */
export default async function PracticeCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const { api, email } = await apiServer();
  const me = await getMe();
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.practiceEndsAt) notFound();
  if (!ws.needsPlan) redirect(`/onboarding/${workspaceId}`);
  const one = (key: string) => (typeof query[key] === 'string' ? query[key] : null);
  const counts = await api.POST('/v1/queries/founding.counts', { body: {} }).then(unwrap);
  const offer = foundingPickable(counts.offers).find((o) => o.offerId === one('offer'));
  if (!offer) redirect(foundingPlanHref(workspaceId));
  const amount = Number(one('amount'));
  const trial = Number(one('trial'));
  return (
    <>
      <PracticeBanner workspaceId={workspaceId} name={ws.name} endsAt={ws.practiceEndsAt} />
      <SetupPage business={{ name: ws.name, home: `/app/w/${workspaceId}` }} email={email}>
        <PracticeCheckout
          workspaceId={workspaceId}
          business={ws.name}
          offer={offer}
          amountCents={
            Number.isInteger(amount) && amount >= 0 && amount <= offer.priceCents
              ? amount
              : offer.priceCents
          }
          trialDays={Number.isInteger(trial) && trial > 0 && trial <= 365 ? trial : null}
        />
      </SetupPage>
    </>
  );
}
