/**
 * Real Estate Agent's worker half (step 9): a changed wire reported on a deal raises a critical alert at once, for
 * the people who see the deal, asking to be acknowledged, and the phone check being done clears it.
 */
import { randomUUID } from 'node:crypto';
import {
  ADDON_SERVER_MODULES,
  executeCommand,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { attentionJobs, withAttention } from '../src/attention/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { pushJobs } from '../src/push/send';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const run = (who: TestUser, name: string, input: Record<string, unknown>) =>
  executeCommand(
    api(),
    realestate.commands!.find((c) => c.name === name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    { correlationId: randomUUID(), channel: 'test' },
  ).then((r) => r.output as Record<string, string>);

const handlers = withAddons(withAttention({}));
const jobs = { ...attentionJobs, ...pushJobs, ...addonJobs };

let s: TestServices;
let owner: TestUser;
let agent: TestUser;
let ws: string;

/** Every pending event and due job of the business, until nothing is left. */
async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-wire-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

const alertOf = (dutyId: string) =>
  rows<{
    severity: string;
    needs_ack: boolean;
    cleared: boolean;
    custom_record_id: string;
    href: string;
  }>(
    admin(),
    sql`select severity, needs_ack, cleared_at is not null as cleared, custom_record_id, href
        from app.addon_alerts
        where workspace_id = ${ws} and addon_id = 'realestate' and key = ${`wire:${dutyId}`}`,
  ).then((r) => r[0]);

beforeAll(async () => {
  s = testServices();
  [owner, agent] = await Promise.all([createTestUser('wire-owner'), createTestUser('wire-agent')]);
  ws = await realestateBusiness(owner, 'Wharf Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
}, 90_000);

afterAll(closeTestDbs);

describe('A changed wire', () => {
  it('raises a critical alert at once, and the phone check clears it', async () => {
    const { dealId } = await run(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Marina purchase',
      stage: 'closing',
    });
    const { dutyId } = await run(agent, 'realestate.deal.report_wire_change', {
      dealId,
      how: 'email',
    });
    await drain();
    expect(await alertOf(dutyId!)).toEqual({
      severity: 'critical',
      needs_ack: true,
      cleared: false,
      custom_record_id: dealId,
      href: `/a/realestate/deals/${dealId}`,
    });
    await run(agent, 'realestate.duty.add_evidence', {
      dutyId: dutyId!,
      kind: 'attestation',
      body: 'I called the title company at a number I found myself',
    });
    await run(agent, 'realestate.duty.add_evidence', {
      dutyId: dutyId!,
      kind: 'note',
      body: 'Called Harbor Title on their listed number; nothing changed.',
    });
    await run(agent, 'realestate.duty.complete', { dutyId: dutyId! });
    await drain();
    expect(await alertOf(dutyId!)).toMatchObject({ cleared: true });
  });
});
