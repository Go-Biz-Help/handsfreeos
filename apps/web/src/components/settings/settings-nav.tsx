'use client';
import { settingsGroupsFor, type SettingsPageKey } from '@hfos/core';
import {
  ArrowRightLeft,
  Building2,
  CalendarClock,
  CalendarDays,
  CreditCard,
  FileText,
  Handshake,
  Inbox,
  KanbanSquare,
  LifeBuoy,
  ListChecks,
  Mail,
  MessageSquare,
  MessagesSquare,
  Network,
  Package,
  ShieldCheck,
  Target,
  Tag,
  Trash2,
  Upload,
  UserCircle,
  Wallet,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { MessengerIcon } from '@/components/inbox/social-bits';
import { PageHeader } from '@/components/shell/page-header';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { hasSettingsSearch, SettingsSearch } from './settings-search';
import { useSettingHighlight } from './use-setting-highlight';

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>;

/**
 * Each settings page's icon. The pages themselves, their groups and who sees each are core's list
 * (`SETTINGS_GROUPS`, packages/core/src/settings/pages.ts), which settings search and the Assistant's map read too.
 */
const ICONS: Readonly<Record<SettingsPageKey, Icon>> = {
  account: UserCircle,
  my_calendar: CalendarClock,
  workspace: Building2,
  main_offer: Target,
  permissions: ShieldCheck,
  automations: Zap,
  safety: LifeBuoy,
  usage: Wallet,
  texting: MessageSquare,
  email: Mail,
  website_chat: MessagesSquare,
  facebook_instagram: MessengerIcon,
  templates: FileText,
  lead_intake: Inbox,
  pipelines: KanbanSquare,
  tags: Tag,
  fields: ListChecks,
  relationships: Network,
  deleted_bin: Trash2,
  calendars: CalendarDays,
  payments: CreditCard,
  products: Package,
  partners: Handshake,
  imports: Upload,
  migrations: ArrowRightLeft,
};

/**
 * A calendar's own page (a new one, or one being built) has its own side menu of the calendar's settings, so it
 * takes the whole width. The other pages under Calendars are the catalogs the calendars share.
 */
const CALENDAR_BUILDER =
  /\/settings\/calendars\/(?!(services|resources|territories|booking-site)(\/|$))[^/]+/;

/**
 * Around every settings page: the settings menu, and beside it the heading over the page. On a computer the menu
 * is a side menu from the top of the window that stays put, and scrolls on its own, while the page scrolls; on a
 * phone, where there is no room beside the page, it is a list to pick from under the heading.
 */
export function SettingsFrame({
  workspaceId,
  staff,
  agency,
  children,
}: {
  workspaceId: string;
  /** They answer HandsFreeOS support, and have New support tickets. */
  staff: boolean;
  /** They run an agency, and have Daily agency digest. */
  agency: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const groups = useSettingsGroups(workspaceId);
  // Settings search's jump lands here on every settings page, and rings what the address points at.
  const highlight = useSettingHighlight();
  // One search for both: the side menu's box on a computer, and the box over the page picker on a phone.
  const [q, setQ] = useState('');
  if (CALENDAR_BUILDER.test(pathname)) return <>{children}</>;
  const search = { workspaceId, staff, agency, q, onChange: setQ, icons: ICONS, highlight };
  return (
    <div className="lg:grid lg:grid-cols-[208px_minmax(0,1fr)] lg:items-start lg:gap-6 xl:gap-8">
      <SettingsNav groups={groups} search={search} />
      <div className="min-w-0">
        <PageHeader
          title="Settings"
          description="Your account, and how this workspace is set up."
        />
        <SettingsPicker groups={groups} search={search} />
        {children}
      </div>
    </div>
  );
}

type SearchProps = Omit<
  Parameters<typeof SettingsSearch>[0],
  'children' | 'clearOnPick' | 'sticky'
>;

type Group = ReturnType<typeof useSettingsGroups>[number];

/** The groups and pages this person may see, and which one they're on: gated as settings search gates them. */
function useSettingsGroups(workspaceId: string) {
  const pathname = usePathname();
  const { permissions, addons } = useWorkspaceShell();
  const base = `/app/w/${workspaceId}/settings`;
  return settingsGroupsFor({ permissions, addons }).map((g) => ({
    label: g.label,
    items: g.items.map((i) => {
      const href = `${base}${i.path}`;
      return {
        ...i,
        icon: ICONS[i.key],
        href,
        active: i.exact ? pathname === href : pathname.startsWith(href),
      };
    }),
  }));
}

/** On a computer: the side menu, with Search settings at its top, which stays there as the menu scrolls under it. */
function SettingsNav({ groups, search }: { groups: readonly Group[]; search: SearchProps }) {
  const pathname = usePathname();
  // The page you're on is always in sight in the menu, even when it's far down a long one or on a short screen, and
  // never hidden under the search box.
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = menu.current;
    const link = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!box || !link) return;
    const b = box.getBoundingClientRect();
    const l = link.getBoundingClientRect();
    const covered =
      box.querySelector<HTMLElement>('[data-testid="settings-search-box"]')?.offsetHeight ?? 0;
    if (l.top < b.top + covered || l.bottom > b.bottom)
      box.scrollTop += l.top - b.top - b.height / 3;
  }, [pathname]);
  return (
    <Card className="hidden lg:sticky lg:top-8 lg:block" data-testid="settings-nav">
      <div
        ref={menu}
        className="max-h-[calc(100dvh-4rem-2px)] overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]"
      >
        <SettingsSearch {...search} sticky>
          <nav aria-label="Settings" className="flex flex-col gap-2">
            {groups.map((g) => {
              // The group's name is plain text, as in a calendar's own menu: labelling the group (or making the name
              // a heading) would give every settings page a "Messages" or "Customers" that a field's own label, or
              // the page's own heading, gets mistaken for.
              const slug = g.label.toLowerCase().replace(/[^a-z]+/g, '-');
              return (
                <div key={g.label} data-testid={`settings-group-${slug}`}>
                  <div className="px-2.5 pb-1 pt-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                    {g.label}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {g.items.map((i) => {
                      const Icon = i.icon;
                      return (
                        <Link
                          key={i.href}
                          href={i.href}
                          aria-current={i.active ? 'page' : undefined}
                          className={cn(
                            'flex h-9 items-center gap-2.5 rounded-control px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                            i.active
                              ? 'bg-accent-soft text-accent-text'
                              : 'text-text-2 hover:bg-card-2 hover:text-text',
                          )}
                        >
                          <Icon className="h-4 w-4 flex-none" strokeWidth={1.5} />
                          <span className="min-w-0 truncate">{i.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>
        </SettingsSearch>
      </div>
    </Card>
  );
}

/** On a phone: the same pages, in the same groups, as a list to pick from, under the same search. */
function SettingsPicker({ groups, search }: { groups: readonly Group[]; search: SearchProps }) {
  const router = useRouter();
  const current = groups.flatMap((g) => g.items).find((i) => i.active);
  return (
    <div
      className={cn(
        'mb-5 lg:hidden',
        hasSettingsSearch(search.q) && 'rounded-card border border-border bg-card p-2',
      )}
    >
      <SettingsSearch {...search} clearOnPick>
        <Select
          aria-label="Settings page"
          value={current?.href ?? ''}
          onChange={(e) => router.push(e.target.value)}
        >
          {current ? null : <option value="">Choose a page</option>}
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((i) => (
                <option key={i.href} value={i.href}>
                  {i.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </SettingsSearch>
    </div>
  );
}
