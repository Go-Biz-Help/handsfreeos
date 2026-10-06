import { addressLines, businessAddressOf, can, readMoneySettings } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PaymentsSettings } from '@/components/settings/payments-page';
import type { TeamMember } from '@/components/settings/payment-access-dialog';
import { apiServer, unwrapPage } from '@/lib/api/server';
import type { Members } from '@/lib/api/types';

export const metadata: Metadata = { title: 'Payments' };

/**
 * Settings → Payments (owners and admins): the accounts money is paid into, which ways to pay a customer sees,
 * the sales tax, invoice and estimate numbering, terms and notes, the deposit an estimate asks for, and the
 * reminders an invoice sends itself. Coming back from Stripe's or Square's sign-in carries `?payments=`.
 */
export default async function PaymentsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { payments } = await searchParams;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'money.manage')) notFound();
  // The address the onboarding setup asked for: documents carry it while none is typed here.
  const asked = businessAddressOf(got.workspace.settings as Record<string, unknown>);
  const body = { body: { workspaceId } };
  // Whether anything has ever gone out to a customer: the "no address on your documents" warning waits for it,
  // so a business still setting itself up is never told off for a field it hasn't reached yet. One row of each
  // is enough to know.
  const [settings, accounts, members, sentEstimates, sentInvoices] = await Promise.all([
    api.POST('/v1/queries/money.settings', body).then(unwrapPage),
    api.POST('/v1/queries/payment_connection.list', body).then(unwrapPage),
    api.POST('/v1/queries/workspace.members', body).then(unwrapPage),
    api
      .POST('/v1/queries/estimate.list', {
        body: { workspaceId, limit: 1, status: ['sent', 'accepted', 'declined', 'expired'] },
      })
      .then((r) => r.data?.estimates.length ?? 0)
      .catch(() => 0),
    api
      .POST('/v1/queries/invoice.list', {
        body: { workspaceId, limit: 1, status: ['sent', 'partly_paid', 'paid', 'overdue'] },
      })
      .then((r) => r.data?.invoices.length ?? 0)
      .catch(() => 0),
  ]);
  return (
    <>
      <PaymentsSettings
        workspaceId={workspaceId}
        initial={readMoneySettings(settings.settings)}
        nextEstimateNumber={settings.nextEstimateNumber}
        nextInvoiceNumber={settings.nextInvoiceNumber}
        connections={accounts.connections}
        team={teamOf(members)}
        hasSentDocuments={sentEstimates + sentInvoices > 0}
        setupAddress={asked ? addressLines(asked) : null}
        result={typeof payments === 'string' ? payments : null}
      />
    </>
  );
}

/**
 * The business's people for who may use each account (0105), and whether each bills: whoever the business lets
 * (`money.bill`, 0106) — owners and admins unless it says otherwise, and the agency's owners and admins, who reach
 * every business as one.
 */
function teamOf(m: Members): TeamMember[] {
  const bills = new Map<string, { fullName: string; bills: boolean }>();
  for (const x of m.members)
    bills.set(x.userId, {
      fullName: x.fullName || x.email,
      bills: can(x.permissions, 'money.bill'),
    });
  for (const x of m.organizationAdmins)
    bills.set(x.userId, {
      fullName: x.fullName || x.email,
      bills: can(x.permissions, 'money.bill'),
    });
  return [...bills]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
