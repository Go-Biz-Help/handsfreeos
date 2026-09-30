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
  me,
  membershipInvite,
  organizationCreate,
  personCreate,
  personList,
  platformViewAsCurrent,
  platformViewAsEnd,
  platformViewAsStart,
  supportTicketList,
  workspaceGet,
  workspaceMembers,
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
    await expect(
      executeCommand(api(), platformViewAsStart, { workspaceId }, human(staff), meta()),
    ).rejects.toMatchObject({ code: 'validation' });
    const { output } = await executeCommand(
      api(),
      platformViewAsStart,
      { workspaceId, reason: 'Checking why their reminders stopped', minutes: 15 },
      human(staff),
      meta(),
    );
    sessionId = output.session.id;
    expect(output.session.businessName).toBe('Looked At Landscaping');
    expect(output.session.acting).toBe(false);
    expect(Date.parse(output.session.expiresAt!)).toBeGreaterThan(Date.now());
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

/**
 * The founder works in a business as its owner (20261013002100, the owner's decision of 2026-09-30): one click,
 * no reason, no time limit, the business not told — and never a member, so on none of its lists.
 */
describe('the founder', () => {
  let founder: TestUser;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    founder = await createTestUser('view-as-founder');
    // There is only ever one: a run that stopped halfway may have left its founder marked.
    await admin().execute(sql`update platform.staff set founder = false where founder`);
    // Marked at the database's console, the only place it can be (a request is refused: support-rls.test.ts).
    // Being the founder doesn't hang on the staff role; an agent keeps this suite clear of the last-admin rule.
    await admin().execute(
      sql`insert into platform.staff (user_id, role, founder) values (${founder.id}, 'agent', true)`,
    );
    const { output } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Not Opened Plumbing' },
      human(owner),
      meta(),
    );
    otherWorkspaceId = output.workspaceId;
  });
  afterAll(async () => {
    await admin().execute(sql`delete from platform.staff where user_id = ${founder.id}`);
  });

  it('opens a business with no reason, and it lasts until they leave', async () => {
    const { output } = await executeCommand(
      api(),
      platformViewAsStart,
      { workspaceId },
      human(founder),
      meta(),
    );
    expect(output.session).toMatchObject({ acting: true, reason: null, expiresAt: null });
    const current = await executeQuery(api(), platformViewAsCurrent, {}, human(founder), meta());
    expect(current.session).toMatchObject({ workspaceId, acting: true, expiresAt: null });
  });

  it('works in it as its owner', async () => {
    const got = await executeQuery(api(), workspaceGet, { workspaceId }, human(founder), meta());
    expect(got.workspace.role).toBe('owner');
    expect(got.workspace.permissions).toContain('records.write');
    await executeCommand(
      api(),
      personCreate,
      { workspaceId, firstName: 'Added', lastName: 'ByTheFounder' },
      human(founder),
      meta(),
    );
    const people = await executeQuery(api(), personList, { workspaceId }, human(owner), meta());
    expect(people.items.some((p) => p.lastName === 'ByTheFounder')).toBe(true);
  });

  it('can bring someone onto its team, as an owner would', async () => {
    const { output } = await executeCommand(
      api(),
      membershipInvite,
      {
        workspaceId,
        email: `invited-by-founder-${randomUUID().slice(0, 8)}@hfos.test`,
        role: 'owner',
      },
      human(founder),
      meta(),
    );
    expect(output.role).toBe('owner');
  });

  it('is not on its team, and holds nothing in it', async () => {
    const team = await executeQuery(api(), workspaceMembers, { workspaceId }, human(owner), meta());
    expect(team.members.map((m) => m.userId)).not.toContain(founder.id);
    const got = await executeQuery(api(), workspaceGet, { workspaceId }, human(owner), meta());
    expect(got.counts.members).toBe(1);
    const held = await admin().execute<{ n: number }>(
      sql`select count(*)::int as n from app.workspace_access where user_id = ${founder.id}`,
    );
    expect(held[0]?.n).toBe(0);
  });

  it('is not one of their own businesses, so the banner stays up', async () => {
    const mine = await executeQuery(api(), me, {}, human(founder), meta());
    expect(mine.workspaces.map((w) => w.id)).not.toContain(workspaceId);
  });

  it('the business is not told', async () => {
    const [event] = await admin().execute<{ payload: { acting?: boolean } }>(
      sql`select e.payload from app.events e
          join platform.view_as_sessions v on v.id = e.entity_id
          where e.event_type = 'platform.view_as_started' and v.staff_user_id = ${founder.id}`,
    );
    // The worker skips the business's audit entry for a session that acts; the event says it does.
    expect(event?.payload.acting).toBe(true);
    const inBusiness = await admin().execute<{ n: number }>(
      sql`select count(*)::int as n from app.audit_logs
          where workspace_id = ${workspaceId} and action = 'platform.view_as.started'`,
    );
    expect(inBusiness[0]?.n).toBe(0);
  });

  it('reaches only the business it opened', async () => {
    await expect(
      executeQuery(api(), workspaceGet, { workspaceId: otherWorkspaceId }, human(founder), meta()),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      executeCommand(
        api(),
        personCreate,
        { workspaceId: otherWorkspaceId, firstName: 'Not', lastName: 'Here' },
        human(founder),
        meta(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('and once they leave, the business is gone for them again', async () => {
    const { output } = await executeCommand(api(), platformViewAsEnd, {}, human(founder), meta());
    expect(output.ended).toBe(true);
    await expect(
      executeQuery(api(), workspaceGet, { workspaceId }, human(founder), meta()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('while support still needs a reason', async () => {
    await expect(
      executeCommand(api(), platformViewAsStart, { workspaceId }, human(staff), meta()),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});
