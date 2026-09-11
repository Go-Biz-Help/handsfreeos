import type { Metadata } from 'next';
import { CustomersList } from '@/components/crm/customers-list';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Customers' };

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const tab = one(sp.tab) === 'companies' ? 'companies' : 'people';
  const filters = {
    q: one(sp.q).trim().slice(0, 120),
    tagId: /^[0-9a-f-]{36}$/.test(one(sp.tag)) ? one(sp.tag) : '',
    ownerUserId: /^[0-9a-f-]{36}$/.test(one(sp.owner)) ? one(sp.owner) : '',
    archived: one(sp.archived) === '1',
  };
  const { api } = await apiServer();
  const common = {
    workspaceId,
    q: filters.q || undefined,
    tagId: filters.tagId || undefined,
    includeArchived: filters.archived,
    limit: 50,
  };
  const [got, tags, members, summary, people, companies] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/tag.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/crm.summary', { body: { workspaceId } })),
    tab === 'people'
      ? unwrapPage(
          await api.POST('/v1/queries/person.list', {
            body: { ...common, ownerUserId: filters.ownerUserId || undefined },
          }),
        )
      : Promise.resolve(null),
    tab === 'companies'
      ? unwrapPage(await api.POST('/v1/queries/company.list', { body: common }))
      : Promise.resolve(null),
  ]);
  const role = got.workspace.role;
  return (
    <>
      <PageHeader title="Customers" description={`Everyone ${got.workspace.name} works with.`} />
      <CustomersList
        workspaceId={workspaceId}
        tab={tab}
        filters={filters}
        tags={tags.tags}
        owners={members.members.map((m) => ({ id: m.userId, fullName: m.fullName || m.email }))}
        people={people}
        companies={companies}
        counts={{ people: summary.people, companies: summary.companies }}
        canImport={role === 'owner' || role === 'admin'}
      />
    </>
  );
}
