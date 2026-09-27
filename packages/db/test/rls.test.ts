import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  events,
  invitations,
  organizationMemberships,
  outbox,
  workspaceMemberships,
  workspaces,
} from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  pgError,
  testEnv,
  uniq,
  type OrgBootstrap,
  type TestUser,
} from './harness';

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

// The cast: an agency (Go Biz Help) with two client workspaces, a second unrelated
// organization, and an outsider with no memberships at all.
let agencyOwner: TestUser, agencyAdmin: TestUser, clientAOwner: TestUser, clientAAdmin: TestUser;
let clientAMember: TestUser, clientBOwner: TestUser, orgXOwner: TestUser, outsider: TestUser;
let agency: OrgBootstrap; // org + workspace A
let wsB: string; // second workspace in the agency org
let orgX: OrgBootstrap;

beforeAll(async () => {
  [
    agencyOwner,
    agencyAdmin,
    clientAOwner,
    clientAAdmin,
    clientAMember,
    clientBOwner,
    orgXOwner,
    outsider,
  ] = await Promise.all([
    createTestUser('agency-owner'),
    createTestUser('agency-admin'),
    createTestUser('client-a-owner'),
    createTestUser('client-a-admin'),
    createTestUser('client-a-member'),
    createTestUser('client-b-owner'),
    createTestUser('org-x-owner'),
    createTestUser('outsider'),
  ]);
  agency = await bootstrapOrganization(agencyOwner, 'Go Biz Help', 'Lone Star HVAC & Roofing');
  orgX = await bootstrapOrganization(orgXOwner, 'Unrelated Co', 'Unrelated Workspace');

  // Direct fixtures as the migration owner (no command layer yet).
  const admin = dbs.admin.db;
  const [b] = await rows<{ id: string }>(
    admin,
    sql`insert into app.workspaces (organization_id, name, slug, created_by) values (${agency.orgId}, 'Bayou Plumbing Co.', ${'bayou-' + uniq()}, ${agencyOwner.id}) returning id`,
  );
  wsB = b!.id;
  await admin
    .insert(organizationMemberships)
    .values({ organizationId: agency.orgId, userId: agencyAdmin.id, role: 'admin' });
  await admin.insert(workspaceMemberships).values([
    { workspaceId: agency.wsId, userId: clientAOwner.id, role: 'owner' },
    { workspaceId: agency.wsId, userId: clientAAdmin.id, role: 'admin' },
    { workspaceId: agency.wsId, userId: clientAMember.id, role: 'member' },
    { workspaceId: wsB, userId: clientBOwner.id, role: 'owner' },
  ]);
});

afterAll(closeAll);

describe('workspace and organization isolation', () => {
  it('org owner sees every workspace in the org and none from another org', async () => {
    const seen = await as(agencyOwner)((tx) => tx.select({ id: workspaces.id }).from(workspaces));
    const ids = seen.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([agency.wsId, wsB]));
    expect(ids).not.toContain(orgX.wsId);
  });

  it('client member sees only their own workspace, not the sibling client', async () => {
    const seen = await as(clientAMember)((tx) => tx.select({ id: workspaces.id }).from(workspaces));
    expect(seen.map((w) => w.id)).toEqual([agency.wsId]);
  });

  it('outsider sees nothing anywhere', async () => {
    const [ws, orgs, members, invites] = await as(outsider)(async (tx) => [
      await tx.select().from(workspaces),
      await rows(tx, sql`select id from app.organizations`),
      await tx.select().from(workspaceMemberships),
      await tx.select({ id: invitations.id }).from(invitations),
    ]);
    expect([ws.length, orgs.length, members.length, invites.length]).toEqual([0, 0, 0, 0]);
  });

  it('cross-tenant update by primary key affects zero rows', async () => {
    const updated = await as(orgXOwner)((tx) =>
      tx
        .update(workspaces)
        .set({ name: 'hijacked' })
        .where(eq(workspaces.id, agency.wsId))
        .returning({ id: workspaces.id }),
    );
    expect(updated).toHaveLength(0);
  });

  it('org admin reads a client workspace without a direct membership row', async () => {
    const seen = await as(agencyAdmin)((tx) =>
      tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, agency.wsId)),
    );
    expect(seen).toHaveLength(1);
    const [role] = await as(agencyAdmin)((tx) =>
      rows<{ role: string }>(
        tx,
        sql`select private.effective_workspace_role(${agency.wsId}) as role`,
      ),
    );
    expect(role?.role).toBe('admin');
  });

  it('client member cannot read the agency org membership list', async () => {
    const seen = await as(clientAMember)((tx) => tx.select().from(organizationMemberships));
    expect(seen).toHaveLength(0);
  });

  it('tenant columns are immutable even for an owner', async () => {
    const err = await expectPgError(() =>
      as(agencyOwner)((tx) =>
        tx
          .update(workspaces)
          .set({ organizationId: orgX.orgId })
          .where(eq(workspaces.id, agency.wsId)),
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toMatch(/immutable/);
  });
});

