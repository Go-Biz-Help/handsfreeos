/**
 * The affiliate program, part 1 (20261027014000), through the command pipeline: applying, staff deciding and setting
 * shares, and a business made through an affiliate's link being credited to them as it's made, and only then.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  affiliateApply,
  affiliateDecide,
  affiliateMine,
  affiliateSetBusiness,
  affiliateSetCode,
  affiliateSetRate,
  affiliateSetStatus,
  affiliatesSaveSettings,
  organizationCreate,
  platformAffiliate,
  platformAffiliateOfBusiness,
  platformAffiliates,
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
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

async function refusal(fn: () => Promise<unknown>): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    return e as HfosError;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

const suffix = randomUUID().slice(0, 6);
const codeFor = (who: string) => `${who}-${suffix}`;

let dana: TestUser;
let riley: TestUser;
let buyer: TestUser;
let staff: TestUser;
let agent: TestUser;

beforeAll(async () => {
  [dana, riley, buyer, staff, agent] = await Promise.all([
    createTestUser('affiliate-dana', { fullName: 'Dana Seller' }),
    createTestUser('affiliate-riley', { fullName: 'Riley Seller' }),
    createTestUser('affiliate-buyer', { fullName: 'Bo Buyer' }),
    createTestUser('affiliate-staff'),
    createTestUser('affiliate-agent'),
  ]);
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin'), (${agent.id}, 'agent')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
});

afterAll(async () => {
  await admin().execute(sql`update platform.affiliate_settings set rate_bp = 4000 where id`);
  await closeTestDbs();
});

beforeEach(async () => {
  await admin().execute(
    sql`delete from platform.affiliates where user_id in (${dana.id}, ${riley.id}, ${buyer.id})`,
  );
});

const apply = (u: TestUser, code: string, extra: Record<string, unknown> = {}) =>
  run(
    affiliateApply,
    { name: 'Dana Seller', code, pitch: 'My podcast', links: '', livesInUs: true, ...extra },
    u,
  );

async function approved(u: TestUser, code: string): Promise<string> {
  const { affiliateId } = await apply(u, code);
  await run(affiliateDecide, { affiliateId, decision: 'approve' }, staff);
  return affiliateId;
}

describe('applying', () => {
  it('keeps what they said, lowercases the code, and shows it on their own page', async () => {
    const code = codeFor('Dana');
    const out = await apply(dana, code);
    expect(out.created).toBe(true);
    const { affiliate, defaultRateBp } = await ask(affiliateMine, {}, dana);
    expect(affiliate).toMatchObject({
      status: 'applied',
      code: code.toLowerCase(),
      pitch: 'My podcast',
      rateBp: defaultRateBp,
      clicks30: 0,
    });
    // Nobody else's page shows it.
    expect((await ask(affiliateMine, {}, riley)).affiliate).toBeNull();
  });

  it('changes the application while it waits, and refuses once decided', async () => {
    const { affiliateId } = await apply(dana, codeFor('dana'));
    const again = await apply(dana, codeFor('dana2'), { pitch: 'Videos too' });
    expect(again).toEqual({ affiliateId, created: false });
    await run(affiliateDecide, { affiliateId, decision: 'approve' }, staff);
    const e = await refusal(() => apply(dana, codeFor('dana3')));
    expect(e.rule).toBe('affiliate_already');
  });

  it('refuses outside the US, a kept word, and a code somebody else has', async () => {
    expect((await refusal(() => apply(dana, codeFor('d'), { livesInUs: false }))).rule).toBe(
      'affiliate_outside_us',
    );
    expect((await refusal(() => apply(dana, 'support'))).code).toBe('validation');
    await apply(dana, codeFor('taken'));
    expect((await refusal(() => apply(riley, codeFor('TAKEN')))).rule).toBe('affiliate_code_taken');
  });

  it('a turned-down person waits 30 days to apply again', async () => {
    const { affiliateId } = await apply(dana, codeFor('no'));
    await run(affiliateDecide, { affiliateId, decision: 'turn_down' }, staff);
    const mine = (await ask(affiliateMine, {}, dana)).affiliate!;
    expect(mine.status).toBe('turned_down');
    expect(Date.parse(mine.applyAgainFrom!)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect((await refusal(() => apply(dana, codeFor('no')))).rule).toBe(
      'affiliate_turned_down_recently',
    );
    await admin().execute(
      sql`update platform.affiliates set decided_at = now() - interval '31 days' where id = ${affiliateId}`,
    );
    expect(await apply(dana, codeFor('no'))).toEqual({ affiliateId, created: false });
    expect((await ask(affiliateMine, {}, dana)).affiliate?.status).toBe('applied');
  });
});

describe('staff', () => {
  it('only support admins see and run the program', async () => {
    const { affiliateId } = await apply(dana, codeFor('staffonly'));
    for (const u of [agent, riley]) {
      // Somebody who isn't staff is told there's nothing here at all, as the admin side always answers them.
      const e = await refusal(() => run(affiliateDecide, { affiliateId, decision: 'approve' }, u));
      expect(['forbidden', 'not_found']).toContain(e.code);
      const q = await refusal(() => ask(platformAffiliates, {}, u));
      expect(['forbidden', 'not_found']).toContain(q.code);
    }
  });

  it('decide, pause, bring back, end; the list and one affiliate’s page say so', async () => {
    const { affiliateId } = await apply(dana, codeFor('flow'));
    let list = await ask(platformAffiliates, {}, staff);
    expect(list.applications.map((a) => a.affiliateId)).toContain(affiliateId);

    const decided = await run(affiliateDecide, { affiliateId, decision: 'approve' }, staff);
    expect(decided.affiliate).toMatchObject({ status: 'approved', email: dana.email });
    expect(
      (await refusal(() => run(affiliateDecide, { affiliateId, decision: 'approve' }, staff))).rule,
    ).toBe('affiliate_already_decided');

    list = await ask(platformAffiliates, {}, staff);
    expect(list.affiliates.map((a) => a.affiliateId)).toContain(affiliateId);

    await run(affiliateSetStatus, { affiliateId, status: 'paused' }, staff);
    await run(affiliateSetStatus, { affiliateId, status: 'approved' }, staff);
    await run(affiliateSetStatus, { affiliateId, status: 'ended' }, staff);
    const e = await refusal(() =>
      run(affiliateSetStatus, { affiliateId, status: 'approved' }, staff),
    );
    expect(e.rule).toBe('affiliate_ended');

    const page = await ask(platformAffiliate, { affiliateId }, staff);
    expect(page.affiliate.status).toBe('ended');
  });

  it('the share for everyone, and one affiliate’s own', async () => {
    const affiliateId = await approved(dana, codeFor('rate'));
    await run(affiliatesSaveSettings, { rateBp: 3500 }, staff);
    expect((await ask(affiliateMine, {}, dana)).affiliate?.rateBp).toBe(3500);
    await run(affiliateSetRate, { affiliateId, rateBp: 5000 }, staff);
    expect((await ask(affiliateMine, {}, dana)).affiliate?.rateBp).toBe(5000);
    await run(affiliateSetRate, { affiliateId, rateBp: null }, staff);
    const mine = await ask(affiliateMine, {}, dana);
    expect(mine.affiliate?.rateBp).toBe(3500);
    expect(mine.defaultRateBp).toBe(3500);
    await run(affiliatesSaveSettings, { rateBp: 4000 }, staff);
  });

  it('changes a link code, never to one somebody has', async () => {
    const affiliateId = await approved(dana, codeFor('old'));
    await apply(riley, codeFor('riley'));
    await run(affiliateSetCode, { affiliateId, code: codeFor('new') }, staff);
    expect((await ask(affiliateMine, {}, dana)).affiliate?.code).toBe(codeFor('new'));
    expect(
      (await refusal(() => run(affiliateSetCode, { affiliateId, code: codeFor('riley') }, staff)))
        .rule,
    ).toBe('affiliate_code_taken');
  });
});

describe('a business made through a link', () => {
  const make = (u: TestUser, affiliate?: Record<string, unknown>) =>
    run(
      organizationCreate,
      { businessName: `Ref Plumbing ${randomUUID().slice(0, 4)}`, affiliate },
      u,
    );

  const creditedTo = async (orgId: string) =>
    (
      await rows<{ affiliate_id: string; how: string }>(
        admin(),
        sql`select affiliate_id, how from platform.affiliate_referrals where organization_id = ${orgId}`,
      )
    )[0] ?? null;

  it('is credited to an approved affiliate as it’s made', async () => {
    const affiliateId = await approved(dana, codeFor('link'));
    const clickedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const org = await make(buyer, { code: codeFor('LINK'), clickedAt });
    expect(await creditedTo(org.organizationId)).toEqual({
      affiliate_id: affiliateId,
      how: 'link',
    });
    const page = await ask(platformAffiliate, { affiliateId }, staff);
    expect(page.businesses).toEqual([
      expect.objectContaining({ organizationId: org.organizationId, how: 'link', clickedAt }),
    ]);
    expect(page.affiliate.businesses).toBe(1);
  });

  it('with no code, uses the link the account was made through, for its first business only', async () => {
    const affiliateId = await approved(dana, codeFor('kept'));
    const fresh = await createTestUser('affiliate-fresh');
    const clickedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await admin().execute(
      sql`update auth.users set raw_user_meta_data = raw_user_meta_data
            || jsonb_build_object('affiliate_ref', ${codeFor('kept')}::text, 'affiliate_ref_at', ${clickedAt}::text)
          where id = ${fresh.id}`,
    );
    const first = await make(fresh);
    expect(await creditedTo(first.organizationId)).toEqual({
      affiliate_id: affiliateId,
      how: 'link',
    });
    expect(await creditedTo((await make(fresh)).organizationId)).toBeNull();

    // A link kept from a click too long ago counts for nothing.
    const late = await createTestUser('affiliate-late');
    await admin().execute(
      sql`update auth.users set raw_user_meta_data = raw_user_meta_data
            || jsonb_build_object('affiliate_ref', ${codeFor('kept')}::text,
                 'affiliate_ref_at', ${new Date(Date.now() - 91 * 86_400_000).toISOString()}::text)
          where id = ${late.id}`,
    );
    expect(await creditedTo((await make(late)).organizationId)).toBeNull();
  });

  it('is never credited to the person’s own link, an affiliate not approved, an old click or a made-up code', async () => {
    await approved(dana, codeFor('self'));
    expect(
      await creditedTo((await make(dana, { code: codeFor('self') })).organizationId),
    ).toBeNull();

    await apply(riley, codeFor('waiting'));
    expect(
      await creditedTo((await make(buyer, { code: codeFor('waiting') })).organizationId),
    ).toBeNull();

    const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    expect(
      await creditedTo(
        (await make(buyer, { code: codeFor('self'), clickedAt: old })).organizationId,
      ),
    ).toBeNull();

    expect(
      await creditedTo((await make(buyer, { code: 'nobody-at-all' })).organizationId),
    ).toBeNull();
  });

  it('a paused affiliate’s link credits nobody', async () => {
    const affiliateId = await approved(dana, codeFor('paused'));
    await run(affiliateSetStatus, { affiliateId, status: 'paused' }, staff);
    expect(
      await creditedTo((await make(buyer, { code: codeFor('paused') })).organizationId),
    ).toBeNull();
  });

  it('staff credit a business by hand, move it, and take it off; never to its own maker', async () => {
    const danaId = await approved(dana, codeFor('hand'));
    const rileyId = await approved(riley, codeFor('hand2'));
    const org = await make(buyer);
    const before = await ask(platformAffiliateOfBusiness, { workspaceId: org.workspaceId }, staff);
    expect(before.affiliate).toBeNull();
    expect(before.choices.map((c) => c.affiliateId)).toEqual(
      expect.arrayContaining([danaId, rileyId]),
    );

    const set = await run(
      affiliateSetBusiness,
      { workspaceId: org.workspaceId, affiliateId: danaId },
      staff,
    );
    expect(set.affiliate).toMatchObject({ affiliateId: danaId, how: 'by_hand' });
    await run(affiliateSetBusiness, { workspaceId: org.workspaceId, affiliateId: rileyId }, staff);
    expect((await creditedTo(org.organizationId))?.affiliate_id).toBe(rileyId);
    const off = await run(
      affiliateSetBusiness,
      { workspaceId: org.workspaceId, affiliateId: null },
      staff,
    );
    expect(off.affiliate).toBeNull();

    const own = await make(dana);
    const e = await refusal(() =>
      run(affiliateSetBusiness, { workspaceId: own.workspaceId, affiliateId: danaId }, staff),
    );
    expect(e.rule).toBe('affiliate_own_business');
  });
});

describe('clicks', () => {
  it('count an approved affiliate’s link only, and show on their page', async () => {
    const code = codeFor('clicks');
    await apply(dana, code);
    const click = () =>
      rows<{ counted: boolean }>(admin(), sql`select private.affiliate_click(${code}) as counted`);
    expect((await click())[0]!.counted).toBe(false);
    const { affiliate } = await ask(affiliateMine, {}, dana);
    await run(affiliateDecide, { affiliateId: affiliate!.affiliateId, decision: 'approve' }, staff);
    await click();
    await click();
    const mine = await ask(affiliateMine, {}, dana);
    expect(mine.affiliate).toMatchObject({ clicks30: 2, clicksAll: 2 });
  });
});
