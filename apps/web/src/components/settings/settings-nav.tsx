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
          // What a business keeps about its customers: its own fields, and its own kinds of records (pets,
          // vehicles, properties) with how they relate.
          { href: `${base}/fields`, label: 'Fields' },
          { href: `${base}/relationships`, label: 'Relationships' },
          { href: `${base}/calendars`, label: 'Calendars' },
          { href: `${base}/imports`, label: 'Imports' },
          // Its own page, not a tab inside Imports: that page lists spreadsheets, and this moves a whole
          // business across from another system.
          { href: `${base}/migrations`, label: 'Migrations' },
          { href: `${base}/texting`, label: 'Texting & calls' },
          { href: `${base}/email`, label: 'Email' },
          { href: `${base}/website-chat`, label: 'Website chat' },
          // Beside the channels, because that is what it is for: the wording they send on them.
          { href: `${base}/templates`, label: 'Templates' },
          // After the three channels: what happens when someone new arrives on any of them.
          { href: `${base}/lead-intake`, label: 'Lead intake' },
          // Payments is exact so its own Products page is the only tab marked while you're on it.
          { href: `${base}/payments`, label: 'Payments', exact: true },
          { href: `${base}/payments/products`, label: 'Products' },
          // Named apart from Payments on purpose: that page is the business's own customers paying *them*,
          // and this is what the business pays HandsFreeOS. Two things, two names, no shared word.
          { href: `${base}/usage`, label: 'Usage & balance' },
          { href: `${base}/automations`, label: 'Automations' },
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
