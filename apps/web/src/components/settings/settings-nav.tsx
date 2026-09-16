'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/** Sub-navigation shared by the settings pages. Workspace pages only show for owners and admins. */
export function SettingsNav({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}/settings`;
  const items = [
    { href: base, label: 'Account', exact: true },
    { href: `${base}/my-calendar`, label: 'My calendar' },
    ...(canManage
      ? [
          { href: `${base}/workspace`, label: 'Workspace' },
          { href: `${base}/pipelines`, label: 'Pipelines' },
          { href: `${base}/calendars`, label: 'Calendars' },
          { href: `${base}/imports`, label: 'Imports' },
          { href: `${base}/texting`, label: 'Texting & calls' },
          { href: `${base}/email`, label: 'Email' },
          { href: `${base}/website-chat`, label: 'Website chat' },
          // Payments is exact so its own Products page is the only tab marked while you're on it.
          { href: `${base}/payments`, label: 'Payments', exact: true },
          { href: `${base}/payments/products`, label: 'Products' },
          { href: `${base}/action-center`, label: 'Action Center' },
        ]
      : []),
  ];
  return (
    <nav
      aria-label="Settings"
      className="mb-5 flex gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {items.map((i) => {
        const active = i.exact ? pathname === i.href : pathname.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px flex h-10 flex-none items-center border-b-2 px-3 text-sm font-medium transition-colors',
              active
                ? 'border-accent text-accent-text'
                : 'border-transparent text-text-2 hover:text-text',
            )}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
