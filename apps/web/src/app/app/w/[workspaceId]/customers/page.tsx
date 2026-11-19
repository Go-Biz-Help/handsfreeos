import { can, CONTACTS_WORDS, HANDS_WORDS } from '@hfos/core';
import Link from 'next/link';
import type { Metadata } from 'next';
import { CustomersList, type CustomerFilters } from '@/components/crm/customers-list';
import { HandsList } from '@/components/crm/hands';
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
  // In your hands (core's messaging/hands.ts): ?show=hands, everyone's or only yours (&mine=1).
  if (one(sp.show) === 'hands')
    return <InHandsPage workspaceId={workspaceId} mine={one(sp.mine) === '1'} />;
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
  const [got, tags, members, summary, people, companies, records, kindFields, inHands] =
    await Promise.all([
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
      api.POST('/v1/queries/person.in_hands', { body: { workspaceId, limit: 1 } }).then(unwrapPage),
    ]);
  return (
    <>
      <PageHeader
        title={CONTACTS_WORDS.title}
        description={`Everyone ${got.workspace.name} works with.`}
        actions={
          inHands.total ? (
            <Link
              href={`/app/w/${workspaceId}/customers?show=hands`}
              className="text-[13px] font-medium text-accent-text hover:underline"
              data-testid="customers-in-hands"
            >
              {HANDS_WORDS.title} ({inHands.total})
            </Link>
          ) : null
        }
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
        canDelete={can(got.workspace.permissions, 'records.delete')}
        kinds={kinds}
        kind={kind}
        records={records}
        kindFields={kindFields}
      />
    </>
  );
}

/** Contacts → In your hands: the customers someone on the team messaged or called themselves, so the AI holds off. */
async function InHandsPage({ workspaceId, mine }: { workspaceId: string; mine: boolean }) {
  const { api, userId } = await apiServer();
  const [got, list] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/person.in_hands', { body: { workspaceId, mine, limit: 200 } })
      .then(unwrapPage),
  ]);
  return (
    <>
      <PageHeader
        title={HANDS_WORDS.title}
        actions={
          <Link
            href={`/app/w/${workspaceId}/customers`}
            className="text-[13px] font-medium text-accent-text hover:underline"
          >
            {CONTACTS_WORDS.title}
          </Link>
        }
      />
      <HandsList
        workspaceId={workspaceId}
        myUserId={userId}
        people={list.people}
        total={list.total}
        mine={mine}
        canEdit={can(got.workspace.permissions, 'inbox.use')}
      />
    </>
  );
}
