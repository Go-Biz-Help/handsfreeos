import type { Metadata } from 'next';
import { MoneyFilterBar } from '@/components/money/filters';
import { HeadlineStrip } from '@/components/money/headline-strip';
import {
  accountChoices,
  accountNames,
  PAYMENT_METHOD_CHOICES,
  PAYMENT_STATUS_CHOICES,
  paymentListBody,
  readFilters,
} from '@/components/money/list-options';
import { PaymentsList } from '@/components/money/payments-list';
import { MoneyActions, MoneySubnav } from '@/components/money/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { unwrapPage } from '@/lib/api/server';
import { COLLECTED_DAYS, loadAccounts, loadMoneyShell } from '../load';

export const metadata: Metadata = { title: 'Payments' };

const STATUSES = PAYMENT_STATUS_CHOICES.map((s) => s.value);
const METHODS = PAYMENT_METHOD_CHOICES.map((m) => m.value);

export default async function PaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const filters = readFilters(await searchParams, {
    status: STATUSES,
    method: METHODS,
    account: true,
  });
  const shell = await loadMoneyShell(workspaceId);
  const [payments, accounts] = await Promise.all([
    shell.api
      .POST('/v1/queries/payment.list', { body: paymentListBody(workspaceId, filters) })
      .then((r) => unwrapPage(r)),
    loadAccounts(shell.api, workspaceId, shell.canManage),
  ]);

  return (
    <>
      <PageHeader
        title="Money"
        description="What you have quoted, what you are owed and what has come in."
        actions={shell.canManage ? <MoneyActions workspaceId={workspaceId} /> : undefined}
      />
      {shell.summary ? (
        <HeadlineStrip summary={shell.summary} days={COLLECTED_DAYS} timeZone={shell.timeZone} />
      ) : null}
      <MoneySubnav workspaceId={workspaceId} tab="payments">
        <MoneyFilterBar
          filters={filters}
          statuses={PAYMENT_STATUS_CHOICES}
          methods={PAYMENT_METHOD_CHOICES}
          accounts={accountChoices(accounts, filters.account)}
          count={payments.payments.length}
        />
      </MoneySubnav>
      <PaymentsList
        workspaceId={workspaceId}
        initial={payments}
        filters={filters}
        timeZone={shell.timeZone}
        collectedCents={shell.summary?.collectedCents ?? 0}
        days={COLLECTED_DAYS}
        accountNames={accountNames(accounts)}
      />
    </>
  );
}
