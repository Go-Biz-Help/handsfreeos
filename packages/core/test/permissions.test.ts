/**
 * What each role and each person may do, set by the business's owners (0106), and members who bill. The settings
 * decide the database's answer (every RLS policy), the command kernel's, the screens' and the phone's, and they
 * all come from one stored copy kept in step with the rules.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  effectivePermissions,
  invoiceCreate,
  invoiceList,
  invoiceRecordCashPayment,
  invoiceSend,
  membershipChangeRole,
  membershipInvite,
  membershipRemove,
  paymentRefund,
  permissionReset,
  permissionSetMember,
  permissionSetRole,
  permissionSettings,
  personCreate,
  recordAssign,
  subscriptionList,
  subscriptionStart,
  workspaceGet,
  workspaceMembers,
  type WorkspacePermission,
} from '../src/server';
import { admin, ask, expectHfos, run, setupTeam, type Team } from './calendar-helpers';

let t: Team;
let theirs: string;
let others: string;
const line = [{ name: 'SEO retainer', quantity: 1, unitPriceCents: 50_000, taxable: false }];

beforeAll(async () => {
  t = await setupTeam('permissions');
  // Marco runs the business beside Dale: an admin.
  await rows(
    admin(),
    sql`update app.workspace_memberships set role = 'admin'
        where workspace_id = ${t.wsId} and user_id = ${t.marco.id}`,
  );
  ({ personId: theirs } = await run(
    personCreate,
    { workspaceId: t.wsId, firstName: 'Priya’s', lastName: 'Client', ownerUserId: t.owner.id },
    t.owner,
  ));
  ({ personId: others } = await run(
    personCreate,
    { workspaceId: t.wsId, firstName: 'Someone', lastName: 'Else', ownerUserId: t.owner.id },
    t.owner,
  ));
  // Priya is on her client's team; nobody put her on the other one.
  await run(
    recordAssign,
    { workspaceId: t.wsId, recordType: 'person', recordId: theirs, userId: t.priya.id },
    t.owner,
  );
});
afterAll(closeTestDbs);

const mine = async (u: Team['owner']) =>
  (await ask(workspaceGet, { workspaceId: t.wsId }, u)).workspace.permissions;
const setRole = (
  role: 'admin' | 'member',
  permission: WorkspacePermission,
  allowed: boolean | null,
) => run(permissionSetRole, { workspaceId: t.wsId, role, permission, allowed }, t.owner);
const setPerson = (u: Team['owner'], permission: WorkspacePermission, allowed: boolean | null) =>
  run(permissionSetMember, { workspaceId: t.wsId, userId: u.id, permission, allowed }, t.owner);
const inSync = async () =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from private.sync_access_mismatches(${t.wsId})`,
    )
  )[0]!.n;

describe('what a role may do', () => {
  it('starts every role at its defaults, and an owner with everything', async () => {
    expect(await mine(t.priya)).toEqual(effectivePermissions('member'));
    expect(await mine(t.marco)).toEqual(effectivePermissions('admin'));
    const owner = await mine(t.owner);
    expect(owner).toContain('permissions.manage');
    expect(owner).toContain('money.bill');
    expect(await mine(t.priya)).not.toContain('money.bill');
  });

  it('turns a permission on for everyone with the role, and back to the default', async () => {
    const out = await setRole('member', 'money.bill', true);
    expect(out.changed).toBe(true);
    expect(out.effective).toContain('money.bill');
    for (const u of [t.priya, t.member]) expect(await mine(u)).toContain('money.bill');
    expect(await inSync()).toBe(0);
    expect((await setRole('member', 'money.bill', true)).changed).toBe(false);
    await setRole('member', 'money.bill', null);
    expect(await mine(t.priya)).not.toContain('money.bill');
  });

  it('turns off what stands on something that is off', async () => {
    await setRole('member', 'money.bill', true);
    await setRole('member', 'money.read', false);
    // Billing needs seeing money: off too, whatever its own setting says.
    const now = await mine(t.priya);
    expect(now).not.toContain('money.read');
    expect(now).not.toContain('money.bill');
    await run(permissionReset, { workspaceId: t.wsId, role: 'member' }, t.owner);
    expect(await mine(t.priya)).toEqual(effectivePermissions('member'));
  });

  it('holds the kernel and the database to it', async () => {
    await setRole('member', 'records.write', false);
    await expectHfos(
      () => run(personCreate, { workspaceId: t.wsId, firstName: 'No', lastName: 'Way' }, t.priya),
      'forbidden',
    );
    const [can] = await rows<{ ok: boolean }>(
      admin(),
      sql`select private.user_has_permission(${t.priya.id}::uuid, ${t.wsId}::uuid, 'records.write') as ok`,
    );
    expect(can!.ok).toBe(false);
    await setRole('member', 'records.write', null);
    await run(personCreate, { workspaceId: t.wsId, firstName: 'Yes', lastName: 'Now' }, t.priya);
  });
});

describe('what one person may do', () => {
  it('lets their own setting win over their role’s, either way', async () => {
    await setPerson(t.priya, 'money.bill', true);
    await setPerson(t.member, 'inbox.use', false);
    expect(await mine(t.priya)).toContain('money.bill');
    expect(await mine(t.marco)).toContain('money.bill');
    expect(await mine(t.member)).not.toContain('inbox.use');
    // The role turned off doesn't reach someone it's on for in their own right.
    await setRole('member', 'money.bill', false);
    expect(await mine(t.priya)).toContain('money.bill');
    await setRole('member', 'money.bill', null);
    await setPerson(t.member, 'inbox.use', null);
    expect(await inSync()).toBe(0);
  });

  it('never narrows an owner, and only owners set any of it', async () => {
    await expectHfos(() => setPerson(t.owner, 'money.manage', false), 'permission_owner');
    await expectHfos(
      () =>
        run(
          permissionSetRole,
          { workspaceId: t.wsId, role: 'member', permission: 'money.bill', allowed: true },
          t.marco,
        ),
      'forbidden',
    );
    await expectHfos(
      () =>
        run(
          permissionSetRole,
          { workspaceId: t.wsId, role: 'owner' as never, permission: 'money.bill', allowed: false },
          t.owner,
        ),
      'validation',
    );
    await expectHfos(() => ask(permissionSettings, { workspaceId: t.wsId }, t.marco), 'forbidden');
  });

  it('keeps an admin kept from money to the money of their own jobs', async () => {
    const { invoiceId } = await run(
      invoiceCreate,
      { workspaceId: t.wsId, personId: others, lines: line },
      t.owner,
    );
    await setPerson(t.marco, 'money.manage', false);
    const seen = (await ask(invoiceList, { workspaceId: t.wsId, limit: 100 }, t.marco)).invoices;
    expect(seen.map((i) => i.id)).not.toContain(invoiceId);
    const [access] = await rows<{ manages_money: boolean }>(
      admin(),
      sql`select manages_money from app.workspace_access
          where workspace_id = ${t.wsId} and user_id = ${t.marco.id}`,
    );
    expect(access!.manages_money).toBe(false);
    await setPerson(t.marco, 'money.manage', null);
    expect(
      (await ask(invoiceList, { workspaceId: t.wsId, limit: 100 }, t.marco)).invoices.map(
        (i) => i.id,
      ),
    ).toContain(invoiceId);
  });

  it('shows the owner every role and person, with their settings', async () => {
    await setPerson(t.priya, 'records.import', true);
    const out = await ask(permissionSettings, { workspaceId: t.wsId }, t.owner);
    expect(out.roles.map((r) => r.role)).toEqual(['admin', 'member']);
    const priya = out.people.find((p) => p.userId === t.priya.id)!;
    expect(priya.settings).toEqual({ 'money.bill': true, 'records.import': true });
    expect(priya.effective).toContain('records.import');
    const members = (await ask(workspaceMembers, { workspaceId: t.wsId }, t.owner)).members;
    expect(members.find((m) => m.userId === t.priya.id)!.permissions).toEqual(priya.effective);
    await setPerson(t.priya, 'records.import', null);
  });

  it('works out the same thing in TypeScript as in the database', async () => {
    const cases: [Record<string, boolean>, Record<string, boolean>][] = [
      [{}, {}],
      [{ 'money.manage': true }, {}],
      [{ 'money.read': false }, { 'money.bill': true }],
      [{ 'channels.manage': true, 'inbox.use': false }, {}],
      [{ 'records.write': false }, { 'records.archive': true, 'records.write': true }],
    ];
    for (const [roleSettings, personSettings] of cases) {
      await run(permissionReset, { workspaceId: t.wsId, role: 'member' }, t.owner);
      await run(permissionReset, { workspaceId: t.wsId, userId: t.member.id }, t.owner);
      for (const [p, v] of Object.entries(roleSettings))
        await setRole('member', p as WorkspacePermission, v);
      for (const [p, v] of Object.entries(personSettings))
        await setPerson(t.member, p as WorkspacePermission, v);
      expect(await mine(t.member)).toEqual(
        effectivePermissions('member', roleSettings, personSettings),
      );
    }
    await run(permissionReset, { workspaceId: t.wsId, role: 'member' }, t.owner);
    await run(permissionReset, { workspaceId: t.wsId, userId: t.member.id }, t.owner);
    expect(await inSync()).toBe(0);
  });
});

describe('members who bill', () => {
  it('bills the customers they’re on, sends it and takes a payment by hand', async () => {
    await setPerson(t.priya, 'money.bill', true);
    const { invoiceId } = await run(
      invoiceCreate,
      { workspaceId: t.wsId, personId: theirs, lines: line },
      t.priya,
    );
    const sent = await run(invoiceSend, { workspaceId: t.wsId, invoiceId, channels: [] }, t.priya);
    expect(sent.number).toBeTruthy();
    const paid = await run(
      invoiceRecordCashPayment,
      { workspaceId: t.wsId, invoiceId, amountCents: 50_000, method: 'cash' },
      t.priya,
    );
    expect(paid.status).toBe('succeeded');
    // Refunds are whoever manages money.
    await expectHfos(
      () => run(paymentRefund, { workspaceId: t.wsId, paymentId: paid.paymentId }, t.priya),
      'forbidden',
    );
  });

  it('refuses a customer they aren’t on, in words and in the database', async () => {
    await expectHfos(
      () => run(invoiceCreate, { workspaceId: t.wsId, personId: others, lines: line }, t.priya),
      'money_not_your_customer',
      403,
    );
    const err = await expectPg(() =>
      admin().transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: t.priya.id, role: 'authenticated' })}, true)`,
        );
        await tx.execute(sql`set local role authenticated`);
        await tx.execute(
          sql`insert into app.invoices (workspace_id, public_ref, person_id, purpose, origin, created_by)
              values (${t.wsId}, private.new_public_ref(), ${others}, 'standard', 'staff', ${t.priya.id})`,
        );
      }),
    );
    expect(err).toMatch(/row-level security/);
  });

  it('starts plans for their customers, and sees only theirs', async () => {
    const { subscriptionId } = await run(
      subscriptionStart,
      { workspaceId: t.wsId, personId: theirs, planName: 'SEO care', priceCents: 30_000 },
      t.priya,
    );
    await run(
      subscriptionStart,
      { workspaceId: t.wsId, personId: others, planName: 'Automations care', priceCents: 20_000 },
      t.owner,
    );
    const hers = (await ask(subscriptionList, { workspaceId: t.wsId }, t.priya)).subscriptions;
    expect(hers.map((s) => s.id)).toEqual([subscriptionId]);
    await expectHfos(
      () =>
        run(
          subscriptionStart,
          { workspaceId: t.wsId, personId: others, planName: 'Nope', priceCents: 100 },
          t.priya,
        ),
      'money_not_your_customer',
    );
  });

  it('leaves a member who doesn’t bill to see, not send', async () => {
    await expectHfos(
      () => run(invoiceCreate, { workspaceId: t.wsId, personId: theirs, lines: line }, t.member),
      'forbidden',
    );
    await setPerson(t.priya, 'money.bill', null);
    await expectHfos(
      () => run(invoiceCreate, { workspaceId: t.wsId, personId: theirs, lines: line }, t.priya),
      'forbidden',
    );
    expect(await inSync()).toBe(0);
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

describe('the team', () => {
  it('lets an admin hand out a role only as far as what they may do themselves', async () => {
    // Marco is an admin the business keeps from managing money. A second address of his own as an admin, or
    // Priya made one, would have the admin role's full set, money included.
    await setPerson(t.marco, 'money.manage', false);
    await expectHfos(
      () =>
        run(
          membershipInvite,
          {
            workspaceId: t.wsId,
            email: `marco-alt-${t.wsId.slice(0, 8)}@example.test`,
            role: 'admin',
          },
          t.marco,
        ),
      'cannot_grant_role',
    );
    await expectHfos(
      () =>
        run(
          membershipChangeRole,
          { workspaceId: t.wsId, userId: t.priya.id, role: 'admin' },
          t.marco,
        ),
      'cannot_grant_role',
    );
    // A member carries nothing he lacks; and once admins here don't manage money either, neither does an admin.
    await run(
      membershipInvite,
      {
        workspaceId: t.wsId,
        email: `marco-crew-${t.wsId.slice(0, 8)}@example.test`,
        role: 'member',
      },
      t.marco,
    );
    await setRole('admin', 'money.manage', false);
    await run(
      membershipInvite,
      { workspaceId: t.wsId, email: `marco-alt-${t.wsId.slice(0, 8)}@example.test`, role: 'admin' },
      t.marco,
    );
    await setRole('admin', 'money.manage', null);
    await setPerson(t.marco, 'money.manage', null);
    expect(await inSync()).toBe(0);
  });

  it('lets whoever the business trusts remove a teammate at their own level, and nobody else', async () => {
    // An admin the business keeps from removing people can't, whatever the role says.
    await setRole('admin', 'members.remove', false);
    await expectHfos(
      () => run(membershipRemove, { workspaceId: t.wsId, userId: t.member.id }, t.marco),
      'cannot_remove_role',
    );
    await setRole('admin', 'members.remove', null);
    // A member can't, until the owner lets them — and then never above their own level.
    await expectHfos(
      () => run(membershipRemove, { workspaceId: t.wsId, userId: t.member.id }, t.priya),
      'cannot_remove_role',
    );
    await setPerson(t.priya, 'members.remove', true);
    await expectHfos(
      () => run(membershipRemove, { workspaceId: t.wsId, userId: t.marco.id }, t.priya),
      'cannot_remove_role',
    );
    await run(membershipRemove, { workspaceId: t.wsId, userId: t.member.id }, t.priya);
    const team = await ask(workspaceMembers, { workspaceId: t.wsId }, t.owner);
    expect(team.members.map((m) => m.userId)).not.toContain(t.member.id);
    expect(await inSync()).toBe(0);
  });
});
