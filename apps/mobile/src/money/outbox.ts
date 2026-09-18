import type { OutboxRow } from '@/changes/outbox';
import { inputOf, stillStanding } from '@/inbox/outbox';

import type { InvoiceRow, PhoneInvoice } from './use-money';

/**
 * Money's changes on this phone, over the synced rows.
 *
 * There is only one that changes what an invoice says: **cash or a check recorded at the door**
 * (`invoice.record_cash_payment`, which works with no signal for as long as it takes). The moment it is pressed, the
 * invoice shows the money against it — part paid, or paid — even though HandsFreeOS hasn't heard yet. The rest of the
 * invoice's own arithmetic then follows from that, because `invoiceState` is given the same figures the server would
 * be given (core's `invoiceStatusForPayments`, arm for arm with the database's roll-up).
 *
 * Sending a document (`invoice.send`, `estimate.send`) reaches a customer, so it waits like any fresh change; the
 * screen shows it as waiting rather than pretending the number has been taken, because the number is only allocated
 * when HandsFreeOS actually sends it.
 */

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export interface MoneyPending {
  readonly id: string;
  readonly state: OutboxRow['state'];
  readonly name: string;
}

/**
 * One invoice as this phone's own changes leave it: every cash or check recorded here that HandsFreeOS hasn't
 * confirmed added to what has been paid, and the status moved the way the roll-up would move it.
 */
export function withOwnChanges(
  row: InvoiceRow,
  rows: readonly OutboxRow[],
): InvoiceRow & { readonly pending: MoneyPending | null } {
  let paid = row.amount_paid_cents ?? 0;
  let pending: MoneyPending | null = null;
  for (const change of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (!stillStanding(change)) continue;
    const input = inputOf(change);
    if (str(input.invoiceId) !== row.id) continue;
    pending = { id: change.id, state: change.state, name: change.name };
    if (change.name !== 'invoice.record_cash_payment') continue;
    paid += num(input.amountCents) ?? 0;
  }
  if (paid === (row.amount_paid_cents ?? 0)) return { ...row, pending };
  const total = row.total_cents ?? 0;
  const refunded = row.amount_refunded_cents ?? 0;
  const status =
    row.status === 'draft' || row.status === 'void'
      ? row.status
      : total > 0 && paid >= total
        ? 'paid'
        : paid > 0
          ? 'partly_paid'
          : row.status;
  return {
    ...row,
    amount_paid_cents: paid,
    balance_cents: Math.max(total - paid, Math.min(0, total - paid + refunded)),
    status,
    // Nothing on this phone can say when HandsFreeOS marked it paid, so the date waits for the real row.
    paid_at: status === 'paid' ? (row.paid_at ?? null) : row.paid_at,
    pending,
  };
}

/** Whether a document has a change of its own still waiting on this phone. */
export const isWaiting = (inv: Pick<PhoneInvoice, 'pending'>): boolean =>
  inv.pending !== null && inv.pending.state !== 'sent';
