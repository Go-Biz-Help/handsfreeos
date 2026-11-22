/**
 * The owner's decision of 2026-11-22, on the local database: "A business with no plan or trial can't text, email,
 * call, buy numbers or use AI, even through the API. Max 3 new businesses per person a day."
 *
 * - A business that still has to pick a plan (`needs_plan`) is refused a text, an email, an outbound call and a
 *   number through the kernel, by a person and by HandsFreeOS itself, with the rule `needs_plan` and words that say
 *   where the plan is picked. The worker's own reads (as the service actor) say the same.
 * - One on a free trial, one with a paid plan, and one made before the founding gate (never marked) all send.
 * - A fourth new business by the same person within a day is refused, whichever command makes it, until the oldest
 *   of the three is a day old. HandsFreeOS's staff aren't counted.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { asService, closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta, SystemActor } from '../src/kernel/types';
import { PLAN_REFUSALS, planNeeded } from '../src/money/plan-gate';
import { walletRoom } from '../src/money/wallet-gate';
import {
  callStart,
  messageSend,
  organizationCreate,
  personCreate,
  phoneNumberBuy,
  phoneUpdateSettings,
  workspaceCreate,
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
const system = (): SystemActor => ({
  type: 'system',
  workspaceId: wsId,
  organizationId: orgId,
  onBehalfOf: null,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().worker.db, cmd, input, system(), meta()).then((r) => r.output);

async function refusal(fn: () => Promise<unknown>): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    return e as HfosError;
  }
  throw new Error('expected a refusal, but it went through');
}

const uniq = () => randomUUID().slice(0, 8);
const nextPhone = () =>
  `+1832${String(2000000 + ((Date.now() + Math.floor(Math.random() * 1e6)) % 7999999)).padStart(7, '0')}`;

let dale: TestUser;
let orgId: string;
let wsId: string;
let mariaId: string;

/** Marks the business as made while a paid spot was on sale, as the trigger does, and takes any plan away. */
async function needsAPlan(on: boolean) {
  await admin().execute(sql`update app.organizations set needs_plan = ${on} where id = ${orgId}`);
  await admin().execute(sql`delete from app.workspace_plans where organization_id = ${orgId}`);
}

/** Puts a plan on the business: on its free trial, or paid. Both are `active` (20261027027000). */
async function givePlan(trial: boolean) {
  await admin().execute(
    sql`insert into app.workspace_plans (workspace_id, organization_id, plan, status, price_cents, trial_ends_at,
                                         current_period_end)
        values (${wsId}, ${orgId}, 'monthly', 'active', 9700,
                ${trial ? sql`now() + interval '14 days'` : sql`null`}, now() + interval '1 month')
        on conflict (workspace_id) do update
          set status = 'active', trial_ends_at = excluded.trial_ends_at`,
  );
}

const text = () =>
  run(
    messageSend,
    { workspaceId: wsId, personId: mariaId, body: 'Your tech is on the way.', clientId: uniq() },
    dale,
  );
const email = (to = `maria-${uniq()}@example.com`) =>
  run(
    messageSend,
    {
      workspaceId: wsId,
      channel: 'email',
      toEmail: to,
      subject: 'Your visit',
      body: 'See you Monday at 8.',
      clientId: uniq(),
    },
    dale,
  );

beforeAll(async () => {
  dale = await createTestUser('plangate-dale', { fullName: 'Dale Owner' });
  const org = await run(
    organizationCreate,
    { businessName: 'Plan Gate HVAC', timezone: 'America/Chicago' },
    dale,
  );
  orgId = org.organizationId;
  wsId = org.workspaceId;
  // A business number that can text, so a text gets as far as the money.
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`ACplan${uniq()}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNplan${uniq()}`}, ${nextPhone()}, 'toll_free', 'active') returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${wsId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHplan${uniq()}`}, now())`,
  );
  // No quiet hours, so a text goes whatever time the test runs.
  await run(
    phoneUpdateSettings,
    { workspaceId: wsId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
    dale,
  );
  mariaId = (
    await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Maria', lastName: 'Lopez', phone: '(713) 555-0174' },
      dale,
    )
  ).personId;
});
afterAll(closeTestDbs);

describe('a business that still has to pick a plan', () => {
  beforeAll(() => needsAPlan(true));

  it('is refused a text, an email, a call and a number, with words that say where the plan is picked', async () => {
    const cases = [
      ['text', text],
      ['email', () => email('victim@example.com')],
      ['call', () => run(callStart, { workspaceId: wsId, personId: mariaId }, dale)],
      [
        'number',
        () =>
          run(phoneNumberBuy, { workspaceId: wsId, e164: nextPhone(), numberType: 'local' }, dale),
      ],
    ] as const;
    for (const [kind, attempt] of cases) {
      const e = await refusal(attempt);
      expect({ kind, rule: e.rule, status: e.status }).toEqual({
        kind,
        rule: 'needs_plan',
        status: 402,
      });
      expect(e.message).toBe(PLAN_REFUSALS[kind]);
    }
    // Nothing was bought, and nothing went to the address.
    const [left] = await rows<{ numbers: number; to: number }>(
      admin(),
      sql`select (select count(*)::int from app.phone_numbers where workspace_id = ${wsId}) as numbers,
                 (select count(*)::int from app.conversations
                   where workspace_id = ${wsId} and counterpart = 'victim@example.com') as to`,
    );
    expect(left).toEqual({ numbers: 1, to: 0 });
  });

  it('is refused for HandsFreeOS itself and its workflows too, not only for people', async () => {
    const e = await refusal(() =>
      sys(messageSend, {
        workspaceId: wsId,
        channel: 'email',
        toEmail: `someone-${uniq()}@example.com`,
        subject: 'Hello',
        body: 'Hello there.',
        keepConversationStatus: true,
      }),
    );
    expect(e.rule).toBe('needs_plan');
    const t = await refusal(() =>
      sys(messageSend, { workspaceId: wsId, personId: mariaId, body: 'A reminder.' }),
    );
    expect(t.rule).toBe('needs_plan');
  });

  it('reads the same in the worker, as the service actor: no room for AI, calls or texts', async () => {
    const scope = { workspaceId: wsId, organizationId: orgId };
    for (const kind of ['ai', 'call', 'text', 'number'] as const)
      expect(await asService(scope)((tx) => walletRoom(tx, wsId, kind)), kind).toMatchObject({
        allowed: false,
        needsPlan: true,
        unknown: false,
      });
    expect(await asService(scope)((tx) => planNeeded(tx, wsId))).toBe(true);
  });
});

