/**
 * Real Estate Agent, round five, step 3, in the worker: its listing feed. Each supplier's adapter asks in that
 * supplier's own words and brings back core's one shape; the stand-in answers the same questions; and asking the
 * business's feed uses its own account before HandsFreeOS's and records whether it worked.
 *
 * The suppliers' answers here are made up in their documented shapes (Repliers' listings, RESO's Property with
 * Media, AnyProp's token and MLS profiles); nothing leaves the worker.
 */
import { randomUUID } from 'node:crypto';
import {
  addonConnectionCommands,
  ADDON_CATALOG,
  catalogAddon,
  executeCommand,
  type HumanActor,
} from '@hfos/core/server';
import { FeedListingSchema, FeedSearchSchema } from '@hfos/core/addons/realestate/feed';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { ConnectionRefused } from '../src/addons/connections';
import { addonScope } from '../src/addons/context';
import { addonWorkerModuleIssues } from '../src/addons/index';
import { ADDON_WORKER_MODULES } from '../src/addons/modules';
import { anypropFromFields, tryAnypropFields } from '../src/addons/realestate/feed/anyprop';
import {
  askFeed,
  FeedUnreachable,
  FeedUnsupported,
  listingDataTesters,
  putStandinListing,
  resetStandin,
} from '../src/addons/realestate/feed/index';
import {
  createRepliersFeed,
  fromRepliers,
  repliersParams,
} from '../src/addons/realestate/feed/repliers';
import {
  fromReso,
  resoFilter,
  resoFromFields,
  tryResoFields,
} from '../src/addons/realestate/feed/reso';
import { createStandinFeed } from '../src/addons/realestate/feed/standin';
import type { FeedFetch } from '../src/addons/realestate/feed/types';
import { workerMeta } from '../src/services';
import { testServices, type TestServices } from './helpers';

const q = (input: Parameters<typeof FeedSearchSchema.parse>[0]) => FeedSearchSchema.parse(input);
const signal = () => AbortSignal.timeout(5_000);

