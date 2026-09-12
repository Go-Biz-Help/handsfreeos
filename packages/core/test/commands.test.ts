import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { asWorker } from '@hfos/db/client';
import { auditLogs, events, invitations, outbox } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  auditList,
  hashInvitationToken,
  invitationAccept,
  invitationPreview,
  invitationResend,
  invitationRevoke,
  me,
  membershipChangeRole,
  membershipInvite,
  membershipRemove,
  organizationCreate,
  registry,
  userUpdateProfile,
  workspaceCreate,
  workspaceGet,
  workspaceInvitations,
  workspaceMembers,
  workspaceUpdate,
} from '../src/server';

const db = () => testDbs().api.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (correlationId = randomUUID()): RequestMeta => ({
  correlationId,
  channel: 'test',
  ip: '127.0.0.1',
  userAgent: 'vitest',
});

const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
  m = meta(),
) => executeCommand(db(), cmd, input, actor(u), m);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(db(), q, input, actor(u), meta());

async function expectHfos(
  fn: () => Promise<unknown>,
  code: HfosError['code'],
  rule?: string,
): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect(err.code).toBe(code);
    if (rule) expect(err.rule).toBe(rule);
    return err;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** What the worker will do in step 9: mint the link token and record that the email went out. */
async function mintToken(
  invitationId: string,
  workspaceId: string,
  organizationId: string,
): Promise<string> {
  const token = `tok_${randomUUID().replace(/-/g, '')}`;
  await asWorker(testDbs().worker.db, { workspaceId, organizationId }, (tx) =>
    tx
      .update(invitations)
      .set({ tokenHash: hashInvitationToken(token), sentAt: new Date() })
      .where(eq(invitations.id, invitationId)),
  );
  return token;
}

let owner: TestUser, admin: TestUser, member: TestUser, outsider: TestUser;
let orgId: string, wsId: string;

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('owner'),
    createTestUser('admin'),
    createTestUser('member'),
    createTestUser('outsider'),
  ]);
});
afterAll(closeTestDbs);

describe('registry', () => {
  it('lists every command and query once, with dotted names', () => {
    expect(registry.commands.map((c) => c.name)).toEqual([
      'organization.create',
      'workspace.create',
      'workspace.update',
      'membership.invite',
      'invitation.resend',
      'invitation.revoke',
      'invitation.accept',
      'membership.change_role',
      'membership.remove',
      'user.update_profile',
      'pipeline.create',
      'pipeline.update',
      'pipeline.archive',
      'stage.create',
      'stage.update',
      'stage.reorder',
      'stage.delete',
      'company.create',
      'company.update',
      'company.archive',
      'company.restore',
      'person.create',
      'person.update',
      'person.archive',
      'person.restore',
      'tag.create',
      'tag.update',
      'tag.delete',
      'record.set_tags',
      'lead.create',
      'lead.update',
      'lead.move_stage',
      'lead.set_next_action',
      'lead.archive',
      'lead.restore',
      'task.create',
      'task.update',
      'task.complete',
      'task.reopen',
      'task.delete',
      'activity.log',
      'activity.update',
      'activity.delete',
      'file.begin_upload',
      'file.confirm',
      'file.delete',
      'import.create',
      'import.start',
      'import.cancel',
      'phone_number.buy',
      'phone_number.release',
      'phone_number.set_routing',
      'phone.update_settings',
      'phone_number.activate',
      'phone_number.fail',
      'phone_number.mark_released',
      'registration.submit',
      'registration.update_status',
      'conversation.open',
      'conversation.mark_read',
      'conversation.mark_unread',
      'conversation.assign',
      'conversation.snooze',
      'conversation.close',
      'conversation.reopen',
      'conversation.link_person',
      'message.send',
      'message.retry',
      'message.receive',
      'message.update_status',
      'message.attach_media',
      'person.set_sms_consent',
    ]);
    expect(registry.queries.map((q) => q.name)).toEqual([
      'account.me',
      'workspace.get',
      'workspace.members',
      'workspace.invitations',
      'invitation.preview',
      'audit.list',
      'pipeline.list',
      'company.list',
      'company.get',
      'person.list',
      'person.get',
      'tag.list',
      'lead.board',
      'lead.list',
      'lead.get',
      'task.list',
      'timeline.list',
      'file.list',
      'import.get',
      'import.list',
      'crm.find_matches',
      'crm.summary',
      'phone.setup_status',
      'inbox.list',
      'inbox.summary',
      'conversation.get',
      'conversation.thread',
      'message.get',
    ]);
    expect(registry.command('membership.invite')?.risk).toBe(2);
  });
});

