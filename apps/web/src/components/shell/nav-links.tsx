'use client';
import {
  BookOpen,
  CalendarDays,
  CircleDollarSign,
  ClipboardList,
  Home,
  Inbox,
  KanbanSquare,
  ListOrdered,
  Settings2,
  Sparkles,
  UserCircle,
  Users,
  Workflow,
  Star,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType } from 'react';
import { useAttentionSummary } from '@/lib/realtime/attention-summary';
import { useUnread } from '@/lib/realtime/unread-provider';
import { cn } from '@/lib/utils';

export interface NavItem {
  readonly key: string;
  readonly href: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly exact?: boolean;
  /** Shown in the phone bottom bar. */
  readonly primary?: boolean;
}

export function navItems(workspaceId: string): NavItem[] {
  const base = `/app/w/${workspaceId}`;
  return [
    { key: 'home', href: base, label: 'Home', icon: Home, exact: true, primary: true },
    { key: 'inbox', href: `${base}/inbox`, label: 'Inbox', icon: Inbox, primary: true },
    // Customers moved to the drawer on phones when the calendar joined the bottom bar (search still finds them).
    { key: 'customers', href: `${base}/customers`, label: 'Customers', icon: Users },
    {
      key: 'pipeline',
      href: `${base}/pipeline`,
      label: 'Pipeline',
      icon: KanbanSquare,
      primary: true,
    },
    {
      key: 'calendar',
      href: `${base}/calendar`,
      label: 'Calendar',
      icon: CalendarDays,
      primary: true,
    },
    // Money is a drawer item on phones too, so the bottom bar stays at five.
    { key: 'money', href: `${base}/money`, label: 'Money', icon: CircleDollarSign },
    // Workflows is a drawer item on phones, so the bottom bar stays at five.
    { key: 'workflows', href: `${base}/workflows`, label: 'Workflows', icon: Workflow },
    // Forms is a drawer item on phones, so the bottom bar stays at five.
    { key: 'forms', href: `${base}/forms`, label: 'Forms', icon: ClipboardList },
    // Reviews is a drawer item on phones too. It sits after Forms because both are about what the outside
    // world says to you rather than what you do about it.
    { key: 'reviews', href: `${base}/reviews`, label: 'Reviews', icon: Star },
    // Knowledge is a drawer item on phones too.
    { key: 'knowledge', href: `${base}/knowledge`, label: 'Knowledge', icon: BookOpen },
    // The AI teammate is a drawer item on phones as well. Everyone sees it; ai_team.manage changes it.
    { key: 'ai-team', href: `${base}/ai-team`, label: 'AI teammate', icon: Sparkles },
    // Tasks moved to the drawer on phones when the inbox joined the bottom bar.
    { key: 'tasks', href: `${base}/tasks`, label: 'Tasks', icon: ClipboardList },
    { key: 'members', href: `${base}/members`, label: 'Members', icon: UserCircle },
    { key: 'audit', href: `${base}/audit`, label: 'Audit log', icon: ListOrdered },
    { key: 'settings', href: `${base}/settings`, label: 'Settings', icon: Settings2 },
  ];
}

export function isActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
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

export function NavLinks({
  workspaceId,
  onNavigate,
}: {
  workspaceId: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const unread = useUnread().summary?.unread.all ?? 0;
  const urgent = useAttentionSummary().summary?.urgent ?? 0;
  return (
    <nav className="mt-2.5 flex flex-col gap-0.5" aria-label="Workspace">
      {navItems(workspaceId).map((item) => {
        const active = isActive(item, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.key}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-9 items-center gap-2.5 rounded-control px-2.5 text-sm font-medium transition-colors md:h-9 max-md:h-11',
              active
                ? 'bg-accent-soft text-accent-text'
                : 'text-text-2 hover:bg-card-2 hover:text-text',
            )}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.5} />
            {item.label}
            {item.key === 'home' ? <UrgentCount count={urgent} className="ml-auto" /> : null}
            {item.key === 'inbox' ? <UnreadCount count={unread} className="ml-auto" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}
