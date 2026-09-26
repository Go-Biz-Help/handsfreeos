/**
 * The Assistant's inbox and customer tools, against the real database: a conversation's own buttons (assign, close,
 * reopen, snooze, read and unread, the AI teammate, linking an unknown number, a held text and a failed one), archiving
 * anything and bringing it back, companies, who looks after a customer, what a customer said about calls and texts,
 * the business's own records and what they're related to, and a file on a record. Every change shows its card first,
 * changes nothing until Confirm, and then runs the command as the person, "via Assistant".
 */
import { randomUUID } from 'node:crypto';
import {
  aiTeammateCreate,
  aiTeammateSetStatus,
  assistantToolByName,
  customRecordTypeCreate,
  executeCommand,
  hasWorkspacePermission,
  leadCreate,
  organizationCreate,
  personCreate,
  type AssistantCard,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import { inboxCrmStepLabels } from '../src/assistant/tools-inbox-crm';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
): Promise<z.output<O>> =>
  (
    await executeCommand(api(), cmd, input, actor(u), {
      correlationId: randomUUID(),
      channel: 'test',
    })
  ).output;

let dale: TestUser;
let marco: TestUser;
let workspaceId: string;
let organizationId: string;
let bob: string;
let ann: string;
/** Bob's texts, a stranger's text, and Ann's email. */
let bobText: string;
let stranger: string;
let annMail: string;
let heldText: string;
let failedText: string;
let failedEmail: string;

