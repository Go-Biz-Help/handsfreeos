import { ROLE_PERMISSIONS, searchCopy, type CopyAnswer, type SearchHit } from '@hfos/core';

import { FakePowerSync } from '@/changes/__tests__/fake-powersync';

import { COPY_ROWS, readCopy, type CopyAsk, type CopyNarrowing } from '../copy-sql';

/**
 * The phone's own SQL for search with no signal (`copy-sql.ts`), run as the phone runs it, on SQLite with the app's
 * schema. The SQL only narrows what's read, so for every search here it must give core's `searchCopy` the same answer
 * as every row would: a letter outside ASCII typed as it's stored, a web address pasted whole, a number written
 * freely, more than three words. `packages/core/test/search/copy.test.ts` holds `searchCopy` over those rows to the
 * server's `search.kind`. And under the 200 rows a kind reads, a name, or a note's own words, isn't crowded out.
 */

// Add-ons answer from their own part of the copy (Real Estate's own test holds it); this is core's kinds alone.
jest.mock('@/addons/registry', () => ({ PHONE_ADDONS: [] }));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER: readonly string[] = [...ROLE_PERMISSIONS.owner];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

/** Every row of each kind: the three longest words are one that matches anything. */
const EVERY_ROW: CopyNarrowing = { likes: ['%'], phone: null, digits: null, domain: null };

type Row = Record<string, string | number | null>;

/** Rows into the phone's copy, as PowerSync stores them: text. */
function put(db: FakePowerSync, table: string, rows: readonly Row[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.sqlite
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .run(...columns.map((c) => row[c] ?? null));
  }
}

const ask = (q: string, kinds: readonly string[] | null = null): CopyAsk => ({
  workspaceId: WS,
  userId: id(900),
  q,
  now: Date.now(),
  timeZone: 'America/Chicago',
  permissions: OWNER,
  kinds,
});

async function answer(
  db: FakePowerSync,
  q: string,
  opts: { kinds?: readonly string[] | null; narrowing?: CopyNarrowing } = {},
): Promise<CopyAnswer> {
  const a = ask(q, opts.kinds ?? null);
  const rows = await readCopy(db, a, opts.narrowing);
  return searchCopy(q, rows, { ...a, perKind: 100 });
}

/** What a list says of each hit, by group: the parts that must agree. */
const said = (a: CopyAnswer) =>
  a.groups.map((g) => [
    g.kind,
    g.total,
    g.items.map((h: SearchHit) => [
      h.title,
      h.tier,
      h.why.field,
      h.why.snippet?.text ?? null,
      h.href,
    ]),
  ]);
const titlesIn = (a: CopyAnswer, kind: string) =>
  a.groups.find((g) => g.kind === kind)?.items.map((h) => h.title) ?? [];

const DANA = id(1);
const KIM = id(2);
const GULF = id(10);
const SMITHFIELD = id(11);
const HEATER = id(20);

