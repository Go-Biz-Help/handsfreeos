/**
 * Real Estate Agent, round five, step 3: the one shape every listing feed is read into, and the words that go with
 * it. Pure: what an MLS calls a status or a kind of home, baths in halves, money in cents, and an address split for
 * asking a feed.
 */
import { describe, expect, it } from 'vitest';
import {
  addressParts,
  bathsOf,
  centsOf,
  dayOf,
  FEED_STATUS_KEYS,
  feedAddressWords,
  feedFacts,
  feedStatusOf,
  FeedSearchSchema,
  homeTypeOf,
  STANDARD_STATUSES,
} from '../../src/addons/realestate/feed';
import { realestateAddon } from '../../src/addons/realestate/manifest';
import { manifestIssues } from '../../src/addons/manifest';

describe('a feed’s words, in ours', () => {
  it('reads RESO’s StandardStatus, and asks for each of ours by it', () => {
    expect(
      [
        'Active',
        'Coming Soon',
        'Active Under Contract',
        'Pending',
        'Closed',
        'Expired',
        'Withdrawn',
        'Canceled',
        'Hold',
        '',
        null,
      ].map(feedStatusOf),
    ).toEqual([
      'active',
      'coming_soon',
      'pending',
      'pending',
      'sold',
      'off_market',
      'off_market',
      'off_market',
      'off_market',
      'off_market',
      'off_market',
    ]);
    for (const s of FEED_STATUS_KEYS)
      for (const std of STANDARD_STATUSES[s]) expect(feedStatusOf(std)).toBe(s);
  });

  it('reads what kind of home it is from the MLS’s words', () => {
    expect(homeTypeOf('Single Family Residence', 'Residential')).toBe('single_family');
    expect(homeTypeOf('Condominium')).toBe('condo');
    expect(homeTypeOf(null, 'CondoProperty')).toBe('condo');
    expect(homeTypeOf('Townhouse')).toBe('townhouse');
    expect(homeTypeOf('Duplex')).toBe('multi_family');
    expect(homeTypeOf('Manufactured On Land')).toBe('manufactured');
    expect(homeTypeOf(null, 'Land')).toBe('land');
    expect(homeTypeOf('Farm', 'Residential')).toBe('single_family');
    expect(homeTypeOf(null, null)).toBeNull();
  });

  it('counts baths in halves, and money in cents', () => {
    expect(bathsOf(2, 1, null)).toBe(2.5);
    expect(bathsOf(null, null, 3)).toBe(3);
    expect(bathsOf(null, null, null)).toBeUndefined();
    expect(centsOf('525,000.00')).toBe(52_500_000);
    expect(centsOf(0)).toBeUndefined();
    expect(centsOf('call')).toBeUndefined();
    expect(dayOf('2026-09-20T00:00:00Z')).toBe('2026-09-20');
    expect(dayOf(20260920)).toBeNull();
  });

  it('splits an address for asking a feed, and says one back', () => {
    expect(addressParts('1204 Elm St, Austin, TX 78704')).toEqual({
      number: '1204',
      street: 'Elm',
      zip: '78704',
    });
    expect(addressParts('88 N. Pecan Grove Rd, Austin TX 78745-1234')).toEqual({
      number: '88',
      street: 'Pecan',
      zip: '78745',
    });
    expect(addressParts('Lot 4, Hill Rd')).toEqual({ number: null, street: null, zip: null });
    expect(
      feedAddressWords({
        line: '700 Lamar Blvd',
        unit: '304',
        city: 'Austin',
        state: 'TX',
        zip: '78703',
        hidden: false,
      }),
    ).toBe('700 Lamar Blvd, Unit 304, Austin, TX 78703');
    expect(feedFacts({ facts: { beds: 3, sqft: undefined, baths: 2 } })).toEqual({
      beds: 3,
      baths: 2,
    });
  });

  it('asks for homes for sale, 25 at a time, unless told otherwise', () => {
    expect(FeedSearchSchema.parse({})).toMatchObject({ statuses: ['active'], limit: 25, page: 0 });
    expect(FeedSearchSchema.safeParse({ zips: ['787'] }).success).toBe(false);
  });

  it('names its listing feed’s suppliers in the manifest, managed by whoever runs the settings', () => {
    expect(manifestIssues(realestateAddon)).toEqual([]);
    const feed = realestateAddon.connectors!.find((c) => c.key === 'listing_data')!;
    expect(feed.permission).toBe('realestate.manage');
    expect(feed.providers.map((p) => [p.id, p.auth])).toEqual([
      ['repliers', ['platform', 'key']],
      ['anyprop', ['key']],
      ['reso', ['key']],
    ]);
  });
});
