/**
 * Deleting a business end to end (0093): the owner's command, the event that queues the job, and the job.
 * - The name has to be typed exactly; an admin can't do it at all.
 * - Once asked, the job closes the phone sub-account (every number goes with it), removes the business's files
 *   from Storage, purges every row, and leaves one `workspace.deleted` line in the organization's log.
 * - The other business in the organization is untouched, and running the job again changes nothing.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  organizationCreate,
  workspaceCreate,
  workspaceDelete,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { WORKSPACE_JOBS, workspaceDeleteJobKey } from '../src/workspace/delete';
import { testServices, type TestServices } from './helpers';

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let priya: TestUser;
let workspaceId: string;
let otherId: string;
let organizationId: string;
let s: TestServices;
const accountSid = `AC${randomUUID().replace(/-/g, '')}`;

const run = <T>(cmd: Parameters<typeof executeCommand>[1], input: unknown, u: TestUser) =>
  executeCommand(api(), cmd, input, actor(u), meta()).then((r) => r.output as T);

async function runOutbox(eventType: string, entityId: string) {
  const runner = `vitest-wsdel-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.outbox set locked_at = now(), locked_by = ${runner}
        where status = 'pending' and event_id in
          (select id from app.events where event_type = ${eventType} and entity_id = ${entityId})`,
  );
  return processOnce({ ...s, handlers, workerId: runner, batchSize: 20, reservedOnly: true });
}
async function runJob() {
  const runner = `vitest-wsdel-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner}
        where status = 'pending' and kind = ${WORKSPACE_JOBS.delete}
          and dedupe_key = ${workspaceDeleteJobKey(workspaceId)}`,
  );
  return processJobs({ ...s, jobs, workerId: runner, batchSize: 5, reservedOnly: true });
}
const count = async (query: ReturnType<typeof sql>) =>
  (await rows<{ n: number }>(admin(), query))[0]!.n;

beforeAll(async () => {
  [owner, priya] = await Promise.all([
    createTestUser('wsdel-owner', { fullName: 'Owen Owner' }),
    createTestUser('wsdel-priya', { fullName: 'Priya Admin' }),
  ]);
  const org = await run<{ workspaceId: string; organizationId: string }>(
    organizationCreate,
    { businessName: 'Closing Down HVAC' },
    owner,
  );
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  const other = await run<{ workspaceId: string }>(
    workspaceCreate,
    { organizationId, name: 'Still Open Roofing', joinAsOwner: true },
    owner,
  );
  otherId = other.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${priya.id}, 'admin')`,
  );
  // What lives outside: a phone sub-account and a stored file, in both businesses.
  for (const ws of [workspaceId, otherId]) {
    await rows(
      admin(),
      sql`insert into app.telephony_accounts (workspace_id, provider, account_sid)
          values (${ws}, 'twilio', ${ws === workspaceId ? accountSid : `AC${randomUUID().replace(/-/g, '')}`})`,
    );
    await rows(
      admin(),
      sql`insert into storage.objects (bucket_id, name) values ('attachments', ${`${ws}/imports/list.csv`})`,
    );
  }
  s = testServices();
}, 60_000);

afterAll(closeTestDbs);

describe('workspace.delete', () => {
  it('wants the name typed exactly, and an owner to type it', async () => {
    await expect(
      run(workspaceDelete, { workspaceId, confirmName: 'Closing Down' }, owner),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      run(workspaceDelete, { workspaceId, confirmName: 'Closing Down HVAC' }, priya),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await count(
        sql`select count(*)::int as n from app.workspaces where id = ${workspaceId} and deletion_requested_at is null`,
      ),
    ).toBe(1);
  });

  it('lets go of what is outside, purges the business and leaves one line in the organization’s log', async () => {
    const out = await run<{ workspaceId: string; requestedAt: string }>(
      workspaceDelete,
      { workspaceId, confirmName: '  closing down hvac ' },
      owner,
    );
    expect(out.workspaceId).toBe(workspaceId);
    await runOutbox('workspace.deletion_requested', workspaceId);
    const stats = await runJob();
    expect(stats.done).toBe(1);

    expect(s.telephony.closedAccounts).toEqual([accountSid]);
    expect(
      await count(sql`select count(*)::int as n from app.workspaces where id = ${workspaceId}`),
    ).toBe(0);
    expect(
      await count(
        sql`select count(*)::int as n from storage.objects where name like ${workspaceId + '/%'}`,
      ),
    ).toBe(0);
    expect(
      await count(
        sql`select count(*)::int as n from app.events where workspace_id = ${workspaceId}`,
      ),
    ).toBe(0);
    const [line] = await rows<{ workspace_id: string | null; before: { name: string } }>(
      admin(),
      sql`select a.workspace_id, a.before from app.audit_logs a
          where a.organization_id = ${organizationId} and a.action = 'workspace.delete' and a.entity_id = ${workspaceId}`,
    );
    expect(line).toEqual({ workspace_id: null, before: { name: 'Closing Down HVAC' } });

    // The other business is as it was.
    expect(
      await count(sql`select count(*)::int as n from app.workspaces where id = ${otherId}`),
    ).toBe(1);
    expect(
      await count(
        sql`select count(*)::int as n from storage.objects where name like ${otherId + '/%'}`,
      ),
    ).toBe(1);
  });

  it('changes nothing when it runs again', async () => {
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, kind, dedupe_key, run_at, payload)
          values (${organizationId}, ${WORKSPACE_JOBS.delete}, ${workspaceDeleteJobKey(workspaceId)}, now(),
                  ${JSON.stringify({ workspaceId, organizationId })}::jsonb)`,
    );
    const stats = await runJob();
    expect(stats.done).toBe(1);
    expect(s.telephony.closedAccounts).toEqual([accountSid]);
    expect(
      await count(
        sql`select count(*)::int as n from app.audit_logs where action = 'workspace.delete' and entity_id = ${workspaceId}`,
      ),
    ).toBe(1);
  });
});
