/**
 * Add-ons through the kernel (0108): businesses installing, turning off, uninstalling and deleting the data of the
 * made-up add-ons in ./addons/fixtures.ts, and the add-on check that refuses an add-on's work, for every kind of
 * actor, while it isn't on.
 *
 * - Business A has no add-ons, B has three, C has thirteen (the twelve plus Rent Collection), and D has C's with
 *   different permissions for its members.
 * - The worker's half (seeding kinds of records, cancelling work, letting go of what an add-on holds, purging) is
 *   apps/worker/test/addons.test.ts. Here a move that takes time is finished the way the worker finishes it: one
 *   update, straight in the database.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HfosError } from '../src/errors';
import {
  addonLifecycleCommands,
  addonQueries,
  defineAddon,
  defineAddonCommand,
  defineAddonQuery,
  defineCommand,
  executeCommand,
  executeCommandWithin,
  executeQuery,
  organizationCreate,
  permissionSetRole,
  workspaceCreate,
  type Actor,
  type AiEmployeeActor,
  type Catalog,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type SystemActor,
  type WorkflowActor,
} from '../src/server';
import { FIXTURE_CATALOG, TWELVE, fxprop, fxsocial } from './addons/fixtures';

/** People go through the API's connection; the system, workflows and the AI teammate through the worker's. */
const dbFor = (actor: Actor) => (actor.type === 'human' ? testDbs().api.db : testDbs().worker.db);
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

const cmds = addonLifecycleCommands(FIXTURE_CATALOG);
const queries = addonQueries(FIXTURE_CATALOG);

const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  actor: Actor,
) => executeCommand(dbFor(actor), cmd, input, actor, meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  actor: Actor,
) => executeQuery(dbFor(actor), q, input, actor, meta());

/** What a refusal says, to compare whole. */
async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HfosError)) throw e;
    return {
      code: e.code,
      status: e.status,
      rule: e.rule ?? null,
      disposition: e.disposition,
      details: e.details ?? null,
    };
  }
  throw new Error('expected a refusal');
}

/** The worker's finishing moves, as it makes them. */
const finish = (ws: string) =>
  rows(
    admin(),
    sql`update app.addon_installations set state = case state
          when 'installing' then 'enabled' when 'uninstalling' then 'uninstalled' when 'purging' then 'purged'
          else state end
        where workspace_id = ${ws}`,
  );

const stateOf = async (ws: string, addonId: string) =>
  (
    await rows<{
      state: string;
      generation: number;
      installed_version: string;
      data_version: number;
    }>(
      admin(),
      sql`select state, generation, installed_version, data_version from app.addon_installations
          where workspace_id = ${ws} and addon_id = ${addonId}`,
    )
  )[0] ?? null;

const permissionsOf = async (u: TestUser, ws: string) =>
  (
    await rows<{ p: string[] }>(
      admin(),
      sql`select private.user_permissions(${u.id}::uuid, ${ws}::uuid) as p`,
    )
  )[0]!.p;

let owner: TestUser;
let adminUser: TestUser;
let member: TestUser;
let outsider: TestUser;
let orgId: string;
let wsA: string;
let wsB: string;
let wsC: string;
let wsD: string;

