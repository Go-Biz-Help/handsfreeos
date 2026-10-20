/**
 * Search's kinds on the local database, through `executeQuery` as different people (HANDSFREEOS_SEARCH_IMPLEMENTATION_
 * PLAN.md, "Tests by package"): the boards' searches for contacts, companies, leads, money, knowledge, a business's
 * own kinds, the Deleted bin and close matches. A phone typed four ways, a number with and without its prefix, an
 * amount, an address, a domain, a field the business invented, a typo and nothing at all; then counts, Only mine,
 * Include archived, close matches kept to the chips, and `search.kind`'s pages, sorts, standing counts and duplicates.
 * Then Search 3's: messages and calls, one row a conversation; a chat visitor and an Instagram handle; Other mail and
 * Spam; archived threads; the calendar, tasks, notes, files and form answers; notes and answers found by who they're
 * on, after their words; and the windows, Look further back carrying on where one ended.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/kernel/pagination';
import { personDelete } from '../../src/server';
import {
  admin,
  allTitles,
  everything,
  expectHfos,
  groupOf,
  moreOfTheBoards,
  oneKind,
  run,
  searchWorld,
  titles,
  type World,
} from './helpers';

let w: World;
beforeAll(async () => {
  w = await searchWorld('search-kinds');
});
afterAll(closeTestDbs);

/** One row's id from an insert. */
const one = async (query: ReturnType<typeof sql>): Promise<string> =>
  (await rows<{ id: string }>(admin(), query))[0]!.id;

describe('contacts', () => {
  it('finds a phone typed four ways as an exact match, the second Dana pointing at the first', async () => {
    for (const q of ['(504) 555-0142', '504.555.0142', '+1 504 555 0142', '5045550142']) {
      const a = await everything(w, w.owner, q);
      const contacts = groupOf(a, 'contacts')!;
      expect(titles(contacts), q).toEqual(['Dana Smith', 'Dana Smith']);
      expect(contacts.items.every((h) => h.tier === 0 && h.exact && h.why.field === 'phone')).toBe(
        true,
      );
      expect(contacts.items[1]!.duplicateOf).toEqual({
        id: contacts.items[0]!.id,
        name: 'Dana Smith',
      });
      expect(a.probes).toMatchObject({ looksLike: 'phone', phoneE164: '+15045550142' });
    }
  });

  it('finds another phone on file and an email exactly, and an email’s domain at tier 1', async () => {
    const other = groupOf(await everything(w, w.owner, '504-555-0111'), 'contacts')!;
    expect(other.items[0]).toMatchObject({ title: 'Marcus Smith', tier: 0, exact: true });
    const email = groupOf(await everything(w, w.owner, 'JO@smithers.net'), 'contacts')!;
    expect(email.items[0]).toMatchObject({
      title: 'Jo Smithers',
      tier: 0,
      why: { field: 'email' },
    });
    const domain = await everything(w, w.owner, 'https://www.gulfcoastrealty.com/about');
    expect(groupOf(domain, 'contacts')!.items[0]).toMatchObject({ title: 'Kim Le', tier: 1 });
    expect(groupOf(domain, 'companies')!.items[0]).toMatchObject({
      title: 'Gulf Coast Realty',
      tier: 1,
      why: { field: 'website' },
    });
  });

  it('finds an address, folds accents in names, and names a field the business invented', async () => {
    const street = groupOf(await everything(w, w.owner, '1042 oak'), 'contacts')!;
    expect(street.items[0]).toMatchObject({
      title: 'Dana Smith',
      tier: 3,
      why: { field: 'address' },
    });
    expect(street.items[0]!.why.snippet?.text).toContain('1042 Oak St');
    const jose = groupOf(await everything(w, w.owner, 'jose garcia'), 'contacts')!;
    expect(jose.items[0]).toMatchObject({ title: 'José García', tier: 1 });
    const field = groupOf(await everything(w, w.owner, 'gate 4471'), 'contacts')!;
    expect(field.items[0]).toMatchObject({
      title: 'José García',
      tier: 3,
      why: { field: 'field', label: 'Gate code' },
    });
  });

  it('says which field matched the words the name doesn’t hold', async () => {
    const dana = groupOf(await everything(w, w.owner, 'dana metairie'), 'contacts')!;
    expect(dana.items[0]).toMatchObject({
      title: 'Dana Smith',
      tier: 3,
      why: { field: 'address' },
    });
    expect(dana.items[0]!.why.snippet?.text).toContain('Metairie');
    const kim = groupOf(await everything(w, w.owner, 'kim smithfield'), 'contacts')!;
    expect(kim.items[0]).toMatchObject({ title: 'Kim Le', why: { field: 'company' } });
  });

  it('matches no phone from a digit or two, though nearly every number holds them', async () => {
    for (const q of ['+1', '15', '50', '04']) {
      const a = await everything(w, w.owner, q);
      expect(groupOf(a, 'contacts'), q).toBeUndefined();
      expect(groupOf(a, 'companies'), q).toBeUndefined();
    }
    // Beside a word they still count.
    expect(titles(groupOf(await everything(w, w.owner, 'oak 10'), 'contacts'))).toEqual([
      'Dana Smith',
    ]);
  });

  it('reads the last contact from real contact only: a booking yesterday, never a file added since', async () => {
    await rows(
      admin(),
      sql`insert into app.activities (workspace_id, kind, subtype, person_id, occurred_at, actor_type) values
          (${w.wsId}, 'system', 'appointment_booked', ${w.ids.jose}, now() - interval '1 day', 'human'),
          (${w.wsId}, 'system', 'file_added', ${w.ids.jose}, now(), 'human')`,
    );
    const jose = groupOf(await everything(w, w.owner, 'jose'), 'contacts')!.items[0]!;
    expect(jose.facts.lastContact).toMatchObject({ kind: 'system', subtype: 'appointment_booked' });
    // Marcus has paid a bill and been in touch no other way: his last contact is the payment, for whoever sees money.
    const marcus = groupOf(await everything(w, w.owner, 'marcus'), 'contacts')!.items[0]!;
    expect(marcus.facts.lastContact?.kind).toBe('paid');
    expect(marcus.badges).toContain('client');
  });
});

