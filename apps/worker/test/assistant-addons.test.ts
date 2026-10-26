import { randomInt, randomUUID } from 'node:crypto';
import {
  emptyUsage,
  ScriptedProvider,
  type AiProvider,
  type AiRequest,
  type ScriptRule,
} from '@hfos/ai';
import {
  addonAiToolByName,
  createTokenVerifier,
  defineAddon,
  defineAddonCommand,
  defineAddonQuery,
  executeCommand,
  executeQuery,
  organizationCreate,
  requireHuman,
  type AddonServerModule,
  type AssistantCard,
  type AssistantEvent,
  type Catalog,
  type HumanActor,
  type Permission,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentToAssistant } from './assistant-consent';
import { questionContext } from '../src/assistant/context';
import { CAPABILITIES_NOTE } from '../src/assistant/prompt';
import { ask as runQuestion, type ToolContext } from '../src/assistant/runtime';
import { capabilityTools } from '../src/assistant/tools-addons';
import { command, query } from '../src/assistant/tools-read';
import { createToolExecutor } from '../src/assistant/tools-write';
import type { AddonWorkerModule } from '../src/addons/types';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

/**
 * Add-ons in the Assistant (docs/addon-readiness-audit.md §8), against a made-up add-on and the real database, kernel
 * and routes: an add-on's operations become tools only while it runs and only for people who hold their permission;
 * a tool that wasn't offered is refused and the kernel refuses the operation itself while the add-on is off; a
 * look-up runs as the person, a change that asks first commits through the kernel from its card and is refused once
 * the add-on is turned off; find_capabilities suggests only available add-ons, only to people who can add them, never
 * planned ones; and nothing in the model's arguments can point a call at another business (audit AI-3).
 *
 * The add-on's ids are fresh random letters starting with `fx` on every run: its permissions are registered in the
 * shared local database, so runs never see each other's.
 */

const env = testEnv();
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
const LIVE = `fx${letters(8)}`;
const BOATS = `fx${letters(8)}`;
const MARKET = `fx${letters(8)}`;
const SPA = `fx${letters(8)}`;

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const perm = (key: string) => key as Permission;
const scope = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

// ---------- the made-up add-ons ----------

const pool = defineAddon({
  id: LIVE,
  name: 'Pool Service',
  summary: 'Pool visits, chemical logs and equipment.',
  description: 'A test fixture.',
  category: 'industry',
  version: '1.0.0',
  dataVersion: 1,
  catalog: { status: 'available', keywords: ['pool', 'chlorine', 'visit'] },
  capabilities: [
    {
      id: `${LIVE}.visits`,
      label: 'Pool visits',
      description: 'Weekly pool visits and what was done at each.',
      permission: `${LIVE}.read`,
    },
    {
      id: `${LIVE}.cancel`,
      label: 'Cancelling pool visits',
      description: 'Cancel a pool visit and tell the customer.',
      permission: `${LIVE}.write`,
    },
  ],
  permissions: [
    {
      key: `${LIVE}.read`,
      label: 'See pool visits',
      description: 'Pool visits and their notes.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: `${LIVE}.write`,
      label: 'Change pool visits',
      description: 'Cancel and change pool visits.',
      defaultRoles: ['admin'],
    },
  ],
  ai: { directory: 'pool visits, chemical logs and equipment' },
  billing: { model: 'free' },
});

/** Available, and never installed here: what a manager may be told about. */
const boats = defineAddon({
  id: BOATS,
  name: 'Boat Storage',
  summary: 'Boat slips, storage and winterizing.',
  description: 'A test fixture.',
  category: 'industry',
  version: '1.0.0',
  dataVersion: 1,
  catalog: { status: 'available', keywords: ['boat', 'storage', 'slip', 'marina', 'winterize'] },
  capabilities: [
    {
      id: `${BOATS}.slips`,
      label: 'Boat slips',
      description: 'Track boat storage slips at the marina and who rents each.',
      permission: `${BOATS}.use`,
    },
  ],
  permissions: [
    {
      key: `${BOATS}.use`,
      label: 'Use Boat Storage',
      description: 'Slips and storage.',
      defaultRoles: ['admin', 'member'],
    },
  ],
  billing: { model: 'free' },
});

/** Planned: a promise, never something to add. */
const market = defineAddon({
  id: MARKET,
  name: 'Marina Marketplace',
  summary: 'Rent boats out at the marina.',
  description: 'A test fixture.',
  category: 'industry',
  version: '1.0.0',
  dataVersion: 1,
  catalog: { status: 'planned', keywords: ['boat', 'rental', 'marina', 'marketplace', 'slip'] },
  capabilities: [
    {
      id: `${MARKET}.rentals`,
      label: 'Boat rentals',
      description: 'Rent boats and storage slips out to people at the marina.',
    },
  ],
  permissions: [],
  billing: { model: 'free' },
});

