/**
 * The phone's own search with no signal (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Phone: no signal"): core's
 * `searchCopy` over the rows a phone keeps. First on hand-made rows (what it finds, what it never shows, close matches,
 * the kinds that wait for signal, an add-on's group); then, as Real Estate's phone views are held to the server
 * (`realestate-phone-views.test.ts`), on Bayou Plumbing's rows read the way a phone gets them, where each kind it keeps
 * must give `search.kind`'s titles, order, tiers, reasons and links. The phone's SQL that narrows those rows is held
 * to `searchCopy` on the phone's side (`apps/mobile/src/search/__tests__/copy-sql.test.ts`).
 */
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '../../src/permissions';
import type { SearchHit } from '../../src/schemas/search';
import {
  copyHit,
  copyKindsFor,
  copyMissingKinds,
  copyWantsClose,
  lastContactsOf,
  searchCopy,
  type CopyAnchor,
  type CopyAppointment,
  type CopyCloseRow,
  type CopyCompany,
  type CopyLead,
  type CopyNote,
  type CopyPerson,
  type CopyRows,
  type CopyTask,
} from '../../src/search/copy';
import { everything, moreOfTheBoards, oneKind, searchWorld, type World } from './helpers';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER: readonly string[] = [...ROLE_PERMISSIONS.owner];
const MEMBER: readonly string[] = [...ROLE_PERMISSIONS.member];
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const person = (f: Partial<CopyPerson> & { id: string }): CopyPerson => ({
  first_name: null,
  last_name: null,
  email: null,
  phone: null,
  phone_e164: null,
  phone_alt: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  postal_code: null,
  other_emails: null,
  other_phones: null,
  other_addresses: null,
  company_name: null,
  archived_at: null,
  updated_at: at(1),
  ...f,
});
const company = (f: Partial<CopyCompany> & { id: string; name: string }): CopyCompany => ({
  email: null,
  phone: null,
  phone_e164: null,
  website: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  postal_code: null,
  other_emails: null,
  other_phones: null,
  other_addresses: null,
  archived_at: null,
  updated_at: at(1),
  ...f,
});
const NO_ANCHOR: CopyAnchor = {
  on_person_id: null,
  on_person_first: null,
  on_person_last: null,
  on_company_id: null,
  on_company_name: null,
  on_lead_id: null,
  on_lead_title: null,
};
const onDana: CopyAnchor = {
  ...NO_ANCHOR,
  on_person_id: id(1),
  on_person_first: 'Dana',
  on_person_last: 'Smith',
};

const dana = person({
  id: id(1),
  first_name: 'Dana',
  last_name: 'Smith',
  email: 'dana.smith@gmail.com',
  phone_e164: '+15045550142',
  address_line1: '1042 Oak St',
  city: 'Metairie',
  state: 'LA',
});
const marcus = person({ id: id(2), first_name: 'Marcus', last_name: 'Smith', updated_at: at(3) });
const tom = person({ id: id(3), first_name: 'Tom', last_name: 'Becnel', archived_at: at(2) });
const smithfield = company({ id: id(10), name: 'Smithfield Property Mgmt' });
const backflow: CopyLead = {
  id: id(20),
  title: 'Backflow test, 4 buildings',
  status: 'open',
  value_cents: 240_000,
  archived_at: null,
  updated_at: at(1),
  stage_name: 'Quote sent',
  pipeline_name: 'Installs',
  person_first: 'Kim',
  person_last: 'Le',
  company_name: 'Smithfield Property Mgmt',
  owner_name: null,
};
const note = (f: Partial<CopyNote> & { id: string; body: string }): CopyNote => ({
  ...NO_ANCHOR,
  kind: 'note',
  subtype: null,
  occurred_at: at(2),
  ...f,
});
const task = (f: Partial<CopyTask> & { id: string; title: string }): CopyTask => ({
  ...NO_ANCHOR,
  notes: null,
  due_at: null,
  done_at: null,
  updated_at: at(1),
  owner_name: null,
  ...f,
});
const tankSwap: CopyAppointment = {
  id: id(40),
  title: 'Tank swap',
  status: 'scheduled',
  starts_at: '2026-10-23 13:00:00Z',
  ends_at: '2026-10-23 15:00:00Z',
  location: JSON.stringify({ kind: 'address', address: '77 Egret Ave, Metairie' }),
  notes: 'Bring the 50 gallon tank',
  attendees: 'Jo Smithers +15045550177 jo@smithers.net',
  who: 'Jo Smithers',
};

