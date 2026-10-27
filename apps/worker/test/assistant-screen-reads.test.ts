import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADDON_SERVER_MODULES,
  allAddonAiTools,
  assistantTools,
  executeCommand,
  hasStaffPermission,
  hasWorkspacePermission,
  isStaffPermission,
  NOT_FOR_THE_ASSISTANT,
  organizationCreate,
  personCreate,
  registry,
  SCREEN_READS,
  screenReadName,
  type HumanActor,
} from '@hfos/core/server';
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
const ctx = (): ToolContext => ({
  actor: actor(owner),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});
const read = async (query: string, args: Record<string, unknown>) => {
  const tool = allScreenReadTools().find((t) => t.name === screenReadName(query))!;
  return (await createToolExecutor(api()).run(tool, tool.input.parse(args) as never, ctx())) as {
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
});
