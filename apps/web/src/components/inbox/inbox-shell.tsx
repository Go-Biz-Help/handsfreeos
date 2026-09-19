'use client';
import {
  boxLabel,
  CONVERSATION_STATUSES,
  INBOX_BOXES,
  inboxEmptyWords,
  STATUS_LABELS,
  type InboxBoxKey,
} from '@hfos/core';
import { Search, SquarePen } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import {
  useConversationsWithDrafts,
  useTeammateBrief,
  type TeammateBrief,
} from '@/lib/ai-team/use-inbox';
import type { ConversationStatus, ConversationSummary, Role } from '@/lib/api/types';
import { useUnread } from '@/lib/realtime/unread-provider';
import { cn } from '@/lib/utils';
import { TeammateBoxes } from './ai-bits';
import { ConversationRow } from './conversation-row';
import { useInboxList } from './hooks';
import { NewMessageDialog } from './new-message-dialog';

interface InboxContextValue {
  readonly workspaceId: string;
  readonly myUserId: string;
  readonly role: Role;
  readonly members: { id: string; fullName: string }[];
  readonly timezone: string;
  /** Refetch the list after this browser changed a conversation (own changes don't come back live). */
  readonly reloadList: () => void;
  readonly patchRow: (id: string, change: Partial<ConversationSummary>) => void;
  /** The list's filters as a query string, carried on links between conversations. */
  readonly listQuery: string;
  /** The business's AI teammate: null when there isn't one, undefined until known. */
  readonly teammate: TeammateBrief | null | undefined;
}

const InboxContext = createContext<InboxContextValue | null>(null);

export function useInbox(): InboxContextValue {
  const value = useContext(InboxContext);
  if (!value) throw new Error('useInbox is only available inside the inbox');
  return value;
}

/**
 * The inbox frame: the conversation list on the left (the whole screen on a phone) and the open conversation
 * beside it. Filters live in the URL so they survive moving between conversations and reloads.
 */
