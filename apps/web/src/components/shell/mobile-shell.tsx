'use client';
import { ArrowLeft, Menu, MoreHorizontal, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Brand } from '@/components/ui/brand';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import type { Me, WorkspaceSummary } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { isActive, navItems, NavLinks } from './nav-links';
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
  const active = items.find((i) => isActive(i, pathname));
  const nested = active && !active.exact && pathname !== active.href;
  const title = active?.label ?? current.name;

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 flex-none items-center gap-1 border-b border-border bg-card px-2 md:hidden">
        {nested ? (
          <button
            type="button"
            aria-label="Back"
            onClick={() => router.back()}
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
        <button
          type="button"
          aria-label="Search customers"
          onClick={() => setSearch(true)}
          className="flex h-11 w-11 items-center justify-center rounded-control text-text-2 hover:bg-card-2"
        >
          <Search className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </header>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex h-[66px] border-t border-border bg-card pb-1.5 md:hidden"
      >
        {items
          .filter((i) => i.primary)
          .map((item) => {
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
                <Icon className="h-[22px] w-[22px]" strokeWidth={on ? 2 : 1.5} />
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

      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" title="Menu" hideHeader className="px-3 pb-4 pt-5">
          <div className="px-2.5 pb-3.5 pt-1">
            <Brand />
          </div>
          <WorkspaceSwitcher me={me} current={current} />
          <NavLinks workspaceId={current.id} onNavigate={() => setDrawer(false)} />
          <div className="flex-1" />
          <UserMenu user={me.user} />
        </SheetContent>
      </Sheet>

      <Sheet open={search} onOpenChange={setSearch}>
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
      </Sheet>
    </>
  );
}
