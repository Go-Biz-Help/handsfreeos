'use client';
import * as Popover from '@radix-ui/react-popover';
import { MENU_KEYS, menuFor, type MenuGroup, type MenuKey } from '@hfos/core';
import {
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Home,
  Inbox,
  KanbanSquare,
  Layers,
  ListOrdered,
  Megaphone,
  Settings2,
  Sparkles,
  UserCircle,
  Users,
  Workflow,
  Star,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useAttentionSummary } from '@/lib/realtime/attention-summary';
import { useUnread } from '@/lib/realtime/unread-provider';
import { useMatches } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { useMenu } from './menu-provider';

export interface NavItem {
  readonly key: MenuKey;
  readonly href: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly exact?: boolean;
  /** Shown in the phone bottom bar. */
  readonly primary?: boolean;
}

type Place = Omit<NavItem, 'key' | 'href'> & { readonly path: string };

/**
 * What each place in the menu is called, what it looks like and where it lives. Keyed by core's list, so a new
 * place cannot ship without words and an icon — and a person's saved menu (core's `menuOf`) puts it where it
 * belongs on its own.
 *
 * The comments say why a place is not in the phone's bottom bar: the bar stays at five, and everything else is
 * one press away under More.
 */
const PLACES: Record<MenuKey, Place> = {
  home: { path: '', label: 'Home', icon: Home, exact: true, primary: true },
  inbox: { path: '/inbox', label: 'Inbox', icon: Inbox, primary: true },
  // The call log sits next to the inbox rather than inside it: a thread shows a call where it happened, which
  // is no use when the question is "who rang this morning". A drawer item on phones, so the bar stays at five.
  // Customers moved to the drawer on phones when the calendar joined the bottom bar (search still finds them).
  customers: { path: '/customers', label: 'Customers', icon: Users },
  pipeline: { path: '/pipeline', label: 'Pipeline', icon: KanbanSquare, primary: true },
  calendar: { path: '/calendar', label: 'Calendar', icon: CalendarDays, primary: true },
  // Money is a drawer item on phones too, so the bottom bar stays at five.
  money: { path: '/money', label: 'Money', icon: CircleDollarSign },
  // Workflows is a drawer item on phones, so the bottom bar stays at five.
  workflows: { path: '/workflows', label: 'Workflows', icon: Workflow },
  // Outreach campaigns (Automations, stage 5): a drawer item on phones too.
  campaigns: { path: '/campaigns', label: 'Campaigns', icon: Megaphone },
  // Forms is a drawer item on phones, so the bottom bar stays at five.
  forms: { path: '/forms', label: 'Forms', icon: ClipboardList },
  // Reviews is a drawer item on phones too. It sits after Forms because both are about what the outside
  // world says to you rather than what you do about it.
  reviews: { path: '/reviews', label: 'Reviews', icon: Star },
  // Knowledge is a drawer item on phones too.
  knowledge: { path: '/knowledge', label: 'Knowledge', icon: BookOpen },
  // The AI teammate is a drawer item on phones as well. Everyone sees it; ai_team.manage changes it.
  'ai-team': { path: '/ai-team', label: 'AI teammate', icon: Sparkles },
  // Tasks moved to the drawer on phones when the inbox joined the bottom bar.
  tasks: { path: '/tasks', label: 'Tasks', icon: ClipboardList },
  members: { path: '/members', label: 'Members', icon: UserCircle },
  audit: { path: '/audit', label: 'Audit log', icon: ListOrdered },
  settings: { path: '/settings', label: 'Settings', icon: Settings2 },
};

/** One place, by key. */
export function navItemOf(workspaceId: string, key: MenuKey): NavItem {
  const { path, ...rest } = PLACES[key];
  return { key, href: `/app/w/${workspaceId}${path}`, ...rest };
}

/** Every place, in the order a new account sees them: the phone's bottom bar and its titles read this. */
export function navItems(workspaceId: string): NavItem[] {
  return MENU_KEYS.map((key) => navItemOf(workspaceId, key));
}

export function isActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}

/** Whether the page open now is one of these places (a group is lit by what is inside it). */
function anyActive(workspaceId: string, keys: readonly MenuKey[], pathname: string): boolean {
  return keys.some((k) => isActive(navItemOf(workspaceId, k), pathname));
}

/** The count on the Inbox item: open conversations with something unread. */
export function UnreadCount({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="unread-badge"
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-none text-white',
        className,
      )}
    >
      <span aria-hidden>{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{count} unread</span>
    </span>
  );
}

/** The count on Home: items that turned urgent, in the viewer's own scope (the Action Center's summary). */
export function UrgentCount({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="urgent-badge"
      title={`${count} urgent`}
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-semibold leading-none text-on-solid',
        className,
      )}
    >
      <span aria-hidden>{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{count} urgent</span>
    </span>
  );
}

const rowClass = (active: boolean, extra?: string) =>
  cn(
    'flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:h-9 max-md:h-11',
    active ? 'bg-accent-soft text-accent-text' : 'text-text-2 hover:bg-card-2 hover:text-text',
    extra,
  );

function NavLink({
  item,
  active,
  onNavigate,
  badge,
  className,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
  badge?: ReactNode;
  className?: string;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={rowClass(active, className)}
    >
      <Icon className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
      <span className="min-w-0 truncate">{item.label}</span>
      {badge}
    </Link>
  );
}

/**
 * A group in the sidebar: the places inside it come up beside the menu on hover or a press, so a menu people
 * rarely go into takes one row instead of seven. Hovering never steals the keyboard's place; a press, and the
 * arrow keys after it, move into the flyout as usual.
 */
