/**
 * Approving an extension sign-in with a matching number, on the local database (20261027002900):
 * - **Starting** (the worker's, `private.start_extension_sign_in`) answers the same shape for an email with no
 *   account, which nobody can ever answer; a new request for an email cancels the one before.
 * - **extension_sign_in.pending** shows a person their own waiting requests, never the number, and nobody else's.
 * - **extension_sign_in.answer**: the right number approves it, a wrong one or "That wasn't me" refuses it, and it
 *   is answered once. Someone else's, or one past its 2 minutes, is gone.
 * - **Collecting** needs the secret, and hands an approval over exactly once; a refusal stays refused.
 * - **People can't read the number or the secret's hash** from the table, nor write it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import {
  as,
  asService,
  closeTestDbs,
  createTestUser,
  expectPgError,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import { extensionSignInAnswer } from '../src/commands/extension-sign-in';
import { extensionSignInPending } from '../src/queries/extension-sign-in';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const web = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'web' });
const hash = (s: string) => createHash('sha256').update(s).digest();

let dale: TestUser;
let marco: TestUser;

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('signin-dale', { fullName: 'Dale Owner' }),
    createTestUser('signin-marco', { fullName: 'Marco Member' }),
  ]);
});
afterAll(closeTestDbs);

/** A request as the worker starts one: 42 is the number, offered beside 17 and 88. */
async function start(email: string, secret = randomUUID() + randomUUID()) {
  const [made] = await asService({})((tx) =>
    rows<{ id: string; user_id: string | null; expires_at: Date }>(
      tx,
      sql`select * from private.start_extension_sign_in(${email}, ${hash(secret)}, 42::smallint,
            array[17, 42, 88]::smallint[], 'Chrome', null)`,
    ),
  );
  return { ...made!, secret };
}

const collect = async (id: string, secret: string) =>
  (
    await asService({})((tx) =>
      rows<{ status: string; email: string | null }>(
        tx,
        sql`select * from private.collect_extension_sign_in(${id}::uuid, ${hash(secret)})`,
      ),
    )
  )[0]!;

const answer = (u: TestUser, requestId: string, pick: number | null) =>
  executeCommand(api(), extensionSignInAnswer, { requestId, pick }, human(u), web()).then(
    (r) => r.output,
  );
const pending = (u: TestUser) =>
  executeQuery(api(), extensionSignInPending, {}, human(u), web()).then((r) => r.requests);

async function expectGone(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule).toBe('sign_in_request_gone');
    return;
  }
  throw new Error('expected the request to be gone');
}

describe('starting a sign-in prompt', () => {
  it('answers alike for an email with no account, which no one can answer', async () => {
    const nobody = await start(`nobody-${randomUUID()}@hfos.test`);
    expect(nobody.user_id).toBeNull();
    expect(nobody.id).toMatch(/^[0-9a-f-]{36}$/);
    const known = await start(dale.email);
    expect(known.user_id).toBe(dale.id);
    expect(await collect(nobody.id, nobody.secret)).toMatchObject({ status: 'waiting' });
  });

  it('cancels the request before for the same email', async () => {
    const first = await start(dale.email);
    const second = await start(dale.email);
    expect(await collect(first.id, first.secret)).toMatchObject({ status: 'expired' });
    expect((await pending(dale)).map((r) => r.id)).toEqual([second.id]);
  });
});

describe('extension_sign_in.pending and .answer', () => {
  it('shows only the person’s own, with three numbers and never which is right', async () => {
    const r = await start(dale.email);
    const mine = await pending(dale);
    expect(mine).toEqual([
      { id: r.id, browser: 'Chrome', choices: [17, 42, 88], expiresAt: expect.any(String) },
    ]);
    expect(JSON.stringify(mine)).not.toContain('number');
    expect(await pending(marco)).toEqual([]);
  });

  it('approves on the right number, once, and hands the sign-in over once to the secret’s holder', async () => {
    const r = await start(dale.email);
    expect(await collect(r.id, 'not the secret '.repeat(4))).toMatchObject({ status: 'expired' });
    expect(await collect(r.id, r.secret)).toMatchObject({ status: 'waiting' });
    expect(await answer(dale, r.id, 42)).toEqual({ outcome: 'approved' });
    await expectGone(() => answer(dale, r.id, 42));
    expect(await collect(r.id, r.secret)).toEqual({
      status: 'approved',
      email: dale.email,
      user_id: dale.id,
    });
    expect(await collect(r.id, r.secret)).toMatchObject({ status: 'expired' });
    const [e] = await rows<{ event_type: string; payload: Record<string, unknown> }>(
      admin(),
      sql`select event_type, payload from app.events where entity_id = ${r.id}::uuid`,
    );
    expect(e?.event_type).toBe('extension_sign_in.approved');
    expect(JSON.stringify(e?.payload)).not.toContain('42');
  });

  it('refuses on one wrong pick, and on That wasn’t me, for good', async () => {
    const wrong = await start(dale.email);
    expect(await answer(dale, wrong.id, 17)).toEqual({ outcome: 'refused' });
    await expectGone(() => answer(dale, wrong.id, 42));
    expect(await collect(wrong.id, wrong.secret)).toMatchObject({ status: 'refused' });
    const notMe = await start(dale.email);
    expect(await answer(dale, notMe.id, null)).toEqual({ outcome: 'refused' });
    expect(await collect(notMe.id, notMe.secret)).toMatchObject({ status: 'refused' });
  });

  it('lets nobody answer someone else’s, or one past its two minutes', async () => {
    const r = await start(dale.email);
    await expectGone(() => answer(marco, r.id, 42));
    await rows(
      admin(),
      sql`update app.extension_sign_ins set expires_at = now() - interval '1 second' where id = ${r.id}::uuid`,
    );
    expect(await pending(dale)).toEqual([]);
    await expectGone(() => answer(dale, r.id, 42));
    expect(await collect(r.id, r.secret)).toMatchObject({ status: 'expired' });
  });

  it('gives an approval up when it isn’t collected within a minute of running out', async () => {
    const r = await start(dale.email);
    await answer(dale, r.id, 42);
    await rows(
      admin(),
      sql`update app.extension_sign_ins set expires_at = now() - interval '61 seconds' where id = ${r.id}::uuid`,
    );
    expect(await collect(r.id, r.secret)).toMatchObject({ status: 'expired' });
  });
});

describe('the table', () => {
  it('shows people neither the number nor the secret’s hash, and takes no writes from them', async () => {
    const r = await start(dale.email);
    await expectPgError(() =>
      as(dale)((tx) =>
        rows(tx, sql`select number from app.extension_sign_ins where id = ${r.id}::uuid`),
      ),
    );
    await expectPgError(() =>
      as(dale)((tx) => rows(tx, sql`select secret_hash from app.extension_sign_ins`)),
    );
    await expectPgError(() =>
      as(dale)((tx) =>
        rows(
          tx,
          sql`update app.extension_sign_ins set status = 'approved' where id = ${r.id}::uuid`,
        ),
      ),
    );
    // The worker's doors are the worker's.
    await expectPgError(() =>
      as(dale)((tx) =>
        rows(
          tx,
          sql`select * from private.collect_extension_sign_in(${r.id}::uuid, ${hash(r.secret)})`,
        ),
      ),
    );
  });
});
