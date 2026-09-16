/**
 * M10 step 6b on the local database: a person's own account.
 * - **Delete my account:** typing the email to confirm; a business's founder (its organization's only owner) is
 *   refused in plain words naming the business and how to hand it over, and nothing changes; a teammate's request is
 *   recorded in every business they can reach, each naming only itself; an account in no business queues the
 *   worker's job for itself and notes it on the account; asking twice is fine; online only from a phone. (Handing
 *   a business or an agency over: ownership.test.ts.)
 * - **The Assistant's consent:** kept with the wording version and the time, once per wording; account.me says whether
 *   the consent step still shows; one OK covers every app.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { asUser, rows, sql } from '@hfos/db/client';
import { events, organizationMemberships, users, workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ASSISTANT_CONSENT_VERSION, assistantConsentOf } from '../src/assistant/consent';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta, SystemActor } from '../src/kernel/types';
import {
  accountDelete,
  accountNoteDeleted,
  assistantConsent,
  me,
  organizationCreate,
  registry,
  userUpdateProfile,
} from '../src/server';

const MIN = 60_000;
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
const phoneMeta = (occurredAt = new Date()): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'mobile',
  commandId: randomUUID(),
  occurredAt,
  sentAt: new Date(),
  confirmedAt: null,
  appVersion: '1.0.0',
});

/** Raw SQL as a signed-in person (RLS on), for the database's own guards. */
function executeQueryAs(u: TestUser, query: ReturnType<typeof sql>) {
  return asUser(api(), u.claims, (tx) => tx.execute(query));
}

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

let founder: TestUser;
let marco: TestUser;
let agencyOwner: TestUser;
let clientOwner: TestUser;
let wsId: string;
let orgId: string;
let agencyWs: string;
let secondAgencyWs: string;

