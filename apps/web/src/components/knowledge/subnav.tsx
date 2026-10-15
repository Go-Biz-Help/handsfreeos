'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

/** What the Knowledge pages show; a teammate's change (or the worker's) refreshes them. */
const LIVE = [
  'knowledge_profile',
  'knowledge_item',
  'knowledge_suggestion',
  'knowledge_scan',
  'knowledge_source',
];

/** Overview · Items · Documents · Website · Promotions · Suggestions (with how many are waiting). */
export function KnowledgeSubnav({
  workspaceId,
  pending,
  more,
}: {
  workspaceId: string;
  pending: number;
  /** More are waiting than were counted. */
  more: boolean;
}) {
  useLiveRefresh(LIVE);
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}/knowledge`;
  const items = [
    { href: base, label: 'Overview', active: pathname === base || pathname === `${base}/profile` },
    { href: `${base}/items`, label: 'Items' },
    { href: `${base}/documents`, label: 'Documents' },
    { href: `${base}/website`, label: 'Website' },
    { href: `${base}/offers`, label: 'Promotions' },
    { href: `${base}/suggestions`, label: 'Suggestions', count: pending },
  ];
  return (
    <nav
      aria-label="Knowledge"
      // relative: the count's screen-reader words (absolutely placed) scroll with the tabs instead of widening
      // the page past a phone's edge.
      className="relative mb-4 flex gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {items.map((i) => {
        const active = i.active ?? pathname.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px flex h-10 flex-none items-center gap-[7px] whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors',
              active
                ? 'border-accent text-accent-text'
                : 'border-transparent text-text-2 hover:text-text',
            )}
          >
            {i.label}
            {i.count ? (
              <span
                data-testid="suggestions-count"
                className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-[5px] text-[11px] font-semibold leading-none text-white"
              >
                <span aria-hidden>{more || i.count > 99 ? '99+' : i.count}</span>
                <span className="sr-only">{i.count} waiting</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
