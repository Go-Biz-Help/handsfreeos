/**
 * 20261027027500: practice businesses made the other ways, for Admin → Try onboarding's other onboardings.
 *
 * **Needs the stack up.** What's worth testing is each way's own rule:
 *
 *   - ready: its plan is on, so nothing waits on a founding spot;
 *   - an agency's client: the staff member owns the agency and isn't on the business's team, yet runs it through the
 *     agency, as an agency does;
 *   - joined from an invitation: nobody is in it, the staff member is invited from their own address at the role they
 *     picked (never owner), and it's ready; it's theirs only once they join, and it's listed for them before;
 *   - any invitation into a practice business is theirs to take, whatever address it went to, and nobody else's,
 *     while a real business's invitations still work only for the address they went to;
 *   - ending one is theirs by being who practises it, whatever role they joined at, and nobody else's.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

const admin$ = dbs.admin.db;
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

let staffAdmin: TestUser;
let otherAdmin: TestUser;
let customer: TestUser;

type Way = 'owner' | 'agency' | 'invited';
const start = (
  who: TestUser,
  way: Way,
  opts: { name?: string; role?: string | null; ready?: boolean } = {},
) => {
  const name = opts.name ?? `Practice ${way}`;
  const slug = `practice-${uniq()}`;
  return as(who)((tx) =>
    rows<{ org_id: string; ws_id: string; invitation_id: string | null }>(
      tx,
      sql`select * from private.start_practice_as(${name}, ${slug}, ${name}, ${slug}, 'America/Chicago',
            'home_services', 24, ${way}, ${opts.role ?? null}::app.member_role, ${opts.ready ?? false})`,
    ),
  ).then((r) => r[0]!);
};
/** As practice.start does for one you're invited into: made, recorded while you're in it, then you step out. */
const startInvited = async (who: TestUser, role: string) => {
  const made = await start(who, 'invited', { role });
  const [out] = await as(who)((tx) =>
    rows<{ out: boolean }>(tx, sql`select private.practice_step_out(${made.ws_id}) as out`),
  );
  expect(out!.out).toBe(true);
  return made;
};
/** What the worker does with a new invitation: gives it a link, kept as its hash. */
const linkFor = async (invitationId: string): Promise<string> => {
  const token = `tok-${uniq()}`;
  await admin$.execute(
    sql`update app.invitations set token_hash = ${sha256(token)}, sent_at = now() where id = ${invitationId}`,
  );
  return token;
};
const needsPlan = async (who: TestUser, ws: string): Promise<boolean> =>
  (
    await as(who)((tx) =>
      rows<{ needs: boolean }>(tx, sql`select private.workspace_needs_plan(${ws}) as needs`),
    )
  )[0]!.needs;
const mine = (who: TestUser) =>
  as(who)((tx) =>
    rows<{ workspace_id: string | null; joined: boolean; invited: boolean }>(
      tx,
      sql`select workspace_id, joined, invited from private.practice_mine()`,
    ),
  );

