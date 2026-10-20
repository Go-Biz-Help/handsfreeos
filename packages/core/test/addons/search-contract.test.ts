/**
 * Add-ons answer searches (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Add-ons answer searches", Search 4a), on a
 * made-up add-on that answers with two kinds of its own, so nothing real is needed yet:
 *
 *   - `manifestIssues` holds the declaration to its rules, and `addonSearchIssues` the query to core's contract: its
 *     own, for people alone, core's shapes, no `ai`, and `route: false`.
 *   - It answers only while it's on, and for people holding its permission; its kinds sit in the add-ons' slot.
 *   - It gets core's probes, never what was typed. Its hits keep to its own pages and the record they're about (`..`
 *     however it's written stays out), its own kinds, and the kinds asked for.
 *   - `covers` takes its kind of records out of core's group only when it answered for every kind it has, and its
 *     archived records stay under Archived.
 *   - A failure of any kind (a database error holding the typed words, a refusal, a timeout, a budget spent before
 *     the add-ons running here were read) leaves the rest of the search standing, its own group marked failed, and
 *     what was typed in no log line. Its statements are held to its own cap.
 *   - `search.kind` pages through one of its kinds in its own order, counting as far as core's kinds' pages do,
 *     refused while it's off, to someone without its permission, for a kind it doesn't have, and when it runs out of
 *     time; too short runs nothing.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineAddon, manifestIssues, type AddonManifest } from '../../src/addons/manifest';
import { defineAddonQuery, type AddonServerModule } from '../../src/addons/server';
import { HfosError } from '../../src/errors';
import { defineQuery } from '../../src/kernel/define';
import type { Permission } from '../../src/permissions';
import type { SearchEverythingOutput, SearchKindOutput } from '../../src/schemas/search';
import {
  AddonSearchInput,
  AddonSearchOutput,
  addonHrefOk,
  type AddonSearchHit,
} from '../../src/search/addon';
import { searchKindsFor } from '../../src/search/kinds';
import { tierOf } from '../../src/search/rank';
import { SEARCH_BUDGETS, type KindSearcher, type RunOptions } from '../../src/search/server/run';
import { ADDON_SERVER_MODULES, addonSearchIssues, CONTRIBUTOR_MS } from '../../src/server';
import {
  admin,
  expectHfos,
  groupOf,
  runAs,
  searchWorld,
  titles,
  type World,
} from '../search/helpers';

const ADDON = 'fxsearch';

const fxsearch = defineAddon({
  id: ADDON,
  name: 'Search Fixture',
  summary: 'A made-up add-on that answers searches.',
  description: 'A test fixture.',
  category: 'industry',
  version: '1.0.0',
  dataVersion: 1,
  catalog: { status: 'development', keywords: ['fixture'] },
  capabilities: [
    {
      id: 'fxsearch.use',
      label: 'Spots and trips',
      description: 'Spots and trips.',
      permission: 'fxsearch.use',
    },
  ],
  permissions: [
    {
      key: 'fxsearch.use',
      label: 'Use the search fixture',
      description: 'Its spots and trips.',
      defaultRoles: ['admin'],
    },
  ],
  recordKinds: [
    {
      key: 'fxsearch_place',
      singular: 'Place',
      plural: 'Places',
      icon: 'home',
      writePermission: 'fxsearch.use',
    },
  ],
  billing: { model: 'free' },
  search: {
    query: 'fxsearch.search',
    kinds: [
      { key: 'spots', singular: 'Spot', plural: 'Spots', icon: 'home' },
      { key: 'trips', singular: 'Trip', plural: 'Trips', icon: 'car' },
    ],
    covers: ['fxsearch_place'],
    permission: 'fxsearch.use',
  },
});

/** How the fixture's search behaves this time. */
let mode: 'answer' | 'drizzle' | 'refuse' | 'slow' | 'hrefs' | 'cursor' | 'careless' | 'many' =
  'answer';
/** What it was last asked, and the error it last threw. */
let asked: AddonSearchInput | null = null;
let thrown: unknown = null;

