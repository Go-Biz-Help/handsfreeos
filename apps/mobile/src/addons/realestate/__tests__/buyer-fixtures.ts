import type { HomesView, MatchesView } from '@hfos/core/addons/realestate/views/buyer';
import type { ListingFacts } from '@hfos/core/addons/realestate/homes';

import type { BuyerDeal } from '../buyer-kit';

/**
 * The boards' people and homes (82–84) as core's views give them: the Nguyen purchase, Linh its client, and homes
 * from the MLS through Repliers. At 10:42 AM in Austin on Saturday, October 3.
 */

export const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const DEAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const LINH = '11111111-1111-4111-8111-111111111111';
export const AGENT = '22222222-2222-4222-8222-222222222222';
export const TZ = 'America/Chicago';
export const TODAY = '2026-10-03';
export const NOW = Date.parse('2026-10-03T15:42:00.000Z');

export const DEAL_REF: BuyerDeal = {
  id: DEAL,
  name: 'Nguyen purchase',
  side: 'buyer',
  full: true,
  clients: [{ personId: LINH, name: 'Linh Nguyen' }],
  who: 'Linh',
};

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function mls(
  over: Partial<NonNullable<HomesView['homes'][number]['mls']>> & { facts?: ListingFacts } = {},
): NonNullable<HomesView['homes'][number]['mls']> {
  return {
    mlsNumber: 'ACT-6612408',
    status: 'active',
    statusWords: 'For sale',
    sourceWords: 'From the MLS (Unlock MLS, through Repliers)',
    listPriceCents: 40_900_000,
    soldPriceCents: null,
    soldOn: null,
    daysOnMarket: 12,
    facts: { price_cents: 40_900_000, beds: 3, baths: 2, sqft: 1780, hoa_monthly_cents: 3500 },
    photos: [{ url: 'https://photos.test/front.jpg', caption: 'Front' }],
    description: null,
    differs: [],
    display: {
      notice: 'Information deemed reliable but not guaranteed; verify it. © 2026 Unlock MLS.',
      logoUrl: null,
      courtesy: 'Listing courtesy of Compass RE Texas.',
    },
    checkedAt: '2026-10-03T15:42:00.000Z',
    ...over,
  };
}

export function home(over: Partial<HomesView['homes'][number]> = {}): HomesView['homes'][number] {
  return {
    id: id(1),
    address: '418 Maple Ave, Austin, TX 78704',
    source: 'mls',
    link: null,
    status: 'saved',
    statusNote: null,
    facts: {},
    factSources: {},
    factsState: 'none',
    factsFailure: null,
    hasPastedText: false,
    mls: mls(),
    mlsState: 'found',
    mlsWords: null,
    fit: { lines: [], met: 0, missed: 0, unknown: 0 },
    reactions: [],
    addedBy: { id: AGENT, fullName: 'Sam Rivera' },
    addedByClient: null,
    addedAt: '2026-09-28T15:00:00.000Z',
    ...over,
  };
}

export function match(
  over: Partial<MatchesView['matches'][number]> = {},
): MatchesView['matches'][number] {
  return {
    id: id(21),
    state: 'new',
    address: '31 Live Oak Ln, Austin, TX 78745',
    mls: mls({
      mlsNumber: 'ACT-7001',
      listPriceCents: 41_900_000,
      facts: { price_cents: 41_900_000, beds: 3, baths: 2, sqft: 1920 },
      display: { notice: null, logoUrl: null, courtesy: 'ACTRIS · courtesy of Compass RE Texas' },
    }),
    fit: { lines: [], met: 0, missed: 0, unknown: 0 },
    foundAt: '2026-10-03T11:42:00.000Z',
    changedAt: null,
    homeId: null,
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}