beforeAll(async () => {
  [staffAdmin, otherAdmin, customer] = await Promise.all([
    createTestUser('practice-ways-admin'),
    createTestUser('practice-ways-other'),
    createTestUser('practice-ways-customer'),
  ]);
  await admin$.execute(
    sql`insert into platform.staff (user_id, role) values (${staffAdmin.id}, 'admin'), (${otherAdmin.id}, 'admin')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
});
afterAll(async () => {
  // Out of the five at once, for whatever runs after.
  await admin$.execute(
    sql`update app.organizations set practice_by = null where practice_by in (${staffAdmin.id}, ${otherAdmin.id})`,
  );
  await closeAll();
});

describe('ready', () => {
  it('its plan is on, so nothing waits on a founding spot', async () => {
    const made = await start(staffAdmin, 'owner', { ready: true });
    const [plan] = await rows<{ plan: string; status: string }>(
      admin$,
      sql`select plan::text, status::text from app.workspace_plans where workspace_id = ${made.ws_id}`,
    );
    expect(plan).toEqual({ plan: 'founding_lifetime', status: 'active' });
    expect(await needsPlan(staffAdmin, made.ws_id)).toBe(false);
    expect(made.invitation_id).toBeNull();
  });
});

describe('an agency’s client', () => {
  it('the staff member owns the agency, isn’t on the business’s team, and runs it through the agency', async () => {
    const made = await start(staffAdmin, 'agency', { name: 'Practice Client' });
    const [who] = await rows<{ org_role: string | null; ws_role: string | null }>(
      admin$,
      sql`select (select role::text from app.organization_memberships
                   where organization_id = ${made.org_id} and user_id = ${staffAdmin.id}) as org_role,
                 (select role::text from app.workspace_memberships
                   where workspace_id = ${made.ws_id} and user_id = ${staffAdmin.id}) as ws_role`,
    );
    expect(who).toEqual({ org_role: 'owner', ws_role: null });
    const [effective] = await as(staffAdmin)((tx) =>
      rows<{ role: string | null }>(
        tx,
        sql`select private.effective_workspace_role(${made.ws_id}) as role`,
      ),
    );
    expect(effective!.role).toBe('owner');
    // Not ready: the agency picks its plan, as a real one does.
    expect(
      await rows(admin$, sql`select 1 from app.workspace_plans where workspace_id = ${made.ws_id}`),
    ).toHaveLength(0);
  });
});

describe('joined from an invitation', () => {
  it('nobody is in it, the staff member is invited from their own address, and it’s ready', async () => {
    const made = await startInvited(staffAdmin, 'member');
    expect(made.invitation_id).not.toBeNull();
    const [inv] = await rows<{ email: string; role: string; invited_by: string }>(
      admin$,
      sql`select email::text, role::text, invited_by from app.invitations where id = ${made.invitation_id}`,
    );
    expect(inv).toEqual({ email: staffAdmin.email, role: 'member', invited_by: staffAdmin.id });
    expect(
      await rows(
        admin$,
        sql`select 1 from app.workspace_memberships where workspace_id = ${made.ws_id}
            union all select 1 from app.organization_memberships where organization_id = ${made.org_id}`,
      ),
    ).toHaveLength(0);
    expect(await needsPlan(staffAdmin, made.ws_id)).toBe(false);

    // Not theirs until they join, but listed for them.
    const [before] = await as(staffAdmin)((tx) =>
      rows<{ role: string | null }>(
        tx,
        sql`select private.effective_workspace_role(${made.ws_id}) as role`,
      ),
    );
    expect(before!.role).toBeNull();
    expect(await mine(staffAdmin)).toContainEqual({
      workspace_id: made.ws_id,
      joined: false,
      invited: true,
    });

    const token = await linkFor(made.invitation_id!);
    const [joined] = await as(staffAdmin)((tx) =>
      rows<{ inv_role: string }>(
        tx,
        sql`select * from private.accept_invitation(${sha256(token)})`,
      ),
    );
    expect(joined!.inv_role).toBe('member');
    const [effective] = await as(staffAdmin)((tx) =>
      rows<{ role: string | null }>(
        tx,
        sql`select private.effective_workspace_role(${made.ws_id}) as role`,
      ),
    );
    expect(effective!.role).toBe('member');
    expect(await mine(staffAdmin)).toContainEqual({
      workspace_id: made.ws_id,
      joined: true,
      invited: false,
    });
  });

  it('only they step out, only of one they were just invited into', async () => {
    const made = await start(staffAdmin, 'invited', { role: 'admin' });
    const theirs = await expectPgError(() =>
      as(otherAdmin)((tx) => rows(tx, sql`select private.practice_step_out(${made.ws_id})`)),
    );
    expect(theirs.detail).toBe('practice_only');
    const owned = await start(staffAdmin, 'owner');
    const notInvited = await expectPgError(() =>
      as(staffAdmin)((tx) => rows(tx, sql`select private.practice_step_out(${owned.ws_id})`)),
    );
    expect(notInvited.detail).toBe('practice_only');
    // Out of the five at once.
    await admin$.execute(
      sql`update app.organizations set practice_by = null where id in (${made.org_id}, ${owned.org_id})`,
    );
  });

  it('never as owner: an owner joins through an agency’s handover', async () => {
    const e = await expectPgError(() => start(staffAdmin, 'invited', { role: 'owner' }));
    expect(e.detail).toBe('practice_role');
  });

  it('refuses a way that isn’t one', async () => {
    const e = await expectPgError(() => start(staffAdmin, 'someone' as Way));
    expect(e.detail).toBe('practice_as');
  });

  it('a customer cannot make one any way', async () => {
    const e = await expectPgError(() => start(customer, 'invited'));
    expect(e.detail).toBe('practice_forbidden');
  });
});

describe('invitations into a practice business', () => {
  it('the staff member practising it takes one whatever address it went to; nobody else does', async () => {
    const made = await start(otherAdmin, 'agency', { name: 'Handed over' });
    // The agency's handover invites the owner, at an address that's pretended.
    const token = `tok-${uniq()}`;
    await admin$.execute(
      sql`insert into app.invitations (organization_id, workspace_id, email, role, invited_by, token_hash, sent_at, expires_at)
          values (${made.org_id}, ${made.ws_id}, ${`owner-${uniq()}@example.com`}, 'owner', ${otherAdmin.id},
                  ${sha256(token)}, now(), now() + interval '7 days')`,
    );
    const [preview] = await as(otherAdmin)((tx) =>
      rows<{ email_matches: boolean }>(
        tx,
        sql`select email_matches from private.invitation_preview(${sha256(token)})`,
      ),
    );
    expect(preview!.email_matches).toBe(true);
    const [theirs] = await as(customer)((tx) =>
      rows<{ email_matches: boolean }>(
        tx,
        sql`select email_matches from private.invitation_preview(${sha256(token)})`,
      ),
    );
    expect(theirs!.email_matches).toBe(false);
    const notYours = await expectPgError(() =>
      as(customer)((tx) =>
        tx.execute(sql`select * from private.accept_invitation(${sha256(token)})`),
      ),
    );
    expect(notYours.detail).toBe('invitation_email_mismatch');

    await as(otherAdmin)((tx) =>
      tx.execute(sql`select * from private.accept_invitation(${sha256(token)})`),
    );
    const [member] = await rows<{ role: string }>(
      admin$,
      sql`select role::text from app.workspace_memberships
          where workspace_id = ${made.ws_id} and user_id = ${otherAdmin.id}`,
    );
    expect(member!.role).toBe('owner');
  });

  it('a real business’s invitation still works only for the address it went to', async () => {
    const real = await bootstrapOrganization(customer, 'Real Invites', 'Real Invites');
    const token = `tok-${uniq()}`;
    await admin$.execute(
      sql`insert into app.invitations (organization_id, workspace_id, email, role, invited_by, token_hash, sent_at, expires_at)
          values (${real.orgId}, ${real.wsId}, ${`mate-${uniq()}@hfos.test`}, 'member', ${customer.id},
                  ${sha256(token)}, now(), now() + interval '7 days')`,
    );
    const e = await expectPgError(() =>
      as(staffAdmin)((tx) =>
        tx.execute(sql`select * from private.accept_invitation(${sha256(token)})`),
      ),
    );
    expect(e.detail).toBe('invitation_email_mismatch');
  });
});

describe('ending one', () => {
  it('is theirs by being who practises it, whatever role they joined at', async () => {
    const made = await startInvited(staffAdmin, 'member');
    const token = await linkFor(made.invitation_id!);
    await as(staffAdmin)((tx) =>
      tx.execute(sql`select * from private.accept_invitation(${sha256(token)})`),
    );
    // A member can't delete a business the ordinary way.
    const ordinary = await expectPgError(() =>
      as(staffAdmin)((tx) =>
        rows(tx, sql`select private.request_workspace_deletion(${made.ws_id})`),
      ),
    );
    expect(ordinary.detail).toBe('workspace_delete_forbidden');
    const notYours = await expectPgError(() =>
      as(otherAdmin)((tx) => rows(tx, sql`select private.end_practice(${made.ws_id})`)),
    );
    expect(notYours.detail).toBe('practice_not_yours');
    const customers = await expectPgError(() =>
      as(customer)((tx) => rows(tx, sql`select private.end_practice(${made.ws_id})`)),
    );
    expect(customers.detail).toBe('practice_forbidden');

    const [ended] = await as(staffAdmin)((tx) =>
      rows<{ at: Date | null }>(tx, sql`select private.end_practice(${made.ws_id}) as at`),
    );
    expect(ended!.at).not.toBeNull();
    const [ws] = await rows<{ marked: boolean }>(
      admin$,
      sql`select deletion_requested_at is not null as marked from app.workspaces where id = ${made.ws_id}`,
    );
    expect(ws!.marked).toBe(true);
  });

  it('one they never joined: they step back in as a member to end it, only into their own', async () => {
    const made = await startInvited(staffAdmin, 'admin');
    const notYours = await expectPgError(() =>
      as(otherAdmin)((tx) => rows(tx, sql`select private.practice_step_in(${made.ws_id})`)),
    );
    expect(notYours.detail).toBe('practice_only');
    const customers = await expectPgError(() =>
      as(customer)((tx) => rows(tx, sql`select private.practice_step_in(${made.ws_id})`)),
    );
    expect(customers.detail).toBe('practice_only');

    const stepIn = () =>
      as(staffAdmin)((tx) =>
        rows<{ in: boolean }>(tx, sql`select private.practice_step_in(${made.ws_id}) as in`),
      ).then((r) => r[0]!.in);
    expect(await stepIn()).toBe(true);
    // Already in: nothing more.
    expect(await stepIn()).toBe(false);
    const [ended] = await as(staffAdmin)((tx) =>
      rows<{ at: Date | null }>(tx, sql`select private.end_practice(${made.ws_id}) as at`),
    );
    expect(ended!.at).not.toBeNull();
  });

  it('a real business never ends this way', async () => {
    const real = await bootstrapOrganization(customer, 'Real Ends', 'Real Ends');
    const e = await expectPgError(() =>
      as(staffAdmin)((tx) => rows(tx, sql`select private.end_practice(${real.wsId})`)),
    );
    expect(e.detail).toBe('practice_only');
    const stepIn = await expectPgError(() =>
      as(staffAdmin)((tx) => rows(tx, sql`select private.practice_step_in(${real.wsId})`)),
    );
    expect(stepIn.detail).toBe('practice_only');
  });
});
