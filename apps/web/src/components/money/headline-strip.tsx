import { headlineFigures, type FigureTone } from '@hfos/core';
import type { MoneySummaryOut } from '@/lib/api/types';
import { cn } from '@/lib/utils';

function Figure({
  value,
  label,
  sub,
  tone,
  testId,
}: {
  value: string;
  label: string;
  sub: string;
  tone?: FigureTone;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-card px-[18px] py-3.5" data-testid={testId}>
      <span
        className={cn(
          'text-2xl font-semibold leading-[1.15] tracking-[-0.015em] tabular-nums',
          tone === 'bad' && 'text-danger-text',
          tone === 'good' && 'text-success-text',
        )}
        data-testid={`${testId}-value`}
      >
        {value}
      </span>
      <span className="text-[12.5px] text-text-2">{label}</span>
      <span className="text-xs text-text-3">{sub}</span>
    </div>
  );
}

/**
 * What you are owed, what is late and what has come in: the three numbers the canvas puts above every list. The
 * figures and their words are core's (`money/lists.ts`), so the phone's Money screen reads the same.
 */
export function HeadlineStrip({
  summary,
  days,
  timeZone,
}: {
  summary: MoneySummaryOut;
  days: number;
  timeZone: string;
}) {
  return (
    <div
      className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3"
      data-testid="money-headline"
    >
      {headlineFigures(summary, timeZone, days).map((f) => (
        <Figure
          key={f.key}
          testId={`money-${f.key}`}
          value={f.value}
          label={f.label}
          sub={f.sub}
          tone={f.tone}
        />
      ))}
    </div>
  );
}