beforeAll(async () => {
  [founder, marco, agencyOwner, clientOwner] = await Promise.all([
    createTestUser('acct-founder', { fullName: 'Dale Founder' }),
    createTestUser('acct-marco', { fullName: 'Marco Member' }),
    createTestUser('acct-agency', { fullName: 'Chris Agency' }),
    createTestUser('acct-client-owner', { fullName: 'Lena Client' }),
  ]);
  const org = await run(organizationCreate, { businessName: 'Founder HVAC & Roofing' }, founder);
  wsId = org.workspaceId;
  orgId = org.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${marco.id}, 'member')`,
  );
  // An agency with two client businesses; Lena owns one of them directly.
  const agency = await run(
    organizationCreate,
    { businessName: 'Bayou Plumbing', organizationName: 'Account Test Agency' },
    agencyOwner,
  );
  agencyWs = agency.workspaceId;
  const [second] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workspaces (organization_id, name, slug)
        values (${agency.organizationId}, 'Gulf Roofing', ${`gulf-roofing-${randomUUID().slice(0, 6)}`}) returning id`,
  );
  secondAgencyWs = second!.id;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${agencyWs}, ${clientOwner.id}, 'owner')`,
  );
  // Marco also works at the agency's other business.
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${secondAgencyWs}, ${marco.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('delete my account', () => {
  it('asks for the email address, exactly', async () => {
    const err = await expectHfos(
      () => run(accountDelete, { confirmEmail: 'someone@else.test' }, marco),
      'validation',
    );
    expect(err.details).toEqual([
      {
        path: 'confirmEmail',
        message: 'Type your email address exactly as it is on your account.',
      },
    ]);
  });

  it('refuses a business’s founder in plain words, naming the business, and changes nothing', async () => {
    const err = await expectHfos(
      () => run(accountDelete, { confirmEmail: founder.email.toUpperCase() }, founder),
      'rule_violation',
      'only_owner',
    );
    expect(err.disposition).toBe('final');
    expect(err.message).toBe(
      'You’re the only owner of Founder HVAC & Roofing. Make someone else an owner first, in Members on the web, so the business isn’t left without one.',
    );
    // Its organization holds only this business, so it is named once, as the business.
    expect(err.details).toEqual({
      businesses: [{ workspaceId: wsId, name: 'Founder HVAC & Roofing' }],
      organizations: [],
    });
    // The probes were undone: both memberships are still there, and nothing was asked for.
    expect(
      await admin()
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.userId, founder.id),
            eq(workspaceMemberships.workspaceId, wsId),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await admin()
        .select()
        .from(organizationMemberships)
        .where(eq(organizationMemberships.userId, founder.id)),
    ).toHaveLength(1);
    const asked = await admin()
      .select()
      .from(events)
      .where(
        and(eq(events.actorId, founder.id), eq(events.eventType, 'account.deletion_requested')),
      );
    expect(asked).toHaveLength(0);
    // An agency owner is the agency's only owner: named as the agency.
    const agency = await expectHfos(
      () => run(accountDelete, { confirmEmail: agencyOwner.email }, agencyOwner),
      'rule_violation',
      'only_owner',
    );
    expect(agency.message).toBe(
      'You’re the only owner of the agency Account Test Agency. Make someone who owns one of its businesses an owner of the agency first, from Delete my account on the web, so it isn’t left without one.',
    );
    expect(agency.details).toMatchObject({
      organizations: [{ name: 'Account Test Agency', agency: true }],
    });
  });

  it('a client business’s owner under an agency may go: the agency still owns it', async () => {
    const out = await run(accountDelete, { confirmEmail: clientOwner.email }, clientOwner);
    expect(out.userId).toBe(clientOwner.id);
  });

  it('a teammate’s request is recorded in every business they can reach, each naming only itself', async () => {
    const out = await run(accountDelete, { confirmEmail: marco.email }, marco);
    expect(out).toMatchObject({ userId: marco.id, requestedAt: expect.any(String) });
    const asked = await admin()
      .select()
      .from(events)
      .where(and(eq(events.actorId, marco.id), eq(events.eventType, 'account.deletion_requested')));
    expect(asked.map((e) => e.workspaceId).sort()).toEqual([wsId, secondAgencyWs].sort());
    for (const e of asked) {
      expect(e).toMatchObject({ entityType: 'user', entityId: marco.id });
      expect(e.payload).toEqual({ userId: marco.id });
    }
    // Asking again while the job runs is fine; once the profile is gone it answers with that moment.
    await run(accountDelete, { confirmEmail: marco.email }, marco);
    await admin()
      .update(users)
      .set({ deletedAt: new Date('2026-09-16T12:00:00Z') })
      .where(eq(users.id, marco.id));
    expect(await run(accountDelete, { confirmEmail: 'anything@at.all' }, marco)).toEqual({
      userId: marco.id,
      requestedAt: '2026-09-16T12:00:00.000Z',
    });
    await admin().update(users).set({ deletedAt: null }).where(eq(users.id, marco.id));
  });

  it('an account in no business queues the worker’s job for itself, noted on its own account', async () => {
    const loner = await createTestUser('acct-loner');
    const out = await run(accountDelete, { confirmEmail: loner.email }, loner);
    expect(out.userId).toBe(loner.id);
    const job = await rows<{ kind: string; workspace_id: string | null; payload: unknown }>(
      admin(),
      sql`select kind, workspace_id, payload from app.scheduled_jobs
          where dedupe_key = ${`account-delete:${loner.id}`} and status = 'pending'`,
    );
    expect(job).toEqual([
      { kind: 'account.delete', workspace_id: null, payload: { userId: loner.id } },
    ]);
    const noted = await admin()
      .select()
      .from(events)
      .where(and(eq(events.actorId, loner.id), eq(events.eventType, 'account.deletion_requested')));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatchObject({ workspaceId: null, organizationId: null, entityId: loner.id });
    // Asking again keeps the one job.
    await run(accountDelete, { confirmEmail: loner.email }, loner);
    const [{ n }] = (await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.scheduled_jobs where dedupe_key = ${`account-delete:${loner.id}`}`,
    )) as [{ n: number }];
    expect(n).toBe(1);
    // Nobody in a business can queue the job for themselves, whatever they call.
    await expect(
      executeQueryAs(marco, sql`select private.request_account_deletion()`),
    ).rejects.toThrow();
  });

  it('needs signal on a phone, and the worker notes it in each business', async () => {
    const late = await createTestUser('acct-late');
    await expectHfos(
      () =>
        executeCommand(
          api(),
          accountDelete,
          { confirmEmail: late.email },
          human(late),
          phoneMeta(new Date(Date.now() - 10 * MIN)),
        ),
      'rule_violation',
      'online_only',
    );
    expect(registry.command('account.delete')!.offline).toBe('online');
    const system: SystemActor = { type: 'system', workspaceId: wsId, organizationId: orgId };
    await executeCommand(
      testDbs().worker.db,
      accountNoteDeleted,
      { workspaceId: wsId, userId: marco.id },
      system,
      meta(),
    );
    const [noted] = await admin()
      .select()
      .from(events)
      .where(and(eq(events.eventType, 'account.deleted'), eq(events.entityId, marco.id)));
    expect(noted).toMatchObject({ workspaceId: wsId, actorType: 'system' });
    await expectHfos(
      () => run(accountNoteDeleted, { workspaceId: wsId, userId: marco.id }, founder),
      'forbidden',
    );
  });
});