/** A second add-on running beside Pool Service: one question can need both. */
const spa = defineAddon({
  id: SPA,
  name: 'Spa Care',
  summary: 'Hot tub and spa visits.',
  description: 'A test fixture.',
  category: 'industry',
  version: '1.0.0',
  dataVersion: 1,
  catalog: { status: 'available', keywords: ['spa', 'hot tub'] },
  capabilities: [
    {
      id: `${SPA}.visits`,
      label: 'Spa visits',
      description: 'Hot tub and spa visits.',
      permission: `${SPA}.read`,
    },
  ],
  permissions: [
    {
      key: `${SPA}.read`,
      label: 'See spa visits',
      description: 'Spa visits.',
      defaultRoles: ['admin', 'member'],
    },
  ],
  ai: { directory: 'hot tub and spa visits' },
  billing: { model: 'free' },
});

const CATALOG: Catalog = [pool, boats, market, spa];

const listVisits = defineAddonQuery(pool, {
  name: `${LIVE}.visit.list`,
  description: 'Pool visits coming up.',
  input: z.object({ workspaceId: z.uuid(), limit: z.int().min(1).max(10).default(5) }),
  output: z.object({
    workspaceId: z.uuid(),
    askedBy: z.uuid(),
    visits: z.array(z.string()),
  }),
  permission: perm(`${LIVE}.read`),
  scope,
  // Digits in the name: the ledgers take them since 20261013000500 (audit AI-2).
  ai: {
    tool: `${LIVE}_top10_visits`,
    description: 'The next pool visits, up to ten',
    keywords: ['pool schedule'],
  },
  handler: async (ctx, input) => ({
    workspaceId: ctx.scope.workspaceId!,
    askedBy: requireHuman(ctx).userId,
    visits: ['Monday 9:00', 'Tuesday 9:00', 'Wednesday 9:00', 'Thursday 9:00'].slice(
      0,
      input.limit,
    ),
  }),
});

const noteVisit = defineAddonCommand(pool, {
  name: `${LIVE}.visit.note`,
  description: 'Add a note to a pool visit.',
  risk: 1,
  input: z.object({
    workspaceId: z.uuid(),
    visit: z.string().trim().min(1).max(40),
    note: z.string().trim().min(1).max(500),
  }),
  output: z.object({ noted: z.literal(true), workspaceId: z.uuid() }),
  permission: perm(`${LIVE}.read`),
  scope,
  emits: [`${LIVE}.visit.noted`],
  ai: { tool: `${LIVE}_note_visit` },
  handler: async (ctx, input) => {
    await ctx.emit({
      type: `${LIVE}.visit.noted`,
      entityType: 'pool_visit',
      payload: { visit: input.visit, note: input.note },
    });
    return { noted: true as const, workspaceId: ctx.scope.workspaceId! };
  },
});

const cancelVisit = defineAddonCommand(pool, {
  name: `${LIVE}.visit.cancel`,
  description: 'Cancel a pool visit and tell the customer.',
  risk: 2,
  input: z
    .object({
      workspaceId: z.uuid(),
      visit: z.string().trim().min(1).max(40),
      reason: z.string().trim().max(200).optional(),
      tellCustomer: z.boolean().default(true),
    })
    .refine((v) => v.visit.toLowerCase() !== 'yesterday', { error: 'That visit is over.' }),
  output: z.object({ cancelled: z.literal(true) }),
  permission: perm(`${LIVE}.write`),
  scope,
  emits: [`${LIVE}.visit.cancelled`],
  ai: { tool: `${LIVE}_cancel_visit` },
  handler: async (ctx, input) => {
    await ctx.emit({
      type: `${LIVE}.visit.cancelled`,
      entityType: 'pool_visit',
      payload: { visit: input.visit, reason: input.reason ?? null },
    });
    return { cancelled: true as const };
  },
});

/** Risk 4: never the AI's, whatever it says. */
const wipeVisits = defineAddonCommand(pool, {
  name: `${LIVE}.visit.wipe`,
  description: 'Delete every pool visit.',
  risk: 4,
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({}),
  permission: perm(`${LIVE}.write`),
  scope,
  emits: [],
  ai: { tool: `${LIVE}_wipe_visits` },
  handler: async () => ({}),
});

const spaVisits = defineAddonQuery(spa, {
  name: `${SPA}.visit.list`,
  description: 'Spa visits coming up.',
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({ visits: z.array(z.string()) }),
  permission: `${SPA}.read`,
  scope,
  ai: { tool: `${SPA}_spa_visits`, description: 'The next spa visits' },
  handler: async () => ({ visits: ['Friday 14:00'] }),
});

const MODULES: readonly AddonServerModule[] = [
  { manifest: pool, queries: [listVisits], commands: [noteVisit, cancelVisit, wipeVisits] },
  { manifest: spa, queries: [spaVisits] },
];

// ---------- the stand-in model ----------

const said = (tool: string) => (_q: string, r: Readonly<Record<string, string>>) =>
  r[tool] ?? 'nothing';
