/**
 * Money as a list (M10 step 16), which the web's Money section and the phone's Money screens both show: what a
 * person may see, the four tabs, the three headline figures, the "Due" column, what a document is for, and the
 * empty states.
 */
import { describe, expect, it } from 'vitest';
import {
  canBill,
  canManageMoney,
  COLLECTED_DAYS,
  effectivePermissions,
  estimatesEmpty,
  headlineFigures,
  invoiceDueLabel,
  invoicesEmpty,
  LINK_COPIED,
  LINK_UNAVAILABLE,
  listState,
  MONEY_LINK_WHAT_IT_DOES,
  MONEY_TAB_LABELS,
  moneyTabsFor,
  paymentsEmpty,
  purposeLabel,
  seesWholeBusiness,
  type MoneySummaryFacts,
} from '../src/index';

const TZ = 'America/Chicago';
/** Tuesday, 22 September 2026, 8:25 AM Central — the canvas's moment. */
const NOW = Date.parse('2026-09-22T13:25:00.000Z');

const summary = (over: Partial<MoneySummaryFacts> = {}): MoneySummaryFacts => ({
  outstandingCents: 656_514,
  outstandingCount: 4,
  settlingCents: 192_230,
  overdueCents: 255_188,
  overdueCount: 1,
  collectedCents: 401_511,
  refundedCents: 2_900,
  now: NOW,
  ...over,
});

describe('what a person may see', () => {
  const owner = effectivePermissions('owner');
  const admin = effectivePermissions('admin');
  const member = effectivePermissions('member');
  const billingMember = effectivePermissions('member', { 'money.bill': true });

  it('gives owners and admins the whole business, and a member their own jobs', () => {
    expect(seesWholeBusiness(owner)).toBe(true);
    expect(seesWholeBusiness(admin)).toBe(true);
    expect(seesWholeBusiness(member)).toBe(false);
    expect(canManageMoney(member)).toBe(false);
    expect(canBill(member)).toBe(false);
  });

  it('lets a member the business lets bill write and send, still for their own jobs', () => {
    expect(canBill(billingMember)).toBe(true);
    expect(seesWholeBusiness(billingMember)).toBe(false);
    // An admin the business keeps from money sees their own jobs only.
    expect(seesWholeBusiness(effectivePermissions('admin', { 'money.manage': false }))).toBe(false);
  });

  it('keeps Payments, which are the business’s, off everyone’s tabs but whoever manages money', () => {
    expect(moneyTabsFor(owner)).toEqual(['invoices', 'estimates', 'payments', 'plans']);
    expect(moneyTabsFor(member)).toEqual(['invoices', 'estimates']);
    // Someone who bills runs their customers' plans on the web: the phone's copy of plans is the managers'.
    expect(moneyTabsFor(billingMember)).toEqual(['invoices', 'estimates']);
    expect(MONEY_TAB_LABELS.plans).toBe('Plans');
  });
});

describe('the three figures above the lists', () => {
  it('says what is owed, what is late and what came in, as the canvas does', () => {
    const [outstanding, overdue, collected] = headlineFigures(summary(), TZ);
    expect(outstanding).toEqual({
      key: 'outstanding',
      value: '$6,565.14',
      label: 'Outstanding',
      sub: '4 invoices waiting · $1,922.30 on its way',
      tone: null,
    });
    expect(overdue!.value).toBe('$2,551.88');
    expect(overdue!.tone).toBe('bad');
    expect(overdue!.sub).toBe('1 invoice past the due date');
    // A summary, so it rounds — deliberately, since M9. (The canvas draws it to the cent; see the step 16 report.)
    expect(collected!.value).toBe('$4,015');
    expect(collected!.label).toBe('Collected in 30 days');
    expect(collected!.tone).toBe('good');
    expect(collected!.sub).toBe('Aug 23 to Sep 22 · after $29 refunded');
  });

  it('drops the "on its way" half when nothing is settling, and says so when there is nothing at all', () => {
    const [outstanding, overdue, collected] = headlineFigures(
      summary({
        settlingCents: 0,
        outstandingCount: 0,
        outstandingCents: 0,
        overdueCents: 0,
        overdueCount: 0,
        collectedCents: 0,
        refundedCents: 0,
      }),
      TZ,
    );
    expect(outstanding!.sub).toBe('Nothing waiting to be paid');
    expect(overdue!.sub).toBe('Nothing is late');
    expect(overdue!.tone).toBe(null);
    expect(collected!.sub).toBe('Aug 23 to Sep 22');
    expect(collected!.tone).toBe(null);
    expect(headlineFigures(summary({ settlingCents: 0 }), TZ)[0]!.sub).toBe(
      '4 invoices waiting to be paid',
    );
  });

  it('counts collected back from the business’s own day, not the reader’s', () => {
    expect(COLLECTED_DAYS).toBe(30);
    // 12:30 AM Central on the 22nd is already the 22nd in UTC's eyes too; an hour earlier is still the 21st there.
    expect(headlineFigures(summary({ now: Date.parse('2026-09-22T04:30:00Z') }), TZ)[2]!.sub).toBe(
      'Aug 22 to Sep 21 · after $29 refunded',
    );
  });
});

