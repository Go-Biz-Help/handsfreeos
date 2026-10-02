/**
 * A local number's texting registration sent before the number is here: a business moving its own number in
 * registers while it travels, and texts the day it lands. Toll-free verification still waits for its number.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  organizationCreate,
  phoneSetupStatus,
  registrationSubmit,
  registrationUpdateStatus,
} from '../src/server';

const db = () => testDbs().api.db;
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
) => executeCommand(db(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(db(), q, input, human(u), meta());

async function expectRule(fn: () => Promise<unknown>, rule: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule).toBe(rule);
    return e as HfosError;
  }
  throw new Error(`expected ${rule}, but the call succeeded`);
}

/** A random local number, so reruns never collide with one still claimed in an old test workspace. */
const randomLocal = () =>
  `+1${2 + Math.floor(Math.random() * 7)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

const business = {
  legalName: 'Ahead Test LLC',
  businessType: 'llc',
  ein: '12-3456789',
  website: 'https://example.com',
  address: { line1: '4410 Westpark Dr', city: 'Houston', state: 'tx', postalCode: '77027' },
  contact: {
    firstName: 'Dale',
    lastName: 'Ramsey',
    email: 'dale@example.com',
    phone: '(713) 555-0161',
  },
  useCase: 'customer_care',
  messageSamples: [
    'Hi Mike, this is Ahead HVAC. Marco is on the way. Reply STOP to opt out.',
    'Hi Mike, your estimate is ready. Reply with questions or STOP to opt out.',
  ],
  optInDescription:
    'Customers give us their cell number when they book a visit and agree to texts about it.',
  monthlyVolume: 'under_1000',
};

let owner: TestUser;

async function freshBusiness(name: string) {
  const org = await run(organizationCreate, { businessName: name }, owner);
  return { wsId: org.workspaceId, orgId: org.organizationId };
}

type RegRow = { kind: string; phone_number_id: string | null; for_number: string | null };
const registrationsOf = (wsId: string) =>
  rows<RegRow>(
    admin(),
    sql`select kind::text as kind, phone_number_id, submission->>'forNumber' as for_number
        from app.telephony_registrations where workspace_id = ${wsId} order by created_at`,
  );

beforeAll(async () => {
  owner = await createTestUser('ahead-owner');
});
afterAll(closeTestDbs);

describe('registering for texting before the number is here', () => {
  it('sends a local registration with no number at all, and refuses toll-free verification', async () => {
    const { wsId } = await freshBusiness('No Number Yet Co');
    await expectRule(
      () =>
        run(
          registrationSubmit,
          { workspaceId: wsId, kind: 'toll_free_verification', business },
          owner,
        ),
      'no_number',
    );

    const { registrationIds } = await run(
      registrationSubmit,
      { workspaceId: wsId, kind: 'a2p_10dlc', business },
      owner,
    );
    expect(registrationIds).toHaveLength(4);
    const regs = await registrationsOf(wsId);
    expect(regs.map((r) => r.kind).sort()).toEqual([
      'a2p_brand',
      'a2p_campaign',
      'a2p_customer_profile',
      'a2p_trust_product',
    ]);
    // Nothing to name yet: no number on the rows, none in what the carrier is sent.
    expect(regs.every((r) => r.phone_number_id === null && r.for_number === null)).toBe(true);

    // The setup screen is still about getting a number; the registration's own step says where it stands.
    const status = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    expect(status).toMatchObject({
      nextStep: 'buy_number',
      localRegistrationStep: 'awaiting_approval',
      messagingReady: false,
    });
  });

  it('names a number being ported in, and says when it is approved', async () => {
    const { wsId } = await freshBusiness('Porting In Co');
    const e164 = randomLocal();
    const [porting] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.phone_numbers (workspace_id, e164, number_type, status)
          values (${wsId}, ${e164}, 'local', 'porting') returning id`,
    );
    expect((await ask(phoneSetupStatus, { workspaceId: wsId }, owner)).localRegistrationStep).toBe(
      'submit_registration',
    );

    const { registrationIds } = await run(
      registrationSubmit,
      { workspaceId: wsId, kind: 'a2p_10dlc', business },
      owner,
    );
    const regs = await registrationsOf(wsId);
    expect(regs.every((r) => r.phone_number_id === porting!.id && r.for_number === e164)).toBe(
      true,
    );

    // The carriers approve every step while the number is still moving.
    const system: SystemActor = {
      type: 'system',
      workspaceId: wsId,
      organizationId: (
        await rows<{ organization_id: string }>(
          admin(),
          sql`select organization_id from app.workspaces where id = ${wsId}`,
        )
      )[0]!.organization_id,
    };
    for (const registrationId of registrationIds)
      await executeCommand(
        testDbs().worker.db,
        registrationUpdateStatus,
        { workspaceId: wsId, registrationId, status: 'approved' },
        system,
        meta(),
      );
    const status = await ask(phoneSetupStatus, { workspaceId: wsId }, owner);
    expect(status).toMatchObject({ nextStep: 'porting', localRegistrationStep: 'ready' });
    await expectRule(
      () => run(registrationSubmit, { workspaceId: wsId, kind: 'a2p_10dlc', business }, owner),
      'registration_approved',
    );

    // A local number starts working here (the port's own landing is the worker's, and has its own tests):
    // texting is ready the same moment, with nothing more to send.
    await rows(
      admin(),
      sql`insert into app.phone_numbers (workspace_id, e164, number_type, status)
          values (${wsId}, ${randomLocal()}, 'local', 'active')`,
    );
    expect(await ask(phoneSetupStatus, { workspaceId: wsId }, owner)).toMatchObject({
      nextStep: 'ready',
      messagingReady: true,
    });
  });

  it('names a number being transferred from another Twilio account, but not a toll-free one', async () => {
    const { wsId } = await freshBusiness('Transferring In Co');
    const tollFree = `+1888${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    await rows(
      admin(),
      sql`insert into app.number_imports (workspace_id, e164, source, status)
          values (${wsId}, ${tollFree}, 'twilio', 'waiting')`,
    );
    // A toll-free number on its way needs toll-free verification, which waits for it.
    await expectRule(
      () => run(registrationSubmit, { workspaceId: wsId, kind: 'a2p_10dlc', business }, owner),
      'registration_kind_mismatch',
    );

    const { wsId: other } = await freshBusiness('Transferring Local Co');
    const local = randomLocal();
    await rows(
      admin(),
      sql`insert into app.number_imports (workspace_id, e164, source, status)
          values (${other}, ${local}, 'highlevel', 'waiting')`,
    );
    await run(registrationSubmit, { workspaceId: other, kind: 'a2p_10dlc', business }, owner);
    const regs = await registrationsOf(other);
    // Not a number of ours yet, so no row to point at — but the carrier is told which one it is for.
    expect(regs.every((r) => r.phone_number_id === null && r.for_number === local)).toBe(true);
  });
});