let wsB = '';
const rules: ScriptRule[] = [
  {
    when: /^what pool visits are coming/i,
    calls: () => [{ name: `${LIVE}_top10_visits`, arguments: { limit: 3 } }],
    reply: said(`${LIVE}_top10_visits`),
  },
  {
    // A model that names another business the person also works in.
    when: /^what pool visits does the other business have/i,
    calls: () => [{ name: `${LIVE}_top10_visits`, arguments: { limit: 2, workspaceId: wsB } }],
    reply: said(`${LIVE}_top10_visits`),
  },
  {
    when: /^note on (\S+): (.+)$/i,
    calls: (q) => {
      const [, visit, note] = /^note on (\S+): (.+)$/i.exec(q)!;
      return [{ name: `${LIVE}_note_visit`, arguments: { visit, note, workspaceId: wsB } }];
    },
    reply: said(`${LIVE}_note_visit`),
  },
  {
    when: /^cancel the (\S+) visit/i,
    calls: (q) => [
      {
        name: `${LIVE}_cancel_visit`,
        arguments: { visit: /^cancel the (\S+) visit/i.exec(q)![1], reason: 'Rain all day' },
      },
    ],
    reply: said(`${LIVE}_cancel_visit`),
  },
  {
    when: /^wipe every pool visit/i,
    calls: () => [{ name: `${LIVE}_wipe_visits`, arguments: {} }],
    reply: said(`${LIVE}_wipe_visits`),
  },
  {
    when: /^can we keep track of boat storage/i,
    calls: (q) => [{ name: 'find_capabilities', arguments: { need: q } }],
    reply: said('find_capabilities'),
  },
  {
    when: /^what is coming for boat rentals/i,
    calls: () => [
      {
        name: 'find_capabilities',
        arguments: { need: 'boat rentals at the marina', includePlanned: true },
      },
    ],
    reply: said('find_capabilities'),
  },
  {
    // One question, two add-ons: the model calls a tool of each in the same turn.
    when: /^what is on for pools and spas/i,
    calls: () => [
      { name: `${LIVE}_top10_visits`, arguments: { limit: 2 } },
      { name: `${SPA}_spa_visits`, arguments: {} },
    ],
    reply: (_q, r) =>
      JSON.stringify({
        pool: JSON.parse(r[`${LIVE}_top10_visits`] ?? 'null'),
        spa: JSON.parse(r[`${SPA}_spa_visits`] ?? 'null'),
      }),
  },
  { when: /^how many new leads/i, reply: () => 'Three new leads came in this week.' },
];

// ---------- the business ----------

let owner: TestUser;
let member: TestUser;
let ownerToken: string;
let memberToken: string;
let wsA: string;
let orgA: string;
let app: FastifyInstance;

const register = (addon: string, permissions: unknown[]) =>
  rows(
    admin(),
    sql`select private.register_addon_permissions(${addon}, ${JSON.stringify(permissions)}::jsonb)`,
  );
/** Where an add-on stands in a business, set the way the lifecycle commands and the worker leave it. */
async function setAddonState(
  ws: string,
  addonId: string,
  state: 'enabled' | 'disabled' | 'uninstalled',
) {
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, ${addonId}, ${state}, '1.0.0')
        on conflict (workspace_id, addon_id) do update set state = excluded.state`,
  );
}
/** Where Pool Service stands. */
const setState = (ws: string, state: 'enabled' | 'disabled' | 'uninstalled') =>
  setAddonState(ws, LIVE, state);

function build(provider: AiProvider = new ScriptedProvider(rules)): Promise<FastifyInstance> {
  const httpDb = testDbs().worker.db;
  return buildHttpServer({
    ...testServices(),
    httpDb,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    assistant: {
      provider,
      tools: createToolExecutor(httpDb, null, null, '', CATALOG),
      dailyTokens: 5_000_000,
      addons: MODULES,
      addonCatalog: CATALOG,
    },
  });
}

/** Asks one question over HTTP and returns the events it streamed. */
async function ask(token: string, text: string): Promise<AssistantEvent[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: wsA, text },
  });
  expect(res.statusCode).toBe(200);
  return res.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
}
const textOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
/** The stand-in model says the tool's result back word for word. */
const resultOf = <T = Record<string, unknown>>(events: AssistantEvent[]) =>
  JSON.parse(textOf(events)) as T;
const runOf = (events: AssistantEvent[]) => {
  const first = events[0];
  if (first?.type !== 'run') throw new Error(`No run: ${JSON.stringify(events)}`);
  return first.runId;
};
const confirmCard = (events: AssistantEvent[]) => {
  const card = events.flatMap((e) => (e.type === 'card' ? [e.card] : []))[0];
  if (card?.type !== 'confirm') throw new Error(`No card. The answer: ${textOf(events)}`);
  return card as Extract<AssistantCard, { type: 'confirm' }>;
};
const decide = (id: string, action: 'confirm' | 'cancel') =>
  app.inject({
    method: 'POST',
    url: `/v1/assistant/tool-calls/${id}/${action}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { workspaceId: wsA },
  });
const callsIn = (runId: string) =>
  rows<{ tool: string; status: string; autonomy: string; arguments: Record<string, unknown> }>(
    admin(),
    sql`select tool, status, autonomy::text as autonomy, arguments from app.assistant_tool_calls
        where run_id = ${runId} order by created_at`,
  );
const events = (ws: string, type: string) =>
  rows<{ payload: Record<string, unknown>; addon_id: string | null }>(
    admin(),
    sql`select payload, addon_id from app.events where workspace_id = ${ws} and event_type = ${type}
        order by occurred_at`,
  );
