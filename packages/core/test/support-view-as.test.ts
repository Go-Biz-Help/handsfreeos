/**
 * Looking at a business, from the kernel's side (M13).
 *
 * The promise made on the screen is "you will see what they see, and you will not be able to change
 * anything". This is where that promise is actually kept, so it is asked here three ways: a look-up works
 * while a session is open, a command never works at all, and once the session ends the business goes back to
 * not existing for that person.
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import {
  organizationCreate,
  personCreate,
  personList,
  platformViewAsEnd,
  platformViewAsStart,
  supportTicketList,
  workspaceGet,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });

let staff: TestUser;
let owner: TestUser;
let workspaceId: string;

beforeAll(async () => {
  [staff, owner] = await Promise.all([
    createTestUser('view-as-staff'),
    createTestUser('view-as-owner'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Looked At Landscaping' },
    human(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  await executeCommand(
    api(),
    personCreate,
    { workspaceId, firstName: 'Dana', lastName: 'Reed' },
    human(owner),
    meta(),
  );
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'agent')
        on conflict (user_id) do update set role = 'agent', status = 'active'`,
  );
});
afterAll(closeTestDbs);

describe('before anyone looks', () => {
  it('a support person cannot see the business at all', async () => {
    await expect(
      executeQuery(api(), workspaceGet, { workspaceId }, human(staff), meta()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('and the business cannot see the support desk', async () => {
    await expect(
      executeQuery(api(), supportTicketList, {}, human(owner), meta()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('while a session is open', () => {
  let sessionId: string;

  it('opening one needs a reason, and says how long it lasts', async () => {
    await expect(
      executeCommand(
        api(),
        platformViewAsStart,
        { workspaceId, reason: 'x' },
        human(staff),
        meta(),
      ),
    ).rejects.toBeInstanceOf(HfosError);
    const { output } = await executeCommand(
      api(),
      platformViewAsStart,
      { workspaceId, reason: 'Checking why their reminders stopped', minutes: 15 },
      human(staff),
      meta(),
    );
    sessionId = output.session.id;
    expect(output.session.businessName).toBe('Looked At Landscaping');
    expect(Date.parse(output.session.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('the business becomes readable — its customers included', async () => {
    const got = await executeQuery(api(), workspaceGet, { workspaceId }, human(staff), meta());
    expect(got.workspace.name).toBe('Looked At Landscaping');
    const people = await executeQuery(api(), personList, { workspaceId }, human(staff), meta());
    expect(people.items.map((p) => p.firstName)).toContain('Dana');
  });

  it('but nothing can be changed, even something a member could do', async () => {
    await expect(
      executeCommand(
        api(),
        personCreate,
        { workspaceId, firstName: 'Added', lastName: 'BySupport' },
        human(staff),
        meta(),
      ),
    ).rejects.toMatchObject({ code: 'forbidden', rule: 'view_as_read_only' });
    const people = await executeQuery(api(), personList, { workspaceId }, human(staff), meta());
    expect(people.items.some((p) => p.lastName === 'BySupport')).toBe(false);
  });

  it('the business finds it in its own audit log', async () => {
    // The worker writes that entry when it handles the event; here the event itself is the proof that it
    // carries what the business needs to read — who looked, and why.
    const [event] = await admin().execute<{ payload: { reason?: string } }>(
      sql`select payload from app.events
          where event_type = 'platform.view_as_started' and entity_id = ${sessionId}`,
    );
    expect(event?.payload.reason).toBe('Checking why their reminders stopped');
  });
});

describe('once it ends', () => {
  it('the business stops existing for them again', async () => {
    const { output } = await executeCommand(api(), platformViewAsEnd, {}, human(staff), meta());
    expect(output.ended).toBe(true);
    await expect(
      executeQuery(api(), workspaceGet, { workspaceId }, human(staff), meta()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
