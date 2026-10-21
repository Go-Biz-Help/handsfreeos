'use client';
import { Archive, Building2, ChevronRight, Plus, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { DeleteDialog } from '@/components/bin/delete-dialog';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { BIN_WORDS, CONTACTS_WORDS, lowerLabel } from '@hfos/core';
import { CustomRecordDialog } from '@/components/relationships/custom-record-dialog';
import { RecordIcon } from '@/components/relationships/record-icon';
import { useCan } from '@/components/shell/workspace-shell';
import type {
  CompanyList,
  CompanySummary,
  CustomField,
  CustomRecordList,
  CustomRecordSummary,
  CustomRecordType,
  PersonList,
  PersonSummary,
  Tag,
} from '@/lib/api/types';
import { addressLine } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn, relativeTime } from '@/lib/utils';
import { TagChip } from './chips';
import { CompanyDialog } from './company-dialog';
import { PersonDialog } from './person-dialog';

/**
 * On a desktop the table scrolls inside its card (the shell gives the page the viewport's height) and the
 * column names stay pinned at the top; the header cells carry their own background and bottom rule because
 * a sticky cell leaves its row behind. Phones show a list and scroll the page as usual.
 */
const scrollingCard = 'overflow-hidden md:min-h-[200px] md:flex-1 md:overflow-y-auto';
const stickyHead = 'sticky top-0 z-10 bg-card-2 px-3 py-2.5 shadow-[inset_0_-1px_0_var(--border)]';

export interface CustomerFilters {
  q: string;
  tagId: string;
  /** Who they are assigned to: their owner, or anyone on their team. */
  assignedUserId: string;
  /** Only the leads, or only the clients; '' for everyone. */
  standing: '' | 'lead' | 'client';
  archived: boolean;
}

