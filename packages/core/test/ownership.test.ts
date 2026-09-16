/**
 * M10 step 7 on the local database: handing a business or an agency over, so its owner can delete their account.
 * - **A founder** (the only owner of a business and of its one-business organization) makes a teammate an owner in
 *   Members; Delete my account then works, and the organization passes to that teammate in the same transaction,
 *   recorded in the business. account.deletion_check says what stands in the way before, and what passes after.
 * - **A refusal undoes the hand-over:** a person who still owns an agency alone keeps everything as it was.
 * - **An agency** is handed over with organization.add_owner: only by an owner of it, only to someone who already owns
 *   one of its businesses (or is an admin of it), recorded in each of its businesses, once.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { events, organizationMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta } from '../src/kernel/types';
import {
  accountDeletionCheck,
  accountDelete,
  membershipChangeRole,
  organizationAddOwner,
  organizationCreate,
  registry,
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
const check = (u: TestUser) => executeQuery(api(), accountDeletionCheck, {}, human(u), meta());

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

const member = (workspaceId: string, u: TestUser, role: 'owner' | 'admin' | 'member') =>
  rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${u.id}, ${role})`,
  );
const orgRoleOf = async (organizationId: string, u: TestUser) =>
  (
    await admin()
      .select({ role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.userId, u.id),
        ),
      )
  )[0]?.role ?? null;
const ownerAddedEvents = (userId: string) =>
  admin()
    .select()
    .from(events)
    .where(and(eq(events.eventType, 'organization.owner_added'), eq(events.entityId, userId)));

afterAll(closeTestDbs);

describe('a founder hands the business over', () => {
  let dale: TestUser;
  let priya: TestUser;
  let marco: TestUser;
  let ws: string;
  let org: string;

  beforeAll(async () => {
    [dale, priya, marco] = await Promise.all([
      createTestUser('own-dale', { fullName: 'Dale Ramsey' }),
      createTestUser('own-priya', { fullName: 'Priya Natarajan' }),
      createTestUser('own-marco', { fullName: 'Marco Villanueva' }),
    ]);
    const created = await run(organizationCreate, { businessName: 'Handover HVAC' }, dale);
    ws = created.workspaceId;
    org = created.organizationId;
    await member(ws, marco, 'member');
    await member(ws, priya, 'admin');
  });

  it('is told what stands in the way, with a teammate to suggest (an admin first)', async () => {
    const got = await check(dale);
    expect(got).toEqual({
      ready: false,
      businesses: [
        {
          workspaceId: ws,
          name: 'Handover HVAC',
          suggestion: { userId: priya.id, fullName: 'Priya Natarajan', email: priya.email },
        },
      ],
      agencies: [],
      handsOver: [],
    });
    // Asking changed nothing.
    expect(await orgRoleOf(org, priya)).toBeNull();
    expect(await orgRoleOf(org, dale)).toBe('owner');
  });

  it('makes Priya an owner in Members, and then can go: the business and its organization pass to her', async () => {
    await run(membershipChangeRole, { workspaceId: ws, userId: priya.id, role: 'owner' }, dale);
    const got = await check(dale);
    expect(got).toMatchObject({ ready: true, businesses: [], agencies: [] });
    expect(got.handsOver).toEqual([
      {
        organizationId: org,
        workspaceId: ws,
        name: 'Handover HVAC',
        to: [{ userId: priya.id, fullName: 'Priya Natarajan', email: priya.email }],
      },
    ]);
    // The check tries the hand-over and undoes it.
    expect(await orgRoleOf(org, priya)).toBeNull();

    await run(accountDelete, { confirmEmail: dale.email }, dale);
    expect(await orgRoleOf(org, priya)).toBe('owner');
    const added = await ownerAddedEvents(priya.id);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      actorId: dale.id,
      organizationId: org,
      workspaceId: ws,
      entityType: 'user',
    });
    const [audit] = await rows<{ action: string; after: unknown }>(
      admin(),
      sql`select action, after from app.audit_logs where event_id = ${added[0]!.id}`,
    );
    expect(audit).toEqual({
      action: 'account.delete',
      after: { role: 'owner', organization: 'Handover HVAC', leaving: true },
    });
    const asked = await admin()
      .select()
      .from(events)
      .where(and(eq(events.actorId, dale.id), eq(events.eventType, 'account.deletion_requested')));
    expect(asked.map((e) => e.workspaceId)).toEqual([ws]);
    // Dale's last-owner membership can go now: the worker's anonymizing would pass.
    await rows(
      admin(),
      sql`delete from app.organization_memberships where organization_id = ${org} and user_id = ${dale.id}`,
    );
  });
});

describe('a refusal undoes the hand-over', () => {
  it('keeps a one-business organization as it was while its owner still owns an agency alone', async () => {
    const [sam, lena] = await Promise.all([
      createTestUser('own-sam', { fullName: 'Sam Both' }),
      createTestUser('own-lena', { fullName: 'Lena Owner' }),
    ]);
    const shop = await run(organizationCreate, { businessName: 'Sam’s Shop' }, sam);
    await member(shop.workspaceId, lena, 'owner');
    const agency = await run(
      organizationCreate,
      { businessName: 'Client One', organizationName: 'Sam’s Agency' },
      sam,
    );
    await rows(
      admin(),
      sql`insert into app.workspaces (organization_id, name, slug)
          values (${agency.organizationId}, 'Client Two', ${`client-two-${randomUUID().slice(0, 6)}`})`,
    );
    const err = await expectHfos(
      () => run(accountDelete, { confirmEmail: sam.email }, sam),
      'rule_violation',
      'only_owner',
    );
    expect(err.message).toContain('the agency Sam’s Agency');
    expect(err.message).toContain('Client One');
    expect(await orgRoleOf(shop.organizationId, lena)).toBeNull();
    expect(await ownerAddedEvents(lena.id)).toHaveLength(0);
    const got = await check(sam);
    expect(got.ready).toBe(false);
    expect(got.handsOver.map((h) => h.name)).toEqual(['Sam’s Shop']);
    expect(got.agencies).toEqual([
      {
        organizationId: agency.organizationId,
        name: 'Sam’s Agency',
        businessCount: 2,
        candidates: [],
      },
    ]);
    // Client One is Sam's alone too (he made the agency with it): someone becomes its owner first, and then of the
    // agency, since only an owner of one of its businesses can be.
    expect(got.businesses).toEqual([
      { workspaceId: agency.workspaceId, name: 'Client One', suggestion: null },
    ]);
  });
});

describe('handing an agency over', () => {
  let chris: TestUser;
  let dale: TestUser;
  let renee: TestUser;
  let olive: TestUser;
  let stranger: TestUser;
  let org: string;
  let lonestar: string;
  let bayou: string;

  beforeAll(async () => {
    [chris, dale, renee, olive, stranger] = await Promise.all([
      createTestUser('own-chris', { fullName: 'Chris Agency' }),
      createTestUser('own-agency-dale', { fullName: 'Dale Client' }),
      createTestUser('own-renee', { fullName: 'Renée Member' }),
      createTestUser('own-olive', { fullName: 'Olive Admin' }),
      createTestUser('own-stranger', { fullName: 'Stranger Elsewhere' }),
    ]);
    const created = await run(
      organizationCreate,
      { businessName: 'Lone Star Test', organizationName: 'Handover Agency' },
      chris,
    );
    org = created.organizationId;
    lonestar = created.workspaceId;
    const [second] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.workspaces (organization_id, name, slug)
          values (${org}, 'Bayou Test', ${`bayou-test-${randomUUID().slice(0, 6)}`}) returning id`,
    );
    bayou = second!.id;
    await member(lonestar, dale, 'owner');
    await member(bayou, renee, 'member');
    // An admin of the agency itself (nothing in the app makes one yet, but the schema allows it).
    await rows(
      admin(),
      sql`insert into app.organization_memberships (organization_id, user_id, role) values (${org}, ${olive.id}, 'admin')`,
    );
    await run(organizationCreate, { businessName: 'Elsewhere Co' }, stranger);
  });

  it('lists who could take the agency over: owners of its businesses, and its admins', async () => {
    const got = await check(chris);
    expect(got).toMatchObject({ ready: false, businesses: [], handsOver: [] });
    expect(got.agencies).toEqual([
      {
        organizationId: org,
        name: 'Handover Agency',
        businessCount: 2,
        candidates: [
          { userId: dale.id, fullName: 'Dale Client', email: dale.email, owns: ['Lone Star Test'] },
          { userId: olive.id, fullName: 'Olive Admin', email: olive.email, owns: [] },
        ],
      },
    ]);
  });

  it('is only for an owner of the agency, and only to someone who already owns part of it', async () => {
    // Dale owns a business in it, not the agency: the agency doesn't exist for him.
    await expectHfos(
      () => run(organizationAddOwner, { organizationId: org, userId: renee.id }, dale),
      'not_found',
    );
    // An admin of the agency can't hand it over.
    await expectHfos(
      () => run(organizationAddOwner, { organizationId: org, userId: dale.id }, olive),
      'forbidden',
    );
    await expectHfos(
      () => run(organizationAddOwner, { organizationId: org, userId: chris.id }, chris),
      'rule_violation',
      'own_role',
    );
    const notOwner = await expectHfos(
      () => run(organizationAddOwner, { organizationId: org, userId: renee.id }, chris),
      'rule_violation',
      'not_a_business_owner',
    );
    expect(notOwner.message).toBe(
      'Make Renée Member an owner of one of Handover Agency’s businesses first, in its Members page. Only someone who already owns one of them can be made an owner of Handover Agency.',
    );
    await expectHfos(
      () => run(organizationAddOwner, { organizationId: org, userId: stranger.id }, chris),
      'not_found',
    );
    expect(await orgRoleOf(org, renee)).toBeNull();
    expect(registry.command('organization.add_owner')).toMatchObject({
      risk: 4,
      offline: 'online',
    });
  });

  it('makes Dale an owner of the agency, recorded once in each of its businesses; an admin moves up', async () => {
    const out = await run(organizationAddOwner, { organizationId: org, userId: dale.id }, chris);
    expect(out).toEqual({
      organizationId: org,
      userId: dale.id,
      previousRole: 'none',
      changed: true,
    });
    expect(await orgRoleOf(org, dale)).toBe('owner');
    const added = await ownerAddedEvents(dale.id);
    expect(added.map((e) => e.workspaceId).sort()).toEqual([lonestar, bayou].sort());
    for (const e of added) expect(e).toMatchObject({ actorId: chris.id, organizationId: org });
    // Again: nothing changes, nothing more is recorded.
    expect(
      await run(organizationAddOwner, { organizationId: org, userId: dale.id }, chris),
    ).toMatchObject({ previousRole: 'owner', changed: false });
    expect(await ownerAddedEvents(dale.id)).toHaveLength(2);
    // Olive, an admin of the agency, becomes an owner of it.
    expect(
      await run(organizationAddOwner, { organizationId: org, userId: olive.id }, chris),
    ).toMatchObject({ previousRole: 'admin', changed: true });
    expect(await orgRoleOf(org, olive)).toBe('owner');
  });

  it('lets Chris delete his account once someone else owns the agency', async () => {
    expect((await check(chris)).ready).toBe(true);
    const out = await run(accountDelete, { confirmEmail: chris.email }, chris);
    expect(out.userId).toBe(chris.id);
  });
});
