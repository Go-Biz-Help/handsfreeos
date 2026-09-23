'use client';
import { menuFor, menuKeys } from '@hfos/core';
import { ArrowLeft, Menu, MoreHorizontal, Search, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { MobileAskButton } from '@/components/assistant/ask-button';
import { CallsPill } from '@/components/calls/calls-pill';
import { Brand } from '@/components/ui/brand';
import { Input } from '@/components/ui/input';
import { GetHelp } from '@/components/support/get-help';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import type { Me, WorkspaceSummary } from '@/lib/api/types';
import { useAttentionSummary } from '@/lib/realtime/attention-summary';
import { useUnread } from '@/lib/realtime/unread-provider';
import { cn } from '@/lib/utils';
import { useMenu } from './menu-provider';
import { isActive, navItems, NavLinks, UnreadCount, UrgentCount } from './nav-links';
import { SearchField } from './search-field';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';

/** Phone chrome: a top bar with the menu and search, a left drawer with the full navigation, and a bottom bar. */
export function MobileShell({ me, current }: { me: Me; current: WorkspaceSummary }) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState(false);
  const items = navItems(current.id);
  // A place taken out of the menu is out of the bottom bar too; it still titles its own page, and search and
  // links still reach it. So is one the business keeps this person from (0103).
  const shown = new Set(menuKeys(menuFor(useMenu().menu, current.permissions)));
  const bar = items.filter((i) => i.primary && shown.has(i.key));
  const active = items.find((i) => isActive(i, pathname));
  const nested = active && !active.exact && pathname !== active.href;
  const title = active?.label ?? current.name;
  const unread = useUnread().summary?.unread.all ?? 0;
  const urgent = useAttentionSummary().summary?.urgent ?? 0;
  // A conversation fills the phone screen: the composer takes the bottom bar's place.
  const inThread = new RegExp(`^/app/w/${current.id}/inbox/[^/]+`).test(pathname);
  const inboxHref = `/app/w/${current.id}/inbox`;
  const inInbox = pathname === inboxHref;
  // Opened from an email link there is no page to go back to: go up to the section instead.
  const goBack = () => (window.history.length > 1 ? router.back() : router.push(active!.href));

  return (
    <>
      <header
        className={cn(
          'sticky top-0 z-30 flex h-14 flex-none items-center gap-1 border-b border-border bg-card px-2 md:hidden',
          inThread && 'hidden',
        )}
      >
        {nested ? (
          <button
            type="button"
            aria-label="Back"
            onClick={goBack}
            className="flex h-11 w-11 items-center justify-center rounded-control text-text-2 hover:bg-card-2"
          >
            <ArrowLeft className="h-5 w-5" strokeWidth={1.5} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Open menu"
            data-testid="mobile-menu"
            onClick={() => setDrawer(true)}
            className="flex h-11 w-11 items-center justify-center rounded-control text-text-2 hover:bg-card-2"
          >
            <Menu className="h-5 w-5" strokeWidth={1.5} />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-base font-semibold">{title}</span>
        {inInbox ? (
          <Link
            href={`${inboxHref}?new=1`}
            aria-label="New message"
            data-testid="mobile-new-message"
            className="flex h-11 w-11 items-center justify-center rounded-control text-text-2 hover:bg-card-2"
          >
            <SquarePen className="h-5 w-5" strokeWidth={1.5} />
          </Link>
        ) : null}
        <MobileAskButton />
        <button
          type="button"
          aria-label={inInbox ? 'Search conversations' : 'Search customers'}
          onClick={() => setSearch(true)}
          className="flex h-11 w-11 items-center justify-center rounded-control text-text-2 hover:bg-card-2"
        >
          <Search className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </header>

      <nav
        aria-label="Primary"
        className={cn(
          'fixed inset-x-0 bottom-0 z-30 flex h-[66px] border-t border-border bg-card pb-1.5 md:hidden',
          inThread && 'hidden',
        )}
      >
        {bar.map((item) => {
          const Icon = item.icon;
          const on = isActive(item, pathname);
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium',
                on ? 'text-accent-text' : 'text-text-3',
              )}
            >
              <span className="relative">
                <Icon className="h-[22px] w-[22px]" strokeWidth={on ? 2 : 1.5} />
                {item.key === 'home' ? (
                  <UrgentCount
                    count={urgent}
                    className="absolute -right-2.5 -top-1.5 h-4 min-w-4 px-1 text-[10px] ring-2 ring-card"
                  />
                ) : null}
                {item.key === 'inbox' ? (
                  <UnreadCount
                    count={unread}
                    className="absolute -right-2.5 -top-1.5 h-4 min-w-4 px-1 text-[10px] ring-2 ring-card"
                  />
                ) : null}
              </span>
              {item.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setDrawer(true)}
          className="flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-text-3"
        >
          <MoreHorizontal className="h-[22px] w-[22px]" strokeWidth={1.5} />
          More
        </button>
      </nav>

      {/* The drawer holds the whole menu, groups and all; only the menu scrolls, so the account stays put. */}
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent
          side="left"
          title="Menu"
          hideHeader
          className="overflow-y-hidden px-3 pb-4 pt-5"
        >
          <div className="flex-none">
            <div className="px-2.5 pb-3.5 pt-1">
              <Brand />
            </div>
            <WorkspaceSwitcher me={me} current={current} />
          </div>
          <div
            data-testid="drawer-menu"
            className="-mx-1 mt-2.5 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-0.5"
          >
            <NavLinks
              workspaceId={current.id}
              permissions={current.permissions}
              variant="drawer"
              onNavigate={() => setDrawer(false)}
            />
          </div>
          <div className="flex-none pt-2">
            <CallsPill />
            <GetHelp workspaceId={current.id} />
            <UserMenu user={me.user} />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={search} onOpenChange={setSearch}>
        {inInbox ? (
          <SheetContent
            title="Search conversations"
            description="Find a conversation by name, number or what was said."
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
                router.push(q ? `${inboxHref}?q=${encodeURIComponent(q)}` : inboxHref);
                setSearch(false);
              }}
            >
              <Input
                name="q"
                inputSize="lg"
                autoFocus
                enterKeyHint="search"
                placeholder="Search conversations"
                aria-label="Search conversations"
              />
            </form>
          </SheetContent>
        ) : (
          <SheetContent
            title="Search"
            description="Find a person or company by name, phone, email or street."
          >
            <SearchField
              workspaceId={current.id}
              size="lg"
              autoFocus
              onSubmitted={() => setSearch(false)}
            />
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}
