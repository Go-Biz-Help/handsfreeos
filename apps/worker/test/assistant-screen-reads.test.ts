import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADDON_PAGE_WORDS,
  ADDON_SERVER_MODULES,
  AFFILIATE_TERMS_VERSION,
  affiliateCodeLink,
  affiliateLink,
  allAddonAiTools,
  assistantTools,
  executeCommand,
  hasStaffPermission,
  hasWorkspacePermission,
  IDEA_STATUS_WORDS,
  IDEAS_WORDS,
  isStaffPermission,
  NOT_FOR_THE_ASSISTANT,
  organizationCreate,
  personCreate,
  registry,
  SCREEN_READS,
  screenReadName,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { allScreenReadTools, screenReadToolsFor } from '../src/assistant/tools-screen-reads';
import { createToolExecutor } from '../src/assistant/tools-write';

/**
 * Everything a person can see, the Assistant can see (the owner, 2026-10-26): every query a screen on the web or the
 * phone loads is read by the Assistant's own tools, an add-on's tool or a screen read, or kept out for a reason.
 */

const ROOT = join(__dirname, '..', '..', '..');

/** Every file under a folder, as text. */
function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === 'node_modules' || name === '__tests__' ? [] : filesIn(path);
    return /\.(ts|tsx)$/.test(name) ? [readFileSync(path, 'utf8')] : [];
  });
}

const screenQueries = () =>
  new Set(
    ['apps/web/src', 'apps/mobile/src'].flatMap((dir) =>
      filesIn(join(ROOT, dir)).flatMap((text) =>
        [...text.matchAll(/\/v1\/queries\/([a-z_]+\.[a-z_.]+)/g)].map((m) => m[1]!),
      ),
    ),
  );

/** The queries the Assistant's own tools read: every one named in its code. */
const ownReads = () =>
  new Set(
    filesIn(join(ROOT, 'apps/worker/src/assistant')).flatMap((text) =>
      [...text.matchAll(/'([a-z_]+\.[a-z_.]+)'/g)].map((m) => m[1]!),
    ),
  );

const api = () => testDbs().api.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
const ctx = (u: TestUser = owner): ToolContext => ({
  actor: actor(u),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});
const read = async (query: string, args: Record<string, unknown>, u: TestUser = owner) => {
  const tool = allScreenReadTools().find((t) => t.name === screenReadName(query))!;
  return (await createToolExecutor(api()).run(tool, tool.input.parse(args) as never, ctx(u))) as {
    result: { data: unknown };
  };
};

beforeAll(async () => {
  owner = await createTestUser('screens-owner', { fullName: 'Sam Owner' });
  const org = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Screens Co' },
      actor(owner),
      meta(),
    )
  ).output as { workspaceId: string; organizationId: string };
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
}, 60_000);
afterAll(closeTestDbs);