/** A fetch that answers from a script, and writes down what it was asked. */
function scripted(answer: (url: URL, init: RequestInit) => { status?: number; body: unknown }) {
  const asked: { url: URL; init: RequestInit }[] = [];
  const f: FeedFetch = async (url, init) => {
    const u = new URL(url);
    asked.push({ url: u, init });
    const a = answer(u, init);
    return new Response(JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: f, asked };
}

const REPLIERS_LISTING = {
  mlsNumber: 'A1234567',
  boardId: 16,
  status: 'A',
  lastStatus: 'New',
  standardStatus: 'Active',
  class: 'ResidentialProperty',
  listPrice: '525000.00',
  originalPrice: '535000',
  listDate: '2026-09-20T00:00:00.000Z',
  updatedOn: '2026-09-28T14:02:11.000Z',
  daysOnMarket: 12,
  address: {
    streetNumber: '1204',
    streetName: 'Elm',
    streetSuffix: 'St',
    unitNumber: null,
    city: 'Austin',
    state: 'TX',
    zip: '78704',
  },
  map: { latitude: 30.2481, longitude: -97.7663 },
  details: {
    numBedrooms: 3,
    numBathrooms: 2,
    sqft: '1850',
    yearBuilt: '1962',
    propertyType: 'Single Family Residence',
    description: 'Shady lot, new roof.',
    numGarageSpaces: 2,
  },
  lot: { acres: 0.2 },
  images: ['sample/IMG-A1234567_1.jpg', 'sample/IMG-A1234567_2.jpg'],
  office: { brokerageName: 'Hill Country Realty' },
  agents: [{ name: 'Dana Agent' }],
  permissions: { displayAddressOnInternet: 'Y' },
};

const RESO_PROPERTY = {
  ListingKey: 'K-99',
  ListingId: '7788123',
  OriginatingSystemName: 'actris',
  StandardStatus: 'Closed',
  ListPrice: 410000,
  ClosePrice: 402500,
  CloseDate: '2026-08-14',
  ListingContractDate: '2026-07-01',
  StreetNumber: '88',
  StreetName: 'Pecan Grove',
  StreetSuffix: 'Rd',
  City: 'Austin',
  StateOrProvince: 'TX',
  PostalCode: '78745',
  Latitude: 30.2112,
  Longitude: -97.7932,
  BedroomsTotal: 3,
  BathroomsFull: 2,
  BathroomsHalf: 1,
  LivingArea: 1640,
  LotSizeSquareFeet: 7200,
  YearBuilt: 1988,
  AssociationFee: 600,
  AssociationFeeFrequency: 'Annually',
  PropertyType: 'Residential',
  PropertySubType: 'Townhouse',
  ListOfficeName: 'Lone Star Homes',
  ModificationTimestamp: '2026-08-15T09:00:00Z',
  Media: [
    { MediaURL: 'https://media.example.com/2.jpg', Order: 2, MediaCategory: 'Photo' },
    { MediaURL: 'https://media.example.com/1.jpg', Order: 1, ShortDescription: 'Front' },
    { MediaURL: 'https://media.example.com/plan.pdf', Order: 3, MediaCategory: 'Document' },
  ],
};

describe('Repliers', () => {
  it('reads a listing into core’s shape', () => {
    const l = fromRepliers(REPLIERS_LISTING)!;
    expect(FeedListingSchema.parse(l)).toEqual(l);
    expect(l).toMatchObject({
      provider: 'repliers',
      mls: { id: '16' },
      listingKey: '16:A1234567',
      mlsNumber: 'A1234567',
      status: 'active',
      address: { line: '1204 Elm St', city: 'Austin', zip: '78704', hidden: false },
      facts: {
        price_cents: 52_500_000,
        beds: 3,
        baths: 2,
        sqft: 1850,
        lot_sqft: 8712,
        year_built: 1962,
        property_type: 'single_family',
        garage_spaces: 2,
      },
      originalPriceCents: 53_500_000,
      listedOn: '2026-09-20',
      display: { courtesy: 'Listing courtesy of Hill Country Realty.' },
    });
    expect(l.photos[0]!.url).toBe('https://cdn.repliers.io/sample/IMG-A1234567_1.jpg');
    // Its own codes, where RESO's word is missing.
    const { standardStatus: _, ...sold } = { ...REPLIERS_LISTING, status: 'U', lastStatus: 'Sld' };
    expect(fromRepliers(sold)!.status).toBe('sold');
  });

  it('asks in its own words, with its key, and says what a refusal means', async () => {
    const p = repliersParams(
      q({
        statuses: ['sold'],
        near: { lat: 30.25, lng: -97.77, miles: 1 },
        soldWithinDays: 180,
        priceMinCents: 30_000_000,
        bedsMin: 3,
        limit: 10,
      }),
    );
    expect(p.getAll('standardStatus')).toEqual(['Closed']);
    expect(p.get('minSoldPrice')).toBe('300000');
    expect(p.get('minBedrooms')).toBe('3');
    expect([p.get('lat'), p.get('long'), p.get('radius'), p.get('radiusUnit')]).toEqual([
      '30.25',
      '-97.77',
      '1',
      'mi',
    ]);
    expect(p.get('minSoldDate')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.get('sortBy')).toBe('soldDateDesc');

    const s = scripted(() => ({ body: { count: 1, listings: [REPLIERS_LISTING] } }));
    const feed = createRepliersFeed({ apiKey: 'rk', fetch: s.fetch });
    const page = await feed.search(q({ mlsNumbers: ['A1234567'] }), signal());
    expect(page).toMatchObject({ total: 1, listings: [{ mlsNumber: 'A1234567' }] });
    expect((s.asked[0]!.init.headers as Record<string, string>)['REPLIERS-API-KEY']).toBe('rk');
    expect(s.asked[0]!.url.searchParams.getAll('mlsNumber')).toEqual(['A1234567']);

    for (const [status, error] of [
      [401, ConnectionRefused],
      [500, FeedUnreachable],
      [400, FeedUnsupported],
    ] as const) {
      const bad = createRepliersFeed({
        apiKey: 'rk',
        fetch: scripted(() => ({ status, body: {} })).fetch,
      });
      await expect(bad.search(q({}), signal())).rejects.toBeInstanceOf(error);
    }
  });
});

describe('a RESO Web API feed', () => {
  it('reads a Property into core’s shape, photos in order and fees by the month', () => {
    const l = fromReso(RESO_PROPERTY, 'reso')!;
    expect(FeedListingSchema.parse(l)).toEqual(l);
    expect(l).toMatchObject({
      mls: { id: 'actris', name: 'actris' },
      listingKey: 'K-99',
      mlsNumber: '7788123',
      status: 'sold',
      soldPriceCents: 40_250_000,
      soldOn: '2026-08-14',
      address: { line: '88 Pecan Grove Rd', zip: '78745' },
      facts: {
        baths: 2.5,
        sqft: 1640,
        lot_sqft: 7200,
        hoa_monthly_cents: 5000,
        property_type: 'townhouse',
      },
    });
    expect(l.photos.map((p) => p.url)).toEqual([
      'https://media.example.com/1.jpg',
      'https://media.example.com/2.jpg',
    ]);
  });

  it('asks with plain OData filters on RESO’s names', () => {
    const f = resoFilter(
      q({
        statuses: ['active', 'pending'],
        priceMaxCents: 60_000_000,
        types: ['townhouse', 'condo'],
        zips: ['78704', '78745'],
        mlsNumbers: ['1'],
      }),
      'actris',
    );
    expect(f).toContain(`OriginatingSystemName eq 'actris'`);
    expect(f).toContain(
      `(StandardStatus eq 'Active' or StandardStatus eq 'Active Under Contract' or StandardStatus eq 'Pending')`,
    );
    expect(f).toContain('ListPrice le 600000');
    expect(f).toContain(`PropertySubType eq 'Townhouse'`);
    expect(f).toContain(`(PostalCode eq '78704' or PostalCode eq '78745')`);
    expect(f).toContain(`ListingId eq '1'`);
    expect(resoFilter(q({ address: "12 O'Hara Ln, Austin, TX 78704" }), null)).toContain(
      `StreetNumber eq '12' and PostalCode eq '78704'`,
    );
  });

  it('swaps a client ID and secret for a token once, and matches an address on its street', async () => {
    const s = scripted((url) =>
      url.pathname.endsWith('/token')
        ? { body: { access_token: 'tok-1', expires_in: 3600 } }
        : {
            body: {
              '@odata.count': 2,
              value: [
                RESO_PROPERTY,
                { ...RESO_PROPERTY, ListingId: '2', StreetName: 'Cedar Bend' },
              ],
            },
          },
    );
    const feed = resoFromFields(
      {
        serviceUrl: 'https://api.mls.example/odata/',
        clientId: 'id',
        clientSecret: 'secret',
        tokenUrl: 'https://api.mls.example/token',
      },
      `conn-${randomUUID()}`,
      s.fetch,
    );
    const page = await feed.search(
      q({ address: '88 Pecan Grove Rd, Austin, TX 78745', statuses: ['sold'] }),
      signal(),
    );
    await feed.search(q({}), signal());
    expect(page.listings.map((l) => l.mlsNumber)).toEqual(['7788123']);
    expect(s.asked.filter((a) => a.url.pathname.endsWith('/token'))).toHaveLength(1);
    const ask = s.asked.find((a) => a.url.pathname.endsWith('/Property'))!;
    expect((ask.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-1');
    expect(ask.url.searchParams.get('$expand')).toBe('Media');
    expect(String(s.asked[0]!.init.body)).toContain('grant_type=client_credentials');
  });

  it('says what’s missing before asking, and that an address isn’t a feed', async () => {
    await expect(tryResoFields({ serviceUrl: 'http://x' }, signal())).rejects.toThrow(/https:\/\//);
    await expect(
      tryResoFields({ serviceUrl: 'https://api.mls.example/odata' }, signal()),
    ).rejects.toThrow(/server token, or the client ID/);
    const notFound = scripted(() => ({ status: 404, body: {} }));
    await expect(
      tryResoFields(
        { serviceUrl: 'https://api.mls.example/odata', accessToken: 't' },
        signal(),
        notFound.fetch,
      ),
    ).rejects.toThrow(/didn’t answer as an MLS feed/);
    const ok = scripted(() => ({ body: { '@odata.count': 120, value: [RESO_PROPERTY] } }));
    expect(
      await tryResoFields(
        { serviceUrl: 'https://api.mls.example/odata', accessToken: 't' },
        signal(),
        ok.fetch,
      ),
    ).toEqual({
      label: 'api.mls.example',
      accountRef: null,
      details: { mls: 'actris', listings: 120 },
    });
  });
});

describe('AnyProp', () => {
  const profiles = [
    {
      originating_system_name: 'actris',
      originating_system_full_name: 'Austin Board of Realtors',
      disclaimer: '© {current_year} ACTRIS. Information deemed reliable but not guaranteed.',
      mls_logo: 'https://logos.example.com/actris.png',
      current_year: '2026',
    },
  ];
  const anyprop = () =>
    scripted((url, init) => {
      if (url.pathname.endsWith('/token'))
        return String(init.body).includes('password=right')
          ? { body: { access_token: 'ap-tok', expires_in: 2_592_000, type: 'Bearer' } }
          : { status: 401, body: {} };
      if (url.pathname.endsWith('/mls_profiles')) return { body: profiles };
      return { body: { '@odata.totalCount': 1, value: [RESO_PROPERTY] } };
    });

  it('signs in with its username and password, and shows each MLS’s notice and logo', async () => {
    const s = anyprop();
    const feed = anypropFromFields(
      { username: 'u', password: 'right' },
      `c-${randomUUID()}`,
      s.fetch,
      'https://api.anyprop.test/v1',
    );
    const page = await feed.search(q({ statuses: ['sold'] }), signal());
    expect(page.total).toBe(1);
    expect(page.listings[0]).toMatchObject({
      provider: 'anyprop',
      mls: { id: 'actris', name: 'Austin Board of Realtors' },
      display: {
        notice: '© 2026 ACTRIS. Information deemed reliable but not guaranteed.',
        logoUrl: 'https://logos.example.com/actris.png',
      },
    });
    expect(s.asked.find((a) => a.url.pathname.endsWith('/Property'))!.url.pathname).toBe(
      '/v1/listings/data/Property',
    );
  });

  it('tries a username and password, and says when they’re turned down', async () => {
    expect(
      await tryAnypropFields(
        { username: 'u', password: 'right' },
        signal(),
        anyprop().fetch,
        'https://api.anyprop.test/v1',
      ),
    ).toEqual({ label: 'u', accountRef: 'u', details: { mlss: ['Austin Board of Realtors'] } });
    await expect(
      tryAnypropFields(
        { username: 'u', password: 'nope' },
        signal(),
        anyprop().fetch,
        'https://api.anyprop.test/v1',
      ),
    ).rejects.toThrow(/AnyProp turned that username and password down/);
  });
});

describe('the stand-in supplier', () => {
  afterAll(resetStandin);

  it('answers the same questions a supplier does', async () => {
    const feed = createStandinFeed();
    const active = await feed.search(q({ zips: ['78704'], bedsMin: 3, limit: 100 }), signal());
    expect(active.listings.length).toBeGreaterThan(0);
    expect(
      active.listings.every(
        (l) => l.status === 'active' && l.address.zip === '78704' && l.facts.beds! >= 3,
      ),
    ).toBe(true);
    for (const l of active.listings) FeedListingSchema.parse(l);

    const comps = await feed.search(
      q({
        statuses: ['sold'],
        near: { lat: 30.2481, lng: -97.7663, miles: 3 },
        soldWithinDays: 365,
        limit: 100,
      }),
      signal(),
    );
    expect(comps.listings.length).toBeGreaterThan(0);
    expect(comps.listings.every((l) => l.status === 'sold' && !!l.soldPriceCents)).toBe(true);

    const one = active.listings[0]!;
    const found = await feed.search(
      q({ address: `${one.address.line}, Austin, TX ${one.address.zip}` }),
      signal(),
    );
    expect(found.listings.map((l) => l.mlsNumber)).toContain(one.mlsNumber);

    putStandinListing({ ...one, mlsNumber: 'OURS-1', listingKey: 'ours-1', status: 'active' });
    expect((await feed.search(q({ mlsNumbers: ['OURS-1'] }), signal())).listings).toHaveLength(1);
  });

  it('tries any key but one with “wrong” in it', async () => {
    const t = listingDataTesters();
    await expect(
      t['repliers']!({ apiKey: 'k' }, { fake: true, signal: signal() }),
    ).resolves.toMatchObject({
      label: 'Stand-in Repliers account',
    });
    await expect(
      t['anyprop']!({ username: 'u', password: 'wrong' }, { fake: true, signal: signal() }),
    ).rejects.toBeInstanceOf(ConnectionRefused);
  });
});

describe('asking the business’s feed', () => {
  const realestate = catalogAddon('realestate');
  const cmds = addonConnectionCommands(ADDON_CATALOG);
  const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
  const human = (u: TestUser): HumanActor => ({
    type: 'human',
    userId: u.id,
    email: u.email,
    claims: u.claims,
  });
  let s: TestServices;
  let owner: TestUser;
  let staff: TestUser;
  let ws: string;
  let org: string;

  const ctx = (fake: boolean) =>
    addonScope(
      { ...s, addonConnect: { fake, platformKeys: { 'realestate.repliers': { apiKey: 'ours' } } } },
      realestate,
      { workspaceId: ws, organizationId: org },
      1,
      workerMeta(),
    );
  const health = async (id: string) =>
    (
      await rows<{ status: string; failures: number; last_error: string | null }>(
        testDbs().admin.db,
        sql`select status, failures, last_error from app.addon_connections where id = ${id}`,
      )
    )[0];

  beforeAll(async () => {
    s = testServices();
    [owner, staff] = await Promise.all([
      createTestUser('feed-owner'),
      createTestUser('feed-staff'),
    ]);
    ws = await realestateBusiness(owner, 'Feed Realty');
    [{ organization_id: org }] = (await rows<{ organization_id: string }>(
      testDbs().admin.db,
      sql`select organization_id from app.workspaces where id = ${ws}`,
    )) as [{ organization_id: string }];
    await rows(
      testDbs().admin.db,
      sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
          on conflict (user_id) do update set role = 'admin', status = 'active'`,
    );
  }, 120_000);
  afterAll(closeTestDbs);

  it('the real worker modules match the catalogue', () => {
    expect(addonWorkerModuleIssues(ADDON_CATALOG, ADDON_WORKER_MODULES)).toEqual([]);
  });

  it('is nothing until a feed is connected', async () => {
    expect(await askFeed(ctx(true), { zips: ['78704'] })).toBeNull();
  });

  it('uses HandsFreeOS’s Repliers account once staff turn it on, and records that it worked', async () => {
    await executeCommand(
      testDbs().api.db,
      cmds.platform,
      {
        workspaceId: ws,
        addonId: 'realestate',
        connector: 'listing_data',
        provider: 'repliers',
        on: true,
      },
      human(staff),
      meta(),
    );
    const s1 = scripted(() => ({ body: { count: 1, listings: [REPLIERS_LISTING] } }));
    const answer = (await askFeed(ctx(false), { mlsNumbers: ['A1234567'] }, { fetch: s1.fetch }))!;
    expect(answer.connection).toMatchObject({ provider: 'repliers', auth: 'platform' });
    expect(answer.listings[0]!.mlsNumber).toBe('A1234567');
    // HandsFreeOS's own key, from the worker's environment.
    expect((s1.asked[0]!.init.headers as Record<string, string>)['REPLIERS-API-KEY']).toBe('ours');
    expect(await health(answer.connection.id)).toMatchObject({ status: 'active', failures: 0 });

    // A supplier that doesn't answer counts against it, and the caller tries later.
    const down = scripted(() => ({ status: 503, body: {} }));
    await expect(askFeed(ctx(false), {}, { fetch: down.fetch })).rejects.toBeInstanceOf(
      FeedUnreachable,
    );
    expect(await health(answer.connection.id)).toMatchObject({ status: 'active', failures: 1 });
    // A question it can't answer isn't the connection failing.
    const cant = scripted(() => ({ status: 400, body: {} }));
    await expect(askFeed(ctx(false), {}, { fetch: cant.fetch })).rejects.toBeInstanceOf(
      FeedUnsupported,
    );
    expect(await health(answer.connection.id)).toMatchObject({ failures: 1 });
  });

  it('uses the business’s own account before HandsFreeOS’s, and asks for its key again when it’s turned down', async () => {
    const { output } = await executeCommand(
      testDbs().worker.db,
      cmds.save,
      {
        workspaceId: ws,
        addonId: 'realestate',
        connector: 'listing_data',
        provider: 'repliers',
        auth: 'key',
        label: 'Repliers account',
        accountRef: null,
        secretEnc: s.sealer.seal(JSON.stringify({ apiKey: 'theirs' })),
        keyId: s.sealer.keyId,
        connectedBy: owner.id,
      },
      { type: 'system', workspaceId: ws, organizationId: org, onBehalfOf: owner.id },
      meta(),
    );
    const refused = scripted(() => ({ status: 401, body: {} }));
    await expect(askFeed(ctx(false), {}, { fetch: refused.fetch })).rejects.toBeInstanceOf(
      ConnectionRefused,
    );
    expect((refused.asked[0]!.init.headers as Record<string, string>)['REPLIERS-API-KEY']).toBe(
      'theirs',
    );
    expect(await health(output.connectionId)).toMatchObject({
      status: 'reauth_required',
      last_error: expect.stringMatching(/Repliers turned that API key down/),
    });
    // While it needs its key again, HandsFreeOS's account answers.
    const ok = scripted(() => ({ body: { count: 0, listings: [] } }));
    expect((await askFeed(ctx(false), {}, { fetch: ok.fetch }))!.connection.auth).toBe('platform');
  });

  it('answers from the stand-in in development, whoever’s account it is', async () => {
    const answer = (await askFeed(ctx(true), { zips: ['78745'], limit: 5 }))!;
    expect(answer.listings.length).toBeGreaterThan(0);
    expect(answer.listings.every((l) => l.provider === 'standin')).toBe(true);
  });
});