const toolCtx = (u: TestUser): ToolContext => ({
  actor: actor(u),
  workspaceId: wsA,
  organizationId: orgA,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});
/** The add-on's tools this person would be offered in business A now. */
async function offeredTo(u: TestUser): Promise<string[]> {
  const context = await questionContext(
    testDbs().worker.db,
    actor(u),
    wsA,
    null,
    randomUUID(),
    new Date(),
    { modules: MODULES, catalog: CATALOG },
  );
  return context.tools.map((t) => t.name).filter((n) => n.startsWith(`${LIVE}_`));
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('aaddon-dale', { fullName: 'Dale Owner' }),
    createTestUser('aaddon-marco', { fullName: 'Marco Member' }),
  ]);
  await consentToAssistant(owner, member);
  const a = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Add-on Pools A', timezone: 'America/Chicago' },
    actor(owner),
    meta(),
  );
  wsA = a.output.workspaceId;
  orgA = a.output.organizationId;
  // Dale runs a second business too: the one a model's arguments must never reach.
  const b = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Add-on Pools B', timezone: 'America/Chicago' },
    actor(owner),
    meta(),
  );
  wsB = b.output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsA}, ${member.id}, 'member')`,
  );
  await register(LIVE, [
    { key: `${LIVE}.read`, defaultRoles: ['admin', 'member'], requires: [] },
    { key: `${LIVE}.write`, defaultRoles: ['admin'], requires: [`${LIVE}.read`] },
  ]);
  await register(SPA, [{ key: `${SPA}.read`, defaultRoles: ['admin', 'member'], requires: [] }]);
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  app = await build();
}, 60_000);
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('which add-on tools the Assistant offers', () => {
  it('only while the add-on runs, and only what each person’s permissions allow', async () => {
    // Never installed: nothing.
    expect(await offeredTo(owner)).toEqual([]);
    await setState(wsA, 'enabled');
    // Risk 4 is never offered; the rest in the module's order.
    expect(await offeredTo(owner)).toEqual([
      `${LIVE}_top10_visits`,
      `${LIVE}_note_visit`,
      `${LIVE}_cancel_visit`,
    ]);
    // Marco can see visits but not change them.
    expect(await offeredTo(member)).toEqual([`${LIVE}_top10_visits`, `${LIVE}_note_visit`]);
    await setState(wsA, 'disabled');
    expect(await offeredTo(owner)).toEqual([]);
    expect(await offeredTo(member)).toEqual([]);
    await setState(wsA, 'uninstalled');
    expect(await offeredTo(owner)).toEqual([]);
  });

  it('keeps them behind search and out of the fixed instructions, with a line saying what they cover', async () => {
    const sent: AiRequest[] = [];
    const provider: AiProvider = {
      id: 'searches',
      model: 'claude-opus-5-5',
      toolSearch: true,
      stream: async (request) => {
        sent.push(request);
        return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', usage: emptyUsage };
      },
    };
    const db = testDbs().worker.db;
    const askNow = async () => {
      const context = await questionContext(db, actor(owner), wsA, null, randomUUID(), new Date(), {
        modules: MODULES,
        catalog: CATALOG,
      });
      await runQuestion(
        {
          db,
          provider,
          tools: createToolExecutor(db),
          dailyTokens: 5e6,
          log: pino({ level: 'silent' }),
        },
        {
          actor: actor(owner),
          workspaceId: wsA,
          organizationId: orgA,
          text: 'What’s on today?',
          page: null,
          tools: context.tools,
          prompt: context.prompt,
        },
        () => undefined,
        new AbortController().signal,
      );
      return sent.at(-1)!;
    };
    const loaded = (r: AiRequest) => r.tools!.filter((t) => !t.deferred).map((t) => t.name);

    await setState(wsA, 'disabled');
    const off = await askNow();
    await setState(wsA, 'enabled');
    const on = await askNow();

    const mine = on.tools!.filter((t) => t.name.startsWith(`${LIVE}_`));
    expect(mine.map((t) => t.name)).toEqual([
      `${LIVE}_top10_visits`,
      `${LIVE}_note_visit`,
      `${LIVE}_cancel_visit`,
    ]);
    expect(mine.every((t) => t.deferred)).toBe(true);
    expect(mine[0]!.description).toBe(
      'The next pool visits, up to ten. From the Pool Service add-on. Also: pool schedule.',
    );
    // The business's ids are never in what the model can fill in.
    for (const t of mine) expect(JSON.stringify(t.inputSchema)).not.toContain('workspaceId');
    // The tools in view and the fixed instructions are the same with the add-on on as off.
    expect(loaded(on)).toEqual(loaded(off));
    expect(loaded(on)).not.toContain('find_capabilities');
    expect(on.tools!.find((t) => t.name === 'find_capabilities')?.deferred).toBe(true);
    expect(on.system).toBe(off.system);
    expect(on.system).not.toContain('Pool Service');
    // What they cover is in the per-business part, only while they run; the note on capabilities always is.
    expect(on.lasting).toContain(
      `- Pool Service (${LIVE}_…): pool visits, chemical logs and equipment`,
    );
    expect(off.lasting).not.toContain('Pool Service');
    expect(on.lasting).toContain(CAPABILITIES_NOTE);
    expect(off.lasting).toContain(CAPABILITIES_NOTE);
  });
});

describe('running an add-on’s tools', () => {
  it('refuses a tool of an add-on that is off, and so does the kernel', async () => {
    await setState(wsA, 'disabled');
    const asked = await ask(ownerToken, 'What pool visits are coming?');
    // The stand-in model calls it anyway: it wasn't offered, so nothing runs and nothing is recorded.
    expect(resultOf(asked)).toEqual({ error: 'That is not something you can do here.' });
    expect(asked.some((e) => e.type === 'step')).toBe(false);
    expect(await callsIn(runOf(asked))).toEqual([]);
    // Reached any other way, the kernel refuses the add-on's operations while it's off.
    await expect(
      executeQuery(api(), listVisits, { workspaceId: wsA }, actor(owner), meta()),
    ).rejects.toMatchObject({ rule: 'addon_inactive' });
    await expect(
      executeCommand(
        api(),
        noteVisit,
        { workspaceId: wsA, visit: 'Monday', note: 'Gate code' },
        actor(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ rule: 'addon_inactive' });
    // And the executor, handed the tool some other way, says so in plain words.
    const tool = addonAiToolByName(MODULES, `${LIVE}_top10_visits`)!;
    await expect(
      createToolExecutor(testDbs().worker.db).run(tool, { limit: 2 }, toolCtx(owner)),
    ).rejects.toMatchObject({
      rule: 'addon_inactive',
      message:
        'Pool Service is turned off for this business, so nothing was done. An owner or admin can turn it back on in Settings → Add-ons.',
    });
  });

  it('never runs a tool too risky for the AI, even when the model asks for it', async () => {
    await setState(wsA, 'enabled');
    const asked = await ask(ownerToken, 'Wipe every pool visit');
    expect(resultOf(asked)).toEqual({ error: 'That is not something you can do here.' });
    expect(await callsIn(runOf(asked))).toEqual([]);
  });

  it('can be recorded in both AI ledgers, digits and all (audit AI-2)', async () => {
    // The Assistant's ledger takes one for real below; the AI teammate's is held to the same check.
    expect(
      await rows<{ ledger: string; check: string }>(
        admin(),
        sql`select conrelid::regclass::text as ledger, pg_get_constraintdef(oid) as check from pg_constraint
            where conname in ('assistant_tool_calls_tool_check', 'ai_teammate_tool_calls_tool_check')
            order by 1`,
      ),
    ).toEqual([
      {
        ledger: 'app.ai_teammate_tool_calls',
        check: "CHECK ((tool ~ '^[a-z][a-z0-9_]{0,63}$'::text))",
      },
      {
        ledger: 'app.assistant_tool_calls',
        check: "CHECK ((tool ~ '^[a-z][a-z0-9_]{0,63}$'::text))",
      },
    ]);
  });

  it('runs a look-up on its own, as the person, and records it under its name', async () => {
    await setState(wsA, 'enabled');
    const asked = await ask(memberToken, 'What pool visits are coming?');
    expect(resultOf(asked)).toEqual({
      from: 'Pool Service',
      data: {
        workspaceId: wsA,
        askedBy: member.id,
        visits: ['Monday 9:00', 'Tuesday 9:00', 'Wednesday 9:00'],
      },
    });
    expect(asked).toContainEqual(
      expect.objectContaining({ type: 'step', label: 'Looking in Pool Service', status: 'done' }),
    );
    expect(await callsIn(runOf(asked))).toEqual([
      { tool: `${LIVE}_top10_visits`, status: 'done', autonomy: 'auto', arguments: { limit: 3 } },
    ]);
  });

  it('makes a note on its own, as the person, marked as the Assistant’s and the add-on’s', async () => {
    await setState(wsA, 'enabled');
    await setState(wsB, 'enabled');
    const asked = await ask(ownerToken, 'Note on Monday: gate code 1234');
    expect(resultOf(asked)).toEqual({
      done: true,
      from: 'Pool Service',
      data: { noted: true, workspaceId: wsA },
    });
    const [noted] = await events(wsA, `${LIVE}.visit.noted`);
    expect(noted).toMatchObject({
      addon_id: LIVE,
      payload: {
        visit: 'Monday',
        note: 'gate code 1234',
        _addon: { id: LIVE, name: 'Pool Service' },
      },
    });
    // The workspaceId the model wrote went nowhere.
    expect(await events(wsB, `${LIVE}.visit.noted`)).toEqual([]);
    expect((await callsIn(runOf(asked)))[0]).toMatchObject({
      status: 'done',
      arguments: { visit: 'Monday', note: 'gate code 1234' },
    });
    const [audit] = await rows<{ actor_id: string; channel: string; addon_id: string }>(
      admin(),
      sql`select actor_id, channel, addon_id from app.audit_logs
          where workspace_id = ${wsA} and action = ${`${LIVE}.visit.note`}`,
    );
    expect(audit).toEqual({ actor_id: owner.id, channel: 'assistant', addon_id: LIVE });
    await setState(wsB, 'disabled');
  });

  it('asks first for a change that reaches customers, and does it through the kernel on Confirm', async () => {
    await setState(wsA, 'enabled');
    const asked = await ask(ownerToken, 'Cancel the Tuesday visit');
    const card = confirmCard(asked);
    expect(card).toMatchObject({
      tool: `${LIVE}_cancel_visit`,
      title: 'Do this in Pool Service?',
      confirmLabel: 'Confirm',
      fields: [
        { label: 'What', value: 'Cancel a pool visit and tell the customer.' },
        { label: 'Visit', value: 'Tuesday' },
        { label: 'Reason', value: 'Rain all day' },
        { label: 'Tell customer', value: 'Yes' },
      ],
    });
    expect(resultOf(asked)).toMatchObject({
      status: 'waiting_for_the_person_to_confirm',
      addon: 'Pool Service',
    });
    // Nothing has happened yet.
    expect(await events(wsA, `${LIVE}.visit.cancelled`)).toEqual([]);

    const ok = await decide(card.toolCallId, 'confirm');
    expect(ok.json()).toMatchObject({ status: 'confirmed', outcome: 'Done in Pool Service' });
    expect(await events(wsA, `${LIVE}.visit.cancelled`)).toEqual([
      expect.objectContaining({
        addon_id: LIVE,
        payload: expect.objectContaining({ visit: 'Tuesday', reason: 'Rain all day' }),
      }),
    ]);
    const [audit] = await rows<{ actor_id: string; channel: string }>(
      admin(),
      sql`select actor_id, channel from app.audit_logs
          where workspace_id = ${wsA} and action = ${`${LIVE}.visit.cancel`}`,
    );
    expect(audit).toEqual({ actor_id: owner.id, channel: 'assistant' });
    expect((await decide(card.toolCallId, 'confirm')).statusCode).toBe(409);
  });

  it('refuses a card confirmed after the add-on was turned off, and says why', async () => {
    await setState(wsA, 'enabled');
    const card = confirmCard(await ask(ownerToken, 'Cancel the Wednesday visit'));
    await setState(wsA, 'disabled');
    const refused = await decide(card.toolCallId, 'confirm');
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({
      status: 'failed',
      error:
        'Pool Service is turned off for this business, so nothing was done. An owner or admin can turn it back on in Settings → Add-ons.',
    });
    expect(
      (await events(wsA, `${LIVE}.visit.cancelled`)).filter(
        (e) => e.payload['visit'] === 'Wednesday',
      ),
    ).toEqual([]);
    const [row] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.assistant_tool_calls where id = ${card.toolCallId}`,
    );
    expect(row?.status).toBe('failed');
  });

  it('never draws a card the operation’s own rules would refuse', async () => {
    await setState(wsA, 'enabled');
    const asked = await ask(ownerToken, 'Cancel the yesterday visit');
    expect(asked.some((e) => e.type === 'card')).toBe(false);
    expect(resultOf(asked)).toMatchObject({ error: 'That visit is over.' });
    expect((await callsIn(runOf(asked))).at(-1)).toMatchObject({
      tool: `${LIVE}_cancel_visit`,
      status: 'failed',
    });
    expect(
      (await events(wsA, `${LIVE}.visit.cancelled`)).filter(
        (e) => e.payload['visit'] === 'yesterday',
      ),
    ).toEqual([]);
  });
});

