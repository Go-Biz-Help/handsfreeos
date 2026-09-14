'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/** Workflows · Runs · Approvals. Runs and Approvals arrive with the runs and approvals screens. */
export function WorkflowsSubnav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}/workflows`;
  const items = [{ href: base, label: 'Workflows' }];
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
          </Link>
        );
      })}
    </nav>
  );
}
