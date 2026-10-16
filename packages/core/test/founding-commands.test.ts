/**
 * Taking a founding seat up, and paying for one, through the command pipeline (0093).
 *
 * The database's own tests (packages/db/test/founding-checkout.test.ts) prove who the functions let through.
 * These prove the commands reach them as the right person: the owner the seat was approved for can take it up
 * and start paying, a plain member is refused by the kernel before anything runs, and the worker's recording of
 * a payment turns the seat on and says so in events somebody can notice.
 */
import { createHash, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta, SystemActor } from '../src/kernel/types';
import {
  foundingApprove,
  foundingCheckoutStatus,
  foundingClaim,
  foundingClaimPreview,
  foundingGive,
  foundingRecordCheckoutOpened,
  foundingRecordCheckoutPaid,
  foundingStartCheckout,
  organizationCreate,
  platformFounding,
  workspaceCreate,
} from '../src/server';

const api = () => testDbs().api.db;
// Only the worker's login may act as HandsFreeOS itself, so the worker's commands go through it, as they do live.
const worker = () => testDbs().worker.db;
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

async function refusal(fn: () => Promise<unknown>): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    return e as HfosError;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

const FREE = 'test_cmd_free';
const PAID = 'test_cmd_paid';

let owner: TestUser;
let member: TestUser;
let staff: TestUser;
let orgId: string;
let wsId: string;

