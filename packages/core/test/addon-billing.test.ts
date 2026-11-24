/**
 * Paying for a paid add-on (20261027028500, the owner's picks of 2026-11-17), through the kernel against the database:
 * a card first, 14 days free the first time, turning it off at the end of what's paid or at once, the worker's monthly
 * charge and its daily retries, and staff giving one free until a date, with Keep it after that.
 *
 * The made-up paid add-on is fxpaid ($29 a month, 14 days free) in ./addons/fixtures.ts. The worker's half (charging
 * the cards, the sweep and the emails) is apps/worker/src/founding/addon-billing.ts; here its answers are recorded the
 * way it records them, as the system.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import {
  addonBillingCommands,
  addonGrantCommands,
  addonLifecycleCommands,
  addonQueries,
  executeCommand,
  executeQuery,
  organizationCreate,
  type Actor,
  type HumanActor,
  type SystemActor,
} from '../src/server';
import { FIXTURE_CATALOG, FIXTURE_MODULES } from './addons/fixtures';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

const lifecycle = addonLifecycleCommands(FIXTURE_CATALOG, FIXTURE_MODULES);
const billing = addonBillingCommands(FIXTURE_CATALOG);
const grants = addonGrantCommands(FIXTURE_CATALOG);
const queries = addonQueries(FIXTURE_CATALOG);
const DAY = 86_400_000;

let owner: TestUser;
let staff: TestUser;
let ws: string;
let org: string;

const system = (): SystemActor => ({ type: 'system', workspaceId: ws, organizationId: org });
const dbOf = (a: Actor) => (a.type === 'human' ? api() : worker());
const run = (cmd: Parameters<typeof executeCommand>[1], input: unknown, actor: Actor) =>
  executeCommand(dbOf(actor), cmd, input, actor, meta()).then((r) => r.output as never);

async function ruleOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof HfosError ? (e.rule ?? e.code) : String(e);
  }
  throw new Error('It was allowed.');
}

type Sub = {
  status: string;
  trial_ends_at: Date | null;
  paid_through: Date | null;
  next_charge_at: Date | null;
  stop_at: Date | null;
  retry_count: number;
  next_retry_at: Date | null;
  charge_count: number;
  end_reason: string | null;
};
const sub = async (): Promise<Sub | undefined> =>
  (
    await rows<Sub>(
      admin(),
      sql`select status, trial_ends_at, paid_through, next_charge_at, stop_at, retry_count, next_retry_at,
                 charge_count, end_reason
            from app.addon_subscriptions where workspace_id = ${ws}::uuid and addon_id = 'fxpaid'`,
    )
  )[0];
const standing = async () => {
  const list = await executeQuery(api(), queries.list, { workspaceId: ws }, human(owner), meta());
  return (
    list.installed.find((i) => i.addonId === 'fxpaid') ??
    list.catalog.find((c) => c.addonId === 'fxpaid')
  )?.standing;
};
const finishMove = (state: string) =>
  admin().execute(
    sql`update app.addon_installations set state = ${state}
         where workspace_id = ${ws}::uuid and addon_id = 'fxpaid'`,
  );
const move = async (action: 'install' | 'enable' | 'disable') => {
  await run(lifecycle[action], { workspaceId: ws, addonId: 'fxpaid', include: [] }, human(owner));
  await finishMove(action === 'disable' ? 'disabled' : 'enabled');
};
/** Its month comes due now: as if the trial or the paid month ran out a minute ago. */
const dueNow = () =>
  admin().execute(
    sql`update app.addon_subscriptions
           set next_charge_at = now() - interval '1 minute',
               trial_ends_at = case when status = 'trial' then now() - interval '1 minute' else trial_ends_at end
         where workspace_id = ${ws}::uuid and addon_id = 'fxpaid'`,
  );
const record = async (outcome: 'paid' | 'failed', attempt = 0) => {
  const s = await sub();
  return run(
    billing.recordCharge,
    {
      workspaceId: ws,
      addonId: 'fxpaid',
      dueAt: new Date(s!.next_charge_at!).toISOString(),
      attempt,
      outcome,
      paymentRef: outcome === 'paid' ? `pi_${randomUUID()}` : null,
      problem: outcome === 'failed' ? 'Your card was declined.' : null,
    },
    system(),
  ) as Promise<{ outcome: string }>;
};

