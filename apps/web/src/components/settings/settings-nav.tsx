'use client';
import { can, type WorkspacePermission } from '@hfos/core';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * Sub-navigation shared by the settings pages. Everyone has their account and their calendar; each of the
 * business's own pages shows for whoever may change what is on it, as the business has set that up (0106).
 */
export function SettingsNav({
  workspaceId,
  permissions,
}: {
  workspaceId: string;
  /** What the business lets them do, as workspace.get gives it. */
  permissions: readonly string[];
}) {
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}/settings`;
  const items: { href: string; label: string; exact?: boolean; needs?: WorkspacePermission }[] = [
    { href: base, label: 'Account', exact: true },
    { href: `${base}/my-calendar`, label: 'My calendar' },
    { href: `${base}/workspace`, label: 'Workspace', needs: 'workspace.update' },
    // Who may do what: only an owner sets it.
    { href: `${base}/permissions`, label: 'Permissions', needs: 'permissions.manage' },
    { href: `${base}/pipelines`, label: 'Pipelines', needs: 'pipelines.manage' },
    // The business's tags, and the AI putting them on every customer (0107).
    { href: `${base}/tags`, label: 'Tags', needs: 'tags.manage' },
    // What a business keeps about its customers: its own fields, and its own kinds of records (pets,
    // vehicles, properties) with how they relate.
    { href: `${base}/fields`, label: 'Fields', needs: 'fields.manage' },
    { href: `${base}/relationships`, label: 'Relationships', needs: 'fields.manage' },
    { href: `${base}/calendars`, label: 'Calendars', needs: 'calendars.manage' },
    { href: `${base}/imports`, label: 'Imports', needs: 'records.import' },
    // Its own page, not a tab inside Imports: that page lists spreadsheets, and this moves a whole
    // business across from another system.
    { href: `${base}/migrations`, label: 'Migrations', needs: 'migrations.manage' },
    { href: `${base}/texting`, label: 'Texting & calls', needs: 'channels.manage' },
    { href: `${base}/email`, label: 'Email', needs: 'channels.manage' },
    { href: `${base}/website-chat`, label: 'Website chat', needs: 'channels.manage' },
    // Beside the channels, because that is what it is for: the wording they send on them.
    { href: `${base}/templates`, label: 'Templates', needs: 'templates.manage' },
    // After the three channels: what happens when someone new arrives on any of them.
    { href: `${base}/lead-intake`, label: 'Lead intake', needs: 'channels.manage' },
    // Payments is exact so its own Products page is the only tab marked while you're on it.
    { href: `${base}/payments`, label: 'Payments', exact: true, needs: 'money.manage' },
    { href: `${base}/payments/products`, label: 'Products', needs: 'money.manage' },
    // Named apart from Payments on purpose: that page is the business's own customers paying *them*,
    // and this is what the business pays HandsFreeOS. Two things, two names, no shared word.
    { href: `${base}/usage`, label: 'Usage & balance', needs: 'money.manage' },
    { href: `${base}/automations`, label: 'Automations', needs: 'workspace.update' },
  ];
  return (
    <nav
      aria-label="Settings"
      className="mb-5 flex gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {items
        .filter((i) => !i.needs || can(permissions, i.needs))
        .map((i) => {
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
