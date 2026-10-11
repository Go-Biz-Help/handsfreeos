/**
 * M10 step 4 on the local database: what the command layer does for a phone that works offline.
 * - **A command runs once.** A repeat of a phone command, even two at once, gets the first answer back and runs
 *   nothing again; the same id with another change is refused; a final refusal is kept and given back, while a
 *   "Still send?" or a retry is never kept; a command run inside another never touches a receipt; the web's
 *   commands have none, nor does a heartbeat that keeps none (`receipt: false`); and a stored answer keeps no secret.
 * - **The moment rules:** a text written 45 minutes ago waits for "Still send?" and the OK sends it once; an
 *   online-only change that waited stays refused; events and notes say when things were really done.
 * - **Newest wins, one detail at a time:** the phone's email change goes through while the web's later number stays,
 *   and the customer's timeline shows both numbers; the same merge on companies, leads, tasks, appointments and a
 *   next action set on its own.
 * - **Records made offline** keep the phone's ids; an id another business holds is refused without saying so; a likely
 *   duplicate made on the phone is added anyway.
 * - **Tags go on and come off one at a time**, and doing a state change again changes nothing.
 * - **Drafts don't merge:** a stale save is refused as before and says how to keep the person's version.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  activities,
  appointments,
  commandReceipts,
  companies,
  conversations,
  events,
  leads,
  messages,
  people,
  tasks,
} from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatPhone } from '../src/crm/phone';
import { HfosError } from '../src/errors';
import { defineCommand } from '../src/kernel/define';
import { executeCommand, executeCommandWithin } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta } from '../src/kernel/types';
import { EstimateCreateInput } from '../src/schemas/money';
import {
  activityLog,
  appointmentUpdate,
  companyCreate,
  companyUpdate,
  conversationClose,
  conversationOpen,
  conversationSnooze,
  estimateCreate,
  estimateUpdate,
  fileBeginUpload,
  leadArchive,
  leadCreate,
  leadMoveStage,
  leadSetNextAction,
  leadUpdate,
  mailboxConnect,
  messageSend,
  organizationCreate,
  personCreate,
  personUpdate,
  phoneUpdateSettings,
  recordAddTag,
  recordRemoveTag,
  tagCreate,
  tagDelete,
  taskComplete,
  taskCreate,
  taskDelete,
  taskUpdate,
} from '../src/server';

const MIN = 60_000;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const ago = (ms: number) => new Date(Date.now() - ms);
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

/** A change made on the web: no id of its own, done now. */
const web = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), { correlationId: randomUUID(), channel: 'web' });

interface PhoneOpts {
  readonly commandId?: string;
  readonly occurredAt?: Date;
  readonly confirmedAt?: Date | null;
}
/** A change made on the phone: its own id and the moment it was done (already on the server's clock). */
const phoneMeta = (opts: PhoneOpts = {}): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'mobile',
  commandId: opts.commandId ?? randomUUID(),
  occurredAt: opts.occurredAt ?? new Date(),
  sentAt: new Date(),
  confirmedAt: opts.confirmedAt ?? null,
  appVersion: '1.0.0',
});
const phone = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
  opts: PhoneOpts = {},
) => executeCommand(api(), cmd, input, human(u), phoneMeta(opts));

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
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

const receiptsOf = (u: TestUser, commandId: string) =>
  admin()
    .select()
    .from(commandReceipts)
    .where(and(eq(commandReceipts.userId, u.id), eq(commandReceipts.commandId, commandId)));
const eventsOf = (type: string, entityId: string) =>
  admin()
    .select()
    .from(events)
    .where(and(eq(events.eventType, type), eq(events.entityId, entityId)));

let dale: TestUser;
let sam: TestUser;
let marco: TestUser;
let outsider: TestUser;
let wsId: string;
let otherWs: string;
let seq = 0;
const nextPhone = () => `+1512555${String(1000 + ((seq++ + Date.now()) % 9000)).padStart(4, '0')}`;
const uniq = () => randomUUID().slice(0, 8);

async function customer(firstName: string, extra: Record<string, unknown> = {}) {
  return (
    await web(
      personCreate,
      { workspaceId: wsId, firstName, lastName: 'Test', ignoreDuplicates: true, ...extra },
      dale,
    )
  ).output.personId;
}