describe('organization.create', () => {
  it('bootstraps org + workspace with the caller as Owner and writes event, outbox and audit rows in one correlation', async () => {
    const corr = randomUUID();
    const { output, eventIds } = await run(
      organizationCreate,
      {
        businessName: 'Lone Star HVAC & Roofing',
        organizationName: 'Go Biz Help',
        timezone: 'America/Chicago',
      },
      owner,
      meta(corr),
    );
    orgId = output.organizationId;
    wsId = output.workspaceId;
    expect(eventIds).toHaveLength(2);
    const evs = await testDbs()
      .admin.db.select()
      .from(events)
      .where(eq(events.correlationId, corr));
    expect(evs.map((e) => e.eventType).sort()).toEqual([
      'organization.created',
      'workspace.created',
    ]);
    expect(evs.every((e) => e.actorType === 'human' && e.actorId === owner.id)).toBe(true);
    const ob = await testDbs()
      .admin.db.select()
      .from(outbox)
      .where(eq(outbox.eventId, eventIds[0]!));
    expect(ob[0]?.status).toBe('pending');
    const audits = await testDbs()
      .admin.db.select()
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, corr));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: 'organization.create',
      channel: 'test',
      actorId: owner.id,
    });
  });

  it('validates input and reports field paths', async () => {
    const err = await expectHfos(
      () => run(organizationCreate, { businessName: '', timezone: 'Mars/Olympus' }, owner),
      'validation',
    );
    const paths = (err.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['businessName', 'timezone']));
  });
});

describe('workspace.create / workspace.update', () => {
  it('org owners can add a workspace; outsiders and non-org members get 404', async () => {
    const { output } = await run(
      workspaceCreate,
      { organizationId: orgId, name: 'Bayou Plumbing Co.' },
      owner,
    );
    expect(output.slug).toMatch(/^bayou-plumbing-co-[a-f0-9]{6}$/);
    await expectHfos(
      () => run(workspaceCreate, { organizationId: orgId, name: 'Nope' }, outsider),
      'not_found',
    );
  });

  it('records before/after for changed fields only', async () => {
    const corr = randomUUID();
    const { output } = await run(
      workspaceUpdate,
      { workspaceId: wsId, timezone: 'America/Denver', name: 'Lone Star HVAC & Roofing' },
      owner,
      meta(corr),
    );
    expect(output.updated).toEqual(['timezone']);
    const [audit] = await testDbs()
      .admin.db.select()
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, corr));
    expect(audit?.before).toEqual({ timezone: 'America/Chicago' });
    expect(audit?.after).toEqual({ timezone: 'America/Denver' });
    await run(workspaceUpdate, { workspaceId: wsId, timezone: 'America/Chicago' }, owner);
  });
});

