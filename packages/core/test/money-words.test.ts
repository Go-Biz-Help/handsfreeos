/** What money is called on screen, and the sentences the pages, the messages and the audit log share. */
import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_WORDING,
  acceptedWording,
  declinedWording,
  dueWording,
  ESTIMATE_STATUSES,
  ESTIMATE_WORDS,
  expiryWording,
  INVOICE_STATUSES,
  INVOICE_WORDS,
  owedWording,
  paidWording,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_WORDS,
  PAYMENT_METHODS,
  PAYMENT_STATUS_WORDS,
  PAYMENT_STATUSES,
  payingWording,
  quotedWording,
  refundedWording,
  soonLabel,
  TERMS_OPTIONS,
  TERMS_WORDS,
} from '../src/money/index';
import { at, NOW, TZ } from './attention-fixtures';

describe('what every state is called', () => {
  it('names each estimate state, stored or worked out', () => {
    for (const status of ESTIMATE_STATUSES) expect(ESTIMATE_WORDS[status]).toBeTruthy();
    expect(ESTIMATE_WORDS.accepted).toBe('Approved');
    expect(ESTIMATE_WORDS.viewed).toBe('Opened');
  });

  it('names each invoice state, plus overdue and paying', () => {
    for (const status of INVOICE_STATUSES) expect(INVOICE_WORDS[status]).toBeTruthy();
    expect(INVOICE_WORDS.partly_paid).toBe('Partly paid');
    expect(INVOICE_WORDS.overdue).toBe('Overdue');
    expect(INVOICE_WORDS.paying).toBe('Paying');
  });

  it('names each payment state, method and terms', () => {
    for (const status of PAYMENT_STATUSES) expect(PAYMENT_STATUS_WORDS[status]).toBeTruthy();
    for (const method of PAYMENT_METHODS) {
      expect(PAYMENT_METHOD_WORDS[method]).toBeTruthy();
      expect(PAYMENT_METHOD_LABELS[method]).toBeTruthy();
    }
    expect(PAYMENT_METHOD_WORDS.ach).toBe('bank transfer');
    expect(PAYMENT_METHOD_LABELS.ach).toBe('Bank transfer');
    expect(TERMS_WORDS.due_on_receipt).toBe('Due on receipt');
    expect(TERMS_OPTIONS.map((o) => o.label)).toEqual([
      'Due on receipt',
      'Net 7',
      'Net 14',
      'Net 30',
    ]);
  });
});

describe('the acceptance', () => {
  it('reads back exactly who approved it and when', () => {
    expect(acceptedWording('Maria Lopez', at('2026-09-22', '16:12'), TZ)).toBe(
      'Approved by Maria Lopez on Tue, Sep 22 at 4:12 PM',
    );
    expect(declinedWording('  Maria L. ', at('2026-09-22', '16:12'), TZ)).toBe(
      'Declined by Maria L. on Tue, Sep 22 at 4:12 PM',
    );
  });

  it('has one sentence the customer agrees to, stored word for word', () => {
    expect(ACCEPTANCE_WORDING).toContain('typing your name');
    expect(ACCEPTANCE_WORDING).toContain('Approve');
    expect(ACCEPTANCE_WORDING.length).toBeLessThanOrEqual(1_000);
  });
});

describe('payments in words', () => {
  it('says a bank transfer is on its way, not late', () => {
    expect(
      payingWording({
        method: 'ach',
        expectedAt: at('2026-09-18', '12:00'),
        timeZone: TZ,
        now: NOW,
      }),
    ).toBe('Paying — bank transfer, expected by Fri');
  });

  it('says just the method when nothing is being waited on', () => {
    expect(payingWording({ method: 'card', expectedAt: null, timeZone: TZ, now: NOW })).toBe(
      'Paying — card',
    );
  });

  it('gives a day its name this week and its date beyond it', () => {
    expect(soonLabel(at('2026-09-15', '16:00'), NOW, TZ)).toBe('today');
    expect(soonLabel(at('2026-09-16', '09:00'), NOW, TZ)).toBe('tomorrow');
    expect(soonLabel(at('2026-09-18', '09:00'), NOW, TZ)).toBe('Fri');
    expect(soonLabel(at('2026-09-30', '09:00'), NOW, TZ)).toBe('Wed, Sep 30');
  });

  it('records what was paid and what came back', () => {
    expect(paidWording(124_000, 'card', at('2026-09-22', '16:12'), TZ)).toBe(
      'Paid $1,240 by card on Tue, Sep 22 at 4:12 PM',
    );
    expect(refundedWording(25_050, at('2026-09-22', '16:12'), TZ)).toBe(
      '$250.50 refunded on Tue, Sep 22',
    );
  });
});

describe('dates in words', () => {
  it('says when an invoice is due, and how late it is', () => {
    expect(dueWording('2026-09-15', NOW, TZ)).toBe('Due today');
    expect(dueWording('2026-09-16', NOW, TZ)).toBe('Due tomorrow');
    expect(dueWording('2026-09-18', NOW, TZ)).toBe('Due Fri');
    expect(dueWording('2026-09-30', NOW, TZ)).toBe('Due Wed, Sep 30');
    expect(dueWording('2026-09-14', NOW, TZ)).toBe('1 day overdue');
    expect(dueWording('2026-09-12', NOW, TZ)).toBe('3 days overdue');
    expect(dueWording(null, NOW, TZ)).toBe('No due date');
  });

  it('says how long an estimate is good for', () => {
    expect(expiryWording(at('2026-10-15', '10:00').toISOString(), NOW, TZ)).toBe(
      'Good through Thu, Oct 15',
    );
    expect(expiryWording(at('2026-09-15', '23:00').toISOString(), NOW, TZ)).toBe('Expires today');
    expect(expiryWording(at('2026-09-16', '10:00').toISOString(), NOW, TZ)).toBe(
      'Expires tomorrow',
    );
    expect(expiryWording(at('2026-09-14', '10:00').toISOString(), NOW, TZ)).toBe('Expired');
    expect(expiryWording(null, NOW, TZ)).toBe('No expiry');
  });
});

describe('amounts in words', () => {
  it('says what is owed and what was quoted', () => {
    expect(owedWording(124_000)).toBe('$1,240 owed');
    expect(owedWording(124_050)).toBe('$1,240.50 owed');
    expect(quotedWording(840_000)).toBe('$8,400 quoted');
  });
});
