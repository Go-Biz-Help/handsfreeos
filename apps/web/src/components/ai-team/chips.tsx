import { BookOpen, Check, PowerOff, ShieldCheck, X, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  STATUS_NAMES,
  teammateLabelName,
  type CheckView,
  type KnowledgeRef,
} from '@/lib/ai-team/describe';
import type { TeammateStatus } from '@/lib/ai-team/types';
import { cn } from '@/lib/utils';
import { AI_SOFT, AI_TEXT } from './mark';

const STATUS = {
  off: { variant: 'gray', icon: PowerOff },
  training: { variant: 'pending', icon: ShieldCheck },
  automatic: { variant: 'ok', icon: Zap },
} as const;

export function TeammateStatusBadge({
  status,
  className,
  testId = 'teammate-status',
}: {
  status: TeammateStatus;
  className?: string;
  testId?: string;
}) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <Badge variant={s.variant} className={className} data-testid={testId}>
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      {STATUS_NAMES[status]}
    </Badge>
  );
}

/** The inferred labels, the first (the role) tinted. They describe the skills; they never lock anything. */
export function TeammateLabelChips({
  tags,
  testId,
  className,
}: {
  tags: readonly string[];
  testId?: string;
  className?: string;
}) {
  return (
    <span className={cn('flex flex-wrap items-center gap-1.5', className)} data-testid={testId}>
      {(tags.length ? tags : ['custom']).map((t, i) => (
        <span
          key={t}
          className={cn(
            'inline-flex h-[22px] items-center whitespace-nowrap rounded-[6px] px-2 text-xs font-medium',
            i === 0 ? 'bg-accent-soft text-accent-text' : 'bg-card-2 text-text-2',
          )}
        >
          {teammateLabelName(t)}
        </span>
      ))}
    </span>
  );
}

/** The checks a reply passed, and any it failed with why. */
export function CheckChips({
  checks,
  className,
  testId,
}: {
  checks: readonly CheckView[];
  className?: string;
  testId?: string;
}) {
  return (
    <span className={cn('flex flex-wrap items-center gap-1.5', className)} data-testid={testId}>
      {checks.map((c) => (
        <span
          key={c.key}
          title={c.message ?? undefined}
          className={cn(
            'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-[11.5px] font-medium',
            c.ok ? 'bg-success-soft text-success-text' : 'bg-danger-soft text-danger-text',
          )}
        >
          {c.ok ? (
            <Check className="h-3 w-3" strokeWidth={2.2} />
          ) : (
            <X className="h-3 w-3" strokeWidth={2.2} />
          )}
          {c.label}
          {c.ok ? null : <span className="sr-only">: failed. {c.message}</span>}
        </span>
      ))}
    </span>
  );
}

/** Knowledge a reply used, on the AI tint. */
export function KnowledgeChips({
  items,
  className,
}: {
  items: readonly KnowledgeRef[];
  className?: string;
}) {
  return (
    <span className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {items.map((k, i) => (
        <span
          key={`${k.id ?? k.title}-${i}`}
          className={cn(
            'inline-flex h-[22px] max-w-full items-center gap-[5px] rounded-[6px] px-2 text-xs font-medium',
            AI_SOFT,
            AI_TEXT,
          )}
        >
          <BookOpen className="h-3 w-3 flex-none" strokeWidth={1.75} />
          <span className="truncate">{k.title}</span>
        </span>
      ))}
    </span>
  );
}