describe('invitations', () => {
  let adminInviteId: string;
  let memberInviteId: string;

  it('owner invites an admin and a member; duplicates are conflicts', async () => {
    const a = await run(
      membershipInvite,
      { workspaceId: wsId, email: admin.email.toUpperCase(), role: 'admin' },
      owner,
    );
    adminInviteId = a.output.invitationId;
    expect(a.output.email).toBe(admin.email);
    const m = await run(
      membershipInvite,
      { workspaceId: wsId, email: member.email, role: 'member' },
      owner,
    );
    memberInviteId = m.output.invitationId;
    await expectHfos(
      () => run(membershipInvite, { workspaceId: wsId, email: member.email }, owner),
      'conflict',
      'invitation_pending',
    );
    await expectHfos(
      () => run(membershipInvite, { workspaceId: wsId, email: 'not-an-email' }, owner),
      'validation',
    );
    await expectHfos(
      () => run(membershipInvite, { workspaceId: wsId, email: 'x@y.zz' }, outsider),
      'not_found',
    );
  });

  it('the pending list shows the inviter; the audit payload never carries a token', async () => {
    const { invitations: list } = await ask(workspaceInvitations, { workspaceId: wsId }, owner);
    expect(list.map((i) => i.email).sort()).toEqual([admin.email, member.email].sort());
    expect(list[0]?.invitedBy?.fullName).toBe(owner.fullName);
    const audits = await testDbs()
      .admin.db.select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, adminInviteId));
    expect(JSON.stringify(audits[0]?.after)).not.toMatch(/token/);
  });

  it('accept: wrong account 403, then the invitee joins once, and a replay is 409', async () => {
    const token = await mintToken(adminInviteId, wsId, orgId);
    const preview = await ask(invitationPreview, { token }, outsider);
    expect(preview).toMatchObject({
      status: 'pending',
      workspaceName: 'Lone Star HVAC & Roofing',
      role: 'admin',
      emailMatches: false,
    });
    await expectHfos(
      () => run(invitationAccept, { token }, outsider),
      'rule_violation',
      'invitation_email_mismatch',
    );
    const corr = randomUUID();
    const { output } = await run(invitationAccept, { token }, admin, meta(corr));
    expect(output).toMatchObject({ workspaceId: wsId, organizationId: orgId, role: 'admin' });
    const evs = await testDbs()
      .admin.db.select()
      .from(events)
      .where(eq(events.correlationId, corr));
    expect(evs.map((e) => e.eventType).sort()).toEqual([
      'invitation.accepted',
      'membership.created',
    ]);
    await expectHfos(
      () => run(invitationAccept, { token }, admin),
      'rule_violation',
      'invitation_used',
    );
    await expectHfos(
      () => run(invitationAccept, { token: 'definitely-not-a-real-token' }, admin),
      'not_found',
    );
  });

  it('admins invite at or below their rank; members cannot invite at all', async () => {
    await expectHfos(
      () =>
        run(membershipInvite, { workspaceId: wsId, email: 'boss@hfos.test', role: 'owner' }, admin),
      'forbidden',
      'cannot_grant_role',
    );
    const token = await mintToken(memberInviteId, wsId, orgId);
    await run(invitationAccept, { token }, member);
    await expectHfos(
      () => run(membershipInvite, { workspaceId: wsId, email: 'friend@hfos.test' }, member),
      'forbidden',
    );
  });

  it('resend emits a request for the worker; revoke ends the invitation; revoking again is 404', async () => {
    const { output } = await run(
      membershipInvite,
      { workspaceId: wsId, email: `later-${randomUUID().slice(0, 6)}@hfos.test` },
      admin,
    );
    const corr = randomUUID();
    await run(
      invitationResend,
      { workspaceId: wsId, invitationId: output.invitationId },
      admin,
      meta(corr),
    );
    const [ev] = await testDbs()
      .admin.db.select()
      .from(events)
      .where(eq(events.correlationId, corr));
    expect(ev?.eventType).toBe('invitation.resend_requested');
    await run(invitationRevoke, { workspaceId: wsId, invitationId: output.invitationId }, admin);
    await expectHfos(
      () => run(invitationRevoke, { workspaceId: wsId, invitationId: output.invitationId }, admin),
      'not_found',
    );
    await expectHfos(
      () => run(invitationResend, { workspaceId: wsId, invitationId: output.invitationId }, admin),
      'not_found',
    );
  });
});

