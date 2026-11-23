import type { Metadata } from 'next';
import { OrderPage } from '@/components/money/order-page';
import { unwrapPage } from '@/lib/api/server';
import { allowed, loadEditorCatalogs, loadMoneyShell } from '../../load';

export const metadata: Metadata = { title: 'Order' };

/** One order (product sellers): where it is, what's on it, when, its invoice, and what they answered on its form. */
export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; orderId: string }>;
}) {
  const { workspaceId, orderId } = await params;
  const shell = await loadMoneyShell(workspaceId);
  const [{ order }, catalogs] = await Promise.all([
    shell.api
      .POST('/v1/queries/order.get', { body: { workspaceId, orderId } })
      .then((r) => unwrapPage(r)),
    loadEditorCatalogs(shell.api, workspaceId),
  ]);
  // The answers are the form's own: one deleted since, or one this person can't see, leaves them off.
  const response = order.formResponseId
    ? await allowed(
        shell.api
          .POST('/v1/queries/form.response_get', {
            body: { workspaceId, responseId: order.formResponseId },
          })
          .then((r) => (r.data ? r.data : null)),
      ).catch(() => null)
    : null;

  return (
    <OrderPage
      workspaceId={workspaceId}
      order={order}
      products={catalogs.products}
      response={response}
      canWrite={shell.permissions.includes('records.write')}
      canBill={shell.canBill}
    />
  );
}