/** Seven trips and one archived, every one found by "trip", in its own order (by name). */
const TRIPS = [
  ...Array.from({ length: 7 }, (_, i) => ({
    id: randomUUID(),
    name: `Trip ${i + 1}`,
    archived: false,
  })),
  { id: randomUUID(), name: 'Trip archived', archived: true },
];

const hit = (id: string, title: string, tier: number, more: Partial<AddonSearchHit> = {}) => ({
  id,
  title,
  subtitle: null,
  badges: [],
  why: { label: null, snippet: null },
  exact: false,
  tier,
  at: null,
  href: `/a/fxsearch/spots/${id}`,
  recordId: null,
  ...more,
});

const fxsearchQuery = defineAddonQuery(fxsearch, {
  name: 'fxsearch.search',
  description: 'Spots and trips, for the search tests.',
  input: AddonSearchInput,
  output: AddonSearchOutput,
  permission: 'fxsearch.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  route: false,
  handler: async (ctx, input) => {
    asked = input;
    try {
      // A database error holding what was typed among its parameters, as Drizzle's always do.
      if (mode === 'drizzle') await rows(ctx.tx, sql`select ${input.probes.words.join(' ')}::int`);
      if (mode === 'slow') await rows(ctx.tx, sql`select pg_sleep(5)`);
      if (mode === 'refuse') throw HfosError.addonInactive(fxsearch);
    } catch (e) {
      thrown = e;
      throw e;
    }
    const wants = (kind: string) => !input.kinds || input.kinds.includes(kind);
    // Its kind of record, read as the person and ranked with core's tiers; archived ones only when asked for.
    const places = await rows<{ id: string; name: string; archived: boolean }>(
      ctx.tx,
      sql`select r.id, r.name, r.archived_at is not null as archived from app.custom_records r
          join app.custom_record_types t on t.id = r.type_id
          where r.workspace_id = ${input.workspaceId} and t.addon_id = ${ADDON}`,
    );
    const spots = places.flatMap((r) => {
      const tier = tierOf(r.name, input.probes);
      return tier && (!r.archived || input.includeArchived)
        ? [hit(r.id, r.name, tier, { recordId: r.id, badges: r.archived ? ['archived'] : [] })]
        : [];
    });
    if (mode === 'hrefs' && spots[0]) {
      const s = spots[0];
      const other = randomUUID();
      spots.push(
        hit(randomUUID(), 'Its record’s page', 3, {
          href: `/customers/records/${s.id}?tab=files`,
          recordId: s.id,
        }),
        hit(randomUUID(), 'Another add-on’s page', 3, { href: `/a/realestate/deals/${s.id}` }),
        hit(randomUUID(), 'Somewhere else', 3, { href: 'https://example.com/a/fxsearch/x' }),
        hit(randomUUID(), 'Out by dots', 3, { href: '/a/fxsearch/../../settings/members' }),
        hit(randomUUID(), 'Out by written dots', 3, {
          href: `/a/fxsearch/%2e%2E/%2E%2e/customers/records/${other}`,
        }),
        hit(randomUUID(), 'Another record', 3, {
          href: `/customers/records/${other}`,
          recordId: s.id,
        }),
        hit(randomUUID(), 'A customer', 3, { href: `/customers/people/${other}` }),
        hit(randomUUID(), 'Its own page', 3, { href: `/a/${ADDON}?spot=1` }),
      );
    }
    // Archived ones only when they're asked for, unless it's careless about it.
    const trips = TRIPS.filter(
      (t) =>
        tierOf(t.name, input.probes) &&
        (!t.archived || input.includeArchived || mode === 'careless'),
    ).map((t) =>
      hit(t.id, t.name, 1, {
        href: `/a/fxsearch/trips/${t.id}`,
        badges: t.archived ? ['archived'] : [],
      }),
    );
    if (mode === 'cursor' && input.cursor === 'not-ours')
      throw HfosError.validation([{ path: 'cursor', message: 'Start again.' }]);
    const from = Number(input.cursor ?? 0);
    const page = trips.slice(from, from + input.perKind);
    return {
      groups: [
        ...(wants('spots') && spots.length
          ? [{ kind: 'spots', total: spots.length, capped: false, nextCursor: null, items: spots }]
          : []),
        ...(wants('trips') && trips.length
          ? [
              {
                kind: 'trips',
                total: mode === 'many' ? 120 : trips.length,
                capped: false,
                nextCursor:
                  from + input.perKind < trips.length ? String(from + input.perKind) : null,
                items: page,
              },
            ]
          : []),
        // A kind it never declared.
        {
          kind: 'secrets',
          total: 1,
          capped: false,
          nextCursor: null,
          items: [hit(randomUUID(), 'Secret', 0)],
        },
      ],
    };
  },
});