describe('what the Assistant can see', () => {
  it('reads every query a screen loads, or keeps it out for a reason', () => {
    const own = ownReads();
    const addonReads = new Set<string>(
      allAddonAiTools(ADDON_SERVER_MODULES)
        .filter((t) => t.op.kind === 'query')
        .map((t) => t.op.name),
    );
    const reads = new Set<string>(SCREEN_READS);
    const unread = [...screenQueries()].filter(
      (q) => !reads.has(q) && !own.has(q) && !addonReads.has(q) && !(q in NOT_FOR_THE_ASSISTANT),
    );
    expect(unread).toEqual([]);
  });

  it('makes a look-up of each, named once, after nothing else', () => {
    const tools = allScreenReadTools();
    expect(tools.map((t) => t.query.name)).toEqual([...SCREEN_READS]);
    for (const name of SCREEN_READS) expect(registry.query(name), name).toBeTruthy();
    const taken = new Set([
      ...assistantTools.map((t) => t.name),
      ...allAddonAiTools(ADDON_SERVER_MODULES).map((t) => t.name),
    ]);
    expect(tools.filter((t) => taken.has(t.name))).toEqual([]);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.autonomy, t.name).toBe('auto');
      // A staff screen looks across businesses, so it names the one it reads (the test below).
      if (t.query.permission && isStaffPermission(t.query.permission)) continue;
      expect(Object.keys(t.input.shape), t.name).not.toContain('workspaceId');
    }
  });

  it('offers each only to people whose permissions open its screen', () => {
    const member = screenReadToolsFor((p) => hasWorkspacePermission('member', p)).map(
      (t) => t.query.name,
    );
    const ownerReads = screenReadToolsFor((p) => hasWorkspacePermission('owner', p)).map(
      (t) => t.query.name,
    );
    expect(member).toContain('timeline.list');
    expect(member).not.toContain('audit.list');
    expect(member).not.toContain('registration.get_draft');
    expect(ownerReads).toContain('audit.list');
    expect(ownerReads).toContain('registration.get_draft');
    // HandsFreeOS's own staff screens: only staff, by their staff role (the owner, 2026-10-27).
    expect(ownerReads).not.toContain('support.ticket.list');
    expect(ownerReads).not.toContain('platform.business.list');
    const agent = screenReadToolsFor((p) => hasStaffPermission('agent', p)).map(
      (t) => t.query.name,
    );
    expect(agent).toContain('support.ticket.list');
    expect(agent).not.toContain('platform.rates');
    // The agency's own screens ask the organization's permission, which no business role holds: they're offered
    // to whoever can change the business, and the kernel still checks the organization's own (the test below).
    expect(ownerReads).toContain('onboarding.clients');
    expect(ownerReads).toContain('ai_setup_template.list');
    expect(member).not.toContain('onboarding.clients');
    expect(member).not.toContain('ai_setup_template.list');
  });

  it('keeps the business a staff screen looks at, and puts on the person’s own everywhere else', () => {
    const glance = allScreenReadTools().find((t) => t.query.name === 'platform.business.glance')!;
    expect(glance.scope).toEqual([]);
    expect(Object.keys(glance.input.shape)).toContain('workspaceId');
    const timeline = allScreenReadTools().find((t) => t.query.name === 'timeline.list')!;
    expect(timeline.scope).toContain('workspaceId');
  });

  it('runs one as the person, in their business, whatever business the model names', async () => {
    const { personId } = (
      await executeCommand(
        api(),
        personCreate,
        { workspaceId, firstName: 'Tess', lastName: 'Timeline' },
        actor(owner),
        meta(),
      )
    ).output as { personId: string };
    const { result } = await read('timeline.list', {
      recordType: 'person',
      recordId: personId,
      workspaceId: randomUUID(),
    });
    expect(result.data).toMatchObject({ items: expect.any(Array) });
    const usage = await read('usage.statement', {});
    expect(usage.result.data).toBeTruthy();
  });

  it('reads the agency’s own screens for its owners, and the whole agency only for them', async () => {
    type Clients = { counts: { all: number }; businesses: Record<string, unknown>[] };
    const clients = (await read('onboarding.clients', {})).result.data as Clients;
    expect(clients.businesses).toContainEqual(
      expect.objectContaining({
        businessId: workspaceId,
        setup: expect.stringMatching(/^\d+ of \d+ done$/),
        openTheirWorkspace: `/app/w/${workspaceId}`,
        stillOpen: expect.any(Array),
      }),
    );
    // Narrowed as the page's filters narrow it, still counting them all.
    const one = (await read('onboarding.clients', { businessId: workspaceId })).result
      .data as Clients;
    expect(one.businesses.map((b) => b['businessId'])).toEqual([workspaceId]);
    expect(one.counts).toEqual(clients.counts);
    expect((await read('ai_setup_template.list', {})).result.data).toMatchObject({
      items: expect.any(Array),
    });
    // The whole agency's migrations go through the agency's own door.
    const migration = allScreenReadTools().find((t) => t.query.name === 'migration.get')!;
    expect(migration.agencyDoor).toBe(true);
    expect(Object.keys(migration.input.shape)).toContain('wholeAgency');
    expect(Object.keys(migration.input.shape)).not.toContain('organizationId');

    // A business's admin who isn't one of the agency's owners or admins is told who can.
    const admin = await createTestUser('screens-admin', { fullName: 'Ada Admin' });
    await rows(
      testDbs().admin.db,
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${admin.id}, 'admin')`,
    );
    await expect(
      read('migration.get', { migrationId: randomUUID(), wholeAgency: true }, admin),
    ).rejects.toMatchObject({ rule: 'agency_only' });
    // The agency's own screens: told who can, never that the agency isn't there.
    expect(
      allScreenReadTools().find((t) => t.query.name === 'onboarding.clients')!.agencyOnly,
    ).toBe(true);
    expect(allScreenReadTools().find((t) => t.query.name === 'timeline.list')!.agencyOnly).toBe(
      false,
    );
    await expect(read('onboarding.clients', {}, admin)).rejects.toMatchObject({
      rule: 'agency_only',
      message: expect.stringContaining('Only the owners and admins of'),
    });
    await expect(read('ai_setup_template.list', {}, admin)).rejects.toMatchObject({
      rule: 'agency_only',
    });
  });

  it('reads the team’s hours in words, as the Calendar’s Team view shows them, without the day-by-day list', async () => {
    const now = Date.now();
    const { result } = await read('schedule.team', {
      from: new Date(now).toISOString(),
      to: new Date(now + 7 * 86_400_000).toISOString(),
    });
    const data = result.data as { timeZone: string; people: Record<string, unknown>[] };
    expect(data.timeZone).toEqual(expect.any(String));
    const me = data.people.find((p) => p['userId'] === owner.id)!;
    expect(me).toMatchObject({
      name: 'Sam Owner',
      weeklyHours: expect.any(String),
      hoursIn: expect.stringContaining('time zone'),
      timeOff: [],
      calendarLink: 'No calendar linked',
    });
    expect(me).not.toHaveProperty('windows');
    expect(me).not.toHaveProperty('weekly');
  });

  it('reads the Audit log as its rows say them, filtered as its menus filter, and keeps the next page when cut', async () => {
    type Page = { entries: Record<string, unknown>[]; nextCursor: string | null };
    // Enough new customers that a page of them is too long to read whole.
    for (let n = 0; n < 65; n += 1)
      await executeCommand(
        api(),
        personCreate,
        { workspaceId, firstName: `Audra${n}`, lastName: 'Logwood' },
        actor(owner),
        meta(),
      );
    // Filter by activity → Contacts: each row as the log says it, who did it and what, in words.
    const contacts = (await read('audit.list', { category: 'customers', limit: 5 })).result
      .data as Page;
    expect(contacts.entries).toHaveLength(5);
    expect(contacts.entries[0]).toMatchObject({
      who: 'Sam Owner',
      did: 'added Audra64 Logwood',
      kind: 'Contacts',
      action: 'person.create',
      actorId: owner.id,
      entityType: 'person',
    });
    expect(contacts.entries[0]).not.toHaveProperty('actor');
    expect(contacts.entries.every((e) => e['kind'] === 'Contacts')).toBe(true);
    expect(contacts.nextCursor).toEqual(expect.any(String));
    // Filter by person → a person, and → HandsFreeOS: only what each did (pages short enough to read whole).
    const sam = (await read('audit.list', { actorType: 'human', limit: 20 })).result.data as Page;
    expect(sam.entries).toHaveLength(20);
    expect(sam.entries.every((e) => e['who'] === 'Sam Owner')).toBe(true);
    const system = (await read('audit.list', { actorType: 'system', limit: 10 })).result
      .data as Page;
    expect(system.entries).toEqual(expect.any(Array));
    expect(system.entries.every((e) => String(e['who']).startsWith('HandsFreeOS'))).toBe(true);

    // A page too long to read whole still says where the next one starts.
    const long = (await read('audit.list', { category: 'customers', limit: 60 })).result as {
      cutShort?: boolean;
      nextCursor?: string;
    };
    expect(long).toMatchObject({ cutShort: true, nextCursor: expect.any(String) });
    const next = (
      await read('audit.list', { category: 'customers', limit: 5, cursor: long.nextCursor })
    ).result.data as Page;
    expect(next.entries.length).toBeGreaterThan(0);
    expect(next.entries.map((e) => e['did'])).not.toContain('added Audra64 Logwood');
  });

  it('gives an affiliate their link and each code’s that’s on, once their page shows them', async () => {
    const admin = testDbs().admin.db;
    const code = `sr-${randomUUID().slice(0, 8)}`;
    const [row] = await rows<{ id: string }>(
      admin,
      sql`insert into platform.affiliates (user_id, code, name, pitch, links, status, terms_version, terms_accepted_at)
          values (${owner.id}, ${code}, 'Sam Owner', 'My newsletter', 'https://sam.example', 'approved',
                  ${AFFILIATE_TERMS_VERSION}, now())
          returning id`,
    );
    const affiliateId = row!.id;
    try {
      await admin.execute(
        sql`insert into platform.affiliate_codes (affiliate_id, code, trial_days, status)
            values (${affiliateId}, ${`${code}-on`}, 14, 'on'), (${affiliateId}, ${`${code}-off`}, 14, 'off')`,
      );
      type Mine = { affiliate: { link?: string; codes: { code: string; link?: string }[] } };
      const mine = (await read('affiliate.mine', {})).result.data as Mine;
      // On HandsFreeOS's own website, as their page's Copy gives them.
      expect(mine.affiliate.link).toBe(affiliateLink(code));
      expect(mine.affiliate.codes.find((c) => c.code === `${code}-on`)?.link).toBe(
        affiliateCodeLink(`${code}-on`),
      );
      expect(mine.affiliate.codes.find((c) => c.code === `${code}-off`)).not.toHaveProperty('link');
      // Until they agree to the terms their page shows no link, and neither does the Assistant.
      await admin.execute(
        sql`update platform.affiliates set terms_version = null, terms_accepted_at = null where id = ${affiliateId}`,
      );
      const before = (await read('affiliate.mine', {})).result.data as Mine;
      expect(before.affiliate).not.toHaveProperty('link');
    } finally {
      await admin.execute(sql`delete from platform.affiliates where id = ${affiliateId}`);
    }
  });
});

describe('the Add-ons page’s vote and the Ideas Roadmap', () => {
  it('reads the vote on what’s next as the page filters it, each add-on with the id a vote takes', async () => {
    type Planned = {
      comingSoon: { addonId: string }[];
      categories: { category: string; label: string; count: number }[];
      planned: { addonId: string; name: string; category: string }[];
      more?: number;
    };
    const all = (await read('addon.roadmap', {})).result.data as Planned;
    expect(all.categories[0]).toMatchObject({
      category: 'all',
      label: ADDON_PAGE_WORDS.allCategories,
    });
    expect(all.comingSoon).toContainEqual(expect.objectContaining({ addonId: 'realestate' }));
    // The first 20, and how many more there are, as nobody reads a hundred-odd at once.
    expect(all.planned).toHaveLength(20);
    expect(all.more).toBe(all.categories[0]!.count - 20);

    // One category chip, A to Z, as the page's chips and Sort do.
    const chip = all.categories[1]!;
    const one = (await read('addon.roadmap', { category: chip.category, sort: 'az', limit: 30 }))
      .result.data as Planned;
    expect(one.planned.length).toBe(Math.min(chip.count, 30));
    expect(one.planned.every((p) => p.category === chip.label)).toBe(true);
    const names = one.planned.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('reads the Roadmap as its columns show it, and more of one column when asked', async () => {
    type Column = {
      column: string;
      status: string;
      means: string;
      count: number;
      cards: unknown[];
    };
    const all = (await read('idea.roadmap', {})).result.data as { columns: Column[] };
    expect(all.columns.map((c) => c.column)).toEqual([
      IDEA_STATUS_WORDS.planned,
      IDEA_STATUS_WORDS.in_progress,
      IDEAS_WORDS.doneLately,
    ]);
    for (const c of all.columns) expect(c.cards.length, c.status).toBe(Math.min(c.count, 15));

    const done = (await read('idea.roadmap', { column: 'done' })).result.data as {
      columns: Column[];
    };
    expect(done.columns).toHaveLength(1);
    expect(done.columns[0]).toMatchObject({ status: 'done', column: IDEAS_WORDS.doneLately });
    expect(done.columns[0]!.means).toContain('90 days');
  });

  it('gives the link to an add-on’s Connections with what it connects to', async () => {
    const got = (await read('addon_connection.list', { addonId: 'realestate' })).result.data;
    // The tests run without the web app's address, so the link is the path.
    expect(got).toMatchObject({ page: `/app/w/${workspaceId}/addons/realestate/connections` });
  });
});