beforeAll(async () => {
  [owner, staff] = await Promise.all([
    createTestUser('addon-billing-owner'),
    createTestUser('addon-billing-staff'),
  ]);
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Lone Star Payroll' },
    human(owner),
    meta(),
  );
  ws = made.output.workspaceId;
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}::uuid`,
  );
  org = w!.organization_id;
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
});
afterAll(closeTestDbs);

describe('adding a paid add-on', () => {
  it('shows its price before it’s added', async () => {
    expect(await standing()).toEqual({
      kind: 'unpaid',
      priceCents: 2900,
      paidThrough: null,
      trialLeft: true,
    });
  });

  it('needs a card first, even for the free trial, and charges nothing then', async () => {
    expect(
      await ruleOf(
        run(lifecycle.install, { workspaceId: ws, addonId: 'fxpaid', include: [] }, human(owner)),
      ),
    ).toBe('addon_needs_card');
    expect(await sub()).toBeUndefined();
  });

  it('starts 14 days free once there’s a card', async () => {
    await admin().execute(
      sql`insert into app.plan_cards (workspace_id, organization_id, customer_ref, card_ref, is_default)
          values (${ws}::uuid, ${org}::uuid, 'cus_test', ${`pm_${randomUUID()}`}, true)`,
    );
    await move('install');
    const s = await sub();
    expect(s).toMatchObject({ status: 'trial', charge_count: 0, stop_at: null });
    const days = (new Date(s!.trial_ends_at!).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    expect(new Date(s!.next_charge_at!).getTime()).toBe(new Date(s!.trial_ends_at!).getTime());
    expect(await standing()).toMatchObject({ kind: 'trial', priceCents: 2900, stopAt: null });
  });
});

describe('turning it off at the end of what’s paid', () => {
  it('runs to the end of the trial, charges nothing, and Keep it undoes that', async () => {
    const stopped = (await run(
      billing.stop,
      { workspaceId: ws, addonId: 'fxpaid' },
      human(owner),
    )) as { stopAt: string };
    const s = await sub();
    expect(new Date(stopped.stopAt).getTime()).toBe(new Date(s!.trial_ends_at!).getTime());
    expect(s).toMatchObject({ status: 'trial', next_charge_at: null });
    expect(await standing()).toMatchObject({ kind: 'trial', stopAt: stopped.stopAt });

    const kept = (await run(
      billing.keep,
      { workspaceId: ws, addonId: 'fxpaid' },
      human(owner),
    )) as {
      nextChargeAt: string;
    };
    expect(kept.nextChargeAt).toBe(stopped.stopAt);
    expect((await sub())!.stop_at).toBeNull();
    expect(
      await ruleOf(run(billing.keep, { workspaceId: ws, addonId: 'fxpaid' }, human(owner))),
    ).toBe('addon_billing_not_stopping');
  });
});

describe('the monthly charge', () => {
  it('moves the month on and keeps the payment, once, when it’s paid', async () => {
    await dueNow();
    const due = new Date((await sub())!.next_charge_at!).getTime();
    expect(await record('paid')).toMatchObject({ outcome: 'recorded' });
    const s = await sub();
    expect(s).toMatchObject({ status: 'active', charge_count: 1 });
    const next = new Date(s!.next_charge_at!);
    expect(next.getTime()).toBeGreaterThan(due + 27 * DAY);
    expect(new Date(s!.paid_through!).getTime()).toBe(next.getTime());
    const [paid] = await rows<{ n: number; cents: number }>(
      admin(),
      sql`select count(*)::int as n, max(amount_cents)::int as cents from app.addon_charges
           where workspace_id = ${ws}::uuid and addon_id = 'fxpaid'`,
    );
    expect(paid).toEqual({ n: 1, cents: 2900 });
    // The same answer again, or one about a month that's no longer due, changes nothing.
    expect(
      await run(
        billing.recordCharge,
        {
          workspaceId: ws,
          addonId: 'fxpaid',
          dueAt: new Date(due).toISOString(),
          attempt: 0,
          outcome: 'paid',
        },
        system(),
      ),
    ).toMatchObject({ outcome: 'already' });
  });

  it('is past due when it’s refused, tries again daily, and says so', async () => {
    await dueNow();
    expect(await record('failed')).toMatchObject({ outcome: 'recorded' });
    let s = await sub();
    expect(s).toMatchObject({ status: 'past_due', retry_count: 0 });
    expect(new Date(s!.next_retry_at!).getTime()).toBeGreaterThan(Date.now());
    expect(await standing()).toMatchObject({
      kind: 'past_due',
      priceCents: 2900,
      problem: 'Your card was declined.',
    });
    // Turning it off at the end of the month isn't offered while it's owed.
    expect(
      await ruleOf(run(billing.stop, { workspaceId: ws, addonId: 'fxpaid' }, human(owner))),
    ).toBe('addon_billing_owing');
    // A first try again is refused as the second answer of the month; the retry's own number counts.
    expect(await record('failed', 0)).toMatchObject({ outcome: 'already' });
    expect(await record('failed', 1)).toMatchObject({ outcome: 'recorded' });
    s = await sub();
    expect(s!.retry_count).toBe(1);
    // …and a retry that goes through puts it back to paid.
    expect(await record('paid', 2)).toMatchObject({ outcome: 'recorded' });
    expect(await sub()).toMatchObject({ status: 'active', retry_count: 0, next_retry_at: null });
  });
});

describe('turning it off at once', () => {
  it('stops charging, keeps the month paid, and charges nothing turning back on before it runs out', async () => {
    const before = await sub();
    await move('disable');
    expect(await sub()).toMatchObject({
      status: 'ended',
      next_charge_at: null,
      end_reason: 'turned_off',
    });
    expect(await standing()).toMatchObject({ kind: 'unpaid', trialLeft: false });
    await move('enable');
    const after = await sub();
    expect(after!.status).toBe('active');
    expect(new Date(after!.next_charge_at!).getTime()).toBe(
      new Date(before!.paid_through!).getTime(),
    );
    expect(after!.charge_count).toBe(before!.charge_count);
  });
});

describe('staff giving it free', () => {
  it('refuses a last free day that has passed', async () => {
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    expect(
      await ruleOf(
        run(
          grants.give,
          { workspaceId: ws, addonId: 'fxpaid', freeUntil: yesterday },
          human(staff),
        ),
      ),
    ).toBe('addon_grant_past');
  });

  it('stops what the business pays, and says it’s free until the day after its last free day', async () => {
    const lastDay = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    await run(
      grants.give,
      { workspaceId: ws, addonId: 'fxpaid', freeUntil: lastDay, note: 'Founding member thanks' },
      human(staff),
    );
    expect(await sub()).toMatchObject({ status: 'ended', end_reason: 'gift' });
    const until = new Date(Date.parse(`${lastDay}T00:00:00Z`) + DAY).toISOString();
    expect(await standing()).toEqual({
      kind: 'gift',
      until,
      keepsAfter: false,
      priceCents: 2900,
    });
  });

  it('keeps it after the gift ends when the business chooses, first charged that day', async () => {
    const kept = (await run(
      billing.keep,
      { workspaceId: ws, addonId: 'fxpaid' },
      human(owner),
    )) as {
      nextChargeAt: string;
    };
    const s = await sub();
    expect(s!.status).toBe('active');
    expect(new Date(s!.next_charge_at!).toISOString()).toBe(kept.nextChargeAt);
    expect(await standing()).toMatchObject({ kind: 'gift', keepsAfter: true });
  });

  it('turns off a paid one nobody pays for once the gift is taken back, keeping its data', async () => {
    // Not kept this time: as though the business never pressed Keep it after that.
    await admin().execute(
      sql`update app.addon_subscriptions set status = 'ended', next_charge_at = null, end_reason = 'gift'
           where workspace_id = ${ws}::uuid and addon_id = 'fxpaid'`,
    );
    await run(grants.takeBack, { workspaceId: ws, addonId: 'fxpaid' }, human(staff));
    // What the worker's hourly sweep finds.
    const [unpaid] = await rows<{ addon_id: string; reason: string }>(
      admin(),
      sql`select addon_id, reason from private.addon_unpaid_running(array['fxpaid'], 100)
           where workspace_id = ${ws}::uuid`,
    );
    expect(unpaid).toMatchObject({ addon_id: 'fxpaid', reason: 'gift' });
    expect(
      await run(billing.turnOff, { workspaceId: ws, addonId: 'fxpaid', reason: 'gift' }, system()),
    ).toEqual({ addonId: 'fxpaid', turnedOff: true });
    const [inst] = await rows<{ state: string }>(
      admin(),
      sql`select state from app.addon_installations
           where workspace_id = ${ws}::uuid and addon_id = 'fxpaid'`,
    );
    expect(inst!.state).toMatch(/^(disabling|disabled)$/);
    // A second time, nothing more.
    expect(
      await run(billing.turnOff, { workspaceId: ws, addonId: 'fxpaid', reason: 'gift' }, system()),
    ).toEqual({ addonId: 'fxpaid', turnedOff: false });
  });
});
