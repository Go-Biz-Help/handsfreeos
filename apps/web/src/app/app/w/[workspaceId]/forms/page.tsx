import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/shell/page-header';
import { FormList } from '@/components/forms/form-list';
import { NewFormButton } from '@/components/forms/new-form-button';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Forms' };

/** Everyone can see the forms; owners and admins build them. */
export default async function FormsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const canManage = can(got.workspace.permissions, 'forms.manage');
  const [listRes, siteRes] = await Promise.all([
    api.POST('/v1/queries/form.list', { body: { workspaceId } }),
    api.POST('/v1/queries/booking_site.get', { body: { workspaceId } }),
  ]);
  const list = unwrapPage(listRes);
  return (
    <>
      <PageHeader
        title="Forms"
        description="Forms, surveys and quizzes. One builder: a form files answers against the customer, a survey asks how you did, a quiz scores what people know."
        actions={canManage ? <NewFormButton workspaceId={workspaceId} /> : null}
      />
      <FormList
        workspaceId={workspaceId}
        items={list.items}
        canManage={canManage}
        siteSlug={siteRes.data?.site?.slug ?? null}
      />
    </>
  );
}
