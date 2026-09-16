/**
 * The two Action Center kinds Milestone 8 left unbuilt: an estimate nobody answered and an invoice nobody paid.
 * The edges are what matter — a bank transfer settling isn't late, an estimate about to expire, and the money
 * key that keeps "$ affected" honest.
 */
import { describe, expect, it } from 'vitest';
import {
  affectedCents,
  ATTENTION_HANDLE_LABELS,
  ATTENTION_KIND_LABELS,
  ATTENTION_KIND_PLURALS,
  ATTENTION_SUBJECT_OF,
  attentionWakeAt,
  chipText,
  detectAttention,
  DETECTORS,
  isLeadKind,
  parseAttentionSettings,
  scoreOf,
  URGENCY_RULES,
  type AttentionSettings,
  type Detection,
  type EstimateWaitingFacts,
  type InvoiceOverdueFacts,
} from '../src/attention/index';
import { at, business, DALE, DAY, iso, NOW, TZ, uid } from './attention-fixtures';

const settings = parseAttentionSettings({});
const codes = (d: Detection | null) => d?.reasons.map((r) => r.code) ?? [];
const words = (d: Detection | null, code: string) => d?.reasons.find((r) => r.code === code)?.label;

const ESTIMATE = uid(3_001);
const INVOICE = uid(4_001);

// ---- estimate_waiting ----

describe('estimate_waiting', () => {
  const facts = (over: Partial<EstimateWaitingFacts['estimate']> = {}): EstimateWaitingFacts => ({
    estimate: {
      id: ESTIMATE,
      status: 'sent',
      totalCents: 840_000,
      sentAt: iso(at('2026-09-10', '09:00')),
      viewedAt: null,
      // Good for the fortnight the business gives: expires_on 2026-09-24, so it lasts until that day is over.
      expiresAt: iso(at('2026-09-25', '00:00')),
      assigneeUserId: DALE,
      ...over,
    },
  });
  const run = (
    over: Partial<EstimateWaitingFacts['estimate']> = {},
    now = NOW,
    s: AttentionSettings = settings,
  ) => DETECTORS.estimate_waiting.detect(facts(over), s, now);

  it('waits the days a business gave the customer', () => {
    // Three days here, not the default five: this is the setting doing its job, whatever it's set to.
    const gave3 = parseAttentionSettings({ money: { estimateWaitingDays: 3 } });
    const f = facts();
    expect(DETECTORS.estimate_waiting.detect(f, gave3, at('2026-09-12', '09:00'))).toBeNull();
    expect(DETECTORS.estimate_waiting.wakeAt(f, gave3, at('2026-09-12', '09:00'))).toBe(
      iso(at('2026-09-13', '09:00')),
    );
    expect(DETECTORS.estimate_waiting.detect(f, gave3, at('2026-09-13', '09:01'))).not.toBeNull();
  });

  it('by default waits five days, a couple after the check-in HandsFreeOS sends on day three', () => {
    const f = facts();
    expect(settings.money.estimateWaitingDays).toBe(5);
    expect(DETECTORS.estimate_waiting.detect(f, settings, at('2026-09-14', '09:00'))).toBeNull();
    expect(
      DETECTORS.estimate_waiting.detect(f, settings, at('2026-09-15', '09:01')),
    ).not.toBeNull();
  });

  it('says what was quoted, how long is left, and that they never opened it', () => {
    const d = run();
    expect(codes(d)).toEqual(['amount', 'expires_in', 'not_viewed']);
    expect(words(d, 'amount')).toBe('$8,400 quoted');
    expect(words(d, 'not_viewed')).toBe('not opened yet');
    expect(d?.assignee).toBe(DALE);
    expect(d?.since).toBe(iso(at('2026-09-10', '09:00')));
    expect(d?.dueAt).toBe(iso(at('2026-09-25', '00:00')));
  });

  it('drops the "not opened" chip once the customer has looked', () => {
    const d = run({ viewedAt: iso(at('2026-09-11', '08:00')) });
    expect(codes(d)).toEqual(['amount', 'expires_in']);
    // Opening it changes the facts, so a dismissed card comes back.
    expect(d?.fingerprint).not.toBe(run()?.fingerprint);
  });

  it('counts down as the expiry nears, and lets go once it passes', () => {
    const nearly = at('2026-09-24', '12:00');
    const d = run({}, nearly);
    expect(
      chipText(
        d!.reasons.find((r) => r.code === 'expires_in')!,
        nearly,
      ),
    ).toBe('expires in 12 h');
    expect(run({}, at('2026-09-25', '00:00'))).toBeNull();
    expect(run({}, at('2026-09-26', '09:00'))).toBeNull();
  });

  it('never opens for an estimate that expires before it would', () => {
    const f = facts({ expiresAt: iso(at('2026-09-12', '09:00')) });
    expect(DETECTORS.estimate_waiting.detect(f, settings, at('2026-09-11', '09:00'))).toBeNull();
    expect(DETECTORS.estimate_waiting.wakeAt(f, settings, at('2026-09-11', '09:00'))).toBeNull();
  });

  it('is only ever about a sent estimate', () => {
    for (const status of ['draft', 'accepted', 'declined', 'expired', 'void'] as const)
      expect(run({ status })).toBeNull();
    expect(run({ sentAt: null })).toBeNull();
  });

  it('carries what was quoted as an estimate, under its own money key', () => {
    const d = run();
    expect(d?.value).toBe(840_000);
    expect(d?.valueIsEstimate).toBe(true);
    expect(d?.moneyKey).toBe(`estimate:${ESTIMATE}`);
    // It shows on the card but stays out of "$ affected" until someone accepts it.
    expect(affectedCents([d!])).toBe(0);
  });

  it('is off when a business turns the kind off', () => {
    const off = parseAttentionSettings({ kinds: { estimate_waiting: false } });
    expect(run({}, NOW, off)).toBeNull();
  });
});