const ROWS: CopyRows = {
  people: [dana, marcus, tom],
  companies: [smithfield],
  leads: [backflow],
  notes: [
    note({ id: id(30), body: 'Gate code 4471, dog in the yard', ...onDana }),
    // An unsealed note on a Real Estate property: no customer, company or lead in the copy.
    note({ id: id(31), body: 'Gatepost lockbox code 1234' }),
    // A text's copy on the timeline is never a note.
    note({ id: id(32), kind: 'sms', subtype: 'inbound', body: 'Gatepost is broken', ...onDana }),
  ],
  tasks: [
    task({ id: id(33), title: 'Fix the gatepost', notes: 'Bring the long screws', ...onDana }),
    task({ id: id(34), title: 'Photograph the gatepost' }),
  ],
  appointments: [tankSwap],
  forms: [{ id: id(50), name: 'Water heater survey', updated_at: at(4) }],
};

const search = (
  q: string,
  rows: CopyRows = ROWS,
  more: Partial<Parameters<typeof searchCopy>[2]> = {},
) =>
  searchCopy(q, rows, {
    workspaceId: WS,
    permissions: OWNER,
    timeZone: 'America/Chicago',
    ...more,
  });
const kinds = (a: ReturnType<typeof search>) => a.groups.map((g) => g.kind);
const titlesIn = (a: ReturnType<typeof search>, kind: string) =>
  a.groups.find((g) => g.kind === kind)?.items.map((h) => h.title) ?? [];

