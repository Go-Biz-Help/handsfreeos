'use client';
import * as Popover from '@radix-ui/react-popover';
import {
  ADDON_CATALOG,
  MENU_KEYS,
  can,
  addonMenuPages,
  addonOfMenuKey,
  addonPageKey,
  currentMenuPlace,
  inMenuPlace,
  isMenuKey,
  menuFor,
  menuKeys,
  type AddonManifest,
  type AddonMenuKey,
  type AddonPageKey,
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
  FilePenLine,
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
import { catchError } from 'next/error';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ADDON_UI } from '@/addons/registry';
import { lazyOnce } from '@/components/addons/lazy';
import { NewDot, useWhatsNewUnseen } from '@/components/ideas/whats-new-signal';
import { useAttentionSummary } from '@/lib/realtime/attention-summary';
import { useUnread } from '@/lib/realtime/unread-provider';
import { useMatches } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { useMenu } from './menu-provider';

type NavIcon = ComponentType<{ className?: string; strokeWidth?: number }>;

export interface NavItem<K extends string = MenuPlaceKey> {
  readonly key: K;
  readonly href: string;
  readonly label: string;
  readonly icon: NavIcon;
  readonly exact?: boolean;
  /** Shown in the phone bottom bar. */
  readonly primary?: boolean;
  /**
   * An add-on's pages, when this person may open more than one of them (0108): the add-on is one row in the menu,
   * `href` is where all its pages live, and these open from it, as a group's places do.
   */
  readonly pages?: readonly NavItem<AddonPageKey>[];
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
  // Documents to sign sit next to Forms (docs/documents.md): a drawer item on phones too.
  documents: { path: '/documents', label: 'Documents', icon: FilePenLine },
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
 * The pages of one add-on this person may open (0108), in its manifest's order: their words from the manifest, their
 * icons from the web's registry of add-ons (addons/registry.ts) or a generic one, their addresses under its pages.
 */
function addonPages(
  workspaceId: string,
  addon: AddonManifest,
  permissions: readonly string[] | null | undefined,
): NavItem<AddonPageKey>[] {
  const ui = ADDON_UI[addon.id];
  return addonMenuPages(addon, permissions).map((nav) => ({
    key: addonPageKey(addon.id, nav.key),
    href: addonHref(workspaceId, addon.id, nav.path),
    label: nav.label,
    icon: ui?.navIcons?.[nav.key] ?? ui?.icon ?? Blocks,
  }));
}

/**
 * An add-on's one row in the menu (0108; the owner's decision, 2026-10-09): its name and its icon. With one page
 * open to this person it goes straight there; with more, they open from it (`pages`), so however many add-ons a
 * business turns on, each is a single row. Null for an add-on the catalogue no longer has, or one with nothing
 * this person may open.
 */
function addonNavItem(
  workspaceId: string,
  key: AddonMenuKey,
  permissions: readonly string[] | null | undefined,
): NavItem | null {
  const addon = addonOfMenuKey(ADDON_CATALOG, key);
  if (!addon) return null;
  const pages = addonPages(workspaceId, addon, permissions);
  const item = { key, label: addon.name, icon: ADDON_UI[addon.id]?.icon ?? Blocks };
  if (pages.length > 1) return { ...item, href: addonHref(workspaceId, addon.id), pages };
  return pages[0] ? { ...item, href: pages[0].href } : null;
}

/**
 * Any place, by key: one of core's, or an add-on (null for one the catalogue no longer has, or that this person may
 * open nothing of: what it shows depends on their permissions).
 */
export function placeItemOf(
  workspaceId: string,
  key: MenuPlaceKey,
  permissions?: readonly string[] | null,
): NavItem | null {
  return isMenuKey(key) ? navItemOf(workspaceId, key) : addonNavItem(workspaceId, key, permissions);
}

/**
 * The pages of the add-ons running here that this person may open, whether their menu shows the add-on or not:
 * like core's places, a page of one taken out of the menu still titles itself on the phone.
 */
export function addonPageItems(
  workspaceId: string,
  permissions: readonly string[] | null | undefined,
  addons: MenuAddons,
): NavItem<AddonPageKey>[] {
  return addons.catalog.flatMap((addon) =>
    addons.running.includes(addon.id) ? addonPages(workspaceId, addon, permissions) : [],
  );
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

/**
 * A count on an add-on's page in the menu, or on its row (the registry's `navCount`): drawn by the add-on's own code,
 * with the words a screen reader says for it. Nothing when there's nothing to count.
 */
export function MenuCount({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="addon-menu-count"
      className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-none text-white"
    >
      <span aria-hidden>{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A count whose code is slow or broke: nothing in its place, as the menu has nowhere to say so. */
const QuietBoundary = catchError(() => null);

/**
 * An add-on's count (the registry's `navCount`): on the page it counts, and on the add-on's row while its pages are
 * closed. Its code is fetched the first time the menu draws it, only while the add-on runs here.
 */
function AddonCount({ workspaceId, addonId }: { workspaceId: string; addonId: string }) {
  const load = ADDON_UI[addonId]?.navCount?.load;
  if (!load) return null;
  const Count = lazyOnce(load);
  return (
    <QuietBoundary>
      <Suspense fallback={null}>
        <Count workspaceId={workspaceId} />
      </Suspense>
    </QuietBoundary>
  );
}

/** Whether an add-on's page is the one its count is on. */
const countedPage = (addonId: string, pageKey: string) => {
  const page = ADDON_UI[addonId]?.navCount?.page;
  return page !== undefined && pageKey === addonPageKey(addonId, page);
};

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
  item: NavItem<string>;
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

/**
 * One row that places open from: a group the person made, or an add-on and its pages (0108). Beside the sidebar
 * they come up in a flyout (`Flyout`); in the phone's drawer, where a flyout has nowhere to go, in place (`Fold`).
 */
interface OpenerProps {
  /** How tests find the row and what opens from it. */
  readonly testId: string;
  readonly panelTestId: string;
  readonly label: string;
  readonly icon: NavIcon;
  /** Lit: the page open now is in one of its places. */
  readonly active: boolean;
  /** The counts on the row (its places' own), handed what to do once one is pressed. */
  readonly counts?: (picked?: () => void) => ReactNode;
  readonly onNavigate?: () => void;
  /** Its places, handed what to do once one is picked. */
  readonly children: (picked?: () => void) => ReactNode;
}

/**
 * In the sidebar: the places come up beside the menu on hover or a press, so a menu people rarely go into takes one
 * row instead of seven. Hovering never steals the keyboard's place; a press, and the arrow keys after it, move into
 * the flyout as usual.
 */
function Flyout({
  testId,
  panelTestId,
  label,
  icon: Icon,
  active,
  counts,
  onNavigate,
  children,
}: OpenerProps) {
  const hoverable = useMatches('(hover: hover) and (pointer: fine)');
  const [open, setOpen] = useState(false);
  /** Open because the pointer is resting on it, rather than because someone asked for it. */
  const byHover = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        data-testid={testId}
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
        <Icon className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
        <span className="min-w-0 truncate">{label}</span>
        <span className="ml-auto flex items-center gap-1">
          {counts?.(close)}
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
          data-testid={panelTestId}
          className="z-40 flex max-h-[70vh] w-[220px] flex-col gap-0.5 overflow-y-auto rounded-menu border border-border bg-card p-1.5 shadow-2"
        >
          <p className="px-2.5 pb-1 pt-1 text-xs font-medium text-text-3">{label}</p>
          {children(close)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** In the phone's drawer: the places open in place, and are already open when the page showing is one of them. */
function Fold({
  testId,
  panelTestId,
  label,
  icon: Icon,
  active,
  counts,
  onNavigate,
  children,
}: OpenerProps) {
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={rowClass(active)}
      >
        <Icon className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
        <span className="min-w-0 truncate">{label}</span>
        <span className="ml-auto flex items-center gap-1">
          {open ? null : counts?.()}
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
          data-testid={panelTestId}
        >
          {children(onNavigate)}
        </div>
      ) : null}
    </>
  );
}

/** An add-on's pages (0108), the one the open page is in lit, and its count on the page it counts. */
function AddonPageLinks({
  workspaceId,
  item,
  pathname,
  onNavigate,
}: {
  workspaceId: string;
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const pages = item.pages ?? [];
  const lit = currentMenuPlace(pages, pathname)?.key ?? null;
  const addonId = item.key.replace(/^addon:/, '');
  return (
    <>
      {pages.map((page) => (
        <NavLink
          key={page.key}
          item={page}
          active={page.key === lit}
          onNavigate={onNavigate}
          badge={
            countedPage(addonId, page.key) ? (
              <span className="ml-auto">
                <AddonCount workspaceId={workspaceId} addonId={addonId} />
              </span>
            ) : undefined
          }
        />
      ))}
    </>
  );
}

/** How the menu is drawn: beside the sidebar, or in the phone's drawer. */
type Variant = 'sidebar' | 'drawer';

/**
 * An add-on as one row (0108; the owner's decision, 2026-10-09): its pages open from it, like a group's places, so
 * every add-on a business turns on adds a single row. It is lit on any of its pages.
 */
function AddonRow({
  workspaceId,
  item,
  active,
  pathname,
  variant,
  onNavigate,
}: {
  workspaceId: string;
  item: NavItem;
  active: boolean;
  pathname: string;
  variant: Variant;
  onNavigate?: () => void;
}) {
  const Opener = variant === 'drawer' ? Fold : Flyout;
  const addonId = item.key.replace(/^addon:/, '');
  return (
    <Opener
      testId={`menu-addon-${addonId}`}
      panelTestId={`menu-addon-panel-${addonId}`}
      label={item.label}
      icon={item.icon}
      active={active}
      counts={() => <AddonCount key="a" workspaceId={workspaceId} addonId={addonId} />}
      onNavigate={onNavigate}
    >
      {(picked) => (
        <AddonPageLinks
          workspaceId={workspaceId}
          item={item}
          pathname={pathname}
          onNavigate={picked}
        />
      )}
    </Opener>
  );
}

/** What a group draws its places from: each place's item, and the one the open page is in. */
interface GroupProps {
  workspaceId: string;
  group: MenuGroup;
  items: ReadonlyMap<MenuPlaceKey, NavItem>;
  activeKey: MenuPlaceKey | null;
  pathname: string;
  badges: (key: MenuPlaceKey, onNavigate?: () => void) => ReactNode;
  variant: Variant;
  onNavigate?: () => void;
}

/**
 * A group the person made, as one row that is lit by what is inside it. An add-on they put in it shows its pages
 * there, under its name.
 */
function Group({
  workspaceId,
  group,
  items,
  activeKey,
  pathname,
  badges,
  variant,
  onNavigate,
}: GroupProps) {
  const Opener = variant === 'drawer' ? Fold : Flyout;
  return (
    <Opener
      testId={`menu-group-${group.id}`}
      panelTestId={`menu-group-panel-${group.id}`}
      label={group.label}
      icon={Layers}
      active={activeKey !== null && group.keys.includes(activeKey)}
      counts={(picked) => group.keys.map((k) => badges(k, picked))}
      onNavigate={onNavigate}
    >
      {(picked) =>
        group.keys.map((key) => {
          const item = items.get(key);
          if (!item) return null;
          if (item.pages)
            return (
              <div key={key} role="group" aria-label={item.label} className="flex flex-col gap-0.5">
                <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-text-3">{item.label}</p>
                <AddonPageLinks
                  workspaceId={workspaceId}
                  item={item}
                  pathname={pathname}
                  onNavigate={picked}
                />
              </div>
            );
          return (
            <NavLink
              key={key}
              item={item}
              active={key === activeKey}
              badge={<span className="ml-auto">{badges(key, picked)}</span>}
              onNavigate={picked}
            />
          );
        })
      }
    </Opener>
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
 * Each add-on running in the business adds one row (0108), whose pages open from it as a group's places do, and
 * only while it runs: one that is turned off leaves no link behind, and comes back where the person had it when
 * it's turned on again.
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
  variant?: Variant;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const menu = menuFor(useMenu().menu, permissions, menuAddons(addons));
  const items = new Map<MenuPlaceKey, NavItem>();
  for (const key of menuKeys(menu)) {
    const item = placeItemOf(workspaceId, key, permissions);
    if (item) items.set(key, item);
  }
  // One place is lit: the one the open page is in, an add-on on any of its pages.
  const activeKey = currentMenuPlace([...items.values()], pathname)?.key ?? null;
  const unread = useUnread().summary?.unread.all ?? 0;
  const urgent = useAttentionSummary().summary?.urgent ?? 0;
  const badges = (key: MenuPlaceKey, after = onNavigate): ReactNode => {
    if (key === 'home') return <UrgentCount key="u" count={urgent} />;
    // An add-on's count, on a group the person put it in.
    if (!isMenuKey(key))
      return (
        <AddonCount key={key} workspaceId={workspaceId} addonId={key.replace(/^addon:/, '')} />
      );
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
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Workspace">
      {menu.entries.map((entry) => {
        if (entry.kind === 'group') {
          return (
            <Group
              key={entry.id}
              workspaceId={workspaceId}
              group={entry}
              items={items}
              activeKey={activeKey}
              pathname={pathname}
              badges={badges}
              variant={variant}
              onNavigate={onNavigate}
            />
          );
        }
        const item = items.get(entry.key);
        if (!item) return null;
        if (item.pages)
          return (
            <AddonRow
              key={entry.key}
              workspaceId={workspaceId}
              item={item}
              active={entry.key === activeKey}
              pathname={pathname}
              variant={variant}
              onNavigate={onNavigate}
            />
          );
        return (
          <NavLink
            key={entry.key}
            item={item}
            active={entry.key === activeKey}
            onNavigate={onNavigate}
            badge={<span className="ml-auto">{badges(entry.key)}</span>}
          />
        );
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