describe('find_capabilities', () => {
  type Found = {
    current: { label: string; from: string }[];
    restricted: { label: string }[];
    turnedOff: { label: string; from: string }[];
    suggestions: { addonId: string; name: string; available: boolean }[];
    planned?: { addonId: string; name: string; available: boolean }[];
    say: Record<string, string>;
  };

  it('suggests an available add-on to someone who can add it, for a need nothing here meets', async () => {
    await setState(wsA, 'enabled');
    const asked = await ask(ownerToken, 'Can we keep track of boat storage slips at the marina?');
    const found = resultOf<Found>(asked);
    expect(found.suggestions).toEqual([
      expect.objectContaining({ addonId: BOATS, name: 'Boat Storage', available: true }),
    ]);
    // Planned is never suggested, and not even listed unless asked for.
    expect(found.planned).toBeUndefined();
    expect(found.current.map((c) => c.from)).toContain('Pool Service');
    expect(await callsIn(runOf(asked))).toEqual([
      expect.objectContaining({ tool: 'find_capabilities', status: 'done', autonomy: 'auto' }),
    ]);
  });

  it('lists what is planned only when asked, and never as something to add', async () => {
    const found = resultOf<Found>(await ask(ownerToken, 'What is coming for boat rentals?'));
    expect(found.planned).toEqual([
      expect.objectContaining({ addonId: MARKET, name: 'Marina Marketplace', available: false }),
    ]);
    expect(found.suggestions.map((s) => s.addonId)).not.toContain(MARKET);
    expect(found.say['planned']).toMatch(/never that they can add it/);
  });

  it('never pitches an add-on to someone who can’t add one, and tells them what an admin can do', async () => {
    await setState(wsA, 'enabled');
    const found = resultOf<Found>(
      await ask(memberToken, 'Can we keep track of boat storage slips at the marina?'),
    );
    expect(found.suggestions).toEqual([]);
    expect(found.restricted.map((c) => c.label)).toContain('Cancelling pool visits');
    expect(found.say['restricted']).toMatch(/owner or admin can give them access/);
    expect(
      resultOf<Found>(await ask(memberToken, 'What is coming for boat rentals?')).planned,
    ).toBeUndefined();
  });

  it('says a turned-off add-on can be turned back on, and suggests nothing for an ordinary question', async () => {
    await setState(wsA, 'disabled');
    const ctx = toolCtx(owner);
    const db = testDbs().worker.db;
    const off = (await capabilityTools.find_capabilities!(db, ctx, {}, CATALOG)).result as Found;
    expect(off.turnedOff.map((c) => c.label)).toEqual(['Pool visits', 'Cancelling pool visits']);
    expect(off.say['turnedOff']).toMatch(/turn it back on/);
    expect(off.suggestions).toEqual([]);
    // Something HandsFreeOS already does is no gap, so nothing is suggested.
    const ordinary = (
      await capabilityTools.find_capabilities!(
        db,
        ctx,
        { need: 'text a customer back about their appointment' },
        CATALOG,
      )
    ).result as Found;
    expect(ordinary.suggestions).toEqual([]);
    // An ordinary question doesn't go looking at all.
    const asked = await ask(ownerToken, 'How many new leads came in this week?');
    expect(textOf(asked)).toBe('Three new leads came in this week.');
    expect(textOf(asked)).not.toMatch(/Boat Storage|add-on/);
    expect(await callsIn(runOf(asked))).toEqual([]);
  });
});