describe('searchCopy on the phone’s rows', () => {
  it('finds contacts, companies and leads by name, in kind order, with the best match, from the phone', () => {
    const a = search('smith');
    expect(a.source).toBe('phone');
    // Jo Smithers is coming to a visit, and the gate code note is on Dana Smith: found by who, after the names.
    expect(kinds(a)).toEqual(['contacts', 'companies', 'leads', 'calendar', 'notes']);
    expect(titlesIn(a, 'contacts')).toEqual(['Dana Smith', 'Marcus Smith']);
    expect(a.best).toMatchObject({ title: 'Dana Smith', tier: 1 });
    // A lead found by its company's name says so, as the server does.
    expect(a.groups[2]!.items[0]).toMatchObject({ tier: 3, why: { field: 'company' } });
    expect(a.groups[2]!.items[0]!.facts).toMatchObject({
      customer: 'Kim Le',
      pipeline: 'Installs',
      stage: 'Quote sent',
    });
    expect(a.archived).toBeNull();
    expect(a.bin).toBeNull();
  });

  it('finds a phone however it was typed as an exact match, and says why at tier 3', () => {
    const exact = search('(504) 555-0142').groups[0]!.items[0]!;
    expect(exact).toMatchObject({
      title: 'Dana Smith',
      tier: 0,
      exact: true,
      why: { field: 'phone' },
    });
    expect(exact.facts).toMatchObject({ phone: '(504) 555-0142', where: '1042 Oak St, Metairie' });
    expect(exact.href).toBe(`/app/w/${WS}/customers/people/${dana.id}`);
    const street = search('dana metairie').groups[0]!.items[0]!;
    expect(street).toMatchObject({ tier: 3, why: { field: 'address' } });
    expect(street.why.snippet?.text).toBe('1042 Oak St, Metairie, LA');
  });

  it('never shows an archived customer: a customer in the bin reads as archived on a phone', () => {
    expect(search('becnel').groups).toEqual([]);
    expect(search('tom').total).toBe(0);
  });

  it('keeps a note or a task only on a customer, company or lead in the copy, and never a text’s copy', () => {
    const a = search('gatepost');
    expect(titlesIn(a, 'tasks')).toEqual(['Fix the gatepost']);
    expect(titlesIn(a, 'notes')).toEqual([]);
    const notes = search('gate code').groups.find((g) => g.kind === 'notes')!;
    expect(notes.items).toHaveLength(1);
    expect(notes.items[0]).toMatchObject({
      title: 'Gate code 4471, dog in the yard',
      tier: 4,
      why: { field: 'note' },
      facts: { on: 'Dana Smith' },
      href: `/app/w/${WS}/customers/people/${dana.id}?activity=${id(30)}`,
    });
    // Found by who it's on, after its words (decision 34).
    const byWho = search('dana').groups.find((g) => g.kind === 'notes')!.items[0]!;
    expect(byWho.why.field).toBe('customer');
    expect(search('long screws').groups[0]!.items[0]).toMatchObject({
      kind: 'tasks',
      tier: 4,
      why: { field: 'task_notes' },
    });
  });

  it('finds a note by any of who it’s on, the customer, the company and the lead together, as the server does', () => {
    const onAll = note({
      id: id(35),
      body: 'Called back about price',
      ...onDana,
      on_company_id: smithfield.id,
      on_company_name: 'Smithfield',
      on_lead_id: backflow.id,
      on_lead_title: 'Water heater install',
    });
    for (const q of ['water heater', 'dana smithfield']) {
      const notes = search(q, { ...ROWS, notes: [onAll] }).groups.find((g) => g.kind === 'notes');
      expect(
        notes?.items.map((h) => [h.title, h.tier, h.why.field, h.facts.on]),
        q,
      ).toEqual([['Called back about price', 4, 'customer', 'Dana Smith']]);
    }
  });

  it('finds a visit by who’s coming, exactly, and opens it on the day where the business is', () => {
    const a = search('+1 504 555 0177');
    expect(a.groups[0]!.items[0]).toMatchObject({
      kind: 'calendar',
      tier: 0,
      exact: true,
      why: { field: 'phone' },
      href: `/app/w/${WS}/calendar?appt=${tankSwap.id}&date=2026-10-23`,
    });
    expect(search('egret').groups[0]!.items[0]).toMatchObject({
      tier: 3,
      why: { field: 'address' },
    });
    expect(search('gallon').groups[0]!.items[0]).toMatchObject({ tier: 4, why: { field: 'note' } });
    expect(titlesIn(search('heater survey'), 'forms')).toEqual(['Water heater survey']);
  });

  it('offers close matches only when nothing matched, the names were read, and no setting matched', () => {
    const close: CopyCloseRow[] = [
      { kind: 'contacts', id: id(1), name: 'Dana Smith', updated_at: at(1) },
      { kind: 'contacts', id: id(4), name: 'Dana Smith', updated_at: at(2) },
      { kind: 'contacts', id: id(2), name: 'Marcus Smith', updated_at: at(3) },
    ];
    const first = search('dnaa smtih');
    expect(first.total).toBe(0);
    expect(copyWantsClose(first, false)).toBe(true);
    expect(copyWantsClose(first, true)).toBe(false);
    const a = search('dnaa smtih', { ...ROWS, close });
    expect(a.close).toBe(true);
    expect(a.best).toBeNull();
    expect(a.groups[0]!.kind).toBe('close');
    expect(a.groups[0]!.items.map((h) => [h.title, h.tier, h.why.field])).toEqual([
      ['Dana Smith', 5, 'close'],
      ['Dana Smith', 5, 'close'],
      ['Marcus Smith', 5, 'close'],
    ]);
    expect(search('dnaa smtih', { ...ROWS, close }, { settingsMatched: true }).close).toBe(false);
    expect(copyWantsClose(search('smith'), false)).toBe(false);
  });

  it('searches only what the person may, and says which kinds wait for signal', () => {
    const viewer = ['workspace.read'];
    expect(copyKindsFor(viewer).map((k) => k.key)).toEqual(['calendar', 'forms']);
    expect(kinds(search('smith', ROWS, { permissions: viewer }))).toEqual(['calendar']);
    expect(copyMissingKinds(OWNER).map((k) => k.label)).toEqual([
      'Money',
      'Messages',
      'Files',
      'Knowledge',
    ]);
    // A member without Use the inbox or money isn't offered those, with signal or without.
    const member = MEMBER.filter((p) => p !== 'inbox.use' && p !== 'money.read');
    expect(copyMissingKinds(member).map((k) => k.label)).toEqual(['Files', 'Knowledge']);
    expect(kinds(search('smith', ROWS, { kinds: ['leads'] }))).toEqual(['leads']);
  });

  it('places an add-on’s group in its slot, and keeps it to the chips', () => {
    const deal: SearchHit = copyHit({
      kind: 'realestate.deals',
      id: id(60),
      title: 'Smith Ave listing',
      href: `/app/w/${WS}/a/realestate/deals/${id(60)}`,
      tier: 1,
    });
    const rows: CopyRows = {
      ...ROWS,
      addons: [{ kind: 'realestate.deals', label: 'Deals', icon: 'key', hits: [deal] }],
    };
    const a = search('smith', rows);
    // Tier 1 groups first, in kind order, where an add-on's come after core's; then the rest in kind order.
    expect(kinds(a)).toEqual([
      'contacts',
      'companies',
      'realestate.deals',
      'leads',
      'calendar',
      'notes',
    ]);
    expect(a.groups[2]).toMatchObject({ label: 'Deals', icon: 'key', total: 1 });
    expect(kinds(search('smith', rows, { kinds: ['realestate.deals'] }))).toEqual([
      'realestate.deals',
    ]);
  });

  it('is too short for one character, and for nothing but punctuation', () => {
    for (const q of ['d', '--', '@@']) {
      const a = search(q);
      expect(a.tooShort, q).toBe(true);
      expect(a.groups).toEqual([]);
    }
  });

  it('reads a contact’s last contact from their real lines, never a file added', () => {
    const lines = lastContactsOf([
      { person_id: id(1), kind: 'system', subtype: 'file_added', occurred_at: at(0) },
      { person_id: id(1), kind: 'sms', subtype: 'outbound', occurred_at: at(2) },
      { person_id: id(1), kind: 'note', subtype: null, occurred_at: at(5) },
      { person_id: id(2), kind: 'system', subtype: 'appointment_booked', occurred_at: at(1) },
    ]);
    expect(lines.get(id(1))).toMatchObject({ kind: 'sms', subtype: 'outbound' });
    expect(lines.get(id(2))).toMatchObject({ kind: 'system', subtype: 'appointment_booked' });
    const a = search('dana', { ...ROWS, facts: { lastContact: lines } });
    expect(a.groups[0]!.items[0]!.facts.lastContact).toMatchObject({ kind: 'sms' });
  });
});