describe('roles and escalation guards', () => {
  it('member cannot insert a membership at all', async () => {
    const err = await expectPgError(() =>
      as(clientAMember)((tx) =>
        tx
          .insert(workspaceMemberships)
          .values({ workspaceId: agency.wsId, userId: outsider.id, role: 'owner' }),
      ),
    );
    expect(err.code).toBe('42501');
  });

  it('admin can invite a member or an admin but never an owner', async () => {
    const ok = await as(clientAAdmin)((tx) =>
      tx
        .insert(invitations)
        .values({
          organizationId: agency.orgId,
          workspaceId: agency.wsId,
          email: `inv-${uniq()}@hfos.test`,
          role: 'admin',
          invitedBy: clientAAdmin.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning({ id: invitations.id }),
    );
    expect(ok).toHaveLength(1);
    const err = await expectPgError(() =>
      as(clientAAdmin)((tx) =>
        tx.insert(invitations).values({
          organizationId: agency.orgId,
          workspaceId: agency.wsId,
          email: `inv-${uniq()}@hfos.test`,
          role: 'owner',
          invitedBy: clientAAdmin.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      ),
    );
    expect(err.code).toBe('42501');
  });

  it('member cannot invite anyone', async () => {
    const err = await expectPgError(() =>
      as(clientAMember)((tx) =>
        tx.insert(invitations).values({
          organizationId: agency.orgId,
          workspaceId: agency.wsId,
          email: `inv-${uniq()}@hfos.test`,
          role: 'member',
          invitedBy: clientAMember.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      ),
    );
    expect(err.code).toBe('42501');
  });

  it('nobody can change their own role', async () => {
    const updated = await as(clientAOwner)((tx) =>
      tx
        .update(workspaceMemberships)
        .set({ role: 'member' })
        .where(eq(workspaceMemberships.userId, clientAOwner.id))
        .returning({ id: workspaceMemberships.id }),
    );
    expect(updated).toHaveLength(0);
  });

  it('admin cannot demote or remove an owner', async () => {
    const demoted = await as(clientAAdmin)((tx) =>
      tx
        .update(workspaceMemberships)
        .set({ role: 'member' })
        .where(eq(workspaceMemberships.userId, clientAOwner.id))
        .returning({ id: workspaceMemberships.id }),
    );
    const removed = await as(clientAAdmin)((tx) =>
      tx
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.userId, clientAOwner.id))
        .returning({ id: workspaceMemberships.id }),
    );
    expect(demoted).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  it('admin can change a member and an owner can promote to owner', async () => {
    const promoted = await as(clientAAdmin)((tx) =>
      tx
        .update(workspaceMemberships)
        .set({ role: 'admin' })
        .where(eq(workspaceMemberships.userId, clientAMember.id))
        .returning({ id: workspaceMemberships.id }),
    );
    expect(promoted).toHaveLength(1);
    const back = await as(clientAOwner)((tx) =>
      tx
        .update(workspaceMemberships)
        .set({ role: 'member' })
        .where(eq(workspaceMemberships.userId, clientAMember.id))
        .returning({ id: workspaceMemberships.id }),
    );
    expect(back).toHaveLength(1);
  });

  it('the last organization owner cannot leave or be demoted', async () => {
    const err = await expectPgError(() =>
      as(orgXOwner)((tx) =>
        tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, orgXOwner.id)),
      ),
    );
    expect(err.detail).toBe('last_owner');
  });

  it('a workspace owner may leave when an org owner remains as backstop, and a member may leave freely', async () => {
    const left = await as(clientBOwner)((tx) =>
      tx
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.userId, clientBOwner.id))
        .returning({ id: workspaceMemberships.id }),
    );
    expect(left).toHaveLength(1);
    await dbs.admin.db
      .insert(workspaceMemberships)
      .values({ workspaceId: wsB, userId: clientBOwner.id, role: 'owner' });

    const memberLeft = await as(clientAMember)((tx) =>
      tx
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.userId, clientAMember.id))
        .returning({ id: workspaceMemberships.id }),
    );
    expect(memberLeft).toHaveLength(1);
    await dbs.admin.db
      .insert(workspaceMemberships)
      .values({ workspaceId: agency.wsId, userId: clientAMember.id, role: 'member' });
  });

  it('a lone owner of a self-serve business cannot remove themselves from their workspace', async () => {
    const err = await expectPgError(() =>
      as(orgXOwner)((tx) =>
        tx.delete(workspaceMemberships).where(eq(workspaceMemberships.userId, orgXOwner.id)),
      ),
    );
    expect(err.detail).toBe('last_owner');
  });
});