describe('the business a call is for (audit AI-3)', () => {
  it('can’t be changed by a workspaceId in a look-up or a command’s input', async () => {
    const db = testDbs().worker.db;
    const ctx = toolCtx(owner);
    const { workspace } = await query<{ workspace: { id: string } }>(db, ctx, 'workspace.get', {
      workspaceId: wsB,
    });
    expect(workspace.id).toBe(wsA);
    const { taskId } = await command<{ taskId: string }>(db, ctx, 'task.create', {
      workspaceId: wsB,
      title: 'Check the pool filter',
    });
    const [task] = await rows<{ workspace_id: string }>(
      admin(),
      sql`select workspace_id from app.tasks where id = ${taskId}`,
    );
    expect(task?.workspace_id).toBe(wsA);
  });

  it('can’t be changed by a workspaceId the model writes into an add-on tool’s arguments', async () => {
    await setState(wsA, 'enabled');
    // On in both of Dale's businesses, so a call that reached B would work there.
    await setState(wsB, 'enabled');
    const asked = await ask(ownerToken, 'What pool visits does the other business have?');
    expect(resultOf(asked)).toMatchObject({ data: { workspaceId: wsA, askedBy: owner.id } });
    // What was recorded is what the tool declares: the business's id was never the model's.
    expect((await callsIn(runOf(asked)))[0]?.arguments).toEqual({ limit: 2 });
    await setState(wsB, 'disabled');
  });
});

