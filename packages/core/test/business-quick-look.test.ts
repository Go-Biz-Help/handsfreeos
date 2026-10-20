/**
 * The directory's quick look (20261027009700): one business at a glance, and what needs a look.
 *
 * Support reads none of these tables under the ordinary rules, so every answer comes from a security-definer function
 * that checks the permission itself. What is asserted here is that staff get the glance and the flags, that the
 * directory's Needs a look order holds exactly the businesses with something to look at, and that nobody else gets
 * anything, not even the business's own owner calling the function directly.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import { money } from '../src/money/index';
import {
  deskBusinessFlags,
  organizationCreate,
  platformBusinessGet,
  platformBusinessGlance,
  platformBusinessList,
  platformWalletGet,
  walletAdjust,
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

let staffAgent: TestUser;
let staffAdmin: TestUser;
let owner: TestUser;
let troubled: string;
let calm: string;

const business = async (name: string) =>
  (await executeCommand(api(), organizationCreate, { businessName: name }, human(owner), meta()))
    .output.workspaceId;

const glance = (workspaceId: string, who = staffAgent) =>
  executeQuery(api(), platformBusinessGlance, { workspaceId }, human(who), meta());

beforeAll(async () => {
  [staffAgent, staffAdmin, owner] = await Promise.all([
    createTestUser('quick-look-agent'),
    createTestUser('quick-look-admin'),
    createTestUser('quick-look-owner'),
  ]);
  await admin().execute(
    sql`insert into platform.staff (user_id, role)
        values (${staffAgent.id}, 'agent'), (${staffAdmin.id}, 'admin')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
  troubled = await business(`Quick Look Troubled ${randomUUID().slice(0, 8)}`);
  calm = await business(`Quick Look Calm ${randomUUID().slice(0, 8)}`);
  // A balance they are shown, run out, on a card that keeps being declined.
  await executeCommand(
    api(),
    walletAdjust,
    {
      workspaceId: troubled,
      amountCents: -300,
      reason: 'Opening the balance',
      reference: randomUUID(),
    },
    human(staffAdmin),
    meta(),
  );
  // The stage is HandsFreeOS's to write: the system scope, as its own commands do.
  await admin().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_scope.workspace_id', ${troubled}, true)`);
    await tx.execute(
      sql`update app.usage_wallets set stage = 'warn', declines_in_row = 2 where workspace_id = ${troubled}`,
    );
  });
});
afterAll(closeTestDbs);

describe('a support person', () => {
  it('sees a new business at a glance, with nothing to look at', async () => {
    const g = await glance(calm);
    expect(g.attention).toEqual([]);
    expect(g.activity).toHaveLength(30);
    // Making the business is something that happened today.
    expect(g.activity[29]).toBeGreaterThan(0);
    expect(g.traffic).toEqual({ texts: 0, calls: 0, emails: 0, aiReplies: 0 });
    expect(g.theirMoney).toMatchObject({ collected30dCents: 0, openInvoices: 0, openDisputes: 0 });
    expect(g.setup).toMatchObject({ numbers: [], registration: null, payments: [], meta: null });
    expect(g.more).toMatchObject({ cameFrom: null, addons: [], lastViewedAs: null });
    expect(g.problemReports).toEqual({ open: 0, recent: [] });
  });

  it('is told what needs a look, most serious first, in the words of what the request knows', async () => {
    const g = await glance(troubled);
    expect(g.attention).toEqual(['card_declined', 'balance_out']);
    const wallet = await executeQuery(
      api(),
      platformWalletGet,
      { workspaceId: troubled },
      human(staffAgent),
      meta(),
    );
    const detail = await executeQuery(
      api(),
      platformBusinessGet,
      { workspaceId: troubled },
      human(staffAgent),
      meta(),
    );
    expect(detail.business.attention).toEqual(['card_declined', 'balance_out']);
    const flags = deskBusinessFlags({ ...detail.business, tickets: detail.tickets }, g, wallet);
    expect(flags.map((f) => [f.key, f.tone, f.tab])).toEqual([
      ['card_declined', 'danger', 'money'],
      ['balance_out', 'warning', 'money'],
    ]);
    expect(flags[0]?.text).toContain('2 times in a row');
    expect(flags[0]?.text).toContain(money(-300));
  });

  it('finds the troubled business under Needs a look, and not the calm one', async () => {
    const list = await executeQuery(
      api(),
      platformBusinessList,
      { search: 'Quick Look', sort: 'attention', limit: 25 },
      human(staffAgent),
      meta(),
    );
    const ids = list.businesses.map((b) => b.workspaceId);
    expect(ids).toContain(troubled);
    expect(ids).not.toContain(calm);
    const everyone = await executeQuery(
      api(),
      platformBusinessList,
      { search: 'Quick Look', sort: 'newest', limit: 25 },
      human(staffAgent),
      meta(),
    );
    expect(everyone.businesses.find((b) => b.workspaceId === calm)?.attention).toEqual([]);
  });
});

describe('everybody else', () => {
  it('refuses the business’s own owner the query', async () => {
    const e = await glance(troubled, owner).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HfosError);
  });

  it('gives the owner nothing from the functions themselves', async () => {
    const [r] = await asUser(api(), owner.claims, (tx) =>
      rows<{ glance: unknown; attention: unknown; plan: unknown }>(
        tx,
        sql`select private.admin_business_glance(${troubled}::uuid) as glance,
              private.admin_business_attention(${troubled}::uuid) as attention,
              private.admin_business_plan(${troubled}::uuid) as plan`,
      ),
    );
    expect(r).toEqual({ glance: null, attention: null, plan: null });
  });
});
