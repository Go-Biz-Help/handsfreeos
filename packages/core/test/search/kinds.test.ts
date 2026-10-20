/**
 * Search's kinds on the local database, through `executeQuery` as different people (HANDSFREEOS_SEARCH_IMPLEMENTATION_
 * PLAN.md, "Tests by package"): the boards' searches for contacts, companies, leads, money, knowledge, a business's
 * own kinds, the Deleted bin and close matches. A phone typed four ways, a number with and without its prefix, an
 * amount, an address, a domain, a field the business invented, a typo and nothing at all; then counts, Only mine,
 * Include archived, close matches kept to the chips, and `search.kind`'s pages, sorts, standing counts and duplicates.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/kernel/pagination';
import { personDelete } from '../../src/server';
import {
  admin,
  everything,
  expectHfos,
  groupOf,
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
