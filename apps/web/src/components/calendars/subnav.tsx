'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/** Settings → Calendars: the calendars themselves and the catalogs they share. */
export function CalendarsSubnav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}/settings/calendars`;
  const items = [
    { href: base, label: 'Calendars' },
    { href: `${base}/services`, label: 'Services' },
    { href: `${base}/resources`, label: 'Resources' },
    { href: `${base}/territories`, label: 'Territories' },
    { href: `${base}/booking-site`, label: 'Booking site' },
  ];
  const catalog = items.slice(1).find((i) => pathname.startsWith(i.href));
  return (
    <nav
      aria-label="Calendar settings"
      className="mb-5 flex gap-1.5 overflow-x-auto [scrollbar-width:none]"
    >
      {items.map((i) => {
        const active = catalog ? catalog.href === i.href : i.href === base;
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex h-8 flex-none items-center rounded-full border px-3 text-[13px] font-medium transition-colors',
              active
                ? 'border-transparent bg-accent-soft text-accent-text'
                : 'border-border-strong bg-card text-text-2 hover:text-text',
            )}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
