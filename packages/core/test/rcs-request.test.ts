/**
 * Asking for RCS and paying for it (0104), the parts that are the database's and the commands': who may ask, what
 * a request needs first, who sees it, and that what Stripe says is the worker's alone to write. The payment
 * itself, the ticket and the renewal run end to end in apps/worker/test/rcs-billing.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { rcsRequests } from '@hfos/db/schema';
import {
  as,
  closeTestDbs,
  createTestUser,
  expectPgError,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  organizationCreate,
  phoneSetupStatus,
  RCS_FEE_LINES,
  RCS_FIRST_YEAR_CENTS,
  RCS_YEARLY_CENTS,
  rcsRequestCancel,
  rcsRequestSubmit,
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

const brand = {
  displayName: 'Lone Star HVAC',
  description: 'Heating and cooling repair in Houston.',
  color: '#1A73E8',
  website: 'https://lonestar.example.com',
  privacyUrl: 'https://lonestar.example.com/privacy',
  termsUrl: 'https://lonestar.example.com/terms',
  phone: '(713) 555-0100',
  email: 'hello@lonestar.example.com',
};

let owner: TestUser;
let member: TestUser;
let wsId: string;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('rcs-req-owner'),
    createTestUser('rcs-req-member'),
  ]);
  wsId = (await run(organizationCreate, { businessName: 'RCS Request Co' }, owner)).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('what RCS costs', () => {
  it('is $800 the first year and $215 every year after, with the passed-on fees marked', () => {
    expect(RCS_FIRST_YEAR_CENTS).toBe(80_000);
    expect(RCS_YEARLY_CENTS).toBe(21_500);
    expect(RCS_FEE_LINES.filter((l) => l.passedOn).map((l) => [l.key, l.cents])).toEqual([
      ['carrier_onboarding', 50_000],
      ['brand_vetting', 20_000],
    ]);
  });
});

describe('asking for RCS', () => {
  it('needs a business number, and the people who manage the channels', async () => {
    await expectHfos(
      () => run(rcsRequestSubmit, { workspaceId: wsId, brand }, owner),
      'rule_violation',
      'no_number',
    );
    await rows(
      admin(),
      sql`insert into app.phone_numbers (workspace_id, e164, number_type, status)
          values (${wsId}, ${`+1713${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`}, 'local', 'porting')`,
    );
    await expectHfos(
      () => run(rcsRequestSubmit, { workspaceId: wsId, brand }, member),
      'forbidden',
    );
    await expectHfos(
      () => run(rcsRequestSubmit, { workspaceId: wsId, brand: { ...brand, color: 'blue' } }, owner),
      'validation',
    );

    // A number on its way is enough: the sender takes weeks either way.
    const made = await run(rcsRequestSubmit, { workspaceId: wsId, brand }, owner);
    expect(made).toMatchObject({ status: 'pending', checkoutUrl: null });
    const [row] = await admin()
      .select()
      .from(rcsRequests)
      .where(eq(rcsRequests.id, made.rcsRequestId));
    expect(row).toMatchObject({
      firstYearCents: 80_000,
      yearlyCents: 21_500,
      requestedBy: owner.id,
    });
    expect(row!.brand).toMatchObject({ displayName: 'Lone Star HVAC', logoUrl: null, notes: '' });

    // The owner sees it on the Texting page; a member doesn't, prices and all.
    expect((await ask(phoneSetupStatus, { workspaceId: wsId }, owner)).rcsRequest).toMatchObject({
      id: made.rcsRequestId,
      status: 'pending',
      renews: false,
    });
    expect((await ask(phoneSetupStatus, { workspaceId: wsId }, member)).rcsRequest).toBeNull();

    // Asking again picks the same request back up.
    expect((await run(rcsRequestSubmit, { workspaceId: wsId, brand }, owner)).rcsRequestId).toBe(
      made.rcsRequestId,
    );
  });

  it('keeps what Stripe says the worker’s: a person can only give up or stop it renewing', async () => {
    const [live] = await admin()
      .select()
      .from(rcsRequests)
      .where(eq(rcsRequests.workspaceId, wsId));
    const err = await expectPgError(() =>
      as(owner)((tx) =>
        tx.update(rcsRequests).set({ status: 'paid' }).where(eq(rcsRequests.id, live!.id)),
      ),
    );
    expect(err.detail).toBe('rcs_request_transition');
    const fields = await expectPgError(() =>
      as(owner)((tx) =>
        tx
          .update(rcsRequests)
          .set({ status: 'cancelled', cardRef: 'pm_mine' })
          .where(eq(rcsRequests.id, live!.id)),
      ),
    );
    expect(fields.detail).toBe('rcs_request_provider_fields');
    // A person can't write a request in somebody else's name, or one that looks paid.
    await expectPgError(() =>
      as(owner)((tx) =>
        tx.insert(rcsRequests).values({
          workspaceId: wsId,
          brand,
          firstYearCents: 1,
          yearlyCents: 1,
          requestedBy: member.id,
        }),
      ),
    );

    const gaveUp = await run(rcsRequestCancel, { workspaceId: wsId }, owner);
    expect(gaveUp.status).toBe('cancelled');
    await expectHfos(() => run(rcsRequestCancel, { workspaceId: wsId }, owner), 'not_found');
    expect((await ask(phoneSetupStatus, { workspaceId: wsId }, owner)).rcsRequest).toBeNull();
  });
});
