/**
 * The money settings document: its defaults, how forgivingly it reads, and every way two settings can fight —
 * each with a fix that, applied, ends the argument.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMoneyPatch,
  checkMoneySettings,
  defaultMoneySettings,
  dueDateFor,
  hasBlockingMoneyIssues,
  MONEY_ISSUE_CODES,
  moneySettingsOf,
  numberingOf,
  numberPreview,
  parseMoneySettings,
  PAYMENT_TERMS,
  readMoneySettings,
  reminderSchedule,
  TERMS_DAYS,
  type MoneyIssueCode,
  type MoneySettings,
} from '../src/money/index';

const settings = (patch: Parameters<typeof applyMoneyPatch>[1] = {}): MoneySettings =>
  applyMoneyPatch(defaultMoneySettings(), patch);

describe('the defaults', () => {
  it('are what a business starts with', () => {
    const d = defaultMoneySettings();
    expect(d.tax).toEqual({ rateBp: 0, name: 'Sales tax', newProductsTaxable: true });
    expect(d.numbering.estimate).toEqual({ prefix: 'EST-', next: 1_001, pad: 4 });
    expect(d.numbering.invoice).toEqual({ prefix: 'INV-', next: 1_001, pad: 4 });
    expect(d.terms).toBe('due_on_receipt');
    expect(d.estimateGoodForDays).toBe(30);
    expect(d.deposit).toEqual({ kind: 'none', percentBp: 2_500, amountCents: 0 });
    expect(d.bankTransfer).toBe(true);
    expect(d.reminders).toEqual({
      beforeDueDays: [],
      onDue: true,
      afterDueDays: [3, 7, 14],
      estimateAfterDays: 3,
    });
    expect(d.notes.estimate).toMatch(/Thanks for the opportunity/);
    expect(d.notes.invoice).toMatch(/Thank you/);
  });

  it('start with nothing to argue about', () => {
    expect(checkMoneySettings(defaultMoneySettings())).toEqual([]);
  });

  it('preview the first invoice number', () => {
    expect(numberPreview(numberingOf(defaultMoneySettings(), 'invoice'))).toBe('INV-1001');
    expect(numberPreview(numberingOf(defaultMoneySettings(), 'estimate'))).toBe('EST-1001');
  });

  it('come back for a business that has never opened the page', () => {
    expect(moneySettingsOf(null)).toEqual(defaultMoneySettings());
    expect(moneySettingsOf({ calendar: {} })).toEqual(defaultMoneySettings());
    expect(moneySettingsOf({ money: { tax: { rateBp: 825 } } }).tax.rateBp).toBe(825);
  });
});

describe('terms', () => {
  it('put the due date where each one says', () => {
    expect(dueDateFor('due_on_receipt', '2026-09-15')).toBe('2026-09-15');
    expect(dueDateFor('net_7', '2026-09-15')).toBe('2026-09-22');
    expect(dueDateFor('net_14', '2026-09-15')).toBe('2026-09-29');
    expect(dueDateFor('net_30', '2026-09-15')).toBe('2026-10-15');
    for (const terms of PAYMENT_TERMS) expect(TERMS_DAYS[terms]).toBeGreaterThanOrEqual(0);
  });
});

describe('the reminder schedule', () => {
  it('runs earliest first, and fires once per moment', () => {
    const s = settings({ terms: 'net_30', reminders: { beforeDueDays: [3, 7, 3] } });
    expect(reminderSchedule(s)).toEqual([
      { when: 'before', days: 7 },
      { when: 'before', days: 3 },
      { when: 'on', days: 0 },
      { when: 'after', days: 3 },
      { when: 'after', days: 7 },
      { when: 'after', days: 14 },
    ]);
  });

  it('is empty when a business turns them all off', () => {
    const s = settings({ reminders: { beforeDueDays: [], onDue: false, afterDueDays: [] } });
    expect(reminderSchedule(s)).toEqual([]);
  });
});

describe('reading stored settings', () => {
  it('keeps what passes and defaults what doesn’t, without throwing', () => {
    const read = readMoneySettings({
      tax: { rateBp: 'eight', name: 'State tax' },
      terms: 'net_14',
      estimateGoodForDays: 9_999,
      reminders: { onDue: false, afterDueDays: [5] },
      somethingNewer: { unknown: true },
    });
    expect(read.tax.rateBp).toBe(0);
    expect(read.tax.name).toBe('State tax');
    expect(read.terms).toBe('net_14');
    expect(read.estimateGoodForDays).toBe(30);
    expect(read.reminders.onDue).toBe(false);
    expect(read.reminders.afterDueDays).toEqual([5]);
  });

  it('falls all the way back for nonsense', () => {
    expect(readMoneySettings('not settings')).toEqual(defaultMoneySettings());
    expect(readMoneySettings(null)).toEqual(defaultMoneySettings());
  });

  it('still refuses to save what a person typed wrong', () => {
    expect(() => parseMoneySettings({ tax: { rateBp: 9_999 } })).toThrow();
    expect(() => parseMoneySettings({ numbering: { invoice: { prefix: 'INV 1' } } })).toThrow();
    expect(() => parseMoneySettings({ terms: 'net_45' })).toThrow();
  });
});

describe('settings that fight', () => {
  const codesOf = (s: MoneySettings): MoneyIssueCode[] => checkMoneySettings(s).map((i) => i.code);
  const issue = (s: MoneySettings, code: MoneyIssueCode) => {
    const found = checkMoneySettings(s).find((i) => i.code === code);
    expect(found, `expected a ${code} issue`).toBeDefined();
    return found!;
  };

  it('refuses a deposit with no figure in it, and says how to fix it', () => {
    const s = settings({ deposit: { kind: 'amount', amountCents: 0 } });
    const found = issue(s, 'deposit_without_amount');
    expect(found.severity).toBe('error');
    expect(hasBlockingMoneyIssues(checkMoneySettings(s))).toBe(true);
    expect(found.fixes.map((f) => f.id)).toEqual(['deposit_percent', 'deposit_off']);
    for (const fix of found.fixes)
      expect(codesOf(applyMoneyPatch(s, fix.patch))).not.toContain('deposit_without_amount');
  });

  it('spots a percentage deposit of nothing', () => {
    const s = settings({ deposit: { kind: 'percent', percentBp: 0 } });
    const found = issue(s, 'deposit_without_amount');
    expect(found.fixes.map((f) => f.id)).toEqual(['deposit_quarter', 'deposit_off']);
    for (const fix of found.fixes)
      expect(codesOf(applyMoneyPatch(s, fix.patch))).not.toContain('deposit_without_amount');
  });

  it('spots a tax rate that is set and never applied', () => {
    const s = settings({ tax: { rateBp: 825, newProductsTaxable: false } });
    const found = issue(s, 'tax_without_taxable');
    expect(found.severity).toBe('warning');
    expect(found.message).toBe('Sales tax is set, but new items aren’t taxable');
    for (const fix of found.fixes)
      expect(codesOf(applyMoneyPatch(s, fix.patch))).not.toContain('tax_without_taxable');
  });

  it('leaves a 0% rate with taxable items alone: plenty of work isn’t taxed', () => {
    expect(codesOf(settings({ tax: { rateBp: 0, newProductsTaxable: true } }))).toEqual([]);
  });

  it('spots estimates and invoices numbered the same way', () => {
    const s = settings({ numbering: { estimate: { prefix: 'INV-' } } });
    const found = issue(s, 'same_prefix');
    expect(found.fixes[0]?.label).toBe('Use EST- for estimates');
    expect(codesOf(applyMoneyPatch(s, found.fixes[0]!.patch))).not.toContain('same_prefix');
  });

  it('spots nobody being reminded at all', () => {
    const s = settings({ reminders: { beforeDueDays: [], onDue: false, afterDueDays: [] } });
    const found = issue(s, 'no_reminders');
    expect(found.message).toBe('Nobody is reminded about an unpaid invoice');
    expect(codesOf(applyMoneyPatch(s, found.fixes[0]!.patch))).not.toContain('no_reminders');
  });

  it('spots a reminder that would go out before the invoice does', () => {
    const s = settings({ terms: 'net_7', reminders: { beforeDueDays: [3, 10] } });
    const found = issue(s, 'reminder_before_sending');
    expect(found.message).toBe(
      'A reminder 10 days before the due date would go out before the invoice does',
    );
    expect(found.fixes.map((f) => f.label)).toEqual([
      'Drop the early reminders',
      'Give them 14 days to pay',
    ]);
    for (const fix of found.fixes)
      expect(codesOf(applyMoneyPatch(s, fix.patch))).not.toContain('reminder_before_sending');
  });

  it('says plainly why a before-due reminder is pointless on due-on-receipt terms', () => {
    const s = settings({ reminders: { beforeDueDays: [3] } });
    const found = issue(s, 'reminder_before_sending');
    expect(found.message).toBe(
      'Invoices are due on receipt, so a reminder before the due date never goes out',
    );
    expect(found.fixes[0]?.label).toBe('Only remind from the due date');
  });

  it('spots an estimate nudge that lands after the estimate expires', () => {
    const s = settings({ estimateGoodForDays: 7, reminders: { estimateAfterDays: 14 } });
    const found = issue(s, 'nudge_after_expiry');
    expect(found.message).toBe(
      'The estimate nudge would go out after the estimate stops being good (7 days)',
    );
    for (const fix of found.fixes)
      expect(codesOf(applyMoneyPatch(s, fix.patch))).not.toContain('nudge_after_expiry');
  });

  it('reports several at once, always in the same order', () => {
    const s = settings({
      deposit: { kind: 'amount', amountCents: 0 },
      tax: { rateBp: 825, newProductsTaxable: false },
      numbering: { estimate: { prefix: 'INV-' } },
      estimateGoodForDays: 2,
      reminders: { beforeDueDays: [3], onDue: true, afterDueDays: [7], estimateAfterDays: 5 },
    });
    expect(codesOf(s)).toEqual([
      'deposit_without_amount',
      'tax_without_taxable',
      'same_prefix',
      'reminder_before_sending',
      'nudge_after_expiry',
    ]);
    const positions = codesOf(s).map((c) => MONEY_ISSUE_CODES.indexOf(c));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('names every way they can fight', () => {
    expect(MONEY_ISSUE_CODES).toEqual([
      'deposit_without_amount',
      'tax_without_taxable',
      'same_prefix',
      'no_reminders',
      'reminder_before_sending',
      'nudge_after_expiry',
    ]);
    // no_reminders and reminder_before_sending can't both hold: one needs before-due reminders, the other none.
    const quiet = settings({ reminders: { beforeDueDays: [], onDue: false, afterDueDays: [] } });
    expect(codesOf(quiet)).toEqual(['no_reminders']);
  });
});