beforeAll(async () => {
  [dale, sam, marco, outsider] = await Promise.all([
    createTestUser('m10-dale', { fullName: 'Dale Owner' }),
    createTestUser('m10-sam', { fullName: 'Sam Admin' }),
    createTestUser('m10-marco', { fullName: 'Marco Member' }),
    createTestUser('m10-outsider', { fullName: 'Olive Outsider' }),
  ]);
  const org = (
    await web(
      organizationCreate,
      { businessName: 'Offline HVAC', timezone: 'America/Chicago' },
      dale,
    )
  ).output;
  wsId = org.workspaceId;
  otherWs = (await web(organizationCreate, { businessName: 'Elsewhere Plumbing' }, outsider)).output
    .workspaceId;
  for (const [u, role] of [
    [sam, 'admin'],
    [marco, 'member'],
  ] as const)
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${u.id}, ${role})`,
    );
  // Texting ready (an approved toll-free number) and no quiet hours, so a text can be queued at any hour.
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`ACm10${uniq()}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNm10${uniq()}`}, ${nextPhone()}, 'toll_free', 'active') returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${wsId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHm10${uniq()}`}, now())`,
  );
  await web(
    phoneUpdateSettings,
    { workspaceId: wsId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
    dale,
  );
});
afterAll(closeTestDbs);

// ---------- a command runs once ----------

describe('command receipts', () => {
  it('gives a repeat the first answer back and runs nothing again', async () => {
    const personId = await customer('Rita');
    const commandId = randomUUID();
    const writtenAt = ago(20 * MIN);
    const body = `Gate code ${uniq()}`;
    const first = await phone(
      activityLog,
      { workspaceId: wsId, kind: 'note', body, personId },
      marco,
      { commandId, occurredAt: writtenAt },
    );
    // The phone sent it again (its first answer never arrived), its keys in another order.
    const again = await phone(
      activityLog,
      { personId, body, kind: 'note', workspaceId: wsId },
      marco,
      { commandId, occurredAt: writtenAt },
    );
    expect(again).toEqual(first);
    const notes = await admin().select().from(activities).where(eq(activities.body, body));
    expect(notes).toHaveLength(1);
    // The note happened when it was written, and its event says so.
    expect(notes[0]!.occurredAt.toISOString()).toBe(writtenAt.toISOString());
    const [event] = await admin().select().from(events).where(eq(events.id, first.eventIds[0]!));
    expect(event!.occurredAt!.toISOString()).toBe(writtenAt.toISOString());
    const [receipt] = await receiptsOf(marco, commandId);
    expect(receipt).toMatchObject({
      command: 'activity.log',
      workspaceId: wsId,
      outcome: 'applied',
      answer: { output: first.output, eventIds: first.eventIds },
    });
    expect(receipt!.occurredAt.toISOString()).toBe(writtenAt.toISOString());
  });

  it('runs two copies that arrive at once only once', async () => {
    const personId = await customer('Twin');
    const commandId = randomUUID();
    const body = `Called about the quote ${uniq()}`;
    const input = { workspaceId: wsId, kind: 'call', body, personId };
    const [x, y] = await Promise.all([
      phone(activityLog, input, marco, { commandId }),
      phone(activityLog, input, marco, { commandId }),
    ]);
    expect(x).toEqual(y);
    expect(await admin().select().from(activities).where(eq(activities.body, body))).toHaveLength(
      1,
    );
    // The same id with a different change is refused, and changes nothing.
    const reused = await expectHfos(
      () => phone(activityLog, { ...input, body: 'Something else' }, marco, { commandId }),
      'rule_violation',
      'command_id_reused',
    );
    expect(reused.disposition).toBe('final');
    expect(
      await admin().select().from(activities).where(eq(activities.body, 'Something else')),
    ).toEqual([]);
  });

  it('keeps a final refusal and gives it back, even once the change would go through', async () => {
    const commandId = randomUUID();
    const missingTask = randomUUID();
    const refused = await expectHfos(
      () => phone(taskComplete, { workspaceId: wsId, taskId: missingTask }, marco, { commandId }),
      'not_found',
    );
    expect(refused.disposition).toBe('final');
    const [receipt] = await receiptsOf(marco, commandId);
    expect(receipt).toMatchObject({
      outcome: 'refused',
      command: 'task.complete',
      answer: {
        status: 404,
        error: {
          code: 'not_found',
          message:
            'That task isn’t there anymore. Someone may have deleted it. Refresh and try again.',
        },
      },
    });
    // The task turns up (made with that id), but the same command gets the same answer: it was refused.
    await web(taskCreate, { workspaceId: wsId, id: missingTask, title: 'Turned up' }, dale);
    await expectHfos(
      () => phone(taskComplete, { workspaceId: wsId, taskId: missingTask }, marco, { commandId }),
      'not_found',
    );
    const [task] = await admin().select().from(tasks).where(eq(tasks.id, missingTask));
    expect(task!.doneAt).toBeNull();
  });

  it('never keeps a "Still send?": the same text, confirmed, goes once', async () => {
    const personId = await customer('Tess', { phone: nextPhone() });
    const commandId = randomUUID();
    const writtenAt = ago(45 * MIN);
    const body = `On my way ${uniq()}`;
    const input = { workspaceId: wsId, personId, body };
    const stale = await expectHfos(
      () => phone(messageSend, input, dale, { commandId, occurredAt: writtenAt }),
      'rule_violation',
      'stale_action',
    );
    expect(stale.disposition).toBe('ask');
    expect(stale.message).toBe(
      'This was done 45 minutes ago, so it waits for your OK before it goes.',
    );
    expect(await receiptsOf(dale, commandId)).toEqual([]);
    expect(await admin().select().from(messages).where(eq(messages.bodyText, body))).toEqual([]);

    const confirmedAt = new Date();
    const sent = await phone(messageSend, input, dale, {
      commandId,
      occurredAt: writtenAt,
      confirmedAt,
    });
    expect(sent.output).toMatchObject({ status: 'queued', duplicate: false });
    // "Send" pressed twice: still one text.
    expect(
      await phone(messageSend, input, dale, { commandId, occurredAt: writtenAt, confirmedAt }),
    ).toEqual(sent);
    expect(await admin().select().from(messages).where(eq(messages.bodyText, body))).toHaveLength(
      1,
    );
    const [event] = await eventsOf('message.queued', sent.output.messageId);
    expect(event!.occurredAt!.toISOString()).toBe(writtenAt.toISOString());
  });

  it('keeps an online-only change that waited refused for good', async () => {
    const commandId = randomUUID();
    const name = `Late ${uniq()}`;
    const late = await expectHfos(
      () =>
        phone(tagCreate, { workspaceId: wsId, name }, dale, {
          commandId,
          occurredAt: ago(10 * MIN),
        }),
      'rule_violation',
      'online_only',
    );
    expect(late.disposition).toBe('final');
    expect((await receiptsOf(dale, commandId))[0]).toMatchObject({
      outcome: 'refused',
      answer: { status: 409, error: { rule: 'online_only' } },
    });
    // Sent again under the same id with signal, it's the same refusal: doing it now is a new change.
    await expectHfos(
      () => phone(tagCreate, { workspaceId: wsId, name }, dale, { commandId }),
      'rule_violation',
      'online_only',
    );
    const done = await phone(tagCreate, { workspaceId: wsId, name }, dale);
    expect(done.output.tagId).toBeTruthy();
  });

  it('never lets a command run inside another read or write a receipt', async () => {
    const personId = await customer('Nesta');
    const { leadId } = (
      await web(leadCreate, { workspaceId: wsId, title: 'Duct work', personId }, dale)
    ).output;
    const outer = defineCommand({
      name: 'test.outer',
      description: 'Changes a lead from inside another command.',
      risk: 1,
      input: z.object({ workspaceId: z.uuid(), leadId: z.uuid() }),
      output: z.object({ updated: z.array(z.string()) }),
      permission: 'records.write',
      scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
      emits: [],
      offline: 'anytime',
      async handler(ctx, input) {
        const inner = await executeCommandWithin(ctx, leadUpdate, {
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          source: 'Yard sign',
        });
        return { updated: inner.output.updated };
      },
    });
    const commandId = randomUUID();
    const madeAt = ago(3 * MIN);
    const out = await phone(outer, { workspaceId: wsId, leadId }, dale, {
      commandId,
      occurredAt: madeAt,
    });
    expect(out.output.updated).toEqual(['source']);
    const receipts = await receiptsOf(dale, commandId);
    expect(receipts.map((r) => r.command)).toEqual(['test.outer']);
    // The inner command shares the outer's moment.
    const [lead] = await admin().select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.fieldTimes.source).toBe(madeAt.toISOString());
  });

  it('writes no receipt for the web’s commands', async () => {
    const personId = await customer('Webby');
    const before = await admin()
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.userId, sam.id));
    await web(
      activityLog,
      { workspaceId: wsId, kind: 'note', body: 'From the desk', personId },
      sam,
    );
    const after = await admin()
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.userId, sam.id));
    expect(after).toHaveLength(before.length);
  });

  it('writes no receipt for a command that keeps none, and runs it each time it’s sent', async () => {
    let ran = 0;
    const beat = defineCommand({
      name: 'test.beat',
      description: 'Says it’s there; a repeat does no harm.',
      risk: 0,
      input: z.object({ workspaceId: z.uuid() }),
      output: z.object({ ran: z.number() }),
      permission: 'records.write',
      scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
      emits: [],
      offline: 'anytime',
      receipt: false,
      handler: async () => ({ ran: ++ran }),
    });
    const commandId = randomUUID();
    const first = await phone(beat, { workspaceId: wsId }, dale, { commandId });
    const again = await phone(beat, { workspaceId: wsId }, dale, { commandId });
    expect([first.output.ran, again.output.ran]).toEqual([1, 2]);
    expect(await receiptsOf(dale, commandId)).toEqual([]);
  });

  it('keeps no secret in a stored answer', async () => {
    const commandId = randomUUID();
    const first = await phone(mailboxConnect, { workspaceId: wsId, provider: 'google' }, dale, {
      commandId,
    });
    expect(first.output.state.length).toBeGreaterThan(20);
    const [receipt] = await receiptsOf(dale, commandId);
    expect(receipt!.answer).toEqual({
      output: { connectionId: first.output.connectionId },
      eventIds: first.eventIds,
    });
    expect(JSON.stringify(receipt!.answer)).not.toContain(first.output.state);
    // A repeat can't show the state again: it says it was done.
    const repeat = await expectHfos(
      () => phone(mailboxConnect, { workspaceId: wsId, provider: 'google' }, dale, { commandId }),
      'rule_violation',
      'answer_not_kept',
    );
    expect(repeat.disposition).toBe('final');
  });

  it('refuses a phone command that doesn’t say which one it is and when', async () => {
    const personId = await customer('Nameless');
    await expectHfos(
      () =>
        executeCommand(
          api(),
          activityLog,
          { workspaceId: wsId, kind: 'note', body: 'No id', personId },
          human(marco),
          { correlationId: randomUUID(), channel: 'mobile' },
        ),
      'validation',
    );
    expect(await admin().select().from(activities).where(eq(activities.body, 'No id'))).toEqual([]);
  });
});

// ---------- newest wins ----------

describe('newest wins, one detail at a time', () => {
  it('keeps the web’s later number and the phone’s email, and the timeline shows both numbers', async () => {
    const [p0, p1, p2] = [nextPhone(), nextPhone(), nextPhone()];
    const email0 = `maria-${uniq()}@old.test`;
    const email1 = `maria-${uniq()}@new.test`;
    const personId = await customer('Maria', { lastName: 'Lopez', phone: p0, email: email0 });
    const phoneMadeAt = ago(10 * MIN);
    // A minute after the phone's change (made with no signal), Sam changes only her number on the web.
    const onWeb = await web(
      personUpdate,
      { workspaceId: wsId, personId, phone: p2, base: { phone: p0 } },
      sam,
    );
    expect(onWeb.output).toEqual({ personId, updated: ['phoneE164'], notApplied: [] });
    const onPhone = await phone(
      personUpdate,
      { workspaceId: wsId, personId, phone: p1, email: email1, base: { phone: p0, email: email0 } },
      dale,
      { occurredAt: phoneMadeAt },
    );
    expect(onPhone.output).toEqual({ personId, updated: ['email'], notApplied: ['phone'] });
    const [maria] = await admin().select().from(people).where(eq(people.id, personId));
    expect(maria).toMatchObject({ phoneE164: p2, phone: formatPhone(p2), email: email1 });
    expect(maria!.fieldTimes.email).toBe(phoneMadeAt.toISOString());
    expect(Date.parse(maria!.fieldTimes.phone_e164!)).toBeGreaterThan(phoneMadeAt.getTime());
    const [kept] = await admin()
      .select()
      .from(activities)
      .where(and(eq(activities.personId, personId), eq(activities.subtype, 'edit_not_applied')));
    expect(kept!.body).toBe(
      `Phone number wasn’t changed to “${formatPhone(p1)}”: Sam Admin’s later change to “${formatPhone(p2)}” was kept.`,
    );
    expect(kept!.meta).toMatchObject({
      field: 'phone',
      wanted: formatPhone(p1),
      stays: formatPhone(p2),
      keptBy: 'Sam Admin',
    });
    expect(kept!.authorUserId).toBe(dale.id);
  });

  it('applies an edit to a detail still as the person saw it, however it got back there', async () => {
    const [e0, e1, e2] = [`a-${uniq()}@x.test`, `b-${uniq()}@x.test`, `c-${uniq()}@x.test`];
    const personId = await customer('Ravi', { email: e0 });
    const madeAt = ago(20 * MIN);
    await web(personUpdate, { workspaceId: wsId, personId, email: e2, base: { email: e0 } }, sam);
    await web(personUpdate, { workspaceId: wsId, personId, email: e0, base: { email: e2 } }, sam);
    const out = await phone(
      personUpdate,
      { workspaceId: wsId, personId, email: e1, base: { email: e0 } },
      dale,
      {
        occurredAt: madeAt,
      },
    );
    expect(out.output).toMatchObject({ updated: ['email'], notApplied: [] });
    const [row] = await admin().select().from(people).where(eq(people.id, personId));
    expect(row!.email).toBe(e1);
  });

  it('applies an older edit to a detail whose change was never stamped', async () => {
    const personId = await customer('Una', { source: 'Referral' });
    // Changed before field times existed: no stamp to compare against.
    await rows(admin(), sql`update app.people set source = 'Website' where id = ${personId}`);
    const out = await phone(
      personUpdate,
      { workspaceId: wsId, personId, source: 'Yard sign', base: { source: 'Referral' } },
      dale,
      { occurredAt: ago(60 * MIN) },
    );
    expect(out.output).toMatchObject({ updated: ['source'], notApplied: [] });
  });

  it('applies the web’s edits as made now, stamping what they change and nothing else', async () => {
    const personId = await customer('Wendy');
    const before = Date.now();
    const out = await web(
      personUpdate,
      { workspaceId: wsId, personId, firstName: 'Wendy', lastName: 'Web' },
      sam,
    );
    // First name unchanged: not written and not stamped.
    expect(out.output).toMatchObject({ updated: ['lastName'], notApplied: [] });
    const [row] = await admin().select().from(people).where(eq(people.id, personId));
    expect(Object.keys(row!.fieldTimes)).toEqual(['last_name']);
    expect(Date.parse(row!.fieldTimes.last_name!)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('merges companies, leads, tasks and appointments the same way', async () => {
    const earlier = ago(15 * MIN);
    // A company's name.
    const { companyId } = (
      await web(
        companyCreate,
        { workspaceId: wsId, name: `Acme ${uniq()}`, ignoreDuplicates: true },
        dale,
      )
    ).output;
    const [co] = await admin().select().from(companies).where(eq(companies.id, companyId));
    await web(
      companyUpdate,
      { workspaceId: wsId, companyId, name: 'Acme Web', base: { name: co!.name } },
      sam,
    );
    const coOut = await phone(
      companyUpdate,
      {
        workspaceId: wsId,
        companyId,
        name: 'Acme Phone',
        website: 'acme.test',
        base: { name: co!.name, website: null },
      },
      dale,
      { occurredAt: earlier },
    );
    expect(coOut.output).toMatchObject({ updated: ['website'], notApplied: ['name'] });

    // A lead's title, and a next action set on its own.
    const personId = await customer('Leah');
    const { leadId } = (
      await web(leadCreate, { workspaceId: wsId, title: 'Furnace', personId }, dale)
    ).output;
    await web(
      leadUpdate,
      { workspaceId: wsId, leadId, title: 'Furnace swap', base: { title: 'Furnace' } },
      sam,
    );
    const leadOut = await phone(
      leadUpdate,
      {
        workspaceId: wsId,
        leadId,
        title: 'Furnace repair',
        valueCents: 90_000,
        base: { title: 'Furnace', valueCents: 0 },
      },
      dale,
      { occurredAt: earlier },
    );
    expect(leadOut.output).toMatchObject({ updated: ['valueCents'], notApplied: ['title'] });
    await web(leadSetNextAction, { workspaceId: wsId, leadId, text: 'Call Tuesday' }, sam);
    const next = await phone(
      leadSetNextAction,
      { workspaceId: wsId, leadId, text: 'Email Monday' },
      dale,
      {
        occurredAt: earlier,
      },
    );
    expect(next.output).toMatchObject({ nextAction: 'Call Tuesday' });
    expect(next.eventIds).toEqual([]);
    const notApplied = await admin()
      .select()
      .from(activities)
      .where(and(eq(activities.leadId, leadId), eq(activities.subtype, 'edit_not_applied')));
    expect(notApplied.map((a) => a.meta.field).sort()).toEqual(['nextAction', 'title']);

    // A task's notes.
    const { taskId } = (
      await web(taskCreate, { workspaceId: wsId, title: 'Order filter', personId }, dale)
    ).output;
    await web(
      taskUpdate,
      { workspaceId: wsId, taskId, notes: '16x25', base: { notes: null } },
      sam,
    );
    const taskOut = await phone(
      taskUpdate,
      {
        workspaceId: wsId,
        taskId,
        notes: '20x20',
        title: 'Order filters',
        base: { notes: null, title: 'Order filter' },
      },
      dale,
      { occurredAt: earlier },
    );
    expect(taskOut.output).toMatchObject({ updated: ['title'], notApplied: ['notes'] });

    // An appointment's notes.
    const [calendar] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.calendars (workspace_id, name, slug, status)
          values (${wsId}, 'Visits', ${`m10-${uniq()}`}, 'active') returning id`,
    );
    const [appt] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, lead_id)
          values (${wsId}, ${calendar!.id}, 1, 'Tune-up', now() + interval '2 days', now() + interval '2 days 1 hour', ${leadId})
          returning id`,
    );
    await web(
      appointmentUpdate,
      { workspaceId: wsId, appointmentId: appt!.id, notes: 'Dog in yard', base: { notes: null } },
      sam,
    );
    const apptOut = await phone(
      appointmentUpdate,
      {
        workspaceId: wsId,
        appointmentId: appt!.id,
        notes: 'Side gate',
        title: 'Spring tune-up',
        base: { notes: null, title: 'Tune-up' },
      },
      dale,
      { occurredAt: earlier },
    );
    expect(apptOut.output).toMatchObject({ updated: ['title'], notApplied: ['notes'] });
    const [row] = await admin().select().from(appointments).where(eq(appointments.id, appt!.id));
    expect(row).toMatchObject({ notes: 'Dog in yard', title: 'Spring tune-up' });
    expect(row!.fieldTimes.title).toBe(earlier.toISOString());
  });
});

// ---------- records made offline ----------

describe('records made on the phone', () => {
  it('keep their ids, so what was made for them offline finds them, and a repeat makes nothing new', async () => {
    const personId = randomUUID();
    const leadId = randomUUID();
    const made = await phone(
      personCreate,
      { workspaceId: wsId, id: personId, firstName: 'Omar', lastName: 'Offline' },
      marco,
    );
    expect(made.output.personId).toBe(personId);
    const lead = await phone(
      leadCreate,
      { workspaceId: wsId, id: leadId, title: 'Water heater', personId },
      marco,
    );
    expect(lead.output.leadId).toBe(leadId);
    // The same create under another command id (its receipt long gone): that customer, and nothing new.
    const again = await phone(
      personCreate,
      { workspaceId: wsId, id: personId, firstName: 'Omar', lastName: 'Offline' },
      marco,
    );
    expect(again.output.personId).toBe(personId);
    expect(again.eventIds).toEqual([]);
    expect(await eventsOf('person.created', personId)).toHaveLength(1);

    const taskId = randomUUID();
    expect(
      (
        await phone(
          taskCreate,
          { workspaceId: wsId, id: taskId, title: 'Bring the part', leadId },
          marco,
        )
      ).output.taskId,
    ).toBe(taskId);
    const noteId = randomUUID();
    expect(
      (
        await phone(
          activityLog,
          { workspaceId: wsId, id: noteId, kind: 'note', body: 'Tank is 12 years old', leadId },
          marco,
        )
      ).output.activityId,
    ).toBe(noteId);
    const fileId = randomUUID();
    const upload = {
      workspaceId: wsId,
      id: fileId,
      recordType: 'lead',
      recordId: leadId,
      name: 'tank.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2_048_000,
    };
    const place = await phone(fileBeginUpload, upload, marco);
    expect(place.output.fileId).toBe(fileId);
    expect(place.output.objectPath).toContain(fileId);
    expect((await phone(fileBeginUpload, upload, marco)).output).toEqual(place.output);
  });

  it('refuse an id another business holds without saying so', async () => {
    const theirs = (
      await web(
        personCreate,
        { workspaceId: otherWs, firstName: 'Private', lastName: 'Person', ignoreDuplicates: true },
        outsider,
      )
    ).output.personId;
    const refused = await expectHfos(
      () => phone(personCreate, { workspaceId: wsId, id: theirs, firstName: 'Probe' }, marco),
      'validation',
    );
    expect(refused.toBody()).toEqual({
      error: {
        code: 'validation',
        message: 'This couldn’t be saved the way the app made it. Discard it and add it again.',
        details: [{ path: 'id', message: 'That id can’t be used. Make a new one.' }],
        disposition: 'final',
      },
    });
    const [still] = await admin().select().from(people).where(eq(people.id, theirs));
    expect(still).toMatchObject({ workspaceId: otherWs, firstName: 'Private' });
  });

  it('add a likely duplicate made on the phone, where the web asks', async () => {
    const shared = nextPhone();
    const first = await customer('Dana', { phone: shared });
    const onWeb = await expectHfos(
      () =>
        web(
          personCreate,
          { workspaceId: wsId, firstName: 'Dana', lastName: 'Again', phone: shared },
          marco,
        ),
      'conflict',
      'duplicate',
    );
    expect(onWeb.disposition).toBe('ask');
    const added = await phone(
      personCreate,
      { workspaceId: wsId, firstName: 'Dana', lastName: 'Again', phone: shared },
      marco,
    );
    expect(added.output.personId).not.toBe(first);
    const [created] = await eventsOf('person.created', added.output.personId);
    expect(created!.payload).toMatchObject({ possibleDuplicateOf: first });
    const [flagged] = await admin()
      .select()
      .from(people)
      .where(eq(people.id, added.output.personId));
    expect(flagged!.possibleDuplicateOf).toBe(first);

    // A company too; one added on the web anyway ("Save anyway") isn't flagged.
    const name = `Duplicate Dental ${uniq()}`;
    const { companyId: original } = (
      await web(companyCreate, { workspaceId: wsId, name, ignoreDuplicates: true }, dale)
    ).output;
    const again = await phone(companyCreate, { workspaceId: wsId, name }, marco);
    const anyway = await web(
      companyCreate,
      { workspaceId: wsId, name, ignoreDuplicates: true },
      marco,
    );
    const rowsOf = await admin()
      .select({ id: companies.id, possibleDuplicateOf: companies.possibleDuplicateOf })
      .from(companies)
      .where(eq(companies.name, name));
    expect(Object.fromEntries(rowsOf.map((r) => [r.id, r.possibleDuplicateOf]))).toEqual({
      [original]: null,
      [again.output.companyId]: original,
      [anyway.output.companyId]: null,
    });
  });
});

// ---------- tags and state changes ----------

describe('tags, one at a time', () => {
  it('go on and come off once however often they’re asked, and a deleted tag is gone', async () => {
    const personId = await customer('Tagg');
    const { tagId } = (await web(tagCreate, { workspaceId: wsId, name: `VIP ${uniq()}` }, dale))
      .output;
    const { tagId: other } = (
      await web(tagCreate, { workspaceId: wsId, name: `Pool ${uniq()}` }, dale)
    ).output;
    const ref = { workspaceId: wsId, recordType: 'person', recordId: personId };
    await web(recordAddTag, { ...ref, tagId: other }, sam);
    const on = await phone(recordAddTag, { ...ref, tagId }, marco);
    expect(on.output.changed).toBe(true);
    expect(on.output.tags.map((t) => t.id).sort()).toEqual([other, tagId].sort());
    const onAgain = await phone(recordAddTag, { ...ref, tagId }, marco);
    expect(onAgain.output.changed).toBe(false);
    expect(onAgain.eventIds).toEqual([]);
    const off = await phone(recordRemoveTag, { ...ref, tagId }, marco);
    expect(off.output).toMatchObject({ changed: true, tags: [{ id: other }] });
    expect((await phone(recordRemoveTag, { ...ref, tagId }, marco)).output.changed).toBe(false);
    expect(await eventsOf('record.tags_changed', personId)).toHaveLength(3);
    await web(tagDelete, { workspaceId: wsId, tagId }, dale);
    const gone = await expectHfos(() => phone(recordAddTag, { ...ref, tagId }, marco), 'not_found');
    expect(gone.disposition).toBe('final');
  });
});

describe('state changes, checked against what’s there', () => {
  it('change nothing when done again', async () => {
    const personId = await customer('Stacy', { phone: nextPhone() });
    const tickedAt = ago(15 * MIN);
    const { taskId } = (
      await web(taskCreate, { workspaceId: wsId, title: 'Send photos', personId }, dale)
    ).output;
    const done = await phone(taskComplete, { workspaceId: wsId, taskId }, marco, {
      occurredAt: tickedAt,
    });
    // Done when it was ticked, not when the phone found signal.
    expect(done.output.doneAt).toBe(tickedAt.toISOString());
    const doneAgain = await phone(taskComplete, { workspaceId: wsId, taskId }, dale);
    expect(doneAgain.output.doneAt).toBe(tickedAt.toISOString());
    expect(await eventsOf('task.completed', taskId)).toHaveLength(1);

    const { conversationId } = (await web(conversationOpen, { workspaceId: wsId, personId }, dale))
      .output;
    await phone(conversationClose, { workspaceId: wsId, conversationId }, marco);
    await phone(conversationClose, { workspaceId: wsId, conversationId }, dale);
    expect(await eventsOf('conversation.closed', conversationId)).toHaveLength(1);

    // A snooze that ran out while the phone had no signal has nothing left to do.
    await web(
      conversationSnooze,
      { workspaceId: wsId, conversationId, until: new Date(Date.now() + 60 * MIN).toISOString() },
      dale,
    );
    const [snoozed] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const lapsed = await phone(
      conversationSnooze,
      { workspaceId: wsId, conversationId, until: ago(60 * MIN).toISOString() },
      marco,
      { occurredAt: ago(120 * MIN) },
    );
    expect(lapsed.eventIds).toEqual([]);
    const [after] = await admin()
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(after!.snoozedUntil).toEqual(snoozed!.snoozedUntil);

    // A lead moved to the stage it's already in, from the phone: it stays where it is on the board.
    const { leadId, stageId } = (
      await web(leadCreate, { workspaceId: wsId, title: 'Mini split', personId }, dale)
    ).output;
    await web(leadCreate, { workspaceId: wsId, title: 'Below it', personId }, dale);
    const [before] = await admin().select().from(leads).where(eq(leads.id, leadId));
    const moved = await phone(leadMoveStage, { workspaceId: wsId, leadId, stageId }, marco);
    expect(moved.eventIds).toEqual([]);
    const [still] = await admin().select().from(leads).where(eq(leads.id, leadId));
    expect(still!.position).toBe(before!.position);
  });

  it('refuse for good what acts on something deleted or archived', async () => {
    const personId = await customer('Gone');
    const { taskId } = (
      await web(taskCreate, { workspaceId: wsId, title: 'Deleted soon', personId }, dale)
    ).output;
    await web(taskDelete, { workspaceId: wsId, taskId }, dale);
    expect(
      (
        await expectHfos(
          () => phone(taskComplete, { workspaceId: wsId, taskId }, dale),
          'not_found',
        )
      ).disposition,
    ).toBe('final');
    const { leadId } = (
      await web(leadCreate, { workspaceId: wsId, title: 'Archived soon', personId }, dale)
    ).output;
    await web(leadArchive, { workspaceId: wsId, leadId }, dale);
    const [won] = await rows<{ id: string }>(
      admin(),
      sql`select s.id from app.pipeline_stages s join app.leads l on l.pipeline_id = s.pipeline_id
          where l.id = ${leadId} and s.kind = 'won' limit 1`,
    );
    const archived = await expectHfos(
      () => phone(leadMoveStage, { workspaceId: wsId, leadId, stageId: won!.id }, dale),
      'rule_violation',
      'lead_archived',
    );
    expect(archived.disposition).toBe('final');
  });
});

// ---------- drafts ----------

describe('drafts', () => {
  it('refuse a stale save as before, and say how to keep the person’s version as a new draft', async () => {
    const personId = await customer('Drafty');
    const lines = [{ name: 'Condenser', quantity: 1, unitPriceCents: 480_000 }];
    const made = (
      await web(estimateCreate, { workspaceId: wsId, personId, title: 'AC', lines }, dale)
    ).output;
    await web(
      estimateUpdate,
      {
        workspaceId: wsId,
        estimateId: made.estimateId,
        personId,
        title: 'AC (Sam)',
        lines,
        baseRevision: made.revision,
      },
      sam,
    );
    const mine = [{ name: 'Condenser and coil', quantity: 1, unitPriceCents: 610_000 }];
    const stale = await expectHfos(
      () =>
        phone(
          estimateUpdate,
          {
            workspaceId: wsId,
            estimateId: made.estimateId,
            personId,
            title: 'AC (Dale)',
            lines: mine,
            baseRevision: made.revision,
          },
          dale,
        ),
      'conflict',
      'document_conflict',
    );
    expect(stale.disposition).toBe('final');
    const keep = (stale.details as { keepAsNewDraft: { command: string; input: unknown } })
      .keepAsNewDraft;
    expect(keep.command).toBe('estimate.create');
    const input = EstimateCreateInput.parse(keep.input);
    expect(input).toMatchObject({ workspaceId: wsId, personId, title: 'AC (Dale)' });
    const kept = await phone(estimateCreate, keep.input, dale);
    const [draft] = await rows<{ title: string; lines: number }>(
      admin(),
      sql`select e.title, (select count(*) from app.estimate_lines l where l.estimate_id = e.id)::int as lines
          from app.estimates e where e.id = ${kept.output.estimateId}`,
    );
    expect(draft).toEqual({ title: 'AC (Dale)', lines: 1 });
    // Sam's version is untouched.
    const [theirs] = await rows<{ title: string }>(
      admin(),
      sql`select title from app.estimates where id = ${made.estimateId}`,
    );
    expect(theirs!.title).toBe('AC (Sam)');
  });
});