function bayou(db: FakePowerSync) {
  put(db, 'companies', [
    {
      id: GULF,
      workspace_id: WS,
      name: 'Gulf Coast Realty',
      website: 'https://gulfcoastrealty.com',
      phone: '504.555.0300 ext 2',
      updated_at: at(5),
    },
    { id: SMITHFIELD, workspace_id: WS, name: 'Smithfield Property Mgmt', updated_at: at(6) },
  ]);
  put(db, 'people', [
    {
      id: DANA,
      workspace_id: WS,
      first_name: 'Dana',
      last_name: 'Smith',
      email: 'dana.smith@gmail.com',
      phone_e164: '+15045550142',
      phone_alt: '504/555-0199',
      address_line1: '1042 Oak St',
      city: 'Metairie',
      state: 'LA',
      updated_at: at(3),
    },
    {
      id: KIM,
      workspace_id: WS,
      first_name: 'Kim',
      last_name: 'Le',
      email: 'kim@gulfcoastrealty.com',
      company_id: GULF,
      updated_at: at(4),
    },
    { id: id(3), workspace_id: WS, first_name: 'Émile', last_name: 'Dupont', updated_at: at(7) },
    { id: id(4), workspace_id: WS, first_name: 'Łukasz', last_name: 'Nowak', updated_at: at(8) },
    { id: id(5), workspace_id: WS, first_name: 'José', last_name: 'Ramirez', updated_at: at(9) },
    {
      id: id(6),
      workspace_id: WS,
      first_name: 'Tom',
      last_name: 'Becnel',
      archived_at: at(2),
      updated_at: at(2),
    },
    { id: id(7), workspace_id: WS, first_name: 'Jo', last_name: 'Smithers', updated_at: at(10) },
  ]);
  put(db, 'leads', [
    {
      id: HEATER,
      workspace_id: WS,
      title: 'Water heater install',
      status: 'open',
      value_cents: 240_000,
      person_id: DANA,
      company_id: SMITHFIELD,
      updated_at: at(2),
    },
  ]);
  put(db, 'activities', [
    {
      id: id(30),
      workspace_id: WS,
      kind: 'note',
      body: 'Gate code 4471, dog in the yard',
      person_id: DANA,
      occurred_at: at(2),
    },
    {
      id: id(31),
      workspace_id: WS,
      kind: 'note',
      body: 'Called back about price',
      person_id: DANA,
      lead_id: HEATER,
      company_id: SMITHFIELD,
      occurred_at: at(3),
    },
    // A text's copy on the timeline, and a call that's a channel's, are never notes.
    {
      id: id(32),
      workspace_id: WS,
      kind: 'sms',
      subtype: 'inbound',
      body: 'Gate is broken',
      person_id: DANA,
      occurred_at: at(1),
    },
    {
      id: id(33),
      workspace_id: WS,
      kind: 'call',
      subtype: 'missed',
      body: 'Gate call',
      person_id: DANA,
      occurred_at: at(1),
    },
    // An unsealed note on nothing in the copy (a Real Estate property's) waits for signal.
    { id: id(34), workspace_id: WS, kind: 'note', body: 'Gate lockbox 1234', occurred_at: at(1) },
    {
      id: id(35),
      workspace_id: WS,
      kind: 'visit',
      body: 'Checked the gate valve',
      person_id: KIM,
      occurred_at: at(4),
    },
  ]);
  put(db, 'tasks', [
    {
      id: id(40),
      workspace_id: WS,
      title: 'Fix the gatepost',
      notes: 'Bring the long screws',
      person_id: DANA,
      updated_at: at(1),
    },
    { id: id(41), workspace_id: WS, title: 'Photograph the gatepost', updated_at: at(1) },
  ]);
  put(db, 'appointments', [
    {
      id: id(50),
      workspace_id: WS,
      title: 'Tank swap',
      status: 'scheduled',
      starts_at: '2026-10-23T13:00:00.000Z',
      ends_at: '2026-10-23T15:00:00.000Z',
      location: JSON.stringify({ kind: 'address', address: '77 Egret Ave, Metairie' }),
      notes: 'Bring the 50 gallon tank',
    },
  ]);
  put(db, 'appointment_attendees', [
    {
      id: id(51),
      workspace_id: WS,
      appointment_id: id(50),
      person_id: id(7),
      contact_phone_e164: '+15045550177',
    },
  ]);
  put(db, 'forms', [
    { id: id(60), workspace_id: WS, name: 'Water heater survey', updated_at: at(4) },
  ]);
}

