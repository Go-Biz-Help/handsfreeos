'use client';
import * as Popover from '@radix-ui/react-popover';
import {
  ArrowUpRight,
  Building2,
  ChevronsUpDown,
  Import,
  LayoutTemplate,
  Menu,
  Package,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { UserMenu } from '@/components/shell/user-menu';
import { Avatar } from '@/components/ui/avatar';
import { Brand } from '@/components/ui/brand';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { agencyHref, type AgencySection } from '@/lib/agency/org';
import type { Me } from '@/lib/api/types';
import { WORKSPACE_COOKIE } from '@/lib/workspace-cookie';
import { cn } from '@/lib/utils';

export interface AgencyShellProps {
  readonly me: Me;
  readonly org: { readonly id: string; readonly name: string };
  /** Other organizations whose agency area this person runs. */
  readonly others: readonly { readonly id: string; readonly name: string }[];
  readonly businesses: readonly { readonly id: string; readonly name: string }[];
}

const SECTIONS: readonly { key: AgencySection; label: string; icon: LucideIcon }[] = [
  { key: 'businesses', label: 'Client businesses', icon: Building2 },
  { key: 'templates', label: 'Templates', icon: LayoutTemplate },
  { key: 'packs', label: 'Knowledge packs', icon: Package },
  { key: 'migrations', label: 'Migrations', icon: Import },
];

function AgencyNav({ orgId, onNavigate }: { orgId: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Agency" className="mt-3 flex flex-col gap-0.5">
      {SECTIONS.map(({ key, label, icon: Icon }) => {
        const href = agencyHref(orgId, key);
        const on = pathname.startsWith(href);
        return (
          <Link
            key={key}
            href={href}
            onClick={onNavigate}
            aria-current={on ? 'page' : undefined}
            data-testid={`agency-nav-${key}`}
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
      })}
    </nav>
  );
}

/** The agency itself, with its client businesses (to open one) and any other agency this person runs. */
function AgencySwitcher({ org, others, businesses }: Omit<AgencyShellProps, 'me'>) {
  const [open, setOpen] = useState(false);
  const count = `${businesses.length} ${businesses.length === 1 ? 'business' : 'businesses'}`;
  const openBusiness = (id: string) => {
    document.cookie = `${WORKSPACE_COOKIE}=${id}; path=/; max-age=31536000; samesite=lax`;
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="agency-switcher"
          className="flex h-[52px] w-full items-center gap-2.5 rounded-menu border border-border bg-card px-2.5 text-left hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          <Avatar name={org.name} seed={org.id} square className="bg-accent text-white" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold">{org.name}</span>
            <span className="truncate text-xs text-text-3">Agency · {count}</span>
          </span>
          <ChevronsUpDown className="h-[18px] w-[18px] flex-none text-text-3" strokeWidth={1.5} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-[60] w-[288px] max-w-[calc(100vw-24px)] rounded-card border border-border bg-card p-1.5 shadow-2 focus:outline-none"
        >
          <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-text-3">Open a business</div>
          <div className="max-h-[280px] overflow-y-auto">
            {businesses.map((b) => (
              <Link
                key={b.id}
                href={`/app/w/${b.id}`}
                onClick={() => openBusiness(b.id)}
                className="flex h-10 items-center gap-2.5 rounded-[6px] px-2.5 text-sm hover:bg-card-2 md:h-9"
              >
                <Avatar
                  name={b.name}
                  seed={b.id}
                  size="sm"
                  square
                  className="bg-card-3 text-text"
                />
                <span className="flex-1 truncate">{b.name}</span>
                <ArrowUpRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
              </Link>
            ))}
          </div>
          {others.length ? (
            <>
              <div className="my-1 h-px bg-border" />
              <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-text-3">
                Other agencies
              </div>
              {others.map((o) => (
                <Link
                  key={o.id}
                  href={agencyHref(o.id)}
                  onClick={() => setOpen(false)}
                  className="flex h-10 items-center gap-2.5 rounded-[6px] px-2.5 text-sm hover:bg-card-2 md:h-9"
                >
                  <Avatar name={o.name} seed={o.id} size="sm" square />
                  <span className="flex-1 truncate">{o.name}</span>
                </Link>
              ))}
            </>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The agency area's chrome: a sidebar on wide screens; a top bar and a drawer on phones. */
export function AgencyShell({ children, ...props }: AgencyShellProps & { children: ReactNode }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const section = SECTIONS.find((s) => pathname.startsWith(agencyHref(props.org.id, s.key)));
  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="hidden w-60 flex-none flex-col gap-1 border-r border-border bg-card px-3 pb-3 pt-4 md:flex">
        <div className="px-2.5 pb-3.5 pt-1">
          <Brand />
        </div>
        <AgencySwitcher org={props.org} others={props.others} businesses={props.businesses} />
        <AgencyNav orgId={props.org.id} />
        <div className="flex-1" />
        <UserMenu user={props.me.user} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 flex-none items-center gap-1 border-b border-border bg-card px-2 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            data-testid="agency-menu"
            onClick={() => setDrawer(true)}
            className="flex h-11 w-11 items-center justify-center rounded-control text-text-2 hover:bg-card-2"
          >
            <Menu className="h-5 w-5" strokeWidth={1.5} />
          </button>
          <span className="min-w-0 flex-1 truncate text-base font-semibold">
            {section?.label ?? props.org.name}
          </span>
        </header>
        <main className="min-w-0 flex-1 px-4 pb-16 pt-4 md:px-10 md:py-8">{children}</main>
      </div>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" title="Menu" hideHeader className="px-3 pb-4 pt-5">
          <div className="px-2.5 pb-3.5 pt-1">
            <Brand />
          </div>
          <AgencySwitcher org={props.org} others={props.others} businesses={props.businesses} />
          <AgencyNav orgId={props.org.id} onNavigate={() => setDrawer(false)} />
          <div className="flex-1" />
          <UserMenu user={props.me.user} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
