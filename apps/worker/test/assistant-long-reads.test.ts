/**
 * How the Assistant reads Settings → Products, Payments' accounts, Your partners, a partner's page and an import's page,
 * without a database: each as its screen shows it, and the long ones cut from their lists' ends, never mid-string, so
 * what comes after a long list (a partner's payouts) is always read.
 */
import { PARTNERS_WORDS, PAYMENTS_PAGE_WORDS } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import { wholeLinksIn } from '../src/assistant/full-links';
import { fitLists, importRead, partnerRead } from '../src/assistant/long-reads';
import { accountsRead, partnerListRead, productsRead } from '../src/assistant/tools-settings';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const commission = (n: number) => ({
  commissionId: id(n),
  kind: 'earned',
  amountCents: 1_500,
  baseCents: 10_000,
  rateBp: 1_500,
  earnedAt: '2026-10-01T15:00:00.000Z',
  payableAt: '2026-10-31T15:00:00.000Z',
  test: false,
  held: false,
  clientName: `Client number ${n}`,
  invoiceNumber: `INV-${1000 + n}`,
});

const earnings = (over: Partial<Record<string, number>> = {}) => ({
  earnedCents: 0,
  waitingCents: 0,
  payableCents: 0,
  heldCents: 0,
  payingCents: 0,
  paidCents: 0,
  ...over,
});

describe('a partner’s page', () => {
  const partner = {
    partnerId: id(1),
    name: 'Paula Lopez',
    linkPath: '/book/c/abc?ref=pa-XYZ',
    earnings: earnings({ earnedCents: 300_000 }),
  };
  const payouts = {
    account: { status: 'ready', bankName: 'Chase' },
    lines: [{ payoutId: id(9), month: '2026-10', amountCents: 4_500, status: 'paid' }],
  };

  it('reads whole when it fits, payouts before the long lists', () => {
    const got = { partner, clients: [], commissions: [commission(1)], payouts };
    const read = partnerRead(got) as Record<string, unknown>;
    expect(Object.keys(read)).toEqual(['partner', 'payouts', 'clients', 'commissions']);
    expect(read['note']).toBeUndefined();
  });

  it('keeps the payouts and cuts the lines of what they earned from the end when there are 200', () => {
    const commissions = Array.from({ length: 200 }, (_, i) => commission(i + 2));
    const read = partnerRead({ partner, clients: [], commissions, payouts }) as {
      payouts: typeof payouts;
      commissions: { commissionId: string }[];
      note: string;
    };
    const json = JSON.stringify(read);
    expect(json.length).toBeLessThanOrEqual(16_000);
    expect(read.payouts).toEqual(payouts);
    expect(read.commissions.length).toBeGreaterThan(10);
    expect(read.commissions.length).toBeLessThan(200);
    // The newest first, as the query gives them: the first ones are kept.
    expect(read.commissions[0]!.commissionId).toBe(id(2));
    expect(read.note).toContain(`of 200 lines of what they've earned are here`);
    expect(read.note).toContain('What they’ve earned');
  });
});

describe('an import’s page', () => {
  const wide = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`column ${i}`, 'x'.repeat(30)]),
  );
  const errors = Array.from({ length: 100 }, (_, i) => ({
    rowNumber: i + 2,
    message: 'That email address isn’t one.',
    raw: wide,
  }));
  const imp = { id: id(1), status: 'done', errorCount: 100 };

  it('leaves a short one as it is', () => {
    const got = { import: imp, errors: errors.slice(0, 2) };
    expect(importRead(got)).toBe(got);
  });

  it('drops a wide sheet’s cells and keeps every failed row’s number and why', () => {
    const read = importRead({ import: imp, errors }) as {
      import: unknown;
      errors: { rowNumber: number; message: string; raw?: unknown }[];
      note: string;
    };
    expect(JSON.stringify(read).length).toBeLessThanOrEqual(16_000);
    expect(read.import).toEqual(imp);
    expect(read.errors).toHaveLength(100);
    expect(read.errors[99]).toEqual({ rowNumber: 101, message: 'That email address isn’t one.' });
    expect(read.note).toContain('Rows that did not import');
  });
});