describe('companies and leads', () => {
  it('finds a company by name and counts its live people and open leads', async () => {
    const companies = groupOf(await everything(w, w.owner, 'smithfield'), 'companies')!;
    expect(companies.items[0]).toMatchObject({
      title: 'Smithfield Property Mgmt',
      tier: 1,
      facts: { people: 1, openLeads: 1 },
    });
  });

  it('finds a lead with both a person and a company by the company’s name, and keeps won ones last', async () => {
    const leads = groupOf(await everything(w, w.owner, 'smith'), 'leads')!;
    expect(titles(leads)).toEqual([
      'Water heater install',
      'Backflow test, 4 buildings',
      'Old roof repair',
    ]);
    expect(leads.items[1]!.why.field).toBe('company');
    expect(leads.items[2]!.badges).toContain('won');
    expect(leads.items[0]!.facts).toMatchObject({ customer: 'Dana Smith', stage: 'New' });
    expect(leads.items[0]!.amount).toEqual({ cents: 185_000, currency: 'USD' });
  });
});

describe('money', () => {
  it('finds a number with or without its prefix, exactly', async () => {
    const bare = groupOf(await everything(w, w.owner, '1042'), 'money')!;
    expect(
      bare.items
        .filter((h) => h.exact)
        .map((h) => h.title)
        .sort(),
    ).toEqual(['Invoice #2026-1042', 'Invoice #INV-001042']);
    for (const q of ['2026-1042', '#2026-1042']) {
      const money = groupOf(await everything(w, w.owner, q), 'money')!;
      expect(money.items[0], q).toMatchObject({
        title: 'Invoice #2026-1042',
        tier: 0,
        why: { field: 'number' },
      });
      expect(titles(money), q).not.toContain('Invoice #INV-001042');
    }
    const prefixed = groupOf(await everything(w, w.owner, 'INV-001042'), 'money')!;
    expect(titles(prefixed)).toEqual(['Invoice #INV-001042']);
    const estimate = groupOf(await everything(w, w.owner, 'LS-0042'), 'money')!;
    expect(estimate.items[0]).toMatchObject({ title: 'Estimate #LS-0042', exact: true });
  });

  it('finds a number typed the way people write one: its own title, after "invoice", or without the hyphen', async () => {
    for (const [q, title] of [
      ['Invoice #2026-1042', 'Invoice #2026-1042'],
      ['invoice 2026-1042', 'Invoice #2026-1042'],
      ['Estimate #LS-0042', 'Estimate #LS-0042'],
      ['LS0042', 'Estimate #LS-0042'],
    ] as const) {
      const money = groupOf(await everything(w, w.owner, q), 'money');
      expect(money?.items[0], q).toMatchObject({ title, tier: 0, why: { field: 'number' } });
    }
  });

  it('says a bill matched on its customer when the words are split between its title and its customer', async () => {
    const money = groupOf(await everything(w, w.owner, 'repipe marcus'), 'money')!;
    expect(money.items[0]).toMatchObject({
      title: 'Invoice #2026-1042',
      tier: 3,
      why: { field: 'customer' },
    });
  });

  it('finds an amount typed as money, an invoice and its payment alike, and never a bare number as one', async () => {
    const money = groupOf(await everything(w, w.owner, '$1,280'), 'money')!;
    expect(money.items.map((h) => [h.title, h.tier, h.why.field])).toEqual([
      ['Invoice #2026-1042', 0, 'amount'],
      ['Payment · Cash', 0, 'amount'],
    ]);
    const bare = groupOf(await everything(w, w.owner, '1280'), 'money');
    expect(bare?.items.some((h) => h.why.field === 'amount') ?? false).toBe(false);
  });

  it('finds a card payment by its last 4, ranked by its tier', async () => {
    await rows(
      admin(),
      sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, provider, status, received_at,
            card_brand, card_last4)
          values (${w.wsId}, ${w.ids.invOld}, 2500, 'card', 'stripe', 'succeeded', now(), 'Visa', '4242')`,
    );
    const money = groupOf(await everything(w, w.owner, '4242'), 'money')!;
    expect(money.items[0]).toMatchObject({
      title: 'Payment · Card',
      tier: 0,
      why: { field: 'card' },
    });
  });

  it('finds drafts by title and by customer, titled as drafts', async () => {
    const flush = groupOf(await everything(w, w.owner, 'flush'), 'money')!;
    expect(flush.items[0]).toMatchObject({
      title: 'Draft invoice · Water heater flush',
      badges: ['draft'],
    });
    const kim = groupOf(await everything(w, w.owner, 'kim le'), 'money')!;
    expect(kim.items[0]).toMatchObject({
      title: 'Draft estimate · Backflow retest',
      why: { field: 'customer' },
    });
    expect(kim.items[0]!.contact).toMatchObject({ personId: w.ids.kim });
  });
});

describe('knowledge and a business’s own kinds', () => {
  it('finds knowledge with marks from its own search', async () => {
    const k = groupOf(await everything(w, w.owner, 'sediment'), 'knowledge')!;
    expect(k.items[0]).toMatchObject({
      title: 'Water heater maintenance',
      tier: 4,
      why: { field: 'knowledge' },
    });
    const snippet = k.items[0]!.why.snippet!;
    expect(snippet.text).not.toContain('**');
    expect(snippet.marks.map(([s, e]) => snippet.text.slice(s, e).toLowerCase())).toContain(
      'sediment',
    );
  });

  it('says knowledge has more when its own search read as many as it reads', async () => {
    await rows(
      admin(),
      sql`insert into app.knowledge_items (workspace_id, kind, title, body, status)
          select ${w.wsId}, 'faq', 'Furnace question ' || n, 'Check the boiler pilot light first.', 'published'
          from generate_series(1, 25) n`,
    );
    const box = groupOf(await everything(w, w.owner, 'boiler'), 'knowledge')!;
    expect(box).toMatchObject({ total: 20, capped: true });
    expect(box.items).toHaveLength(3);
    const page = await oneKind(w, w.owner, 'boiler', 'knowledge');
    expect(page.group).toMatchObject({ total: 20, capped: true });
    expect(page.nextCursor).toBeNull();
    const few = groupOf(await everything(w, w.owner, 'sediment'), 'knowledge')!;
    expect(few).toMatchObject({ total: 1, capped: false });
  });

  it('gives each kind of record its own group, label and icon, and names the field that matched', async () => {
    const pets = groupOf(await everything(w, w.owner, 'golden retriever'), 'record.pets')!;
    expect(pets).toMatchObject({ label: 'Pets', icon: 'paw' });
    expect(pets.items[0]).toMatchObject({
      title: 'Rex Smith',
      tier: 3,
      why: { field: 'field', label: 'Breed' },
      subtitle: 'Golden retriever',
    });
    const chip = await everything(w, w.owner, 'smith', { kinds: ['record.pets'] });
    expect(chip.groups.map((g) => g.kind)).toEqual(['record.pets']);
  });
});

describe('the box', () => {
  it('orders groups best tier first and picks the best match from people, companies, leads, money or records', async () => {
    const a = await everything(w, w.owner, 'smith');
    expect(a.groups.map((g) => g.kind)).toEqual([
      'contacts',
      'companies',
      'record.pets',
      'leads',
      'money',
    ]);
    expect(a.best?.kind).toBe('contacts');
    expect(a.best?.tier).toBe(1);
    expect(a.groups.every((g) => g.items.length <= 3)).toBe(true);
  });

  it('shows close matches for "dnaa smtih": both Dana Smiths first, and nothing for "zxqv"', async () => {
    const a = await everything(w, w.owner, 'dnaa smtih');
    expect(a.close).toBe(true);
    expect(a.best).toBeNull();
    expect(titles(groupOf(a, 'close')).slice(0, 2)).toEqual(['Dana Smith', 'Dana Smith']);
    expect(groupOf(a, 'close')!.items.every((h) => h.tier === 5 && h.why.field === 'close')).toBe(
      true,
    );
    // A setting found on the device means it was spelled right: no close matches.
    const spelled = await everything(w, w.owner, 'dnaa smtih', { settingsMatched: true });
    expect(spelled.close).toBe(false);
    expect(spelled.groups).toEqual([]);
    const none = await everything(w, w.owner, 'zxqv');
    expect(none).toMatchObject({ groups: [], close: false, noneActive: false, total: 0 });
  });

  it('keeps close matches to the kinds picked', async () => {
    const contacts = await everything(w, w.owner, 'dnaa smtih', { kinds: ['contacts'] });
    expect(contacts.close).toBe(true);
    expect(groupOf(contacts, 'close')!.items.every((h) => h.kind === 'contacts')).toBe(true);
    const pets = await everything(w, w.owner, 'dnaa smtih', { kinds: ['record.pets'] });
    expect(titles(groupOf(pets, 'close'))).toEqual(['Rex Smith']);
    expect(groupOf(pets, 'close')!.items[0]!.kind).toBe('record.pets');
    const money = await everything(w, w.owner, 'dnaa smtih', { kinds: ['money'] });
    expect(money).toMatchObject({ close: false, groups: [] });
  });

  it('pages close matches on their own page, over every kind and in their own order, and answers their chip', async () => {
    const a = await everything(w, w.owner, 'dnaa smtih');
    const page = await oneKind(w, w.owner, 'dnaa smtih', 'close');
    expect(page.group).toMatchObject({ kind: 'close', total: groupOf(a, 'close')!.total });
    expect(titles(page.group).slice(0, 2)).toEqual(['Dana Smith', 'Dana Smith']);
    expect(titles(page.group)).toEqual(expect.arrayContaining(['Marcus Smith', 'Rex Smith']));
    expect(page.group.items.every((h) => h.tier === 5 && h.why.field === 'close')).toBe(true);
    // Show more reads on from where a page ended.
    const first = await oneKind(w, w.owner, 'dnaa smtih', 'close', { limit: 1 });
    const second = await oneKind(w, w.owner, 'dnaa smtih', 'close', {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.group.items[0]!.id).toBe(page.group.items[1]!.id);
    // The box's Close matches chip asks for them alone.
    const chip = await everything(w, w.owner, 'dnaa smtih', { kinds: ['close'] });
    expect(chip.close).toBe(true);
    expect(titles(groupOf(chip, 'close')).slice(0, 2)).toEqual(['Dana Smith', 'Dana Smith']);
  });

  it('counts to 100 and says there are more', async () => {
    await rows(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name)
          select ${w.wsId}, 'Zed', 'Capper ' || n from generate_series(1, 105) n`,
    );
    const a = await everything(w, w.owner, 'capper');
    expect(groupOf(a, 'contacts')).toMatchObject({ total: 100, capped: true });
    expect(a.capped).toBe(true);
    const page = await oneKind(w, w.owner, 'capper', 'contacts');
    expect(page.group.total).toBe(105);
    expect(page.group.items).toHaveLength(50);
  });

  it('keeps archived records under Archived, by name only, or in their kind with Include archived', async () => {
    const a = await everything(w, w.owner, 'becnel');
    expect(a.groups).toEqual([]);
    expect(titles(a.archived)).toEqual(['Tom Becnel']);
    expect(a.archived!.items[0]!.badges).toContain('archived');
    expect(a.noneActive).toBe(true);
    const included = await everything(w, w.owner, 'becnel', { includeArchived: true });
    expect(titles(groupOf(included, 'contacts'))).toEqual(['Tom Becnel']);
    expect(included.archived).toBeNull();
    const page = await oneKind(w, w.owner, 'becnel', 'archived');
    expect(titles(page.group)).toEqual(['Tom Becnel']);
    expect(titles((await oneKind(w, w.owner, 'becnel', 'contacts')).group)).toEqual([]);
  });

  it('keeps to the person’s own with Only mine', async () => {
    const mine = await everything(w, w.member, 'smith', { onlyMine: true });
    expect(titles(groupOf(mine, 'contacts'))).toEqual(['Dana Smith']);
    expect(titles(groupOf(mine, 'leads'))).toEqual(['Water heater install']);
    expect(groupOf(mine, 'companies')).toBeUndefined();
    const knowledge = await everything(w, w.member, 'sediment', { onlyMine: true });
    expect(groupOf(knowledge, 'knowledge')).toBeUndefined();
  });
});