// ---- invoice_overdue ----

describe('invoice_overdue', () => {
  const facts = (
    over: Partial<InvoiceOverdueFacts['invoice']> = {},
    hasProcessingPayment = false,
  ): InvoiceOverdueFacts => ({
    business,
    invoice: {
      id: INVOICE,
      status: 'sent',
      dueDate: '2026-09-20',
      totalCents: 124_000,
      paidCents: 0,
      refundedCents: 0,
      viewedAt: iso(at('2026-09-16', '11:00')),
      assigneeUserId: DALE,
      ...over,
    },
    hasProcessingPayment,
  });
  const run = (
    over: Partial<InvoiceOverdueFacts['invoice']> = {},
    now = at('2026-09-25', '09:00'),
    s: AttentionSettings = settings,
    processing = false,
  ) => DETECTORS.invoice_overdue.detect(facts(over, processing), s, now);

  it('opens a day after the due day ends, where the business is', () => {
    const f = facts();
    // Still the 20th in Chicago.
    expect(DETECTORS.invoice_overdue.detect(f, settings, at('2026-09-20', '23:59'))).toBeNull();
    // Late from midnight, with a day of grace: the card opens on the 22nd.
    expect(DETECTORS.invoice_overdue.detect(f, settings, at('2026-09-21', '09:00'))).toBeNull();
    expect(DETECTORS.invoice_overdue.wakeAt(f, settings, at('2026-09-21', '09:00'))).toBe(
      iso(at('2026-09-22', '00:00')),
    );
    expect(DETECTORS.invoice_overdue.detect(f, settings, at('2026-09-22', '00:01'))).not.toBeNull();
  });

  it('counts the lateness from the due day, not from when the card opened', () => {
    const now = at('2026-09-25', '09:00');
    const d = run({}, now);
    expect(d?.since).toBe(iso(at('2026-09-21', '00:00')));
    expect(
      chipText(
        d!.reasons.find((r) => r.code === 'overdue')!,
        now,
      ),
    ).toBe('4 days overdue');
  });

  it('is not overdue while a bank transfer is settling', () => {
    expect(run({}, at('2026-10-01', '09:00'), settings, true)).toBeNull();
    expect(
      DETECTORS.invoice_overdue.wakeAt(facts({}, true), settings, at('2026-10-01', '09:00')),
    ).toBeNull();
  });

  it('says what is owed, and whether they ever opened it', () => {
    const d = run({ paidCents: 24_000 });
    expect(codes(d)).toEqual(['amount', 'overdue']);
    expect(words(d, 'amount')).toBe('$1,000 owed');
    const never = run({ viewedAt: null });
    expect(codes(never)).toEqual(['amount', 'overdue', 'not_viewed']);
  });

  it('lets go when the balance does, and stays for a refund that owes again', () => {
    expect(run({ paidCents: 124_000 })).toBeNull();
    expect(run({ status: 'paid', paidCents: 124_000 })).toBeNull();
    expect(run({ status: 'void' })).toBeNull();
    expect(run({ dueDate: null })).toBeNull();
    const refunded = run({ status: 'partly_paid', paidCents: 124_000, refundedCents: 24_000 });
    expect(refunded?.value).toBe(24_000);
  });

  it('ignores a balance too small to be worth a card', () => {
    const s = parseAttentionSettings({ money: { minBalanceCents: 5_000 } });
    expect(run({ paidCents: 120_000 }, at('2026-09-25', '09:00'), s)).toBeNull();
    expect(run({ paidCents: 119_000 }, at('2026-09-25', '09:00'), s)).not.toBeNull();
  });

  it('carries the balance owed, counted once under its own money key', () => {
    const d = run({ paidCents: 24_000 });
    expect(d?.value).toBe(100_000);
    expect(d?.valueIsEstimate).toBe(false);
    expect(d?.moneyKey).toBe(`invoice:${INVOICE}`);
    expect(affectedCents([d!])).toBe(100_000);
    // The same invoice twice is still one invoice; a lead's value is its own money.
    expect(affectedCents([d!, d!])).toBe(100_000);
    expect(
      affectedCents([d!, { value: 500_000, valueIsEstimate: false, moneyKey: `lead:${uid(1)}` }]),
    ).toBe(600_000);
  });

  it('honours the grace days a business sets', () => {
    const s = parseAttentionSettings({ money: { invoiceOverdueDays: 0 } });
    expect(DETECTORS.invoice_overdue.detect(facts(), s, at('2026-09-21', '00:01'))).not.toBeNull();
  });

  it('is off when a business turns the kind off', () => {
    const off = parseAttentionSettings({ kinds: { invoice_overdue: false } });
    expect(run({}, at('2026-09-25', '09:00'), off)).toBeNull();
  });
});

