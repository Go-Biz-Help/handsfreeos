import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { asWorker } from '@hfos/db/client';
import { auditLogs, events, invitations, outbox, workspaceMemberships } from '@hfos/db/schema';
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
  workspaceJoin,
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
      'workspace.join',
      'workspace.update',
      'workspace.delete',
      'membership.invite',
      'invitation.resend',
      'invitation.revoke',
      'invitation.accept',
      'membership.change_role',
      'membership.remove',
      'organization.add_owner',
      'user.update_profile',
      'account.delete',
      'assistant.consent',
      'account.note_deleted',
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
      'record.add_tag',
      'record.remove_tag',
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
      'phone_number.set_caller_id',
      // M17: several numbers, moving one in, who sees which threads, and a business's own domain.
      'phone_number.set_default',
      'phone_number.set_label',
      'phone_number.set_members',
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
      'conversation.archive',
      'conversation.close',
      'conversation.close_all',
      'conversation.reopen',
      'conversation.restore',
      'conversation.link_person',
      'message.send',
      'message.retry',
      'message.cancel_scheduled',
      'message.release_scheduled',
      'message.receive',
      'message.update_status',
      'message.attach_media',
      'person.set_sms_consent',
      'message.record_opt_out',
      'call.start',
      'call.record',
      'call.update_status',
      'call.attach_recording',
      'call.attach_transcript',
      'call.connect_me',
      'call.cancel_connect',
      'user_phone.start_verification',
      'user_phone.record_call',
      'user_phone.verify',
      'email_domain.add',
      'email_domain.verify',
      'email_domain.remove',
      'email_domain.record',
      'email_address.create',
      'email_address.update',
      'mailbox.connect',
      'mailbox.disconnect',
      'mailbox.resync',
      'mailbox.activate',
      'mailbox.fail',
      'email.claim_unmatched',
      'email.dismiss_unmatched',
      'email_suppression.add',
      'email_suppression.release',
      'email.receive',
      'email_suppression.record',
      'assistant_thread.rename',
      'assistant_thread.archive',
      'calendar.create',
      'calendar.save',
      'calendar.restore_revision',
      'calendar.set_status',
      'calendar.set_slug',
      'service.create',
      'service.update',
      'service.archive',
      'resource.create',
      'resource.update',
      'resource.archive',
      'territory.create',
      'territory.update',
      'territory.delete',
      'booking_site.update',
      'schedule.set',
      'time_off.add',
      'time_off.remove',
      'appointment.create',
      'appointment.update',
      'appointment.reschedule',
      'appointment.reassign',
      'appointment.cancel',
      'appointment.set_status',
      'appointment.still_going',
      'appointment.add_attendee',
      'appointment.remove_attendee',
      'session.publish',
      'series.create',
      'series.cancel',
      'waitlist.add',
      'waitlist.remove',
      'appointment.book_online',
      'attendee.reschedule_online',
      'attendee.cancel_online',
      'booking.confirm_deposit',
      'booking.release_hold',
      'waitlist.join_online',
      'calendar_connection.connect',
      'calendar_connection.disconnect',
      'calendar_connection.sync_now',
      'calendar_connection.activate',
      'calendar_connection.fail',
      'attendee.record_reminder',
      'waitlist.promote',
      'waitlist.offer',
      'waitlist.expire',
      'waitlist.claim_online',
      'workflow.create',
      'workflow.save_draft',
      'workflow.rename',
      'workflow.publish',
      'workflow.pause',
      'workflow.resume',
      'workflow.archive',
      'workflow.restore_version',
      'workflow.test',
      'workflow.enrol',
      'workflow.remove_contact',
      'workflow.stop_run',
      'workflow.decide_approval',
      'workflow.retry_step',
      'workflow.skip_step',
      'workflow_proposal.apply',
      'workflow_proposal.create',
      'workflow_proposal.mark_applied',
      'workflow_template.create_from_workflow',
      'workflow_template.publish',
      'workflow_template.push',
      'workflow_template.save_draft',
      'workflow_template.install',
      'workflow_template.apply_update',
      'workflow_template.create',
      'workflow_template.rename',
      'knowledge_pack.create',
      'knowledge_pack.update',
      'knowledge_pack.push',
      'knowledge.profile_update',
      'knowledge_item.create',
      'knowledge_item.update',
      'knowledge_item.publish',
      'knowledge_item.archive',
      'offer.create',
      'offer.update',
      'offer.archive',
      'knowledge_item.import_faqs',
      'knowledge_document.begin_upload',
      'knowledge_document.add',
      'knowledge_document.save_text',
      'knowledge_source.set',
      'knowledge_scan.start',
      'knowledge_suggestion.accept',
      'knowledge_suggestion.reject',
      'knowledge_suggestion.propose',
      'knowledge_item.record_use',
      'lead.record_answers',
      'conversation.hand_off',
      'conversation.take_over',
      'conversation.hand_to_ai',
      'conversation.pick_up',
      'ai_teammate.create',
      'ai_teammate.save_config',
      'ai_teammate.restore',
      'ai_teammate.set_status',
      'ai_teammate.decide_draft',
      'ai_teammate.send_draft',
      'ai_teammate.retry',
      'appointment.book_for_customer',
      'attendee.reschedule_for_customer',
      'attendee.cancel_for_customer',
      'series.book_for_customer',
      'waitlist.join_for_customer',
      'appointment.add_for_customer',
      'job.set_status',
      'job.add_visit',
      'invoice.create_for_customer',
      'estimate.create_for_customer',
      'estimate.answer_for_customer',
      'subscription.start_for_customer',
      'chat.send_code_for_customer',
      'chat.check_code_for_customer',
      'intake_source.create',
      'intake_source.update',
      'intake_source.rotate_key',
      'intake_source.archive',
      'intake.submit',
      'chat_widget.create',
      'chat_widget.update',
      'chat_widget.pause',
      'chat_widget.resume',
      'chat_widget.rotate_key',
      'chat_widget.record_seen',
      'chat_visitor.start',
      'chat_visitor.resume',
      'chat_visitor.rotate_token',
      'chat_visitor.record_seen',
      'chat.receive',
      'chat.identify',
      'chat.mark_sent',
      'chat.mark_read',
      'chat.block_visitor',
      'chat.unblock_visitor',
      'attention.snooze',
      'attention.unsnooze',
      'attention.dismiss',
      'attention.restore',
      'attention.assign',
      'attention.let_handle',
      'attention.cancel_auto',
      'attention.save_settings',
      'attention.record_auto',
      'automations.save_settings',
      'referral.create_lead',
      'teammate_lesson.apply',
      'campaign.create',
      'campaign.update_draft',
      'campaign.remove_recipient',
      'campaign.approve',
      'campaign.pause',
      'campaign.resume',
      'campaign.cancel',
      'campaign.set_pace',
      'maintenance.set_schedule',
      'lead.catch_up',
      'attendee.confirm',
      'attendee.confirm_online',
      'product.create',
      'product.update',
      'product.archive',
      'plan.create',
      'plan.update',
      'plan.archive',
      'payment_connection.connect',
      'payment_connection.set_label',
      'payment_connection.set_default',
      'payment_connection.disconnect',
      'payment_connection.activate',
      'payment_connection.fail',
      'payment_connection.revoked',
      'estimate.create',
      'estimate.update',
      'estimate.send',
      'estimate.mark_accepted',
      'estimate.convert',
      'estimate.void',
      'estimate.accept_online',
      'estimate.decline_online',
      'estimate.record_view',
      'estimate.expire',
      'invoice.create',
      'invoice.update',
      'invoice.send',
      'invoice.void',
      'invoice.record_cash_payment',
      'invoice.record_payment',
      'invoice.record_view',
      'invoice.mark_overdue',
      'payment.refund',
      'payment.record_refund',
      'subscription.start',
      'subscription.pause',
      'subscription.resume',
      'subscription.request_card',
      'subscription.record_card',
      'subscription.set_connection',
      'subscription.cancel',
      'subscription.record_cycle',
      // M16: what a business pays HandsFreeOS, and how far along the rollout it is.
      'wallet.set_auto_topup',
      'wallet.request_card',
      'wallet.forget_card',
      'wallet.top_up',
      'wallet.record_card',
      'wallet.start_recharge',
      'wallet.record_recharge',
      'wallet.note_crossing',
      'wallet.suspend',
      'wallet.resume',
      'wallet.adjust',
      'wallet.set_stage',
      'founding.approve',
      'founding.decline',
      'founding.waitlist',
      'founding.claim',
      'founding.start_checkout',
      'founding.record_checkout_opened',
      'founding.record_checkout_paid',
      'founding.record_checkout_closed',
      'founding.revoke',
      'founding.restore',
      'founding.set_cap',
      'founding.set_status',
      'money.save_settings',
      'push_device.register',
      'push_device.remove',
      'migration.connect',
      'migration_connection.rename',
      'migration_connection.disconnect',
      'migration.create',
      'migration.scan',
      'migration.map_scopes',
      'migration.select',
      'migration.start',
      'migration.pause',
      'migration.resume',
      'migration.retry',
      'migration.extend_transition',
      'migration.finalize',
      'migration.rollback',
      'migration.delete',
      'migration.resolve_merge',
      'migration.task_done',
      // M13: the support desk, and the people who run it.
      'support.request.create',
      'support.ticket.reply',
      'support.ticket.set_status',
      'support.ticket.set_priority',
      'support.ticket.assign',
      'support.ticket.snooze',
      'support.ticket.link_business',
      'support.ticket.merge',
      'support.ticket.request_draft',
      'support.ticket.dismiss_draft',
      'support.canned_reply.save',
      'support.canned_reply.delete',
      'support.staff.invite',
      'support.staff.resend_invitation',
      'support.staff.revoke_invitation',
      'support.staff.accept',
      'support.staff.set_role',
      'support.staff.remove',
      'support.staff.save_profile',
      'platform.view_as.start',
      'platform.view_as.end',
      // Milestone 15: forms, surveys and quizzes.
      'form.create',
      'form.save_draft',
      'form.restore_version',
      'form.publish',
      'form.set_status',
      'form.rename',
      'form.set_slug',
      'form.set_delivery',
      'form.duplicate',
      'form.archive',
      'form.restore',
      'template.create',
      'template.update',
      'template.archive',
      'template.used',
      'review_connection.connect',
      'review_connection.activate',
      'review_connection.fail',
      'review_connection.disconnect',
      'review_connection.sync_now',
      'review.reply',
      'form_response.start',
      'form_response.save',
      'form_response.submit',
      'form_response.record',
      'form_response.delete',
      'number_port.start',
      'number_port.save',
      'number_port.begin_upload',
      'number_port.attach_document',
      'number_port.submit',
      'number_port.cancel',
      'number_port.record_state',
      'number_port.complete',
      'inbox.set_visibility',
      'branded_domain.add',
      'branded_domain.verify',
      'branded_domain.remove',
      'branded_domain.record',
      'custom_field.create',
      'custom_field.update',
      'custom_field.archive',
      'record.set_fields',
      'custom_record_type.create',
      'custom_record_type.update',
      'custom_record_type.archive',
      'custom_record_type.restore',
      'custom_record.create',
      'custom_record.update',
      'custom_record.archive',
      'custom_record.restore',
      'relationship_type.create',
      'relationship_type.update',
      'relationship_type.archive',
      'relationship_type.restore',
      'relationship.create',
      'relationship.update',
      'relationship.delete',
      // Ideas, the roadmap and What's new: the people's, then the team's.
      'idea.share',
      'idea.edit',
      'idea.vote',
      'idea.unvote',
      'idea.follow',
      'idea.comment',
      'idea.set_comment_hidden',
      'whats_new.mark_seen',
      'idea.set_status',
      'idea.merge',
      'idea.set_hidden',
      'idea_area.save',
      'whats_new.save',
      'whats_new.publish',
      'whats_new.unpublish',
      'whats_new.delete',
      'rcs_sender.connect',
      'rcs_sender.update',
      'rcs_sender.refresh',
      'rcs_sender.disconnect',
      'rcs_sender.record_state',
    ]);
    expect(registry.queries.map((q) => q.name)).toEqual([
      'migration.list',
      'migration.get',
      'migration.review_queue',
      'migration.rollback_preview',
      'migration.report',
      // M13: reading the support desk and the admin side.
      'support.ticket.list',
      'support.ticket.get',
      'support.queue.summary',
      'support.canned_reply.list',
      'support.staff.list',
      'platform.me',
      'platform.business.list',
      'platform.business.get',
      'platform.health.summary',
      'platform.view_as.current',
      'platform.rates',
      'platform.wallet.get',
      'founding.counts',
      'platform.founding',
      'founding.mine',
      'founding.claim_preview',
      'founding.checkout_status',
      'account.me',
      'account.deletion_check',
      'push_device.list',
      'user_phone.get',
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
      'crm.metrics',
      'intake.list',
      'phone.setup_status',
      'number_port.list',
      'branded_domain.get',
      'call.log',
      'inbox.list',
      'inbox.summary',
      'conversation.get',
      'conversation.thread',
      'message.get',
      'email.setup_status',
      'email_suppression.list',
      'email.unmatched_list',
      'email.compose_options',
      'assistant_thread.list',
      'assistant_thread.get',
      'calendar.list',
      'calendar.get',
      'calendar.availability',
      'appointment.list',
      'appointment.get',
      'schedule.team',
      'service.list',
      'resource.list',
      'territory.list',
      'booking_site.get',
      'calendar_connection.list',
      'workflow.list',
      'workflow.get',
      'workflow.version_get',
      'workflow.catalogs',
      'workflow.run_list',
      'workflow.run_get',
      'workflow.stats',
      'workflow.approval_list',
      'workflow.proposal_get',
      'workflow_template.list',
      'workflow_template.get',
      'knowledge.profile',
      'knowledge_item.list',
      'offer.list',
      'knowledge_item.get',
      'knowledge.search',
      'knowledge_scan.get',
      'knowledge_suggestion.list',
      'knowledge_pack.list',
      'ai_teammate.get',
      'ai_teammate.draft_list',
      'ai_teammate.activity',
      'chat_widget.list',
      'chat_widget.get',
      'attention.list',
      'attention.summary',
      'attention.for_record',
      'attention.preview_handle',
      'attention.settings',
      'maintenance.for_person',
      'product.list',
      'plan.list',
      'payment_connection.list',
      'estimate.list',
      'estimate.get',
      'invoice.list',
      'invoice.get',
      'payment.list',
      'subscription.list',
      'subscription.get',
      'money.summary',
      'money.for_record',
      'money.settings',
      'wallet.get',
      'usage.statement',
      'usage.prices',
      // Milestone 15.
      'form.list',
      'form.get',
      'form.version_get',
      'form.catalogs',
      'form.response_list',
      'form.response_get',
      'form.results',
      'campaign.list',
      'campaign.get',
      'campaign.preview_audience',
      'template.list',
      'review.list',
      'custom_field.list',
      'custom_record_type.list',
      'relationship_type.list',
      'custom_record.list',
      'custom_record.get',
      'relationship.list',
      'idea.list',
      'idea.get',
      'idea.similar',
      'idea.roadmap',
      'idea.areas',
      'whats_new.list',
      'whats_new.unseen',
      'idea.triage',
      'idea.team_view',
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

/** Who is on a workspace, by the admin client so no policy hides a row. */
const membersOf = async (workspaceId: string) =>
  (
    await testDbs()
      .admin.db.select({
        userId: workspaceMemberships.userId,
        role: workspaceMemberships.role,
      })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId))
  ).map((m) => ({ userId: m.userId, role: m.role as string }));

