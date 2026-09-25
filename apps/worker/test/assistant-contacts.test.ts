/**
 * The Assistant's customers in bulk (0107), against the real database: many customers at once with their tags;
 * tags on or off many in one go, a new tag made on the way; any detail of a customer changed, added or taken off;
 * and the AI's pass over the whole list started, read and stopped. Every change waits for Confirm, runs as the
 * person "via Assistant", and keeps the reason they gave on its audit row.
 */
import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
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
      'ai_tagging_status',
      'tag_customers',
      'ai_tag_customers',
      'update_customer',
    ])
      expect(executorFor(name), name).toBeTruthy();
    const member = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    expect(member).toEqual(expect.arrayContaining(['list_customers', 'tag_customers']));
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
});
