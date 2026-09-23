import {
  canBill,
  effectivePermissions,
  invoiceState,
  moneyTabsFor,
  seesWholeBusiness,
} from '@hfos/core';

import type { OutboxRow } from '@/changes/outbox';

import { isWaiting, withOwnChanges } from '../outbox';
import type { InvoiceRow } from '../use-money';

/**
 * Money on the phone: cash or a check recorded here showing on the invoice the moment it is pressed, the invoice's
 * state following from it the way the server's roll-up would, and who sees what.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TZ = 'America/Chicago';
const T0 = Date.parse('2026-09-22T13:26:00.000Z');

let seq = 0;
function row(
  name: string,
  input: Record<string, unknown>,
  extra: Partial<OutboxRow> = {},
): OutboxRow {
  seq += 1;
  return {
    id: `change-${seq}`,
    command_id: `cmd-${seq}`,
    name,
    workspace_id: WS,
    input: JSON.stringify({ workspaceId: WS, ...input }),
    made_at: new Date(T0 + seq * 1000).toISOString(),
    depends_on: '[]',
    track: 'queue',
    state: 'waiting',
    reason: null,
    disposition: null,
    rule: null,
    answer: null,
    attempts: 0,
    revision: 0,
    confirmed_at: null,
    seq,
    queued_at: new Date(T0).toISOString(),
    settled_at: new Date(T0).toISOString(),
    sent_at: null,
    ...extra,
  };
}

/** Bayou Bistro's invoice from the canvas: $1,313.83, sent, nothing paid. */
const invoice = (over: Partial<InvoiceRow> = {}): InvoiceRow =>
  ({
    id: INV,
    number: 'INV-1039',
    status: 'sent',
    purpose: 'job',
    origin: 'manual',
    title: 'Walk-in cooler line repair',
    person_id: null,
    person_name: 'Bayou Bistro',
    person_email: 'elena@bayoubistro.example',
    person_phone: null,
    total_cents: 131_383,
    amount_paid_cents: 0,
    amount_refunded_cents: 0,
    balance_cents: 131_383,
    settling: 0,
    due_on: '2026-09-25',
    terms: 'Net 14',
    sent_at: '2026-09-11T15:00:00.000Z',
    first_viewed_at: null,
    paid_at: null,
    voided_at: null,
    created_at: '2026-09-11T15:00:00.000Z',
    subtotal_cents: 128_000,
    discount_cents: 0,
    discount_percent_bp: 0,
    taxable_base_cents: 41_000,
    tax_cents: 3_383,
    tax_rate_bp: 825,
    tax_label: 'TX sales tax',
    notes: null,
    attendee_id: null,
    estimate_id: null,
    subscription_id: null,
    ...over,
  }) as InvoiceRow;

const cash = (amountCents: number, extra: Partial<OutboxRow> = {}) =>
  row(
    'invoice.record_cash_payment',
    { invoiceId: INV, amountCents, method: 'check', reference: '4127' },
    extra,
  );

describe('cash or a check recorded on this phone', () => {
  it('shows on the invoice at once, and takes it to part paid', () => {
    const out = withOwnChanges(invoice(), [cash(50_000)]);
    expect(out.amount_paid_cents).toBe(50_000);
    expect(out.balance_cents).toBe(81_383);
    expect(out.status).toBe('partly_paid');
    expect(isWaiting({ pending: out.pending })).toBe(true);
  });

  it('takes it to paid when the whole balance is handed over, as the roll-up would', () => {
    const out = withOwnChanges(invoice(), [cash(131_383)]);
    expect(out.status).toBe('paid');
    expect(out.balance_cents).toBe(0);
    // Only HandsFreeOS can say when it was marked paid, so the date waits for its own row.
    expect(out.paid_at).toBe(null);
    expect(
      invoiceState(
        {
          status: out.status as never,
          dueDate: out.due_on,
          timeZone: TZ,
          balanceCents: out.balance_cents!,
          totalCents: out.total_cents!,
          paidCents: out.amount_paid_cents!,
          refundedCents: 0,
        },
        T0,
      ),
    ).toBe('paid');
  });

  it('adds two payments made here together', () => {
    const out = withOwnChanges(invoice(), [cash(50_000), cash(81_383)]);
    expect(out.amount_paid_cents).toBe(131_383);
    expect(out.status).toBe('paid');
  });

  it('stops counting once the change has gone through or been refused', () => {
    for (const state of ['sent', 'refused'] as const) {
      const out = withOwnChanges(invoice(), [cash(50_000, { state })]);
      expect(out.amount_paid_cents).toBe(0);
      expect(out.status).toBe('sent');
    }
  });

  it('leaves another invoice alone', () => {
    const out = withOwnChanges(invoice(), [
      row('invoice.record_cash_payment', { invoiceId: 'other', amountCents: 5_000 }),
    ]);
    expect(out.amount_paid_cents).toBe(0);
    expect(out.pending).toBe(null);
  });

  it('never moves a draft or a voided invoice', () => {
    expect(withOwnChanges(invoice({ status: 'draft' }), [cash(10_000)]).status).toBe('draft');
    expect(withOwnChanges(invoice({ status: 'void' }), [cash(10_000)]).status).toBe('void');
  });

  it('marks a document sent from here as waiting, without pretending it has a number yet', () => {
    const out = withOwnChanges(invoice({ number: null, status: 'draft' }), [
      row('invoice.send', { invoiceId: INV, channels: ['email'], message: null }),
    ]);
    expect(out.number).toBe(null);
    expect(out.status).toBe('draft');
    expect(out.pending).toMatchObject({ name: 'invoice.send', state: 'waiting' });
  });
});

describe('who sees what', () => {
  const owner = effectivePermissions('owner');
  const member = effectivePermissions('member');

  it('gives an owner the whole business and a member their own jobs', () => {
    expect(seesWholeBusiness(owner)).toBe(true);
    expect(moneyTabsFor(owner)).toHaveLength(4);
    expect(seesWholeBusiness(member)).toBe(false);
    expect(moneyTabsFor(member)).toEqual(['invoices', 'estimates']);
  });

  it('lets a member the business lets bill send from their own jobs, still without the totals (0105)', () => {
    const billing = effectivePermissions('member', { 'money.bill': true });
    expect(canBill(member)).toBe(false);
    expect(canBill(billing)).toBe(true);
    expect(seesWholeBusiness(billing)).toBe(false);
    expect(moneyTabsFor(billing)).toEqual(['invoices', 'estimates']);
  });
});