describe('one kind at a time', () => {
  it('pages by best match with an offset cursor, by most recent and by name, and refuses a tampered cursor', async () => {
    const first = await oneKind(w, w.owner, 'smith', 'contacts', { limit: 2 });
    expect(first.group.items).toHaveLength(2);
    expect(first.nextCursor).toBe(encodeCursor({ sort: 'best', id: '2' }));
    const second = await oneKind(w, w.owner, 'smith', 'contacts', {
      limit: 2,
      cursor: first.nextCursor!,
    });
    const ids = new Set([...first.group.items, ...second.group.items].map((h) => h.id));
    expect(ids.size).toBe(4);
    const far = await oneKind(w, w.owner, 'smith', 'contacts', {
      cursor: encodeCursor({ sort: 'best', id: '50' }),
    });
    expect(far.group.items).toEqual([]);
    expect(far.nextCursor).toBeNull();

    for (const sort of ['recent', 'name'] as const) {
      const all = await oneKind(w, w.owner, 'smith', 'contacts', { sort });
      const walked: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await oneKind(w, w.owner, 'smith', 'contacts', { sort, limit: 2, cursor });
        walked.push(...page.group.items.map((h) => h.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(walked, sort).toEqual(all.group.items.map((h) => h.id));
    }
    expect(
      titles((await oneKind(w, w.owner, 'smith', 'contacts', { sort: 'name' })).group)[0],
    ).toBe('Dana Smith');

    await expectHfos(
      () => oneKind(w, w.owner, 'smith', 'contacts', { cursor: 'not-a-cursor' }),
      'validation',
      400,
    );
    await expectHfos(
      () =>
        oneKind(w, w.owner, 'smith', 'contacts', {
          cursor: encodeCursor({ sort: 'best', id: '9999' }),
        }),
      'validation',
    );
    await expectHfos(
      () =>
        oneKind(w, w.owner, 'smith', 'contacts', {
          sort: 'recent',
          cursor: encodeCursor({ sort: 'x', id: 'y' }),
        }),
      'validation',
    );
  });

  it('sorts Most recent contact over everyone found, not over the 500 best', async () => {
    await rows(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, updated_at)
          select ${w.wsId}, 'Yolo', 'Recentcase ' || n, now() - make_interval(mins => n)
          from generate_series(1, 521) n`,
    );
    const [old] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, updated_at)
          values (${w.wsId}, 'Yolo', 'Recentcase Oldone', now() - interval '2 years') returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.activities (workspace_id, kind, person_id, occurred_at, actor_type)
          values (${w.wsId}, 'sms', ${old!.id}, now(), 'human')`,
    );
    const page = await oneKind(w, w.owner, 'recentcase', 'contacts', { sort: 'recent' });
    expect(page.group).toMatchObject({ total: 500, capped: true });
    expect(page.group.items[0]).toMatchObject({ id: old!.id, title: 'Yolo Recentcase Oldone' });
    expect(titles(page.group).slice(1, 3)).toEqual(['Yolo Recentcase 1', 'Yolo Recentcase 2']);
  });

  it('counts leads and clients, filters to either, and finds two contacts on one number', async () => {
    // Marcus won a lead and paid; Jo paid by card above. Everyone else is still a lead.
    const page = await oneKind(w, w.owner, 'smith', 'contacts');
    expect(page.standingCounts).toEqual({ leads: 3, clients: 2 });
    const clients = await oneKind(w, w.owner, 'smith', 'contacts', { standing: 'client' });
    expect(titles(clients.group).sort()).toEqual(['Jo Smithers', 'Marcus Smith']);
    expect(page.duplicates).toEqual([
      expect.objectContaining({ on: 'phone', value: '(504) 555-0142', name: 'Dana Smith' }),
    ]);
    expect(new Set(page.duplicates[0]!.ids)).toEqual(new Set([w.ids.dana, w.ids.dana2]));
  });

  it('refuses a kind that isn’t there, and one of the business’s kinds that’s gone', async () => {
    await expectHfos(() => oneKind(w, w.owner, 'smith', 'nonsense'), 'search_kind_gone', 404);
    await expectHfos(
      () => oneKind(w, w.owner, 'smith', 'record.nothing_here'),
      'search_kind_gone',
      404,
    );
    const pets = await oneKind(w, w.owner, 'smith', 'record.pets');
    expect(pets.group).toMatchObject({ kind: 'record.pets', label: 'Pets', icon: 'paw' });
    expect(titles(pets.group)).toEqual(['Rex Smith']);
  });

  it('leaves a customer in the bin out of standing counts and duplicates', async () => {
    await run(personDelete, { workspaceId: w.wsId, personIds: [w.ids.dana2] }, w.owner);
    const page = await oneKind(w, w.owner, 'smith', 'contacts');
    expect(page.standingCounts).toEqual({ leads: 2, clients: 2 });
    expect(page.duplicates).toEqual([]);
  });
});

describe('the remaining kinds (Search 3)', () => {
  let m: Record<string, string>;
  beforeAll(async () => {
    m = await moreOfTheBoards(w);
  });

  it('finds words in a message as one row for its conversation, its best message opening the thread there', async () => {
    const messages = groupOf(await everything(w, w.owner, 'leaking'), 'messages')!;
    expect(messages.items[0]).toMatchObject({
      id: m.danaTexts,
      title: 'Text from Dana Smith',
      tier: 4,
      why: { field: 'message' },
    });
    expect(messages.items[0]!.href).toContain(`/inbox/${m.danaTexts}?message=${m.leak}&at=`);
    const snippet = messages.items[0]!.why.snippet!;
    expect(snippet.marks.map(([a, b]) => snippet.text.slice(a, b))).toEqual(['leaking']);
    // A message and a call in the same thread are one row, counting both.
    const heater = groupOf(await everything(w, w.owner, 'water heater'), 'messages')!;
    const dana = heater.items.find((h) => h.id === m.danaTexts)!;
    expect(dana.facts.matches).toBe(2);
    expect(heater.items.filter((h) => h.id === m.danaTexts)).toHaveLength(1);
  });

  it('finds a thread exactly by its number, and by a chat visitor’s name or an Instagram handle', async () => {
    const phone = groupOf(await everything(w, w.owner, '(504) 555-0142'), 'messages')!;
    expect(phone.items[0]).toMatchObject({
      id: m.danaTexts,
      title: 'Texts with Dana Smith',
      tier: 0,
      exact: true,
      why: { field: 'phone' },
    });
    const page = await oneKind(w, w.owner, '(504) 555-0142', 'messages');
    expect(page.group.items[0]!.facts.messages).toBe(2);
    const chat = groupOf(await everything(w, w.owner, 'beatrice'), 'messages')!;
    expect(chat.items[0]).toMatchObject({ id: m.chat, title: 'Chat with Beatrice Fontaine' });
    const insta = groupOf(await everything(w, w.owner, 'nolaplumbfan'), 'messages')!;
    expect(insta.items[0]).toMatchObject({ id: m.insta, title: 'Instagram with Theo Lavergne' });
  });

  it('badges Other mail, keeps Spam and its calls to the Spam kind, and finds a voicemail with no thread', async () => {
    const kim = groupOf(await everything(w, w.owner, 'backflow certificate'), 'messages')!;
    expect(kim.items[0]).toMatchObject({ id: m.kimMail, title: 'Email · Kim Le' });
    expect(kim.items[0]!.badges).toContain('other_mail');
    for (const q of ['tankless heaters', 'robocall']) {
      expect(groupOf(await everything(w, w.owner, q), 'messages'), q).toBeUndefined();
      const spam = groupOf(await everything(w, w.owner, q, { kinds: ['spam'] }), 'spam')!;
      expect(spam.items[0], q).toMatchObject({ id: m.spam, badges: ['spam'] });
    }
    expect(titles((await oneKind(w, w.owner, 'robocall', 'spam')).group)).toHaveLength(1);
    const voicemail = groupOf(await everything(w, w.owner, 'repipe estimate'), 'messages')!;
    expect(voicemail.items[0]).toMatchObject({
      id: m.voicemail,
      title: 'Call · Marcus Smith',
      why: { field: 'voicemail' },
      href: `/app/w/${w.wsId}/customers/people/${w.ids.marcus}`,
    });
    expect(voicemail.items[0]!.badges).toContain('voicemail');
  });

  it('keeps an archived thread under Archived by who it’s with, and its words and calls to Include archived', async () => {
    for (const q of ['shelvedword', 'shelvedcall']) {
      const a = await everything(w, w.owner, q);
      expect(allTitles(a), q).toEqual([]);
      const included = groupOf(
        await everything(w, w.owner, q, { includeArchived: true }),
        'messages',
      )!;
      expect(included.items[0], q).toMatchObject({ id: m.archivedThread });
      expect(included.items[0]!.badges, q).toContain('archived');
    }
    const byName = await everything(w, w.owner, 'garcia');
    expect(byName.archived!.items.map((h) => [h.kind, h.title])).toEqual([
      ['messages', 'Texts with José García'],
    ]);
    const archivedPage = await oneKind(w, w.owner, 'garcia', 'archived');
    expect(titles(archivedPage.group)).toContain('Texts with José García');
  });

  it('keeps calls and messages to the person’s own threads with Only mine', async () => {
    const mine = groupOf(
      await everything(w, w.member, 'pilot light', { onlyMine: true }),
      'messages',
    );
    expect(mine?.items[0]?.id).toBe(m.danaTexts);
    expect(
      groupOf(await everything(w, w.marco, 'pilot light', { onlyMine: true }), 'messages'),
    ).toBeUndefined();
  });

  it('finds the calendar by who’s coming, exactly or by name, by the place and by the notes, cancelled ones last', async () => {
    const exact = groupOf(await everything(w, w.owner, '(504) 555-0177'), 'calendar')!;
    expect(exact.items[0]).toMatchObject({ id: m.tankSwap, tier: 0, exact: true });
    const place = groupOf(await everything(w, w.owner, '77 egret'), 'calendar')!;
    expect(place.items[0]).toMatchObject({
      title: 'Tank swap',
      tier: 3,
      why: { field: 'address' },
    });
    expect(place.items[0]!.href).toMatch(
      new RegExp(`/calendar\\?appt=${m.tankSwap}&date=\\d{4}-\\d{2}-\\d{2}$`),
    );
    const who = groupOf(await everything(w, w.owner, 'jo smithers'), 'calendar')!;
    expect(who.items[0]).toMatchObject({ title: 'Tank swap', why: { field: 'customer' } });
    expect(who.items[0]!.facts.who).toBe('Jo Smithers');
    const notes = groupOf(await everything(w, w.owner, '50 gallon tank'), 'calendar')!;
    expect(notes.items[0]).toMatchObject({ title: 'Tank swap', tier: 4, why: { field: 'note' } });
    const drain = groupOf(await everything(w, w.owner, 'drain'), 'calendar')!;
    expect(drain.items[0]).toMatchObject({ id: m.drain, badges: ['cancelled'] });
  });

  it('finds tasks by title and by their notes, done ones marked, opening over the Tasks page', async () => {
    const task = groupOf(await everything(w, w.owner, 'water heater'), 'tasks')!;
    expect(task.items[0]).toMatchObject({
      id: m.callBack,
      tier: 1,
      href: `/app/w/${w.wsId}/tasks?task=${m.callBack}`,
      facts: { owner: 'Mike Member', on: 'Dana Smith' },
    });
    const notes = groupOf(await everything(w, w.owner, 'four valves'), 'tasks')!;
    expect(notes.items[0]).toMatchObject({
      id: m.parts,
      tier: 4,
      why: { field: 'task_notes' },
      badges: ['done'],
    });
  });

  it('finds a note by its words, then notes found by who they’re on, after them', async () => {
    const gate = groupOf(await everything(w, w.owner, 'gate code'), 'notes')!;
    expect(gate.items[0]).toMatchObject({
      id: m.gateNote,
      title: 'Gate code 4471, dog in the yard',
      tier: 4,
      why: { field: 'note' },
      facts: { on: 'Dana Smith' },
      href: `/app/w/${w.wsId}/customers/people/${w.ids.dana}?activity=${m.gateNote}`,
    });
    const smithers = groupOf(await everything(w, w.owner, 'smithers', { perKind: 5 }), 'notes')!;
    expect(smithers.items.map((h) => [h.id, h.why.field])).toEqual([
      [m.referred, 'note'],
      [m.loggedCall, 'customer'],
      [m.summary, 'customer'],
    ]);
  });

  it('finds files by name, saying what they’re on, never port papers or knowledge files', async () => {
    const files = groupOf(await everything(w, w.owner, 'backflow'), 'files')!;
    expect(files.items.map((h) => h.id)).toEqual([m.report]);
    expect(files.items[0]).toMatchObject({
      title: 'Backflow report.pdf',
      why: { field: 'file_name' },
      facts: { on: 'Kim Le' },
      href: `/app/w/${w.wsId}/customers/people/${w.ids.kim}?tab=files&file=${m.report}`,
    });
  });

  it('finds a form by name, and answers by their words, then by who answered, one row a response', async () => {
    const form = groupOf(await everything(w, w.owner, 'heater survey'), 'forms')!;
    expect(form.items[0]).toMatchObject({
      id: m.form,
      tier: 1,
      why: { field: 'form_name' },
      href: `/app/w/${w.wsId}/forms/${m.form}`,
    });
    const answer = groupOf(await everything(w, w.owner, '50 gallon'), 'forms')!;
    expect(answer.items[0]).toMatchObject({
      id: m.joAnswers,
      title: 'Water heater survey',
      tier: 4,
      why: { field: 'answer' },
      facts: { answeredBy: 'Jo Smithers', question: 'What tank do you have?' },
      href: `/app/w/${w.wsId}/forms/${m.form}/answers/${m.joAnswers}`,
    });
    const anonymous = groupOf(await everything(w, w.owner, 'tankless'), 'forms')!;
    expect(anonymous.items[0]).toMatchObject({
      id: m.anonymous,
      badges: ['anonymous'],
      facts: { answeredBy: null },
    });
    // A choice is kept in its labels and in text_value alike: its words show once.
    expect(anonymous.items[0]!.why.snippet!.text).toBe('Tankless');
    // Smithers is in a note's words, and answered the survey: words first, then who answered, with the answer to
    // the form's first question, though its id sorts last.
    const byWho = groupOf(await everything(w, w.owner, 'smithers'), 'forms')!;
    expect(byWho.items[0]).toMatchObject({ id: m.joAnswers, why: { field: 'customer' } });
    expect(byWho.items[0]!.why.snippet!.text).toBe('50 gallon, gas');
    expect(byWho.items.filter((h) => h.id === m.joAnswers)).toHaveLength(1);
    // A response still being filled in isn't found.
    expect(groupOf(await everything(w, w.owner, 'halfwayword'), 'forms')).toBeUndefined();
  });

  it('folds accents in the name a note, a visit or an answer is found by', async () => {
    const note = await one(
      sql`insert into app.activities (workspace_id, kind, body, person_id, occurred_at, actor_type)
          values (${w.wsId}, 'note', 'Prefers mornings', ${w.ids.jose}, now() - interval '1 day', 'human')
          returning id`,
    );
    const visit = await one(
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at)
          values (${w.wsId}, ${m.calendar}, 1, 'Gutter install', now() + interval '2 days',
            now() + interval '2 days 1 hour')
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, status)
          values (${w.wsId}, ${visit}, ${w.ids.jose}, 'booked')`,
    );
    const answers = await one(
      sql`insert into app.form_responses (workspace_id, form_id, version_id, status, person_id, completed_at)
          select ${w.wsId}, ${m.form}, v.id, 'completed', ${w.ids.jose}, now()
          from app.form_versions v where v.form_id = ${m.form}
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title,
            question_type, text_value)
          values (${w.wsId}, ${answers}, ${m.form}, 'q_else0005', 'Anything else?', 'long_text', 'Ring twice')`,
    );
    for (const q of ['jose garcia', 'josé garcía']) {
      const a = await everything(w, w.owner, q);
      expect(
        groupOf(a, 'notes')?.items.find((h) => h.id === note),
        q,
      ).toMatchObject({
        why: { field: 'customer' },
      });
      expect(
        groupOf(a, 'calendar')?.items.find((h) => h.id === visit),
        q,
      ).toMatchObject({
        why: { field: 'customer' },
      });
      expect(
        groupOf(a, 'forms')?.items.find((h) => h.id === answers),
        q,
      ).toMatchObject({
        why: { field: 'customer' },
        facts: { answeredBy: 'José García' },
      });
    }
  });

  it('leaves who answered off a response whose customer was merged away, and doesn’t call it anonymous', async () => {
    const shell = await one(
      sql`insert into app.people (workspace_id, first_name, last_name) values (${w.wsId}, 'Nell', 'Shell')
          returning id`,
    );
    const answers = await one(
      sql`insert into app.form_responses (workspace_id, form_id, version_id, status, person_id, completed_at)
          select ${w.wsId}, ${m.form}, v.id, 'completed', ${shell}, now()
          from app.form_versions v where v.form_id = ${m.form}
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title,
            question_type, text_value)
          values (${w.wsId}, ${answers}, ${m.form}, 'q_else0005', 'Anything else?', 'long_text', 'Numbatword here')`,
    );
    await rows(
      admin(),
      sql`update app.people set merged_into_id = ${w.ids.dana}, merged_at = now() where id = ${shell}`,
    );
    const found = groupOf(await everything(w, w.owner, 'numbatword'), 'forms')!;
    expect(found.items[0]).toMatchObject({
      id: answers,
      contact: null,
      badges: [],
      facts: { answeredBy: null },
    });
  });

  it('never matches a thread by the letters or digits of our own keys for it', async () => {
    const portal = await one(
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, last_message_at)
          values (${w.wsId}, 'portal', 'portal:5f1e0420-7c3b-4a9d-8e21-0b6c1042aa77', ${w.ids.dana}, now())
          returning id`,
    );
    for (const q of ['1042', 'portal', 'chat', '0420']) {
      const ids = (groupOf(await everything(w, w.owner, q), 'messages')?.items ?? []).map(
        (h) => h.id,
      );
      expect(ids, q).not.toContain(portal);
      expect(ids, q).not.toContain(m.chat);
    }
    // A text's number still is: "0142" is in Dana's.
    const digits = groupOf(await everything(w, w.owner, '0142'), 'messages')!;
    expect(digits.items.find((h) => h.id === m.danaTexts)).toMatchObject({
      tier: 3,
      why: { field: 'phone' },
    });
  });

  it('reads notes whose words match before notes found by who they’re on, and caps a window’s count at 100', async () => {
    const zephyr = await one(
      sql`insert into app.people (workspace_id, first_name, last_name) values (${w.wsId}, 'Zephyr', 'Quayle')
          returning id`,
    );
    const quote = await one(
      sql`insert into app.activities (workspace_id, kind, body, person_id, occurred_at, actor_type)
          values (${w.wsId}, 'note', 'Zephyr asked for a quote', ${zephyr}, now() - interval '10 days', 'human')
          returning id`,
    );
    // Calls logged with no words, every one newer than the note: more than the box reads.
    await rows(
      admin(),
      sql`insert into app.activities (workspace_id, kind, body, person_id, occurred_at, actor_type)
          select ${w.wsId}, 'call', null, ${zephyr}, now() - make_interval(mins => n), 'human'
          from generate_series(1, 105) n`,
    );
    const notes = groupOf(await everything(w, w.owner, 'zephyr'), 'notes')!;
    expect(notes.items[0]).toMatchObject({ id: quote, why: { field: 'note' } });
    expect(notes).toMatchObject({ total: 100, capped: true });
  });

  it('keeps each kind to the person’s own with Only mine', async () => {
    const me = w.member.id;
    const dale = w.owner.id;
    const visit = (title: string) =>
      one(sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
                owner_user_id)
              values (${w.wsId}, ${m.calendar}, 1, ${title}, now() + interval '3 days',
                now() + interval '3 days 1 hour', ${dale})
              returning id`);
    const staffed = await visit('Minecalword staffed');
    await visit('Minecalword not mine');
    await rows(
      admin(),
      sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
          values (${w.wsId}, ${staffed}, ${me})`,
    );
    const task = (title: string, createdBy: string, assignee: string | null) =>
      one(sql`insert into app.tasks (workspace_id, title, assignee_user_id, created_by)
              values (${w.wsId}, ${title}, ${assignee}, ${createdBy}) returning id`);
    const made = await task('Minetaskword made unassigned', me, null);
    const given = await task('Minetaskword given to me', dale, me);
    await task('Minetaskword made for Priya', me, w.priya.id);
    await task('Minetaskword Dale’s unassigned', dale, null);
    const note = (body: string, author: string) =>
      one(sql`insert into app.activities (workspace_id, kind, body, person_id, occurred_at, actor_type,
                author_user_id)
              values (${w.wsId}, 'note', ${body}, ${w.ids.dana}, now() - interval '1 hour', 'human', ${author})
              returning id`);
    const myNote = await note('Minenoteword mine', me);
    await note('Minenoteword Dale’s', dale);
    const file = (name: string, createdBy: string) =>
      one(sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, status, created_by)
              values (${w.wsId}, 'person', ${w.ids.dana}, ${`${w.wsId}/${randomUUID()}`}, ${name}, 'ready',
                ${createdBy})
              returning id`);
    const myFile = await file('Minefileword mine.pdf', me);
    await file('Minefileword Dale’s.pdf', dale);
    const form = (name: string, createdBy: string) =>
      one(sql`insert into app.forms (workspace_id, name, slug, created_by)
              values (${w.wsId}, ${name}, ${`mine-${randomUUID().slice(0, 8)}`}, ${createdBy})
              returning id`);
    const myForm = await form('Mineformword intake', me);
    await form('Mineformword checklist', dale);
    await rows(
      admin(),
      sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title,
            question_type, text_value)
          values (${w.wsId}, ${m.joAnswers}, ${m.form}, 'q_extra001', 'Where did you hear of us?', 'short_text',
            'Mineformword flyer')`,
    );

    const ids = async (q: string, kind: string, onlyMine: boolean) =>
      (groupOf(await everything(w, w.member, q, { onlyMine, perKind: 5 }), kind)?.items ?? [])
        .map((h) => h.id)
        .sort();
    expect(await ids('minecalword', 'calendar', true)).toEqual([staffed]);
    expect(await ids('minecalword', 'calendar', false)).toHaveLength(2);
    expect(await ids('minetaskword', 'tasks', true)).toEqual([made, given].sort());
    expect(await ids('minetaskword', 'tasks', false)).toHaveLength(4);
    expect(await ids('minenoteword', 'notes', true)).toEqual([myNote]);
    expect(await ids('minenoteword', 'notes', false)).toHaveLength(2);
    expect(await ids('minefileword', 'files', true)).toEqual([myFile]);
    expect(await ids('minefileword', 'files', false)).toHaveLength(2);
    // Nobody owns an answer, so Only mine leaves them out.
    expect(await ids('mineformword', 'forms', true)).toEqual([myForm]);
    expect(await ids('mineformword', 'forms', false)).toHaveLength(3);
  });

  it('orders a search’s groups by the rule of decision 33 across every kind', async () => {
    const a = await everything(w, w.owner, 'water heater');
    // Tier 1 (a lead's, a task's, a form's and a knowledge item's title) in kind order, then tier 2 (a bill's title),
    // then the rest (the messages) in kind order.
    expect(a.groups.map((g) => [g.kind, Math.min(...g.items.map((h) => h.tier))])).toEqual([
      ['leads', 1],
      ['tasks', 1],
      ['forms', 1],
      ['knowledge', 1],
      ['money', 2],
      ['messages', 4],
    ]);
  });

  it('says how far back a window looked, and Look further back carries on from there', async () => {
    const [bulk] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart, last_message_at)
          values (${w.wsId}, 'sms', '+15045559999', now() - interval '300 days') returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
          select ${w.wsId}, ${bulk!.id}, 'sms', 'inbound', 'received',
            case when n = 25001 then 'Oldestword in the pile' else 'Bulk ' || n end,
            now() - interval '300 days' - make_interval(mins => n)
          from generate_series(1, 25001) n`,
    );
    // The box's window is the newest 4,000 or 180 days: it says it didn't look that far.
    const box = groupOf(await everything(w, w.owner, 'leaking'), 'messages')!;
    expect(box).toMatchObject({ complete: false });
    expect(Date.parse(box.searchedBack!)).toBeGreaterThan(Date.now() - 181 * 86_400_000);
    // A kind's page reads 25,000 messages: the oldest is just past them.
    const first = await oneKind(w, w.owner, 'oldestword', 'messages');
    expect(first.group).toMatchObject({ complete: false, items: [] });
    expect(first.group.searchedBack).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const further = await oneKind(w, w.owner, 'oldestword', 'messages', {
      before: first.group.searchedBack!,
    });
    expect(further.group).toMatchObject({ complete: true, searchedBack: null });
    expect(further.group.items[0]).toMatchObject({ id: bulk!.id, why: { field: 'message' } });
  });

  // Last, since a thread older than every window leaves every later window incomplete.
  it('says how far back the Archived page looked through threads, and Look further back finds an older one', async () => {
    const ottoline = await one(
      sql`insert into app.people (workspace_id, first_name, last_name) values (${w.wsId}, 'Ottoline', 'Farquhar')
          returning id`,
    );
    const old = await one(
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, last_message_at, archived_at)
          values (${w.wsId}, 'sms', '+15045557788', ${ottoline}, now() - interval '4 years', now())
          returning id`,
    );
    const first = await oneKind(w, w.owner, 'farquhar', 'archived');
    expect(first.group).toMatchObject({ complete: false, items: [] });
    expect(first.group.searchedBack).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const further = await oneKind(w, w.owner, 'farquhar', 'archived', {
      before: first.group.searchedBack!,
    });
    expect(further.group.items.map((h) => h.id)).toEqual([old]);
  });
});
