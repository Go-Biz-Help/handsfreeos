/**
 * Support putting a credit on a business's balance (M16).
 *
 * `wallet.adjust` shipped in step 5 and was callable by **nobody** — it asked for a `platform.*` permission
 * from inside a workspace scope, and a staff role is only ever resolved by a platform scope. Nothing caught it
 * because it had no test and no caller. This is that test.
 *
 * The second half matters as much as the first. The usage ledger is deliberately closed: no insert policy and
 * no insert grant for a signed-in person, and a guard that demands the system's own scope. Re-scoping the
 * command alone would have moved the failure from the permission check to the database and looked just as
 * broken, so the credit goes in through a security-definer function that does its own staff check. What is
 * asserted here is that both doors are shut to everyone except a staff admin, and open to them.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import { organizationCreate, walletAdjust } from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });

let staffAdmin: TestUser;
let agent: TestUser;
let owner: TestUser;
let workspaceId: string;

const beStaff = (u: TestUser, role: 'admin' | 'agent') =>
  admin().execute(
    sql`insert into platform.staff (user_id, role) values (${u.id}, ${role})
        on conflict (user_id) do update set role = ${role}, status = 'active'`,
  );

const credit = (who: TestUser, amountCents: number, reference: string, reason = 'Goodwill') =>
  executeCommand(
    api(),
    walletAdjust,
    { workspaceId, amountCents, reason, reference },
    human(who),
    meta(),
  );

/** What the business's own statement says, which is the only place a credit is supposed to show up. */
async function statement(): Promise<{ kind: string; amount: number; subject: string }[]> {
  return (
    await rows<{ kind: string; amount: number; subject: string }>(
      admin(),
      sql`select kind::text as kind, amount_cents::int as amount, subject
          from app.usage_ledger where workspace_id = ${workspaceId} order by occurred_at, id`,
    )
  ).map((r) => ({ kind: r.kind, amount: Number(r.amount), subject: r.subject }));
}

beforeAll(async () => {
  [staffAdmin, agent, owner] = await Promise.all([
    createTestUser('wallet-staff-admin'),
    createTestUser('wallet-staff-agent'),
    createTestUser('wallet-credit-owner'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Credited Contracting' },
    human(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  await Promise.all([beStaff(staffAdmin, 'admin'), beStaff(agent, 'agent')]);
});
afterAll(closeTestDbs);

describe('a staff admin', () => {
  it('puts a credit on a balance, and it lands on the business’s statement', async () => {
    const { output } = await credit(staffAdmin, 2500, 'ticket-1', 'Sorry about the outage');
    expect(output).toMatchObject({ workspaceId, balanceCents: 2500, recorded: true });
    expect(output.entryId).not.toBeNull();
    expect(await statement()).toEqual([
      { kind: 'credit', amount: 2500, subject: 'Sorry about the outage' },
    ]);
  });

  it('opens a wallet for a business that has never spent anything', async () => {
    // The credit above was the first thing to touch this business's balance; there was no wallet row before it.
    const [w] = await rows<{ balance: number }>(
      admin(),
      sql`select balance_cents::int as balance from app.usage_wallets where workspace_id = ${workspaceId}`,
    );
    expect(Number(w?.balance)).toBe(2500);
  });

  it('counts the same decision once, however many times it is sent', async () => {
    const again = await credit(staffAdmin, 2500, 'ticket-1', 'Sorry about the outage');
    expect(again.output).toMatchObject({ recorded: false, entryId: null, balanceCents: 2500 });
    expect(await statement()).toHaveLength(1);
  });

  it('takes a credit back, which is an adjustment rather than a spend', async () => {
    const { output } = await credit(staffAdmin, -500, 'ticket-2', 'Applied twice');
    expect(output).toMatchObject({ balanceCents: 2000, recorded: true });
    expect((await statement())[1]).toEqual({
      kind: 'adjustment',
      amount: -500,
      subject: 'Applied twice',
    });
  });

  it('never writes the balance itself — the row moves it', async () => {
    const [w] = await rows<{ cached: number; summed: number }>(
      admin(),
      sql`select w.balance_cents::int as cached,
            (select sum(l.amount_cents) from app.usage_ledger l
              where l.workspace_id = ${workspaceId})::int as summed
          from app.usage_wallets w where w.workspace_id = ${workspaceId}`,
    );
    expect(Number(w?.cached)).toBe(Number(w?.summed));
  });
});

describe('everybody else', () => {
  it('refuses the business’s own owner, who could otherwise credit themselves', async () => {
    const e = await credit(owner, 10_000, 'self-serve').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HfosError);
    // Not found rather than forbidden: the support desk does not exist for someone who does not work here.
    expect((e as HfosError).status).toBeGreaterThanOrEqual(400);
    expect(await statement()).toHaveLength(2);
  });

  it('refuses a support agent, who may read a business but not move its money', async () => {
    await expect(credit(agent, 10_000, 'agent-try')).rejects.toBeInstanceOf(HfosError);
    expect(await statement()).toHaveLength(2);
  });

  it('refuses a staff admin asking about a business that does not exist', async () => {
    await expect(
      executeCommand(
        api(),
        walletAdjust,
        {
          workspaceId: '11111111-1111-4111-8111-111111111111',
          amountCents: 100,
          reason: 'Nowhere',
          reference: 'ghost',
        },
        human(staffAdmin),
        meta(),
      ),
    ).rejects.toThrow();
  });
});