export function CustomersList({
  workspaceId,
  tab,
  filters,
  tags,
  owners,
  people,
  companies,
  counts,
  canImport,
  canDelete = false,
  kinds = [],
  kind = null,
  records = null,
  kindFields = [],
}: {
  workspaceId: string;
  tab: 'people' | 'companies' | 'records';
  filters: CustomerFilters;
  tags: Tag[];
  owners: { id: string; fullName: string }[];
  people: PersonList | null;
  companies: CompanyList | null;
  counts: { people: number; companies: number };
  canImport: boolean;
  /** May delete customers for good (records.delete): ticks beside each person, to delete several at once. */
  canDelete?: boolean;
  /** The kinds of records the business keeps (0101): a tab each, beside People and Companies. */
  kinds?: CustomRecordType[];
  /** The kind whose tab this is, its records, and its fields (for Add). */
  kind?: CustomRecordType | null;
  records?: CustomRecordList | null;
  kindFields?: CustomField[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(filters.q);
  const [adding, setAdding] = useState(false);
  useLiveRefresh(['person', 'company', 'tag', 'custom_record', 'relationship']);

  /**
   * "Add a contact" from a search that found nobody (`#add=person&name=…`): the dialog opens with what was typed as
   * the name, when the list opens and whenever the fragment changes on it (the box, already on Contacts). It travels
   * after `#`, so it never reaches the server, and the fragment is dropped once read.
   */
  const canWrite = useCan('records.write');
  const [addName, setAddName] = useState<string | undefined>(undefined);
  useEffect(() => {
    const read = () => {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      if (hash.get('add') !== 'person') return;
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      if (!canWrite || tab !== 'people') return;
      setAddName((hash.get('name') ?? '').trim().slice(0, 120));
      setAdding(true);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [canWrite, tab]);

  // Filters live in the URL so the server renders the right page and links are shareable.
  function navigate(next: Partial<CustomerFilters> & { tab?: 'people' | 'companies' }) {
    const params = new URLSearchParams();
    const merged = { ...filters, tab, ...next };
    if (merged.tab === 'companies') params.set('tab', 'companies');
    if (merged.tab === 'records' && kind) params.set('kind', kind.id);
    if (merged.q.trim()) params.set('q', merged.q.trim());
    if (merged.tagId) params.set('tag', merged.tagId);
    if (merged.assignedUserId) params.set('assigned', merged.assignedUserId);
    if (merged.standing) params.set('show', merged.standing === 'lead' ? 'leads' : 'clients');
    if (merged.archived) params.set('archived', '1');
    const qs = params.toString();
    startTransition(() => router.replace(`${pathname}${qs ? `?${qs}` : ''}`));
  }
  useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => navigate({ q }), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setQ(filters.q), [filters.q]);

  const base = `/app/w/${workspaceId}/customers`;
  const shown =
    tab === 'people'
      ? (people?.items.length ?? 0)
      : tab === 'companies'
        ? (companies?.items.length ?? 0)
        : (records?.items.length ?? 0);
  const tabs: { key: string; label: string; href: string; current: boolean }[] = [
    { key: 'people', label: `People · ${counts.people}`, href: base, current: tab === 'people' },
    {
      key: 'companies',
      label: `Companies · ${counts.companies}`,
      href: `${base}?tab=companies`,
      current: tab === 'companies',
    },
    ...kinds.map((k) => ({
      key: k.key,
      label: `${k.plural} · ${k.recordCount}`,
      href: `${base}?kind=${k.id}`,
      current: tab === 'records' && kind?.id === k.id,
    })),
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-full gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]">
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              aria-current={t.current ? 'page' : undefined}
              data-testid={`customers-tab-${t.key}`}
              className={cn(
                '-mb-px flex h-10 flex-none items-center border-b-2 px-3 text-sm font-medium transition-colors',
                t.current
                  ? 'border-accent text-accent-text'
                  : 'border-transparent text-text-2 hover:text-text',
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
        <div className="flex gap-2">
          {canImport ? (
            <ButtonLink href={`/app/w/${workspaceId}/imports/new`} variant="secondary">
              <Upload className="h-[18px] w-[18px]" strokeWidth={1.5} />
              Import
            </ButtonLink>
          ) : null}
          <Button onClick={() => setAdding(true)} data-testid="customers-add">
            <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
            {tab === 'people'
              ? 'Add person'
              : tab === 'companies'
                ? 'Add company'
                : `Add ${lowerLabel(kind?.singular ?? 'record')}`}
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Input
          type="search"
          inputSize="sm"
          className="w-full sm:w-[320px]"
          placeholder={
            tab === 'records'
              ? `Search ${lowerLabel(kind?.plural ?? 'records')} by name or any field`
              : 'Search by name, phone, email or street'
          }
          aria-label={CONTACTS_WORDS.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="customers-search"
        />
        {tab === 'records' ? null : (
          <>
            <Segmented
              ariaLabel={CONTACTS_WORDS.standing}
              value={filters.standing || 'all'}
              onChange={(v) => navigate({ standing: v === 'all' ? '' : v })}
              options={[
                { value: 'all', label: CONTACTS_WORDS.all, testId: 'customers-standing-all' },
                {
                  value: 'lead',
                  label: CONTACTS_WORDS.leads,
                  title: CONTACTS_WORDS.clientRule,
                  testId: 'customers-standing-lead',
                },
                {
                  value: 'client',
                  label: CONTACTS_WORDS.clients,
                  title: CONTACTS_WORDS.clientRule,
                  testId: 'customers-standing-client',
                },
              ]}
            />
            <Select
              selectSize="sm"
              className="w-[150px]"
              aria-label="Tag"
              value={filters.tagId}
              onChange={(e) => navigate({ tagId: e.target.value })}
            >
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Select
              selectSize="sm"
              className="w-[170px]"
              aria-label="Assigned to"
              value={filters.assignedUserId}
              onChange={(e) => navigate({ assignedUserId: e.target.value })}
              data-testid="customers-assigned"
            >
              <option value="">Assigned to anyone</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.fullName}
                </option>
              ))}
            </Select>
          </>
        )}
        <Button
          variant={filters.archived ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => navigate({ archived: !filters.archived })}
          aria-pressed={filters.archived}
          data-testid="customers-archived"
        >
          <Archive className="h-4 w-4" strokeWidth={1.5} />
          {filters.archived ? 'Showing archived' : 'Show archived'}
        </Button>
        <span className="flex-1" />
        <span className="text-[13px] text-text-3" aria-live="polite">
          {pending ? 'Updating…' : `${shown} shown`}
        </span>
      </div>

      {tab === 'people' ? (
        <PeopleTable
          workspaceId={workspaceId}
          filters={filters}
          initial={people!}
          onAdd={() => setAdding(true)}
          canImport={canImport}
          canDelete={canDelete}
        />
      ) : tab === 'companies' ? (
        <CompaniesTable
          workspaceId={workspaceId}
          filters={filters}
          initial={companies!}
          onAdd={() => setAdding(true)}
          canImport={canImport}
        />
      ) : kind && records ? (
        <RecordsTable
          workspaceId={workspaceId}
          filters={filters}
          kind={kind}
          initial={records}
          onAdd={() => setAdding(true)}
        />
      ) : null}

      {tab === 'people' ? (
        <PersonDialog
          workspaceId={workspaceId}
          tags={tags}
          open={adding}
          onOpenChange={(o) => {
            setAdding(o);
            if (!o) setAddName(undefined);
          }}
          defaultName={addName}
        />
      ) : tab === 'companies' ? (
        <CompanyDialog
          workspaceId={workspaceId}
          tags={tags}
          open={adding}
          onOpenChange={setAdding}
        />
      ) : kind ? (
        <CustomRecordDialog
          workspaceId={workspaceId}
          kind={kind}
          fields={kindFields}
          open={adding}
          onOpenChange={setAdding}
        />
      ) : null}
    </>
  );
}

function useMore<T extends { id: string }>(key: string, initialCursor: string | null) {
  const [extra, setExtra] = useState<{ key: string; items: T[]; cursor: string | null }>({
    key,
    items: [],
    cursor: initialCursor,
  });
  const current = extra.key === key ? extra : { key, items: [] as T[], cursor: initialCursor };
  return {
    items: current.items,
    cursor: current.cursor,
    append: (items: T[], cursor: string | null) =>
      setExtra({ key, items: [...current.items, ...items], cursor }),
  };
}

function emptyState(
  filters: CustomerFilters,
  kind: 'people' | 'companies',
  onAdd: () => void,
  canImport: boolean,
  workspaceId: string,
) {
  const searched = filters.q || filters.tagId || filters.assignedUserId;
  const filtered = searched || filters.standing;
  // "No clients yet" rather than "No people yet" when leads or clients is chosen.
  const noun =
    kind === 'people' && filters.standing
      ? lowerLabel(filters.standing === 'lead' ? CONTACTS_WORDS.leads : CONTACTS_WORDS.clients)
      : kind;
  return (
    <EmptyState
      title={
        searched ? `No ${noun} match` : filters.archived ? `No archived ${noun}` : `No ${noun} yet`
      }
      actions={
        filtered ? undefined : (
          <>
            {canImport ? (
              <ButtonLink href={`/app/w/${workspaceId}/imports/new`} variant="secondary" size="sm">
                Import a spreadsheet
              </ButtonLink>
            ) : null}
            <Button size="sm" onClick={onAdd}>
              Add {kind === 'people' ? 'a person' : 'a company'}
            </Button>
          </>
        )
      }
    >
      {searched
        ? 'Try a different search, or add them.'
        : filtered
          ? CONTACTS_WORDS.clientRule
          : `Add one, or import a spreadsheet.`}
    </EmptyState>
  );
}

function PeopleTable({
  workspaceId,
  filters,
  initial,
  onAdd,
  canImport,
  canDelete,
}: {
  workspaceId: string;
  filters: CustomerFilters;
  initial: PersonList;
  onAdd: () => void;
  canImport: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const key = JSON.stringify({ filters, first: initial.items[0]?.id, n: initial.items.length });
  const more = useMore<PersonSummary>(key, initial.nextCursor);
  const [busy, setBusy] = useState(false);
  const items = [...initial.items, ...more.items];
  // Ticked to delete several at once; only those still shown count.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const picked = items.filter((p) => ticked.has(p.id));
  const all = picked.length === items.length;
  const tick = (id: string, on: boolean) =>
    setTicked((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  async function loadMore() {
    if (!more.cursor) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/person.list', {
          body: {
            workspaceId,
            q: filters.q || undefined,
            tagId: filters.tagId || undefined,
            assignedUserId: filters.assignedUserId || undefined,
            standing: filters.standing || undefined,
            includeArchived: filters.archived,
            cursor: more.cursor,
            limit: 50,
          },
        }),
      );
      more.append(out.items, out.nextCursor);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (items.length === 0)
    return <Card>{emptyState(filters, 'people', onAdd, canImport, workspaceId)}</Card>;
  return (
    <>
      {picked.length > 0 ? (
        <div
          className="mb-3 hidden items-center gap-3 rounded-menu bg-card-2 px-3.5 py-2 text-[13px] md:flex"
          data-testid="people-picked"
        >
          <span className="font-medium">{picked.length} selected</span>
          <Button
            variant="secondary"
            size="sm"
            className="text-danger-text hover:text-danger-text"
            onClick={() => setDeleting(true)}
            data-testid="people-delete"
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.5} />
            {BIN_WORDS.menu}
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => setTicked(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}
      <Card className={scrollingCard}>
        <table className="hidden w-full text-sm md:table" data-testid="people-table">
          <thead>
            <tr className="text-left text-xs font-medium text-text-2">
              {canDelete ? (
                <th className={cn(stickyHead, 'w-10 pl-4 pr-0')}>
                  <input
                    type="checkbox"
                    aria-label="Select everyone shown"
                    className="h-4 w-4 cursor-pointer accent-accent"
                    checked={all}
                    onChange={(e) =>
                      setTicked(new Set(e.target.checked ? items.map((p) => p.id) : []))
                    }
                    data-testid="people-select-all"
                  />
                </th>
              ) : null}
              <th className={cn(stickyHead, 'w-[30%] px-4')}>Person</th>
              <th className={stickyHead}>Contact</th>
              <th className={stickyHead}>Tags</th>
              <th className={stickyHead}>Open leads</th>
              <th className={stickyHead}>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr
                key={p.id}
                className="border-t border-border hover:bg-card-2/60"
                data-testid={`person-row-${p.id}`}
              >
                {canDelete ? (
                  <td className="w-10 py-2.5 pl-4 pr-0">
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.fullName}`}
                      className="h-4 w-4 cursor-pointer accent-accent"
                      checked={ticked.has(p.id)}
                      onChange={(e) => tick(p.id, e.target.checked)}
                      data-testid={`person-select-${p.id}`}
                    />
                  </td>
                ) : null}
                <td className="px-4 py-2.5">
                  <Link
                    href={`/app/w/${workspaceId}/customers/people/${p.id}`}
                    className="flex items-center gap-3"
                  >
                    <Avatar name={p.fullName} seed={p.id} />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">
                          {p.fullName}
                          {p.archivedAt ? (
                            <span className="ml-2 text-xs font-normal text-text-3">(archived)</span>
                          ) : null}
                        </span>
                        {p.client ? <Badge variant="ok">{CONTACTS_WORDS.client}</Badge> : null}
                      </span>
                      <span className="truncate text-xs text-text-3">
                        {p.company?.name ?? addressLine(p.address) ?? ''}
                      </span>
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex flex-col">
                    <span className="text-[13px]">{p.phone ?? ''}</span>
                    <span className="text-xs text-text-3">{p.email ?? ''}</span>
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex flex-wrap gap-1.5">
                    {p.tags.map((t) => (
                      <TagChip key={t.id} name={t.name} color={t.color} />
                    ))}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  {p.openLeads ? (
                    <Badge variant="accent">{p.openLeads} open</Badge>
                  ) : (
                    <span className="text-[13px] text-text-3">none</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-[13px] text-text-2">
                  {p.lastActivityAt ? relativeTime(p.lastActivityAt) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="flex flex-col divide-y divide-border md:hidden">
          {items.map((p) => (
            <li key={p.id}>
              <Link
                href={`/app/w/${workspaceId}/customers/people/${p.id}`}
                className="flex min-h-[64px] items-center gap-3 px-4 py-3 active:bg-card-2"
              >
                <Avatar name={p.fullName} seed={p.id} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{p.fullName}</span>
                  <span className="truncate text-xs text-text-3">
                    {p.company?.name ?? p.phone ?? p.email ?? addressLine(p.address)}
                  </span>
                </span>
                {p.client ? <Badge variant="ok">{CONTACTS_WORDS.client}</Badge> : null}
                {p.openLeads ? <Badge variant="accent">{p.openLeads} open</Badge> : null}
                <ChevronRight className="h-[18px] w-[18px] text-text-3" strokeWidth={1.5} />
              </Link>
            </li>
          ))}
        </ul>
        {more.cursor ? (
          <div className="flex justify-center border-t border-border p-3">
            <Button variant="ghost" size="sm" loading={busy} onClick={loadMore}>
              Show more
            </Button>
          </div>
        ) : null}
      </Card>
      {canDelete ? (
        <DeleteDialog
          workspaceId={workspaceId}
          kind="person"
          ids={picked.map((p) => p.id)}
          names={picked.map((p) => p.fullName)}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={() => {
            setTicked(new Set());
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function CompaniesTable({
  workspaceId,
  filters,
  initial,
  onAdd,
  canImport,
}: {
  workspaceId: string;
  filters: CustomerFilters;
  initial: CompanyList;
  onAdd: () => void;
  canImport: boolean;
}) {
  const key = JSON.stringify({ filters, first: initial.items[0]?.id, n: initial.items.length });
  const more = useMore<CompanySummary>(key, initial.nextCursor);
  const [busy, setBusy] = useState(false);
  const items = [...initial.items, ...more.items];
  async function loadMore() {
    if (!more.cursor) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/company.list', {
          body: {
            workspaceId,
            q: filters.q || undefined,
            tagId: filters.tagId || undefined,
            assignedUserId: filters.assignedUserId || undefined,
            standing: filters.standing || undefined,
            includeArchived: filters.archived,
            cursor: more.cursor,
            limit: 50,
          },
        }),
      );
      more.append(out.items, out.nextCursor);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (items.length === 0)
    return <Card>{emptyState(filters, 'companies', onAdd, canImport, workspaceId)}</Card>;
  return (
    <Card className={scrollingCard}>
      <table className="hidden w-full text-sm md:table" data-testid="companies-table">
        <thead>
          <tr className="text-left text-xs font-medium text-text-2">
            <th className={cn(stickyHead, 'w-[32%] px-4')}>Company</th>
            <th className={stickyHead}>Contact</th>
            <th className={stickyHead}>Tags</th>
            <th className={stickyHead}>People</th>
            <th className={stickyHead}>Open leads</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr
              key={c.id}
              className="border-t border-border hover:bg-card-2/60"
              data-testid={`company-row-${c.id}`}
            >
              <td className="px-4 py-2.5">
                <Link
                  href={`/app/w/${workspaceId}/customers/companies/${c.id}`}
                  className="flex items-center gap-3"
                >
                  <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-control bg-card-3 text-text">
                    <Building2 className="h-4 w-4" strokeWidth={1.5} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">
                        {c.name}
                        {c.archivedAt ? (
                          <span className="ml-2 text-xs font-normal text-text-3">(archived)</span>
                        ) : null}
                      </span>
                      {c.client ? <Badge variant="ok">{CONTACTS_WORDS.client}</Badge> : null}
                    </span>
                    <span className="truncate text-xs text-text-3">{addressLine(c.address)}</span>
                  </span>
                </Link>
              </td>
              <td className="px-3 py-2.5">
                <span className="flex flex-col">
                  <span className="text-[13px]">{c.phone ?? ''}</span>
                  <span className="text-xs text-text-3">{c.email ?? c.website ?? ''}</span>
                </span>
              </td>
              <td className="px-3 py-2.5">
                <span className="flex flex-wrap gap-1.5">
                  {c.tags.map((t) => (
                    <TagChip key={t.id} name={t.name} color={t.color} />
                  ))}
                </span>
              </td>
              <td className="px-3 py-2.5 text-[13px]">{c.peopleCount}</td>
              <td className="px-3 py-2.5">
                {c.openLeads ? (
                  <Badge variant="accent">{c.openLeads} open</Badge>
                ) : (
                  <span className="text-[13px] text-text-3">none</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {items.map((c) => (
          <li key={c.id}>
            <Link
              href={`/app/w/${workspaceId}/customers/companies/${c.id}`}
              className="flex min-h-[64px] items-center gap-3 px-4 py-3 active:bg-card-2"
            >
              <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-control bg-card-3 text-text">
                <Building2 className="h-4 w-4" strokeWidth={1.5} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{c.name}</span>
                <span className="truncate text-xs text-text-3">
                  {c.phone ?? addressLine(c.address)}
                </span>
              </span>
              {c.client ? <Badge variant="ok">{CONTACTS_WORDS.client}</Badge> : null}
              {c.openLeads ? <Badge variant="accent">{c.openLeads} open</Badge> : null}
              <ChevronRight className="h-[18px] w-[18px] text-text-3" strokeWidth={1.5} />
            </Link>
          </li>
        ))}
      </ul>
      {more.cursor ? (
        <div className="flex justify-center border-t border-border p-3">
          <Button variant="ghost" size="sm" loading={busy} onClick={loadMore}>
            Show more
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** The records of one of the business's own kinds: its pets, its vehicles, its properties. */
function RecordsTable({
  workspaceId,
  filters,
  kind,
  initial,
  onAdd,
}: {
  workspaceId: string;
  filters: CustomerFilters;
  kind: CustomRecordType;
  initial: CustomRecordList;
  onAdd: () => void;
}) {
  const key = JSON.stringify({
    filters,
    kind: kind.id,
    first: initial.items[0]?.id,
    n: initial.items.length,
  });
  const more = useMore<CustomRecordSummary>(key, initial.nextCursor);
  const [busy, setBusy] = useState(false);
  const items = [...initial.items, ...more.items];
  const href = (id: string) => `/app/w/${workspaceId}/customers/records/${id}`;
  const relatedLine = (r: CustomRecordSummary) =>
    r.related.map((x) => `${x.name} (${x.label})`).join(', ');
  async function loadMore() {
    if (!more.cursor) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/custom_record.list', {
          body: {
            workspaceId,
            typeId: kind.id,
            q: filters.q || undefined,
            includeArchived: filters.archived,
            cursor: more.cursor,
            limit: 50,
          },
        }),
      );
      more.append(out.items, out.nextCursor);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (items.length === 0)
    return (
      <Card>
        <EmptyState
          title={
            filters.q
              ? `No ${lowerLabel(kind.plural)} match`
              : filters.archived
                ? `No archived ${lowerLabel(kind.plural)}`
                : `No ${lowerLabel(kind.plural)} yet`
          }
          actions={
            filters.q ? undefined : (
              <Button size="sm" onClick={onAdd}>
                Add {lowerLabel(kind.singular)}
              </Button>
            )
          }
        >
          {filters.q
            ? 'Try a different search.'
            : `Add one here, or from a customer’s page under Relationships.`}
        </EmptyState>
      </Card>
    );
  return (
    <Card className={scrollingCard}>
      <table className="hidden w-full text-sm md:table" data-testid="records-table">
        <thead>
          <tr className="text-left text-xs font-medium text-text-2">
            <th className={cn(stickyHead, 'w-[34%] px-4')}>{kind.singular}</th>
            <th className={stickyHead}>Related to</th>
            <th className={stickyHead}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr
              key={r.id}
              className="border-t border-border hover:bg-card-2/60"
              data-testid={`record-row-${r.id}`}
            >
              <td className="px-4 py-2.5">
                <Link href={href(r.id)} className="flex items-center gap-3">
                  <RecordIcon icon={kind.icon} size="md" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {r.name}
                      {r.archivedAt ? (
                        <span className="ml-2 text-xs font-normal text-text-3">(archived)</span>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-text-3">{r.detail ?? ''}</span>
                  </span>
                </Link>
              </td>
              <td className="px-3 py-2.5 text-[13px] text-text-2">{relatedLine(r)}</td>
              <td className="px-3 py-2.5 text-[13px] text-text-2">{relativeTime(r.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {items.map((r) => (
          <li key={r.id}>
            <Link
              href={href(r.id)}
              className="flex min-h-[64px] items-center gap-3 px-4 py-3 active:bg-card-2"
            >
              <RecordIcon icon={kind.icon} size="md" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{r.name}</span>
                <span className="truncate text-xs text-text-3">
                  {relatedLine(r) || r.detail || ''}
                </span>
              </span>
              <ChevronRight className="h-[18px] w-[18px] text-text-3" strokeWidth={1.5} />
            </Link>
          </li>
        ))}
      </ul>
      {more.cursor ? (
        <div className="flex justify-center border-t border-border p-3">
          <Button variant="ghost" size="sm" loading={busy} onClick={loadMore}>
            Show more
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
