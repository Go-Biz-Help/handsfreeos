/**
 * What the quick look says of a business (support/business-words.ts): each thing it can connect and whether it works,
 * the plan, and the money their own customers paid them. The web shows these words; tests check the parts that matter.
 */
import { describe, expect, it } from 'vitest';
import {
  deskBusinessFlags,
  deskMoreLines,
  deskPlanLines,
  deskSetupRows,
  deskSetupScore,
  deskTheirMoneyLines,
  type BusinessGlance,
} from '../src/index';

const now = Date.parse('2026-10-20T15:00:00Z');
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

const glance = (over: Partial<BusinessGlance> = {}): BusinessGlance => ({
  attention: [],
  deletionRequestedAt: null,
  plan: null,
  activity: Array.from({ length: 30 }, () => 0),
  traffic: { texts: 0, calls: 0, emails: 0, aiReplies: 0 },
  theirMoney: {
    collected30dCents: 0,
    refunded30dCents: 0,
    openInvoices: 0,
    openInvoiceCents: 0,
    overdueInvoices: 0,
    openDisputes: 0,
  },
  setup: {
    numbers: [],
    registration: null,
    emailDomain: null,
    emailAddresses: 0,
    mailboxes: [],
    payments: [],
    calendarConnections: [],
    calendars: 0,
    bookingPage: null,
    aiTeammate: null,
    meta: null,
    gettingStarted: 'not_started',
  },
  more: { cameFrom: null, addons: [], mainOffer: null, supportAccess: null, lastViewedAs: null },
  problemReports: { open: 0, recent: [] },
  ...over,
});

const state = (g: BusinessGlance, key: string) =>
  deskSetupRows(g.setup, now).find((r) => r.key === key);

describe('what is set up', () => {
  it('says a new business has nothing set up yet, row by row', () => {
    const rows = deskSetupRows(glance().setup, now);
    expect(rows.map((r) => r.state)).toEqual(Array.from({ length: 8 }, () => 'no'));
    expect(deskSetupScore(rows)).toBe('0 of 8');
  });

  it('names the number, and how many more there are', () => {
    const g = glance({ setup: { ...glance().setup, numbers: ['+15125550148', '+15125550149'] } });
    expect(state(g, 'phone')).toMatchObject({ state: 'yes', detail: '(512) 555-0148 and 1 more' });
  });

  it('says how long a texting registration has waited, and why one was turned down', () => {
    const waiting = glance({
      setup: {
        ...glance().setup,
        registration: { state: 'waiting', since: daysAgo(6), reason: null },
      },
    });
    expect(state(waiting, 'registration')).toMatchObject({ state: 'waiting' });
    expect(state(waiting, 'registration')?.detail).toContain('6 days');
    const rejected = glance({
      setup: {
        ...glance().setup,
        registration: {
          state: 'rejected',
          since: null,
          reason: 'The website didn’t match the brand',
        },
      },
    });
    expect(state(rejected, 'registration')).toMatchObject({
      state: 'problem',
      detail: 'Turned down. The website didn’t match the brand.',
    });
  });

  it('puts a connection that needs signing in again ahead of everything else about it', () => {
    const g = glance({
      setup: {
        ...glance().setup,
        emailDomain: { domain: 'lonestar.com', status: 'verified' },
        mailboxes: [{ provider: 'google', status: 'reauth_required' }],
        payments: [{ provider: 'stripe', status: 'error' }],
      },
    });
    expect(state(g, 'email')).toMatchObject({
      state: 'problem',
      detail: 'Gmail mailbox needs signing in again',
    });
    expect(state(g, 'payments')).toMatchObject({
      state: 'problem',
      detail: 'Stripe needs signing in again',
    });
  });

  it('names who a connection needing it is, in the flag', () => {
    const g = glance({
      attention: ['connection_broken'],
      setup: {
        ...glance().setup,
        payments: [{ provider: 'square', status: 'reauth_required' }],
        calendarConnections: [{ provider: 'google', status: 'error' }],
      },
    });
    const [flag] = deskBusinessFlags(
      { attention: g.attention, lastActiveAt: null, createdAt: daysAgo(30), tickets: [] },
      g,
      null,
      now,
    );
    expect(flag).toMatchObject({ key: 'connection_broken', tone: 'warning', tab: 'setup' });
    expect(flag?.text).toBe('Square and Google Calendar need signing in again.');
  });
});

describe('the plan', () => {
  const plan = {
    plan: 'founding_lifetime' as const,
    status: 'active' as const,
    priceCents: 49_700,
    periodEnd: '2027-08-01T00:00:00.000Z',
    graceEndsAt: null,
    canceledAt: null,
    renewalStoppedAt: null,
    renewalProblem: null,
    renewalFailedAt: null,
  };

  it('tells a yearly founding seat from one for life', () => {
    expect(deskPlanLines(plan).map((l) => [l.label, l.value])).toEqual([
      ['Plan', 'Founding, yearly, $497 a year'],
      ['Renews', 'Aug 1, 2027'],
    ]);
    expect(deskPlanLines({ ...plan, priceCents: 0, periodEnd: null })[1]?.value).toBe(
      'Never, it’s for life',
    );
  });

  it('marks a failed renewal and a plan in grace', () => {
    const lines = deskPlanLines({
      ...plan,
      status: 'grace',
      graceEndsAt: '2026-10-27T00:00:00.000Z',
      renewalProblem: 'Your card was declined.',
      renewalFailedAt: '2026-10-13T00:00:00.000Z',
    });
    expect(lines.filter((l) => l.tone === 'danger').map((l) => l.label)).toEqual([
      'In grace until',
      'Renewal failed',
    ]);
  });
});

describe('what their customers paid them', () => {
  it('counts what is waiting to be paid, and flags what is overdue', () => {
    const lines = deskTheirMoneyLines(
      glance({
        theirMoney: {
          collected30dCents: 482_000,
          refunded30dCents: 0,
          openInvoices: 4,
          openInvoiceCents: 126_000,
          overdueInvoices: 1,
          openDisputes: 0,
        },
        setup: { ...glance().setup, payments: [{ provider: 'stripe', status: 'active' }] },
      }),
    );
    const by = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(by['Waiting to be paid']?.value).toContain('on 4 invoices');
    expect(by.Overdue).toMatchObject({ value: '1 invoice', tone: 'danger' });
    expect(by['Takes payments with']?.value).toBe('Stripe');
  });
});

describe('more about them', () => {
  it('says where they came from, and whether the move is done', () => {
    const lines = deskMoreLines(
      { industry: 'hvac', timezone: 'America/Chicago', createdAt: daysAgo(80) },
      glance({
        more: {
          ...glance().more,
          cameFrom: { source: 'gohighlevel', status: 'importing', at: null },
        },
      }),
      null,
      now,
    );
    const by = Object.fromEntries(lines.map((l) => [l.label, l.value]));
    expect(by['Came from']).toBe('GoHighLevel, still moving');
    expect(by.Industry).toBe('HVAC');
    expect(by['Their time']).toBe('10:00 AM, America/Chicago');
  });
});