describe('fitting lists', () => {
  it('cuts each list to the same share, says how many show, and keeps valid JSON', () => {
    const data = {
      head: 'kept',
      a: Array.from({ length: 100 }, (_, i) => `item ${i} `.repeat(10)),
      b: Array.from({ length: 50 }, (_, i) => `other ${i} `.repeat(10)),
    };
    const { data: fitted, cut } = fitLists(data, ['a', 'b'], 4_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(4_000);
    expect(fitted['head']).toBe('kept');
    expect(cut['a']!.total).toBe(100);
    expect(cut['b']!.total).toBe(50);
    expect(cut['a']!.shown).toBeGreaterThan(cut['b']!.shown);
  });
});

describe('Settings → Products', () => {
  it('lists each item’s price and kind as the screen does, and the archived ones apart', () => {
    const read = productsRead({
      products: [
        {
          id: id(1),
          name: 'Service call',
          kind: 'fee',
          unitPriceCents: 8_900,
          unitLabel: 'each',
          archivedAt: null,
        },
        {
          id: id(2),
          name: 'Old filter',
          kind: 'product',
          unitPriceCents: 1_250,
          unitLabel: 'each',
          archivedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    }) as {
      items: { price: string; kindLabel: string }[];
      archived: { name: string }[];
      archivedNote: string;
    };
    expect(read.items).toMatchObject([{ price: '$89 each', kindLabel: 'Fee' }]);
    expect(read.archived.map((p) => p.name)).toEqual(['Old filter']);
    expect(read.archivedNote).toContain('1 archived item, still on the documents it’s already on');
  });
});

describe('Your partners', () => {
  it('gives the totals across them, each one’s clients, terms and earnings, and their link', () => {
    const row = (name: string, over: Record<string, unknown>) => ({
      partnerId: id(name.length),
      personId: id(name.length + 10),
      name,
      email: null,
      status: 'active',
      rateBp: 1_500,
      ownRate: false,
      code: 'X',
      linkPath: '/book/c/abc?ref=pa-X',
      clients: 2,
      termsAccepted: true,
      earnings: earnings(),
      addedAt: '2026-10-01T00:00:00.000Z',
      ...over,
    });
    const read = partnerListRead({
      partners: [
        row('Paula', { earnings: earnings({ earnedCents: 10_000, payableCents: 4_000 }) }),
        row('Pat Lee', {
          termsAccepted: false,
          earnings: earnings({ earnedCents: 5_000, paidCents: 2_000 }),
        }),
        row('Ended One', { status: 'ended', termsAccepted: false }),
      ],
    }) as {
      totals: string[];
      about: string;
      partners: { terms?: string; earned: string[]; clients: number; link: string }[];
    };
    expect(read.totals).toEqual([
      'Earned $150',
      'Waiting 30 days $0',
      'Free to pay out $40',
      'Paid $20',
    ]);
    expect(read.about).toBe(PARTNERS_WORDS.earnings.about);
    expect(read.partners[0]).toMatchObject({ clients: 2, link: '/book/c/abc?ref=pa-X' });
    expect(read.partners[0]!.terms).toBeUndefined();
    expect(read.partners[1]!.terms).toBe('Hasn’t accepted your terms yet');
    // An ended partner isn't waiting on anything.
    expect(read.partners[2]!.terms).toBeUndefined();
    expect(read.partners[1]!.earned).toContain('Paid $20');
    // The executor writes their link out whole on the business's address, as Copy their link gives it.
    expect(wholeLinksIn(read.partners[0]!.link, 'https://book.acme.com')).toBe(
      'https://book.acme.com/book/c/abc?ref=pa-X',
    );
  });
});

describe('Accounts you get paid into', () => {
  it('says each account’s badge, how to fix one that needs it, and Square’s renewal', () => {
    const read = accountsRead(
      {
        connections: [
          {
            provider: 'stripe',
            status: 'reauth_required',
            capabilities: { needsInfo: true, needsInfoBy: Date.UTC(2026, 11, 3) / 1000 },
          },
          { provider: 'square', status: 'active', capabilities: {} },
        ],
      },
      'America/Chicago',
    ) as {
      connections: { badge: string; toFix?: string; needsMoreDetails?: string; signIn?: string }[];
    };
    const [stripe, square] = read.connections;
    expect(stripe!.badge).toBe('Needs reconnecting');
    expect(stripe!.toFix).toContain('press Reconnect');
    expect(stripe!.needsMoreDetails).toContain('https://dashboard.stripe.com/');
    expect(square!.badge).toBe('Connected');
    expect(square!.toFix).toBeUndefined();
    expect(square!.signIn).toBe(PAYMENTS_PAGE_WORDS.squareRenews);
  });
});
