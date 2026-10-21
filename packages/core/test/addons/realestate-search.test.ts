/**
 * Real Estate answers Search everything (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, Search 4b), on the database, as
 * the people of a real estate business, through the real `search.everything` and `search.kind`:
 *
 *   - an MLS number finds its listing first, exactly, with its stage, list price and rooms;
 *   - a deal is found by its name, its client and its home's address, and a listing's own deal shows once, as that
 *     listing, however it matched; a record of the deal kind without its deal opens its record's page; a buyer's home
 *     by its address, opening the deal's Homes with it;
 *   - a property with no listing is found under Properties, and one with a listing once, as its Listing; a deal or a
 *     property found by one of its fields says which;
 *   - a private deal, its listing and its homes are found by its team and by nobody off it;
 *   - archived deals only with Include archived; Only mine keeps to the person's own deals;
 *   - `covers` takes core's group of deals and properties out only when Real Estate answered: someone without "Work
 *     on deals" still finds them there;
 *   - a kind's own page leaves to a listing what the whole answer does, carries on with its cursor, starts again on
 *     one it can't read, and is refused while the add-on is off; the query is never a route.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  addonSearchIssues,
  customRecordArchive,
  executeCommand,
  permissionSetMember,
  personCreate,
  type CommandDef,
  type HumanActor,
} from '../../src/server';
import { admin, everything, expectHfos, groupOf, oneKind, titles } from '../search/helpers';
import { realestateBusiness } from './realestate-fixture';

const api = () => testDbs().api.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const cmd = (name: string) => {
  const c = realestateAddonServer.commands!.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name}`);
  return c as CommandDef;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const run = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(api(), cmd(name), { workspaceId: t.wsId, ...input }, human(who), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output);
const one = async (query: ReturnType<typeof sql>): Promise<string> => {
  const [r] = await rows<{ id: string }>(admin(), query);
  return r!.id;
};

let owner: TestUser;
let agent: TestUser;
let other: TestUser;
let nouse: TestUser;
const t = { wsId: '' };
/**
 * Becnel's listing at 418 Smith Ave and its property; Ray Moreno's listing on Moreno Ct, named the web's way; Lakefront's
 * purchase (its client Dana Moreno, a home on Pelican Way); a property with no deal on Bayou Lane, in Jefferson parish;
 * Oak Street's sale, archived.
 */
let listing: string;
let listingHome: string;
let purchase: string;
let pelican: string;
let bayou: string;
let oak: string;