const fxsearchServer: AddonServerModule = {
  manifest: fxsearch,
  commands: [],
  queries: [fxsearchQuery],
};
const withFixture: RunOptions = { addons: [fxsearchServer] };

const SECRET = 'zqtypedaddonwords';

let w: World;
let placeType: string;
let place: string;
let archivedPlace: string;

beforeAll(async () => {
  w = await searchWorld('search-contract');
  await rows(
    admin(),
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify(fxsearch.permissions)}::jsonb)`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${w.wsId}, ${ADDON}, 'enabled', '1.0.0')`,
  );
  placeType = (
    await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, icon, position, addon_id,
            write_permission)
          values (${w.wsId}, 'fxsearch_place', 'Place', 'Places', 'home', 90, ${ADDON}, 'fxsearch.use')
          returning id`,
    )
  )[0]!.id;
  place = (
    await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_records (workspace_id, type_id, name)
          values (${w.wsId}, ${placeType}, 'Smith Landing') returning id`,
    )
  )[0]!.id;
  archivedPlace = (
    await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_records (workspace_id, type_id, name, archived_at)
          values (${w.wsId}, ${placeType}, 'Quillwort Manor', now()) returning id`,
    )
  )[0]!.id;
});
afterEach(() => {
  mode = 'answer';
  asked = null;
  thrown = null;
  vi.restoreAllMocks();
});
afterAll(closeTestDbs);

const everythingAs = (
  u: World['owner'],
  q: string,
  more: Record<string, unknown> = {},
  opts = withFixture,
) => runAs(w, u, { workspaceId: w.wsId, q, ...more }, opts) as Promise<SearchEverythingOutput>;
const kindAs = (
  u: World['owner'],
  q: string,
  kind: string,
  more: Record<string, unknown> = {},
  opts = withFixture,
) => runAs(w, u, { workspaceId: w.wsId, q, kind, ...more }, opts) as Promise<SearchKindOutput>;

/** Every line logged while `fn` runs. */
async function logged<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '),
    );
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation(keep);
  const result = await fn();
  return { result, lines };
}

describe('the declaration and the query', () => {
  it('holds every real add-on and the fixture to the contract', () => {
    expect(manifestIssues(fxsearch)).toEqual([]);
    expect(addonSearchIssues(ADDON_SERVER_MODULES)).toEqual([]);
    expect(addonSearchIssues([fxsearchServer])).toEqual([]);
  });

  it('refuses a declaration under another name, with a foreign permission or an unknown kind of records', () => {
    const declared = (search: NonNullable<AddonManifest['search']>) =>
      manifestIssues({ ...fxsearch, search }).map((i) => i.message);
    const s = fxsearch.search;
    expect(declared({ ...s, query: 'realestate.search' })).toEqual([
      'search runs "realestate.search", which must start with "fxsearch."',
    ]);
    expect(declared({ ...s, permission: 'realestate.use' })).toEqual([
      'search runs for "realestate.use", which isn\'t one of its permissions',
    ]);
    expect(declared({ ...s, covers: ['realestate_property'] })).toEqual([
      'search covers "realestate_property", which isn\'t one of its kinds of records',
    ]);
    expect(declared({ ...s, kinds: [] })).toEqual(['search needs at least one kind']);
    expect(
      declared({
        ...s,
        kinds: [
          { key: 'Spots!', singular: 'Spot', plural: 'Spots', icon: 'home' },
          { key: 'trips', singular: 'Trip', plural: 'Trips', icon: 'house' },
          { key: 'trips', singular: 'Trip', plural: '', icon: 'car' },
        ],
      }),
    ).toEqual([
      'search kind "Spots!" must be 2–31 lowercase letters, digits and underscores',
      'search kind "trips"\'s icon "house" isn\'t one of the record icons',
      'search kind "trips"\'s plural must be 1–40 characters',
      'search kind "trips" is declared twice',
    ]);
  });

  it('refuses a missing query, and one that isn’t its own, for people alone, on core’s shapes, kept from the AI and off the API', () => {
    const def = {
      name: 'fxsearch.search' as const,
      description: fxsearchQuery.description,
      input: AddonSearchInput,
      output: AddonSearchOutput,
      permission: 'fxsearch.use' as const,
      scope: fxsearchQuery.scope,
      route: false as const,
      handler: fxsearchQuery.handler,
    };
    /** Its search query with one thing changed, or none at all. */
    const issues = (change?: Record<string, unknown>) =>
      addonSearchIssues([
        {
          manifest: fxsearch,
          queries: change ? [defineAddonQuery(fxsearch, { ...def, ...change } as typeof def)] : [],
        },
      ]);
    expect(issues({})).toEqual([]);
    expect(issues()).toEqual(['fxsearch: search runs "fxsearch.search", which it doesn\'t have']);
    expect(issues({ route: undefined })).toEqual([
      'fxsearch: search query "fxsearch.search" must be marked route: false, so it never runs outside a search, around its limits',
    ]);
    expect(issues({ ai: { tool: 'fxsearch_search' } })).toEqual([
      'fxsearch: search query "fxsearch.search" isn\'t offered to the AI',
    ]);
    expect(issues({ input: AddonSearchInput.extend({}) })).toEqual([
      'fxsearch: search query "fxsearch.search" must take core\'s AddonSearchInput, the same object',
    ]);
    expect(issues({ output: z.object({ groups: z.array(z.never()) }) })).toEqual([
      'fxsearch: search query "fxsearch.search" must answer core\'s AddonSearchOutput, the same object',
    ]);
    expect(issues({ permission: 'workspace.read' })).toEqual([
      'fxsearch: search query "fxsearch.search" asks for "workspace.read", but the search runs for "fxsearch.use"',
    ]);
    expect(issues({ actors: ['human', 'system'] })).toEqual([
      'fxsearch: search query "fxsearch.search" is for people alone',
    ]);
    // The same query, defined as core's, as defineAddonQuery casts its permission.
    const notItsOwn = defineQuery({ ...def, permission: def.permission as Permission });
    expect(addonSearchIssues([{ manifest: fxsearch, queries: [notItsOwn] }])).toEqual([
      'fxsearch: search query "fxsearch.search" isn\'t one of its own (defineAddonQuery)',
    ]);
  });

  it('puts its kinds in the add-ons’ slot, for people holding its permission, and everyone under a staff view-as', () => {
    const keys = (permissions: string[], viewAs = false) =>
      searchKindsFor({ permissions, viewAs, addons: [fxsearch] }).map((k) => k.key);
    const owner = keys(['workspace.read', 'records.read', 'fxsearch.use']);
    expect(owner.slice(owner.indexOf('records'), owner.indexOf('settings') + 1)).toEqual([
      'records',
      'fxsearch.spots',
      'fxsearch.trips',
      'settings',
    ]);
    expect(keys(['workspace.read', 'records.read'])).not.toContain('fxsearch.spots');
    expect(keys([], true)).toContain('fxsearch.trips');
    const [spots] = searchKindsFor({ permissions: ['fxsearch.use'], addons: [fxsearch] });
    expect(spots).toMatchObject({
      key: 'fxsearch.spots',
      label: 'Spots',
      icon: 'home',
      addon: { id: ADDON, name: 'Search Fixture' },
    });
  });

  it('lets a link through only to its own pages, or to the page of the record a hit is about', () => {
    const ok = (href: string, recordId: string | null = null) =>
      addonHrefOk(ADDON, { href, recordId });
    expect(ok('/a/fxsearch')).toBe(true);
    expect(ok('/a/fxsearch/spots/1?x=1#y')).toBe(true);
    expect(ok(`/customers/records/${place}`, place)).toBe(true);
    expect(ok(`/customers/records/${place}`)).toBe(false);
    expect(ok(`/customers/records/${place}`, randomUUID())).toBe(false);
    expect(ok('/a/fxsearchmore/spots')).toBe(false);
    expect(ok('/a/realestate/deals/1')).toBe(false);
    expect(ok('/a/fxsearch/../../settings')).toBe(false);
    // A browser reads "%2e" as a dot, whatever its case, so these climb out just the same.
    expect(ok('/a/fxsearch/%2e%2e/realestate/deals/x')).toBe(false);
    expect(ok('/a/fxsearch/%2E%2E/%2e%2e/settings/members')).toBe(false);
    expect(ok('/a/fxsearch/.%2e/%2E./x')).toBe(false);
    expect(ok('/a/fxsearch/%2e/x')).toBe(false);
    expect(ok('/a/fxsearch/a%2f..%2fb')).toBe(false);
    expect(ok('/a/fxsearch/%E0%A4%A')).toBe(false);
    expect(ok('/a/fxsearch/spots/Main%20St?q=%2e%2e')).toBe(true);
    expect(ok('/a/fxsearch/x y')).toBe(false);
    expect(ok('/a/fxsearch\\..\\x')).toBe(false);
    expect(ok('//evil.example/a/fxsearch')).toBe(false);
  });

  it('holds what it answers to a row’s size, and its cursor to what search.kind takes back', () => {
    const answer = (more: { nextCursor?: string; snippet?: string }) =>
      AddonSearchOutput.safeParse({
        groups: [
          {
            kind: 'spots',
            total: 1,
            capped: false,
            nextCursor: more.nextCursor ?? null,
            items: [
              hit(randomUUID(), 'Spot', 1, {
                why: { label: null, snippet: { text: more.snippet ?? 'Spot', marks: [[0, 4]] } },
              }),
            ],
          },
        ],
      }).success;
    expect(answer({})).toBe(true);
    expect(answer({ nextCursor: 'x'.repeat(400) })).toBe(true);
    expect(answer({ nextCursor: 'x'.repeat(401) })).toBe(false);
    expect(answer({ snippet: 'word '.repeat(100) })).toBe(false);
  });
});

describe('answering Search everything', () => {
  it('asks it with core’s probes, and its hits join on core’s scale, under the business’s pages', async () => {
    const a = await everythingAs(w.owner, 'smith landing');
    expect(asked).toMatchObject({
      workspaceId: w.wsId,
      probes: { words: ['smith', 'landing'], folded: ['smith', 'landing'] },
      perKind: 3,
      depth: 'quick',
      includeArchived: false,
      onlyMine: false,
    });
    expect(asked!.kinds).toBeUndefined();
    // Never what was typed, to read its own way.
    expect(asked!.probes).not.toHaveProperty('q');
    const spots = groupOf(a, 'fxsearch.spots')!;
    expect(spots).toMatchObject({ label: 'Spots', icon: 'home', total: 1, unavailable: null });
    expect(spots.items[0]).toMatchObject({
      kind: 'fxsearch.spots',
      title: 'Smith Landing',
      tier: 1,
      why: { field: 'name', label: null },
      href: `/app/w/${w.wsId}/a/fxsearch/spots/${place}`,
    });
    // A tier 1 hit of an add-on's may be the best match.
    expect(a.best).toMatchObject({ kind: 'fxsearch.spots', title: 'Smith Landing' });
    // Never a kind it didn't declare.
    expect(a.groups.map((g) => g.kind)).not.toContain('fxsearch.secrets');
  });

  it('keeps its hits to its own pages and the record they’re about', async () => {
    mode = 'hrefs';
    const spots = groupOf(
      await everythingAs(w.owner, 'smith landing', { perKind: 5 }),
      'fxsearch.spots',
    );
    expect(titles(spots).sort()).toEqual(['Its own page', 'Its record’s page', 'Smith Landing']);
    expect(spots!.total).toBe(3);
  });

  it('asks only for its kinds a chip names, and leaves its archived hits out unless archived ones are asked for', async () => {
    const trips = await everythingAs(w.owner, 'trip', { kinds: ['fxsearch.trips'], perKind: 5 });
    expect(asked!.kinds).toEqual(['trips']);
    expect(trips.groups.map((g) => g.kind)).toEqual(['fxsearch.trips']);
    expect(groupOf(trips, 'fxsearch.trips')).toMatchObject({ total: 7, items: { length: 5 } });
    const all = await everythingAs(w.owner, 'trip archived', { includeArchived: true });
    expect(titles(groupOf(all, 'fxsearch.trips'))).toEqual(['Trip archived']);
    // An add-on that sends archived ones anyway has them dropped.
    mode = 'careless';
    expect(groupOf(await everythingAs(w.owner, 'trip archived'), 'fxsearch.trips')).toBeUndefined();
    // A chip of core's alone never asks it.
    asked = null;
    await everythingAs(w.owner, 'smith', { kinds: ['contacts'] });
    expect(asked).toBeNull();
  });

  it('runs only while it’s on, for people holding its permission; covers takes its records out of core’s group only when it answered', async () => {
    const owner = await everythingAs(w.owner, 'smith landing');
    expect(groupOf(owner, 'fxsearch.spots')).toBeDefined();
    expect(groupOf(owner, 'record.fxsearch_place')).toBeUndefined();
    // Someone who reads records but not the add-on still finds the place, through core's group.
    asked = null;
    const member = await everythingAs(w.member, 'smith landing');
    expect(asked).toBeNull();
    expect(groupOf(member, 'fxsearch.spots')).toBeUndefined();
    expect(titles(groupOf(member, 'record.fxsearch_place'))).toEqual(['Smith Landing']);
    // Turned off, it isn't asked, and its kind of records hides with it.
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${w.wsId} and addon_id = ${ADDON}`,
    );
    try {
      asked = null;
      const off = await everythingAs(w.owner, 'smith landing');
      expect(asked).toBeNull();
      expect(off.groups.map((g) => g.kind)).not.toContain('fxsearch.spots');
      expect(groupOf(off, 'record.fxsearch_place')).toBeUndefined();
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${w.wsId} and addon_id = ${ADDON}`,
      );
    }
  });

  it('leaves a covered kind’s archived records under Archived, and its group alone when chips ask it for only some of its kinds', async () => {
    const a = await everythingAs(w.owner, 'quillwort manor');
    expect(a.archived?.items.map((h) => h.id)).toEqual([archivedPlace]);
    expect(a.groups).toEqual([]);
    expect(a).toMatchObject({ close: false, noneActive: true });
    // Asked for its trips alone, it can't find the places it covers, so core's group stays.
    const picked = await everythingAs(w.owner, 'smith landing', {
      kinds: ['fxsearch.trips', 'record.fxsearch_place'],
    });
    expect(asked!.kinds).toEqual(['trips']);
    expect(titles(groupOf(picked, 'record.fxsearch_place'))).toEqual(['Smith Landing']);
    expect(picked.close).toBe(false);
  });

  it('keeps a database error holding the typed words to its own group, and the words out of every log line', async () => {
    mode = 'drizzle';
    const { result: a, lines } = await logged(() => everythingAs(w.owner, 'smith'));
    // The error it threw held the words, as Drizzle's errors do.
    expect(String((thrown as Error).message)).toContain('smith');
    // The rest stands: core's kinds, and core's group for its records, since it didn't answer.
    expect(titles(groupOf(a, 'contacts')).length).toBeGreaterThan(0);
    expect(titles(groupOf(a, 'record.fxsearch_place'))).toEqual(['Smith Landing']);
    expect(groupOf(a, 'fxsearch')).toMatchObject({
      label: 'Search Fixture',
      unavailable: 'failed',
      items: [],
    });
    expect(a.groups.map((g) => g.kind)).not.toContain('fxsearch.spots');
    expect(lines).toEqual(['search: the fxsearch add-on answered nothing (22P02)']);
    expect(lines.join('\n').toLowerCase()).not.toContain('smith');

    const { result: secret, lines: more } = await logged(() => everythingAs(w.owner, SECRET));
    expect(String((thrown as Error).message)).toContain(SECRET);
    expect(JSON.stringify({ ...secret, q: null })).not.toContain(SECRET);
    expect(more.join('\n')).not.toContain(SECRET);
    // Nothing else answered, but it didn't either: no close matches, and no "No one active matches".
    expect(secret).toMatchObject({ close: false, noneActive: false, total: 0 });
  });

  it('keeps a refusal and a timeout to its own group too, its statement held to its own cap', async () => {
    mode = 'refuse';
    const refused = await logged(() => everythingAs(w.owner, 'smith'));
    expect(groupOf(refused.result, 'fxsearch')?.unavailable).toBe('failed');
    expect(refused.lines).toEqual([
      'search: the fxsearch add-on answered nothing (addon_inactive)',
    ]);

    mode = 'slow';
    const caps: number[] = [];
    const slow = await logged(() =>
      everythingAs(
        w.owner,
        'smith',
        {},
        {
          ...withFixture,
          onStatement: (kind, ms) => {
            if (kind === ADDON) caps.push(ms);
          },
        },
      ),
    );
    expect(caps).toHaveLength(1);
    expect(caps[0]).toBeLessThanOrEqual(CONTRIBUTOR_MS.quick);
    expect(groupOf(slow.result, 'fxsearch')?.unavailable).toBe('failed');
    expect(titles(groupOf(slow.result, 'contacts')).length).toBeGreaterThan(0);
    expect(slow.lines).toEqual(['search: the fxsearch add-on answered nothing (too_slow)']);
  }, 20_000);

  it('holds its statements to its own cap, below a core kind’s, on the Search page and a kind’s own page', async () => {
    const caps = new Map<string, number[]>();
    const seeing: RunOptions = {
      ...withFixture,
      onStatement: (kind, ms) => caps.set(kind, [...(caps.get(kind) ?? []), ms]),
    };
    await everythingAs(w.owner, 'smith', { depth: 'full' }, seeing);
    expect(caps.get(ADDON)).toEqual([CONTRIBUTOR_MS.full]);
    expect(caps.get('contacts')![0]).toBe(SEARCH_BUDGETS.full.statementMs);
    caps.clear();
    await kindAs(w.owner, 'trip', 'fxsearch.trips', {}, seeing);
    expect(caps.get(ADDON)).toEqual([CONTRIBUTOR_MS.full]);
    expect(caps.get('addons')![0]).toBe(SEARCH_BUDGETS.kind.statementMs);
  });

  it('marks every add-on asked when the budget is spent before the add-ons running here are read', async () => {
    // A kind of core's that takes the time that was left.
    const lingering: KindSearcher = {
      key: 'contacts',
      find: async (db) => {
        await db.rows(sql`select 1`);
        await new Promise((r) => setTimeout(r, 270));
        return [];
      },
    };
    const spent = await logged(() =>
      everythingAs(
        w.owner,
        'smith',
        {},
        { ...withFixture, searchers: [lingering], budget: { requestMs: 300, statementMs: 1_000 } },
      ),
    );
    expect(groupOf(spent.result, 'fxsearch')).toMatchObject({
      label: 'Search Fixture',
      unavailable: 'failed',
    });
    expect(spent.result).toMatchObject({ close: false, noneActive: false });
    expect(spent.lines).toEqual(['search: the add-ons running here couldn’t be read (skipped)']);
    // Searching its kinds alone, that's every kind tried run out of time.
    await logged(() =>
      expectHfos(
        () =>
          everythingAs(
            w.owner,
            'smith',
            { kinds: ['fxsearch.spots'] },
            { ...withFixture, budget: { requestMs: 30, statementMs: 30 } },
          ),
        'search_took_too_long',
        503,
      ),
    );
  });
});

describe('one of its kinds on its own page', () => {
  it('pages through its kind in its own order, with its own cursor', async () => {
    const first = await kindAs(w.owner, 'trip', 'fxsearch.trips', { limit: 3, sort: 'name' });
    expect(asked).toMatchObject({ kinds: ['trips'], perKind: 3, depth: 'full', sort: 'name' });
    expect(titles(first.group)).toEqual(['Trip 1', 'Trip 2', 'Trip 3']);
    expect(first.group).toMatchObject({
      kind: 'fxsearch.trips',
      label: 'Trips',
      icon: 'car',
      total: 7,
    });
    expect(first).toMatchObject({ nextCursor: '3', standingCounts: null, duplicates: [] });
    const second = await kindAs(w.owner, 'trip', 'fxsearch.trips', {
      limit: 3,
      sort: 'name',
      cursor: first.nextCursor!,
    });
    expect(titles(second.group)).toEqual(['Trip 4', 'Trip 5', 'Trip 6']);
    // A cursor it can't read starts the list again, as core's kinds do.
    mode = 'cursor';
    await expectHfos(
      () => kindAs(w.owner, 'trip', 'fxsearch.trips', { cursor: 'not-ours' }),
      'validation',
      400,
    );
  });

  it('counts as far as core’s kinds’ pages do, runs nothing when too short, and refuses when out of time', async () => {
    mode = 'many';
    expect((await kindAs(w.owner, 'trip', 'fxsearch.trips')).group).toMatchObject({
      total: 120,
      capped: false,
    });
    // In the box it still counts to 50.
    expect(groupOf(await everythingAs(w.owner, 'trip'), 'fxsearch.trips')).toMatchObject({
      total: 50,
      capped: true,
    });

    mode = 'answer';
    let statements = 0;
    asked = null;
    const short = await kindAs(
      w.owner,
      'a',
      'fxsearch.trips',
      {},
      {
        ...withFixture,
        onStatement: () => statements++,
      },
    );
    expect(short.group).toMatchObject({ kind: 'fxsearch.trips', items: [], unavailable: null });
    expect(statements).toBe(0);
    expect(asked).toBeNull();

    mode = 'slow';
    await logged(() =>
      expectHfos(
        () =>
          kindAs(
            w.owner,
            'smith',
            'fxsearch.spots',
            {},
            {
              ...withFixture,
              budget: { requestMs: 1_000, statementMs: 1_000 },
            },
          ),
        'search_took_too_long',
        503,
      ),
    );
  }, 20_000);

  it('marks the page when it fails, and refuses while it’s off, without its permission, or for a kind it doesn’t have', async () => {
    mode = 'drizzle';
    const failed = await logged(() => kindAs(w.owner, SECRET, 'fxsearch.spots'));
    expect(failed.result.group).toMatchObject({
      kind: 'fxsearch.spots',
      unavailable: 'failed',
      complete: false,
      items: [],
    });
    expect(failed.lines.join('\n')).not.toContain(SECRET);
    mode = 'answer';

    const refused = await expectHfos(
      () => kindAs(w.member, 'smith', 'fxsearch.spots'),
      'search_kind_not_allowed',
      403,
    );
    expect(refused.message).toBe(
      'You need the “Use the search fixture” permission for that. An owner of this business can turn it on for you in Settings → Permissions.',
    );
    await expectHfos(() => kindAs(w.owner, 'smith', 'fxsearch.nothing'), 'search_kind_gone', 404);
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${w.wsId} and addon_id = ${ADDON}`,
    );
    try {
      const off = await expectHfos(
        () => kindAs(w.owner, 'smith', 'fxsearch.spots'),
        'addon_inactive',
        403,
      );
      expect(off.message).toBe('Search Fixture is turned off for this business.');
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${w.wsId} and addon_id = ${ADDON}`,
      );
    }
  });
});
