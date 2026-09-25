/**
 * Who bills into which account (0105): an account open to everyone who bills, one kept to the people it names,
 * and one kept to them that also keeps them to it. Checked where a person picks an account for an invoice or a
 * plan — by the commands in words, and by the database whatever path a write takes.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  invoiceCreate,
  invoiceGet,
  invoiceList,
  invoiceUpdate,
  paymentConnectionActivate,
  paymentConnectionList,
  paymentConnectionSetAccess,
  personCreate,
  subscriptionSetConnection,
  subscriptionStart,
} from '../src/server';
import { admin, ask, expectHfos, run, runSystem, setupTeam, type Team } from './calendar-helpers';

let t: Team;
let personId: string;
let main: string;
let seo: string;
let automations: string;
let reconnected: string;
const line = [{ name: 'Work', quantity: 1, unitPriceCents: 10_000, taxable: false }];

/** A connected account, as the worker leaves one after the sign-in. */
async function account(label: string, provider: 'stripe' | 'square', isDefault = false) {
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.payment_connections (workspace_id, provider, environment, status,
          external_account_id, label, display_name, token_enc, token_key_id, connected_at, is_default)
        values (${t.wsId}, ${provider}::app.payment_provider, 'live', 'active', ${`acct_${randomUUID()}`},
          ${label}, ${label}, 'sealed', 'key-1', now(), ${isDefault})
        returning id`,
  );
  return row!.id;
}

const invoiceFor = (u: Team['owner'], connectionId?: string) =>
  run(
    invoiceCreate,
    { workspaceId: t.wsId, personId, lines: line, ...(connectionId ? { connectionId } : {}) },
    u,
  );
const access = (connectionId: string, usedBy: string, userIds: string[] = []) =>
  run(paymentConnectionSetAccess, { workspaceId: t.wsId, connectionId, usedBy, userIds }, t.owner);
const paidInto = async (invoiceId: string) =>
  (await ask(invoiceGet, { workspaceId: t.wsId, invoiceId }, t.owner)).invoice.connectionId;

beforeAll(async () => {
  t = await setupTeam('payment-access');
  // Priya and Marco bill too: admins, as a team where everyone bills would have them.
  await rows(
    admin(),
    sql`update app.workspace_memberships set role = 'admin'
        where workspace_id = ${t.wsId} and user_id in (${t.priya.id}, ${t.marco.id})`,
  );
  ({ personId } = await run(
    personCreate,
    { workspaceId: t.wsId, firstName: 'Client', lastName: 'Co' },
    t.owner,
  ));
  main = await account('Main', 'stripe', true);
  seo = await account('SEO', 'stripe');
  automations = await account('Automations', 'square');
});
afterAll(closeTestDbs);

describe('who bills into which account', () => {
  it('starts with every account open to everyone who bills', async () => {
    const { connections } = await ask(paymentConnectionList, { workspaceId: t.wsId }, t.priya);
    expect(connections.map((c) => [c.label, c.usedBy, c.usableByMe])).toEqual([
      ['Main', 'everyone', true],
      ['SEO', 'everyone', true],
      ['Automations', 'everyone', true],
    ]);
    const made = await invoiceFor(t.priya);
    expect(await paidInto(made.invoiceId)).toBe(main);
  });

  it('keeps an account to the people it names', async () => {
    await access(seo, 'chosen', [t.priya.id]);
    expect((await invoiceFor(t.priya, seo)).invoiceId).toBeTruthy();
    await expectHfos(() => invoiceFor(t.marco, seo), 'payment_account_not_yours');
    // Not even the owner, until they add themselves.
    await expectHfos(() => invoiceFor(t.owner, seo), 'payment_account_not_yours');
    const { connections } = await ask(paymentConnectionList, { workspaceId: t.wsId }, t.marco);
    expect(connections.find((c) => c.id === seo)).toMatchObject({
      usedBy: 'chosen',
      userIds: [t.priya.id],
      usableByMe: false,
    });
  });

  it('keeps people to their own accounts when it says only theirs', async () => {
    await access(automations, 'only_theirs', [t.marco.id]);
    // Marco's invoice goes to his account, not the default he may no longer use.
    const made = await invoiceFor(t.marco);
    expect(await paidInto(made.invoiceId)).toBe(automations);
    await expectHfos(() => invoiceFor(t.marco, main), 'payment_account_not_yours');
    // Everyone else still has the main account, and not Marco's.
    expect(await paidInto((await invoiceFor(t.priya)).invoiceId)).toBe(main);
    await expectHfos(() => invoiceFor(t.priya, automations), 'payment_account_not_yours');
  });

  it('refuses moving a draft onto an account that isn’t theirs', async () => {
    const made = await invoiceFor(t.priya);
    await expectHfos(
      () =>
        run(
          invoiceUpdate,
          {
            workspaceId: t.wsId,
            invoiceId: made.invoiceId,
            personId,
            lines: line,
            connectionId: automations,
            baseRevision: made.revision,
          },
          t.priya,
        ),
      'payment_account_not_yours',
    );
  });

  it('refuses a sign-in that was started and never finished, which could never take the money', async () => {
    const [started] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.payment_connections (workspace_id, provider, environment, status)
          values (${t.wsId}, 'stripe', 'live', 'pending') returning id`,
    );
    await expectHfos(
      () => invoiceFor(t.owner, started!.id),
      'payment_connection_not_connected',
      409,
    );
    // Nor is it where an invoice lands when nobody names one.
    expect(await paidInto((await invoiceFor(t.owner)).invoiceId)).toBe(main);
    await rows(admin(), sql`delete from app.payment_connections where id = ${started!.id}`);
  });

  it('refuses the same in the database, whatever writes it as a person', async () => {
    const made = await invoiceFor(t.priya);
    const err = await expectPg(() =>
      admin().transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: t.priya.id, role: 'authenticated' })}, true)`,
        );
        await tx.execute(
          sql`update app.invoices set connection_id = ${automations} where id = ${made.invoiceId}`,
        );
      }),
    );
    expect(err).toMatch(/kept for other people/);
  });

  it('tells somebody with no account of their own to ask for one, or gives them the one they have', async () => {
    await access(main, 'chosen', [t.owner.id]);
    await access(seo, 'chosen', [t.owner.id]);
    await expectHfos(() => invoiceFor(t.priya), 'no_payment_account');
    await access(seo, 'chosen', [t.priya.id, t.owner.id]);
    expect(await paidInto((await invoiceFor(t.priya)).invoiceId)).toBe(seo);
  });

  it('gives a plan a person sells an account they may use', async () => {
    const { subscriptionId } = await run(
      subscriptionStart,
      { workspaceId: t.wsId, personId, planName: 'SEO retainer', priceCents: 50_000 },
      t.priya,
    );
    const [plan] = await rows<{ connection_id: string }>(
      admin(),
      sql`select connection_id from app.subscriptions where id = ${subscriptionId}`,
    );
    expect(plan!.connection_id).toBe(seo);
    await expectHfos(
      () =>
        run(
          subscriptionStart,
          {
            workspaceId: t.wsId,
            personId,
            planName: 'Automations care',
            priceCents: 30_000,
            connectionId: automations,
          },
          t.priya,
        ),
      'payment_account_not_yours',
    );
  });

  it('opens an account to everyone again, and a reconnect keeps who uses it', async () => {
    await access(main, 'everyone');
    expect(await paidInto((await invoiceFor(t.priya)).invoiceId)).toBe(main);
    // Marco's account signs in again: the new connection is still his alone.
    const [old] = await rows<{ external_account_id: string }>(
      admin(),
      sql`select external_account_id from app.payment_connections where id = ${automations}`,
    );
    const [fresh] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.payment_connections (workspace_id, provider, environment, status)
          values (${t.wsId}, 'square', 'live', 'pending') returning id`,
    );
    await runSystem(
      paymentConnectionActivate,
      {
        workspaceId: t.wsId,
        connectionId: fresh!.id,
        externalAccountId: old!.external_account_id,
        tokenEnc: 'sealed-again',
        tokenKeyId: 'key-1',
      },
      t.scope,
    );
    const [again] = await rows<{ used_by: string; user_ids: string[] }>(
      admin(),
      sql`select used_by::text, user_ids from app.payment_connections where id = ${fresh!.id}`,
    );
    expect(again).toEqual({ used_by: 'only_theirs', user_ids: [t.marco.id] });
    reconnected = fresh!.id;
  });

  it('splits the invoices up by the account they are paid into, across a reconnect', async () => {
    const list = async (connectionId: string | null) =>
      (
        await ask(invoiceList, { workspaceId: t.wsId, connectionId, limit: 100 }, t.owner)
      ).invoices.map((i) => i.connectionId);
    const marcos = await list(reconnected);
    expect(marcos.length).toBeGreaterThan(0);
    // Everything Marco billed before the reconnect is still his account's.
    expect(new Set(marcos)).toEqual(new Set([automations]));
    expect(new Set(await list(seo))).toEqual(new Set([seo]));
    const [none] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.invoices (workspace_id, public_ref, person_id, purpose, origin, total_cents)
          values (${t.wsId}, private.new_public_ref(), ${personId}, 'standard', 'staff', 0) returning id`,
    );
    expect(await list(null)).toEqual([null]);
    expect(none).toBeTruthy();
  });

  it('leaves a plan on the account it already uses, whoever saves it', async () => {
    const { subscriptionId } = await run(
      subscriptionStart,
      {
        workspaceId: t.wsId,
        personId,
        planName: 'Care plan',
        priceCents: 9_900,
        connectionId: seo,
      },
      t.owner,
    );
    const move = (connectionId: string) =>
      run(
        subscriptionSetConnection,
        { workspaceId: t.wsId, subscriptionId, connectionId },
        t.marco,
      );
    // Not Marco's account, but nothing changes: the plan stays where it is.
    await expect(move(seo)).resolves.toMatchObject({ subscriptionId });
    await expectHfos(() => move(main), 'payment_account_not_yours');
  });

  it('keeps somebody who has left on an account until they are taken off', async () => {
    await access(seo, 'chosen', [t.priya.id, t.owner.id]);
    await rows(
      admin(),
      sql`delete from app.workspace_memberships where workspace_id = ${t.wsId} and user_id = ${t.priya.id}`,
    );
    try {
      // Adding someone else still saves with her on it, and she can be taken off…
      await access(seo, 'chosen', [t.priya.id, t.owner.id, t.marco.id]);
      await access(seo, 'chosen', [t.owner.id, t.marco.id]);
      // …but not put back while she's gone.
      await expectHfos(
        () => access(seo, 'chosen', [t.owner.id, t.marco.id, t.priya.id]),
        'validation',
      );
    } finally {
      await rows(
        admin(),
        sql`insert into app.workspace_memberships (workspace_id, user_id, role)
            values (${t.wsId}, ${t.priya.id}, 'admin')`,
      );
    }
  });

  it('never keeps an account to nobody, or to somebody outside the business', async () => {
    await expectHfos(() => access(seo, 'chosen', []), 'validation');
    await expectHfos(() => access(seo, 'chosen', [randomUUID()]), 'validation');
  });
});

/** The database's own refusal, as the message it raised. */
async function expectPg(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ''} ${err.cause?.message ?? ''}`;
  }
  throw new Error('expected the database to refuse');
}
