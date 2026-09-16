/** What money is called on screen, and the sentences the pages, the messages and the audit log share. */
import { describe, expect, it } from 'vitest';
import {
  acceptanceWording,
  acceptedWording,
  declinedWording,
  dueWording,
  ESTIMATE_STATUSES,
  ESTIMATE_WORDS,
  expiryPhrase,
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

  it('names each invoice state, plus overdue, paying and money given back', () => {
    for (const status of INVOICE_STATUSES) expect(INVOICE_WORDS[status]).toBeTruthy();
    expect(INVOICE_WORDS.partly_paid).toBe('Partly paid');
    expect(INVOICE_WORDS.overdue).toBe('Overdue');
    expect(INVOICE_WORDS.paying).toBe('Paying');
    expect(INVOICE_WORDS.refunded).toBe('Refunded');
    expect(INVOICE_WORDS.partly_refunded).toBe('Partly refunded');
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

  it('names the figure and the business in the sentence the customer agrees to', () => {
    const sentence = acceptanceWording(860_476, 'Lone Star HVAC & Roofing');
    expect(sentence).toBe(
      'By typing my name I approve this estimate for $8,604.76 from Lone Star HVAC & Roofing.',
    );
    // It is stored word for word, so it has to fit the column that keeps it.
    expect(acceptanceWording(100_000_000_000, 'A'.repeat(200)).length).toBeLessThanOrEqual(1_000);
    // A business with no name still gets a sentence that reads, and a round figure keeps no stray cents.
    expect(acceptanceWording(2_500, '  ')).toBe(
      'By typing my name I approve this estimate for $25 from this business.',
    );
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

  it('says how long an estimate is good for, from the day it stays good through', () => {
    expect(expiryWording('2026-10-15', NOW, TZ)).toBe('Good through Thu, Oct 15');
    expect(expiryWording('2026-09-15', NOW, TZ)).toBe('Expires today');
    expect(expiryWording('2026-09-16', NOW, TZ)).toBe('Expires tomorrow');
    expect(expiryWording('2026-09-14', NOW, TZ)).toBe('Expired');
    expect(expiryWording(null, NOW, TZ)).toBe('No expiry');
  });

  it('says the same thing inside a line, in the voice the list writes in', () => {
    expect(expiryPhrase('2026-10-15', NOW, TZ)).toBe('good until Thu, Oct 15');
    expect(expiryPhrase('2026-09-15', NOW, TZ)).toBe('good until today');
    expect(expiryPhrase('2026-09-16', NOW, TZ)).toBe('good until tomorrow');
    expect(expiryPhrase('2026-09-14', NOW, TZ)).toBe('expired');
    expect(expiryPhrase(null, NOW, TZ)).toBe('no expiry');
    expect(`Sent Thu, Sep 17 · opened · ${expiryPhrase('2026-09-18', NOW, TZ)}`).toBe(
      'Sent Thu, Sep 17 · opened · good until Fri, Sep 18',
    );
  });

  it('holds at 11 PM in Chicago, where a date read as an instant slips a day', () => {
    // 23:00 in Chicago is already tomorrow in UTC, and the stored date is UTC midnight if anyone parses it.
    const lateOn30th = at('2026-09-30', '23:00');
    expect(lateOn30th.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(Date.parse('2026-09-30')).toBe(Date.parse('2026-09-30T00:00:00.000Z'));

    expect(expiryWording('2026-09-30', lateOn30th, TZ)).toBe('Expires today');
    expect(expiryWording('2026-10-01', lateOn30th, TZ)).toBe('Expires tomorrow');
    expect(expiryWording('2026-10-05', lateOn30th, TZ)).toBe('Good through Mon, Oct 5');
    expect(expiryWording('2026-09-29', lateOn30th, TZ)).toBe('Expired');

    // The two voices share the arithmetic, so neither can drift from the other.
    expect(expiryPhrase('2026-09-30', lateOn30th, TZ)).toBe('good until today');
    expect(expiryPhrase('2026-09-29', lateOn30th, TZ)).toBe('expired');

    // Its sibling counts the same days: neither sends the customer a day early.
    expect(dueWording('2026-09-30', lateOn30th, TZ)).toBe('Due today');
    expect(dueWording('2026-09-29', lateOn30th, TZ)).toBe('1 day overdue');
  });
});

describe('amounts in words', () => {
  it('says what is owed and what was quoted', () => {
    expect(owedWording(124_000)).toBe('$1,240 owed');
    expect(owedWording(124_050)).toBe('$1,240.50 owed');
    expect(quotedWording(840_000)).toBe('$8,400 quoted');
  });
});
