'use client';
import { IDEAS_WORDS } from '@hfos/core';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NewDot, useWhatsNewUnseen } from './whats-new-signal';

/** Ideas · Roadmap · What's new (with a dot when something there is new to this person). */
export function IdeasSubnav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const unseen = useWhatsNewUnseen();
  const base = `/app/w/${workspaceId}/ideas`;
  const items = [
    {
      href: base,
      label: IDEAS_WORDS.tabs.ideas,
      active:
        pathname === base ||
        (pathname.startsWith(`${base}/`) &&
          !pathname.startsWith(`${base}/roadmap`) &&
          !pathname.startsWith(`${base}/whats-new`)),
    },
    { href: `${base}/roadmap`, label: IDEAS_WORDS.tabs.roadmap },
    { href: `${base}/whats-new`, label: IDEAS_WORDS.tabs.whatsNew, dot: unseen },
  ];
  return (
    <nav
      aria-label={IDEAS_WORDS.title}
      className="relative mb-5 flex gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {items.map((i) => {
        const active = i.active ?? pathname.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            data-testid={`ideas-tab-${i.href.split('/').pop()}`}
            className={cn(
              '-mb-px flex h-10 flex-none items-center gap-[7px] whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors',
              active
                ? 'border-accent text-accent-text'
                : 'border-transparent text-text-2 hover:text-text',
            )}
          >
            {i.label}
            {i.dot ? <NewDot count={i.dot} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}
