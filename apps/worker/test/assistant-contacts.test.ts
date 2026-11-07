/**
 * The Assistant's customers in bulk (0107), against the real database: many customers at once with their tags;
 * tags on or off many in one go, a new tag made on the way; any detail of a customer changed, added or taken off;
 * and the AI's pass over the whole list started, read and stopped; and Settings → Tags' tags added, renamed,
 * recoloured and deleted. Every change waits for Confirm, runs as the person "via Assistant", and keeps the reason
 * they gave on its audit row. Then a customer read in full, and the list narrowed as Contacts narrows it.
 */
import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  companyCreate,
  customFieldCreate,
  executeCommand,
  hasWorkspacePermission,
  organizationCreate,
  personCreate,
  recordAddTag,
  tagCreate,
  type AssistantCard,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
): Promise<z.output<O>> =>
  (
    await executeCommand(api(), cmd, input, actor(u), {
      correlationId: randomUUID(),
      channel: 'test',
    })
  ).output;

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let vip: string;
const people: Record<string, string> = {};

const ctx = (): ToolContext => ({
  actor: actor(owner),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const tools = () => createToolExecutor(api());
const tool = (name: string) => assistantToolByName.get(name)!;
/** The arguments as the runtime hands them over: checked against the tool's input, defaults filled. */
const argsOf = (name: string, args: Record<string, unknown>) =>
  tool(name).input.parse(args) as Record<string, unknown>;
const prepare = async (name: string, args: Record<string, unknown>) => {
  const out = await tools().prepare(tool(name), argsOf(name, args), ctx(), randomUUID());
  return out as {
    card: Extract<AssistantCard, { type: 'confirm' }>;
    result: Record<string, unknown>;
  };
};
const commit = (name: string, args: Record<string, unknown>) =>
  tools().commit(tool(name), argsOf(name, args), ctx(), { toolCallId: randomUUID() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (name: string, args: Record<string, unknown>): Promise<any> =>
  ((await tools().run(tool(name), argsOf(name, args), ctx())) as { result: unknown }).result;
const field = (card: { fields: { label: string; value: string }[] }, label: string) =>
  card.fields.find((f) => f.label === label)?.value;
const tagsOn = async (personId: string) =>
  (
    await rows<{ name: string }>(
      admin(),
      sql`select t.name::text as name from app.record_tags rt join app.tags t on t.id = rt.tag_id
          where rt.record_type = 'person' and rt.record_id = ${personId} order by t.name`,
    )
  ).map((t) => t.name);

beforeAll(async () => {
  owner = await createTestUser('acon-dale', { fullName: 'Dale Owner' });
  const org = await run(
    organizationCreate,
    { businessName: `Contacts HVAC ${randomUUID().slice(0, 8)}`, timezone: CHI },
    owner,
  );
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  vip = (await run(tagCreate, { workspaceId, name: 'VIP' }, owner)).tagId;
  for (const [first, email] of [
    ['Ann', 'ann@old.test'],
    ['Ben', null],
    ['Cal', null],
  ] as const)
    people[first] = (
      await run(
        personCreate,
        {
          workspaceId,
          firstName: first,
          lastName: 'Bulk',
          email,
          phone: first === 'Ann' ? '512-555-0142' : null,
        },
        owner,
      )
    ).personId;
  await run(
    recordAddTag,
    { workspaceId, recordType: 'person', recordId: people['Cal'], tagId: vip },
    owner,
  );
}, 60_000);
afterAll(closeTestDbs);

describe('the tools', () => {
  it('each have their executor, and only owners and admins start a pass over the list', () => {
    for (const name of [
      'list_customers',
      'list_companies',
      'ai_tagging_status',
      'tag_customers',
      'ai_tag_customers',
      'update_customer',
    ])
      expect(executorFor(name), name).toBeTruthy();
    const member = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    expect(member).toEqual(
      expect.arrayContaining(['list_customers', 'list_companies', 'tag_customers']),
    );
    expect(member).not.toContain('ai_tag_customers');
  });
});

describe('list_customers', () => {
  it('lists many at once with their tags, and the ones without a tag', async () => {
    const out = (await tools().run(
      tool('list_customers'),
      argsOf('list_customers', { withoutTagId: vip }),
      ctx(),
    )) as {
      result: {
        customers: { id: string; name: string; tags: string[] }[];
        nextCursor: string | null;
      };
    };
    expect(out.result.customers.map((c) => c.name)).toEqual(['Ann Bulk', 'Ben Bulk']);
    const all = (await tools().run(
      tool('list_customers'),
      argsOf('list_customers', {}),
      ctx(),
    )) as {
      result: { customers: { name: string; tags: string[] }[] };
    };
    expect(all.result.customers.find((c) => c.name === 'Cal Bulk')!.tags).toEqual(['VIP']);
  });
});

describe('tag_customers', () => {
  it('shows who and what first, then tags them all, making the new tag, with the reason on every audit row', async () => {
    const args = {
      personIds: [people['Ann'], people['Ben']],
      addTagIds: [vip],
      newTagNames: ['Spring promo'],
      reason: 'Both booked a spring tune-up',
    };
    const { card } = await prepare('tag_customers', args);
    expect(card.title).toBe('Change the tags on 2 customers?');
    expect(field(card, 'Customers')).toBe('Ann Bulk, Ben Bulk');
    expect(field(card, 'Put on')).toBe('VIP');
    expect(field(card, 'New tags')).toBe('Spring promo');
    expect(await tagsOn(people['Ann']!)).toEqual([]);

    const done = await commit('tag_customers', args);
    expect(done.outcome).toBe('Tags changed on 2 of 2');
    expect(await tagsOn(people['Ann']!)).toEqual(['Spring promo', 'VIP']);
    expect(await tagsOn(people['Ben']!)).toEqual(['Spring promo', 'VIP']);
    const audit = await rows<{ action: string; channel: string; reason: string | null }>(
      admin(),
      sql`select action, channel, reason from app.audit_logs
          where workspace_id = ${workspaceId} and entity_id = ${people['Ann']} and action = 'record.set_tags'`,
    );
    expect(audit).toEqual([
      { action: 'record.set_tags', channel: 'assistant', reason: 'Both booked a spring tune-up' },
    ]);
  });

  it('takes tags off and leaves the rest', async () => {
    await commit('tag_customers', {
      personIds: [people['Ann']],
      removeTagIds: [vip],
      reason: 'Not a VIP after all',
    });
    expect(await tagsOn(people['Ann']!)).toEqual(['Spring promo']);
  });
});

describe('update_customer', () => {
  it('changes, adds and takes off any detail, showing each before and after', async () => {
    const args = {
      personId: people['Ann'],
      email: 'ann@new.test',
      phone: null,
      address: { city: 'Round Rock', state: 'TX' },
      addOtherEmails: [{ email: 'ann@work.test', label: 'Work' }],
      source: 'Yard sign',
      reason: 'Ann called with her new details',
    };
    const { card } = await prepare('update_customer', args);
    expect(card.title).toBe('Change Ann’s details?');
    expect(field(card, 'Email')).toBe('ann@old.test → ann@new.test');
    expect(field(card, 'Phone')).toBe('(512) 555-0142 → none');
    expect(field(card, 'City')).toBe('none → Round Rock');
    expect(field(card, 'Other emails')).toBe('none → ann@work.test');
    expect(field(card, 'Why')).toBe('Ann called with her new details');

    await commit('update_customer', args);
    const [p] = await rows<{
      email: string | null;
      phone_e164: string | null;
      city: string | null;
      source: string | null;
      other_emails: unknown;
    }>(
      admin(),
      sql`select email::text as email, phone_e164, city, source, other_emails from app.people where id = ${people['Ann']}`,
    );
    expect(p).toMatchObject({
      email: 'ann@new.test',
      phone_e164: null,
      city: 'Round Rock',
      source: 'Yard sign',
    });
    expect(p!.other_emails).toEqual([{ email: 'ann@work.test', label: 'Work' }]);
    const [audit] = await rows<{ channel: string; reason: string | null }>(
      admin(),
      sql`select channel, reason from app.audit_logs
          where entity_id = ${people['Ann']} and action = 'person.update' order by created_at desc limit 1`,
    );
    expect(audit).toEqual({ channel: 'assistant', reason: 'Ann called with her new details' });
  });

  it('says so when nothing would change', async () => {
    await expect(
      prepare('update_customer', { personId: people['Ben'], firstName: 'Ben' }),
    ).rejects.toThrow('Nothing would change.');
  });
});

describe('ai_tag_customers', () => {
  it('starts a pass over the whole list with a new tag, reads how it goes, and stops it', async () => {
    const args = {
      instructions: 'Anyone with a heat pump gets Heat pump.',
      newTagNames: ['Heat pump'],
      fixDetails: true,
    };
    const { card } = await prepare('ai_tag_customers', args);
    expect(card.title).toBe('Let the AI go through 3 customers?');
    expect(field(card, 'Tags it may use')).toBe('Heat pump');
    expect(field(card, 'Details')).toMatch(/Also fills in and fixes/);

    const started = await commit('ai_tag_customers', args);
    expect(started.outcome).toBe('Going through 3 customers');
    const status = (await tools().run(
      tool('ai_tagging_status'),
      argsOf('ai_tagging_status', {}),
      ctx(),
    )) as {
      result: { running: { progress: string; tags: string[]; instructions: string } | null };
    };
    expect(status.result.running).toMatchObject({
      progress: '0 of 3',
      tags: ['Heat pump'],
      instructions: 'Anyone with a heat pump gets Heat pump.',
    });

    // One pass at a time, as the screen shows Stop instead of the form while one goes.
    await expect(prepare('ai_tag_customers', args)).rejects.toMatchObject({
      rule: 'contact_ai_running',
    });

    const stop = await prepare('ai_tag_customers', { action: 'stop' });
    expect(stop.card.title).toBe('Stop the AI going through your customers?');
    expect((await commit('ai_tag_customers', { action: 'stop' })).outcome).toBe(
      'Stopped after 0 of 3',
    );
    const [sweep] = await rows<{ status: string; cancelled_by: string | null }>(
      admin(),
      sql`select status, cancelled_by from app.contact_ai_sweeps where workspace_id = ${workspaceId}`,
    );
    expect(sweep).toEqual({ status: 'cancelled', cancelled_by: owner.id });
  });

  it('reads the latest 15 changes, as Settings → Tags lists them, and says where the older ones are', async () => {
    const status = async () =>
      (
        (await tools().run(tool('ai_tagging_status'), argsOf('ai_tagging_status', {}), ctx())) as {
          result: { latestLooks: { customer: string }[]; more?: boolean; olderChanges?: string };
        }
      ).result;
    // Sixteen changes, a minute apart, as the AI's looks after each message leave them.
    await rows(
      admin(),
      sql`insert into app.contact_ai_reviews (workspace_id, person_id, trigger, outcome, applied, created_at)
          select ${workspaceId}::uuid, ${people['Ann']}::uuid, 'activity', 'changed',
            '{"addTags":[{"name":"VIP","reason":"Asked for the premium plan"}]}'::jsonb,
            now() - make_interval(mins => g)
          from generate_series(1, 16) as g`,
    );
    const read = await status();
    expect(read.latestLooks).toHaveLength(15);
    expect(read.latestLooks[0]!.customer).toContain('Ann');
    expect(read.more).toBe(true);
    expect(read.olderChanges).toContain('read_audit_list');
  });
});

describe('Settings → Tags: manage_tag', () => {
  const tagList = async () =>
    rows<{ id: string; name: string; color: string }>(
      admin(),
      sql`select id, name::text as name, color from app.tags where workspace_id = ${workspaceId} order by name`,
    );
  const tagNamed = async (name: string) => (await tagList()).find((t) => t.name === name);

  it('adds a tag only on Confirm, and turns away a name that’s taken', async () => {
    const args = { action: 'create', name: 'Solar lead', color: '#16A34A' };
    const { card } = await prepare('manage_tag', args);
    expect(card.title).toBe('Add the Solar lead tag');
    expect(field(card, 'Colour')).toBe('#16a34a');
    expect(await tagNamed('Solar lead')).toBeUndefined();

    await commit('manage_tag', args);
    expect(await tagNamed('Solar lead')).toMatchObject({ color: '#16a34a' });

    await expect(prepare('manage_tag', { action: 'create', name: 'vip' })).rejects.toMatchObject({
      rule: 'tag_exists',
      message: expect.stringContaining('There’s already a tag called VIP.'),
    });
  });

  it('renames one, and says which tag and when nothing would change', async () => {
    const solar = (await tagNamed('Solar lead'))!;
    const args = { action: 'change', tagId: solar.id, name: 'Solar' };
    const { card } = await prepare('manage_tag', args);
    expect(card.title).toBe('Change the Solar lead tag');
    expect(field(card, 'Tag')).toBe('Solar');
    expect(field(card, 'Was')).toBe('Solar lead');
    await commit('manage_tag', args);
    expect(await tagNamed('Solar')).toMatchObject({ id: solar.id, color: '#16a34a' });

    await expect(
      prepare('manage_tag', { action: 'change', tagId: solar.id, color: '#16a34a' }),
    ).rejects.toMatchObject({ rule: 'nothing_to_change' });
    await expect(prepare('manage_tag', { action: 'change', name: 'Sun' })).rejects.toThrow(
      'Say which tag',
    );
    await expect(
      prepare('manage_tag', { action: 'change', tagId: solar.id, name: 'VIP' }),
    ).rejects.toMatchObject({ rule: 'tag_exists' });
  });

  it('deletes one only on Confirm, saying who loses it and that it can’t come back', async () => {
    const { tagId } = await run(tagCreate, { workspaceId, name: 'Old list' }, owner);
    await run(
      recordAddTag,
      { workspaceId, recordType: 'person', recordId: people['Ann'], tagId },
      owner,
    );
    const { card } = await prepare('manage_tag', { action: 'delete', tagId });
    expect(card.title).toBe('Delete the Old list tag');
    expect(field(card, 'On')).toBe('1 customer or lead');
    expect(card.warnings[0]).toMatchObject({ kind: 'caution' });
    expect(card.warnings[0]!.text).toContain('can’t be brought back');
    expect(await tagsOn(people['Ann']!)).toContain('Old list');

    const done = await commit('manage_tag', { action: 'delete', tagId });
    expect(done.outcome).toBe('Deleted, and taken off 1 customer or lead');
    expect(await tagNamed('Old list')).toBeUndefined();
    expect(await tagsOn(people['Ann']!)).not.toContain('Old list');
    await expect(prepare('manage_tag', { action: 'delete', tagId })).rejects.toThrow(
      'No tag has that id.',
    );
  });
});

// Last, so the people it adds don't change the counts above.
describe('a customer in full, and the list narrowed', () => {
  it('adds labelled addresses, takes one off, and reads them back with every field of their own', async () => {
    const gate = (
      await run(
        customFieldCreate,
        { workspaceId, entity: 'person', label: 'Gate code', type: 'text' },
        owner,
      )
    ).customFieldId;
    const plan = (
      await run(
        customFieldCreate,
        {
          workspaceId,
          entity: 'person',
          label: 'Plan',
          type: 'choice',
          options: [{ label: 'Gold' }],
        },
        owner,
      )
    ).customFieldId;
    const ben = people['Ben']!;
    const args = {
      personId: ben,
      addOtherAddresses: [
        { line1: '12 Elm St', city: 'Austin', state: 'TX', postalCode: '78701', label: 'Rental' },
        { line1: '9 Oak Ave', city: 'Austin', label: 'Job site' },
      ],
    };
    const { card } = await prepare('update_customer', args);
    expect(field(card, 'Other addresses')).toBe(
      'none → 12 Elm St, Austin, TX 78701 (Rental), 9 Oak Ave, Austin (Job site)',
    );
    await commit('update_customer', args);

    const off = { personId: ben, removeOtherAddresses: ['9 Oak Ave'] };
    expect(field((await prepare('update_customer', off)).card, 'Other addresses')).toBe(
      '12 Elm St, Austin, TX 78701 (Rental), 9 Oak Ave, Austin (Job site) → 12 Elm St, Austin, TX 78701 (Rental)',
    );
    await commit('update_customer', off);
    await expect(
      prepare('update_customer', { personId: ben, removeOtherAddresses: ['1 Nowhere Rd'] }),
    ).rejects.toThrow('isn’t one of their other addresses');

    const { person } = await read('get_customer', { personId: ben });
    expect(person.otherAddresses).toEqual([
      { address: '12 Elm St, Austin, TX 78701', label: 'Rental' },
    ]);
    // Empty ones too, so a gate code nobody has written yet can be filled in by its id.
    expect(person.fields).toEqual([
      { id: gate, name: 'Gate code', type: 'text', value: null },
      {
        id: plan,
        name: 'Plan',
        type: 'choice',
        choices: [{ value: expect.any(String), label: 'Gold' }],
        value: null,
      },
    ]);
    expect(person).toMatchObject({
      callsFromUs: 'Not asked',
      badge: expect.stringMatching(/^Customer since /),
      lookedAfterBy: { main: null, alsoOnIt: [] },
    });
  });

  it('narrows to a company and to who looks after them, saying who is a client and where they are', async () => {
    const acme = (await run(companyCreate, { workspaceId, name: 'Acme Bulk' }, owner)).companyId;
    const dee = (
      await run(
        personCreate,
        {
          workspaceId,
          firstName: 'Dee',
          lastName: 'Bulk',
          companyId: acme,
          ownerUserId: owner.id,
          address: { city: 'Austin' },
        },
        owner,
      )
    ).personId;
    expect((await read('list_customers', { companyId: acme })).customers).toEqual([
      expect.objectContaining({
        id: dee,
        name: 'Dee Bulk',
        client: false,
        openLeads: 0,
        company: { id: acme, name: 'Acme Bulk' },
        town: 'Austin',
      }),
    ]);
    const mine = await read('list_customers', { assignedUserId: owner.id });
    expect(mine.customers.map((c: { id: string }) => c.id)).toEqual([dee]);
    // Nobody here has been worked for or paid yet: all leads, no clients.
    expect((await read('list_customers', { standing: 'client' })).customers).toEqual([]);
    expect(
      (await read('list_customers', { standing: 'lead' })).customers.map(
        (c: { name: string }) => c.name,
      ),
    ).toContain('Dee Bulk');
    expect((await read('list_companies', {})).companies).toEqual([
      expect.objectContaining({ id: acme, name: 'Acme Bulk', people: 1, client: false }),
    ]);
  });
});
