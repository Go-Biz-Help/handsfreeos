'use client';
import { Archive, Building2, ChevronRight, Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { CompanyList, CompanySummary, PersonList, PersonSummary, Tag } from '@/lib/api/types';
import { addressLine } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn, relativeTime } from '@/lib/utils';
import { TagChip } from './chips';
import { CompanyDialog } from './company-dialog';
import { PersonDialog } from './person-dialog';

export interface CustomerFilters {
  q: string;
  tagId: string;
  ownerUserId: string;
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
}: {
  workspaceId: string;
  tab: 'people' | 'companies';
  filters: CustomerFilters;
  tags: Tag[];
  owners: { id: string; fullName: string }[];
  people: PersonList | null;
  companies: CompanyList | null;
  counts: { people: number; companies: number };
  canImport: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(filters.q);
  const [adding, setAdding] = useState(false);
  useLiveRefresh(['person', 'company', 'tag']);

  // Filters live in the URL so the server renders the right page and links are shareable.
  function navigate(next: Partial<CustomerFilters> & { tab?: 'people' | 'companies' }) {
    const params = new URLSearchParams();
    const merged = { ...filters, tab, ...next };
    if (merged.tab === 'companies') params.set('tab', 'companies');
    if (merged.q.trim()) params.set('q', merged.q.trim());
    if (merged.tagId) params.set('tag', merged.tagId);
    if (merged.ownerUserId) params.set('owner', merged.ownerUserId);
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
  const shown = tab === 'people' ? (people?.items.length ?? 0) : (companies?.items.length ?? 0);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-0.5 border-b border-border">
          {(
            [
              ['people', `People · ${counts.people}`],
              ['companies', `Companies · ${counts.companies}`],
            ] as const
          ).map(([key, label]) => (
            <Link
              key={key}
              href={key === 'people' ? base : `${base}?tab=companies`}
              aria-current={tab === key ? 'page' : undefined}
              data-testid={`customers-tab-${key}`}
              className={cn(
                '-mb-px flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors',
                tab === key
                  ? 'border-accent text-accent-text'
                  : 'border-transparent text-text-2 hover:text-text',
              )}
            >
              {label}
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
            {tab === 'people' ? 'Add person' : 'Add company'}
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Input
          type="search"
          inputSize="sm"
          className="w-full sm:w-[320px]"
          placeholder="Search by name, phone, email or street"
          aria-label="Search customers"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="customers-search"
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
        {tab === 'people' ? (
          <Select
            selectSize="sm"
            className="w-[160px]"
            aria-label="Owner"
            value={filters.ownerUserId}
            onChange={(e) => navigate({ ownerUserId: e.target.value })}
          >
            <option value="">Any owner</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.fullName}
              </option>
            ))}
          </Select>
        ) : null}
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
        />
      ) : (
        <CompaniesTable
          workspaceId={workspaceId}
          filters={filters}
          initial={companies!}
          onAdd={() => setAdding(true)}
          canImport={canImport}
        />
      )}

      {tab === 'people' ? (
        <PersonDialog
          workspaceId={workspaceId}
          tags={tags}
          open={adding}
          onOpenChange={setAdding}
        />
      ) : (
        <CompanyDialog
          workspaceId={workspaceId}
          tags={tags}
          open={adding}
          onOpenChange={setAdding}
        />
      )}
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
  noun: string,
  onAdd: () => void,
  canImport: boolean,
  workspaceId: string,
) {
  const filtered = filters.q || filters.tagId || filters.ownerUserId;
  return (
    <EmptyState
      title={
        filtered ? `No ${noun} match` : filters.archived ? `No archived ${noun}` : `No ${noun} yet`
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
              Add {noun === 'people' ? 'a person' : 'a company'}
            </Button>
          </>
        )
      }
    >
      {filtered ? 'Try a different search, or add them.' : `Add one, or import a spreadsheet.`}
    </EmptyState>
  );
}

function PeopleTable({
  workspaceId,
  filters,
  initial,
  onAdd,
  canImport,
}: {
  workspaceId: string;
  filters: CustomerFilters;
  initial: PersonList;
  onAdd: () => void;
  canImport: boolean;
}) {
  const key = JSON.stringify({ filters, first: initial.items[0]?.id, n: initial.items.length });
  const more = useMore<PersonSummary>(key, initial.nextCursor);
  const [busy, setBusy] = useState(false);
  const items = [...initial.items, ...more.items];
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
            ownerUserId: filters.ownerUserId || undefined,
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
    <Card className="overflow-hidden">
      <table className="hidden w-full text-sm md:table" data-testid="people-table">
        <thead>
          <tr className="bg-card-2 text-left text-xs font-medium text-text-2">
            <th className="w-[30%] px-4 py-2.5">Person</th>
            <th className="px-3 py-2.5">Contact</th>
            <th className="px-3 py-2.5">Tags</th>
            <th className="px-3 py-2.5">Open leads</th>
            <th className="px-3 py-2.5">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr
              key={p.id}
              className="border-t border-border hover:bg-card-2/60"
              data-testid={`person-row-${p.id}`}
            >
              <td className="px-4 py-2.5">
                <Link
                  href={`/app/w/${workspaceId}/customers/people/${p.id}`}
                  className="flex items-center gap-3"
                >
                  <Avatar name={p.fullName} seed={p.id} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {p.fullName}
                      {p.archivedAt ? (
                        <span className="ml-2 text-xs font-normal text-text-3">(archived)</span>
                      ) : null}
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
    <Card className="overflow-hidden">
      <table className="hidden w-full text-sm md:table" data-testid="companies-table">
        <thead>
          <tr className="bg-card-2 text-left text-xs font-medium text-text-2">
            <th className="w-[32%] px-4 py-2.5">Company</th>
            <th className="px-3 py-2.5">Contact</th>
            <th className="px-3 py-2.5">Tags</th>
            <th className="px-3 py-2.5">People</th>
            <th className="px-3 py-2.5">Open leads</th>
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
                    <span className="truncate font-medium">
                      {c.name}
                      {c.archivedAt ? (
                        <span className="ml-2 text-xs font-normal text-text-3">(archived)</span>
                      ) : null}
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
