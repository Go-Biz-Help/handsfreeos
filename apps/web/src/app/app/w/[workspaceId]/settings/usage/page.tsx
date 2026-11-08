import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CardsSection, PlanSections } from '@/components/settings/billing-page';
import { UsagePage } from '@/components/settings/usage-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Billing & Usage' };

/**
 * Settings → Billing & Usage (whoever manages money): everything the business pays HandsFreeOS, on one page (the
 * owner's 6b, 2026-11-08). A founding spot paid by the month or the year comes first: a payment that didn't go through,
 * then the plan, its next payment with Change date, and stopping it renewing (20261027023600). Then the cards, one list
 * for the plan and the balance (the owner's 5a). Then what the business has left, what it has spent, automatic top-up,
 * its daily AI limit, and a statement of every text, call, number and AI reply it has been charged for.
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
  const [wallet, prices, statement, billing] = await Promise.all([
    api.POST('/v1/queries/wallet.get', body).then(unwrapPage),
    api.POST('/v1/queries/usage.prices', body).then(unwrapPage),
    api.POST('/v1/queries/usage.statement', { body: { workspaceId, limit: 50 } }).then(unwrapPage),
    api.POST('/v1/queries/billing.get', body).then(unwrapPage),
  ]);
  return (
    <UsagePage
      workspaceId={workspaceId}
      wallet={wallet}
      prices={prices}
      statement={statement}
      plan={<PlanSections workspaceId={workspaceId} billing={billing} />}
      cards={<CardsSection workspaceId={workspaceId} billing={billing} />}
    />
  );
}
