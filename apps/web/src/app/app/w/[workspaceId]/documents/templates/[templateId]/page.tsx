import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TemplateEditor } from '@/components/documents/template-editor';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Template' };

/** One document template: its PDF, who signs it and what they fill in. Owners and admins change it. */
export default async function DocumentTemplatePage({
  params,
}: {
  params: Promise<{ workspaceId: string; templateId: string }>;
}) {
  const { workspaceId, templateId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const res = await api.POST('/v1/queries/document_template.get', {
    body: { workspaceId, templateId },
  });
  if (!res.data) notFound();
  return (
    <TemplateEditor
      key={`${res.data.id}:${res.data.archivedAt ?? ''}`}
      workspaceId={workspaceId}
      initial={res.data}
      canManage={can(got.workspace.permissions, 'documents.manage')}
    />
  );
}