describe('membership changes', () => {
  it('owner promotes a member; admin cannot touch an owner; nobody edits their own role', async () => {
    const { output } = await run(
      membershipChangeRole,
      { workspaceId: wsId, userId: member.id, role: 'admin' },
      owner,
    );
    expect(output).toEqual({ userId: member.id, previousRole: 'member', role: 'admin' });
    await expectHfos(
      () =>
        run(membershipChangeRole, { workspaceId: wsId, userId: owner.id, role: 'member' }, admin),
      'forbidden',
      'cannot_grant_role',
    );
    await expectHfos(
      () =>
        run(membershipChangeRole, { workspaceId: wsId, userId: owner.id, role: 'admin' }, owner),
      'forbidden',
      'own_role',
    );
    await expectHfos(
      () =>
        run(membershipChangeRole, { workspaceId: wsId, userId: outsider.id, role: 'admin' }, owner),
      'not_found',
    );
    await run(
      membershipChangeRole,
      { workspaceId: wsId, userId: member.id, role: 'member' },
      owner,
    );
  });

  it('the members query lists direct members and hides org staff from client members', async () => {
    const asOwner = await ask(workspaceMembers, { workspaceId: wsId }, owner);
    expect(asOwner.members.map((m) => m.role).sort()).toEqual(['admin', 'member', 'owner']);
    expect(asOwner.organizationAdmins).toEqual([]);
    const asMember = await ask(workspaceMembers, { workspaceId: wsId }, member);
    expect(asMember.members).toHaveLength(3);
    await expectHfos(() => ask(workspaceMembers, { workspaceId: wsId }, outsider), 'not_found');
  });

  it('a member may leave; an admin may remove a member but not an owner; the last owner cannot leave', async () => {
    const left = await run(membershipRemove, { workspaceId: wsId, userId: member.id }, member);
    expect(left.output).toEqual({ userId: member.id, left: true });
    await expectHfos(
      () => run(membershipRemove, { workspaceId: wsId, userId: owner.id }, admin),
      'forbidden',
      'cannot_remove_role',
    );
    await expectHfos(
      () => run(membershipRemove, { workspaceId: wsId, userId: owner.id }, owner),
      'rule_violation',
      'last_owner',
    );
    const { output } = await run(
      membershipInvite,
      { workspaceId: wsId, email: member.email },
      admin,
    );
    const token = await mintToken(output.invitationId, wsId, orgId);
    await run(invitationAccept, { token }, member);
    const removed = await run(membershipRemove, { workspaceId: wsId, userId: member.id }, admin);
    expect(removed.output).toEqual({ userId: member.id, left: false });
  });
});

describe('account and reads', () => {
  it('profile updates are account-level events visible to the user', async () => {
    const corr = randomUUID();
    const { output } = await run(
      userUpdateProfile,
      { fullName: 'Chris Martinez', settings: { theme: 'dark' } },
      owner,
      meta(corr),
    );
    expect(output.updated.sort()).toEqual(['fullName', 'settings']);
    const [ev] = await testDbs()
      .admin.db.select()
      .from(events)
      .where(eq(events.correlationId, corr));
    expect(ev).toMatchObject({
      eventType: 'user.profile_updated',
      organizationId: null,
      workspaceId: null,
      actorId: owner.id,
    });
    const profile = await ask(me, {}, owner);
    expect(profile.user.fullName).toBe('Chris Martinez');
    expect(profile.user.settings).toMatchObject({ theme: 'dark' });
    expect(profile.organizations.map((o) => o.role)).toEqual(['owner']);
    expect(profile.workspaces.find((w) => w.id === wsId)?.role).toBe('owner');
    await expectHfos(() => run(userUpdateProfile, {}, owner), 'validation');
  });

  it('workspace.get and audit.list respect permissions and paginate', async () => {
    const got = await ask(workspaceGet, { workspaceId: wsId }, admin);
    expect(got.workspace).toMatchObject({
      id: wsId,
      role: 'admin',
      organizationName: 'Go Biz Help',
    });
    expect(got.counts.members).toBe(2);
    const page1 = await ask(auditList, { workspaceId: wsId, limit: 3 }, owner);
    expect(page1.entries).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await ask(
      auditList,
      { workspaceId: wsId, limit: 50, before: page1.nextCursor! },
      owner,
    );
    expect(page2.entries.every((e) => e.createdAt < page1.entries[2]!.createdAt)).toBe(true);
    const onlyInvites = await ask(auditList, { workspaceId: wsId, action: 'invitation.' }, owner);
    expect(onlyInvites.entries.every((e) => e.action.startsWith('invitation.'))).toBe(true);
    await expectHfos(() => ask(auditList, { workspaceId: wsId }, outsider), 'not_found');
  });
});