export function InboxShell({
  workspaceId,
  myUserId,
  role,
  members,
  timezone,
  children,
}: {
  workspaceId: string;
  myUserId: string;
  role: Role;
  members: { id: string; fullName: string }[];
  timezone: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const base = `/app/w/${workspaceId}/inbox`;
  const selectedId = pathname.startsWith(`${base}/`)
    ? (pathname.slice(base.length + 1).split('/')[0] ?? null)
    : null;
  const boxParam = params.get('box') ?? '';
  const statusParam = params.get('status') ?? '';
  const box: InboxBoxKey = (INBOX_BOXES as readonly string[]).includes(boxParam)
    ? (boxParam as InboxBoxKey)
    : 'all';
  const status: ConversationStatus = (CONVERSATION_STATUSES as readonly string[]).includes(
    statusParam,
  )
    ? (statusParam as ConversationStatus)
    : 'open';
  const q = params.get('q') ?? '';
  // Archived is chosen where the statuses are, because that is where somebody looks for a thread they put away —
  // but it is a box, not a status: an archived conversation keeps the status it had.
  const archivedView = statusParam === 'archived';
  const [search, setSearch] = useState(q);
  const [newOpen, setNewOpen] = useState(false);
  // `status` still goes with it: the archived box ignores it server-side, since a thread keeps the status it had.
  const list = useInboxList(workspaceId, {
    box: archivedView ? ('archived' as InboxBoxKey) : box,
    status,
    ...(q ? { q } : {}),
  });
  const { summary } = useUnread();
  const counts = summary?.open ?? { mine: 0, unassigned: 0, all: 0 };
  const waitThreshold = summary?.waitingThresholdMinutes ?? 10;
  const teammate = useTeammateBrief(workspaceId);
  const withDrafts = useConversationsWithDrafts(workspaceId, !!teammate);
  const needsPerson = summary?.needsPerson ?? 0;
  const aiCount = summary?.ai ?? 0;
  // The teammate's boxes: once there's a teammate, or while anything is in them.
  const showBoxes = !!teammate || needsPerson > 0 || aiCount > 0;

  const listQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (box !== 'all') p.set('box', box);
    if (archivedView) p.set('status', 'archived');
    else if (status !== 'open') p.set('status', status);
    if (q) p.set('q', q);
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [box, status, q, archivedView]);

  const setFilter = useCallback(
    (change: Record<string, string | null>) => {
      const p = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(change)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      p.delete('new');
      const s = p.toString();
      router.replace(`${pathname}${s ? `?${s}` : ''}`, { scroll: false });
    },
    [params, pathname, router],
  );

  // Search as you type, a beat after the last key; follow searches started elsewhere (the phone's top bar).
  useEffect(() => {
    if (search.trim() === q) return;
    const timer = setTimeout(() => setFilter({ q: search.trim() || null }), 300);
    return () => clearTimeout(timer);
  }, [search, q, setFilter]);
  const [lastQ, setLastQ] = useState(q);
  if (lastQ !== q) {
    setLastQ(q);
    setSearch(q);
  }

  // "New message" from the phone's top bar arrives as ?new=1.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setNewOpen(true);
    setFilter({});
  }, [params, setFilter]);

  const value = useMemo<InboxContextValue>(
    () => ({
      workspaceId,
      myUserId,
      role,
      members,
      timezone,
      reloadList: list.reload,
      patchRow: list.patch,
      listQuery,
      teammate,
    }),
    [workspaceId, myUserId, role, members, timezone, list.reload, list.patch, listQuery, teammate],
  );
  const empty = inboxEmptyWords(
    archivedView ? 'archived' : box,
    status,
    q,
    teammate?.name ?? 'The AI teammate',
  );

  return (
    <InboxContext.Provider value={value}>
      <div
        className={cn('flex min-h-0 md:h-dvh', selectedId ? 'h-dvh' : 'h-[calc(100dvh-3.5rem)]')}
        data-testid="inbox"
      >
        <section
          aria-label="Conversations"
          className={cn(
            'min-h-0 w-full flex-col border-r border-border bg-card md:flex md:w-[340px] md:flex-none',
            selectedId ? 'hidden' : 'flex',
          )}
        >
          <div className="flex flex-col gap-3 border-b border-border px-3.5 py-3 md:px-4 md:pb-3 md:pt-[18px]">
            <div className="hidden items-center justify-between md:flex">
              <h1 className="text-lg font-semibold tracking-tight">Inbox</h1>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setNewOpen(true)}
                data-testid="inbox-new"
              >
                <SquarePen className="h-3.5 w-3.5" strokeWidth={1.5} />
                New message
              </Button>
            </div>
            <Segmented
              fill
              ariaLabel="Whose conversations"
              className="max-md:[&>button]:h-9"
              value={box}
              onChange={(v) => setFilter({ box: v === 'all' ? null : v })}
              options={[
                { value: 'mine', label: boxLabel('mine', counts.mine), testId: 'box-mine' },
                {
                  value: 'unassigned',
                  label: boxLabel('unassigned', counts.unassigned),
                  testId: 'box-unassigned',
                },
                { value: 'all', label: boxLabel('all', counts.all), testId: 'box-all' },
              ]}
            />
            {showBoxes ? (
              <TeammateBoxes
                box={box}
                name={teammate?.name ?? null}
                needsPerson={needsPerson}
                ai={aiCount}
                onPick={(b) => setFilter({ box: b === 'all' ? null : b })}
              />
            ) : null}
            <div className="hidden gap-2 md:flex">
              <div className="relative flex-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-text-3"
                  strokeWidth={1.5}
                />
                <Input
                  inputSize="sm"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search conversations"
                  aria-label="Search conversations"
                  className="pl-[34px]"
                  data-testid="inbox-search"
                />
              </div>
              <Select
                selectSize="sm"
                className="w-[112px]"
                value={archivedView ? 'archived' : status}
                aria-label="Status"
                data-testid="inbox-status"
                onChange={(e) =>
                  setFilter({ status: e.target.value === 'open' ? null : e.target.value })
                }
              >
                {CONVERSATION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
                <option value="archived">Archived</option>
              </Select>
            </div>
            {q ? (
              <div className="flex items-center justify-between gap-2 text-[13px] text-text-2 md:hidden">
                <span className="truncate">Showing “{q}”</span>
                <button
                  type="button"
                  className="font-medium text-accent-text"
                  onClick={() => setFilter({ q: null })}
                >
                  Clear
                </button>
              </div>
            ) : null}
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto pb-[76px] md:pb-0"
            data-testid="conversation-list"
            aria-busy={list.loading}
          >
            {list.items.length === 0 ? (
              list.loading ? (
                <div className="px-4 py-6 text-center text-[13px] text-text-3">
                  Loading conversations…
                </div>
              ) : list.error ? (
                <EmptyState title="The inbox didn’t load">{list.error}</EmptyState>
              ) : (
                <EmptyState title={empty.title}>{empty.body}</EmptyState>
              )
            ) : (
              list.items.map((c) => (
                <ConversationRow
                  key={c.id}
                  c={c}
                  href={`${base}/${c.id}${listQuery}`}
                  selected={c.id === selectedId}
                  myUserId={myUserId}
                  waitThreshold={waitThreshold}
                  timezone={timezone}
                  onOpen={() => list.patch(c.id, { unreadCount: 0 })}
                  draftWaiting={withDrafts.has(c.id)}
                />
              ))
            )}
            {list.hasMore ? (
              <div className="flex justify-center p-3">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={list.loadingMore}
                  onClick={() => void list.loadMore()}
                >
                  Show more
                </Button>
              </div>
            ) : null}
          </div>
        </section>
        <div
          className={cn('min-w-0 flex-1 flex-col bg-bg md:flex', selectedId ? 'flex' : 'hidden')}
        >
          {children}
        </div>
      </div>
      <NewMessageDialog
        workspaceId={workspaceId}
        open={newOpen}
        onOpenChange={setNewOpen}
        onOpened={(id) => router.push(`${base}/${id}${listQuery}`)}
      />
    </InboxContext.Provider>
  );
}
