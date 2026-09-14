import { CircleHelp, File, FileText, Hash, Lightbulb, type LucideIcon } from 'lucide-react';
import { Fragment } from 'react';
import { Badge } from '@/components/ui/badge';
import type { KnowledgeItemKind, KnowledgeItemStatus } from '@/lib/api/types';
import { AI_TINT, KIND_LABEL, STATUS_LABEL, TEAL_TINT } from '@/lib/knowledge/labels';
import { cn } from '@/lib/utils';

type ChipKind = KnowledgeItemKind | 'gap';

const KIND_STYLE: Record<ChipKind, { icon: LucideIcon; className: string; label: string }> = {
  faq: { icon: CircleHelp, className: 'bg-accent-soft text-accent-text', label: KIND_LABEL.faq },
  article: { icon: FileText, className: TEAL_TINT, label: KIND_LABEL.article },
  fact: { icon: Hash, className: 'bg-success-soft text-success-text', label: KIND_LABEL.fact },
  document: {
    icon: File,
    className: 'bg-warning-soft text-warning-text',
    label: KIND_LABEL.document,
  },
  gap: { icon: Lightbulb, className: AI_TINT, label: 'Gap' },
};

/** FAQ, Article, Fact, Document or Gap, on its colour. */
export function KindChip({
  kind,
  label,
  className,
}: {
  kind: ChipKind;
  label?: string;
  className?: string;
}) {
  const style = KIND_STYLE[kind];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        'inline-flex h-5 flex-none items-center gap-[5px] whitespace-nowrap rounded-[6px] px-[7px] text-[11.5px] font-semibold',
        style.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={1.75} aria-hidden />
      {label ?? style.label}
    </span>
  );
}

export function ItemStatusBadge({
  status,
  className,
}: {
  status: KnowledgeItemStatus;
  className?: string;
}) {
  return (
    <Badge
      variant={status === 'published' ? 'ok' : status === 'draft' ? 'gray' : 'member'}
      className={cn('h-5 text-[11.5px]', className)}
      data-testid="item-status"
    >
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function TagChip({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 max-w-[160px] items-center truncate whitespace-nowrap rounded-full bg-card-2 px-2 text-[11.5px] font-medium text-text-2',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Search passages with the matched words (wrapped in ** ** by the database) highlighted. */
export function Snippet({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        i % 2 ? (
          <mark
            key={i}
            className="rounded-[3px] bg-warning-soft px-[1px] font-medium text-warning-text"
          >
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </span>
  );
}

/** A small completeness bar (filled of total). */
export function Meter({
  filled,
  total,
  className,
}: {
  filled: number;
  total: number;
  className?: string;
}) {
  const pct = total ? Math.round((filled / total) * 100) : 0;
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={filled}
      aria-label={`${filled} of ${total}`}
      className={cn('block h-1.5 overflow-hidden rounded-full bg-card-3', className)}
    >
      <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </span>
  );
}
