/**
 * The guided payments setup's own logic (guided-setup/payments.ts), with no database: where the answers start (the
 * kind of business, P2, or the business's own settings), which questions a path asks, what is wrong with an answer,
 * the settings Save writes for money.save_settings, and the lines beside the questions and on Settings → Payments.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultMoneySettings,
  MoneySettings,
  parseMoneySettings,
  paymentsCentsOf,
  paymentsRateOf,
  paymentsRemindersOf,
  paymentsSettingsConfigured,
  paymentsSetupAccountOf,
  paymentsSetupAnswersOf,
  paymentsSetupContextFrom,
  paymentsSetupFirstProblem,
  paymentsSetupLines,
  paymentsSetupProblems,
  paymentsSetupQuestions,
  paymentsSetupSettings,
  paymentsSetupStart,
  paymentsSetupUsualFor,
  paymentsShortAddress,
  type PaymentsSetupAnswers,
  type PaymentsSetupContext,
} from '../src';

const ADDRESS = '2210 Oak St\nHouston, TX 77002';
const stripe = (capabilities: Record<string, unknown>, status = 'active') => ({
  provider: 'stripe',
  status,
  label: null,
  capabilities,
});

const ctxOf = (
  over: {
    connections?: Parameters<typeof paymentsSetupAccountOf>[0];
    settings?: MoneySettings;
    nextInvoiceNumber?: string;
    payPalOpen?: boolean;
  } = {},
): PaymentsSetupContext =>
  paymentsSetupContextFrom({
    connections: over.connections ?? [],
    payPalOpen: over.payPalOpen ?? false,
    money: {
      settings: over.settings ?? defaultMoneySettings(),
      nextEstimateNumber: 'EST-1001',
      nextInvoiceNumber: over.nextInvoiceNumber ?? 'INV-1001',
    },
    setupAddress: ADDRESS,
  });

const NEW = ctxOf();
const roofer = (over: Partial<PaymentsSetupAnswers> = {}): PaymentsSetupAnswers => ({
  ...paymentsSetupStart(NEW, 'roofing'),
  tax: 'yes',
  taxRate: '8.25',
  ...over,
});

describe('where the answers start', () => {
  it('starts a business with no money settings from what its kind usually picks, never guessing the tax', () => {
    expect(NEW.configured).toBe(false);
    expect(NEW.mode).toBe('new');
    const a = paymentsSetupStart(NEW, 'roofing');
    expect(a).toMatchObject({
      where: 'stripe',
      tax: null,
      taxRate: '',
      terms: 'net_14',
      estimates: true,
      estimateDays: '30',
      deposit: 'percent',
      depositPercent: '25',
      reminders: 'usual',
      estimateNudge: true,
      address: ADDRESS,
      invoicePrefix: 'INV-',
      invoiceNext: '1001',
      note: 'Thank you for your business.',
    });
    expect(paymentsSetupUsualFor(NEW, 'roofing')).toBe('Roofing');

    // A salon is paid on the spot and never quotes.
    expect(paymentsSetupStart(NEW, 'hair_salon')).toMatchObject({
      terms: 'due_on_receipt',
      estimates: false,
      deposit: 'none',
      reminders: 'few',
    });
    // No kind, or one the list doesn't know: the plain starting point, and no "usually pick" line.
    expect(paymentsSetupStart(NEW, null)).toMatchObject({ terms: 'net_14', deposit: 'none' });
    expect(paymentsSetupUsualFor(NEW, 'not_a_kind')).toBeNull();
  });

  it('starts a business that has saved its own settings from those, whatever its kind', () => {
    const settings = parseMoneySettings({
      tax: { rateBp: 825, name: 'Sales tax' },
      terms: 'net_30',
      estimateGoodForDays: 21,
      deposit: { kind: 'amount', amountCents: 50_000 },
      businessAddress: 'Lone Star HVAC\n2210 Oak St\nHouston, TX 77002',
    });
    const ctx = ctxOf({ settings });
    expect(ctx.configured).toBe(true);
    expect(paymentsSetupUsualFor(ctx, 'hair_salon')).toBeNull();
    expect(paymentsSetupStart(ctx, 'hair_salon')).toMatchObject({
      tax: 'yes',
      taxRate: '8.25',
      terms: 'net_30',
      estimates: true,
      estimateDays: '21',
      deposit: 'amount',
      depositAmount: '$500',
      address: 'Lone Star HVAC\n2210 Oak St\nHouston, TX 77002',
    });
  });

  it('counts the defaults as nothing saved, and any change as saved', () => {
    expect(paymentsSettingsConfigured(defaultMoneySettings())).toBe(false);
    expect(paymentsSettingsConfigured(parseMoneySettings({ terms: 'net_7' }))).toBe(true);
  });

  it('starts the invoice number where the counter is, not behind it', () => {
    const ctx = ctxOf({ nextInvoiceNumber: 'INV-1042' });
    expect(ctx.settings.numbering.invoice.next).toBe(1042);
    // Sending moved the counter, but that isn't the business saving settings of its own.
    expect(ctx.configured).toBe(false);
    expect(paymentsSetupStart(ctx, 'roofing').invoiceNext).toBe('1042');
  });

  it('reads saved answers back a field at a time, keeping the start for any that no longer fit', () => {
    const start = paymentsSetupStart(NEW, 'roofing');
    const back = paymentsSetupAnswersOf(
      { terms: 'net_30', where: 'venmo', taxRate: '7', estimateDays: 30, extra: true },
      start,
    );
    expect(back.terms).toBe('net_30');
    expect(back.taxRate).toBe('7');
    expect(back.where).toBe(start.where);
    expect(back.estimateDays).toBe(start.estimateDays);
    expect(back).not.toHaveProperty('extra');
    expect(paymentsSetupAnswersOf(null, start)).toEqual(start);
  });
});

describe('the account', () => {
  it('reads an account with nothing switched on yet as still being checked', () => {
    expect(paymentsSetupAccountOf([stripe({})])).toEqual({
      provider: 'stripe',
      label: null,
      state: 'checking',
    });
    expect(paymentsSetupAccountOf([stripe({ card: true })])?.state).toBe('ready');
    expect(paymentsSetupAccountOf([stripe({}, 'reauth_required')])?.state).toBe('broken');
    expect(paymentsSetupAccountOf([stripe({}, 'disconnected')])).toBeNull();
    expect(paymentsSetupAccountOf([])).toBeNull();
  });

  it('asks the same questions without the first once an account is connected', () => {
    const again = ctxOf({ connections: [stripe({ card: true })] });
    expect(again.mode).toBe('again');
    expect(paymentsSetupQuestions(roofer(), again)).toEqual([
      'ways',
      'tax',
      'due',
      'estimates',
      'reminders',
      'documents',
    ]);
  });
});

describe('which questions a path asks', () => {
  it('asks all seven for Stripe, and skips ways to pay for Not now', () => {
    expect(paymentsSetupQuestions(roofer(), NEW)).toHaveLength(7);
    expect(paymentsSetupQuestions(roofer({ where: 'later' }), NEW)).toEqual([
      'where',
      'tax',
      'due',
      'estimates',
      'reminders',
      'documents',
    ]);
  });
});

describe('what is wrong with an answer', () => {
  const paths = (q: Parameters<typeof paymentsSetupProblems>[0], a: PaymentsSetupAnswers) =>
    paymentsSetupProblems(q, a, NEW).map((p) => p.path);

  it('needs a yes or no on sales tax, and a real rate and name for yes', () => {
    expect(paths('tax', roofer({ tax: null }))).toEqual(['tax']);
    expect(paths('tax', roofer({ tax: 'no', taxRate: '' }))).toEqual([]);
    expect(paths('tax', roofer({ taxRate: '8.25%' }))).toEqual([]);
    expect(paths('tax', roofer({ taxRate: '0' }))).toEqual(['taxRate']);
    expect(paths('tax', roofer({ taxRate: '25' }))).toEqual(['taxRate']);
    expect(paths('tax', roofer({ taxName: '  ' }))).toEqual(['taxName']);
  });

  it('checks estimate days and the deposit only when estimates are sent', () => {
    expect(paths('estimates', roofer({ estimateDays: '0' }))).toEqual(['estimateDays']);
    expect(paths('estimates', roofer({ depositPercent: '120' }))).toEqual(['depositPercent']);
    expect(paths('estimates', roofer({ deposit: 'amount', depositAmount: 'lots' }))).toEqual([
      'depositAmount',
    ]);
    expect(
      paths('estimates', roofer({ estimates: false, estimateDays: '0', depositPercent: 'x' })),
    ).toEqual([]);
  });

  it('keeps the invoice number moving forward from the counter', () => {
    const ctx = ctxOf({ nextInvoiceNumber: 'INV-1042' });
    const a = paymentsSetupStart(ctx, 'roofing');
    const problems = paymentsSetupProblems('documents', { ...a, invoiceNext: '1001' }, ctx);
    expect(problems).toEqual([
      { path: 'invoiceNext', message: expect.stringContaining('only moves forward') as string },
    ]);
    expect(paymentsSetupProblems('documents', { ...a, invoiceNext: '2000' }, ctx)).toEqual([]);
    expect(paths('documents', roofer({ invoicePrefix: 'INV 2026' }))).toEqual(['invoicePrefix']);
    expect(paths('documents', roofer({ address: 'a\nb\nc\nd\ne\nf' }))).toEqual(['address']);
  });

  it('refuses PayPal until it is open', () => {
    expect(paths('where', roofer({ where: 'paypal' }))).toEqual(['where']);
    expect(
      paymentsSetupProblems('where', roofer({ where: 'paypal' }), { ...NEW, payPalOpen: true }),
    ).toEqual([]);
  });

  it('sends Save back to the first question with something wrong', () => {
    expect(paymentsSetupFirstProblem(roofer(), NEW)).toBeNull();
    expect(paymentsSetupFirstProblem(roofer({ tax: null, invoicePrefix: '!' }), NEW)).toBe('tax');
  });
});

describe('what Save writes', () => {
  it('writes the answers over the business’s own settings, leaving what the setup doesn’t ask', () => {
    const current = parseMoneySettings({
      numbering: { estimate: { prefix: 'Q-', next: 77 } },
      notes: { estimate: 'Quote valid as written.' },
    });
    const out = paymentsSetupSettings(
      current,
      roofer({ bankTransfer: false, note: '  Thanks!  ', invoiceNext: '1200' }),
    );
    // Whatever Save writes, money.save_settings must take.
    expect(MoneySettings.parse(out)).toEqual(out);
    expect(out).toMatchObject({
      bankTransfer: false,
      tax: { rateBp: 825, name: 'Sales tax', newProductsTaxable: true },
      terms: 'net_14',
      estimateGoodForDays: 30,
      deposit: { kind: 'percent', percentBp: 2500 },
      reminders: {
        beforeDueDays: [3],
        onDue: true,
        afterDueDays: [3, 7, 14],
        estimateAfterDays: 3,
      },
      businessAddress: ADDRESS,
      notes: { estimate: 'Quote valid as written.', invoice: 'Thanks!' },
    });
    expect(out.numbering.estimate).toEqual(current.numbering.estimate);
    expect(out.numbering.invoice).toMatchObject({ prefix: 'INV-', next: 1200 });
  });

  it('turns estimates off with no deposit and no nudge, and keeps the deposit figure for later', () => {
    const current = parseMoneySettings({ deposit: { kind: 'percent', percentBp: 4000 } });
    const out = paymentsSetupSettings(current, roofer({ estimates: false, depositPercent: 'x' }));
    expect(out.deposit).toEqual({ kind: 'none', percentBp: 4000, amountCents: 0 });
    expect(out.reminders.estimateAfterDays).toBeNull();
  });

  it('sends no reminder before an invoice that is due the day it goes out', () => {
    const out = paymentsSetupSettings(defaultMoneySettings(), roofer({ terms: 'due_on_receipt' }));
    expect(out.reminders.beforeDueDays).toEqual([]);
    expect(paymentsRemindersOf(out)).toBe('usual');
  });

  it('keeps a business’s own reminder schedule as it is', () => {
    const current = parseMoneySettings({
      reminders: { beforeDueDays: [5, 1], onDue: false, afterDueDays: [10] },
    });
    expect(paymentsRemindersOf(current)).toBe('own');
    const out = paymentsSetupSettings(current, roofer({ reminders: 'own' }));
    expect(out.reminders).toMatchObject({
      beforeDueDays: [5, 1],
      onDue: false,
      afterDueDays: [10],
    });
  });

  it('charges no tax when they say no', () => {
    const current = parseMoneySettings({ tax: { rateBp: 700 } });
    expect(paymentsSetupSettings(current, roofer({ tax: 'no' })).tax.rateBp).toBe(0);
  });
});

describe('the lines', () => {
  it('reads like the design', () => {
    const lines = paymentsSetupLines(roofer(), NEW);
    expect(Object.fromEntries(lines.map((l) => [l.key, l.value]))).toEqual({
      where: 'Stripe',
      ways: 'Bank transfer first, then card. Cash and cheques by hand.',
      tax: '8.25%, called “Sales tax”. New items start taxable.',
      due: 'Within 14 days of sending',
      estimates: 'Good for 30 days. 25% up front when they say yes.',
      reminders:
        '3 days before, on the day, then 3, 7 and 14 days late. One nudge on an unanswered estimate.',
      documents: '2210 Oak St, Houston. Next number INV-1001. “Thank you for your business.”',
    });
  });

  it('leaves an unanswered tax blank, and drops ways to pay for Not now', () => {
    const lines = paymentsSetupLines(roofer({ tax: null, where: 'later' }), NEW);
    expect(lines.find((l) => l.key === 'tax')?.value).toBeNull();
    expect(lines.map((l) => l.key)).not.toContain('ways');
    expect(lines.find((l) => l.key === 'where')?.value).toBe('Not now');
  });

  it('names the connected account on Settings', () => {
    const again = ctxOf({ connections: [stripe({ card: true })] });
    expect(paymentsSetupLines(roofer(), again)[0]).toMatchObject({
      key: 'where',
      value: 'Stripe, connected',
    });
  });

  it('shortens the address to the street and the town', () => {
    expect(paymentsShortAddress(ADDRESS)).toBe('2210 Oak St, Houston');
    expect(paymentsShortAddress('  ')).toBeNull();
    expect(paymentsShortAddress('PO Box 4')).toBe('PO Box 4');
  });
});

describe('typed numbers', () => {
  it('reads rates and amounts the way people type them', () => {
    expect(paymentsRateOf('8.25%', 2_000)).toBe(825);
    expect(paymentsRateOf('8.255', 2_000)).toBeNull();
    expect(paymentsCentsOf('$1,250')).toBe(125_000);
    expect(paymentsCentsOf('0')).toBeNull();
  });
});