const ctx = (u: TestUser = dale): ToolContext => ({
  actor: actor(u),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const tools = () => createToolExecutor(api());
const tool = (name: string) => assistantToolByName.get(name)!;
/** The arguments as the runtime hands them over: checked against the tool's input, defaults filled. */
const argsOf = (name: string, args: Record<string, unknown>) =>
  tool(name).input.parse(args) as Record<string, unknown>;
type Confirm = Extract<AssistantCard, { type: 'confirm' }>;
const prepare = async (name: string, args: Record<string, unknown>) =>
  (await tools().prepare(tool(name), argsOf(name, args), ctx(), randomUUID())) as {
    card: Confirm;
    result: Record<string, unknown>;
  };
const commit = (name: string, args: Record<string, unknown>) =>
  tools().commit(tool(name), argsOf(name, args), ctx(), { toolCallId: randomUUID() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (name: string, args: Record<string, unknown>): Promise<any> =>
  ((await tools().run(tool(name), argsOf(name, args), ctx())) as { result: unknown }).result;
const field = (card: { fields: { label: string; value: string }[] }, label: string) =>
  card.fields.find((f) => f.label === label)?.value;
const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
  (await rows<T>(admin(), query))[0]!;
const conv = (id: string) =>
  one<{
    status: string;
    assignee_user_id: string | null;
    unread_count: number;
    handled_by: string;
    taken_over_by: string | null;
    person_id: string | null;
    archived: boolean;
  }>(
    sql`select status::text as status, assignee_user_id, unread_count, handled_by::text as handled_by,
          taken_over_by, person_id, archived_at is not null as archived
        from app.conversations where id = ${id}`,
  );
const message = (id: string) =>
  one<{ status: string; error_code: string | null }>(
    sql`select status::text as status, error_code from app.messages where id = ${id}`,
  );
const archived = async (table: string, id: string) =>
  (
    await one<{ archived: boolean }>(
      sql`select archived_at is not null as archived from ${sql.raw(`app.${table}`)} where id = ${id}`,
    )
  ).archived;

async function insertConversation(
  channel: 'sms' | 'email',
  counterpart: string,
  personId: string | null,
  status: 'open' | 'closed',
  unread = 0,
): Promise<string> {
  return (
    await one<{ id: string }>(
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, status, unread_count, last_message_at)
          values (${workspaceId}, ${channel}, ${counterpart}, ${personId},
            ${status}, ${unread}, now())
          returning id`,
    )
  ).id;
}
async function insertMessage(
  conversationId: string,
  m: {
    channel: 'sms' | 'email';
    direction: 'inbound' | 'outbound';
    status: string;
    body: string;
    subject?: string;
    errorCode?: string;
    errorMessage?: string;
    at?: string;
  },
): Promise<string> {
  return (
    await one<{ id: string }>(
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, subject,
            error_code, error_message, occurred_at)
          values (${workspaceId}, ${conversationId}, ${m.channel},
            ${m.direction}, ${m.status}, ${m.body},
            ${m.subject ?? null}, ${m.errorCode ?? null}, ${m.errorMessage ?? null},
            now() + ${m.at ?? '0 minutes'}::interval)
          returning id`,
    )
  ).id;
}

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('aicrm-dale', { fullName: 'Dale Owner' }),
    createTestUser('aicrm-marco', { fullName: 'Marco Member' }),
  ]);
  const org = await run(
    organizationCreate,
    { businessName: `Inbox CRM HVAC ${randomUUID().slice(0, 8)}`, timezone: CHI },
    dale,
  );
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${marco.id}, 'member')`,
  );
  bob = (
    await run(
      personCreate,
      { workspaceId, firstName: 'Bob', lastName: 'Reyes', phone: '512-555-0142' },
      dale,
    )
  ).personId;
  ann = (
    await run(
      personCreate,
      { workspaceId, firstName: 'Ann', lastName: 'Lee', email: 'ann@lee.test' },
      dale,
    )
  ).personId;
  bobText = await insertConversation('sms', '+15125550142', bob, 'open', 2);
  await insertMessage(bobText, {
    channel: 'sms',
    direction: 'inbound',
    status: 'received',
    body: 'Is Tuesday still good?',
    at: '-2 hours',
  });
  failedText = await insertMessage(bobText, {
    channel: 'sms',
    direction: 'outbound',
    status: 'failed',
    body: 'Running 10 minutes late.',
    errorMessage: 'The carrier turned it away.',
    at: '-1 hour',
  });
  heldText = await insertMessage(bobText, {
    channel: 'sms',
    direction: 'outbound',
    status: 'queued',
    body: 'See you Tuesday at 9.',
    errorCode: 'scheduled',
    at: '5 hours',
  });
  stranger = await insertConversation('sms', '+15125550199', null, 'open', 1);
  await insertMessage(stranger, {
    channel: 'sms',
    direction: 'inbound',
    status: 'received',
    body: 'Hi, do you fix water heaters?',
  });
  annMail = await insertConversation('email', 'ann@lee.test', ann, 'closed');
  failedEmail = await insertMessage(annMail, {
    channel: 'email',
    direction: 'outbound',
    status: 'failed',
    subject: 'Your estimate',
    body: 'Here is the estimate we talked about.',
    errorMessage: 'Their mailbox is full.',
  });
}, 60_000);
afterAll(closeTestDbs);

const NAMES = [
  'find_conversations',
  'unsent_messages',
  'manage_conversation',
  'archive_or_restore',
  'find_archived',
  'manage_company',
  'assign_customer',
  'record_consent',
  'find_records',
  'get_record_details',
  'manage_record',
  'delete_file',
];

describe('the tools', () => {
  it('each have an executor and a step label, and are offered to the roles that can press the buttons', () => {
    for (const name of NAMES) {
      expect(executorFor(name), name).toBeTruthy();
      expect(inboxCrmStepLabels[name], name).toBeTruthy();
    }
    const member = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    expect(member).toEqual(
      expect.arrayContaining([
        'find_conversations',
        'manage_conversation',
        'record_consent',
        'manage_company',
        'manage_record',
        'delete_file',
      ]),
    );
    // Archiving and choosing who looks after a customer are owners' and admins'.
    expect(member).not.toContain('archive_or_restore');
    expect(member).not.toContain('assign_customer');
    const owner = toolsFor((p) => hasWorkspacePermission('owner', p)).map((t) => t.name);
    expect(owner).toEqual(expect.arrayContaining(NAMES));
  });
});

describe('a conversation’s buttons', () => {
  it('assigns it to a teammate and back to nobody, only after Confirm, as the person via the Assistant', async () => {
    const { card } = await prepare('manage_conversation', {
      action: 'assign',
      conversationId: bobText,
      assigneeUserId: marco.id,
    });
    expect(card.title).toBe('Give the conversation with Bob Reyes to Marco Member?');
    expect(field(card, 'Assigned to')).toBe('Marco Member');
    expect(field(card, 'Was')).toBe('Nobody');
    expect((await conv(bobText)).assignee_user_id).toBeNull();

    const done = await commit('manage_conversation', {
      action: 'assign',
      conversationId: bobText,
      assigneeUserId: marco.id,
    });
    expect(done).toMatchObject({ outcome: 'Assigned', command: 'conversation.assign' });
    expect((await conv(bobText)).assignee_user_id).toBe(marco.id);
    const audit = await rows<{ channel: string }>(
      admin(),
      sql`select channel from app.audit_logs
          where workspace_id = ${workspaceId} and entity_id = ${bobText} and action = 'conversation.assign'`,
    );
    expect(audit).toEqual([{ channel: 'assistant' }]);

    const back = await prepare('manage_conversation', {
      action: 'assign',
      conversationId: bobText,
      assigneeUserId: null,
    });
    expect(back.card.title).toBe('Unassign the conversation with Bob Reyes?');
    await commit('manage_conversation', {
      action: 'assign',
      conversationId: bobText,
      assigneeUserId: null,
    });
    expect((await conv(bobText)).assignee_user_id).toBeNull();
    await expect(
      prepare('manage_conversation', {
        action: 'assign',
        conversationId: bobText,
        assigneeUserId: null,
      }),
    ).rejects.toThrow('It’s unassigned already.');
  });

  it('marks it read and unread', async () => {
    const { card } = await prepare('manage_conversation', {
      action: 'mark_read',
      conversationId: bobText,
    });
    expect(field(card, 'Unread now')).toBe('2 messages');
    expect((await conv(bobText)).unread_count).toBe(2);
    await commit('manage_conversation', { action: 'mark_read', conversationId: bobText });
    expect((await conv(bobText)).unread_count).toBe(0);

    await prepare('manage_conversation', { action: 'mark_unread', conversationId: bobText });
    await commit('manage_conversation', { action: 'mark_unread', conversationId: bobText });
    expect((await conv(bobText)).unread_count).toBe(1);
  });

  it('snoozes it until a time, finds it among the snoozed, and reopens it', async () => {
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const { card } = await prepare('manage_conversation', {
      action: 'snooze',
      conversationId: bobText,
      until,
    });
    expect(card.title).toBe('Snooze the conversation with Bob Reyes?');
    expect(field(card, 'Comes back')).toBeTruthy();
    expect(card.warnings[0]?.text).toBe('It comes back then, or sooner if they write.');
    expect((await conv(bobText)).status).toBe('open');
    await commit('manage_conversation', { action: 'snooze', conversationId: bobText, until });
    expect((await conv(bobText)).status).toBe('snoozed');

    const snoozed = await read('find_conversations', { status: 'snoozed' });
    expect(snoozed.conversations.map((c: { id: string }) => c.id)).toContain(bobText);
    expect(snoozed.conversations[0].snoozedUntil).toBeTruthy();

    await expect(
      prepare('manage_conversation', {
        action: 'snooze',
        conversationId: bobText,
        until: new Date(Date.now() + 100 * 86_400_000).toISOString(),
      }),
    ).rejects.toThrow('Snooze for 90 days at most.');

    const reopen = await prepare('manage_conversation', {
      action: 'reopen',
      conversationId: bobText,
    });
    expect(field(reopen.card, 'Was')).toMatch(/^Snoozed until /);
    await commit('manage_conversation', { action: 'reopen', conversationId: bobText });
    expect((await conv(bobText)).status).toBe('open');
  });

  it('closes it, and finds it among the closed', async () => {
    const { card } = await prepare('manage_conversation', {
      action: 'close',
      conversationId: bobText,
    });
    expect(card.confirmLabel).toBe('Close it');
    expect((await conv(bobText)).status).toBe('open');
    await commit('manage_conversation', { action: 'close', conversationId: bobText });
    expect((await conv(bobText)).status).toBe('closed');
    const closed = await read('find_conversations', { status: 'closed', query: 'Bob' });
    expect(closed.conversations.map((c: { id: string }) => c.id)).toEqual([bobText]);
    await commit('manage_conversation', { action: 'reopen', conversationId: bobText });
  });

  it('hands it to the AI teammate once there is one, and takes it back', async () => {
    const none = await prepare('manage_conversation', {
      action: 'hand_to_ai',
      conversationId: bobText,
    });
    expect(none.card.confirmLabel).toBe('');
    expect(none.card.warnings[0]).toMatchObject({ kind: 'blocked' });
    expect(none.result).toMatchObject({ blocked: true });

    const { teammateId } = await run(
      aiTeammateCreate,
      { workspaceId, preset: 'lead_responder', name: 'Ava' },
      dale,
    );
    await run(aiTeammateSetStatus, { workspaceId, teammateId, status: 'training' }, dale);
    const { card } = await prepare('manage_conversation', {
      action: 'hand_to_ai',
      conversationId: bobText,
    });
    expect(card.title).toBe('Hand the conversation with Bob Reyes to Ava?');
    expect(card.warnings[0]?.text).toContain('still in training');
    expect((await conv(bobText)).handled_by).toBe('none');
    await commit('manage_conversation', { action: 'hand_to_ai', conversationId: bobText });
    expect((await conv(bobText)).handled_by).toBe('ai');

    const take = await prepare('manage_conversation', {
      action: 'take_over',
      conversationId: bobText,
    });
    expect(field(take.card, 'Was')).toBe('Ava (AI)');
    await commit('manage_conversation', { action: 'take_over', conversationId: bobText });
    expect(await conv(bobText)).toMatchObject({ handled_by: 'person', taken_over_by: dale.id });
  });

  it('links an unknown number to a customer, whose number it becomes', async () => {
    const { card } = await prepare('manage_conversation', {
      action: 'link_customer',
      conversationId: stranger,
      personId: ann,
    });
    expect(card.title).toBe('Link (512) 555-0199 to Ann Lee?');
    expect(card.warnings.map((w) => w.text)).toContain(
      '(512) 555-0199 becomes their phone number.',
    );
    expect((await conv(stranger)).person_id).toBeNull();
    await commit('manage_conversation', {
      action: 'link_customer',
      conversationId: stranger,
      personId: ann,
    });
    expect((await conv(stranger)).person_id).toBe(ann);
    const { phone_e164 } = await one<{ phone_e164: string | null }>(
      sql`select phone_e164 from app.people where id = ${ann}`,
    );
    expect(phone_e164).toBe('+15125550199');
  });

  it('lists what is waiting and what didn’t go, with their ids', async () => {
    const out = await read('unsent_messages', { conversationId: bobText });
    expect(out.waitingForQuietHours).toEqual([
      expect.objectContaining({ messageId: heldText, text: 'See you Tuesday at 9.' }),
    ]);
    expect(out.didNotGo).toEqual([
      expect.objectContaining({ messageId: failedText, why: 'The carrier turned it away.' }),
    ]);
  });

  it('cancels a text held for quiet hours', async () => {
    const args = { action: 'cancel_held_text', conversationId: bobText, messageId: heldText };
    const { card } = await prepare('manage_conversation', args);
    expect(card.title).toBe('Cancel the text to Bob Reyes?');
    expect(field(card, 'Text')).toBe('See you Tuesday at 9.');
    expect((await message(heldText)).error_code).toBe('scheduled');
    await commit('manage_conversation', args);
    expect((await message(heldText)).error_code).toBe('cancelled');
    expect(
      (await read('unsent_messages', { conversationId: bobText })).waitingForQuietHours,
    ).toEqual([]);
    await expect(prepare('manage_conversation', args)).rejects.toThrow(
      'That text is cancelled already.',
    );
  });

  it('won’t send a text again from a business with no number, and says why before anyone agrees', async () => {
    const { card, result } = await prepare('manage_conversation', {
      action: 'send_again',
      conversationId: bobText,
      messageId: failedText,
    });
    expect(card.confirmLabel).toBe('');
    expect(card.warnings[0]).toEqual({
      kind: 'blocked',
      text: 'There’s no business number to text from yet.',
    });
    expect(result).toMatchObject({ blocked: true });
    // A message from another conversation, or one that went, is refused outright.
    await expect(
      prepare('manage_conversation', {
        action: 'send_again',
        conversationId: bobText,
        messageId: failedEmail,
      }),
    ).rejects.toThrow('That message isn’t in this conversation.');
  });

  it('sends an email that didn’t go out again, saying it reaches them now', async () => {
    const args = { action: 'send_again', conversationId: annMail, messageId: failedEmail };
    const { card } = await prepare('manage_conversation', args);
    expect(card.title).toBe('Send this email to Ann Lee again?');
    expect(field(card, 'Subject')).toBe('Your estimate');
    expect(field(card, 'Didn’t go because')).toBe('Their mailbox is full.');
    expect(card.warnings[0]).toEqual({ kind: 'caution', text: 'It goes to Ann Lee now.' });
    expect((await message(failedEmail)).status).toBe('failed');
    await commit('manage_conversation', args);
    expect((await message(failedEmail)).status).toBe('queued');
  });
});

describe('archiving and bringing back', () => {
  let lead: string;

  it('holds back a customer with open work, then archives them with their leads when asked again', async () => {
    lead = (await run(leadCreate, { workspaceId, title: 'Water heater swap', personId: bob }, dale))
      .leadId;
    const first = await prepare('archive_or_restore', {
      action: 'archive',
      what: 'customer',
      id: bob,
    });
    expect(first.card.title).toBe('Bob Reyes still has open work');
    expect(first.card.confirmLabel).toBe('');
    expect(field(first.card, 'Open leads')).toBe('1');
    expect(first.result).toMatchObject({ blocked: true });

    const args = { action: 'archive', what: 'customer', id: bob, archiveOpenLeads: true };
    const { card } = await prepare('archive_or_restore', args);
    expect(card.title).toBe('Archive Bob Reyes anyway?');
    expect(card.confirmLabel).toBe('Archive anyway');
    expect(field(card, 'Open leads')).toBe('1, archived too');
    expect(await archived('people', bob)).toBe(false);

    const done = await commit('archive_or_restore', args);
    expect(done.outcome).toBe('Archived, with 1 open lead');
    expect(await archived('people', bob)).toBe(true);
    expect(await archived('leads', lead)).toBe(true);
  });

  it('finds what is archived, and brings back the lead and the customer', async () => {
    const found = await read('find_archived', { query: 'Bob' });
    expect(found.customers).toEqual([expect.objectContaining({ id: bob, name: 'Bob Reyes' })]);
    const leads = await read('find_archived', { what: 'lead', query: 'Water heater' });
    expect(leads.leads).toEqual([expect.objectContaining({ id: lead, customer: 'Bob Reyes' })]);

    const { card } = await prepare('archive_or_restore', {
      action: 'restore',
      what: 'lead',
      id: lead,
    });
    expect(card.title).toBe('Bring back the lead “Water heater swap”?');
    await commit('archive_or_restore', { action: 'restore', what: 'lead', id: lead });
    expect(await archived('leads', lead)).toBe(false);

    await prepare('archive_or_restore', { action: 'restore', what: 'customer', id: bob });
    await commit('archive_or_restore', { action: 'restore', what: 'customer', id: bob });
    expect(await archived('people', bob)).toBe(false);
    await expect(
      prepare('archive_or_restore', { action: 'restore', what: 'customer', id: bob }),
    ).rejects.toThrow('Bob Reyes isn’t archived.');
  });

  it('puts a conversation away and brings it back', async () => {
    const args = { action: 'archive', what: 'conversation', id: stranger };
    const { card } = await prepare('archive_or_restore', args);
    expect(card.title).toBe('Archive the conversation with Ann Lee?');
    expect((await conv(stranger)).archived).toBe(false);
    await commit('archive_or_restore', args);
    expect((await conv(stranger)).archived).toBe(true);
    const box = await read('find_conversations', { box: 'archived' });
    expect(box.conversations.map((c: { id: string }) => c.id)).toContain(stranger);
    await commit('archive_or_restore', { action: 'restore', what: 'conversation', id: stranger });
    expect((await conv(stranger)).archived).toBe(false);
  });
});

describe('companies', () => {
  let bayou: string;

  it('adds one, warning when it may be there already', async () => {
    const args = {
      action: 'create',
      name: 'Bayou Dental',
      phone: '713-555-0100',
      address: { city: 'Houston' },
    };
    const { card } = await prepare('manage_company', args);
    expect(card.title).toBe('Add Bayou Dental as a company?');
    expect(card.confirmLabel).toBe('Add company');
    expect(field(card, 'Phone')).toBe('(713) 555-0100');
    const none = await rows(
      admin(),
      sql`select id from app.companies where workspace_id = ${workspaceId} and name = 'Bayou Dental'`,
    );
    expect(none).toEqual([]);
    const done = await commit('manage_company', args);
    expect(done.command).toBe('company.create');
    bayou = (
      await one<{ id: string }>(
        sql`select id from app.companies where workspace_id = ${workspaceId} and name = 'Bayou Dental'`,
      )
    ).id;

    const again = await prepare('manage_company', { action: 'create', name: 'Bayou Dental' });
    expect(again.card.confirmLabel).toBe('Add anyway');
    expect(again.card.warnings[0]?.kind).toBe('duplicate');
    await expect(
      prepare('manage_company', { action: 'create', name: 'Gulf Air', phone: 'not a phone' }),
    ).rejects.toThrow('Enter a valid phone number.');
  });

  it('changes only what was said, showing what it was', async () => {
    const args = {
      action: 'change',
      companyId: bayou,
      website: 'bayoudental.test',
      address: { city: 'Houston', state: 'TX' },
      phone: null,
    };
    const { card } = await prepare('manage_company', args);
    expect(card.title).toBe('Change Bayou Dental?');
    expect(field(card, 'Website')).toBe('bayoudental.test');
    expect(field(card, 'Phone')).toBe('Taken off (was (713) 555-0100)');
    expect(field(card, 'State')).toBe('TX');
    await commit('manage_company', args);
    const row = await one<{ website: string; state: string; phone_e164: string | null }>(
      sql`select website, state, phone_e164 from app.companies where id = ${bayou}`,
    );
    expect(row).toEqual({ website: 'bayoudental.test', state: 'TX', phone_e164: null });
    await expect(
      prepare('manage_company', {
        action: 'change',
        companyId: bayou,
        website: 'bayoudental.test',
      }),
    ).rejects.toThrow('Nothing would change.');
  });

  it('archives it and brings it back', async () => {
    const { card } = await prepare('archive_or_restore', {
      action: 'archive',
      what: 'company',
      id: bayou,
    });
    expect(card.title).toBe('Archive Bayou Dental?');
    await commit('archive_or_restore', { action: 'archive', what: 'company', id: bayou });
    expect(await archived('companies', bayou)).toBe(true);
    expect((await read('find_archived', { what: 'company' })).companies).toEqual([
      expect.objectContaining({ id: bayou }),
    ]);
    await commit('archive_or_restore', { action: 'restore', what: 'company', id: bayou });
    expect(await archived('companies', bayou)).toBe(false);
  });
});

describe('who looks after a customer', () => {
  const team = () =>
    one<{ owner_user_id: string | null; team_user_ids: string[] }>(
      sql`select owner_user_id, team_user_ids from app.people where id = ${ann}`,
    );

  it('puts people on, makes one main, and takes one off', async () => {
    const first = await prepare('assign_customer', {
      action: 'add',
      recordId: ann,
      userId: marco.id,
    });
    expect(first.card.title).toBe('Make Marco Member the main person on Ann Lee?');
    expect((await team()).owner_user_id).toBeNull();
    await commit('assign_customer', { action: 'add', recordId: ann, userId: marco.id });
    expect((await team()).owner_user_id).toBe(marco.id);

    const second = await prepare('assign_customer', {
      action: 'add',
      recordId: ann,
      userId: dale.id,
    });
    expect(second.card.title).toBe('Put Dale Owner on Ann Lee?');
    expect(field(second.card, 'Also on it')).toBe('Dale Owner');
    await commit('assign_customer', { action: 'add', recordId: ann, userId: dale.id });

    const main = await prepare('assign_customer', {
      action: 'make_main',
      recordId: ann,
      userId: dale.id,
    });
    expect(main.card.warnings[0]?.text).toBe('Marco Member stays on it.');
    await commit('assign_customer', { action: 'make_main', recordId: ann, userId: dale.id });
    expect(await team()).toEqual({ owner_user_id: dale.id, team_user_ids: [marco.id] });

    const off = await prepare('assign_customer', {
      action: 'remove',
      recordId: ann,
      userId: marco.id,
    });
    expect(off.card.title).toBe('Take Marco Member off Ann Lee?');
    await commit('assign_customer', { action: 'remove', recordId: ann, userId: marco.id });
    expect(await team()).toEqual({ owner_user_id: dale.id, team_user_ids: [] });

    const details = await read('get_record_details', { recordType: 'person', recordId: ann });
    expect(details.lookedAfterBy).toEqual({
      main: { userId: dale.id, name: 'Dale Owner' },
      alsoOnIt: [],
    });
    await expect(
      prepare('assign_customer', { action: 'remove', recordId: ann, userId: marco.id }),
    ).rejects.toThrow('Marco Member isn’t on Ann Lee.');
  });
});

describe('what a customer said about being contacted', () => {
  const consent = () =>
    one<{ call_consent: string; call_consent_source: string | null; sms_consent: string }>(
      sql`select call_consent::text as call_consent, call_consent_source, sms_consent::text as sms_consent
          from app.people where id = ${bob}`,
    );

  it('records a written yes to calls with where it’s written, and a no', async () => {
    await expect(
      prepare('record_consent', { personId: bob, what: 'calls', answer: 'agreed' }),
    ).rejects.toThrow(/Say where they agreed in writing/);
    const args = {
      personId: bob,
      what: 'calls',
      answer: 'agreed',
      where: 'Signed service agreement',
    };
    const { card } = await prepare('record_consent', args);
    expect(card.title).toBe('Record that Bob Reyes agreed to calls?');
    expect(field(card, 'Where they agreed')).toBe('Signed service agreement');
    expect(card.warnings[0]?.kind).toBe('caution');
    expect((await consent()).call_consent).toBe('unknown');
    await commit('record_consent', args);
    expect(await consent()).toMatchObject({
      call_consent: 'opted_in',
      call_consent_source: 'Signed service agreement',
    });

    await prepare('record_consent', { personId: bob, what: 'calls', answer: 'said_no' });
    await commit('record_consent', { personId: bob, what: 'calls', answer: 'said_no' });
    expect((await consent()).call_consent).toBe('opted_out');
  });

  it('records a no to texts, and leaves a yes to the customer', async () => {
    const yes = await prepare('record_consent', { personId: bob, what: 'texts', answer: 'agreed' });
    expect(yes.card.confirmLabel).toBe('');
    expect(yes.card.warnings[0]?.kind).toBe('blocked');
    await expect(
      commit('record_consent', { personId: bob, what: 'texts', answer: 'agreed' }),
    ).rejects.toThrow(/has to come from them/);

    const args = { personId: bob, what: 'texts', answer: 'said_no' };
    const { card } = await prepare('record_consent', args);
    expect(card.title).toBe('Record that Bob Reyes doesn’t want texts?');
    expect(field(card, 'Number')).toBe('(512) 555-0142');
    expect((await consent()).sms_consent).toBe('unknown');
    await commit('record_consent', args);
    expect((await consent()).sms_consent).toBe('opted_out');
    await expect(prepare('record_consent', args)).rejects.toThrow(
      'Bob Reyes is already marked as not wanting texts.',
    );
  });
});

describe('the business’s own records', () => {
  let petType: string;
  let ownerType: string;
  let breed: string;
  let sizeField: string;
  let small: string;
  let max: string;

  beforeAll(async () => {
    const made = await run(
      customRecordTypeCreate,
      {
        workspaceId,
        singular: 'Pet',
        fields: [
          { label: 'Breed', type: 'text' },
          { label: 'Size', type: 'choice', options: ['Small', 'Large'] },
        ],
        link: { end: 'person', label: 'Owner', recordLabel: 'Pet' },
      },
      dale,
    );
    petType = made.customRecordTypeId;
    ownerType = made.relationshipTypeId!;
  });

  it('lists the kinds with their fields, how records relate, and the records', async () => {
    const out = await read('find_records', {});
    const pets = out.kinds.find((k: { typeId: string }) => k.typeId === petType);
    expect(pets.name).toBe('Pet');
    breed = pets.fields.find((f: { label: string }) => f.label === 'Breed').fieldId;
    const size = pets.fields.find((f: { label: string }) => f.label === 'Size');
    sizeField = size.fieldId;
    small = size.choices.find((c: { label: string }) => c.label === 'Small').value;
    expect(out.relationshipTypes).toEqual([
      expect.objectContaining({
        relationshipTypeId: ownerType,
        a: { label: 'Owner', is: 'customer' },
        b: { label: 'Pet', is: 'Pet' },
      }),
    ]);
    expect(out.records).toEqual([]);
  });

  it('adds a pet with its fields, related to its owner as it’s made', async () => {
    const args = {
      action: 'create',
      typeId: petType,
      name: 'Max',
      values: { [breed]: 'Beagle', [sizeField]: small },
      relationshipTypeId: ownerType,
      relateToId: bob,
    };
    const { card } = await prepare('manage_record', args);
    expect(card.title).toBe('Add Max as a new pet?');
    expect(field(card, 'Owner')).toBe('Bob Reyes');
    expect(field(card, 'Breed')).toBe('Beagle');
    expect(field(card, 'Size')).toBe('Small');
    expect((await read('find_records', { query: 'Max' })).records).toEqual([]);
    await commit('manage_record', args);
    const [found] = (await read('find_records', { query: 'Max' })).records;
    max = found.id;
    expect(found).toMatchObject({ kind: 'Pet', name: 'Max' });
    expect(found.relatedTo).toEqual([expect.objectContaining({ id: bob, name: 'Bob Reyes' })]);
    await expect(
      prepare('manage_record', { ...args, values: { [sizeField]: 'huge' } }),
    ).rejects.toThrow('Size: Pick one of the choices.');
  });

  it('changes its name and fields, showing what they were', async () => {
    const args = {
      action: 'change',
      recordId: max,
      name: 'Maximus',
      values: { [breed]: 'Basset hound' },
    };
    const { card } = await prepare('manage_record', args);
    expect(field(card, 'Name')).toBe('Maximus (was Max)');
    expect(field(card, 'Breed')).toBe('Basset hound (was Beagle)');
    await commit('manage_record', args);
    const details = await read('get_record_details', { recordType: 'record', recordId: max });
    expect(details).toMatchObject({ name: 'Maximus', kind: 'Pet' });
    expect(details.fields.find((f: { label: string }) => f.label === 'Breed').value).toBe(
      'Basset hound',
    );
  });

  it('relates it to a second owner, changes the note on the pair, and takes it apart', async () => {
    const args = {
      action: 'relate',
      relationshipTypeId: ownerType,
      aId: ann,
      bId: max,
      note: 'Picks him up',
    };
    const { card } = await prepare('manage_record', args);
    expect(card.title).toBe('Relate Ann Lee and Maximus?');
    expect(field(card, 'Owner')).toBe('Ann Lee');
    expect(field(card, 'Pet')).toBe('Maximus');
    await commit('manage_record', args);
    const pairs = (await read('get_record_details', { recordType: 'person', recordId: ann }))
      .relationships;
    expect(pairs).toEqual([
      expect.objectContaining({
        other: { kind: 'record', id: max, name: 'Maximus' },
        note: 'Picks him up',
      }),
    ]);
    const relationshipId = pairs[0].relationshipId;
    await expect(
      prepare('manage_record', {
        action: 'relate',
        relationshipTypeId: ownerType,
        aId: max,
        bId: ann,
      }),
    ).rejects.toThrow(
      'aId isn’t a customer: the Owner end takes one. bId isn’t a pet: the Pet end takes one.',
    );

    const note = {
      action: 'change_note',
      recordType: 'person',
      recordId: ann,
      relationshipId,
      note: 'Weekends',
    };
    const changed = await prepare('manage_record', note);
    expect(field(changed.card, 'Was')).toBe('Picks him up');
    await commit('manage_record', note);

    const apart = { action: 'unrelate', recordType: 'person', recordId: ann, relationshipId };
    const gone = await prepare('manage_record', apart);
    expect(gone.card.title).toBe('Remove the relationship between Ann Lee and Maximus?');
    expect(field(gone.card, 'Note')).toBe('Weekends');
    await commit('manage_record', apart);
    expect(
      (await read('get_record_details', { recordType: 'person', recordId: ann })).relationships,
    ).toEqual([]);
  });

  it('archives it and brings it back', async () => {
    const { card } = await prepare('archive_or_restore', {
      action: 'archive',
      what: 'record',
      id: max,
    });
    expect(card.title).toBe('Archive Maximus?');
    await commit('archive_or_restore', { action: 'archive', what: 'record', id: max });
    expect(await archived('custom_records', max)).toBe(true);
    expect((await read('find_archived', { what: 'record' })).records).toEqual([
      expect.objectContaining({ id: max, kind: 'Pet' }),
    ]);
    await commit('archive_or_restore', { action: 'restore', what: 'record', id: max });
    expect(await archived('custom_records', max)).toBe(false);
  });
});

describe('a file on a record', () => {
  it('lists it and deletes it for good, only from the record it’s on', async () => {
    const insertFile = async (recordId: string, name: string) =>
      (
        await one<{ id: string }>(
          sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes, status, created_by)
              values (${workspaceId}, 'person', ${recordId}, ${`${workspaceId}/${randomUUID()}`}, ${name},
                'image/jpeg', 204800, 'ready', ${dale.id})
              returning id`,
        )
      ).id;
    const photo = await insertFile(bob, 'Water heater.jpg');
    const annsPhoto = await insertFile(ann, 'Porch.jpg');
    const files = (await read('get_record_details', { recordType: 'person', recordId: bob })).files;
    expect(files).toEqual([
      expect.objectContaining({
        fileId: photo,
        name: 'Water heater.jpg',
        size: '200 KB',
        addedBy: 'Dale Owner',
      }),
    ]);

    const args = { recordType: 'person', recordId: bob, fileId: photo };
    const { card } = await prepare('delete_file', args);
    expect(card.title).toBe('Delete Water heater.jpg?');
    expect(field(card, 'On')).toBe('Bob Reyes');
    expect(card.warnings[0]?.kind).toBe('caution');
    const deleted = async (id: string) =>
      (
        await one<{ gone: boolean }>(
          sql`select deleted_at is not null as gone from app.files where id = ${id}`,
        )
      ).gone;
    expect(await deleted(photo)).toBe(false);
    await commit('delete_file', args);
    expect(await deleted(photo)).toBe(true);

    await expect(
      prepare('delete_file', { recordType: 'person', recordId: bob, fileId: annsPhoto }),
    ).rejects.toThrow('That file isn’t on this record');
    expect(await deleted(annsPhoto)).toBe(false);
  });
});
