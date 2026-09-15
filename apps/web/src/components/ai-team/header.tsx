'use client';
import { ChevronDown, FlaskConical, History } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { TeammateStatus } from '@/lib/ai-team/types';
import { cn } from '@/lib/utils';
import { TeammateStatusBadge } from './chips';
import { TeammateMark } from './mark';

/** The teammate's name, status and last save, with the test console, History and More. */
export function TeammateHeader({
  name,
  status,
  saved,
  onTest,
  onHistory,
  menu,
  className,
}: {
  name: string;
  status: TeammateStatus;
  /** "Revision 6 · saved by Dale today at 10:12 AM". */
  saved: string | null;
  /** Owners and admins only. */
  onTest?: () => void;
  onHistory: () => void;
  /** DropdownMenuItems for More. */
  menu?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex flex-wrap items-center justify-between gap-3', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <TeammateMark size="lg" label={`${name} (AI)`} />
        <h1
          className="min-w-0 truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl"
          data-testid="teammate-name"
        >
          {name}
        </h1>
        <TeammateStatusBadge status={status} />
        {saved ? (
          <span className="text-[13px] text-text-3" data-testid="teammate-revision">
            {saved}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onTest ? (
          <Button variant="secondary" size="sm" onClick={onTest} data-testid="open-test-console">
            <FlaskConical className="h-4 w-4" strokeWidth={1.5} />
            Test console
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onHistory} data-testid="open-history">
          <History className="h-4 w-4" strokeWidth={1.5} />
          History
        </Button>
        {menu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`More for ${name}`}
                data-testid="teammate-menu"
              >
                More
                <ChevronDown className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

/** Teammate · Activity. */
export function TeammateSubnav({
  workspaceId,
  className,
}: {
  workspaceId: string;
  className?: string;
}) {
  const pathname = usePathname();
  const base = `/app/w/${workspaceId}/ai-team`;
  const items = [
    { href: base, label: 'Teammate', active: pathname === base },
    {
      href: `${base}/activity`,
      label: 'Activity',
      active: pathname.startsWith(`${base}/activity`),
    },
    // Its drafts wait on the Approvals page, beside workflow approvals.
    {
      href: `/app/w/${workspaceId}/workflows/approvals?filter=ai`,
      label: 'Approvals',
      active: false,
    },
  ];
  return (
    <nav
      aria-label="AI teammate"
      className={cn(
        'mb-4 flex gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]',
        className,
      )}
    >
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={i.active ? 'page' : undefined}
          data-testid={`subnav-${i.label.toLowerCase()}`}
          className={cn(
            '-mb-px flex h-11 flex-none items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors md:h-10',
            i.active
              ? 'border-accent text-accent-text'
              : 'border-transparent text-text-2 hover:text-text',
          )}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
