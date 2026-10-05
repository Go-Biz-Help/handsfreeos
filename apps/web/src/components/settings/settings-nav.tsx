'use client';
import { can, type WorkspacePermission } from '@hfos/core';
import {
  ArrowRightLeft,
  Building2,
  CalendarClock,
  CalendarDays,
  CreditCard,
  FileText,
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
  Tag,
  Upload,
  UserCircle,
  Wallet,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface SettingsItem {
  readonly path: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly exact?: boolean;
  readonly needs?: WorkspacePermission;
}

/**
 * The settings pages, in groups a business owner looks for: themselves first, then the business, then how it
 * talks to customers, what it keeps about them, how they book and pay, and last bringing data across, which is
 * done once. Everyone has their account and their calendar; each of the business's own pages shows for whoever
 * may change what is on it, as the business has set that up (0106), and a group with none of them doesn't show.
 */
const GROUPS: readonly { readonly label: string; readonly items: readonly SettingsItem[] }[] = [
  {
    label: 'Your account',
    items: [
      { path: '', label: 'Account', icon: UserCircle, exact: true },
      { path: '/my-calendar', label: 'My calendar', icon: CalendarClock },
    ],
  },
  {
    label: 'Business',
    items: [
      { path: '/workspace', label: 'Workspace', icon: Building2, needs: 'workspace.update' },
      // Who may do what: only an owner sets it.
      {
        path: '/permissions',
        label: 'Permissions',
        icon: ShieldCheck,
        needs: 'permissions.manage',
      },
      { path: '/automations', label: 'Automations', icon: Zap, needs: 'workspace.update' },
      // Check-ins (round six): the business's times and its safety person. Each person's own contacts are on their
      // Safety page, never here.
      { path: '/safety', label: 'Safety', icon: LifeBuoy, needs: 'workspace.update' },
      // Named apart from Payments, and kept in another group, on purpose: Payments is the business's own
      // customers paying *them*, and this is what the business pays HandsFreeOS. Two things, two names.
      { path: '/usage', label: 'Usage & balance', icon: Wallet, needs: 'money.manage' },
    ],
  },
  {
    label: 'Messages',
    items: [
      { path: '/texting', label: 'Texting & calls', icon: MessageSquare, needs: 'channels.manage' },
      { path: '/email', label: 'Email', icon: Mail, needs: 'channels.manage' },
      {
        path: '/website-chat',
        label: 'Website chat',
        icon: MessagesSquare,
        needs: 'channels.manage',
      },
      // Beside the channels, because that is what it is for: the wording they send on them.
      { path: '/templates', label: 'Templates', icon: FileText, needs: 'templates.manage' },
      // After the channels: what happens when someone new arrives on any of them.
      { path: '/lead-intake', label: 'Lead intake', icon: Inbox, needs: 'channels.manage' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { path: '/pipelines', label: 'Pipelines', icon: KanbanSquare, needs: 'pipelines.manage' },
      // The business's tags, and the AI putting them on every customer (0107).
      { path: '/tags', label: 'Tags', icon: Tag, needs: 'tags.manage' },
      // What a business keeps about its customers: its own fields, and its own kinds of records (pets,
      // vehicles, properties) with how they relate.
      { path: '/fields', label: 'Fields', icon: ListChecks, needs: 'fields.manage' },
      { path: '/relationships', label: 'Relationships', icon: Network, needs: 'fields.manage' },
    ],
  },
  {
    label: 'Bookings & payments',
    items: [
      { path: '/calendars', label: 'Calendars', icon: CalendarDays, needs: 'calendars.manage' },
      // Payments is exact so its own Products page is the only one marked while you're on it.
      {
        path: '/payments',
        label: 'Payments',
        icon: CreditCard,
        exact: true,
        needs: 'money.manage',
      },
      { path: '/payments/products', label: 'Products', icon: Package, needs: 'money.manage' },
    ],
  },
  {
    label: 'Bring data in',
    items: [
      { path: '/imports', label: 'Imports', icon: Upload, needs: 'records.import' },
      // Its own page, not a tab inside Imports: that page lists spreadsheets, and this moves a whole
      // business across from another system.
      {
        path: '/migrations',
        label: 'Migrations',
        icon: ArrowRightLeft,
        needs: 'migrations.manage',
      },
    ],
  },
];

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
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const groups = useSettingsGroups(workspaceId);
  if (CALENDAR_BUILDER.test(pathname)) return <>{children}</>;
  return (
    <div className="lg:grid lg:grid-cols-[208px_minmax(0,1fr)] lg:items-start lg:gap-6 xl:gap-8">
      <SettingsNav groups={groups} />
      <div className="min-w-0">
        <PageHeader
          title="Settings"
          description="Your account, and how this workspace is set up."
        />
        <SettingsPicker groups={groups} />
        {children}
      </div>
    </div>
  );
}

type Group = ReturnType<typeof useSettingsGroups>[number];

/** The groups and pages this person may see, and which one they're on. */
function useSettingsGroups(workspaceId: string) {
  const pathname = usePathname();
  const { permissions } = useWorkspaceShell();
  const base = `/app/w/${workspaceId}/settings`;
  return GROUPS.map((g) => ({
    label: g.label,
    items: g.items
      .filter((i) => !i.needs || can(permissions, i.needs))
      .map((i) => {
        const href = `${base}${i.path}`;
        return { ...i, href, active: i.exact ? pathname === href : pathname.startsWith(href) };
      }),
  })).filter((g) => g.items.length > 0);
}

/** On a computer: the side menu. */
function SettingsNav({ groups }: { groups: readonly Group[] }) {
  const pathname = usePathname();
  // The page you're on is always in sight in the menu, even when it's far down a long one or on a short screen.
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = menu.current;
    const link = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!box || !link) return;
    const b = box.getBoundingClientRect();
    const l = link.getBoundingClientRect();
    if (l.top < b.top || l.bottom > b.bottom) box.scrollTop += l.top - b.top - b.height / 3;
  }, [pathname]);
  return (
    <Card className="hidden lg:sticky lg:top-8 lg:block" data-testid="settings-nav">
      <div
        ref={menu}
        className="max-h-[calc(100dvh-4rem-2px)] overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]"
      >
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
      </div>
    </Card>
  );
}

/** On a phone: the same pages, in the same groups, as a list to pick from. */
function SettingsPicker({ groups }: { groups: readonly Group[] }) {
  const router = useRouter();
  const current = groups.flatMap((g) => g.items).find((i) => i.active);
  return (
    <div className="mb-5 lg:hidden">
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
    </div>
  );
}
