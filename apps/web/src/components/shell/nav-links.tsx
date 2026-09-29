'use client';
import * as Popover from '@radix-ui/react-popover';
import {
  ADDON_CATALOG,
  MENU_KEYS,
  can,
  addonMenuPlace,
  addonMenuPlaces,
  currentMenuPlace,
  inMenuPlace,
  isMenuKey,
  menuFor,
  menuKeys,
  type AddonMenuKey,
  type MenuAddons,
  type MenuGroup,
  type MenuKey,
  type MenuPlaceKey,
} from '@hfos/core';
import {
  Blocks,
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
  Lightbulb,
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
import { usePathname, useRouter } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ADDON_UI } from '@/addons/registry';
import { NewDot, useWhatsNewUnseen } from '@/components/ideas/whats-new-signal';
import { useAttentionSummary } from '@/lib/realtime/attention-summary';
import { useUnread } from '@/lib/realtime/unread-provider';
import { useMatches } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { useMenu } from './menu-provider';

export interface NavItem<K extends MenuPlaceKey | FootKey = MenuPlaceKey> {
  readonly key: K;
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
  // Contacts moved to the drawer on phones when the calendar joined the bottom bar (search still finds them).
  // Its address and key are still `customers`, so saved menus and links keep working.
  customers: { path: '/customers', label: 'Contacts', icon: Users },
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

/**
 * The places about HandsFreeOS itself rather than the business (the owner's decision, 2026-09-28): Add-ons, for the
 * owners and admins who manage them, and Ideas. They sit at the foot of the sidebar and the drawer, above Get help,
 * where nobody arranges them; the menu (core's `MENU_KEYS`) never holds them.
 */
export type FootKey = 'add-ons' | 'ideas';

/** The foot's places open to this person, top to bottom. */
export function footItems(
  workspaceId: string,
  permissions?: readonly string[] | null,
): NavItem<FootKey>[] {
  const items: NavItem<FootKey>[] = [];
  if (can(permissions ?? [], 'addons.manage'))
    items.push({
      key: 'add-ons',
      href: `/app/w/${workspaceId}/add-ons`,
      label: 'Add-ons',
      icon: Blocks,
    });
  items.push({
    key: 'ideas',
    href: `/app/w/${workspaceId}/ideas`,
    label: 'Ideas',
    icon: Lightbulb,
  });
  return items;
}

/** One place, by key. */
export function navItemOf(workspaceId: string, key: MenuKey): NavItem {
  const { path, ...rest } = PLACES[key];
  return { key, href: `/app/w/${workspaceId}${path}`, ...rest };
}

/** Every place, in the order a new account sees them: the phone's bottom bar and its titles read this. */
export function navItems(workspaceId: string): NavItem[] {
  return MENU_KEYS.map((key) => navItemOf(workspaceId, key));
}

/** Where an add-on's page lives (0108): `/app/w/<business>/a/<add-on>/<path>`, '' being its first page. */
export function addonHref(workspaceId: string, addonId: string, path = ''): string {
  const rest = path.replace(/^\/+|\/+$/g, '');
  return `/app/w/${workspaceId}/a/${addonId}${rest ? `/${rest}` : ''}`;
}

/** The add-ons running in a business, as the menu reads them: their manifests come from the catalogue. */
export const menuAddons = (running: readonly string[] | undefined): MenuAddons => ({
  running: running ?? [],
  catalog: ADDON_CATALOG,
});

/**
 * One of an add-on's places (0108): its words from the add-on's manifest, its icon from the web's registry of
 * add-ons (addons/registry.ts) or a generic one, its address under the add-on's pages. Null for a place no add-on
 * in the catalogue has any more.
 */
function addonNavItem(workspaceId: string, key: AddonMenuKey): NavItem | null {
  const place = addonMenuPlace(ADDON_CATALOG, key);
  if (!place) return null;
  const ui = ADDON_UI[place.addon.id];
  return {
    key,
    href: addonHref(workspaceId, place.addon.id, place.nav.path),
    label: place.nav.label,
    icon: ui?.navIcons?.[place.nav.key] ?? ui?.icon ?? Blocks,
  };
}

/** Any place, by key: one of core's, or an add-on's (null for an add-on the catalogue no longer has). */
export function placeItemOf(workspaceId: string, key: MenuPlaceKey): NavItem | null {
  return isMenuKey(key) ? navItemOf(workspaceId, key) : addonNavItem(workspaceId, key);
}

/**
 * The places of the add-ons running here that this person may open, whether their menu shows them or not: like
 * core's, a place taken out of the menu still titles its own pages on the phone.
 */
export function addonNavItems(
  workspaceId: string,
  permissions: readonly string[] | null | undefined,
  addons: MenuAddons,
): NavItem[] {
  return addonMenuPlaces(permissions, addons).flatMap((key) => {
    const item = addonNavItem(workspaceId, key);
    return item ? [item] : [];
  });
}

/**
 * Whether the page open now is in this place: its own address or a page under it, by whole segments, so
 * `/forms-pro` never lights up Forms (FE-2). Home is lit on its own address only.
 */
export function isActive(item: NavItem, pathname: string): boolean {
  return inMenuPlace(pathname, item.href, item.exact);
}

/**
 * The count on the Inbox item: open conversations with something unread.
 *
 * With `href`, pressing the count itself goes there (the inbox with only the unread ones showing), while the rest of
 * the row still opens the whole inbox: the count is what someone is looking at when they wonder what it means, and
 * a thread marked unread months ago can sit hundreds of rows down. It is a press on part of the row rather than a
 * link of its own, because a link inside a link is not one a browser keeps; the keyboard has the inbox's own Unread
 * filter.
 */
export function UnreadCount({
  count,
  className,
  href,
  onNavigate,
}: {
  count: number;
  className?: string;
  href?: string;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  if (count <= 0) return null;
  const jump = href
    ? (e: MouseEvent) => {
        // A new tab or window is the row's to open, as it always was.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        // Inside the Inbox link or a group's row: this press is the count's, not theirs.
        e.preventDefault();
        e.stopPropagation();
        onNavigate?.();
        router.push(href);
      }
    : undefined;
  return (
    <span
      data-testid="unread-badge"
      onClick={jump}
      title={href ? 'Show unread' : undefined}
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-none text-white',
        href && 'cursor-pointer transition-shadow hover:ring-2 hover:ring-accent-soft-2',
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
  item: NavItem<MenuPlaceKey | FootKey>;
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
      // Where the tour points (components/onboarding/tour.tsx).
      data-tour={item.key}
      className={rowClass(active, className)}
    >
      <Icon className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
      <span className="min-w-0 truncate">{item.label}</span>
      {badge}
    </Link>
  );
}

/** What a group draws its places from: each place's item, and the one the open page is in. */
interface GroupProps {
  group: MenuGroup;
  items: ReadonlyMap<MenuPlaceKey, NavItem>;
  activeKey: MenuPlaceKey | null;
  badges: (key: MenuPlaceKey, onNavigate?: () => void) => ReactNode;
  onNavigate?: () => void;
}

/**
 * A group in the sidebar: the places inside it come up beside the menu on hover or a press, so a menu people
 * rarely go into takes one row instead of seven. Hovering never steals the keyboard's place; a press, and the
 * arrow keys after it, move into the flyout as usual.
 */
function GroupFlyout({ group, items, activeKey, badges, onNavigate }: GroupProps) {
  const hoverable = useMatches('(hover: hover) and (pointer: fine)');
  const [open, setOpen] = useState(false);
  /** Open because the pointer is resting on it, rather than because someone asked for it. */
  const byHover = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A group is lit by what is inside it.
  const active = activeKey !== null && group.keys.includes(activeKey);

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
  /** Somewhere was picked: the flyout goes, and so does the drawer it may sit in. */
  const close = () => {
    setOpen(false);
    onNavigate?.();
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
          {group.keys.map((k) => badges(k, close))}
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
            const item = items.get(key);
            return item ? (
              <NavLink
                key={key}
                item={item}
                active={key === activeKey}
                badge={<span className="ml-auto">{badges(key, close)}</span>}
                onNavigate={close}
              />
            ) : null;
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The same group in the phone's drawer, where a flyout has nowhere to go: it opens in place. */
function GroupAccordion({ group, items, activeKey, badges, onNavigate }: GroupProps) {
  const active = activeKey !== null && group.keys.includes(activeKey);
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
            const item = items.get(key);
            return item ? (
              <NavLink
                key={key}
                item={item}
                active={key === activeKey}
                onNavigate={onNavigate}
                badge={<span className="ml-auto">{badges(key)}</span>}
              />
            ) : null;
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
 *
 * The add-ons running in the business add their places (0108), and only while they run: one that is turned off
 * leaves no link behind, and comes back where the person had it when it's turned on again.
 */
export function NavLinks({
  workspaceId,
  permissions,
  addons,
  variant = 'sidebar',
  onNavigate,
}: {
  workspaceId: string;
  /** What the business lets them do (0106): a place they may not open isn't offered. */
  permissions?: readonly string[] | null;
  /** The add-ons running in the business (0108). */
  addons?: readonly string[];
  variant?: 'sidebar' | 'drawer';
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const menu = menuFor(useMenu().menu, permissions, menuAddons(addons));
  const items = new Map<MenuPlaceKey, NavItem>();
  for (const key of menuKeys(menu)) {
    const item = placeItemOf(workspaceId, key);
    if (item) items.set(key, item);
  }
  // One place is lit: the one the open page is in, the deepest when an add-on's places nest.
  const activeKey = currentMenuPlace([...items.values()], pathname)?.key ?? null;
  const unread = useUnread().summary?.unread.all ?? 0;
  const urgent = useAttentionSummary().summary?.urgent ?? 0;
  const badges = (key: MenuPlaceKey, after = onNavigate): ReactNode => {
    if (key === 'home') return <UrgentCount key="u" count={urgent} />;
    if (key === 'inbox')
      return (
        <UnreadCount
          key="n"
          count={unread}
          // "All" (or "Everyone"), because that is what the count counts: a member whose inbox opens on Mine would
          // otherwise land on a list without the thread the badge is about.
          href={`${navItemOf(workspaceId, 'inbox').href}?box=all&unread=1`}
          onNavigate={after}
        />
      );
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
              items={items}
              activeKey={activeKey}
              badges={badges}
              onNavigate={onNavigate}
            />
          );
        }
        const item = items.get(entry.key);
        return item ? (
          <NavLink
            key={entry.key}
            item={item}
            active={entry.key === activeKey}
            onNavigate={onNavigate}
            badge={<span className="ml-auto">{badges(entry.key)}</span>}
          />
        ) : null;
      })}
    </nav>
  );
}

/**
 * The foot of the sidebar and the drawer, above Get help: Add-ons (for whoever manages them) and Ideas, with a dot
 * when What's new has something the person hasn't read. Not part of the menu a person arranges.
 */
export function FootLinks({
  workspaceId,
  permissions,
  onNavigate,
}: {
  workspaceId: string;
  permissions?: readonly string[] | null;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const whatsNew = useWhatsNewUnseen();
  const items = footItems(workspaceId, permissions);
  const activeKey = currentMenuPlace(items, pathname)?.key ?? null;
  return (
    <nav className="flex flex-col gap-0.5" aria-label="HandsFreeOS" data-testid="sidebar-foot">
      {items.map((item) => (
        <NavLink
          key={item.key}
          item={item}
          active={item.key === activeKey}
          onNavigate={onNavigate}
          badge={
            item.key === 'ideas' ? (
              <span className="ml-auto">
                <NewDot count={whatsNew} />
              </span>
            ) : null
          }
        />
      ))}
    </nav>
  );
}
