import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormEditor } from '@/components/forms/editor';
import { FormNameHeader } from '@/components/forms/name-header';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

export const metadata: Metadata = { title: 'Form' };

/** One form: its questions, and what a customer would see. */
export default async function FormPage({
  params,
}: {
  params: Promise<{ workspaceId: string; formId: string }>;
}) {
  const { workspaceId, formId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const canManage = can(got.workspace.permissions, 'forms.manage');
  const [formRes, catalogsRes, resultsRes, siteRes, brandedOrigin] = await Promise.all([
    api.POST('/v1/queries/form.get', { body: { workspaceId, formId } }),
    api.POST('/v1/queries/form.catalogs', { body: { workspaceId } }),
    api.POST('/v1/queries/form.results', { body: { workspaceId, formId } }),
    api.POST('/v1/queries/booking_site.get', { body: { workspaceId } }),
    brandedOriginFor(api, workspaceId),
  ]);
  if (!formRes.data) notFound();
  return (
    <>
      <FormNameHeader workspaceId={workspaceId} form={formRes.data.form} canManage={canManage} />
      <FormEditor
        workspaceId={workspaceId}
        initial={formRes.data}
        catalogs={catalogsRes.data ?? null}
        results={resultsRes.data ?? null}
        siteSlug={siteRes.data?.site?.slug ?? null}
        canManage={canManage}
        brandedOrigin={brandedOrigin}
        timeZone={got.workspace.timezone}
      />
    </>
  );
}
