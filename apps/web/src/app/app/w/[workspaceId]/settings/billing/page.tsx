import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BillingPage } from '@/components/settings/billing-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Billing' };

/**
 * Settings → Billing (20261027023600, whoever manages money): the business's HandsFreeOS plan, its cards, its payment
 * date and a payment that didn't go through. Only on the web: the phone sends people here.
 *
 * Usage & balance stays what texts, calls and AI come out of; Payments stays the business's own customers paying them.
 */
export default async function BillingSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'money.manage')) notFound();
  const billing = unwrapPage(await api.POST('/v1/queries/billing.get', { body: { workspaceId } }));
  return <BillingPage workspaceId={workspaceId} billing={billing} />;
}