beforeAll(async () => {
  [owner, agent, other, nouse] = await Promise.all([
    createTestUser('res-owner'),
    createTestUser('res-agent'),
    createTestUser('res-other'),
    createTestUser('res-nouse'),
  ]);
  t.wsId = await realestateBusiness(owner, 'Crescent City Realty');
  await admin()
    .insert(workspaceMemberships)
    .values(
      [agent, other, nouse].map((u) => ({
        workspaceId: t.wsId,
        userId: u.id,
        role: 'member' as const,
      })),
    );
  const person = async (firstName: string, lastName: string): Promise<string> =>
    (
      await executeCommand(
        api(),
        personCreate,
        { workspaceId: t.wsId, firstName, lastName },
        human(agent),
        { correlationId: randomUUID(), channel: 'test' },
      )
    ).output.personId;
  const dana = await person('Dana', 'Moreno');

  // A listing, live on the MLS at Active, with its list price and its rooms. Deals are private to their people.
  const opened = await run(agent, 'realestate.deal.open', {
    side: 'listing',
    name: 'Becnel listing',
    newPropertyAddress: '418 Smith Ave, Metairie, LA',
  });
  listing = opened.dealId;
  listingHome = opened.propertyId;
  await rows(
    admin(),
    sql`update addon_realestate.deals set stage = 'active' where record_id = ${listing}`,
  );
  await rows(
    admin(),
    sql`insert into addon_realestate.listings (workspace_id, deal_record_id, mls_number, mls_live_on, facts,
          facts_confirmed_at)
        values (${t.wsId}, ${listing}, 'GS4821937', current_date, ${JSON.stringify({ beds: 3, baths: 2 })}::jsonb,
          now())`,
  );
  await run(agent, 'realestate.term.enter', {
    dealId: listing,
    key: 'list_price',
    cents: 38_900_000,
    source: 'agreement',
  });

  // A listing named as the web's Start a deal names one, its seller's name in its street.
  const moreno = (
    await run(agent, 'realestate.deal.open', {
      side: 'listing',
      name: 'Listing · 12 Moreno Ct, Kenner, LA',
      clientPersonId: await person('Ray', 'Moreno'),
      newPropertyAddress: '12 Moreno Ct, Kenner, LA',
    })
  ).dealId;
  await rows(
    admin(),
    sql`insert into addon_realestate.listings (workspace_id, deal_record_id) values (${t.wsId}, ${moreno})`,
  );

  // A buyer deal on a home of its own, with a client and a home they're looking at.
  purchase = (
    await run(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Lakefront purchase',
      clientPersonId: dana,
      newPropertyAddress: '14 Lake Rd, Mandeville, LA',
    })
  ).dealId;
  pelican = await one(
    sql`insert into addon_realestate.homes (workspace_id, deal_record_id, address, address_key, source, status)
        values (${t.wsId}, ${purchase}, '77 Pelican Way, Kenner, LA', '77 pelican way kenner la', 'agent',
          'shortlisted')
        returning id`,
  );

  // A property with no deal at all, and seven alike for paging.
  const property = (name: string) =>
    one(sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
            select ${t.wsId}, ty.id, ${name}, ${agent.id} from app.custom_record_types ty
            where ty.workspace_id = ${t.wsId} and ty.key = 'realestate_property'
            returning id`);
  bayou = await property('9 Bayou Lane, Slidell, LA');
  for (let i = 1; i <= 7; i++) await property(`${i} Cypress Row, Covington, LA`);

  // Fields the business added to its properties and its deals, filled in on Bayou Lane and Lakefront's purchase.
  const field = (kind: string, key: string, label: string) =>
    one(sql`insert into app.custom_fields (workspace_id, entity, key, label, type, record_type_id)
            select ${t.wsId}, 'custom_record', ${key}, ${label}, 'text', ty.id from app.custom_record_types ty
            where ty.workspace_id = ${t.wsId} and ty.key = ${kind}
            returning id`);
  const fill = (record: string, fieldId: string, value: string) =>
    rows(
      admin(),
      sql`update app.custom_records set custom = custom || ${JSON.stringify({ [fieldId]: value })}::jsonb
          where id = ${record}`,
    );
  await fill(bayou, await field('realestate_property', 'parish', 'Parish'), 'Jefferson');
  await fill(
    purchase,
    await field('realestate_deal', 'referred_by', 'Referred by'),
    'Pontchartrain Realty',
  );

  // A deal that's archived.
  oak = (await run(agent, 'realestate.deal.open', { side: 'buyer', name: 'Oak Street sale' }))
    .dealId;
  await executeCommand(
    api(),
    customRecordArchive,
    { workspaceId: t.wsId, customRecordId: oak },
    human(owner),
    { correlationId: randomUUID(), channel: 'test' },
  );

  // Someone with the records but without "Work on deals".
  await executeCommand(
    api(),
    permissionSetMember,
    { workspaceId: t.wsId, userId: nouse.id, permission: 'realestate.use', allowed: false },
    human(owner),
    { correlationId: randomUUID(), channel: 'test' },
  );
}, 120_000);

afterAll(closeTestDbs);

describe('the query', () => {
  it('keeps to core’s contract, and is never a route', () => {
    expect(addonSearchIssues([realestateAddonServer])).toEqual([]);
    const q = realestateAddonServer.queries!.find((x) => x.name === 'realestate.search')!;
    expect(q.route).toBe(false);
    expect(q.ai).toBeUndefined();
  });
});

describe('listings', () => {
  it('are found by their MLS number first, exactly, with their stage, list price and rooms', async () => {
    for (const q of ['GS4821937', 'gs4821937', 'MLS GS4821937', '#GS4821937', 'MLS#GS4821937']) {
      const a = await everything(t, agent, q);
      expect(a.best, q).toMatchObject({
        kind: 'realestate.listings',
        id: listing,
        title: '418 Smith Ave, Metairie, LA',
        subtitle: 'Active · $389,000 · 3 bd · 2 ba',
        tier: 0,
        exact: true,
        why: { label: 'MLS number', snippet: { text: 'GS4821937', marks: [[0, 9]] } },
        href: `/app/w/${t.wsId}/a/realestate/deals/${listing}`,
      });
    }
    // Part of a number is no MLS number.
    expect(groupOf(await everything(t, agent, 'GS482'), 'realestate.listings')).toBeUndefined();
  });

  it('are found by their home’s address, and the deal and the property show once, as the listing', async () => {
    const a = await everything(t, agent, '418 smith');
    expect(titles(groupOf(a, 'realestate.listings'))).toEqual(['418 Smith Ave, Metairie, LA']);
    expect(groupOf(a, 'realestate.listings')!.items[0]).toMatchObject({ tier: 1, exact: false });
    expect(groupOf(a, 'realestate.deals')).toBeUndefined();
    expect(groupOf(a, 'realestate.properties')).toBeUndefined();
    expect(groupOf(a, 'record.realestate_property')).toBeUndefined();
    expect(groupOf(a, 'record.realestate_deal')).toBeUndefined();
    // Asked for deals alone, the deal is found by its home's address.
    const deals = await everything(t, agent, '418 smith', { kinds: ['realestate.deals'] });
    expect(groupOf(deals, 'realestate.deals')!.items).toEqual([
      expect.objectContaining({
        title: 'Becnel listing',
        subtitle: 'Listing · Active',
        tier: 3,
        why: expect.objectContaining({ label: 'Address' }),
      }),
    ]);
  });

  it('leave their own deal to them however it matched: by its name, or by its client', async () => {
    const byAddress = await everything(t, agent, 'moreno ct');
    expect(titles(groupOf(byAddress, 'realestate.listings'))).toEqual(['12 Moreno Ct, Kenner, LA']);
    expect(groupOf(byAddress, 'realestate.deals')).toBeUndefined();
    expect(groupOf(byAddress, 'realestate.properties')).toBeUndefined();
    const byClient = await everything(t, agent, 'moreno');
    expect(titles(groupOf(byClient, 'realestate.listings'))).toEqual(['12 Moreno Ct, Kenner, LA']);
    expect(titles(groupOf(byClient, 'realestate.deals'))).toEqual(['Lakefront purchase']);
  });

  it('leave the same to them on a kind’s own page, so it holds what its group counted', async () => {
    for (const kind of ['realestate.deals', 'realestate.properties'])
      expect(titles((await oneKind(t, agent, '418 smith', kind)).group), kind).toEqual([]);
    expect(titles((await oneKind(t, agent, 'moreno', 'realestate.deals')).group)).toEqual([
      'Lakefront purchase',
    ]);
    // Someone the listing is hidden from finds its property there, as in the whole answer.
    expect(titles((await oneKind(t, other, '418 smith', 'realestate.properties')).group)).toEqual([
      '418 Smith Ave, Metairie, LA',
    ]);
  });
});

describe('deals and homes', () => {
  it('find a deal by its name and by its client, opening the deal', async () => {
    const byName = await everything(t, agent, 'lakefront');
    expect(groupOf(byName, 'realestate.deals')!.items[0]).toMatchObject({
      id: purchase,
      title: 'Lakefront purchase',
      subtitle: 'Buyer deal · Lead',
      tier: 1,
      href: `/app/w/${t.wsId}/a/realestate/deals/${purchase}`,
    });
    const byClient = await everything(t, agent, 'dana moreno');
    expect(titles(groupOf(byClient, 'contacts'))).toEqual(['Dana Moreno']);
    expect(groupOf(byClient, 'realestate.deals')!.items).toEqual([
      expect.objectContaining({
        title: 'Lakefront purchase',
        tier: 3,
        why: expect.objectContaining({
          label: 'Client',
          snippet: {
            text: 'Dana Moreno',
            marks: [
              [0, 4],
              [5, 11],
            ],
          },
        }),
      }),
    ]);
  });

  it('find a record of the deal kind made without its deal, opening its record’s page', async () => {
    // Core's custom_record.create can make one; with core's group taken away, Real Estate finds it.
    const plain = await one(
      sql`insert into app.custom_records (workspace_id, type_id, name, kept_to_team, owner_user_id, created_by)
          select ${t.wsId}, ty.id, 'Magnolia Court purchase', true, ${agent.id}, ${agent.id}
          from app.custom_record_types ty where ty.workspace_id = ${t.wsId} and ty.key = 'realestate_deal'
          returning id`,
    );
    const a = await everything(t, agent, 'magnolia');
    expect(groupOf(a, 'realestate.deals')!.items).toEqual([
      expect.objectContaining({
        id: plain,
        subtitle: null,
        href: `/app/w/${t.wsId}/customers/records/${plain}`,
      }),
    ]);
    expect(groupOf(a, 'record.realestate_deal')).toBeUndefined();
  });

  it('find a deal by one of its fields, saying which', async () => {
    const a = await everything(t, agent, 'pontchartrain');
    expect(groupOf(a, 'realestate.deals')!.items).toEqual([
      expect.objectContaining({
        id: purchase,
        tier: 3,
        why: expect.objectContaining({
          label: 'Referred by',
          snippet: { text: 'Pontchartrain Realty', marks: [[0, 13]] },
        }),
      }),
    ]);
  });

  it('find a buyer’s own home under Properties, and its deal by the address', async () => {
    const a = await everything(t, agent, '14 lake rd');
    expect(groupOf(a, 'realestate.properties')!.items).toEqual([
      expect.objectContaining({ title: '14 Lake Rd, Mandeville, LA', subtitle: '1 deal' }),
    ]);
    expect(groupOf(a, 'realestate.deals')!.items).toEqual([
      expect.objectContaining({
        title: 'Lakefront purchase',
        why: expect.objectContaining({ label: 'Address' }),
      }),
    ]);
  });

  it('find a home on a buyer deal by its address, opening the deal’s Homes with it', async () => {
    const a = await everything(t, agent, 'pelican way');
    expect(groupOf(a, 'realestate.homes')!.items).toEqual([
      expect.objectContaining({
        id: pelican,
        title: '77 Pelican Way, Kenner, LA',
        subtitle: 'Shortlisted · Lakefront purchase',
        href: `/app/w/${t.wsId}/a/realestate/deals/${purchase}/homes?home=${pelican}`,
      }),
    ]);
  });
});

describe('properties', () => {
  it('are found when no listing is on them, opening the record’s page', async () => {
    const a = await everything(t, agent, 'bayou lane');
    expect(groupOf(a, 'realestate.properties')!.items).toEqual([
      expect.objectContaining({
        id: bayou,
        title: '9 Bayou Lane, Slidell, LA',
        subtitle: 'No deals yet',
        href: `/app/w/${t.wsId}/customers/records/${bayou}`,
      }),
    ]);
    expect(groupOf(a, 'record.realestate_property')).toBeUndefined();
  });

  it('are found by one of their fields, saying which, as core’s group of records did', async () => {
    const a = await everything(t, agent, 'jefferson');
    expect(groupOf(a, 'realestate.properties')!.items).toEqual([
      expect.objectContaining({
        id: bayou,
        subtitle: 'No deals yet',
        tier: 3,
        why: expect.objectContaining({
          label: 'Parish',
          snippet: { text: 'Jefferson', marks: [[0, 9]] },
        }),
      }),
    ]);
  });
});

describe('who finds what', () => {
  it('keeps a private deal, its listing and its homes to its people', async () => {
    for (const u of [agent, owner]) {
      expect(titles(groupOf(await everything(t, u, 'GS4821937'), 'realestate.listings'))).toEqual([
        '418 Smith Ave, Metairie, LA',
      ]);
      expect(titles(groupOf(await everything(t, u, 'lakefront'), 'realestate.deals'))).toEqual([
        'Lakefront purchase',
      ]);
      expect(groupOf(await everything(t, u, 'pelican way'), 'realestate.homes')).toBeDefined();
    }
    expect(groupOf(await everything(t, other, 'GS4821937'), 'realestate.listings')).toBeUndefined();
    expect(groupOf(await everything(t, other, 'lakefront'), 'realestate.deals')).toBeUndefined();
    expect(groupOf(await everything(t, other, 'dana moreno'), 'realestate.deals')).toBeUndefined();
    expect(groupOf(await everything(t, other, 'pelican way'), 'realestate.homes')).toBeUndefined();
    // The listing hidden from them, its property (everyone's) is found under Properties instead.
    const a = await everything(t, other, '418 smith');
    expect(groupOf(a, 'realestate.listings')).toBeUndefined();
    expect(titles(groupOf(a, 'realestate.properties'))).toEqual(['418 Smith Ave, Metairie, LA']);
    expect(groupOf(a, 'realestate.properties')!.items[0]!.id).toBe(listingHome);
  });

  it('shows archived deals only with Include archived, and core’s Archived lists them otherwise', async () => {
    const a = await everything(t, agent, 'oak street');
    expect(groupOf(a, 'realestate.deals')).toBeUndefined();
    expect(titles(a.archived)).toEqual(['Oak Street sale']);
    const all = await everything(t, agent, 'oak street', { includeArchived: true });
    expect(groupOf(all, 'realestate.deals')!.items).toEqual([
      expect.objectContaining({ id: oak, title: 'Oak Street sale', badges: ['archived'] }),
    ]);
    expect(titles((await oneKind(t, agent, 'oak street', 'realestate.deals')).group)).toEqual([]);
    expect(
      titles(
        (await oneKind(t, agent, 'oak street', 'realestate.deals', { includeArchived: true }))
          .group,
      ),
    ).toEqual(['Oak Street sale']);
    expect(titles(all.archived)).toEqual([]);
  });

  it('keeps Only mine to the deals the person is on', async () => {
    expect(
      groupOf(await everything(t, owner, 'lakefront', { onlyMine: true }), 'realestate.deals'),
    ).toBeUndefined();
    expect(
      titles(
        groupOf(await everything(t, agent, 'lakefront', { onlyMine: true }), 'realestate.deals'),
      ),
    ).toEqual(['Lakefront purchase']);
  });

  it('leaves core’s group of its records standing for someone it doesn’t run for', async () => {
    const a = await everything(t, nouse, 'bayou lane');
    expect(groupOf(a, 'realestate.properties')).toBeUndefined();
    expect(titles(groupOf(a, 'record.realestate_property'))).toEqual(['9 Bayou Lane, Slidell, LA']);
    expect(groupOf(a, 'record.realestate_property')!.items[0]!.href).toBe(
      `/app/w/${t.wsId}/customers/records/${bayou}`,
    );
    await expectHfos(
      () => oneKind(t, nouse, 'bayou lane', 'realestate.properties'),
      'search_kind_not_allowed',
      403,
    );
  });
});

describe('a kind’s own page', () => {
  it('pages in its own order with its cursor, and starts again on one it can’t read', async () => {
    const page = (cursor?: string) =>
      oneKind(t, agent, 'cypress row', 'realestate.properties', {
        sort: 'name',
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
    const first = await page();
    expect(first.group.total).toBe(7);
    expect(titles(first.group)).toEqual([
      '1 Cypress Row, Covington, LA',
      '2 Cypress Row, Covington, LA',
      '3 Cypress Row, Covington, LA',
    ]);
    expect(first.nextCursor).toBe('3');
    const second = await page(first.nextCursor!);
    expect(titles(second.group)[0]).toBe('4 Cypress Row, Covington, LA');
    const last = await page(second.nextCursor!);
    expect(titles(last.group)).toEqual(['7 Cypress Row, Covington, LA']);
    expect(last.nextCursor).toBeNull();
    await expectHfos(() => page('not-ours'), 'validation', 400);
    await expectHfos(() => page('999'), 'validation', 400);
  });

  it('is refused while Real Estate is off, and the rest of the search goes on without it', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${t.wsId} and addon_id = 'realestate'`,
    );
    try {
      await expectHfos(
        () => oneKind(t, agent, 'GS4821937', 'realestate.listings'),
        'addon_inactive',
        403,
      );
      const a = await everything(t, agent, 'dana moreno');
      expect(a.groups.map((g) => g.kind)).toEqual(['contacts']);
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${t.wsId} and addon_id = 'realestate'`,
      );
    }
    expect(groupOf(await everything(t, agent, 'GS4821937'), 'realestate.listings')).toBeDefined();
  });
});
