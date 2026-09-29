'use client';
import {
  Blocks,
  Building2,
  HeartPulse,
  Inbox,
  Lightbulb,
  ListChecks,
  Menu,
  MessageSquareQuote,
  Tag,
  Ticket,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { UserMenu } from '@/components/shell/user-menu';
import { Brand } from '@/components/ui/brand';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import type { Me } from '@/lib/api/types';
import { cn } from '@/lib/utils';

export interface AdminStaff {
  readonly role: 'agent' | 'lead' | 'admin';
  readonly displayName: string;
  readonly permissions: readonly string[];
}

const SECTIONS: readonly {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Left out of the menu for anyone without it. */
  needs?: string;
}[] = [
  { href: '/admin/tickets', label: 'Tickets', icon: Inbox },
  // Ideas, the roadmap and What's new (0102): every support role answers them; leads and admins move them.
  { href: '/admin/ideas', label: 'Ideas', icon: Lightbulb, needs: 'platform.ideas.moderate' },
  // Voting on what's next (0109): the weekly pick, and choosing one when a week has no winner.
  { href: '/admin/add-ons', label: 'Add-on votes', icon: Blocks, needs: 'platform.addons.manage' },
  {
    href: '/admin/businesses',
    label: 'Businesses',
    icon: Building2,
    needs: 'platform.businesses.read',
  },
  // How Getting started is going, everywhere: its skips and finishes, counted (the plan's §9).
  {
    href: '/admin/getting-started',
    label: 'Getting started',
    icon: ListChecks,
    needs: 'platform.businesses.read',
  },
  { href: '/admin/health', label: 'Health', icon: HeartPulse, needs: 'platform.health.read' },
  { href: '/admin/rates', label: 'Rates', icon: Tag, needs: 'platform.rates.manage' },
  {
    href: '/admin/founding',
    label: 'Founding',
    icon: Ticket,
    needs: 'platform.founding.manage',
  },
  { href: '/admin/replies', label: 'Saved replies', icon: MessageSquareQuote },
  { href: '/admin/staff', label: 'Support people', icon: Users },
];

function AdminNav({
  permissions,
  onNavigate,
}: {
  permissions: readonly string[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Support and admin" className="mt-3 flex flex-col gap-0.5">
      {SECTIONS.filter((s) => !s.needs || permissions.includes(s.needs)).map(
        ({ href, label, icon: Icon }) => {
          const on = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={on ? 'page' : undefined}
              data-testid={`admin-nav-${href.split('/')[2]}`}
              className={cn(
                'flex h-10 items-center gap-2.5 rounded-control px-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:h-9',
                on
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-text-2 hover:bg-card-2 hover:text-text',
              )}
            >
              <Icon className="h-[18px] w-[18px] flex-none" strokeWidth={on ? 1.75 : 1.5} />
              {label}
            </Link>
          );
        },
      )}
    </nav>
  );
}

const ROLE_WORD: Record<AdminStaff['role'], string> = {
  agent: 'Support agent',
  lead: 'Support lead',
  admin: 'Support admin',
};

/**
 * The support desk's own chrome. Deliberately unlike the app a customer sees — a different colour on the
 * badge, and the word "HandsFreeOS" rather than a business name — so nobody ever answers a ticket thinking
 * they are inside somebody's account.
 */
export function AdminShell({
  me,
  staff,
  children,
}: {
  me: Me;
  staff: AdminStaff;
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const banner = (
    <div className="rounded-menu border border-border bg-card-2 px-2.5 py-2">
      <div className="text-sm font-semibold">HandsFreeOS</div>
      <div className="text-xs text-text-3">{ROLE_WORD[staff.role]}</div>
    </div>
  );
  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="hidden w-60 flex-none flex-col gap-1 border-r border-border bg-card px-3 pb-3 pt-4 md:flex">
        <div className="px-2.5 pb-3.5 pt-1">
          <Brand />
        </div>
        {banner}
        <AdminNav permissions={staff.permissions} />
        <div className="flex-1" />
        <Link
          href="/app"
          className="mb-1 rounded-control px-2.5 py-2 text-[13px] text-text-3 hover:bg-card-2 hover:text-text"
        >
          ← Back to the app
        </Link>
        <UserMenu user={me.user} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 flex-none items-center gap-1 border-b border-border bg-card px-2 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            data-testid="admin-menu"
            onClick={() => setDrawer(true)}
            className="flex h-11 w-11 items-center justify-center rounded-control text-text-2 hover:bg-card-2"
          >
            <Menu className="h-5 w-5" strokeWidth={1.5} />
          </button>
          <span className="min-w-0 flex-1 truncate text-base font-semibold">
            HandsFreeOS support
          </span>
        </header>
        <main className="min-w-0 flex-1 px-4 pb-16 pt-4 md:px-8 md:py-7">{children}</main>
      </div>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" title="Menu" hideHeader className="px-3 pb-4 pt-5">
          <div className="px-2.5 pb-3.5 pt-1">
            <Brand />
          </div>
          {banner}
          <AdminNav permissions={staff.permissions} onNavigate={() => setDrawer(false)} />
          <div className="flex-1" />
          <UserMenu user={me.user} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
