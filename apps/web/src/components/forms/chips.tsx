import type { FormMode, FormStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { FORM_MODE_LABELS, STATUS_WORDS } from '@/lib/forms/words';

/** Draft, taking answers, closed — the same three words everywhere they appear. */
export function FormStatusBadge({ status, className }: { status: FormStatus; className?: string }) {
  const word = STATUS_WORDS[status] ?? { label: status, tone: 'quiet' as const };
  const tone =
    word.tone === 'live'
      ? 'bg-success-soft text-success-text'
      : word.tone === 'draft'
        ? 'bg-card-2 text-text-2'
        : 'bg-card-2 text-text-3';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium',
        tone,
        className,
      )}
      data-testid="form-status"
    >
      {word.label}
    </span>
  );
}

export function FormModeBadge({ mode, className }: { mode: FormMode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[12px] text-text-2',
        className,
      )}
    >
      {FORM_MODE_LABELS[mode]}
    </span>
  );
}