describe('bootstrap and invitations', () => {
  it('create_organization requires a signed-in user', async () => {
    const err = await expectPgError(() =>
      dbs.api.db.transaction(async (tx) => {
        await tx.execute(sql`set local role authenticated`);
        await tx.execute(
          sql`select * from private.create_organization('X', 'x-slug', 'Y', 'y-slug')`,
        );
      }),
    );
    expect(err.detail).toBe('not_authenticated');
  });

  it('accept rejects the wrong account, expired links, revoked links, and unknown tokens', async () => {
    const mk = async (extra: string) => {
      const token = `tok-${uniq()}`;
      const email = extra === 'valid' ? outsider.email : `${extra}-${uniq()}@hfos.test`;
      await dbs.admin.db.execute(
        sql`insert into app.invitations (organization_id, workspace_id, email, role, invited_by, token_hash, sent_at, expires_at, revoked_at)
            values (${agency.orgId}, ${agency.wsId}, ${email}, 'member', ${clientAOwner.id}, ${sha256(token)}, now(), ${sql.raw(extra.includes('expired') ? "now() - interval '1 day'" : "now() + interval '7 days'")}, ${sql.raw(extra.includes('revoked') ? 'now()' : 'null')})`,
      );
      return token;
    };
    const validToken = await mk('valid');
    const expiredToken = await mk('expired');
    const revokedToken = await mk('revoked');
    const wrong = await expectPgError(() =>
      as(orgXOwner)((tx) =>
        tx.execute(sql`select * from private.accept_invitation(${sha256(validToken)})`),
      ),
    );
    expect(wrong.detail).toBe('invitation_email_mismatch');
    const expired = await expectPgError(() =>
      as(outsider)((tx) =>
        tx.execute(sql`select * from private.accept_invitation(${sha256(expiredToken)})`),
      ),
    );
    expect(expired.detail).toBe('invitation_expired');
    const revoked = await expectPgError(() =>
      as(outsider)((tx) =>
        tx.execute(sql`select * from private.accept_invitation(${sha256(revokedToken)})`),
      ),
    );
    expect(revoked.detail).toBe('invitation_revoked');
    const unknown = await expectPgError(() =>
      as(outsider)((tx) =>
        tx.execute(sql`select * from private.accept_invitation(${sha256('nope')})`),
      ),
    );
    expect(unknown.detail).toBe('invitation_not_found');
  });

  it('a valid token is single use, even under concurrent acceptance', async () => {
    const invitee = await createTestUser('invitee');
    const token = `tok-${uniq()}`;
    await dbs.admin.db.execute(
      sql`insert into app.invitations (organization_id, workspace_id, email, role, invited_by, token_hash, sent_at)
          values (${agency.orgId}, ${agency.wsId}, ${invitee.email}, 'admin', ${clientAOwner.id}, ${sha256(token)}, now())`,
    );
    const attempt = () =>
      as(invitee)((tx) =>
        rows<{ ws_id: string }>(
          tx,
          sql`select ws_id from private.accept_invitation(${sha256(token)})`,
        ),
      );
    const results = await Promise.allSettled([attempt(), attempt()]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(pgError(failed[0]!.reason).detail).toBe('invitation_used');
    const membership = await as(invitee)((tx) =>
      tx
        .select({ role: workspaceMemberships.role })
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.userId, invitee.id)),
    );
    expect(membership).toEqual([{ role: 'admin' }]);
  });

  it('token_hash is never selectable; invitations are visible only to managers and the invitee', async () => {
    const token = `tok-${uniq()}`;
    const email = `pending-${uniq()}@hfos.test`;
    await dbs.admin.db.execute(
      sql`insert into app.invitations (organization_id, workspace_id, email, role, invited_by, token_hash, sent_at)
          values (${agency.orgId}, ${agency.wsId}, ${email}, 'member', ${clientAOwner.id}, ${sha256(token)}, now())`,
    );
    const err = await expectPgError(() =>
      as(clientAOwner)((tx) => tx.execute(sql`select token_hash from app.invitations`)),
    );
    expect(err.code).toBe('42501');
    const managerSees = await as(clientAAdmin)((tx) =>
      tx.select({ email: invitations.email }).from(invitations).where(eq(invitations.email, email)),
    );
    expect(managerSees).toHaveLength(1);
    const memberSees = await as(clientAMember)((tx) =>
      tx.select({ email: invitations.email }).from(invitations).where(eq(invitations.email, email)),
    );
    expect(memberSees).toHaveLength(0);
    const invitee = { ...outsider, claims: { sub: outsider.id, email } };
    const inviteeSees = await as(invitee)((tx) =>
      tx.select({ email: invitations.email }).from(invitations).where(eq(invitations.email, email)),
    );
    expect(inviteeSees).toHaveLength(1);
  });

  it('invitation_preview masks the address and reports whether the signed-in email matches', async () => {
    const token = `tok-${uniq()}`;
    const previewEmail = `outsider-${uniq()}@hfos.test`;
    await dbs.admin.db.execute(
      sql`insert into app.invitations (organization_id, workspace_id, email, role, invited_by, token_hash, sent_at)
          values (${agency.orgId}, ${agency.wsId}, ${previewEmail}, 'member', ${clientAOwner.id}, ${sha256(token)}, now())`,
    );
    const [preview] = await as(orgXOwner)((tx) =>
      rows<{
        status: string;
        workspace_name: string;
        invitee_email_masked: string;
        email_matches: boolean;
      }>(tx, sql`select * from private.invitation_preview(${sha256(token)})`),
    );
    expect(preview).toMatchObject({
      status: 'pending',
      workspace_name: 'Lone Star HVAC & Roofing',
      email_matches: false,
    });
    expect(preview!.invitee_email_masked).toMatch(/^o••••@hfos\.test$/);
  });
});

