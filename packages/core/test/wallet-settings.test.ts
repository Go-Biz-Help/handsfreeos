/**
 * The four settings and the two buttons a business owns on its own balance, on a business that has never
 * spent anything (M16).
 *
 * That last clause is the whole test. A wallet row is opened by the first thing that needs one, so until a
 * business sends its first text there is no row — and `wallet.set_auto_topup`, `wallet.forget_card` and
 * `wallet.top_up` each open one lazily before they write. Run as the person pressing the button, that insert
 * was refused: `authenticated` has no INSERT privilege on `app.usage_wallets` and there is no insert policy
 * for one, so the refusal came back as a bare 42501 — "You do not have permission to do that." — to an owner
 * who had every permission there is. Setting a top-up amount on a new business failed, and said the wrong
 * thing about why.
 *
 * None of the four had a test, which is why it shipped. The fix is `private.open_usage_wallet` (0094): one
 * security-definer function that checks `money.manage` for itself and writes defaults and only defaults. So
 * what is asserted here is both halves — that the press works, and that the wallet it opens is the one
 * every business starts with: nothing spent, no card, and `stage` where HandsFreeOS puts it rather than
 * anywhere its owner named.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import {
  organizationCreate,
  walletForgetCard,
  walletSetAutoTopup,
  walletTopUp,
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

let owner: TestUser;
let member: TestUser;
let workspaceId: string;

const settings = (who: TestUser, patch: Record<string, unknown>) =>
  executeCommand(api(), walletSetAutoTopup, { workspaceId, ...patch }, human(who), meta());

/** The wallet row as the database holds it, or null while the business has never touched its balance. */
async function walletRow() {
  const [row] = await rows<{
    stage: string;
    balance_cents: number;
    auto_topup: boolean;
    floor_cents: number;
    topup_cents: number;
    method_token: string | null;
  }>(
    admin(),
    sql`select stage::text as stage, balance_cents::int as balance_cents, auto_topup,
          floor_cents::int as floor_cents, topup_cents::int as topup_cents, method_token
        from app.usage_wallets where workspace_id = ${workspaceId}`,
  );
  return row ?? null;
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('wallet-settings-owner', { fullName: 'Dale Owner' }),
    createTestUser('wallet-settings-marco', { fullName: 'Marco Tech' }),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Never Spent Anything Plumbing' },
    human(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('a business that has never spent anything', () => {
  it('has no wallet at all until somebody touches its balance', async () => {
    expect(await walletRow()).toBeNull();
  });

  it('lets its owner set the top-up amount, which opens the wallet', async () => {
    const { output } = await settings(owner, { floorCents: 1000, topupCents: 2500 });
    expect(output).toMatchObject({ workspaceId, floorCents: 1000, topupCents: 2500 });
    expect(await walletRow()).toMatchObject({ floor_cents: 1000, topup_cents: 2500 });
  });

  it('opens it the way every business starts, with nothing its owner chose', async () => {
    const w = await walletRow();
    // Nothing spent and no card, the two things a person must never be able to hand themselves — and
    // `stage` where a new business begins. Which stage a business is on is HandsFreeOS's to set (the
    // update guard says so in those words); naming it on the way in would be naming it all the same.
    expect(w).toMatchObject({ stage: 'off', balance_cents: 0 });
    expect(w?.method_token).toBeNull();
    // Meaning to top itself up from the start, which is the table's own default and the kind one: a
    // business that runs out mid-job did not choose to. It charges nothing until there is a card.
    expect(w?.auto_topup).toBe(true);
  });
});

describe('the rules that were hidden behind the refusal', () => {
  it('says there is no card, rather than refusing the press, when auto top-up is set', async () => {
    const e = await settings(owner, { autoTopup: true, topupCents: 9999 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule).toBe('wallet_no_card');
    expect((e as HfosError).status).toBe(409);
    // The whole press is refused, not the half of it the rule was about.
    expect((await walletRow())?.topup_cents).toBe(2500);
  });

  it('says there is no card to charge, rather than refusing the press, on Top up', async () => {
    const e = await executeCommand(
      api(),
      walletTopUp,
      { workspaceId, amountCents: 2500 },
      human(owner),
      meta(),
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule).toBe('wallet_no_card');
  });

  it('takes a card off a wallet that has none quietly, rather than refusing', async () => {
    const { output } = await executeCommand(
      api(),
      walletForgetCard,
      { workspaceId },
      human(owner),
      meta(),
    );
    expect(output).toMatchObject({ workspaceId, hasCard: false });
  });
});

describe('a member', () => {
  it('may not set what the business spends, wallet or no wallet', async () => {
    const e = await settings(member, { topupCents: 100_000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).code).toBe('forbidden');
    // And nothing of theirs landed.
    expect((await walletRow())?.topup_cents).toBe(2500);
  });
});