describe('a task across two add-ons', () => {
  it('uses each one’s tools in one answer, and loses only the one turned off', async () => {
    await setState(wsA, 'enabled');
    await setAddonState(wsA, SPA, 'enabled');
    const both = await ask(memberToken, 'What is on for pools and spas this week?');
    expect(resultOf(both)).toEqual({
      pool: {
        from: 'Pool Service',
        data: { workspaceId: wsA, askedBy: member.id, visits: ['Monday 9:00', 'Tuesday 9:00'] },
      },
      spa: { from: 'Spa Care', data: { visits: ['Friday 14:00'] } },
    });
    expect((await callsIn(runOf(both))).map((c) => [c.tool, c.status])).toEqual([
      [`${LIVE}_top10_visits`, 'done'],
      [`${SPA}_spa_visits`, 'done'],
    ]);

    // Spa Care turned off: the same question still gets its pool visits, and nothing of the spa's runs.
    await setAddonState(wsA, SPA, 'disabled');
    const one = await ask(memberToken, 'What is on for pools and spas this week?');
    expect(resultOf(one)).toEqual({
      pool: {
        from: 'Pool Service',
        data: { workspaceId: wsA, askedBy: member.id, visits: ['Monday 9:00', 'Tuesday 9:00'] },
      },
      spa: { error: 'That is not something you can do here.' },
    });
    expect((await callsIn(runOf(one))).map((c) => c.tool)).toEqual([`${LIVE}_top10_visits`]);
  });
});

