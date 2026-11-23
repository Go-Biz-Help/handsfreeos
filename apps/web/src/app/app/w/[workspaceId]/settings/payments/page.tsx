import {
  addressLines,
  businessAddressOf,
  can,
  checkMoneySettings,
  paymentsSetupAnswersFromSettings,
  paymentsSetupContextFrom,
  paymentsSetupLines,
  readMoneySettings,
} from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PaymentsOverview } from '@/components/settings/payments-overview';
import { PaymentsSettings } from '@/components/settings/payments-page';
import type { TeamMember } from '@/components/settings/payment-access-dialog';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { publicEnv } from '@/lib/env';
import type { Members } from '@/lib/api/types';

export const metadata: Metadata = { title: 'Payments' };

/**
 * Settings → Payments (owners and admins): one simple card (the owner, 23 Nov 2026, P3 a) with the account money goes
 * into and the guided setup's answers, each with Change; and under All settings, as before, the accounts money is
 * paid into, which ways to pay a customer sees, the sales tax, invoice and estimate numbering, terms and notes, the
 * deposit an estimate asks for, and the reminders an invoice sends itself. Coming back from Stripe's or Square's
 * sign-in carries `?payments=`; `?all=1` opens All settings.
 */
export default async function PaymentsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { payments, all } = await searchParams;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'money.manage')) notFound();
  // The address the onboarding setup asked for: documents carry it while none is typed here.
  const asked = businessAddressOf(got.workspace.settings as Record<string, unknown>);
  const body = { body: { workspaceId } };
  // Whether anything has ever gone out to a customer: the "no address on your documents" warning waits for it,
  // so a business still setting itself up is never told off for a field it hasn't reached yet. One row of each
  // is enough to know.
  const [settings, accounts, members, sentEstimates, sentInvoices, draft] = await Promise.all([
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
    // The web ships a little before the API: a draft it can't read yet is no draft.
    api
      .POST('/v1/queries/guided_setup.get_draft', { body: { workspaceId, setup: 'payments' } })
      .then((r) => r.data?.answers ?? null)
      .catch(() => null),
  ]);
  const setupAddress = asked ? addressLines(asked) : null;
  const initial = readMoneySettings(settings.settings);
  const ctx = paymentsSetupContextFrom({
    connections: accounts.connections,
    payPalOpen: publicEnv.payPalEnabled,
    money: { ...settings, settings: initial },
    setupAddress,
  });
  // The answers once there's something to show: an account, or settings of the business's own. Where the money goes
  // is the account's card, above them.
  const lines =
    ctx.account || ctx.configured
      ? paymentsSetupLines(
          paymentsSetupAnswersFromSettings(ctx.settings, setupAddress, 'later'),
          ctx,
        ).filter((l) => l.key !== 'where')
      : [];
  const hasSentDocuments = sentEstimates + sentInvoices > 0;
  return (
    <PaymentsOverview
      workspaceId={workspaceId}
      businessName={got.workspace.name}
      account={ctx.account}
      lines={lines}
      started={draft !== null}
      openAll={all === '1' || typeof payments === 'string'}
      needsFixing={checkMoneySettings(initial, { hasSentDocuments, setupAddress }).length > 0}
    >
      <PaymentsSettings
        workspaceId={workspaceId}
        initial={initial}
        nextEstimateNumber={settings.nextEstimateNumber}
        nextInvoiceNumber={settings.nextInvoiceNumber}
        connections={accounts.connections}
        team={teamOf(members)}
        hasSentDocuments={hasSentDocuments}
        setupAddress={setupAddress}
        result={typeof payments === 'string' ? payments : null}
      />
    </PaymentsOverview>
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