describe('one invoice on a list', () => {
  const inv = (over: Partial<Parameters<typeof invoiceDueLabel>[0]> = {}) => ({
    status: 'sent',
    state: 'sent',
    dueOn: '2026-10-02',
    paidAt: null,
    voidedAt: null,
    ...over,
  });

  it('says when it is due, or what happened instead', () => {
    expect(invoiceDueLabel(inv(), NOW, TZ)).toBe('Due Fri, Oct 2');
    expect(invoiceDueLabel(inv({ dueOn: '2026-09-25' }), NOW, TZ)).toBe('Due Fri');
    expect(invoiceDueLabel(inv({ dueOn: '2026-09-04' }), NOW, TZ)).toBe('18 days overdue');
    expect(invoiceDueLabel(inv({ status: 'paid', paidAt: '2026-09-22T11:52:00Z' }), NOW, TZ)).toBe(
      'Paid Tue, Sep 22',
    );
    expect(invoiceDueLabel(inv({ status: 'paid', paidAt: null }), NOW, TZ)).toBe('Paid');
    expect(invoiceDueLabel(inv({ state: 'paying' }), NOW, TZ)).toBe('A payment is on its way');
    expect(invoiceDueLabel(inv({ status: 'draft' }), NOW, TZ)).toBe('Not sent');
    expect(invoiceDueLabel(inv({ status: 'paid', state: 'refunded' }), NOW, TZ)).toBe('Refunded');
    expect(
      invoiceDueLabel(inv({ status: 'void', voidedAt: '2026-09-20T00:00:00Z' }), NOW, TZ),
    ).toBe('Voided');
  });

  it('says why an invoice exists when it isn’t just a job', () => {
    expect(purposeLabel('deposit')).toBe('Deposit');
    expect(purposeLabel('subscription')).toBe('Plan');
    expect(purposeLabel('setup_fee')).toBe('Setup fee');
    expect(purposeLabel('job')).toBe(null);
  });

  it('keeps an opened document reading as sent in the Status column', () => {
    expect(listState('viewed')).toBe('sent');
    expect(listState('partly_paid')).toBe('partly_paid');
  });
});

describe('nothing to show, and a customer’s own link', () => {
  it('tells a filtered list from an empty one', () => {
    expect(invoicesEmpty(false).title).toBe('No invoices yet');
    expect(invoicesEmpty(true).title).toBe('No invoices match');
    expect(invoicesEmpty(true).body).toBe('Try a different search, or show every status.');
    expect(estimatesEmpty(false).body).toBe(
      'Quote a job from the catalogue. The customer approves it on their own page.',
    );
    expect(paymentsEmpty(true).body).toBe('Try a different filter.');
  });

  it('says once what the link lets whoever has it do', () => {
    expect(MONEY_LINK_WHAT_IT_DOES.invoice).toBe('Anyone with this link can pay this invoice.');
    expect(MONEY_LINK_WHAT_IT_DOES.estimate).toBe(
      'Anyone with this link can see and approve this estimate.',
    );
    expect(LINK_COPIED).toBe('Link copied');
    expect(LINK_UNAVAILABLE).toBe('We couldn’t get the link just now. Try again in a minute.');
  });
});
