import { can } from '@hfos/core';
import { Send } from 'lucide-react';
import type { Metadata } from 'next';
import { DocumentsHome } from '@/components/documents/documents-home';
import { NewTemplateButton } from '@/components/documents/new-template';
import { PageHeader } from '@/components/shell/page-header';
import { ButtonLink } from '@/components/ui/button';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Documents' };

/** Documents to sign (docs/documents.md): what's out and where it is, and the templates. */
export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { workspaceId } = await params;
  const { tab } = await searchParams;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const canManage = can(got.workspace.permissions, 'documents.manage');
  const canSend = can(got.workspace.permissions, 'documents.send');
  const [docs, templates] = await Promise.all([
    api.POST('/v1/queries/document.list', { body: { workspaceId, limit: 50 } }),
    api.POST('/v1/queries/document_template.list', { body: { workspaceId } }),
  ]);
  const list = unwrapPage(docs);
  const ready = unwrapPage(templates).templates;
  return (
    <>
      <PageHeader
        title="Documents"
        description="Contracts and agreements your customers sign online. Make a template from a PDF once, then send it to anyone."
        actions={
          <>
            {canManage ? <NewTemplateButton workspaceId={workspaceId} /> : null}
            {canSend && ready.some((t) => t.ready) ? (
              <ButtonLink
                variant={canManage ? 'secondary' : 'primary'}
                href={`/app/w/${workspaceId}/documents/send`}
              >
                <Send className="h-4 w-4" strokeWidth={1.75} />
                Send a document
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <DocumentsHome
        workspaceId={workspaceId}
        tab={tab === 'templates' ? 'templates' : 'sent'}
        documents={list.documents}
        more={list.more}
        templates={ready}
        canManage={canManage}
        canSend={canSend}
      />
    </>
  );
}