// ---- how they sit in the list ----

describe('money in the Action Center', () => {
  it('is named, has a subject and a button, and is nobody’s lead card', () => {
    for (const kind of ['estimate_waiting', 'invoice_overdue'] as const) {
      expect(ATTENTION_KIND_LABELS[kind]).toBeTruthy();
      expect(ATTENTION_KIND_PLURALS[kind]).toBeTruthy();
      expect(ATTENTION_HANDLE_LABELS[kind]).toBeTruthy();
      expect(isLeadKind(kind)).toBe(false);
    }
    expect(ATTENTION_SUBJECT_OF.estimate_waiting).toBe('estimate');
    expect(ATTENTION_SUBJECT_OF.invoice_overdue).toBe('invoice');
    expect(ATTENTION_HANDLE_LABELS.invoice_overdue).toBe('Send reminder');
  });

  it('climbs slowly: the size of the money does the talking', () => {
    expect(URGENCY_RULES.estimate_waiting).toEqual({
      grows: 'since',
      start: 1,
      stepMs: 5 * DAY,
    });
    expect(URGENCY_RULES.invoice_overdue).toEqual({
      grows: 'since',
      start: 1,
      stepMs: 10 * DAY,
    });
    const overdue = detectAttention(
      'invoice_overdue',
      {
        business,
        invoice: {
          id: INVOICE,
          status: 'sent',
          dueDate: '2026-09-20',
          totalCents: 124_000,
          paidCents: 0,
          refundedCents: 0,
          viewedAt: null,
          assigneeUserId: null,
        },
        hasProcessingPayment: false,
      },
      settings,
      at('2026-09-25', '09:00'),
    );
    const fresh = scoreOf({ ...overdue!, kind: 'invoice_overdue' }, at('2026-09-25', '09:00'));
    const stale = scoreOf({ ...overdue!, kind: 'invoice_overdue' }, at('2026-10-25', '09:00'));
    expect(stale).toBeGreaterThan(fresh);
  });

  it('never turns urgent on its own: money is chased in working hours', () => {
    const d = detectAttention(
      'estimate_waiting',
      {
        estimate: {
          id: ESTIMATE,
          status: 'sent',
          totalCents: 840_000,
          sentAt: iso(at('2026-09-10', '09:00')),
          viewedAt: null,
          expiresAt: null,
          assigneeUserId: null,
        },
      },
      settings,
      NOW,
    );
    expect(d?.urgentFrom).toBeNull();
    expect(
      attentionWakeAt(
        'estimate_waiting',
        {
          estimate: {
            id: ESTIMATE,
            status: 'void',
            totalCents: 0,
            sentAt: null,
            viewedAt: null,
            expiresAt: null,
            assigneeUserId: null,
          },
        },
        settings,
        NOW,
      ),
    ).toBeNull();
  });

  it('is about the business’s own time zone, not the server’s', () => {
    const utc = { ...business, timeZone: 'UTC' };
    const late = DETECTORS.invoice_overdue.detect(
      {
        business: utc,
        invoice: {
          id: INVOICE,
          status: 'sent',
          dueDate: '2026-09-20',
          totalCents: 124_000,
          paidCents: 0,
          refundedCents: 0,
          viewedAt: null,
          assigneeUserId: null,
        },
        hasProcessingPayment: false,
      },
      parseAttentionSettings({ money: { invoiceOverdueDays: 0 } }),
      new Date('2026-09-21T00:30:00Z'),
    );
    expect(late).not.toBeNull();
    expect(late?.since).toBe('2026-09-21T00:00:00.000Z');
    expect(TZ).toBe('America/Chicago');
  });
});
