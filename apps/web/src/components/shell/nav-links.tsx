'use client';
import { Home, ListOrdered, Settings2, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export function NavLinks({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}`;
  const items = [
    { href: base, label: 'Home', icon: Home, exact: true },
    { href: `${base}/members`, label: 'Members', icon: Users },
    { href: `${base}/audit`, label: 'Audit log', icon: ListOrdered },
    { href: `${base}/settings`, label: 'Settings', icon: Settings2 },
  ];
  return (
    <nav className="mt-2.5 flex flex-col gap-0.5" aria-label="Workspace">
      {items.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-9 items-center gap-2.5 rounded-control px-2.5 text-sm font-medium transition-colors',
              active
                ? 'bg-accent-soft text-accent-text'
                : 'text-text-2 hover:bg-card-2 hover:text-text',
            )}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.5} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
