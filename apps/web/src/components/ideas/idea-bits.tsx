import {
  IDEA_STATUS_WORDS,
  WHATS_NEW_KIND_WORDS,
  type IdeaStatus,
  type WhatsNewKind,
} from '@hfos/core';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The small pieces every ideas page shares: the status and kind pills, and the plain-text renderer for an
 * idea's details and a What's new entry. Nothing here is interactive.
 */

const STATUS_TONE: Record<IdeaStatus, string> = {
  under_review: 'bg-card-2 text-text-2 border-border',
  planned: 'bg-accent-soft text-accent-text',
  in_progress: 'bg-warning-soft text-warning-text',
  done: 'bg-success-soft text-success-text',
  not_planned: 'bg-card-3 text-text-3',
};

export function StatusPill({ status, className }: { status: IdeaStatus; className?: string }) {
  return (
    <span
      data-testid="idea-status"
      className={cn(
        'inline-flex h-[22px] flex-none items-center whitespace-nowrap rounded-full border border-transparent px-2 text-xs font-medium',
        STATUS_TONE[status],
        className,
      )}
    >
      {IDEA_STATUS_WORDS[status]}
    </span>
  );
}

const KIND_TONE: Record<WhatsNewKind, string> = {
  new: 'bg-accent-soft text-accent-text',
  improved: 'bg-success-soft text-success-text',
  fixed: 'bg-card-2 text-text-2 border-border',
};

export function KindPill({ kind }: { kind: WhatsNewKind }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] flex-none items-center whitespace-nowrap rounded-full border border-transparent px-2 text-xs font-semibold',
        KIND_TONE[kind],
      )}
    >
      {WHATS_NEW_KIND_WORDS[kind]}
    </span>
  );
}

/**
 * Plain text as people typed it: blank lines make paragraphs, and lines that start "- " make a list. Never
 * HTML — what somebody typed is shown as words, whatever it looks like.
 */
export function PlainText({ text, className }: { text: string; className?: string }) {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (!blocks.length) return null;
  const out: ReactNode[] = blocks.map((block, i) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^[-•*]\s+/.test(l.trim())))
      return (
        <ul key={i} className="list-disc space-y-1 pl-5">
          {lines.map((l, j) => (
            <li key={j}>{l.trim().replace(/^[-•*]\s+/, '')}</li>
          ))}
        </ul>
      );
    return (
      <p key={i} className="whitespace-pre-line">
        {block}
      </p>
    );
  });
  return <div className={cn('flex flex-col gap-3 leading-relaxed', className)}>{out}</div>;
}

/** "Sep 9, 2026". */
export function dayWords(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Area ids to their names, for rows that carry only the id. */
export function areaNames(areas: readonly { id: string; name: string }[]): Map<string, string> {
  return new Map(areas.map((a) => [a.id, a.name]));
}