function GroupFlyout({
  group,
  workspaceId,
  pathname,
  badges,
  onNavigate,
}: {
  group: MenuGroup;
  workspaceId: string;
  pathname: string;
  badges: (key: MenuKey) => ReactNode;
  onNavigate?: () => void;
}) {
  const hoverable = useMatches('(hover: hover) and (pointer: fine)');
  const [open, setOpen] = useState(false);
  /** Open because the pointer is resting on it, rather than because someone asked for it. */
  const byHover = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = anyActive(workspaceId, group.keys, pathname);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const show = () => {
    if (!hoverable) return;
    stop();
    byHover.current = true;
    setOpen(true);
  };
  // A moment's grace, so crossing the gap between the row and the flyout doesn't shut it.
  const hideSoon = () => {
    if (!hoverable) return;
    stop();
    timer.current = setTimeout(() => setOpen(false), 160);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        stop();
        if (!next) byHover.current = false;
        setOpen(next);
      }}
    >
      <Popover.Trigger
        data-testid={`menu-group-${group.id}`}
        onClick={(e) => {
          // A press decides, not Radix's own toggle (preventDefault stands it down): pressing a flyout the
          // pointer has already opened pins it open, so it doesn't shut under the very press that asked for it.
          e.preventDefault();
          stop();
          const pinned = open && !byHover.current;
          byHover.current = false;
          setOpen(!pinned);
        }}
        onPointerEnter={show}
        onPointerLeave={hideSoon}
        className={rowClass(active)}
      >
        <Layers className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
        <span className="min-w-0 truncate">{group.label}</span>
        <span className="ml-auto flex items-center gap-1">
          {group.keys.map((k) => badges(k))}
          <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            // Opened by the pointer alone: leave the keyboard where it was.
            if (byHover.current) e.preventDefault();
          }}
          onPointerEnter={stop}
          onPointerLeave={hideSoon}
          data-testid={`menu-group-panel-${group.id}`}
          className="z-40 flex max-h-[70vh] w-[220px] flex-col gap-0.5 overflow-y-auto rounded-menu border border-border bg-card p-1.5 shadow-2"
        >
          <p className="px-2.5 pb-1 pt-1 text-xs font-medium text-text-3">{group.label}</p>
          {group.keys.map((key) => {
            const item = navItemOf(workspaceId, key);
            return (
              <NavLink
                key={key}
                item={item}
                active={isActive(item, pathname)}
                badge={<span className="ml-auto">{badges(key)}</span>}
                onNavigate={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
              />
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The same group in the phone's drawer, where a flyout has nowhere to go: it opens in place. */
function GroupAccordion({
  group,
  workspaceId,
  pathname,
  badges,
  onNavigate,
}: {
  group: MenuGroup;
  workspaceId: string;
  pathname: string;
  badges: (key: MenuKey) => ReactNode;
  onNavigate?: () => void;
}) {
  const active = anyActive(workspaceId, group.keys, pathname);
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  return (
    <>
      <button
        type="button"
        data-testid={`menu-group-${group.id}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={rowClass(active)}
      >
        <Layers className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
        <span className="min-w-0 truncate">{group.label}</span>
        <span className="ml-auto flex items-center gap-1">
          {open ? null : group.keys.map((k) => badges(k))}
          {open ? (
            <ChevronDown className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
          )}
        </span>
      </button>
      {open ? (
        <div
          className="flex flex-col gap-0.5 border-l border-border pl-2 ml-[19px]"
          data-testid={`menu-group-panel-${group.id}`}
        >
          {group.keys.map((key) => {
            const item = navItemOf(workspaceId, key);
            return (
              <NavLink
                key={key}
                item={item}
                active={isActive(item, pathname)}
                onNavigate={onNavigate}
                badge={<span className="ml-auto">{badges(key)}</span>}
              />
            );
          })}
        </div>
      ) : null}
    </>
  );
}

/**
 * The workspace menu, as this person arranged it: places one under the other, and groups that open beside the
 * sidebar or in place in the drawer. The list scrolls on its own, so a long menu never pushes the account away
 * from the bottom of the sidebar.
 *
 * Arranging it is Settings → Side menu (components/settings/menu-section.tsx). The menu is places to go, and
 * nothing else: a row for editing it would be one more thing to read past, every day, for something done once.
 */
export function NavLinks({
  workspaceId,
  permissions,
  variant = 'sidebar',
  onNavigate,
}: {
  workspaceId: string;
  /** What the business lets them do (0105): a place they may not open isn't offered. */
  permissions?: readonly string[] | null;
  variant?: 'sidebar' | 'drawer';
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const menu = menuFor(useMenu().menu, permissions);
  const unread = useUnread().summary?.unread.all ?? 0;
  const urgent = useAttentionSummary().summary?.urgent ?? 0;
  const badges = (key: MenuKey): ReactNode => {
    if (key === 'home') return <UrgentCount key="u" count={urgent} />;
    if (key === 'inbox') return <UnreadCount key="n" count={unread} />;
    return null;
  };
  const Group = variant === 'drawer' ? GroupAccordion : GroupFlyout;
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Workspace">
      {menu.entries.map((entry) => {
        if (entry.kind === 'group') {
          return (
            <Group
              key={entry.id}
              group={entry}
              workspaceId={workspaceId}
              pathname={pathname}
              badges={badges}
              onNavigate={onNavigate}
            />
          );
        }
        const item = navItemOf(workspaceId, entry.key);
        return (
          <NavLink
            key={entry.key}
            item={item}
            active={isActive(item, pathname)}
            onNavigate={onNavigate}
            badge={<span className="ml-auto">{badges(entry.key)}</span>}
          />
        );
      })}
    </nav>
  );
}
