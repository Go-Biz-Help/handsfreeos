'use client';
import { Home, ListOrdered, Settings2, UserCircle, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType } from 'react';
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
    { key: 'customers', href: `${base}/customers`, label: 'Customers', icon: Users, primary: true },
    { key: 'members', href: `${base}/members`, label: 'Members', icon: UserCircle },
    { key: 'audit', href: `${base}/audit`, label: 'Audit log', icon: ListOrdered },
    { key: 'settings', href: `${base}/settings`, label: 'Settings', icon: Settings2 },
  ];
}

export function isActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}

export function NavLinks({
  workspaceId,
  onNavigate,
}: {
  workspaceId: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
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
          </Link>
        );
      })}
    </nav>
  );
}
