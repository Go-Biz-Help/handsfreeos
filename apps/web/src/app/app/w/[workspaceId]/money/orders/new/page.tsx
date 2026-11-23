import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NewOrderEditor } from '@/components/money/order-editor';
import { MoneyCrumbs } from '@/components/money/subnav';
import { loadEditorCatalogs, loadMoneyShell } from '../../load';
import { seedFrom } from '../../seed';

export const metadata: Metadata = { title: 'New order' };

/** A new order, taken by hand. `?person=` picks the customer, as a new invoice's does. */
export default async function NewOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const shell = await loadMoneyShell(workspaceId);
  if (!shell.permissions.includes('records.write')) notFound();
  const [{ products }, seed] = await Promise.all([
    loadEditorCatalogs(shell.api, workspaceId),
    searchParams.then((sp) => seedFrom(shell.api, workspaceId, sp)),
  ]);

  return (
    <>
      <MoneyCrumbs workspaceId={workspaceId} tab="orders" current="New order" />
      <NewOrderEditor workspaceId={workspaceId} products={products} person={seed.person ?? null} />
    </>
  );
}
