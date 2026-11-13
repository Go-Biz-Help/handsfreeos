import { can, foundingPickable, foundingPickFirst } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PickPlan, PlanSignOut } from '@/components/founding/pick-plan';
import { SetupPage } from '@/components/onboarding-setup/frame';
import { apiServer, getMe, unwrap } from '@/lib/api/server';
import { discountCode } from '@/lib/auth/visitor';
import { wantedPlan } from '@/lib/founding-plan';
import { supabaseServer } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Pick your founding spot' };

/**
 * Where a new business picks its founding spot and pays, before it is set up (20261027012700): $497 a year or $97 a
 * month, first come, first served. The business is made first, so the spot is held for it and paid for in its name.
 * A business that doesn't need one (made before, or it holds one now) goes on to its setup. A discount or trial code
 * (20261027014300) is filled in from `?code=`, or from the code's link the account was made through. Each plan's own
 * free trial (20261027027000) is what `founding.trials` says this person gets for this business.
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
  const canPay = can(ws.permissions, 'money.manage');
  const [counts, trials] = await Promise.all([
    api.POST('/v1/queries/founding.counts', { body: {} }).then(unwrap),
    // The free trial this person gets for this business (20261027027000): none once they've had one.
    canPay ? api.POST('/v1/queries/founding.trials', { body: { workspaceId } }).then(unwrap) : null,
  ]);
  const offers = foundingPickable(counts.offers).map((o) => ({
    ...o,
    trialDays: trials?.offers.find((t) => t.offerId === o.offerId)?.trialDays ?? null,
  }));
  const startCode =
    discountCode(query.code) ??
    discountCode(
      (await (await supabaseServer()).auth.getUser()).data.user?.user_metadata?.affiliate_code,
    ) ??
    null;
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
        canPay={canPay}
        startCode={startCode}
      />
    </SetupPage>
  );
}