describe('a business that may spend', () => {
  it('on its free trial sends texts and email', async () => {
    await needsAPlan(true);
    await givePlan(true);
    expect(await text()).toMatchObject({ status: 'queued' });
    expect(await email()).toMatchObject({ status: 'queued' });
  });

  it('with a paid plan sends texts and email', async () => {
    await needsAPlan(true);
    await givePlan(false);
    expect(await text()).toMatchObject({ status: 'queued' });
    expect(await email()).toMatchObject({ status: 'queued' });
  });

  it('made before the founding gate (never marked) sends with no plan at all', async () => {
    await needsAPlan(false);
    expect(
      await asService({ workspaceId: wsId, organizationId: orgId })((tx) => planNeeded(tx, wsId)),
    ).toBe(false);
    expect(await text()).toMatchObject({ status: 'queued' });
    expect(await email()).toMatchObject({ status: 'queued' });
  });
});

describe('three new businesses a person a day', () => {
  const newOrg = (u: TestUser, name: string) =>
    run(organizationCreate, { businessName: name, timezone: 'America/Chicago' }, u);
  const newWs = (u: TestUser, organizationId: string, name: string) =>
    run(workspaceCreate, { organizationId, name }, u);

  it('refuses a fourth in a day, whichever command makes it, and says when another can be added', async () => {
    const maker = await createTestUser('plangate-maker', { newBusinessesADay: null });
    const first = await newOrg(maker, 'Maker One');
    await newWs(maker, first.organizationId, 'Maker Two');
    await newWs(maker, first.organizationId, 'Maker Three');

    for (const attempt of [
      () => newWs(maker, first.organizationId, 'Maker Four'),
      () => newOrg(maker, 'Maker Four Co'),
    ]) {
      const e = await refusal(attempt);
      expect({ rule: e.rule, status: e.status }).toEqual({
        rule: 'too_many_new_businesses',
        status: 429,
      });
      expect(e.message).toMatch(/3 businesses in the last day/);
      expect(e.message).toMatch(/add another in about (an hour|\d+ hours)\./);
    }
    // Refused whole: no fourth business, and no second organization either.
    const [made] = await rows<{ workspaces: number; orgs: number }>(
      admin(),
      sql`select (select count(*)::int from app.workspaces where created_by = ${maker.id}) as workspaces,
                 (select count(*)::int from app.organizations where created_by = ${maker.id}) as orgs`,
    );
    expect(made).toEqual({ workspaces: 3, orgs: 1 });

    // Once the oldest of the three is a day old, there's room for one more, and only one.
    await admin().execute(
      sql`update app.workspaces set created_at = now() - interval '25 hours'
          where id = ${first.workspaceId}`,
    );
    await newWs(maker, first.organizationId, 'Maker Four');
    expect((await refusal(() => newOrg(maker, 'Maker Five Co'))).rule).toBe(
      'too_many_new_businesses',
    );
  });

  it('counts each person on their own', async () => {
    const other = await createTestUser('plangate-other', { newBusinessesADay: null });
    // Dale made one above; somebody new has all three.
    const theirs = await newOrg(other, 'Other One');
    await newWs(other, theirs.organizationId, 'Other Two');
    await newWs(other, theirs.organizationId, 'Other Three');
  });

  it('lets one person HandsFreeOS has allowed more add that many', async () => {
    const agency = await createTestUser('plangate-agency', { newBusinessesADay: 5 });
    const org = await newOrg(agency, 'Agency One');
    for (const name of ['Client Two', 'Client Three', 'Client Four', 'Client Five'])
      await newWs(agency, org.organizationId, name);
    const e = await refusal(() => newWs(agency, org.organizationId, 'Client Six'));
    expect(e.rule).toBe('too_many_new_businesses');
    expect(e.message).toMatch(/5 businesses in the last day/);
  });

  it('doesn’t count HandsFreeOS’s staff', async () => {
    const staffer = await createTestUser('plangate-staff', { newBusinessesADay: null });
    await admin().execute(
      sql`insert into platform.staff (user_id, role) values (${staffer.id}, 'admin')`,
    );
    const org = await newOrg(staffer, 'Staff One');
    for (const name of ['Staff Two', 'Staff Three', 'Staff Four', 'Staff Five'])
      await newWs(staffer, org.organizationId, name);
    await newOrg(staffer, 'Staff Six Co');
  });
});