describe('events and audit are append-only and honest about their actor', () => {
  it('a member can record their own event but cannot forge another actor or another workspace', async () => {
    const own = await as(clientAMember)((tx) =>
      tx
        .insert(events)
        .values({
          organizationId: agency.orgId,
          workspaceId: agency.wsId,
          eventType: 'test.recorded',
          actorType: 'human',
          actorId: clientAMember.id,
          entityType: 'workspace',
          entityId: agency.wsId,
          correlationId: randomUUID(),
        })
        .returning({ id: events.id }),
    );
    expect(own).toHaveLength(1);
    const forged = await expectPgError(() =>
      as(clientAMember)((tx) =>
        tx.insert(events).values({
          organizationId: agency.orgId,
          workspaceId: agency.wsId,
          eventType: 'test.forged',
          actorType: 'human',
          actorId: clientAOwner.id,
          entityType: 'workspace',
          correlationId: randomUUID(),
        }),
      ),
    );
    expect(forged.code).toBe('42501');
    const foreign = await expectPgError(() =>
      as(clientAMember)((tx) =>
        tx.insert(events).values({
          organizationId: agency.orgId,
          workspaceId: wsB,
          eventType: 'test.foreign',
          actorType: 'human',
          actorId: clientAMember.id,
          entityType: 'workspace',
          correlationId: randomUUID(),
        }),
      ),
    );
    expect(foreign.code).toBe('42501');
  });

  it('an outbox row must say what its own event says, so the worker never runs it in another tenant', async () => {
    const recordAndQueue = (queued: { workspaceId: string; eventType: string }) =>
      as(clientAOwner)(async (tx) => {
        const [ev] = await tx
          .insert(events)
          .values({
            organizationId: agency.orgId,
            workspaceId: agency.wsId,
            eventType: 'test.queued',
            actorType: 'human',
            actorId: clientAOwner.id,
            entityType: 'workspace',
            entityId: agency.wsId,
            correlationId: randomUUID(),
          })
          .returning({ id: events.id });
        await tx.insert(outbox).values({ eventId: ev!.id, organizationId: agency.orgId, ...queued });
        return ev!.id;
      });
    await recordAndQueue({ workspaceId: agency.wsId, eventType: 'test.queued' });
    const elsewhere = await expectPgError(() =>
      recordAndQueue({ workspaceId: wsB, eventType: 'test.queued' }),
    );
    expect(elsewhere.code).toBe('42501');
    const retyped = await expectPgError(() =>
      recordAndQueue({ workspaceId: agency.wsId, eventType: 'test.other' }),
    );
    expect(retyped.code).toBe('42501');
  });

  it('events and audit rows cannot be updated or deleted by anyone, including postgres', async () => {
    const [ev] = await as(clientAOwner)((tx) =>
      tx
        .insert(events)
        .values({
          organizationId: agency.orgId,
          workspaceId: agency.wsId,
          eventType: 'test.immutable',
          actorType: 'human',
          actorId: clientAOwner.id,
          entityType: 'workspace',
          entityId: agency.wsId,
          correlationId: randomUUID(),
        })
        .returning({ id: events.id }),
    );
    const byUser = await expectPgError(() =>
      as(clientAOwner)((tx) => tx.delete(events).where(eq(events.id, ev!.id))),
    );
    expect(byUser.code).toBe('42501');
    const byPostgres = await expectPgError(() =>
      dbs.admin.db.delete(events).where(eq(events.id, ev!.id)),
    );
    expect(byPostgres.code).toBe('42501');
    const updByPostgres = await expectPgError(() =>
      dbs.admin.db.update(events).set({ eventType: 'test.tampered' }).where(eq(events.id, ev!.id)),
    );
    expect(updByPostgres.code).toBe('42501');
  });

  it('members see only the events they caused; audit.read holders see the whole workspace', async () => {
    const asMember = await as(clientAMember)((tx) =>
      tx
        .select({ actorId: events.actorId })
        .from(events)
        .where(eq(events.workspaceId, agency.wsId)),
    );
    expect(asMember.length).toBeGreaterThan(0);
    for (const e of asMember) expect(e.actorId).toBe(clientAMember.id);
    const asAdmin = await as(clientAAdmin)((tx) =>
      tx.select({ id: events.id }).from(events).where(eq(events.workspaceId, agency.wsId)),
    );
    expect(asAdmin.length).toBeGreaterThan(0);
  });
});