beforeAll(async () => {
  [owner, member, staff] = await Promise.all([
    createTestUser('founding-owner', { fullName: 'Dana Owner' }),
    createTestUser('founding-member', { fullName: 'Marco Member' }),
    createTestUser('founding-staff'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Founding Plumbing' }, owner);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  await admin().execute(
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${member.id}, 'member')`,
  );
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
});
afterAll(closeTestDbs);

beforeEach(async () => {
  for (const offer of [FREE, PAID]) {
    await admin().execute(sql`delete from platform.founding_checkouts where offer_id = ${offer}`);
    await admin().execute(
      sql`delete from platform.founding_applications where offer_id = ${offer}`,
    );
    await admin().execute(sql`delete from platform.founding_grants where offer_id = ${offer}`);
    await admin().execute(sql`delete from platform.founding_offers where id = ${offer}`);
  }
  await admin().execute(sql`delete from app.workspace_plans where workspace_id = ${wsId}`);
  await admin().execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, starting_credit_cents, show_counter)
        values (${FREE}, 'Founding Partner', 5, 0, 'open', 1000, false),
               (${PAID}, 'Founding Customer', 5, 49700, 'open', 1000, false)`,
  );
});

/** An approval as founding.approve writes it, with a link whose token the test keeps. */
async function approve(offer: string): Promise<{ token: string; grantId: string }> {
  const token = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
  const [grant] = await rows<{ id: string }>(
    admin(),
    sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
        values (${offer}, ${orgId}::uuid, now() + interval '14 days') returning id`,
  );
  await admin().execute(
    sql`insert into platform.founding_applications
          (offer_id, business_name, contact_name, email, status, claim_token_hash, claim_expires_at, grant_id)
        values (${offer}, 'Founding Plumbing', 'Dana', ${`${randomUUID()}@hfos.test`}, 'approved',
                ${createHash('sha256').update(token).digest()}, now() + interval '14 days', ${grant!.id}::uuid)`,
  );
  return { token, grantId: grant!.id };
}

const seatOf = async (grantId: string) =>
  (
    await rows<{ status: string; expires_at: string | null; workspace_id: string | null }>(
      admin(),
      sql`select status, expires_at, workspace_id from platform.founding_grants where id = ${grantId}::uuid`,
    )
  )[0];

const planOf = async (workspaceId: string) =>
  (
    await rows<{ plan: string; status: string; grant_id: string | null }>(
      admin(),
      sql`select plan, status, grant_id from app.workspace_plans where workspace_id = ${workspaceId}::uuid`,
    )
  )[0];

const eventsOf = (type: string, entityId: string) =>
  rows<{ event_type: string }>(
    admin(),
    sql`select event_type from app.events where event_type = ${type} and entity_id = ${entityId}::uuid`,
  );

describe('a free seat', () => {
  it('is previewed by the link holder, then taken up onto their workspace', async () => {
    const { token, grantId } = await approve(FREE);
    const seen = await executeQuery(api(), foundingClaimPreview, { token }, human(owner), meta());
    expect(seen).toMatchObject({
      state: 'ready',
      offerName: 'Founding Partner',
      priceCents: 0,
      organizationId: orgId,
      checkoutId: null,
    });

    const done = await run(foundingClaim, { token, workspaceId: wsId }, owner);
    expect(done).toMatchObject({ grantId, plan: 'founding_free', creditedCents: 1000 });
    expect(await eventsOf('founding.claimed', grantId)).toHaveLength(1);
  });

  it('is refused to a plain member before anything runs', async () => {
    const { token } = await approve(FREE);
    const e = await refusal(() => run(foundingClaim, { token, workspaceId: wsId }, member));
    expect(e.status).toBe(403);
  });

  it('answers a used link in words, not a server error', async () => {
    const { token } = await approve(FREE);
    await run(foundingClaim, { token, workspaceId: wsId }, owner);
    const e = await refusal(() => run(foundingClaim, { token, workspaceId: wsId }, owner));
    expect(e.rule).toBe('founding_claim_invalid');
    expect(e.status).toBe(404);
  });
});

describe('a paid seat', () => {
  it('is paid for at checkout, and goes active when the worker records the payment', async () => {
    const { token, grantId } = await approve(PAID);

    const free = await refusal(() => run(foundingClaim, { token, workspaceId: wsId }, owner));
    expect(free.rule).toBe('founding_claim_needs_checkout');

    const started = await run(foundingStartCheckout, { token, workspaceId: wsId }, owner);
    expect(started).toMatchObject({ status: 'pending', url: null, created: true });
    // The worker is asked to make the page exactly once, however many times the button is pressed.
    const again = await run(foundingStartCheckout, { token, workspaceId: wsId }, owner);
    expect(again).toMatchObject({ checkoutId: started.checkoutId, created: false });
    expect(await eventsOf('founding.checkout_requested', started.checkoutId)).toHaveLength(1);

    const system: SystemActor = { type: 'system', workspaceId: wsId, organizationId: orgId };
    const opened = await executeCommand(
      worker(),
      foundingRecordCheckoutOpened,
      {
        workspaceId: wsId,
        checkoutId: started.checkoutId,
        sessionRef: `cs_test_${randomUUID()}`,
        url: 'https://checkout.stripe.com/c/pay/cs_test_page',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      system,
      meta(),
    );
    expect(opened.output.outcome).toBe('opened');

    const status = await executeQuery(
      api(),
      foundingCheckoutStatus,
      { checkoutId: started.checkoutId },
      human(owner),
      meta(),
    );
    expect(status).toMatchObject({
      status: 'open',
      url: 'https://checkout.stripe.com/c/pay/cs_test_page',
      seatActive: false,
      amountCents: 49700,
    });
    // A member of the same workspace is told nothing: the checkout is for whoever runs it.
    const hidden = await refusal(() =>
      executeQuery(
        api(),
        foundingCheckoutStatus,
        { checkoutId: started.checkoutId },
        human(member),
        meta(),
      ),
    );
    expect(hidden.status).toBe(404);

    const paid = await executeCommand(
      worker(),
      foundingRecordCheckoutPaid,
      {
        workspaceId: wsId,
        checkoutId: started.checkoutId,
        sessionRef: 'cs_test_page',
        paymentRef: 'pi_test_page',
        paidCents: 49700,
      },
      system,
      meta(),
    );
    expect(paid.output.outcome).toBe('activated');
    expect(await eventsOf('founding.paid', started.checkoutId)).toHaveLength(1);
    expect(await eventsOf('founding.claimed', grantId)).toHaveLength(1);

    const after = await executeQuery(
      api(),
      foundingCheckoutStatus,
      { checkoutId: started.checkoutId },
      human(owner),
      meta(),
    );
    expect(after).toMatchObject({ status: 'paid', seatActive: true, url: null });
  });

  it('records a payment for a seat taken back meanwhile as stranded, for staff', async () => {
    const { token, grantId } = await approve(PAID);
    const started = await run(foundingStartCheckout, { token, workspaceId: wsId }, owner);
    await admin().execute(
      sql`update platform.founding_grants set status = 'revoked', revoked_at = now(), revoke_reason = 'test'
          where id = ${grantId}::uuid`,
    );
    const system: SystemActor = { type: 'system', workspaceId: wsId, organizationId: orgId };
    const paid = await executeCommand(
      worker(),
      foundingRecordCheckoutPaid,
      {
        workspaceId: wsId,
        checkoutId: started.checkoutId,
        sessionRef: 'cs_test_late',
        paymentRef: 'pi_test_late',
        paidCents: 49700,
      },
      system,
      meta(),
    );
    expect(paid.output.outcome).toBe('no_seat');
    expect(await eventsOf('founding.payment_stranded', started.checkoutId)).toHaveLength(1);
    expect(await eventsOf('founding.claimed', grantId)).toHaveLength(0);
  });
});

describe('approving', () => {
  const apply = async (offer: string, email = `${randomUUID()}@hfos.test`): Promise<string> => {
    const [row] = await rows<{ id: string }>(
      admin(),
      sql`insert into platform.founding_applications (offer_id, business_name, contact_name, email)
          values (${offer}, 'Founding Plumbing', 'Dana', ${email}) returning id`,
    );
    return row!.id;
  };
  const heldOn = (offer: string) =>
    rows<{ id: string }>(
      admin(),
      sql`select id from platform.founding_grants where offer_id = ${offer}`,
    );

  it('turns a free seat on for the business picked, with no link to follow', async () => {
    const applicationId = await apply(FREE);
    const out = await run(
      foundingApprove,
      { applicationId, organizationId: orgId, workspaceId: wsId },
      staff,
    );
    expect(out).toMatchObject({
      offerId: FREE,
      status: 'active',
      workspaceId: wsId,
      expiresAt: null,
      claimToken: null,
      remaining: 4,
    });
    expect(await seatOf(out.grantId)).toMatchObject({ status: 'active', expires_at: null });
    expect(await planOf(wsId)).toMatchObject({ plan: 'founding_free', status: 'active' });
    expect(await eventsOf('founding.approved', out.grantId)).toHaveLength(1);
    expect(await eventsOf('founding.claimed', out.grantId)).toHaveLength(1);
  });

  it('holds a paid seat and returns the link to pay for it, once', async () => {
    const applicationId = await apply(PAID);
    const out = await run(foundingApprove, { applicationId, organizationId: orgId }, staff);
    expect(out).toMatchObject({ offerId: PAID, status: 'reserved', workspaceId: null });
    expect(out.claimToken).toMatch(/^[0-9a-f]{64}$/);
    expect(out.expiresAt).not.toBeNull();
  });

  it('offers the business its owner applied from, matched on their email', async () => {
    const byOwner = await apply(FREE, owner.email.toUpperCase());
    const byMember = await apply(FREE, member.email);
    const { applications } = await executeQuery(
      api(),
      platformFounding,
      { offerId: FREE },
      human(staff),
      meta(),
    );
    const theirs = (id: string) =>
      applications.find((a) => a.applicationId === id)?.theirBusinesses;
    expect(theirs(byOwner)).toEqual([
      expect.objectContaining({ workspaceId: wsId, organizationId: orgId, role: 'owner' }),
    ]);
    // A plain member cannot take a seat up, so their business is not offered.
    expect(theirs(byMember)).toEqual([]);
  });

  it('refuses a workspace id in words that name its business, and holds nothing', async () => {
    const applicationId = await apply(FREE);
    const e = await refusal(() =>
      run(foundingApprove, { applicationId, organizationId: wsId }, staff),
    );
    expect(e.status).toBe(422);
    expect(e.rule).toBe('founding_not_a_business');
    expect(e.message).toContain('Founding Plumbing');
    expect(await heldOn(FREE)).toHaveLength(0);
  });

  it('refuses an id nothing has, instead of failing on our side', async () => {
    const applicationId = await apply(FREE);
    const e = await refusal(() =>
      run(foundingApprove, { applicationId, organizationId: randomUUID() }, staff),
    );
    expect(e.status).toBe(404);
    expect(e.rule).toBe('founding_business_missing');
    expect(await heldOn(FREE)).toHaveLength(0);
  });
});

describe('giving a seat', () => {
  const give = (input: object) =>
    run(foundingGive, { offerId: FREE, organizationId: orgId, ...input }, staff);
  const seatsOf = (offer: string) =>
    rows<{ id: string; status: string }>(
      admin(),
      sql`select id, status from platform.founding_grants
          where offer_id = ${offer} and organization_id = ${orgId}::uuid`,
    );

  it('turns a seat on for any business, with no application, and it does not run out', async () => {
    const out = await give({ note: 'They helped us shape the calendar.' });
    expect(out).toMatchObject({
      offerId: FREE,
      organizationId: orgId,
      workspaceId: wsId,
      plan: 'founding_free',
      remaining: 4,
    });
    expect(await seatOf(out.grantId)).toMatchObject({
      status: 'active',
      expires_at: null,
      workspace_id: wsId,
    });
    expect(await planOf(wsId)).toMatchObject({ plan: 'founding_free', grant_id: out.grantId });
    expect(await eventsOf('founding.claimed', out.grantId)).toHaveLength(1);

    // The hourly sweep that gives back lapsed holds leaves it alone.
    await admin().execute(sql`select private.founding_expire_reservations()`);
    expect(await seatOf(out.grantId)).toMatchObject({ status: 'active' });
  });

  it('turns on the seat the business is already holding, instead of taking a second', async () => {
    const { grantId } = await approve(FREE);
    const out = await give({ workspaceId: wsId });
    expect(out).toMatchObject({ grantId, remaining: 4 });
    expect(await seatsOf(FREE)).toEqual([{ id: grantId, status: 'active' }]);
  });

  it('turns a seat that lapsed back on, so it leaves the given-back list', async () => {
    const { grantId } = await approve(FREE);
    await admin().execute(
      sql`update platform.founding_grants set status = 'expired', expires_at = now() - interval '1 day'
          where id = ${grantId}::uuid`,
    );
    const out = await give({});
    expect(out.grantId).toBe(grantId);
    expect(await seatsOf(FREE)).toEqual([{ id: grantId, status: 'active' }]);
    expect(await seatOf(grantId)).toMatchObject({ expires_at: null, workspace_id: wsId });
  });

  it('credits the starting credit once, however often the seat is turned back on', async () => {
    const first = await give({});
    expect(first.creditedCents).toBe(1000);
    await admin().execute(
      sql`update platform.founding_grants set status = 'expired', workspace_id = null, activated_at = null,
            expires_at = now() - interval '1 day'
          where id = ${first.grantId}::uuid`,
    );
    const again = await give({});
    expect(again).toMatchObject({ grantId: first.grantId, creditedCents: 0 });
  });

  it('refuses a business that already has a seat, in words', async () => {
    await give({});
    const e = await refusal(() => give({}));
    expect(e.rule).toBe('founding_org_has_a_seat');
    expect(e.message).toContain('Founding Partner');
  });

  it('refuses when every seat is out, and takes nothing', async () => {
    await admin().execute(sql`update platform.founding_offers set seat_cap = 0 where id = ${FREE}`);
    const e = await refusal(() => give({}));
    expect(e.rule).toBe('founding_offer_full');
    expect(await seatsOf(FREE)).toHaveLength(0);
    expect(await planOf(wsId)).toBeUndefined();
  });

  it('refuses a workspace that is not the business’s own', async () => {
    const other = await run(organizationCreate, { businessName: 'Someone Else Roofing' }, owner);
    const e = await refusal(() => give({ workspaceId: other.workspaceId }));
    expect(e.rule).toBe('founding_workspace_elsewhere');
    expect(e.message).toContain('Founding Plumbing');
    expect(await seatsOf(FREE)).toHaveLength(0);
  });

  it('asks which workspace when the business has several', async () => {
    const group = await run(organizationCreate, { businessName: 'Two Shops Group' }, owner);
    await run(
      workspaceCreate,
      { organizationId: group.organizationId, name: 'Second Shop' },
      owner,
    );
    const e = await refusal(() =>
      run(foundingGive, { offerId: FREE, organizationId: group.organizationId }, staff),
    );
    expect(e.rule).toBe('founding_pick_workspace');
    expect(e.message).toContain('2 workspaces');

    const out = await run(
      foundingGive,
      { offerId: FREE, organizationId: group.organizationId, workspaceId: group.workspaceId },
      staff,
    );
    expect(out.workspaceId).toBe(group.workspaceId);
  });

  it('is refused to anybody without the founding permission', async () => {
    // Somebody who isn't staff is told nothing about the platform at all, so it reads as not found.
    const e = await refusal(() =>
      run(foundingGive, { offerId: FREE, organizationId: orgId }, owner),
    );
    expect(e.status).toBe(404);
    expect(await seatsOf(FREE)).toHaveLength(0);
  });
});
