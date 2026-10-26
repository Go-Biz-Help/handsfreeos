import { can, foundingPlanIsYearly } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FoundingPlanCard } from '@/components/settings/founding-plan-card';
import { UsagePage } from '@/components/settings/usage-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Usage & balance' };

/**
 * Settings → Usage & balance (owners and admins): what the business has left, what it has spent, the card that
 * tops it up, its daily AI limit, and a statement of every text, call, number and AI reply it has been charged for. A founding seat paid
 * by the year shows here too, above the balance: when it renews, and the way to stop it.
 *
 * Deliberately not part of Settings → Payments. That page is the business's own customers paying **them**;
 * this is what the business pays **us**. Sharing a page would be the single most confusing thing this feature
 * could do.
 */
export default async function UsageSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'money.manage')) notFound();
  const body = { body: { workspaceId } };
  const [wallet, prices, statement, plan] = await Promise.all([
    api.POST('/v1/queries/wallet.get', body).then(unwrapPage),
    api.POST('/v1/queries/usage.prices', body).then(unwrapPage),
    api.POST('/v1/queries/usage.statement', { body: { workspaceId, limit: 50 } }).then(unwrapPage),
    api.POST('/v1/queries/founding.mine', body).then(unwrapPage),
  ]);
  // A founding seat paid by the year (20261027009500) is what the business pays us too, so it sits here.
  const paidThrough = plan.paidThrough;
  return (
    <>
      {paidThrough && foundingPlanIsYearly(plan) ? (
        <div className="mb-5">
          <FoundingPlanCard workspaceId={workspaceId} plan={{ ...plan, paidThrough }} />
        </div>
      ) : null}
      <UsagePage workspaceId={workspaceId} wallet={wallet} prices={prices} statement={statement} />
    </>
  );
}
