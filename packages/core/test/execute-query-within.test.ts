/**
 * `executeQueryWithin` (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Add-ons answer searches"): a query run from inside
 * another's handler, as the same person in the same transaction, the way Search everything asks an add-on. The inner
 * query keeps every rule of its own:
 *
 *   - who may run it, its input, and the same business (another one, even the person's own, isn't there);
 *   - its add-on being on, for an owner too;
 *   - its permission for people, skipped under a staff view-as as executeQuery skips it, the Assistant excepted;
 *   - a savepoint, so a refusal leaves the outer query's transaction usable.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAddon } from '../src/addons/manifest';
import { defineAddonQuery } from '../src/addons/server';
import { HfosError } from '../src/errors';
import { defineQuery } from '../src/kernel/define';
import { executeCommand, executeQuery, executeQueryWithin } from '../src/kernel/execute';
import type { QueryDef, RequestMeta } from '../src/kernel/types';
import { organizationCreate, platformViewAsEnd, platformViewAsStart } from '../src/server';
import { admin, human, run } from './calendar-helpers';

const ADDON = 'fxwithin';

const fxwithin = defineAddon({
  id: ADDON,
  name: 'Within Fixture',
  summary: 'A made-up add-on whose look-up runs inside another.',
  description: 'A test fixture.',
  category: 'industry',
  version: '1.0.0',
  dataVersion: 1,
  catalog: { status: 'development', keywords: ['fixture'] },
  capabilities: [
    { id: 'fxwithin.read', label: 'Peek', description: 'Peek.', permission: 'fxwithin.read' },
  ],
  permissions: [
    {
      key: 'fxwithin.read',
      label: 'Peek inside',
      description: 'Its look-up.',
      defaultRoles: ['admin'],
    },
  ],
  billing: { model: 'free' },
});

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** The add-on's look-up: who it reads as, and what row security shows them. */
const peek = defineAddonQuery(fxwithin, {
  name: 'fxwithin.peek',
  description: 'Who it reads as.',
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({ role: z.string(), businesses: z.number().int() }),
  permission: 'fxwithin.read',
  scope: inWorkspace,
  route: false,
  handler: async (ctx) => {
    const [r] = await rows<{ role: string; businesses: number }>(
      ctx.tx,
      sql`select current_user::text as role, (select count(*)::int from app.workspaces) as businesses`,
    );
    return r!;
  },
});

/** A query of core's that runs only for the system, and one asking for the Assistant. */
const forSystem = defineQuery({
  name: 'test.for_system',
  description: 'The system’s alone.',
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({ ok: z.boolean() }),
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  handler: async () => ({ ok: true }),
});
const assistantPeek = defineQuery({
  name: 'test.assistant_peek',
  description: 'Asks for the Assistant.',
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({ ok: z.boolean() }),
  permission: 'assistant.use',
  scope: inWorkspace,
  handler: async () => ({ ok: true }),
});

/** The outer query: runs `inner` for the business it names, and says whether its own transaction still works after. */
const outer = (inner: QueryDef) =>
  defineQuery({
    name: 'test.outer',
    description: 'Runs another query inside it.',
    input: z.object({ workspaceId: z.uuid(), target: z.uuid().optional() }),
    output: z.object({
      inner: z.unknown().nullable(),
      refused: z.string().nullable(),
      stillWorks: z.boolean(),
    }),
    permission: 'workspace.read',
    scope: inWorkspace,
    handler: async (ctx, input) => {
      let inside: unknown = null;
      let refused: string | null = null;
      try {
        inside = await executeQueryWithin(ctx, inner, {
          workspaceId: input.target ?? input.workspaceId,
        });
      } catch (e) {
        if (!(e instanceof HfosError)) throw e;
        refused = e.rule ?? e.code;
      }
      const [r] = await rows<{ ok: boolean }>(ctx.tx, sql`select true as ok`);
      return { inner: inside, refused, stillWorks: !!r?.ok };
    },
  });

const meta = (viewAs?: string): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'test',
  ...(viewAs ? { viewAs } : {}),
});

let owner: TestUser;
let member: TestUser;
let staff: TestUser;
let ws: string;
let other: string;

const ask = (u: TestUser, inner: QueryDef, more: { target?: string } = {}) =>
  executeQuery(testDbs().api.db, outer(inner), { workspaceId: ws, ...more }, human(u), meta());

const setAddon = (state: 'enabled' | 'disabled') =>
  rows(
    admin(),
    sql`update app.addon_installations set state = ${state} where workspace_id = ${ws} and addon_id = ${ADDON}`,
  );

beforeAll(async () => {
  [owner, member, staff] = await Promise.all([
    createTestUser('within-owner'),
    createTestUser('within-member'),
    createTestUser('within-staff'),
  ]);
  ws = (await run(organizationCreate, { businessName: 'Within Plumbing' }, owner)).workspaceId;
  other = (await run(organizationCreate, { businessName: 'Without Plumbing' }, owner)).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify(fxwithin.permissions)}::jsonb)`,
  );
  for (const id of [ws, other])
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${id}, ${ADDON}, 'enabled', '1.0.0')`,
    );
  await rows(
    admin(),
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'agent')
        on conflict (user_id) do update set role = 'agent', status = 'active'`,
  );
}, 60_000);
afterAll(closeTestDbs);

describe('a query run inside another', () => {
  it('runs as the same person under row security, in the same transaction', async () => {
    const a = await ask(owner, peek);
    expect(a.refused).toBeNull();
    expect(a.inner).toMatchObject({ role: 'authenticated' });
    // Row security, as the person: the two businesses they own, no more.
    expect((a.inner as { businesses: number }).businesses).toBe(2);
  });

  it('asks for its permission, and the outer transaction still works after a refusal', async () => {
    expect(await ask(member, peek)).toMatchObject({
      inner: null,
      refused: 'forbidden',
      stillWorks: true,
    });
  });

  it('refuses while its add-on is off, for an owner too', async () => {
    await setAddon('disabled');
    try {
      expect(await ask(owner, peek)).toMatchObject({ refused: 'addon_inactive', stillWorks: true });
    } finally {
      await setAddon('enabled');
    }
  });

  it('is never run for another business, even one of the person’s own', async () => {
    expect(await ask(owner, peek, { target: other })).toMatchObject({
      inner: null,
      refused: 'not_found',
      stillWorks: true,
    });
  });

  it('keeps to who may run it', async () => {
    expect(await ask(owner, forSystem)).toMatchObject({ refused: 'forbidden', stillWorks: true });
  });

  it('skips its permission under a staff view-as, where row security decides, but never opens the Assistant', async () => {
    await executeCommand(
      testDbs().api.db,
      platformViewAsStart,
      { workspaceId: ws, reason: 'Checking an add-on’s look-up inside a search', minutes: 15 },
      human(staff),
      meta(),
    );
    try {
      const viewing = (inner: QueryDef) =>
        executeQuery(testDbs().api.db, outer(inner), { workspaceId: ws }, human(staff), meta());
      expect(await viewing(peek)).toMatchObject({
        inner: { role: 'authenticated' },
        refused: null,
      });
      expect(await viewing(assistantPeek)).toMatchObject({ inner: null, refused: 'not_found' });
      await setAddon('disabled');
      try {
        expect(await viewing(peek)).toMatchObject({ refused: 'addon_inactive' });
      } finally {
        await setAddon('enabled');
      }
    } finally {
      await executeCommand(testDbs().api.db, platformViewAsEnd, {}, human(staff), meta());
    }
  });
});
