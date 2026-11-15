/**
 * Practice businesses through the command pipeline (Admin → Try onboarding, 20261027027400, 20261027027500).
 *
 * The database's own tests (packages/db/test/practice-businesses.test.ts, practice-more-flows.test.ts) prove what its
 * functions let through. These prove the commands reach them as the right person: a staff admin starts one, owned by
 * them, with the same events a new customer's sign-up records; a support agent is refused by the kernel; it's on their
 * own list and their switcher says it's practice, never on Admin → Businesses; and paying and ending work only in a
 * practice business. The other ways: an agency's client under the agency, one they're invited into (the invitation is
 * recorded for the worker to email, and the list says it's waiting), ending one they joined as a member, and every
 * add-on offered in a practice business, the ones still being built too.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { as, closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { practiceEnd, practicePay, practiceStart } from '../src/commands/practice';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import { PRACTICE_HOURS } from '../src/practice/words';
import { practiceList } from '../src/queries/practice';
import {
  addonList,
  me,
  organizationCreate,
  platformBusinessList,
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
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

async function refusal(fn: () => Promise<unknown>): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    return e as HfosError;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

const OFFER = 'test_practice_cmd_monthly';

let staff: TestUser;
let otherStaff: TestUser;
let agent: TestUser;
let customer: TestUser;
let practice: { organizationId: string; workspaceId: string; endsAt: string };
let real: { organizationId: string; workspaceId: string };

beforeAll(async () => {
  [staff, otherStaff, agent, customer] = await Promise.all([
    createTestUser('practice-cmd-staff', { fullName: 'Pat Staff' }),
    createTestUser('practice-cmd-other'),
    createTestUser('practice-cmd-agent'),
    createTestUser('practice-cmd-customer'),
  ]);
  await admin().execute(
    sql`insert into platform.staff (user_id, role)
        values (${staff.id}, 'admin'), (${otherStaff.id}, 'admin'), (${agent.id}, 'agent')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
  await admin().execute(sql`delete from platform.founding_offers where id = ${OFFER}`);
  // Closed, so no other test's new business has to pick a plan; the stand-in takes any plan that isn't a draft.
  await admin().execute(
    sql`insert into platform.founding_offers (id, name, seat_cap, price_cents, status, billing, show_counter)
        values (${OFFER}, 'Founding monthly', 5, 9700, 'closed', 'monthly', false)`,
  );
  practice = await run(
    practiceStart,
    {
      businessName: 'Practice Pest Control',
      timezone: 'America/Denver',
      industry: 'home_services',
    },
    staff,
  );
  real = await run(organizationCreate, { businessName: 'Real Pest Control' }, customer);
});
afterAll(async () => {
  await admin().execute(sql`delete from platform.founding_offers where id = ${OFFER}`);
  // Out of the five at once, for whatever runs after.
  await admin().execute(
    sql`update app.organizations set practice_by = null where practice_by in (${staff.id}::uuid, ${otherStaff.id}::uuid)`,
  );
  await closeTestDbs();
});

describe('practice.start', () => {
  it('makes a business owned by the staff admin, ending in a day, with a new customer’s two events', async () => {
    const hours = (Date.parse(practice.endsAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(PRACTICE_HOURS - 1);
    expect(hours).toBeLessThanOrEqual(PRACTICE_HOURS);
    const events = await rows<{ event_type: string; practice: boolean }>(
      admin(),
      sql`select event_type, (payload ->> 'practice')::boolean as practice from app.events
          where organization_id = ${practice.organizationId}::uuid order by event_type`,
    );
    expect(events).toEqual([
      { event_type: 'organization.created', practice: true },
      { event_type: 'workspace.created', practice: true },
    ]);
    const got = await ask(workspaceGet, { workspaceId: practice.workspaceId }, staff);
    expect(got.workspace.name).toBe('Practice Pest Control');
    expect(got.workspace.timezone).toBe('America/Denver');
    expect(got.workspace.practiceEndsAt).toBe(practice.endsAt);
  });

  it('a support agent and a customer are refused', async () => {
    // A support agent is told no; a customer isn't told there's anything here.
    for (const [who, status] of [
      [agent, 403],
      [customer, 404],
    ] as const) {
      const e = await refusal(() => run(practiceStart, { businessName: 'Nope' }, who));
      expect(e.status).toBe(status);
    }
    const [made] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.organizations where name = 'Nope'
          and created_by in (${agent.id}::uuid, ${customer.id}::uuid)`,
    );
    expect(made!.n).toBe(0);
  });
});

describe('where it shows', () => {
  it('on the staff admin’s practice list, and marked in their businesses', async () => {
    const { businesses } = await ask(practiceList, {}, staff);
    expect(businesses).toContainEqual(
      expect.objectContaining({
        organizationId: practice.organizationId,
        workspaceId: practice.workspaceId,
        name: 'Practice Pest Control',
        ending: false,
      }),
    );
    const mine = await ask(me, {}, staff);
    expect(mine.workspaces.find((w) => w.id === practice.workspaceId)?.practiceEndsAt).toBe(
      practice.endsAt,
    );
    const theirs = await ask(me, {}, customer);
    expect(theirs.workspaces.find((w) => w.id === real.workspaceId)?.practiceEndsAt).toBeNull();
  });

  it('never on Admin → Businesses', async () => {
    const { businesses } = await ask(
      platformBusinessList,
      { search: 'Pest Control', sort: 'name', limit: 50 },
      staff,
    );
    const ids = businesses.map((b) => b.workspaceId);
    expect(ids).toContain(real.workspaceId);
    expect(ids).not.toContain(practice.workspaceId);
  });
});

describe('practice.pay', () => {
  it('puts the plan on a practice business with its trial', async () => {
    const out = await run(
      practicePay,
      { workspaceId: practice.workspaceId, offerId: OFFER, trialDays: 14 },
      staff,
    );
    expect(out.plan).toBe('monthly');
  });

  it('is refused in a real business', async () => {
    const e = await refusal(() =>
      run(practicePay, { workspaceId: real.workspaceId, offerId: OFFER }, customer),
    );
    expect(e.rule).toBe('practice_only');
  });
});

describe('practice.end', () => {
  it('is refused in a real business, which is left as it was', async () => {
    // Its owner isn't told there's anything here; staff are told it only ends a practice business.
    const theirs = await refusal(() =>
      run(practiceEnd, { workspaceId: real.workspaceId }, customer),
    );
    expect(theirs.status).toBe(404);
    const e = await refusal(() => run(practiceEnd, { workspaceId: real.workspaceId }, staff));
    expect(e.rule).toBe('practice_only');
    const [ws] = await rows<{ marked: boolean }>(
      admin(),
      sql`select deletion_requested_at is not null as marked from app.workspaces
          where id = ${real.workspaceId}::uuid`,
    );
    expect(ws!.marked).toBe(false);
  });

  it('deletes a practice business as Delete business does, and the list says it’s going', async () => {
    const out = await run(practiceEnd, { workspaceId: practice.workspaceId }, staff);
    expect(Date.parse(out.requestedAt)).toBeGreaterThan(Date.now() - 60_000);
    const [event] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${practice.workspaceId}::uuid and event_type = 'workspace.deletion_requested'`,
    );
    expect(event!.n).toBe(1);
    const { businesses } = await ask(practiceList, {}, staff);
    expect(businesses.find((b) => b.organizationId === practice.organizationId)).toMatchObject({
      workspaceId: null,
      ending: true,
    });
    const mine = await ask(me, {}, staff);
    expect(mine.workspaces.some((w) => w.id === practice.workspaceId)).toBe(false);
  });
});

describe('the other ways', () => {
  it('an agency’s client: under the agency, which is theirs, without them on its team', async () => {
    const made = await run(
      practiceStart,
      { businessName: 'Client Plumbing', as: 'agency', agencyName: 'Practice Agency' },
      staff,
    );
    const [who] = await rows<{ org: string; ws_member: boolean }>(
      admin(),
      sql`select o.name as org,
                 exists (select 1 from app.workspace_memberships m
                         where m.workspace_id = ${made.workspaceId}::uuid and m.user_id = ${staff.id}::uuid) as ws_member
          from app.organizations o where o.id = ${made.organizationId}::uuid`,
    );
    expect(who).toEqual({ org: 'Practice Agency', ws_member: false });
    const got = await ask(workspaceGet, { workspaceId: made.workspaceId }, staff);
    expect(got.workspace.name).toBe('Client Plumbing');
    expect(made.invitationId).toBeNull();
  });

  it('invited: recorded for the worker to email them, waiting on their list, then ended as a member', async () => {
    const made = await run(
      practiceStart,
      { businessName: 'Team Plumbing', as: 'invited', role: 'member' },
      staff,
    );
    expect(made.invitationId).not.toBeNull();
    const [event] = await rows<{ email: string; role: string }>(
      admin(),
      sql`select payload ->> 'email' as email, payload ->> 'role' as role from app.events
          where workspace_id = ${made.workspaceId}::uuid and event_type = 'invitation.created'`,
    );
    expect(event).toEqual({ email: staff.email, role: 'member' });
    const listed = async () =>
      (await ask(practiceList, {}, staff)).businesses.find(
        (b) => b.workspaceId === made.workspaceId,
      );
    expect(await listed()).toMatchObject({ joined: false, invited: true, ending: false });

    // They take the invitation, as the email's link does.
    const token = randomUUID();
    await admin().execute(
      sql`update app.invitations set token_hash = sha256(convert_to(${token}, 'UTF8')), sent_at = now()
          where id = ${made.invitationId}::uuid`,
    );
    await as(staff)((tx) =>
      tx.execute(
        sql`select * from private.accept_invitation(sha256(convert_to(${token}, 'UTF8')))`,
      ),
    );
    expect(await listed()).toMatchObject({ joined: true, invited: false });

    // Someone else practising can't end it; they can, as a member.
    const e = await refusal(() => run(practiceEnd, { workspaceId: made.workspaceId }, otherStaff));
    expect(e.rule).toBe('practice_not_yours');
    const out = await run(practiceEnd, { workspaceId: made.workspaceId }, staff);
    expect(Date.parse(out.requestedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('invited and never joined: ended all the same', async () => {
    const made = await run(
      practiceStart,
      { businessName: 'Unjoined Plumbing', as: 'invited' },
      staff,
    );
    const out = await run(practiceEnd, { workspaceId: made.workspaceId }, staff);
    expect(Date.parse(out.requestedAt)).toBeGreaterThan(Date.now() - 60_000);
    const [event] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${made.workspaceId}::uuid and event_type = 'workspace.deletion_requested'`,
    );
    expect(event!.n).toBe(1);
  });

  it('ready, with every add-on offered, the ones still being built too; a real business isn’t', async () => {
    const made = await run(practiceStart, { businessName: 'Add-ons Plumbing', ready: true }, staff);
    const got = await ask(workspaceGet, { workspaceId: made.workspaceId }, staff);
    expect(got.workspace.needsPlan).toBe(false);
    const offered = async (workspaceId: string, who: TestUser) =>
      (await ask(addonList, { workspaceId }, who)).catalog;
    const here = await offered(made.workspaceId, staff);
    expect(here).toContainEqual(
      expect.objectContaining({ addonId: 'contractor', status: 'development', testing: true }),
    );
    expect(here).toContainEqual(
      expect.objectContaining({ addonId: 'socialcontent', testing: true }),
    );
    const there = await offered(real.workspaceId, customer);
    expect(there.some((m) => m.addonId === 'contractor')).toBe(false);
  });
});
