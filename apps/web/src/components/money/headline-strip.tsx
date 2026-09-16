import { addDays, localDateOf, money, moneyRounded } from '@hfos/core';
import { formatDateOnly } from '@/lib/format';
import type { MoneySummaryOut } from '@/lib/api/types';
import { cn } from '@/lib/utils';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

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
  tone?: 'bad' | 'good';
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
 * What you are owed, what is late and what has come in: the three numbers the canvas puts above every list.
 * Outstanding and overdue are exact to the cent — they are what someone chases — while the collected figure is
 * a summary, so it rounds.
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
  const today = localDateOf(Date.parse(summary.now), timeZone);
  const from = addDays(today, -days);
  const settling = summary.settlingCents > 0;
  return (
    <div
      className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3"
      data-testid="money-headline"
    >
      <Figure
        testId="money-outstanding"
        value={money(summary.outstandingCents)}
        label="Outstanding"
        sub={
          summary.outstandingCount === 0
            ? 'Nothing waiting to be paid'
            : settling
              ? `${plural(summary.outstandingCount, 'invoice')} waiting · ${money(summary.settlingCents)} on its way`
              : `${plural(summary.outstandingCount, 'invoice')} waiting to be paid`
        }
      />
      <Figure
        testId="money-overdue"
        value={money(summary.overdueCents)}
        label="Overdue"
        tone={summary.overdueCents > 0 ? 'bad' : undefined}
        sub={
          summary.overdueCount === 0
            ? 'Nothing is late'
            : `${plural(summary.overdueCount, 'invoice')} past the due date`
        }
      />
      <Figure
        testId="money-collected"
        value={moneyRounded(summary.collectedCents)}
        label={`Collected in ${days} days`}
        tone={summary.collectedCents > 0 ? 'good' : undefined}
        sub={
          summary.refundedCents > 0
            ? `${formatDateOnly(from)} to ${formatDateOnly(today)} · after ${money(summary.refundedCents)} refunded`
            : `${formatDateOnly(from)} to ${formatDateOnly(today)}`
        }
      />
    </div>
  );
}
