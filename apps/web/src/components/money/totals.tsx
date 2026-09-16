import { money, refundShares } from '@hfos/core';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Basis points as people write them: 825 → "8.25%", 1000 → "10%". */
export function percentLabel(bp: number): string {
  const value = (bp ?? 0) / 100;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;
}

export function TotalRow({
  label,
  value,
  big,
  credit,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  /** The line that matters: the total, or what's still owed. */
  big?: boolean;
  /** Money coming off, shown in green with a minus. */
  credit?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-center justify-between gap-4 py-1.5 text-[13.5px]',
        big && 'mt-1 border-t border-border pt-2.5 text-base font-semibold',
      )}
    >
      <span className={big ? 'text-text' : 'text-text-2'}>{label}</span>
      <span
        className={cn('whitespace-nowrap tabular-nums', credit && 'text-success-text')}
        data-testid={testId ? `${testId}-value` : undefined}
      >
        {value}
      </span>
    </div>
  );
}

export interface TotalsShape {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly discountPercentBp: number | null;
  readonly taxableBaseCents: number;
  readonly taxCents: number;
  readonly taxRateBp: number;
  readonly taxLabel: string | null;
  readonly totalCents: number;
}

/**
 * The totals block every money screen shares. `subtotalCents` is the lines before the document discount, so the
 * three lines read down to the total the way the canvas draws them; tax names the rate and what it was worked
 * out on, because that is the number people check.
 *
 * On an invoice the rows still add up once money has gone back. A refund never puts money back on the bill,
 * so what was refunded sits under "Amount due" rather than inside the sum — except the part that used up an
 * overpayment, which is exactly what took a credit back to nothing, and so reads above it.
 */
export function Totals({
  totals,
  paidCents,
  balanceCents,
  refundedCents,
  paidLabel = 'Paid',
  children,
  className,
  testId = 'money-totals',
}: {
  totals: TotalsShape;
  /** Given, an invoice's block ends with what's still owed instead of the total. */
  paidCents?: number;
  balanceCents?: number;
  refundedCents?: number;
  paidLabel?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const discounted = totals.discountCents > 0;
  const owes = balanceCents !== undefined;
  const refund = refundShares(totals.totalCents, paidCents ?? 0, refundedCents ?? 0);
  return (
    <div className={className} data-testid={testId}>
      <TotalRow
        label="Subtotal"
        value={money(totals.subtotalCents + totals.discountCents)}
        testId="totals-subtotal"
      />
      {discounted ? (
        <TotalRow
          label={
            totals.discountPercentBp
              ? `${percentLabel(totals.discountPercentBp)} off, before tax`
              : 'Off the whole job, before tax'
          }
          value={`−${money(totals.discountCents)}`}
          credit
          testId="totals-discount"
        />
      ) : null}
      {totals.taxRateBp > 0 ? (
        <TotalRow
          label={`${totals.taxLabel ?? 'Sales tax'} · ${percentLabel(totals.taxRateBp)} on ${money(totals.taxableBaseCents)}`}
          value={money(totals.taxCents)}
          testId="totals-tax"
        />
      ) : null}
      <TotalRow label="Total" value={money(totals.totalCents)} big={!owes} testId="totals-total" />
      {owes ? (
        <>
          {paidCents ? (
            <TotalRow
              label={paidLabel}
              value={`−${money(paidCents)}`}
              credit
              testId="totals-paid"
            />
          ) : null}
          {refund.fromOverpaymentCents ? (
            <TotalRow
              label="Overpayment given back"
              value={money(refund.fromOverpaymentCents)}
              testId="totals-overpayment"
            />
          ) : null}
          <TotalRow label="Amount due" value={money(balanceCents)} big testId="totals-balance" />
          {refund.givenBackCents ? (
            <TotalRow
              label="Refunded to the customer"
              value={money(refund.givenBackCents)}
              testId="totals-refunded"
            />
          ) : null}
        </>
      ) : null}
      {children}
    </div>
  );
}

/** The quiet grey note under a totals block or beside a setting. */
export function MoneyNote({
  icon,
  children,
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mt-3 flex items-start gap-2 rounded-menu bg-card-2 px-3 py-2.5 text-[12.5px] leading-[1.45] text-text-2',
        className,
      )}
    >
      {icon ? <span className="mt-px flex-none">{icon}</span> : null}
      <span>{children}</span>
    </div>
  );
}
