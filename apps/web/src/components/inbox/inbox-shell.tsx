'use client';
import {
  BIN_WORDS,
  boxLabel,
  can,
  CONVERSATION_STATUSES,
  INBOX_BOXES,
  INBOX_SHOW_NOTES,
  inboxEmptyWords,
  inboxShowOf,
  inboxShowPick,
  rowName,
  unreadFilterLabel,
  unreadLabel,
  type InboxBoxKey,
  type InboxShowKey,
} from '@hfos/core';
import { Search, SquarePen, Trash2 } from 'lucide-react';
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
import { DeleteDialog } from '@/components/bin/delete-dialog';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import {
  useConversationsWithDrafts,
  useTeammateBrief,
  type TeammateBrief,
} from '@/lib/ai-team/use-inbox';
import type { ConversationStatus, ConversationSummary } from '@/lib/api/types';
import { useUnread } from '@/lib/realtime/unread-provider';
import { cn } from '@/lib/utils';
import { TeammateBoxes } from './ai-bits';
import { ConversationRow } from './conversation-row';
import { useInboxList } from './hooks';
import { NewMessageDialog } from './new-message-dialog';
import { ShowMenu } from './show-menu';

interface InboxContextValue {
  readonly workspaceId: string;
  readonly myUserId: string;
  /** What the business lets them do (0106), as workspace.get gives it. */
  readonly permissions: readonly string[];
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
  permissions,
  members,
  timezone,
  narrowed,
  children,
}: {
  workspaceId: string;
  myUserId: string;
  permissions: readonly string[];
  members: { id: string; fullName: string }[];
  timezone: string;
  /** The business says each person sees their own threads (M17). Changes two words and one default. */
  narrowed: boolean;
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
  // Where a person lands with nothing in the address bar. Someone who sees only their own threads in a business
  // that has narrowed its inbox (everyone who doesn't set up the channels, 0106) lands on them, because that is
  // what they came for; everybody else lands where they always have. Nothing is hidden either way — pressing
  // Everyone still shows them what they may see.
  // The person's own mail (M19) is in the list beside the team's, each thread of theirs marked "Only you", in every
  // box it belongs in: there's no page of its own (Chris, 2026-11-11), so an old `?mail=mine` link shows everything.
  const home: InboxBoxKey = narrowed && !can(permissions, 'channels.manage') ? 'mine' : 'all';
  const box: InboxBoxKey = (INBOX_BOXES as readonly string[]).includes(boxParam)
    ? (boxParam as InboxBoxKey)
    : home;
  const status: ConversationStatus = (CONVERSATION_STATUSES as readonly string[]).includes(
    statusParam,
  )
    ? (statusParam as ConversationStatus)
    : 'open';
  const q = params.get('q') ?? '';
  const unread = params.get('unread') === '1';
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
    ...(unread ? { unread } : {}),
  });
  const { summary } = useUnread();
  const counts = summary?.open ?? { mine: 0, unassigned: 0, all: 0 };
  const waitThreshold = summary?.waitingThresholdMinutes ?? 10;
  const teammate = useTeammateBrief(workspaceId);
  // Deleting for good (records.delete): pick rows, then delete each with every lane it carries, as it shows them.
  const canDelete = can(permissions, 'records.delete');
  const [picking, setPicking] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const picked = list.items.filter((c) => ticked.has(c.id));
  const laneIds = (c: ConversationSummary) => (c.lanes?.length ? c.lanes.map((l) => l.id) : [c.id]);
  const stopPicking = () => {
    setPicking(false);
    setTicked(new Set());
  };
  const tick = (id: string) =>
    setTicked((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const withDrafts = useConversationsWithDrafts(workspaceId, !!teammate);
  const needsPerson = summary?.needsPerson ?? 0;
  const aiCount = summary?.ai ?? 0;
  // The teammate's boxes: once there's a teammate, or while anything is in them.
  const showBoxes = !!teammate || needsPerson > 0 || aiCount > 0;
  const mail = summary?.mail ?? { mine: 0, other: 0, spam: 0, own: false };
  // The badges count open conversations in the three boxes and Other mail; anywhere else the chip has no number.
  const unreadCount =
    status !== 'open' || archivedView
      ? null
      : box === 'mine' || box === 'unassigned' || box === 'all'
        ? (summary?.unread[box] ?? null)
        : box === 'other'
          ? mail.other
          : null;
  // What the Show menu is on, and picking another: a status keeps the box, Archived, Other mail and Spam are boxes
  // of their own (Archived rides on `status`, where it always has).
  const show: InboxShowKey = archivedView ? 'archived' : inboxShowOf(box, status);

  const listQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (box !== 'all') p.set('box', box);
    if (archivedView) p.set('status', 'archived');
    else if (status !== 'open') p.set('status', status);
    if (q) p.set('q', q);
    if (unread) p.set('unread', '1');
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [box, status, q, archivedView, unread]);

  const setFilter = useCallback(
    (change: Record<string, string | null>) => {
      const p = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(change)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      p.delete('new');
      p.delete('mail');
      const s = p.toString();
      router.replace(`${pathname}${s ? `?${s}` : ''}`, { scroll: false });
    },
    [params, pathname, router],
  );
  const pickShow = (key: InboxShowKey) => {
    const next = inboxShowPick(key, archivedView ? 'archived' : box, home);
    if (next.box === 'archived') setFilter({ status: 'archived', box: null });
    else
      setFilter({
        box: next.box === home ? null : next.box,
        status: next.status === 'open' ? null : next.status,
      });
  };

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
      permissions,
      members,
      timezone,
      reloadList: list.reload,
      patchRow: list.patch,
      listQuery,
      teammate,
    }),
    [
      workspaceId,
      myUserId,
      permissions,
      members,
      timezone,
      list.reload,
      list.patch,
      listQuery,
      teammate,
    ],
  );
  const empty = inboxEmptyWords(
    archivedView ? 'archived' : box,
    status,
    q,
    teammate?.name ?? 'The AI teammate',
    unread,
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
              onChange={(v) => setFilter({ box: v === home ? null : v })}
              options={[
                { value: 'mine', label: boxLabel('mine', counts.mine), testId: 'box-mine' },
                {
                  value: 'unassigned',
                  label: boxLabel('unassigned', counts.unassigned),
                  testId: 'box-unassigned',
                },
                {
                  value: 'all',
                  label: boxLabel('all', counts.all, narrowed),
                  testId: 'box-all',
                },
              ]}
            />
            {showBoxes ? (
              <TeammateBoxes
                box={box}
                name={teammate?.name ?? null}
                needsPerson={needsPerson}
                ai={aiCount}
                onPick={(b) => setFilter({ box: b === home ? null : b })}
              />
            ) : null}
            {/* Unread and Select on top, the search and the Show menu under them. At phone width the search is in the
                top bar, so the Show menu moves up beside Unread. */}
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-3">
              <UnreadToggle
                on={unread}
                count={unreadCount}
                onToggle={() => setFilter({ unread: unread ? null : '1' })}
                className="col-start-1 row-start-1"
              />
              <ShowMenu
                value={show}
                counts={{ other: mail.other, spam: mail.spam }}
                onPick={pickShow}
                className="col-start-2 row-start-1 justify-self-start md:col-start-3 md:row-start-2"
              />
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={picking}
                  onClick={() => (picking ? stopPicking() : setPicking(true))}
                  className="col-start-3 row-start-1 justify-self-end"
                  data-testid="inbox-pick"
                >
                  {picking ? 'Done' : 'Select'}
                </Button>
              ) : null}
              <div className="relative col-span-2 col-start-1 row-start-2 hidden md:block">
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
          {show === 'other' || show === 'spam' ? (
            <div
              className="flex items-start gap-2.5 border-b border-border bg-card-2 px-3.5 py-2.5 md:px-4"
              data-testid="inbox-show-note"
            >
              <p className="min-w-0 flex-1 text-[12.5px] leading-[1.45] text-text-2">
                {INBOX_SHOW_NOTES[show]}
              </p>
              <button
                type="button"
                className="flex-none pt-px text-[12.5px] font-semibold text-accent-text hover:underline"
                onClick={() => pickShow('open')}
                data-testid="inbox-show-back"
              >
                {INBOX_SHOW_NOTES.back}
              </button>
            </div>
          ) : null}
          <div
            className="min-h-0 flex-1 overflow-y-auto pb-[76px] md:pb-0"
            data-testid="conversation-list"
            aria-busy={list.loading}
          >
            {picking ? (
              <div
                className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-3.5 py-2 text-[13px] md:px-4"
                data-testid="inbox-picked"
              >
                <span className="font-medium">{picked.length} selected</span>
                <span className="flex-1" />
                <Button
                  variant="secondary"
                  size="sm"
                  className="text-danger-text hover:text-danger-text"
                  disabled={picked.length === 0}
                  onClick={() => setDeleting(true)}
                  data-testid="inbox-delete"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {BIN_WORDS.menu}
                </Button>
              </div>
            ) : null}
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
                  pick={picking ? { on: ticked.has(c.id), toggle: () => tick(c.id) } : undefined}
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
      {canDelete ? (
        <DeleteDialog
          workspaceId={workspaceId}
          kind="conversation"
          ids={picked.flatMap(laneIds)}
          names={picked.flatMap((c) => laneIds(c).map(() => rowName(c)))}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={(ids) => {
            stopPicking();
            list.reload();
            // The open one went too: back to the list.
            if (selectedId && ids.includes(selectedId)) router.push(`${base}${listQuery}`);
          }}
        />
      ) : null}
    </InboxContext.Provider>
  );
}

/**
 * "Unread": narrows whichever box and status is showing to the customers with something unread, so a thread marked
 * unread months down the list is one click away rather than hundreds of rows.
 */
function UnreadToggle({
  on,
  count,
  onToggle,
  className,
}: {
  on: boolean;
  /** Null where the badges have no count for the list showing. */
  count: number | null;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex', className)}>
      <button
        type="button"
        aria-pressed={on}
        onClick={onToggle}
        data-testid="filter-unread"
        aria-label={unreadFilterLabel(count)}
        className={cn(
          'flex h-8 items-center gap-[7px] whitespace-nowrap rounded-control border pl-2.5 pr-2 text-[13px] font-medium transition-colors max-md:h-9',
          on
            ? 'border-accent bg-accent-soft text-accent-text'
            : 'border-border bg-card text-text-2 hover:text-text',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'h-2 w-2 flex-none rounded-full',
            on || count ? 'bg-accent' : 'bg-border-strong',
          )}
        />
        Unread
        {count ? (
          <span
            aria-hidden
            data-testid="filter-unread-count"
            className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-[5px] text-[11px] font-semibold leading-none text-white"
          >
            {unreadLabel(count)}
          </span>
        ) : null}
      </button>
    </div>
  );
}
