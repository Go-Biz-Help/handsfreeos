'use client';
/**
 * "Before it goes on" (step 8): what stops a funnel from turning on (red), what's worth a look (yellow), and what's in
 * place (ok), worked out from the funnel as it's edited (core's funnelIssues).
 */
import type { FunnelIssue } from '@hfos/core';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const ICON = { red: XCircle, yellow: AlertTriangle, ok: CheckCircle2 } as const;
const TONE = {
  red: 'text-danger-text',
  yellow: 'text-warning-text',
  ok: 'text-success-text',
} as const;
const ORDER = { red: 0, yellow: 1, ok: 2 } as const;

export function IssueList({ issues }: { issues: readonly FunnelIssue[] }) {
  const sorted = [...issues].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  return (
    <ul className="flex flex-col gap-2" data-testid="funnel-issues">
      {sorted.map((i, n) => {
        const Icon = ICON[i.level];
        return (
          <li
            key={`${i.rule}-${n}`}
            className="flex items-start gap-2 text-[13px]"
            data-rule={i.rule}
          >
            <Icon className={cn('mt-0.5 h-4 w-4 flex-none', TONE[i.level])} aria-hidden />
            <span className={i.level === 'ok' ? 'text-text-2' : 'text-text'}>{i.words}</span>
          </li>
        );
      })}
    </ul>
  );
}
