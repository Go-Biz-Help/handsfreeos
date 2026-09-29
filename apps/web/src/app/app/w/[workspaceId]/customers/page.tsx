import { can, CONTACTS_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { CustomersList, type CustomerFilters } from '@/components/crm/customers-list';
import { PageHeader } from '@/components/shell/page-header';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: CONTACTS_WORDS.title };

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

export default async function ContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  // A kind of record the business keeps (0101) has a tab of its own: ?kind=<its id>.
  const kindId = /^[0-9a-f-]{36}$/.test(one(sp.kind)) ? one(sp.kind) : '';
  const filters: CustomerFilters = {
    q: one(sp.q).trim().slice(0, 120),
    tagId: /^[0-9a-f-]{36}$/.test(one(sp.tag)) ? one(sp.tag) : '',
    // `owner` is what links said before a customer could have a team.
    assignedUserId: [one(sp.assigned), one(sp.owner)].find((v) => /^[0-9a-f-]{36}$/.test(v)) ?? '',
    // Leads or clients: ?show=leads or ?show=clients.
    standing: one(sp.show) === 'leads' ? 'lead' : one(sp.show) === 'clients' ? 'client' : '',
    archived: one(sp.archived) === '1',
  };
  const { api } = await apiServer();
  const { types: kinds } = unwrapPage(
    await api.POST('/v1/queries/custom_record_type.list', { body: { workspaceId } }),
  );
  const kind = kinds.find((k) => k.id === kindId) ?? null;
  const tab = kind ? 'records' : one(sp.tab) === 'companies' ? 'companies' : 'people';
  const common = {
    workspaceId,
    q: filters.q || undefined,
    tagId: filters.tagId || undefined,
    assignedUserId: filters.assignedUserId || undefined,
    standing: filters.standing || undefined,
    includeArchived: filters.archived,
    limit: 50,
  };
  const [got, tags, members, summary, people, companies, records, kindFields] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/tag.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/crm.summary', { body: { workspaceId } }).then(unwrapPage),
    tab === 'people'
      ? api.POST('/v1/queries/person.list', { body: common }).then(unwrapPage)
      : Promise.resolve(null),
    tab === 'companies'
      ? api.POST('/v1/queries/company.list', { body: common }).then(unwrapPage)
      : Promise.resolve(null),
    kind
      ? api
          .POST('/v1/queries/custom_record.list', {
            body: {
              workspaceId,
              typeId: kind.id,
              q: filters.q || undefined,
              includeArchived: filters.archived,
              limit: 50,
            },
          })
          .then(unwrapPage)
      : Promise.resolve(null),
    kind
      ? api
          .POST('/v1/queries/custom_field.list', {
            body: { workspaceId, recordTypeId: kind.id },
          })
          .then((r) => unwrapPage(r).fields)
      : [],
  ]);
  return (
    <>
      <PageHeader
        title={CONTACTS_WORDS.title}
        description={`Everyone ${got.workspace.name} works with.`}
      />
      <CustomersList
        workspaceId={workspaceId}
        tab={tab}
        filters={filters}
        tags={tags.tags}
        owners={assigneeOptions(members)}
        people={people}
        companies={companies}
        counts={{ people: summary.people, companies: summary.companies }}
        canImport={can(got.workspace.permissions, 'records.import')}
        kinds={kinds}
        kind={kind}
        records={records}
        kindFields={kindFields}
      />
    </>
  );
}
