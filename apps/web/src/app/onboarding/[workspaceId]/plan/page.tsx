import { can, foundingPickable, foundingPickFirst } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PickPlan, PlanSignOut } from '@/components/founding/pick-plan';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { apiServer, getMe, unwrap } from '@/lib/api/server';
import { wantedPlan } from '@/lib/founding-plan';

export const metadata: Metadata = { title: 'Pick your founding spot' };

/**
 * Where a new business picks its founding spot and pays, before it is set up (20261027012700): $497 a year or $97 a
 * month, first come, first served. The business is made first, so the spot is held for it and paid for in its name.
 * A business that doesn't need one (made before, or it holds one now) goes on to its setup.
 */
export default async function FoundingPlanPage({
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
  if (!ws) notFound();
  if (!ws.needsPlan) redirect(`/onboarding/${workspaceId}`);
  const counts = unwrap(await api.POST('/v1/queries/founding.counts', { body: {} }));
  const offers = foundingPickable(counts.offers);
  return (
    <SetupPage
      business={{ name: ws.name, home: `/app/w/${workspaceId}` }}
      email={email}
      // Finish later would only come back here: nothing in the business opens until a spot is paid for.
      finishLater={<PlanSignOut />}
    >
      <PickPlan
        workspaceId={workspaceId}
        business={ws.name}
        offers={offers}
        first={foundingPickFirst(offers, wantedPlan(query.plan))}
        canPay={can(ws.permissions, 'money.manage')}
      />
    </SetupPage>
  );
}