beforeAll(async () => {
  [owner, adminUser, member, outsider] = await Promise.all([
    createTestUser('addon-life-owner'),
    createTestUser('addon-life-admin'),
    createTestUser('addon-life-member'),
    createTestUser('addon-life-outsider'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Add-on Lifecycle A' }, human(owner));
  orgId = org.organizationId;
  wsA = org.workspaceId;
  const more: string[] = [];
  for (const name of ['Add-on Lifecycle B', 'Add-on Lifecycle C', 'Add-on Lifecycle D']) {
    const made = await run(
      workspaceCreate,
      { organizationId: orgId, name, joinAsOwner: true },
      human(owner),
    );
    more.push(made.workspaceId);
  }
  [wsB, wsC, wsD] = more as [string, string, string];
  for (const ws of [wsA, wsB, wsC, wsD])
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${ws}, ${adminUser.id}, 'admin'), (${ws}, ${member.id}, 'member')`,
    );
  // Each fixture's permissions, as its migration would declare them (idempotent; shared by every test run).
  for (const m of FIXTURE_CATALOG)
    if (m.permissions.length > 0)
      await rows(
        admin(),
        sql`select private.register_addon_permissions(${m.id}, ${JSON.stringify(m.permissions)}::jsonb)`,
      );
}, 60_000);

afterAll(closeTestDbs);

describe('a business with no add-ons (A)', () => {
  it('has core and nothing else, and only people who manage add-ons hear what could be added', async () => {
    const mine = await ask(queries.list, { workspaceId: wsA }, human(owner));
    expect(mine.installed).toEqual([]);
    expect(mine.capabilities.current.every((c) => c.provider === 'core')).toBe(true);
    expect(mine.capabilities.current.map((c) => c.id)).toContain('crm.contacts');
    const installable = mine.capabilities.installable.map((c) => c.provider);
    expect(installable).toContain('fxprop');
    // Never planned, beta, paid or deprecated ones.
    for (const id of ['fxinflu', 'fxbeta', 'fxpaid', 'fxold'])
      expect(installable).not.toContain(id);
    expect(mine.capabilities.planned.map((c) => c.provider)).toEqual(['fxinflu']);
    expect(mine.catalog.map((c) => c.status)).not.toContain('beta');

    const theirs = await ask(queries.list, { workspaceId: wsA }, human(member));
    expect(theirs.capabilities.installable).toEqual([]);
    expect(theirs.capabilities.planned).toEqual([]);
    expect(theirs.catalog).toEqual([]);
  });

  it('is invisible to someone outside it', async () => {
    expect(await refusal(ask(queries.list, { workspaceId: wsA }, human(outsider)))).toMatchObject({
      status: 404,
    });
    expect(
      await refusal(run(cmds.install, { workspaceId: wsA, addonId: 'fxseo' }, human(outsider))),
    ).toMatchObject({ status: 404 });
  });
});

describe('installing (B)', () => {
  it('is for owners and admins, not members', async () => {
    expect(
      await refusal(run(cmds.install, { workspaceId: wsB, addonId: 'fxacct' }, human(member))),
    ).toMatchObject({ code: 'forbidden', status: 403 });
    expect(await stateOf(wsB, 'fxacct')).toBeNull();
  });

  it('installs three add-ons, each arriving until the worker has set it up', async () => {
    const one = await run(cmds.install, { workspaceId: wsB, addonId: 'fxacct' }, human(owner));
    expect(one.moved).toEqual([
      { addonId: 'fxacct', action: 'install', from: null, to: 'installing', generation: 1 },
    ]);
    await run(cmds.install, { workspaceId: wsB, addonId: 'fxsocial' }, human(adminUser));
    await run(cmds.install, { workspaceId: wsB, addonId: 'fxcontent' }, human(owner));
    // Asking again changes nothing.
    expect(
      (await run(cmds.install, { workspaceId: wsB, addonId: 'fxacct' }, human(owner))).moved,
    ).toEqual([]);
    // Arriving: nobody has its permissions yet.
    expect(await permissionsOf(member, wsB)).not.toContain('fxacct.use');
    await finish(wsB);
    expect(await permissionsOf(member, wsB)).toEqual(
      expect.arrayContaining(['fxacct.use', 'fxsocial.use', 'fxcontent.use']),
    );
    const list = await ask(queries.list, { workspaceId: wsB }, human(member));
    expect(list.installed.map((i) => [i.addonId, i.state])).toEqual([
      ['fxacct', 'enabled'],
      ['fxcontent', 'enabled'],
      ['fxsocial', 'enabled'],
    ]);
    expect(list.capabilities.current.map((c) => c.id)).toEqual(
      expect.arrayContaining(['fxacct.use', 'fxsocial.use', 'fxcontent.use']),
    );
  });

  it('never installs what isn’t available, and says why', async () => {
    const tryIt = (addonId: string) =>
      refusal(run(cmds.install, { workspaceId: wsB, addonId }, human(owner)));
    expect(await tryIt('fxinflu')).toMatchObject({ rule: 'addon_not_available', status: 409 });
    expect(await tryIt('fxbeta')).toMatchObject({ rule: 'addon_not_available' });
    expect(await tryIt('fxold')).toMatchObject({ rule: 'addon_not_available' });
    expect(await tryIt('fxpaid')).toMatchObject({ rule: 'addon_needs_billing' });
    expect(await tryIt('fxnothing')).toMatchObject({ rule: 'addon_unknown', status: 404 });
  });

  it('asks before installing what an add-on needs, and installs both once agreed', async () => {
    const asked = await refusal(
      run(cmds.install, { workspaceId: wsB, addonId: 'fxrent' }, human(owner)),
    );
    expect(asked).toMatchObject({
      rule: 'addon_needs',
      status: 409,
      disposition: 'ask',
      details: { addons: ['fxprop'] },
    });
    const both = await run(
      cmds.install,
      { workspaceId: wsB, addonId: 'fxrent', include: ['fxprop'] },
      human(owner),
    );
    expect(both.moved.map((m) => m.addonId)).toEqual(['fxprop', 'fxrent']);
    await finish(wsB);
  });
});

describe('thirteen add-ons (C), and the same with other permissions (D)', () => {
  it('installs all of them in both', async () => {
    for (const ws of [wsC, wsD]) {
      for (const addonId of TWELVE)
        await run(cmds.install, { workspaceId: ws, addonId }, human(owner));
      await run(cmds.install, { workspaceId: ws, addonId: 'fxrent' }, human(owner));
      await finish(ws);
      const list = await ask(queries.list, { workspaceId: ws }, human(owner));
      expect(list.installed.filter((i) => i.state === 'enabled')).toHaveLength(13);
    }
  });

  it('gives each role what its add-ons say, and a business can change that for its members', async () => {
    // Rent Collection is for admins by default.
    expect(await permissionsOf(adminUser, wsC)).toContain('fxrent.use');
    expect(await permissionsOf(member, wsC)).not.toContain('fxrent.use');
    // D's owner keeps its members away from properties; `fxprop.write` stands on `fxprop.read`, so it goes too.
    const set = await run(
      permissionSetRole,
      { workspaceId: wsD, role: 'member', permission: 'fxprop.read', allowed: false },
      human(owner),
    );
    expect(set.effective).not.toContain('fxprop.read');
    expect(set.effective).not.toContain('fxprop.write');
    expect(set.effective).toContain('fxseo.use');
    expect(await permissionsOf(member, wsD)).not.toContain('fxprop.write');
    expect(await permissionsOf(member, wsC)).toEqual(
      expect.arrayContaining(['fxprop.read', 'fxprop.write']),
    );
    const inD = await ask(queries.list, { workspaceId: wsD }, human(member));
    expect(inD.capabilities.restricted.map((c) => c.id)).toEqual(
      expect.arrayContaining(['fxprop.properties', 'fxprop.leases', 'fxrent.overdue']),
    );
    const inC = await ask(queries.list, { workspaceId: wsC }, human(member));
    expect(inC.capabilities.current.map((c) => c.id)).toContain('fxprop.properties');
  });

  it('can’t set a permission of an add-on the business doesn’t have', async () => {
    expect(
      await refusal(
        run(
          permissionSetRole,
          { workspaceId: wsA, role: 'member', permission: 'fxprop.read', allowed: false },
          human(owner),
        ),
      ),
    ).toMatchObject({ code: 'validation' });
    // Nor one of core's that isn't settable.
    expect(
      await refusal(
        run(
          permissionSetRole,
          { workspaceId: wsC, role: 'member', permission: 'workspace.read', allowed: false },
          human(owner),
        ),
      ),
    ).toMatchObject({ code: 'validation' });
  });

  it('keeps what a business has quick to read with thirteen add-ons', async () => {
    const timed = async (fn: () => Promise<unknown>) => {
      const took: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await fn();
        took.push(performance.now() - t);
      }
      return took.sort((a, b) => a - b)[2]!;
    };
    const busy = await timed(() => ask(queries.list, { workspaceId: wsC }, human(member)));
    const empty = await timed(() => ask(queries.list, { workspaceId: wsA }, human(member)));
    expect(busy).toBeLessThan(400);
    expect(empty).toBeLessThan(400);
  });
});

describe('turning off, and what depends on what', () => {
  it('asks before turning off what another add-on needs, then turns off both, dependents first', async () => {
    const asked = await refusal(
      run(cmds.disable, { workspaceId: wsC, addonId: 'fxprop' }, human(owner)),
    );
    expect(asked).toMatchObject({
      rule: 'addon_required_by',
      disposition: 'ask',
      details: { addons: ['fxrent'] },
    });
    const impact = await ask(
      queries.impact,
      { workspaceId: wsC, addonId: 'fxprop', action: 'disable' },
      human(owner),
    );
    expect(impact.needsAgreement).toEqual(['fxrent']);
    expect(impact.question).toBe('Rent Collection needs Property Management. Turn it off too?');
    expect(impact.moves.map((m) => m.addonId)).toEqual(['fxrent', 'fxprop']);
    expect(impact.capabilitiesLost.map((c) => c.id)).toEqual(
      expect.arrayContaining(['fxprop.properties', 'fxrent.overdue']),
    );
    // Only people who manage add-ons see what an add-on holds.
    expect(
      await refusal(
        ask(
          queries.impact,
          { workspaceId: wsC, addonId: 'fxprop', action: 'disable' },
          human(member),
        ),
      ),
    ).toMatchObject({ status: 403 });

    const both = await run(
      cmds.disable,
      { workspaceId: wsC, addonId: 'fxprop', include: ['fxrent'] },
      human(adminUser),
    );
    expect(both.moved.map((m) => [m.addonId, m.to])).toEqual([
      ['fxrent', 'disabled'],
      ['fxprop', 'disabled'],
    ]);
    // Everyone loses it at once, everywhere the permission is read.
    expect(await permissionsOf(member, wsC)).not.toContain('fxprop.read');
    const list = await ask(queries.list, { workspaceId: wsC }, human(member));
    expect(list.capabilities.turnedOff.map((c) => c.id)).toContain('fxprop.properties');
  });

  it('asks again to turn back on what an add-on needs, and turns both back on', async () => {
    expect(
      await refusal(run(cmds.enable, { workspaceId: wsC, addonId: 'fxrent' }, human(owner))),
    ).toMatchObject({ rule: 'addon_needs', details: { addons: ['fxprop'] } });
    const both = await run(
      cmds.enable,
      { workspaceId: wsC, addonId: 'fxrent', include: ['fxprop'] },
      human(owner),
    );
    expect(both.moved.map((m) => [m.addonId, m.to])).toEqual([
      ['fxprop', 'enabled'],
      ['fxrent', 'enabled'],
    ]);
    expect(await permissionsOf(member, wsC)).toContain('fxprop.read');
  });

  it('turns off an add-on others only use when it’s there, and says who used it', async () => {
    const impact = await ask(
      queries.impact,
      { workspaceId: wsB, addonId: 'fxsocial', action: 'disable' },
      human(owner),
    );
    expect(impact.needsAgreement).toEqual([]);
    expect(impact.optionalFor.map((o) => o.addonId)).toEqual(['fxcontent']);
    await run(cmds.disable, { workspaceId: wsB, addonId: 'fxsocial' }, human(owner));
    expect((await stateOf(wsB, 'fxsocial'))?.state).toBe('disabled');
    expect((await stateOf(wsB, 'fxcontent'))?.state).toBe('enabled');
  });
});

describe('the add-on check, for every kind of actor', () => {
  const inputOf = z.object({ workspaceId: z.uuid(), text: z.string() });
  const inWorkspace = (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  });
  /** A core command: attributed to an add-on only when it runs for one. */
  const coreNote = defineCommand({
    name: 'test.addon_core_note',
    description: 'Test: a core command.',
    risk: 0,
    input: inputOf,
    output: z.object({ ok: z.literal(true) }),
    permission: 'workspace.read',
    actors: ['human', 'system', 'workflow'],
    scope: inWorkspace,
    emits: ['test.addon_core_noted'],
    async handler(ctx, input) {
      await ctx.emit({
        type: 'test.addon_core_noted',
        entityType: 'workspace',
        entityId: ctx.scope.workspaceId,
        payload: { text: input.text },
      });
      return { ok: true as const };
    },
  });
  /** One of Property Management's commands, which runs a core one inside it. */
  const addonNote = defineAddonCommand(fxprop, {
    name: 'fxprop.note',
    description: 'Test: a note on the properties.',
    risk: 1,
    input: inputOf,
    output: z.object({ ok: z.literal(true) }),
    permission: 'fxprop.write',
    actors: ['human', 'system', 'workflow', 'ai_employee'],
    scope: inWorkspace,
    emits: ['fxprop.noted'],
    async handler(ctx, input) {
      await ctx.emit({
        type: 'fxprop.noted',
        entityType: 'workspace',
        entityId: ctx.scope.workspaceId,
        payload: { text: input.text },
      });
      await executeCommandWithin(ctx, coreNote, { workspaceId: input.workspaceId, text: 'inner' });
      return { ok: true as const };
    },
  });
  const addonCount = defineAddonQuery(fxprop, {
    name: 'fxprop.count',
    description: 'Test: how many properties.',
    input: z.object({ workspaceId: z.uuid() }),
    output: z.object({ n: z.number() }),
    permission: 'fxprop.read',
    actors: ['human', 'system', 'workflow'],
    scope: inWorkspace,
    handler: async () => ({ n: 0 }),
  });

  const system = (ws: string, addon = false): SystemActor => ({
    type: 'system',
    workspaceId: ws,
    organizationId: orgId,
    ...(addon ? { addon: { id: fxprop.id, name: fxprop.name, version: fxprop.version } } : {}),
  });
  const workflow = (ws: string): WorkflowActor => ({
    type: 'workflow',
    workspaceId: ws,
    organizationId: orgId,
    workflowId: randomUUID(),
    versionId: null,
    runId: randomUUID(),
    stepKey: 'step',
    depth: 0,
    originRunId: null,
    workflowName: 'Test flow',
    test: false,
  });
  const teammate = (ws: string): AiEmployeeActor => ({
    type: 'ai_employee',
    workspaceId: ws,
    organizationId: orgId,
    teammateId: randomUUID(),
    teammateName: 'Ava',
    runId: null,
    conversationId: null,
    approvedBy: null,
    origin: null,
    test: false,
  });
  const note = (ws: string, actor: Actor) =>
    run(addonNote, { workspaceId: ws, text: `from ${actor.type}` }, actor);

  it('refuses the add-on’s commands and queries to everyone where it isn’t installed', async () => {
    for (const actor of [human(member), system(wsA), workflow(wsA)])
      expect(await refusal(note(wsA, actor))).toMatchObject({
        status: 403,
        rule: 'addon_inactive',
        disposition: 'final',
      });
    expect(await refusal(ask(addonCount, { workspaceId: wsA }, human(member)))).toMatchObject({
      rule: 'addon_inactive',
    });
    expect(await refusal(ask(addonCount, { workspaceId: wsA }, system(wsA)))).toMatchObject({
      rule: 'addon_inactive',
    });
    // The AI teammate runs only what it is allowed to, add-on or not.
    expect(await refusal(note(wsA, teammate(wsA)))).toMatchObject({ status: 403 });
    // Core's own command, run by the system for the add-on, is the add-on's work too.
    expect(
      await refusal(run(coreNote, { workspaceId: wsA, text: 'for it' }, system(wsA, true))),
    ).toMatchObject({ rule: 'addon_inactive' });
    // …and by the system for nobody, it's core's, and runs.
    expect(await run(coreNote, { workspaceId: wsA, text: 'core' }, system(wsA))).toEqual({
      ok: true,
    });
  });

  it('runs them where it’s on, and history says which add-on did what', async () => {
    const correlationId = randomUUID();
    await executeCommand(
      dbFor(human(member)),
      addonNote,
      { workspaceId: wsC, text: 'from a person' },
      human(member),
      { correlationId, channel: 'test' },
    );
    for (const actor of [system(wsC), workflow(wsC)])
      expect(await note(wsC, actor)).toEqual({ ok: true });
    expect(await ask(addonCount, { workspaceId: wsC }, human(member))).toEqual({ n: 0 });
    const history = await rows<{ event_type: string; addon_id: string | null; addon: unknown }>(
      admin(),
      sql`select e.event_type, e.addon_id, e.payload -> '_addon' as addon from app.events e
          where e.correlation_id = ${correlationId} order by e.created_at, e.event_type`,
    );
    expect(history).toEqual([
      {
        event_type: 'fxprop.noted',
        addon_id: 'fxprop',
        addon: { id: 'fxprop', name: 'Property Management', version: '1.0.0' },
      },
      {
        event_type: 'test.addon_core_noted',
        addon_id: 'fxprop',
        addon: { id: 'fxprop', name: 'Property Management', version: '1.0.0' },
      },
    ]);
    const audit = await rows<{ addon_id: string | null }>(
      admin(),
      sql`select a.addon_id from app.audit_logs a join app.events e on e.id = a.event_id
          where e.correlation_id = ${correlationId}`,
    );
    expect(audit.every((a) => a.addon_id === 'fxprop')).toBe(true);
    // The permission still counts where it's on: D's members may not write properties.
    expect(await refusal(note(wsD, human(member)))).toMatchObject({ code: 'forbidden' });
  });

  it('stops everything the moment it’s turned off, and starts again when it’s back', async () => {
    await run(
      cmds.disable,
      { workspaceId: wsC, addonId: 'fxprop', include: ['fxrent'] },
      human(owner),
    );
    for (const actor of [human(member), system(wsC), workflow(wsC)])
      expect(await refusal(note(wsC, actor))).toMatchObject({ rule: 'addon_inactive' });
    expect(
      await refusal(run(coreNote, { workspaceId: wsC, text: 'for it' }, system(wsC, true))),
    ).toMatchObject({ rule: 'addon_inactive' });
    await run(
      cmds.enable,
      { workspaceId: wsC, addonId: 'fxrent', include: ['fxprop'] },
      human(owner),
    );
    expect(await note(wsC, human(member))).toEqual({ ok: true });
  });

  it('is switched off everywhere by HandsFreeOS, whatever a business chose', async () => {
    // A fresh id: an override is global, and other runs share this database.
    const id = `fx${randomUUID()
      .replace(/[^a-f]/g, '')
      .slice(0, 8)
      .padEnd(8, 'a')}`.slice(0, 16);
    const solo = defineAddon({
      id,
      name: 'Switch Test',
      summary: 'Switched off everywhere.',
      description: 'A test fixture.',
      category: 'operations',
      version: '1.0.0',
      dataVersion: 1,
      billing: { model: 'free' },
      catalog: { status: 'available', keywords: ['switch'] },
      capabilities: [
        { id: `${id}.use`, label: 'Switch', description: 'Switch.', permission: `${id}.use` },
      ],
      permissions: [
        { key: `${id}.use`, label: 'Use', description: 'Use.', defaultRoles: ['member'] },
      ],
    });
    const catalog: Catalog = [solo];
    const soloCmds = addonLifecycleCommands(catalog);
    await rows(
      admin(),
      sql`select private.register_addon_permissions(${id}, ${JSON.stringify(solo.permissions)}::jsonb)`,
    );
    await run(soloCmds.install, { workspaceId: wsA, addonId: id }, human(owner));
    await finish(wsA);
    expect(await permissionsOf(member, wsA)).toContain(`${id}.use`);
    await rows(
      admin(),
      sql`insert into platform.addon_overrides (addon_id, status, reason) values (${id}, 'unavailable', 'Test')`,
    );
    expect(await permissionsOf(member, wsA)).not.toContain(`${id}.use`);
    const ping = defineAddonQuery(solo, {
      name: `${id}.ping`,
      description: 'Test.',
      input: z.object({ workspaceId: z.uuid() }),
      output: z.object({ ok: z.boolean() }),
      permission: 'workspace.read',
      scope: inWorkspace,
      handler: async () => ({ ok: true }),
    });
    expect(await refusal(ask(ping, { workspaceId: wsA }, human(member)))).toMatchObject({
      rule: 'addon_inactive',
    });
    // And back.
    await rows(admin(), sql`delete from platform.addon_overrides where addon_id = ${id}`);
    expect(await ask(ping, { workspaceId: wsA }, human(member))).toEqual({ ok: true });
    await run(soloCmds.uninstall, { workspaceId: wsA, addonId: id }, human(owner));
    await finish(wsA);
  });
});

describe('settings', () => {
  it('are saved by whoever the add-on says, checked against its own rules', async () => {
    const saved = await run(
      cmds.saveSettings,
      { workspaceId: wsB, addonId: 'fxacct', settings: { currency: 'eur', closeDay: 5 } },
      human(member),
    );
    expect(saved).toEqual({ addonId: 'fxacct', saved: true });
    expect(
      await refusal(
        run(
          cmds.saveSettings,
          { workspaceId: wsB, addonId: 'fxacct', settings: { currency: 'gbp' } },
          human(owner),
        ),
      ),
    ).toMatchObject({ code: 'validation' });
    expect(
      await refusal(
        run(
          cmds.saveSettings,
          { workspaceId: wsB, addonId: 'fxacct', flags: { nope: true } },
          human(owner),
        ),
      ),
    ).toMatchObject({ code: 'validation' });
    await run(
      cmds.saveSettings,
      { workspaceId: wsB, addonId: 'fxacct', flags: { beta_reports: true } },
      human(owner),
    );
    // An add-on with no settings has none to save.
    expect(
      await refusal(
        run(
          cmds.saveSettings,
          { workspaceId: wsB, addonId: 'fxcontent', settings: { x: 1 } },
          human(owner),
        ),
      ),
    ).toMatchObject({ code: 'validation' });
    const read = await ask(
      queries.settings,
      { workspaceId: wsB, addonId: 'fxacct' },
      human(member),
    );
    expect(read).toEqual({
      addonId: 'fxacct',
      settings: { currency: 'eur', closeDay: 5 },
      flags: { beta_reports: true },
      mySettings: {},
    });
  });

  it('keeps each person’s own settings to themselves', async () => {
    await run(
      cmds.saveMySettings,
      { workspaceId: wsB, addonId: 'fxacct', settings: { digest: true } },
      human(member),
    );
    expect(
      (await ask(queries.settings, { workspaceId: wsB, addonId: 'fxacct' }, human(member)))
        .mySettings,
    ).toEqual({ digest: true });
    expect(
      (await ask(queries.settings, { workspaceId: wsB, addonId: 'fxacct' }, human(adminUser)))
        .mySettings,
    ).toEqual({});
  });

  it('are out of reach while the add-on is off, and kept for when it’s back', async () => {
    await run(cmds.disable, { workspaceId: wsB, addonId: 'fxacct' }, human(owner));
    expect(
      await refusal(ask(queries.settings, { workspaceId: wsB, addonId: 'fxacct' }, human(owner))),
    ).toMatchObject({ rule: 'addon_inactive' });
    expect(
      await refusal(
        run(
          cmds.saveSettings,
          { workspaceId: wsB, addonId: 'fxacct', settings: { currency: 'usd' } },
          human(owner),
        ),
      ),
    ).toMatchObject({ rule: 'addon_inactive' });
    await run(cmds.enable, { workspaceId: wsB, addonId: 'fxacct' }, human(owner));
    expect(
      (await ask(queries.settings, { workspaceId: wsB, addonId: 'fxacct' }, human(owner))).settings,
    ).toEqual({ currency: 'eur', closeDay: 5 });
  });
});

describe('uninstalling, deleting its data, and installing again', () => {
  it('uninstalls, keeping what it had until an owner deletes it', async () => {
    const out = await run(
      cmds.uninstall,
      { workspaceId: wsB, addonId: 'fxsocial' },
      human(adminUser),
    );
    expect(out.moved).toEqual([
      {
        addonId: 'fxsocial',
        action: 'uninstall',
        from: 'disabled',
        to: 'uninstalling',
        generation: 1,
      },
    ]);
    await finish(wsB);
    const list = await ask(queries.list, { workspaceId: wsB }, human(owner));
    expect(list.installed.find((i) => i.addonId === 'fxsocial')?.state).toBe('uninstalled');
    // Back among what could be added.
    expect(list.capabilities.installable.map((c) => c.provider)).toContain('fxsocial');
  });

  it('deletes the data only for an owner who types its name, and only once it’s uninstalled', async () => {
    expect(
      await refusal(
        run(
          cmds.purge,
          { workspaceId: wsB, addonId: 'fxsocial', confirmName: 'Social Media Scheduler' },
          human(adminUser),
        ),
      ),
    ).toMatchObject({ code: 'forbidden' });
    expect(
      await refusal(
        run(
          cmds.purge,
          { workspaceId: wsB, addonId: 'fxsocial', confirmName: 'Social' },
          human(owner),
        ),
      ),
    ).toMatchObject({ code: 'validation' });
    expect(
      await refusal(
        run(
          cmds.purge,
          { workspaceId: wsB, addonId: 'fxacct', confirmName: 'Accounting' },
          human(owner),
        ),
      ),
    ).toMatchObject({ rule: 'addon_uninstall_first' });
    const out = await run(
      cmds.purge,
      { workspaceId: wsB, addonId: 'fxsocial', confirmName: '  social media scheduler ' },
      human(owner),
    );
    expect(out.moved.map((m) => m.to)).toEqual(['purging']);
    await finish(wsB);
    expect((await stateOf(wsB, 'fxsocial'))?.state).toBe('purged');
  });

  it('installs again as a new generation, and a newer version keeps the old data for the worker to bring up', async () => {
    const again = await run(cmds.install, { workspaceId: wsB, addonId: 'fxsocial' }, human(owner));
    expect(again.moved).toEqual([
      { addonId: 'fxsocial', action: 'install', from: 'purged', to: 'installing', generation: 2 },
    ]);
    await finish(wsB);
    await run(cmds.uninstall, { workspaceId: wsB, addonId: 'fxsocial' }, human(owner));
    await finish(wsB);
    // The same add-on, a version on, whose data changed shape.
    const newer: Catalog = FIXTURE_CATALOG.map((m) =>
      m.id === fxsocial.id ? { ...m, version: '1.1.0', dataVersion: 2 } : m,
    );
    await run(
      addonLifecycleCommands(newer).install,
      { workspaceId: wsB, addonId: 'fxsocial' },
      human(owner),
    );
    expect(await stateOf(wsB, 'fxsocial')).toEqual({
      state: 'installing',
      generation: 3,
      installed_version: '1.1.0',
      data_version: 1,
    });
    await finish(wsB);
  });

  it('records every move in history, as core’s, with the add-on named', async () => {
    const moves = await rows<{
      event_type: string;
      addon_id: string | null;
      payload: Record<string, unknown>;
    }>(
      admin(),
      sql`select event_type, addon_id, payload from app.events
          where workspace_id = ${wsB} and entity_type = 'addon' and payload ->> 'addonId' = 'fxsocial'
          order by created_at`,
    );
    expect(moves.map((m) => m.event_type)).toEqual([
      'addon.install_started',
      'addon.disabled',
      'addon.uninstall_started',
      'addon.purge_started',
      'addon.install_started',
      'addon.uninstall_started',
      'addon.install_started',
    ]);
    expect(
      moves.every((m) => m.addon_id === null && m.payload['name'] === 'Social Media Scheduler'),
    ).toBe(true);
  });
});