/**
 * The rows a phone keeps for each kind, read as someone under row security, as text the way PowerSync stores it.
 * Every row: the phone's own SQL only narrows them, and `apps/mobile/src/search/__tests__/copy-sql.test.ts` runs it on
 * SQLite to hold it to reading every row `searchCopy` would match.
 */
async function phoneRows(w: World, u: TestUser): Promise<CopyRows> {
  return asUser(testDbs().api.db, u.claims, async (tx) => {
    const ws = w.wsId;
    const anchor = sql`p.id as on_person_id, p.first_name as on_person_first, p.last_name as on_person_last,
      c.id as on_company_id, c.name as on_company_name, l.id as on_lead_id, l.title as on_lead_title`;
    const anchorJoins = (alias: string) =>
      sql.raw(`
      left join app.people p on p.id = ${alias}.person_id and p.archived_at is null
      left join app.companies c on c.id = ${alias}.company_id and c.archived_at is null
      left join app.leads l on l.id = ${alias}.lead_id and l.archived_at is null`);
    const people = await rows<CopyPerson & Record<string, unknown>>(
      tx,
      sql`select p.id, p.first_name, p.last_name, p.email::text as email, p.phone, p.phone_e164, p.phone_alt,
            p.address_line1, p.address_line2, p.city, p.state, p.postal_code, p.other_emails::text as other_emails,
            p.other_phones::text as other_phones, p.other_addresses::text as other_addresses,
            c.name as company_name, p.archived_at::text as archived_at, p.updated_at::text as updated_at
          from app.people p left join app.companies c on c.id = p.company_id and c.archived_at is null
          where p.workspace_id = ${ws}`,
    );
    const companies = await rows<CopyCompany & Record<string, unknown>>(
      tx,
      sql`select c.id, c.name, c.email::text as email, c.phone, c.phone_e164, c.website, c.address_line1,
            c.address_line2, c.city, c.state, c.postal_code, c.other_emails::text as other_emails,
            c.other_phones::text as other_phones, c.other_addresses::text as other_addresses,
            c.archived_at::text as archived_at, c.updated_at::text as updated_at
          from app.companies c where c.workspace_id = ${ws}`,
    );
    const leads = await rows<CopyLead & Record<string, unknown>>(
      tx,
      sql`select l.id, l.title, l.status::text as status, l.value_cents, l.archived_at::text as archived_at,
            l.updated_at::text as updated_at, s.name as stage_name, pl.name as pipeline_name,
            p.first_name as person_first, p.last_name as person_last, c.name as company_name,
            coalesce(nullif(u.full_name, ''), u.email::text) as owner_name
          from app.leads l
          left join app.pipeline_stages s on s.id = l.stage_id
          left join app.pipelines pl on pl.id = l.pipeline_id
          left join app.people p on p.id = l.person_id and p.archived_at is null
          left join app.companies c on c.id = l.company_id and c.archived_at is null
          left join app.users u on u.id = l.assignee_user_id
          where l.workspace_id = ${ws}`,
    );
    const tasks = await rows<CopyTask & Record<string, unknown>>(
      tx,
      sql`select t.id, t.title, t.notes, t.due_at::text as due_at, t.done_at::text as done_at,
            t.updated_at::text as updated_at, coalesce(nullif(u.full_name, ''), u.email::text) as owner_name,
            ${anchor}
          from app.tasks t left join app.users u on u.id = t.assignee_user_id ${anchorJoins('t')}
          where t.workspace_id = ${ws}`,
    );
    const notes = await rows<CopyNote & Record<string, unknown>>(
      tx,
      sql`select a.id, a.kind::text as kind, a.subtype, a.body, a.occurred_at::text as occurred_at, ${anchor}
          from app.activities a ${anchorJoins('a')}
          where a.workspace_id = ${ws}`,
    );
    const appointments = await rows<CopyAppointment & Record<string, unknown>>(
      tx,
      sql`select a.id, a.title, a.status::text as status, a.starts_at::text as starts_at,
            a.ends_at::text as ends_at, a.location::text as location, a.notes,
            (select string_agg(concat_ws(' ', p.first_name, p.last_name, x.contact_phone_e164, x.contact_email),
                ' ')
             from app.appointment_attendees x
             left join app.people p on p.id = x.person_id and p.archived_at is null
             where x.appointment_id = a.id) as attendees,
            (select string_agg(nullif(concat_ws(' ', p.first_name, p.last_name), ''), ', ' order by x.created_at)
             from app.appointment_attendees x
             left join app.people p on p.id = x.person_id and p.archived_at is null
             where x.appointment_id = a.id) as who
          from app.appointments a where a.workspace_id = ${ws}`,
    );
    const forms = await rows<{ id: string; name: string; updated_at: string }>(
      tx,
      sql`select f.id, f.name, f.updated_at::text as updated_at from app.forms f
          where f.workspace_id = ${ws} and f.archived_at is null`,
    );
    const lines = await rows<{
      person_id: string;
      kind: string;
      subtype: string | null;
      occurred_at: string;
    }>(
      tx,
      sql`select a.person_id, a.kind::text as kind, a.subtype, a.occurred_at::text as occurred_at
          from app.activities a where a.workspace_id = ${ws} and a.person_id is not null`,
    );
    return {
      people,
      companies,
      leads,
      tasks,
      notes,
      appointments,
      forms,
      facts: { lastContact: lastContactsOf(lines) },
    };
  });
}

