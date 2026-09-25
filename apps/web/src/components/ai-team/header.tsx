'use client';
import { ChevronDown, CloudAlert, CloudCheck, FlaskConical, History, Loader2 } from 'lucide-react';
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
import type { SaveState } from '@/lib/ai-team/use-draft';
import { cn } from '@/lib/utils';
import { TeammateStatusBadge } from './chips';
import { TeammateMark } from './mark';

/** Saved / Saving… / Couldn't save (Try again) / Not saved: changes save on their own. */
export function SaveIndicator({
  state,
  onRetry,
  className,
}: {
  state: SaveState;
  onRetry: () => void;
  className?: string;
}) {
  const bad = state === 'failed' || state === 'conflict';
  const Icon = state === 'saving' ? Loader2 : bad ? CloudAlert : CloudCheck;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]',
        bad ? 'font-medium text-warning-text' : 'text-text-3',
        className,
      )}
      data-testid="teammate-save-state"
      data-state={state}
      aria-live="polite"
    >
      <Icon
        className={cn('h-4 w-4 flex-none', state === 'saving' && 'animate-spin')}
        strokeWidth={1.75}
        aria-hidden
      />
      {
        {
          saved: 'Saved',
          saving: 'Saving…',
          failed: 'Couldn’t save',
          conflict: 'Not saved',
        }[state]
      }
      {state === 'failed' ? (
        <button type="button" onClick={onRetry} className="text-accent-text hover:underline">
          Try again
        </button>
      ) : null}
    </span>
  );
}

/** The teammate's name, status and last save, with the save indicator, test console, History and More. */
export function TeammateHeader({
  name,
  status,
  saved,
  saveState,
  onTest,
  onHistory,
  menu,
  className,
}: {
  name: string;
  status: TeammateStatus;
  /** "Revision 6 · saved by Dale today at 10:12 AM". */
  saved: string | null;
  /** The auto-save indicator, for owners and admins. */
  saveState?: ReactNode;
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
        {saveState ? <span className="mr-1">{saveState}</span> : null}
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

/** Teammate · Activity · Approvals. */
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
    {
      href: `${base}/approvals`,
      label: 'Approvals',
      active: pathname.startsWith(`${base}/approvals`),
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
