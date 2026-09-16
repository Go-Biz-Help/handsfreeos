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
  AUTO_KINDS,
  autoActionOf,
  chipText,
  detectAttention,
  DETECTORS,
  isLeadKind,
  lastReminderNote,
  letHandleModeOf,
  letHandleRefusal,
  mayTakeAttentionAction,
  moneyDraftEmail,
  moneyDraftText,
  parseAttentionSettings,
  scoreOf,
  tooSoonAfterReminder,
  URGENCY_RULES,
  type AttentionSettings,
  type Detection,
  type EstimateWaitingFacts,
  type InvoiceOverdueFacts,
} from '../src/attention/index';
import { dueWording } from '../src/money/words';
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
    // The card has been open since the due day ended: that is when the invoice became late.
    expect(d?.since).toBe(iso(at('2026-09-21', '00:00')));
    // But the chip counts the way a person does, from the date on the invoice — due the 20th, today the
    // 25th, five days — and says the same number as `dueWording` does on the list and on the document.
    const chip = chipText(
      d!.reasons.find((r) => r.code === 'overdue')!,
      now,
    );
    expect(chip).toBe('5 days overdue');
    expect(chip).toBe(dueWording('2026-09-20', now, TZ));
  });

  it('says the same number of days as every other place that counts them, at any hour', () => {
    // The chip used to count from midnight after the due day, so it was a day behind the list and the
    // document for the whole of every day. One invoice, one number, whatever the hour.
    for (const clock of ['00:01', '06:59', '12:00', '18:30', '23:59'])
      for (const day of ['2026-09-22', '2026-09-25', '2026-10-05']) {
        const now = at(day, clock);
        const d = run({}, now);
        expect(
          chipText(
            d!.reasons.find((r) => r.code === 'overdue')!,
            now,
          ),
          `${day} ${clock}`,
        ).toBe(dueWording('2026-09-20', now, TZ));
      }
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

  /**
   * A part payment is the case that matters: the card must re-rank on the smaller balance rather than sit there
   * saying the old figure, and a card someone dismissed last week has to come back now that the number changed.
   */
  it('changes its fingerprint when what is owed changes', () => {
    const full = run();
    const part = run({ paidCents: 24_000, status: 'partly_paid' });
    expect(full?.value).toBe(124_000);
    expect(part?.value).toBe(100_000);
    expect(part?.fingerprint).not.toBe(full?.fingerprint);
    expect(words(part, 'amount')).toBe('$1,000 owed');
    // The same facts twice are the same fingerprint: a sweep that changes nothing writes nothing.
    expect(run({ paidCents: 24_000, status: 'partly_paid' })?.fingerprint).toBe(part?.fingerprint);
    // And a refund that puts money back owed moves it again.
    const refunded = run({ paidCents: 24_000, status: 'partly_paid', refundedCents: 10_000 });
    expect(refunded?.value).toBe(110_000);
    expect(refunded?.fingerprint).not.toBe(part?.fingerprint);
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

// ---- the follow-up a person sends ----

/**
 * The words Home puts in front of a person when they follow one of these cards up. Nobody's words but the
 * business's own: the document read back, with an offer rather than a demand, and never a link nobody can mint.
 */
describe('the follow-up draft', () => {
  const invoice = {
    kind: 'invoice_overdue' as const,
    firstName: 'Robert',
    businessName: 'Lone Star HVAC',
    senderFirstName: 'Dale',
    title: 'Ductwork repair',
    number: 'INV-1036',
    amountCents: 255_188,
    day: '2026-09-04',
    timeZone: TZ,
    now: NOW.getTime(),
    firstText: false,
  };
  const estimate = {
    ...invoice,
    kind: 'estimate_waiting' as const,
    firstName: 'Tom',
    title: 'Rooftop unit replacement',
    number: 'EST-1036',
    amountCents: 1_292_850,
    day: '2026-09-25',
  };

  it('says who it is from, what the document says, and what to do about it', () => {
    expect(moneyDraftText(invoice)).toBe(
      "Hi Robert, it's Dale at Lone Star HVAC. I'm following up on invoice INV-1036 for $2,551.88, " +
        'which was due Fri, Sep 4. The payment link we sent still works. Let me know if you would like ' +
        'it again, or if something needs sorting out.',
    );
    expect(moneyDraftText(estimate)).toBe(
      "Hi Tom, it's Dale at Lone Star HVAC. Just checking in on estimate EST-1036 for $12,928.50. " +
        "It's good until Fri, Sep 25. The link we sent still works if you want to approve it. Happy to " +
        'answer any questions.',
    );
  });

  it('carries the STOP wording on a first text, and never asks anyone to reply CANCEL', () => {
    const first = moneyDraftText({ ...invoice, firstText: true });
    expect(first).toContain('Reply STOP to opt out.');
    expect(moneyDraftText(invoice)).not.toContain('STOP');
    for (const words of [moneyDraftText(invoice), moneyDraftText(estimate)])
      expect(words).not.toMatch(/\b(CANCEL|YES)\b/);
  });

  it('spells the document out in an email, and signs it', () => {
    const mail = moneyDraftEmail(invoice);
    expect(mail.subject).toBe('Following up on invoice INV-1036');
    expect(mail.body).toContain('Invoice: INV-1036');
    expect(mail.body).toContain('For: Ductwork repair');
    expect(mail.body).toContain('Amount due: $2,551.88');
    expect(mail.body).toContain('Due: Fri, Sep 4');
    expect(mail.body.endsWith('Dale\nLone Star HVAC')).toBe(true);
    expect(moneyDraftEmail(estimate).subject).toBe('Checking in on estimate EST-1036');
    expect(moneyDraftEmail(estimate).body).toContain('Good through: Fri, Sep 25');
  });

  it('manages without a name, a number or a date', () => {
    const bare = moneyDraftText({
      ...invoice,
      firstName: null,
      senderFirstName: null,
      number: null,
      day: null,
    });
    expect(bare).toBe(
      "Hi there, it's Lone Star HVAC. I'm following up on your invoice for $2,551.88, which is still " +
        'open. The payment link we sent still works. Let me know if you would like it again, or if ' +
        'something needs sorting out.',
    );
  });

  /**
   * The business's own ladder is already writing to this customer about this invoice. Two messages an hour
   * apart about the same bill is what makes a business look broken.
   */
  it('says when the last reminder went out, and holds the next one for a day', () => {
    const hoursAgo = (h: number, kind: 'reminder' | 'document' = 'reminder') => ({
      at: new Date(NOW.getTime() - h * 3_600_000).toISOString(),
      channel: 'sms' as const,
      kind,
    });
    expect(lastReminderNote(hoursAgo(3), NOW.getTime(), TZ)).toBe(
      'Your last reminder about this invoice went out by text 3 hours ago.',
    );
    expect(lastReminderNote(hoursAgo(72), NOW.getTime(), TZ)).toBe(
      'Your last reminder about this invoice went out by text on Sat, Sep 12.',
    );
    expect(lastReminderNote(null, NOW.getTime(), TZ)).toBeNull();
    // The invoice going out is the same mistake to make twice, and says which it was.
    expect(lastReminderNote(hoursAgo(2, 'document'), NOW.getTime(), TZ)).toBe(
      'The invoice itself went out by text 2 hours ago.',
    );

    const held = tooSoonAfterReminder(hoursAgo(3), NOW.getTime(), TZ);
    expect(held).toContain('went out by text 3 hours ago');
    expect(held).toContain('Give it a day before you follow up');
    // A day later it is a person's own call again.
    expect(tooSoonAfterReminder(hoursAgo(25), NOW.getTime(), TZ)).toBeNull();
    expect(tooSoonAfterReminder(null, NOW.getTime(), TZ)).toBeNull();
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
    // The card is handled by reaching the customer, not by reading the document.
    expect(ATTENTION_HANDLE_LABELS.estimate_waiting).toBe('Follow up');
    expect(ATTENTION_HANDLE_LABELS.invoice_overdue).toBe('Follow up');
  });

  /**
   * Chris's rule: money never chases itself *unreviewed*. Neither kind ever runs on its own, and neither is
   * ever handed to the AI teammate — Let HandsFreeOS Handle writes the follow-up and waits for a person.
   */
  it('asks first, always: nothing automatic, and never the AI teammate', () => {
    for (const kind of ['estimate_waiting', 'invoice_overdue'] as const) {
      expect(autoActionOf(kind)).toBeNull();
      expect(AUTO_KINDS[kind]).toBeUndefined();
      expect(letHandleModeOf(kind)).toBe('ask');
      // Nothing to refuse: the refusals are for the kinds HandsFreeOS genuinely can't do.
      expect(letHandleRefusal(kind)).toBeNull();
      // A member can still pass it on, put it off or let it go.
      for (const action of ['assign', 'snooze', 'dismiss'] as const)
        expect(mayTakeAttentionAction('member', kind, action)).toBe(true);
      // Writing to a customer about money is money.manage, for both the card's button and the draft.
      expect(mayTakeAttentionAction('member', kind, 'handle')).toBe(false);
      expect(mayTakeAttentionAction('member', kind, 'let_handle')).toBe(false);
    }
  });

  /**
   * "$ affected" counts money owed, each job once. An overdue invoice for a lead that already has a card is
   * that lead's money seen again, and an estimate stays out until someone accepts it.
   */
  it('counts an overdue invoice once, even when its lead is already counted', () => {
    const lead = uid(1);
    const owed = detectAttention(
      'invoice_overdue',
      {
        business,
        invoice: {
          id: INVOICE,
          status: 'partly_paid',
          dueDate: '2026-09-20',
          totalCents: 124_000,
          paidCents: 24_000,
          refundedCents: 0,
          viewedAt: null,
          assigneeUserId: null,
        },
        hasProcessingPayment: false,
      },
      settings,
      at('2026-09-25', '09:00'),
    );
    expect(owed?.value).toBe(100_000);
    const overdue = { ...owed!, leadId: lead };
    const leadCard = {
      value: 180_000,
      valueIsEstimate: false,
      moneyKey: `lead:${lead}`,
      leadId: lead,
    };
    // The lead is worth more than what is still owed on it: one figure, the larger.
    expect(affectedCents([leadCard, overdue])).toBe(180_000);
    // The same job, and only the invoice left open: still one figure.
    expect(affectedCents([overdue])).toBe(100_000);
    // A different lead's overdue invoice is its own money.
    const other = { ...overdue, leadId: uid(2), value: 40_000 };
    expect(affectedCents([leadCard, overdue, other])).toBe(220_000);
    // An invoice with no lead behind it counts on its own, under its own key.
    expect(affectedCents([leadCard, { ...owed!, leadId: null }])).toBe(280_000);
    // The estimate stays out until it's accepted, whether or not its lead has a card.
    const quoted = DETECTORS.estimate_waiting.detect(
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
    expect(affectedCents([leadCard, { ...quoted!, leadId: lead }])).toBe(180_000);
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
