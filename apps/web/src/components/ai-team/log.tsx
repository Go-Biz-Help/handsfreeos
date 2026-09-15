import type { LucideIcon } from 'lucide-react';
import type { CheckView, KnowledgeRef } from '@/lib/ai-team/describe';
import { cn } from '@/lib/utils';
import { CheckChips, KnowledgeChips } from './chips';
import { AI_SOFT, AI_TEXT } from './mark';

export type LogTone = 'ok' | 'bad' | 'wait' | 'ai' | 'held' | 'run';

const TONES: Readonly<Record<LogTone, string>> = {
  ok: 'bg-success-soft text-success-text',
  bad: 'bg-danger-soft text-danger-text',
  wait: 'bg-card-2 text-text-3',
  ai: cn(AI_SOFT, AI_TEXT),
  held: 'bg-warning-soft text-warning-text',
  run: 'bg-accent-soft text-accent-text',
};

export interface LogLine {
  readonly id: string;
  /** "10:39:02"; null leaves the time column out. */
  readonly time: string | null;
  readonly tone: LogTone;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail?: string | null;
  /** What the customer wrote, or the reply. */
  readonly quote?: string | null;
  readonly knowledge?: readonly KnowledgeRef[];
  readonly checks?: readonly CheckView[];
}

/** One line of "What Ava did": when, an icon on its tone, what happened, and what it used. */
export function LogRow({ line, first }: { line: LogLine; first?: boolean }) {
  const Icon = line.icon;
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 py-2 text-[13px] leading-[1.4]',
        !first && 'border-t border-border',
      )}
      data-testid="log-line"
    >
      {line.time !== null ? (
        <span className="w-[66px] flex-none whitespace-nowrap pt-px text-xs tabular-nums text-text-3">
          {line.time}
        </span>
      ) : null}
      <span
        aria-hidden
        className={cn(
          'inline-flex h-5 w-5 flex-none items-center justify-center rounded-full',
          TONES[line.tone],
        )}
      >
        <Icon className="h-3 w-3" strokeWidth={2.2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{line.title}</span>
        {line.detail ? <span className="block text-xs text-text-3">{line.detail}</span> : null}
        {line.quote ? (
          <span className="mt-[5px] block whitespace-pre-wrap rounded-control bg-card-2 px-2.5 py-[7px] text-[12.5px] leading-[1.45] [overflow-wrap:anywhere]">
            {line.quote}
          </span>
        ) : null}
        {line.knowledge?.length ? (
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-text-3">Knowledge used:</span>
            <KnowledgeChips items={line.knowledge} />
          </span>
        ) : null}
        {line.checks?.length ? <CheckChips checks={line.checks} className="mt-1.5" /> : null}
      </span>
    </div>
  );
}