describe('the Assistant’s consent', () => {
  it('is needed until the person says OK, then kept once with the wording version and time', async () => {
    const u = await createTestUser('acct-consent');
    const read = () => executeQuery(api(), me, {}, human(u), meta());
    expect((await read()).assistantConsent).toEqual({
      version: ASSISTANT_CONSENT_VERSION,
      consentedAt: null,
      consentedVersion: null,
      needed: true,
    });
    const first = await run(assistantConsent, { version: ASSISTANT_CONSENT_VERSION }, u);
    expect(first).toMatchObject({ version: ASSISTANT_CONSENT_VERSION, changed: true });
    const again = await run(assistantConsent, { version: ASSISTANT_CONSENT_VERSION }, u);
    expect(again).toEqual({ ...first, changed: false });
    expect((await read()).assistantConsent).toEqual({
      version: ASSISTANT_CONSENT_VERSION,
      consentedAt: first.consentedAt,
      consentedVersion: ASSISTANT_CONSENT_VERSION,
      needed: false,
    });
    const recorded = await admin()
      .select()
      .from(events)
      .where(and(eq(events.actorId, u.id), eq(events.eventType, 'assistant.consented')));
    expect(recorded).toHaveLength(1);
    // Another settings save keeps it (saves replace their own keys only).
    await run(userUpdateProfile, { settings: { notifications: { urgent: false } } }, u);
    expect((await read()).assistantConsent.needed).toBe(false);
  });

  it('asks again when the wording changes, and reads anything malformed as no OK', () => {
    const at = '2026-09-16T12:00:00.000Z';
    expect(assistantConsentOf({ assistantConsent: { version: 1, at } }).needed).toBe(
      ASSISTANT_CONSENT_VERSION > 1,
    );
    expect(
      assistantConsentOf({ assistantConsent: { version: ASSISTANT_CONSENT_VERSION + 1, at } })
        .needed,
    ).toBe(false);
    for (const bad of [null, {}, { assistantConsent: 'yes' }, { assistantConsent: { version: 1 } }])
      expect(assistantConsentOf(bad)).toMatchObject({ consentedAt: null, needed: true });
  });

  it('can be given from the phone', async () => {
    const u = await createTestUser('acct-consent-phone');
    const out = await executeCommand(
      api(),
      assistantConsent,
      { version: ASSISTANT_CONSENT_VERSION },
      human(u),
      phoneMeta(),
    );
    expect(out.output.changed).toBe(true);
  });
});