describe('the phone’s SQL reads every row searchCopy would match', () => {
  const db = new FakePowerSync();
  beforeAll(() => bayou(db));

  it.each([
    'smith',
    'dana smith',
    'Dana Smith',
    '(504) 555-0142',
    '5045550199',
    '504 555 0300',
    'dana metairie',
    'oak st metairie la',
    'gulfcoastrealty.com',
    'https://www.gulfcoastrealty.com/about',
    'www.gulfcoastrealty.com',
    'kim@gulfcoastrealty.com',
    'Émile',
    'émile',
    'ÉMILE DUPONT',
    'Łukasz',
    'łukasz nowak',
    'josé',
    'water heater',
    'smithfield',
    'dana smithfield',
    'called back about price',
    'gate',
    'gate code',
    'long screws',
    'tank',
    'egret',
    '+1 504 555 0177',
    'jo smithers',
    'heater survey',
  ])('“%s”', async (q) => {
    const every = await answer(db, q, { narrowing: EVERY_ROW });
    // Something to compare, so the case holds the SQL to something.
    expect(every.total).toBeGreaterThan(0);
    expect(said(await answer(db, q))).toEqual(said(every));
  });

  it('finds a name typed as it’s stored, outside ASCII, and a pasted web address', async () => {
    expect(titlesIn(await answer(db, 'Émile'), 'contacts')).toEqual(['Émile Dupont']);
    expect(titlesIn(await answer(db, 'łukasz'), 'contacts')).toEqual(['Łukasz Nowak']);
    const site = await answer(db, 'https://www.gulfcoastrealty.com/about');
    expect(titlesIn(site, 'companies')).toEqual(['Gulf Coast Realty']);
    expect(titlesIn(site, 'contacts')).toEqual(['Kim Le']);
    // A second number written freely ("504/555-0199"), found digit by digit.
    expect(titlesIn(await answer(db, '5045550199'), 'contacts')).toEqual(['Dana Smith']);
  });

  it('finds a note by any of who it’s on, and never a channel’s copy or a note on nothing in the copy', async () => {
    const a = await answer(db, 'gate');
    expect(titlesIn(a, 'notes')).toEqual([
      'Gate code 4471, dog in the yard',
      'Checked the gate valve',
    ]);
    expect(titlesIn(a, 'tasks')).toEqual(['Fix the gatepost']);
    const byLead = (await answer(db, 'water heater')).groups.find((g) => g.kind === 'notes');
    expect(byLead?.items.map((h) => [h.title, h.why.field])).toEqual([
      ['Called back about price', 'customer'],
    ]);
  });

  it('can’t fold accents, so “jose” may miss José offline, as the plan says', async () => {
    expect(titlesIn(await answer(db, 'jose', { narrowing: EVERY_ROW }), 'contacts')).toEqual([
      'José Ramirez',
    ]);
    expect(titlesIn(await answer(db, 'jose'), 'contacts')).toEqual([]);
  });
});

describe('under the 200 rows a kind reads', () => {
  const db = new FakePowerSync();
  beforeAll(() => {
    bayou(db);
    // More recently changed contacts on Smith St and notes on Dana Smith than one read holds.
    put(
      db,
      'people',
      Array.from({ length: COPY_ROWS + 50 }, (_, i) => ({
        id: id(1000 + i),
        workspace_id: WS,
        first_name: 'Pat',
        last_name: `Crowd ${i}`,
        address_line1: `${i + 1} Smith St`,
        updated_at: at(0),
      })),
    );
    put(db, 'people', [
      { id: id(8), workspace_id: WS, first_name: 'John', last_name: 'Smith', updated_at: at(400) },
    ]);
    put(
      db,
      'activities',
      Array.from({ length: COPY_ROWS + 10 }, (_, i) => ({
        id: id(2000 + i),
        workspace_id: WS,
        kind: 'note',
        body: `Checked in ${i}`,
        person_id: DANA,
        occurred_at: at(0),
      })),
    );
    put(db, 'activities', [
      {
        id: id(36),
        workspace_id: WS,
        kind: 'note',
        body: 'Referred by Dana',
        person_id: KIM,
        occurred_at: at(300),
      },
    ]);
  });

  it('reads a contact whose name holds the words before those found by their street', async () => {
    const names = titlesIn(await answer(db, 'smith', { kinds: ['contacts'] }), 'contacts');
    expect(names.slice(0, 3)).toEqual(['Dana Smith', 'Jo Smithers', 'John Smith']);
  });

  it('reads a note whose own words hold the words before those found by who they’re on', async () => {
    const notes = (await answer(db, 'dana', { kinds: ['notes'] })).groups[0]!;
    expect(notes.items[0]).toMatchObject({ title: 'Referred by Dana', why: { field: 'note' } });
  });
});
