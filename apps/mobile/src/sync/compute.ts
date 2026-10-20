import { balanceCents } from '@hfos/core';

import type { InvoicesRow } from './schema';

/**
 * What the phone works out for itself (the plan's "What the phone works out", pitfall 9). `search_text` and
 * `balance_cents` are generated columns, and Postgres 17 doesn't replicate generated columns, so they never reach the
 * phone: these give the same answers from the columns that do. The search text lives in core
 * (`crm/search-text.ts`), since the phone's offline search reads it too; it's re-exported here for the pickers.
 */
export { companySearchText, leadSearchText, matchesSearch, personSearchText } from '@hfos/core';

/**
 * What's still owed on an invoice, with core's own sum (the same as `invoices.balance_cents`): total less paid, and a
 * refund only ever uses up an overpayment.
 */
export function invoiceBalanceCents(
  invoice: Pick<InvoicesRow, 'total_cents' | 'amount_paid_cents' | 'amount_refunded_cents'>,
): number {
  return balanceCents(
    invoice.total_cents ?? 0,
    invoice.amount_paid_cents ?? 0,
    invoice.amount_refunded_cents ?? 0,
  );
}
