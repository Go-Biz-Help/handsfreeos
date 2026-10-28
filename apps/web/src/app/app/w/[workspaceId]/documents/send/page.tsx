import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { SendDocument, type SendAbout } from '@/components/documents/send-document';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { assigneeOptions } from '@/lib/api/people';

export const metadata: Metadata = { title: 'Send a document' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) =>
  typeof v === 'string' && UUID.test(v) ? v : null;

/**
 * Sending a template to sign: `?template=` picks it, `?person=` (or `company`, `lead`, `record`) who it's about, and
 * `?from=` a voided or declined document it corrects (answer 15a).
 */
export default async function SendDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'documents.send'))
    return (
      <PageHeader
        title="Send a document"
        description="Ask an owner of this business to let you send documents in Settings → Team."
      />
    );
  const [templates, members] = await Promise.all([
    api.POST('/v1/queries/document_template.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
  ]);

  let about: SendAbout | null = null;
  const personId = one(q.person);
  const companyId = one(q.company);
  const leadId = one(q.lead);
  const recordId = one(q.record);
  if (personId) {
    const r = await api.POST('/v1/queries/person.get', { body: { workspaceId, personId } });
    if (r.data) about = { kind: 'person', id: personId, name: r.data.person.fullName };
  } else if (companyId) {
    const r = await api.POST('/v1/queries/company.get', { body: { workspaceId, companyId } });
    if (r.data) about = { kind: 'company', id: companyId, name: r.data.company.name };
  } else if (leadId) {
    const r = await api.POST('/v1/queries/lead.get', { body: { workspaceId, leadId } });
    if (r.data) about = { kind: 'lead', id: leadId, name: r.data.lead.title };
  } else if (recordId) {
    const r = await api.POST('/v1/queries/custom_record.get', {
      body: { workspaceId, customRecordId: recordId },
    });
    if (r.data) about = { kind: 'custom_record', id: recordId, name: r.data.record.name };
  }

  return (
    <>
      <PageHeader
        title="Send a document"
        description="Pick the template and who it’s for. Check what’s filled in, change any words for this customer, and send. Each signer gets their own private link."
      />
      <SendDocument
        workspaceId={workspaceId}
        templates={templates.templates
          .filter((t) => t.ready)
          .map((t) => ({ id: t.id, name: t.name }))}
        templateId={one(q.template)}
        about={about}
        fromDocumentId={one(q.from)}
        members={assigneeOptions(members)}
      />
    </>
  );
}
