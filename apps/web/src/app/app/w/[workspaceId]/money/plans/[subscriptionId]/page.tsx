import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PlanPage } from '@/components/money/plan-page';
import { ApiError, unwrapPage } from '@/lib/api/server';
import type { PaymentListRow } from '@/lib/api/types';
import { allowed, loadMoneyShell } from '../../load';

export const metadata: Metadata = { title: 'Plan' };

/**
 * One maintenance plan: what it bills, when it bills next, the cycles it has run and the card paying for it.
 *
 * Plans are for whoever bills (`money.bill`, 0106): someone who manages money sees every plan, and anyone else who
 * bills sees the plans of the customers they're on. Everyone else never gets here.
 */
export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; subscriptionId: string }>;
}) {
  const { workspaceId, subscriptionId } = await params;
  const shell = await loadMoneyShell(workspaceId);
  if (!shell.canBill) notFound();

  const got = await shell.api
    .POST('/v1/queries/subscription.get', { body: { workspaceId, subscriptionId } })
    .then((r) => unwrapPage(r))
    .catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    });

  // The card that is paying for it: the newest cycle the provider actually took money for.
  const billed = got.invoices.find((i) => i.status === 'paid' || i.status === 'partly_paid');
  const [connections, payments] = await Promise.all([
    allowed(
      shell.api
        .POST('/v1/queries/payment_connection.list', { body: { workspaceId } })
        .then((r) => unwrapPage(r)),
    ),
    billed
      ? allowed(
          shell.api
            .POST('/v1/queries/payment.list', {
              body: { workspaceId, invoiceId: billed.id, succeededOnly: true, limit: 5 },
            })
            .then((r) => unwrapPage(r)),
        )
      : Promise.resolve(null),
  ]);
  const card: PaymentListRow | null =
    payments?.payments.find((p) => !!p.cardBrand && !!p.cardLast4) ?? null;

  return (
    <PlanPage
      workspaceId={workspaceId}
      subscription={got.subscription}
      cycles={got.invoices}
      connections={connections?.connections ?? []}
      cardPayment={card}
      canBill={shell.canBill}
      timeZone={shell.timeZone}
    />
  );
}
