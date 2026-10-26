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
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import { walletRoom } from '../src/money/wallet-gate';
import {
  organizationCreate,
  platformWalletGet,
  usageStatement,
  walletAdjust,
  walletGet,
  walletSetStage,
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
    // On top of the $5 every new business starts with.
    expect(output).toMatchObject({ workspaceId, balanceCents: 3000, recorded: true });
    expect(output.entryId).not.toBeNull();
    expect(await statement()).toEqual([
      { kind: 'credit', amount: 500, subject: 'Starting credit' },
      { kind: 'credit', amount: 2500, subject: 'Sorry about the outage' },
    ]);
  });

  it('finds the wallet the business has had since it was made', async () => {
    const [w] = await rows<{ balance: number }>(
      admin(),
      sql`select balance_cents::int as balance from app.usage_wallets where workspace_id = ${workspaceId}`,
    );
    expect(Number(w?.balance)).toBe(3000);
  });

  it('counts the same decision once, however many times it is sent', async () => {
    const again = await credit(staffAdmin, 2500, 'ticket-1', 'Sorry about the outage');
    expect(again.output).toMatchObject({ recorded: false, entryId: null, balanceCents: 3000 });
    expect(await statement()).toHaveLength(2);
  });

  it('takes a credit back, which is an adjustment rather than a spend', async () => {
    const { output } = await credit(staffAdmin, -500, 'ticket-2', 'Applied twice');
    expect(output).toMatchObject({ balanceCents: 2500, recorded: true });
    expect((await statement())[2]).toEqual({
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
    expect(await statement()).toHaveLength(3);
  });

  it('refuses a support agent, who may read a business but not move its money', async () => {
    await expect(credit(agent, 10_000, 'agent-try')).rejects.toBeInstanceOf(HfosError);
    expect(await statement()).toHaveLength(3);
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

describe('moving a business along the wallet', () => {
  const move = (who: TestUser, stage: 'off' | 'warn' | 'enforce' | 'agency', reason = 'Rollout') =>
    executeCommand(
      api(),
      walletSetStage,
      // Silent is refused at the door; the cast is the old client that still sends it.
      { workspaceId, stage: stage as 'warn', reason },
      human(who),
      meta(),
    );
  const stage = async () => {
    const [w] = await rows<{ stage: string }>(
      admin(),
      sql`select stage::text as stage from app.usage_wallets where workspace_id = ${workspaceId}`,
    );
    return w?.stage;
  };

  it('starts a new business Stopped at zero, and a staff admin moves it to warned and back', async () => {
    expect(await stage()).toBe('enforce');
    expect((await move(staffAdmin, 'warn')).output).toMatchObject({
      was: 'enforce',
      stage: 'warn',
      changed: true,
    });
    expect(await stage()).toBe('warn');
    expect((await move(staffAdmin, 'enforce')).output).toMatchObject({
      was: 'warn',
      changed: true,
    });
    expect(await stage()).toBe('enforce');
    // The same click twice is visibly a no-op.
    expect((await move(staffAdmin, 'enforce')).output.changed).toBe(false);
  });

  it('never moves a business back to Silent, which is gone', async () => {
    await expect(move(staffAdmin, 'off')).rejects.toBeInstanceOf(HfosError);
    // Nor the database, asked directly by the staff admin it would otherwise let through.
    const direct = await asUser(api(), staffAdmin.claims, (tx) =>
      rows(tx, sql`select * from private.set_wallet_stage(${workspaceId}::uuid, 'off')`),
    ).catch((e: unknown) => e);
    let err = direct as { detail?: string; cause?: unknown } | undefined;
    while (err && !err.detail && err.cause) err = err.cause as typeof err;
    expect(err?.detail).toBe('wallet_stage_off_is_gone');
    expect(await stage()).toBe('enforce');
  });

  it('refuses a support agent and the business’s own owner, and the owner writing it directly', async () => {
    await expect(move(agent, 'warn')).rejects.toBeInstanceOf(HfosError);
    await expect(move(owner, 'warn')).rejects.toBeInstanceOf(HfosError);
    expect(await stage()).toBe('enforce');
    const direct = await asUser(api(), owner.claims, (tx) =>
      rows(
        tx,
        sql`update app.usage_wallets set stage = 'warn' where workspace_id = ${workspaceId}`,
      ),
    ).catch((e: unknown) => e);
    expect(direct instanceof Error || (Array.isArray(direct) && direct.length === 0)).toBe(true);
    expect(await stage()).toBe('enforce');
  });
});

describe('a business the agency pays for', () => {
  const move = (stage: 'warn' | 'enforce' | 'agency') =>
    executeCommand(
      api(),
      walletSetStage,
      { workspaceId, stage, reason: 'Our own business' },
      human(staffAdmin),
      meta(),
    );
  /** Usage, written the way the worker writes it: under the system's own scope for this business. */
  const use = (cents: number) =>
    admin().transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.system_scope.workspace_id', ${workspaceId}, true)`,
      );
      await tx.execute(
        sql`insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, cost_cents, subject,
              idempotency_key)
            select ${workspaceId}, organization_id, 'spend', ${-cents}, ${Math.round(cents / 2)}, 'Text to a customer',
                   ${`agency-use-${randomUUID()}`}
            from app.workspaces where id = ${workspaceId}`,
      );
    });
  const balance = async () => {
    const [w] = await rows<{ balance: number }>(
      admin(),
      sql`select balance_cents::int as balance from app.usage_wallets where workspace_id = ${workspaceId}`,
    );
    return Number(w?.balance);
  };

  it('runs up usage, is shown nothing, and is never stopped', async () => {
    await move('enforce');
    const start = await balance();
    await move('agency');
    await use(start + 5_000);
    expect(await balance()).toBe(-5_000);

    // The business: no balance, no statement — the same "nothing yet" as a business not on the wallet.
    const own = await executeQuery(api(), walletGet, { workspaceId }, human(owner), meta());
    expect(own.opened).toBe(false);
    const lines = await executeQuery(api(), usageStatement, { workspaceId }, human(owner), meta());
    expect(lines.items).toEqual([]);
    // Far past any overdraft, and still nothing stops.
    const room = await admin().transaction((tx) => walletRoom(tx, workspaceId, 'text'));
    expect(room).toMatchObject({ allowed: true, stage: 'agency' });

    // The support desk sees where it is, and what it has used.
    const desk = await executeQuery(
      api(),
      platformWalletGet,
      { workspaceId },
      human(staffAdmin),
      meta(),
    );
    expect(desk).toMatchObject({ opened: true, stage: 'agency', balanceCents: -5_000 });
  });

  it('starts from zero when it is moved off, with the agency’s credit on its statement', async () => {
    expect((await move('warn')).output).toMatchObject({ was: 'agency', changed: true });
    expect(await balance()).toBe(0);
    const paid = (await statement()).filter((l) => l.subject === 'Paid by the agency');
    expect(paid).toEqual([{ kind: 'credit', amount: 5_000, subject: 'Paid by the agency' }]);
    const own = await executeQuery(api(), walletGet, { workspaceId }, human(owner), meta());
    expect(own).toMatchObject({ opened: true, balanceCents: 0 });
  });

  it('writes nothing off when there is nothing owed', async () => {
    await move('agency');
    await move('warn');
    expect((await statement()).filter((l) => l.subject === 'Paid by the agency')).toHaveLength(1);
    expect(await balance()).toBe(0);
  });
});