/** What a list says of each hit: the parts the phone must agree on. */
const said = (h: SearchHit) => [
  h.title,
  h.tier,
  h.exact,
  h.why.field,
  h.why.snippet?.text ?? null,
  h.href,
];

describe('searchCopy gives the server’s answer for what the phone keeps', () => {
  let w: World;
  let copy: CopyRows;
  beforeAll(async () => {
    w = await searchWorld('search-copy');
    await moreOfTheBoards(w);
    copy = await phoneRows(w, w.owner);
  }, 120_000);
  afterAll(closeTestDbs);

  const CASES: readonly (readonly [string, string])[] = [
    ['smith', 'contacts'],
    ['dana smith', 'contacts'],
    ['(504) 555-0142', 'contacts'],
    ['504-555-0111', 'contacts'],
    ['dana metairie', 'contacts'],
    ['gulfcoastrealty.com', 'contacts'],
    ['jose', 'contacts'],
    ['smith', 'companies'],
    ['gulfcoastrealty.com', 'companies'],
    ['smith', 'leads'],
    ['water heater', 'leads'],
    ['smithfield', 'leads'],
    ['tank', 'calendar'],
    ['metairie', 'calendar'],
    ['jo smithers', 'calendar'],
    ['water heater', 'tasks'],
    ['valves', 'tasks'],
    ['gate code', 'notes'],
    ['smithers', 'notes'],
    ['dana', 'notes'],
    ['water heater', 'forms'],
  ];

  it.each(CASES)('“%s” in %s', async (q, kind) => {
    const server = (await oneKind(w, w.owner, q, kind, { limit: 100 })).group.items.filter(
      // Form answers wait for signal; only form names are on the phone.
      (h) => kind !== 'forms' || h.why.field === 'form_name',
    );
    const phone = searchCopy(q, copy, {
      workspaceId: w.wsId,
      permissions: OWNER,
      timeZone: 'America/Chicago',
      kinds: [kind],
      perKind: 100,
    });
    const items = phone.groups.find((g) => g.kind === kind)?.items ?? [];
    expect(server.length, `${q} in ${kind}: the server found nothing to compare`).toBeGreaterThan(
      0,
    );
    expect(items.map(said)).toEqual(server.map(said));
  });

  it('finds the same close matches for a typo', async () => {
    // The names a phone reads for close matches: those that show, the latest changed first.
    const close: CopyCloseRow[] = (copy.people ?? [])
      .filter((p) => !p.archived_at)
      .map((p) => ({
        kind: 'contacts' as const,
        id: p.id,
        name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
        updated_at: p.updated_at,
      }))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const phone = searchCopy(
      'dnaa smtih',
      { ...copy, close },
      {
        workspaceId: w.wsId,
        permissions: OWNER,
        timeZone: 'America/Chicago',
        kinds: ['contacts'],
        perKind: 3,
      },
    );
    const server = await everything(w, w.owner, 'dnaa smtih', { kinds: ['contacts'] });
    expect(server.close).toBe(true);
    expect(phone.close).toBe(true);
    expect(phone.groups[0]!.items.map(said)).toEqual(server.groups[0]!.items.map(said));
  });
});
