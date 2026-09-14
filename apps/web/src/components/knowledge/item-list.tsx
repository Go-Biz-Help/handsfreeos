'use client';
import { BookOpen, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { KnowledgeItem, KnowledgeItemKind, KnowledgeItemList } from '@/lib/api/types';
import { KIND_PLURAL } from '@/lib/knowledge/labels';
import { cn, relativeTime } from '@/lib/utils';
import { ItemStatusBadge, KindChip, Snippet, TagChip } from './chips';
import { ImportFaqs } from './import-faqs';

export interface ItemFilters {
  readonly q: string;
  readonly kind: KnowledgeItemKind | null;
  readonly tag: string | null;
  /** null: drafts and published. */
  readonly status: 'published' | 'draft' | 'archived' | null;
}

type StatusView = 'active' | 'published' | 'draft' | 'archived';

const preview = (body: string) => body.replace(/\s+/g, ' ').trim().slice(0, 160);

/** The knowledge items, newest change first, with search, kind, tag and status filters in the address. */
export function ItemList({
  workspaceId,
  canManage,
  filters,
  page,
  tags,
  snippets,
}: {
  workspaceId: string;
  canManage: boolean;
  filters: ItemFilters;
  page: KnowledgeItemList;
  tags: readonly string[];
  snippets: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}/knowledge`;
  const [q, setQ] = useState(filters.q);
  const [pending, startTransition] = useTransition();
  const [more, setMore] = useState<{ items: KnowledgeItem[]; cursor: string | null }>({
    items: [],
    cursor: page.nextCursor,
  });
  const [loading, setLoading] = useState(false);
  const items = [...page.items, ...more.items];
  const typed = useRef(false);

  function go(next: Partial<ItemFilters>) {
    const f = { ...filters, ...next };
    const sp = new URLSearchParams();
    if (f.q) sp.set('q', f.q);
    if (f.kind) sp.set('kind', f.kind);
    if (f.tag) sp.set('tag', f.tag);
    if (f.status) sp.set('status', f.status);
    const qs = sp.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  // Search as you type, a moment after the last key.
  useEffect(() => {
    if (!typed.current) return;
    const t = setTimeout(() => {
      if (q.trim() !== filters.q) go({ q: q.trim() });
    }, 350);
    return () => clearTimeout(t);
    // Only typing starts a search; a new address remounts the list (it's keyed by its filters).
  }, [q]);

  async function loadMore() {
    if (!more.cursor) return;
    setLoading(true);
    try {
      const next = unwrap(
        await apiBrowser().POST('/v1/queries/knowledge_item.list', {
          body: {
            workspaceId,
            limit: 50,
            cursor: more.cursor,
            ...(filters.q ? { search: filters.q } : {}),
            ...(filters.kind ? { kind: [filters.kind] } : {}),
            ...(filters.tag ? { tags: [filters.tag] } : {}),
            ...(filters.status ? { status: [filters.status] } : {}),
          },
        }),
      );
      setMore((m) => ({ items: [...m.items, ...next.items], cursor: next.nextCursor }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  const statusView: StatusView = filters.status ?? 'active';
  const { counts } = page;
  const kinds: (KnowledgeItemKind | null)[] = [null, 'faq', 'article', 'fact', 'document'];

  return (
    <div data-testid="items-page">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="relative w-full sm:w-[300px]">
          <Search
            className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-3"
            strokeWidth={1.5}
          />
          <Input
            inputSize="sm"
            className="pl-9"
            placeholder="Search FAQs, articles and facts"
            aria-label="Search knowledge"
            value={q}
            data-testid="items-search"
            onChange={(e) => {
              typed.current = true;
              setQ(e.target.value);
            }}
          />
        </div>
        <Segmented<StatusView>
          ariaLabel="Status"
          value={statusView}
          onChange={(v) => go({ status: v === 'active' ? null : v })}
          className="max-w-full overflow-x-auto [scrollbar-width:none]"
          options={[
            {
              value: 'active',
              label: `All · ${counts.draft + counts.published}`,
              testId: 'status-active',
            },
            {
              value: 'published',
              label: `Published · ${counts.published}`,
              testId: 'status-published',
            },
            { value: 'draft', label: `Drafts · ${counts.draft}`, testId: 'status-draft' },
            {
              value: 'archived',
              label: `Archived · ${counts.archived}`,
              testId: 'status-archived',
            },
          ]}
        />
        {canManage ? (
          <span className="flex gap-2 sm:ml-auto">
            <ImportFaqs workspaceId={workspaceId} />
          </span>
        ) : null}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="Kind and tags">
        {kinds.map((k) => (
          <FilterChip
            key={k ?? 'all'}
            on={filters.kind === k}
            onClick={() => go({ kind: k })}
            testId={`kind-${k ?? 'all'}`}
          >
            {k ? KIND_PLURAL[k] : 'All kinds'}
          </FilterChip>
        ))}
        {tags.length ? <span className="mx-1 h-5 w-px bg-border" aria-hidden /> : null}
        {tags.map((t) => (
          <FilterChip
            key={t}
            on={filters.tag === t}
            onClick={() => go({ tag: filters.tag === t ? null : t })}
            testId={`tag-${t}`}
          >
            {t}
          </FilterChip>
        ))}
      </div>

      <Card
        className={cn('overflow-hidden transition-opacity', pending && 'opacity-60')}
        data-testid="items-list"
      >
        {items.map((i) => (
          <Link
            key={i.id}
            href={`${base}/items/${i.id}`}
            data-testid={`item-row-${i.id}`}
            className="flex items-start gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-card-2 md:grid md:grid-cols-[88px_minmax(0,1fr)_96px_84px] md:items-center md:gap-4"
          >
            <KindChip kind={i.kind} className="mt-0.5 md:mt-0" />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[14.5px] font-medium leading-snug md:text-sm">{i.title}</span>
              {filters.q && snippets[i.id] ? (
                <Snippet text={snippets[i.id]!} className="line-clamp-2 text-[13px] text-text-2" />
              ) : i.body.trim() ? (
                <span className="line-clamp-1 text-[13px] text-text-2">{preview(i.body)}</span>
              ) : (
                <span className="text-[13px] italic text-text-3">No text yet</span>
              )}
              {i.tags.length ? (
                <span className="flex flex-wrap gap-1">
                  {i.tags.slice(0, 4).map((t) => (
                    <TagChip key={t}>{t}</TagChip>
                  ))}
                </span>
              ) : null}
            </span>
            <span className="hidden text-xs text-text-3 md:block">
              {i.useCount ? `Used ${i.useCount}×` : 'Not used yet'}
            </span>
            <span className="flex flex-none flex-col items-end gap-1 md:items-start">
              <ItemStatusBadge status={i.status} />
              <span className="text-xs text-text-3">{relativeTime(i.updatedAt)}</span>
            </span>
          </Link>
        ))}
        {!items.length ? (
          <NoItems
            base={base}
            filtered={!!(filters.q || filters.kind || filters.tag || filters.status)}
            canManage={canManage}
          />
        ) : null}
      </Card>
      {more.cursor ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" loading={loading} onClick={() => void loadMore()}>
            Show more
          </Button>
        </div>
      ) : null}
      <p className="mt-3 text-xs text-text-3">
        {canManage
          ? 'Drafts and archived items are never used by the AI. Publish an item to use it.'
          : 'Only owners and admins can change the knowledge base. Open any item to read it.'}
      </p>
    </div>
  );
}

function FilterChip({
  on,
  onClick,
  children,
  testId,
}: {
  on: boolean;
  onClick: () => void;
  children: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-testid={testId}
      className={cn(
        'inline-flex h-7 items-center whitespace-nowrap rounded-full border px-3 text-[12.5px] font-medium transition-colors',
        on
          ? 'border-transparent bg-accent-soft text-accent-text'
          : 'border-border-strong bg-card text-text-2 hover:bg-card-2',
      )}
    >
      {children}
    </button>
  );
}

function NoItems({
  base,
  filtered,
  canManage,
}: {
  base: string;
  filtered: boolean;
  canManage: boolean;
}) {
  if (filtered)
    return (
      <div className="px-6 py-[34px] text-center" data-testid="items-empty">
        <h3 className="text-[15px] font-semibold">Nothing matches</h3>
        <p className="mt-1 text-[13px] text-text-2">Try other words, or clear the filters.</p>
      </div>
    );
  return (
    <div
      className="flex flex-col items-center gap-1.5 px-6 py-10 text-center"
      data-testid="items-empty"
    >
      <span className="mb-1 inline-flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent-text">
        <BookOpen className="h-5 w-5" strokeWidth={1.5} />
      </span>
      <h3 className="text-[15px] font-semibold">Nothing in the knowledge base yet</h3>
      <p className="max-w-[380px] text-[13px] text-text-2">
        Add the questions customers ask most, import them from a spreadsheet, or scan your website
        and accept what it finds.
      </p>
      {canManage ? (
        <div className="mt-2.5 flex flex-wrap justify-center gap-2">
          <ButtonLink href={`${base}/items/new?kind=faq`} variant="primary" size="sm">
            Add an FAQ
          </ButtonLink>
          <ButtonLink href={`${base}/website`} size="sm">
            Scan your website
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}