describe('workspace.create / workspace.join / workspace.update', () => {
  it('org owners can add a workspace; outsiders and non-org members get 404', async () => {
    const { output } = await run(
      workspaceCreate,
      { organizationId: orgId, name: 'Bayou Plumbing Co.' },
      owner,
    );
    expect(output.slug).toMatch(/^bayou-plumbing-co-[a-f0-9]{6}$/);
    // Set up for a client: nobody is on it, so the organization's owners and admins hear about it
    // until the client's own people are invited.
    expect(await membersOf(output.workspaceId)).toEqual([]);
    await expectHfos(
      () => run(workspaceCreate, { organizationId: orgId, name: 'Nope' }, outsider),
      'not_found',
    );
  });

  it('puts the creator on a business they say they run, and lets them join one later', async () => {
    const { output } = await run(
      workspaceCreate,
      { organizationId: orgId, name: 'Run By Me', joinAsOwner: true },
      owner,
    );
    expect(await membersOf(output.workspaceId)).toEqual([{ userId: owner.id, role: 'owner' }]);

    // The other answer, changed afterwards: set up for a client, then taken on.
    const { output: later } = await run(
      workspaceCreate,
      { organizationId: orgId, name: 'Taken On Later' },
      owner,
    );
    expect(await membersOf(later.workspaceId)).toEqual([]);
    const joined = await run(workspaceJoin, { workspaceId: later.workspaceId }, owner);
    expect(joined.output).toMatchObject({ workspaceId: later.workspaceId, role: 'owner' });
    expect(await membersOf(later.workspaceId)).toEqual([{ userId: owner.id, role: 'owner' }]);
    // Twice is the same once: joining again neither duplicates the row nor fails.
    await run(workspaceJoin, { workspaceId: later.workspaceId }, owner);
    expect(await membersOf(later.workspaceId)).toEqual([{ userId: owner.id, role: 'owner' }]);
    // Somebody outside the organization can't put themselves on it.
    await expectHfos(
      () => run(workspaceJoin, { workspaceId: later.workspaceId }, outsider),
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

  it('stores an older zone name as its current one, and refuses abbreviations and offsets', async () => {
    const stored = async () =>
      (await ask(workspaceGet, { workspaceId: wsId }, owner)).workspace.timezone;
    const { output } = await run(
      workspaceUpdate,
      { workspaceId: wsId, timezone: 'US/Mountain' },
      owner,
    );
    expect(output.updated).toEqual(['timezone']);
    expect(await stored()).toBe('America/Denver');
    // Chicago's older name is the zone it already has: nothing changes.
    await run(workspaceUpdate, { workspaceId: wsId, timezone: 'America/Chicago' }, owner);
    expect(
      (await run(workspaceUpdate, { workspaceId: wsId, timezone: 'US/Central' }, owner)).output
        .updated,
    ).toEqual([]);
    for (const timezone of ['CST', 'GMT+5', 'Etc/GMT+6']) {
      const err = await expectHfos(
        () => run(workspaceUpdate, { workspaceId: wsId, timezone }, owner),
        'validation',
      );
      expect((err.details as { path: string }[]).map((d) => d.path)).toEqual(['timezone']);
    }
    expect(await stored()).toBe('America/Chicago');
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

  it('audit.list filters by where a change was made from', async () => {
    const corr = randomUUID();
    await run(workspaceUpdate, { workspaceId: wsId, timezone: 'America/Denver' }, owner, {
      ...meta(corr),
      channel: 'assistant',
    });
    await run(workspaceUpdate, { workspaceId: wsId, timezone: 'America/Chicago' }, owner);
    const viaAssistant = await ask(auditList, { workspaceId: wsId, channel: 'assistant' }, owner);
    expect(viaAssistant.entries.map((e) => [e.correlationId, e.channel])).toEqual([
      [corr, 'assistant'],
    ]);
    const viaTests = await ask(auditList, { workspaceId: wsId, channel: 'test' }, owner);
    expect(viaTests.entries.length).toBeGreaterThan(0);
    expect(viaTests.entries.every((e) => e.channel === 'test')).toBe(true);
    await expectHfos(
      () => ask(auditList, { workspaceId: wsId, channel: 'fax' }, owner),
      'validation',
    );
  });
});
