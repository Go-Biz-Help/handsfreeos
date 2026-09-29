import { can, readMoneySettings } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductsPage } from '@/components/money/products-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Products' };

/**
 * Settings → Products (owners and admins): the catalogue an estimate or an invoice is built from, each item's
 * price, unit and taxability, and the bookable service it can be the price of.
 */
export default async function ProductsSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'money.manage')) notFound();
  const [products, services, settings] = await Promise.all([
    api
      .POST('/v1/queries/product.list', { body: { workspaceId, includeArchived: true } })
      .then(unwrapPage),
    api.POST('/v1/queries/service.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/money.settings', { body: { workspaceId } }).then(unwrapPage),
  ]);
  return (
    <>
      <ProductsPage
        workspaceId={workspaceId}
        products={products.products}
        services={services.items}
        settings={readMoneySettings(settings.settings)}
      />
    </>
  );
}