describe('an add-on’s worker actions', () => {
  /** What Pool Service's made-up worker actions did, and for whom. */
  const did: { action: string; userId: string; input: unknown }[] = [];
  const poolWorker: AddonWorkerModule = {
    manifest: pool,
    actions: {
      [`${LIVE}.visits.plan`]: {
        permission: `${LIVE}.read`,
        input: z.object({ weeks: z.int().min(1).max(8).default(2) }),
        async run(ctx, input: { weeks: number }) {
          did.push({ action: 'plan', userId: ctx.userId, input });
          return { planned: input.weeks, addon: ctx.actor.addon?.id ?? null };
        },
        ai: {
          tool: `${LIVE}_plan_visits`,
          description: 'Plan the next pool visits.',
          autonomy: 'auto',
        },
      },
      [`${LIVE}.owner.text`]: {
        permission: `${LIVE}.write`,
        input: z.object({ text: z.string().min(1).max(160) }),
        async run(ctx, input: { text: string }) {
          did.push({ action: 'text', userId: ctx.userId, input });
          return { texted: true };
        },
        ai: {
          tool: `${LIVE}_text_owner`,
          description: 'Text the pool’s owner. Asks the person first.',
          autonomy: 'confirm',
        },
      },
      // What only its browser extension asks for: never a tool.
      [`${LIVE}.page.read`]: {
        permission: `${LIVE}.read`,
        input: z.object({}),
        run: async () => ({}),
      },
    },
  };
  const WORKERS = [poolWorker];
  const actionRules: ScriptRule[] = [
    {
      when: /plan the pool visits/i,
      calls: () => [
        // The business's id in the arguments goes nowhere: the door puts this one on.
        { name: `${LIVE}_plan_visits`, arguments: { weeks: 3, workspaceId: wsB } },
      ],
      reply: (_q, r) => r[`${LIVE}_plan_visits`] ?? 'null',
    },
    {
      when: /text the pool owner/i,
      calls: () => [{ name: `${LIVE}_text_owner`, arguments: { text: 'We’re on our way.' } }],
      reply: () => 'Ready for your OK.',
    },
  ];
  const services = testServices();
  let server: FastifyInstance;
  const buildWithActions = () => {
    const httpDb = testDbs().worker.db;
    return buildHttpServer({
      ...services,
      httpDb,
      verifyToken: createTokenVerifier({
        jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
        jwtIssuer: `${env.supabaseUrl}/auth/v1`,
      }),
      webOrigins: ['http://localhost:3000'],
      assistant: {
        provider: new ScriptedProvider(actionRules),
        tools: createToolExecutor(httpDb, null, null, '', CATALOG, { services }),
        dailyTokens: 5_000_000,
        addons: MODULES,
        addonCatalog: CATALOG,
        workerAddons: WORKERS,
      },
    });
  };
  const askActions = async (token: string, text: string) => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/assistant/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { workspaceId: wsA, text },
    });
    expect(res.statusCode).toBe(200);
    return res.body
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
  };
  const offered = async (u: TestUser) =>
    (
      await questionContext(testDbs().worker.db, actor(u), wsA, null, randomUUID(), new Date(), {
        modules: MODULES,
        catalog: CATALOG,
        workerModules: WORKERS,
      })
    ).tools
      .map((t) => t.name)
      .filter((n) => n === `${LIVE}_plan_visits` || n === `${LIVE}_text_owner`);

  beforeAll(async () => {
    server = await buildWithActions();
  });
  afterAll(async () => {
    await server?.close();
  });

  it('are tools only while the add-on runs, and only for people who hold their permission', async () => {
    await setState(wsA, 'disabled');
    expect(await offered(owner)).toEqual([]);
    await setState(wsA, 'enabled');
    expect(await offered(owner)).toEqual([`${LIVE}_plan_visits`, `${LIVE}_text_owner`]);
    // Marco can see pool visits but not change them.
    expect(await offered(member)).toEqual([`${LIVE}_plan_visits`]);
  });

  it('runs one that may go on its own through the add-on’s door, for the person, in their business', async () => {
    await setState(wsA, 'enabled');
    did.length = 0;
    const events = await askActions(ownerToken, 'Plan the pool visits');
    const said = JSON.parse(textOf(events)) as { from: string; data: Record<string, unknown> };
    expect(said).toEqual({ from: 'Pool Service', data: { planned: 3, addon: LIVE } });
    expect(did).toEqual([{ action: 'plan', userId: owner.id, input: { weeks: 3 } }]);
    expect((await callsIn(runOf(events))).map((c) => [c.tool, c.status])).toEqual([
      [`${LIVE}_plan_visits`, 'done'],
    ]);
  });

  it('asks first for one that reaches people, does it on Confirm, and refuses once the add-on is off', async () => {
    await setState(wsA, 'enabled');
    did.length = 0;
    const first = await askActions(ownerToken, 'Text the pool owner');
    const card = confirmCard(first);
    expect(did).toEqual([]);
    const confirm = (id: string) =>
      server.inject({
        method: 'POST',
        url: `/v1/assistant/tool-calls/${id}/confirm`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId: wsA },
      });
    expect((await confirm(card.toolCallId)).json()).toMatchObject({ status: 'confirmed' });
    expect(did).toEqual([
      { action: 'text', userId: owner.id, input: { text: 'We’re on our way.' } },
    ]);

    const second = confirmCard(await askActions(ownerToken, 'Text the pool owner'));
    await setState(wsA, 'disabled');
    const refused = (await confirm(second.toolCallId)).json() as { status: string; error: string };
    expect(refused.status).toBe('failed');
    expect(refused.error).toContain('Pool Service is turned off for this business');
    expect(did).toHaveLength(1);
    await setState(wsA, 'enabled');
  });
});
