/**
 * The words customers read about money (M9 step 6): the estimate, the invoice, each rung of the reminder
 * ladder, the receipt and a payment that didn't go through — and the team's "you've been paid".
 *
 * Two things are checked for every one of them, not just the ones spelled out below:
 * - **Texts stay in the texting alphabet**: straight apostrophes, no curly quotes, no ellipsis, no en dash.
 *   One curly character sends a text as 70-character parts instead of 160.
 * - **Nothing ever says what a way of paying costs the business.** Bank transfer leads on the customer's page
 *   because it is the cheap rail; no message prices it, compares it, or asks anyone to pick it to save money.
 */
import { describe, expect, it } from 'vitest';
import { invoicePaidEmail } from '../src/emails/templates';
import {
  estimateNudgeEmail,
  estimateNudgeText,
  estimateSentEmail,
  estimateSentText,
  invoiceReminderEmail,
  invoiceReminderText,
  invoiceSentEmail,
  invoiceSentText,
  paymentFailedEmail,
  paymentFailedText,
  receiptEmail,
  receiptText,
  reminderKeyOf,
  reminderOffsetOf,
  type MoneyBusiness,
} from '../src/money/messages';

const TZ = 'America/Chicago';
/** Wed, Sep 16 2026, 10:00 AM in Houston. */
const NOW = Date.parse('2026-09-16T15:00:00Z');
const LONE_STAR: MoneyBusiness = { name: 'Lone Star HVAC', phoneDisplay: '(713) 555-0100' };
const E_URL = 'http://localhost:3000/e/7Kd2mQp4aB9xLm3nZq';
const I_URL = 'http://localhost:3000/i/3Nf8vRt6cD2yPk5wXs';

const estimate = {
  business: LONE_STAR,
  firstName: 'Maria',
  number: 'EST-1001',
  title: 'AC tune-up',
  totalCents: 18_000,
  expiresOn: '2026-10-16',
  timeZone: TZ,
  now: NOW,
  url: E_URL,
  first: false,
};

const invoice = {
  business: LONE_STAR,
  firstName: 'Maria',
  number: 'INV-1001',
  title: 'AC tune-up',
  totalCents: 18_000,
  balanceCents: 18_000,
  dueOn: '2026-09-18',
  timeZone: TZ,
  now: NOW,
  url: I_URL,
  first: false,
};

const payment = {
  business: LONE_STAR,
  firstName: 'Maria',
  number: 'INV-1001',
  amountCents: 18_000,
  balanceCents: 0,
  method: 'card' as const,
  receivedAt: NOW,
  timeZone: TZ,
  now: NOW,
  url: I_URL,
  first: false,
};

describe('what an estimate says', () => {
  it('names the job, the price and the day it stops being good, and carries their own link', () => {
    expect(estimateSentText(estimate)).toBe(
      `Lone Star HVAC: Your estimate for an AC tune-up is ready, $180. It's good through Fri, Oct 16. Approve it here: ${E_URL}`,
    );
    const email = estimateSentEmail(estimate);
    expect(email.subject).toBe('Estimate EST-1001 from Lone Star HVAC');
    expect(email.body).toBe(
      [
        'Hi Maria, here’s your estimate for an AC tune-up.',
        '',
        'Estimate: EST-1001',
        'Total: $180',
        'Good through: Fri, Oct 16',
        '',
        `Approve or decline it here: ${E_URL}`,
        '',
        'Lone Star HVAC · (713) 555-0100',
      ].join('\n'),
    );
  });

  it('carries the STOP wording on a first text, and nothing about replying CANCEL', () => {
    const first = estimateSentText({ ...estimate, first: true });
    expect(first.endsWith('Reply STOP to opt out.')).toBe(true);
    expect(first).not.toMatch(/CANCEL|reply YES/i);
  });

  it('nudges once, without pressing', () => {
    expect(estimateNudgeText(estimate)).toBe(
      `Lone Star HVAC: Just checking you saw your estimate for an AC tune-up, $180. It's good through Fri, Oct 16. Approve it here: ${E_URL}`,
    );
    const email = estimateNudgeEmail(estimate);
    expect(email.subject).toBe('Still thinking it over? Estimate EST-1001');
    expect(email.body).toContain('If the timing isn’t right, just tell us — there’s no rush.');
  });

  it('says "your estimate" when it somehow has no number, and leaves the expiry out when it has none', () => {
    expect(estimateSentText({ ...estimate, number: null, title: null, expiresOn: null })).toBe(
      `Lone Star HVAC: Your estimate is ready, $180. Approve it here: ${E_URL}`,
    );
    expect(estimateSentEmail({ ...estimate, number: null }).subject).toBe(
      'Your estimate from Lone Star HVAC',
    );
  });
});

