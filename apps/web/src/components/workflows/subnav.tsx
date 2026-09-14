'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useWaitingApprovals } from './approvals/use-waiting-approvals';

/** Workflows · Runs · Approvals (with how many wait for the viewer). */
export function WorkflowsSubnav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}/workflows`;
  const waiting = useWaitingApprovals(workspaceId);
  const items: { href: string; label: string; count?: number | null }[] = [
    { href: base, label: 'Workflows' },
    { href: `${base}/runs`, label: 'Runs' },
    { href: `${base}/approvals`, label: 'Approvals', count: waiting },
  ];
  return (
    <nav
      aria-label="Workflows"
      className="mb-4 flex gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {items.map((i) => {
        const active = i.href === base ? pathname === base : pathname.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px flex h-10 flex-none items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors',
              active
                ? 'border-accent text-accent-text'
                : 'border-transparent text-text-2 hover:text-text',
            )}
          >
            {i.label}
            {i.count ? (
              <span
                data-testid="approvals-count"
                className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning-soft px-1.5 text-[11px] font-semibold tabular-nums text-warning-text"
              >
                {i.count > 99 ? '99+' : i.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