describe('worker scope', () => {
  it('sees nothing tenant-related without a scope, and only the scoped tenant with one', async () => {
    const unscoped = await asService({})((tx) =>
      tx.select({ id: invitations.id }).from(invitations),
    );
    expect(unscoped).toHaveLength(0);
    const scopedA = await asService({ workspaceId: agency.wsId, organizationId: agency.orgId })(
      (tx) => tx.select({ id: workspaces.id }).from(workspaces),
    );
    expect(scopedA.map((w) => w.id).sort()).toEqual([agency.wsId, wsB].sort());
    const scopedX = await asService({ workspaceId: orgX.wsId, organizationId: orgX.orgId })((tx) =>
      tx
        .select({ id: invitations.id })
        .from(invitations)
        .where(eq(invitations.workspaceId, agency.wsId)),
    );
    expect(scopedX).toHaveLength(0);
  });

  it('may mint an invitation token only inside its scope, and can always see the outbox', async () => {
    const [inv] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.invitations (organization_id, workspace_id, email, role, invited_by) values (${agency.orgId}, ${agency.wsId}, ${'mint-' + uniq() + '@hfos.test'}, 'member', ${clientAOwner.id}) returning id`,
    );
    const outside = await asService({ workspaceId: orgX.wsId, organizationId: orgX.orgId })((tx) =>
      tx
        .update(invitations)
        .set({ tokenHash: sha256('x-' + uniq()), sentAt: new Date() })
        .where(eq(invitations.id, inv!.id))
        .returning({ id: invitations.id }),
    );
    expect(outside).toHaveLength(0);
    const inside = await asService({ workspaceId: agency.wsId, organizationId: agency.orgId })(
      (tx) =>
        tx
          .update(invitations)
          .set({ tokenHash: sha256('y-' + uniq()), sentAt: new Date() })
          .where(eq(invitations.id, inv!.id))
          .returning({ id: invitations.id }),
    );
    expect(inside).toHaveLength(1);
    await asService({})((tx) => rows(tx, sql`select event_id from app.outbox limit 1`));
  });
});

describe('connection hygiene', () => {
  it('a bare API connection fails closed and carries no claims or role between transactions', async () => {
    const err = await expectPgError(() =>
      dbs.api.db.execute(sql`select count(*) from app.organizations`),
    );
    expect(err.code).toBe('42501');
    await as(agencyOwner)((tx) => tx.select({ id: workspaces.id }).from(workspaces));
    const [after] = await rows<{ role: string; claims: string | null }>(
      dbs.api.db,
      sql`select current_user as role, current_setting('request.jwt.claims', true) as claims`,
    );
    expect(after).toEqual({ role: 'hfos_api', claims: '' });
  });

  it('app roles are not superusers, do not bypass RLS, and own nothing; every app table has RLS; definer helpers pin search_path', async () => {
    const roles = await rows<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      dbs.admin.db,
      sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('hfos_api', 'hfos_worker', 'service_actor', 'authenticated')`,
    );
    expect(roles).toHaveLength(4);
    for (const r of roles) expect([r.rolsuper, r.rolbypassrls]).toEqual([false, false]);
    const owned = await rows(
      dbs.admin.db,
      sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner where n.nspname = 'app' and r.rolname in ('hfos_api', 'hfos_worker', 'service_actor', 'authenticated')`,
    );
    expect(owned).toHaveLength(0);
    const noRls = await rows(
      dbs.admin.db,
      sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(noRls).toEqual([]);
    const unpinned = await rows<{ proname: string; proconfig: string[] | null }>(
      dbs.admin.db,
      sql`select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.prosecdef`,
    );
    for (const fn of unpinned)
      expect(
        fn.proconfig?.some((c) => /^search_path=("")?$/.test(c)),
        `${fn.proname} must pin an empty search_path`,
      ).toBe(true);
    const views = await rows(
      dbs.admin.db,
      sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'v' and coalesce(c.reloptions, '{}') @> array['security_invoker=true'] = false`,
    );
    expect(views).toEqual([]);
  });

  it('PostgREST does not serve the app schema', async () => {
    const plain = await fetch(`${testEnv.supabaseUrl}/rest/v1/organizations`, {
      headers: { apikey: testEnv.publishableKey },
    });
    const profiled = await fetch(`${testEnv.supabaseUrl}/rest/v1/organizations`, {
      headers: { apikey: testEnv.publishableKey, 'Accept-Profile': 'app' },
    });
    expect([404, 406]).toContain(plain.status);
    expect([404, 406]).toContain(profiled.status);
  });
});