describe('what an invoice says', () => {
  it('names the invoice, the amount and when it is due', () => {
    expect(invoiceSentText(invoice)).toBe(
      `Lone Star HVAC: Invoice INV-1001 for an AC tune-up is ready, $180. It's due Fri. Pay it here: ${I_URL}`,
    );
    const email = invoiceSentEmail(invoice);
    expect(email.subject).toBe('Invoice INV-1001 from Lone Star HVAC');
    expect(email.body).toContain('Amount: $180');
    expect(email.body).toContain('Due: Fri, Sep 18');
    expect(email.body).toContain(`Pay it here: ${I_URL}`);
  });

  it('shows what is still owed when part of it is paid', () => {
    const email = invoiceSentEmail({ ...invoice, balanceCents: 10_000 });
    expect(email.body).toContain('Amount: $180');
    expect(email.body).toContain('Owed: $100');
  });
});

describe('what each rung of the ladder says', () => {
  const rung = (when: 'before' | 'on' | 'after', days: number, dueOn: string) =>
    invoiceReminderText({ ...invoice, dueOn, step: { when, days } });

  it('asks before the due day, on it, and after it', () => {
    expect(rung('before', 3, '2026-09-18')).toBe(
      `Lone Star HVAC: A reminder that invoice INV-1001 for $180 is due Fri. Pay it here: ${I_URL}`,
    );
    expect(rung('on', 0, '2026-09-16')).toBe(
      `Lone Star HVAC: Invoice INV-1001 for $180 is due today. Pay it here: ${I_URL}`,
    );
    expect(rung('after', 7, '2026-09-09')).toBe(
      `Lone Star HVAC: Invoice INV-1001 for $180 was due Wed, Sep 9 and is still unpaid. Pay it here: ${I_URL}`,
    );
  });

  it('chases the balance, not the total', () => {
    expect(
      invoiceReminderText({
        ...invoice,
        balanceCents: 8_000,
        dueOn: '2026-09-16',
        step: { when: 'on', days: 0 },
      }),
    ).toContain('for $80 is due today');
  });

  it('allows for a payment that crossed in the post', () => {
    const email = invoiceReminderEmail({
      ...invoice,
      dueOn: '2026-09-09',
      step: { when: 'after', days: 7 },
    });
    expect(email.subject).toBe('Invoice INV-1001 is past due');
    expect(email.body).toContain('If you’ve already sent it, thank you');
    expect(invoiceReminderEmail({ ...invoice, step: { when: 'on', days: 0 } }).subject).toBe(
      'Invoice INV-1001 is due today',
    );
    expect(invoiceReminderEmail({ ...invoice, step: { when: 'before', days: 3 } }).subject).toBe(
      'Invoice INV-1001 is due Fri',
    );
  });

  it('names each rung the way its job and its record do', () => {
    expect(reminderKeyOf({ when: 'before', days: 3 })).toBe('before_3');
    expect(reminderKeyOf({ when: 'on', days: 0 })).toBe('on_due');
    expect(reminderKeyOf({ when: 'after', days: 14 })).toBe('after_14');
    expect(reminderOffsetOf({ when: 'before', days: 3 })).toBe(-3);
    expect(reminderOffsetOf({ when: 'on', days: 0 })).toBe(0);
    expect(reminderOffsetOf({ when: 'after', days: 14 })).toBe(14);
  });
});

describe('what a payment brings', () => {
  it('thanks them, and says what is left when something is', () => {
    expect(receiptText(payment)).toBe(
      `Lone Star HVAC: Thanks, Maria. We got your $180 payment for invoice INV-1001. Your receipt: ${I_URL}`,
    );
    expect(receiptText({ ...payment, amountCents: 8_000, balanceCents: 10_000 })).toBe(
      `Lone Star HVAC: Thanks, Maria. We got your $80 payment for invoice INV-1001. $100 is still owed. Your receipt: ${I_URL}`,
    );
    const email = receiptEmail(payment);
    expect(email.subject).toBe('Receipt from Lone Star HVAC: $180');
    expect(email.body).toContain('Paid: $180 by card');
    expect(email.body).toContain('When: Wed, Sep 16 at 10:00 AM');
  });

  it('says a bank transfer is a bank transfer, and never what it costs', () => {
    const email = receiptEmail({ ...payment, method: 'ach' });
    expect(email.body).toContain('Paid: $180 by bank transfer');
    expect(email.body).not.toMatch(/ACH/);
  });

  it('says plainly that nothing was taken when a payment failed', () => {
    expect(paymentFailedText({ ...payment, balanceCents: 18_000 })).toBe(
      `Lone Star HVAC: Your $180 payment for invoice INV-1001 didn't go through, so nothing was taken. You can try again here: ${I_URL}`,
    );
    const email = paymentFailedEmail({ ...payment, balanceCents: 18_000 });
    expect(email.subject).toBe('Your payment to Lone Star HVAC didn’t go through');
    expect(email.body).toContain('so nothing was taken');
    expect(email.body).toContain(`You can try again here: ${I_URL}`);
  });
});

describe('the team hears they have been paid', () => {
  it('says who paid, what for and how much, with one way in', () => {
    const mail = invoicePaidEmail({
      customer: 'Maria Lopez',
      invoice: 'INV-1001',
      title: 'AC tune-up',
      amountCents: 18_000,
      totalCents: 18_000,
      method: 'card',
      link: 'http://localhost:3000/app/w/ws/money/invoices/abc',
    });
    expect(mail.subject).toBe('You’ve been paid: Maria Lopez, $180');
    expect(mail.text).toContain('Maria Lopez paid invoice INV-1001 — $180 by card.');
    expect(mail.text).toContain('For: AC tune-up');
    expect(mail.text).toContain('Paid: $180 by card');
    expect(mail.text).toContain(
      'Open in HandsFreeOS: http://localhost:3000/app/w/ws/money/invoices/abc',
    );
    expect(mail.html).toContain('<strong>Maria Lopez</strong>');
  });

  it('says so when the last payment only finished it off', () => {
    const mail = invoicePaidEmail({
      customer: 'Maria Lopez',
      invoice: 'INV-1001',
      title: null,
      amountCents: 8_000,
      totalCents: 18_000,
      method: 'ach',
      link: 'http://localhost:3000/app/w/ws/money/invoices/abc',
    });
    expect(mail.text).toContain(
      'Maria Lopez has now paid invoice INV-1001 in full — $180. The last payment was $80 by bank transfer.',
    );
  });
});

// ---- The two rules that hold for every message ----

/** Every text a customer can get, over the inputs that change the wording. */
const everyText = (): string[] => {
  const out: string[] = [];
  for (const first of [false, true])
    for (const number of ['INV-1001', null])
      for (const title of ['AC tune-up', null]) {
        const e = { ...estimate, first, number: number && 'EST-1001', title };
        const i = { ...invoice, first, number, title };
        const p = { ...payment, first, number };
        out.push(estimateSentText(e), estimateNudgeText(e), invoiceSentText(i));
        for (const step of [
          { when: 'before' as const, days: 3 },
          { when: 'on' as const, days: 0 },
          { when: 'after' as const, days: 7 },
        ])
          out.push(invoiceReminderText({ ...i, step }));
        for (const method of ['card', 'ach', 'cash', 'check', 'other'] as const)
          out.push(receiptText({ ...p, method }), paymentFailedText({ ...p, method }));
      }
  return out;
};

/** Every email body a customer can get. */
const everyEmail = (): string[] => [
  ...[estimateSentEmail(estimate), estimateNudgeEmail(estimate)].map(
    (m) => `${m.subject}\n${m.body}`,
  ),
  ...[
    invoiceSentEmail(invoice),
    invoiceReminderEmail({ ...invoice, step: { when: 'before', days: 3 } }),
    invoiceReminderEmail({ ...invoice, step: { when: 'on', days: 0 } }),
    invoiceReminderEmail({ ...invoice, step: { when: 'after', days: 7 } }),
  ].map((m) => `${m.subject}\n${m.body}`),
  ...(['card', 'ach', 'cash', 'check', 'other'] as const).flatMap((method) =>
    [receiptEmail({ ...payment, method }), paymentFailedEmail({ ...payment, method })].map(
      (m) => `${m.subject}\n${m.body}`,
    ),
  ),
];

/**
 * Curly quotes, an en or em dash, an ellipsis or a non-breaking space: any one of them sends a text as
 * 70-character parts instead of 160. Built from escapes, so nothing can paste one back in.
 */
const OUTSIDE_THE_TEXTING_ALPHABET = new RegExp(
  '[\\u2018\\u2019\\u201c\\u201d\\u2013\\u2014\\u2026\\u00a0]',
);

describe('the rules every money message keeps', () => {
  it('sends texts in the texting alphabet, with the link last', () => {
    for (const body of everyText()) {
      expect(body, body).not.toMatch(OUTSIDE_THE_TEXTING_ALPHABET);
      expect(body, body).not.toMatch(/reply (cancel|yes)/i);
      expect(body, body).toMatch(/http:\/\/localhost:3000\/[ei]\//);
    }
  });

  it('never says what a way of paying costs the business', () => {
    // Naming a way of paying is a fact ("Paid: $180 by bank transfer"); pricing one is what Chris cut.
    const money =
      /fee|surcharge|cheaper|cheapest|costs? (us|less|more)|saves? (you|us)|%|discount if|convenience charge|processing charge/i;
    for (const body of [...everyText(), ...everyEmail()]) expect(body, body).not.toMatch(money);
  });
});
