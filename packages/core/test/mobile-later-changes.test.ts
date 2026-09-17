/**
 * M10 on the local database: newest wins for changes of state. A change made on a phone with no signal reaches the
 * server after a later change to the same thing, and the later one stands: the phone's isn't applied. It's answered as
 * applied, with `notApplied` naming what didn't change (so the phone's queue shows it as sent, and its receipt says
 * so), and the record's timeline says what the person tried and why it stays. The same change made before anything
 * changed goes through, and the web's changes are made now, as before.
 * - **A stage move** someone moved the lead after.
 * - **Ticking or reopening a task** someone reopened or ticked after.
 * - **Adding or removing a tag** someone removed or added after.
 * - **Closing or snoozing a conversation** the customer wrote in after, or someone reopened or snoozed after.
 * - **Snoozing or dismissing an Action Center card** that came back with something new after, or someone snoozed or
 *   dismissed after.
 * - **Marking a visit confirmed** that was moved to another time after, or taking back a confirmation someone made after.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  appointmentAttendees,
  attentionItems,
  commandReceipts,
  conversations,
  leads,
  recordTagRemovals,
  recordTags,
  tasks,
} from '@hfos/db/schema';
import { closeTestDbs, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { reconcile } from '../src/attention/load';
import { addDays, localDateOf, weekdayOf } from '../src/calendar/index';
import { notAppliedWords } from '../src/crm/not-applied';
import { executeCommand } from '../src/kernel/execute';
import type { CommandDef, RequestMeta } from '../src/kernel/types';
import {
  appointmentReschedule,
  attendeeConfirm,
  attentionDismiss,
  attentionSaveSettings,
  attentionSnooze,
  conversationClose,
  conversationOpen,
  conversationReopen,
  conversationSnooze,
  leadCreate,
  leadMoveStage,
  messageReceive,
  personCreate,
  phoneUpdateSettings,
  recordAddTag,
  recordRemoveTag,
  tagCreate,
  taskComplete,
  taskCreate,
  taskReopen,
  timelineList,
} from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  CHI,
  human,
  isoAt,
  makeCalendar,
  MIN,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const later = (ms: number) => new Date(Date.now() + ms);
const uniq = () => randomUUID().slice(0, 8);

/** A change made on the web: done now. */
const web = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) =>
  executeCommand(testDbs().api.db, cmd, input, human(u), {
    correlationId: randomUUID(),
    channel: 'web',
  }).then((r) => r.output);

/** A change made on the phone at `madeAt`, arriving now under its own command id. */
async function phone<I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
  madeAt: Date,
) {
  const meta: RequestMeta = {
    correlationId: randomUUID(),
    channel: 'mobile',
    commandId: randomUUID(),
    occurredAt: madeAt,
    sentAt: new Date(),
    confirmedAt: null,
    appVersion: '1.0.0',
  };
  const out = await executeCommand(testDbs().api.db, cmd, input, human(u), meta);
  return { output: out.output, commandId: meta.commandId! };
}

let t: Team;
/** The business number customers text. */
let number: string;
let calendarId: string;
let day: string;
const stage = { new: '', contacted: '', estimate: '', won: '' };

beforeAll(async () => {
  t = await setupTeam('later');
  const list = await rows<{ id: string; name: string }>(
    admin(),
    sql`select s.id, s.name from app.pipeline_stages s where s.workspace_id = ${t.wsId} order by s.position`,
  );
  const byName = new Map(list.map((s) => [s.name, s.id]));
  stage.new = byName.get('New')!;
  stage.contacted = byName.get('Contacted')!;
  stage.estimate = byName.get('Estimate sent')!;
  stage.won = byName.get('Won')!;
  // Texting ready: an approved toll-free number, and no quiet hours.
  number = `+1888555${String(1000 + Math.floor(Math.random() * 9000))}`;
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${t.wsId}, 'fake', ${`AClc${uniq()}`}, 'active') returning id`,
  );
  const [line] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${t.wsId}, ${account!.id}, ${`PNlc${uniq()}`}, ${number}, 'toll_free', 'active') returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${t.wsId}, ${account!.id}, ${line!.id}, 'toll_free_verification', 'approved', ${`HHlc${uniq()}`}, now())`,
  );
  await web(
    phoneUpdateSettings,
    { workspaceId: t.wsId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
    t.owner,
  );
  calendarId = (
    await makeCalendar(t, 'Visits', { public: true, team: { members: [{ userId: t.priya.id }] } })
  ).id;
  day = addDays(localDateOf(Date.now(), CHI), 1);
  while (weekdayOf(day) === 0 || weekdayOf(day) === 6) day = addDays(day, 1);
  await web(
    attentionSaveSettings,
    { workspaceId: t.wsId, settings: { appointments: { windowHours: 168 } } },
    t.owner,
  );
});
afterAll(closeTestDbs);

let phones = 0;
const nextPhone = () => `+1512555${String(2000 + phones++).padStart(4, '0')}`;

async function customer(firstName: string, extra: Record<string, unknown> = {}) {
  const out = await web(
    personCreate,
    { workspaceId: t.wsId, firstName, lastName: 'Lopez', ignoreDuplicates: true, ...extra },
    t.owner,
  );
  return out.personId;
}

/** The sentences of a record's "not applied" entries, newest first, as the timeline shows them after the name. */
async function notApplied(recordType: 'person' | 'company' | 'lead', recordId: string) {
  const { items } = await ask(timelineList, { workspaceId: t.wsId, recordType, recordId }, t.owner);
  return items
    .filter((i) => i.subtype === 'edit_not_applied')
    .map((i) => `${i.actor?.fullName ?? ''} ${notAppliedWords(i.meta)}`);
}

// ---------- a stage move ----------

describe('a stage move', () => {
  async function lead(title: string, madeAt: Date) {
    const personId = await customer(title);
    const { output } = await phone(
      leadCreate,
      { workspaceId: t.wsId, id: randomUUID(), title, personId },
      t.member,
      madeAt,
    );
    return { personId, leadId: output.leadId };
  }
  const leadRow = async (id: string) =>
    (await admin().select().from(leads).where(eq(leads.id, id)))[0]!;

  it('someone moved the lead after it was made: theirs stands, answered as applied, and the timeline says so', async () => {
    const { personId, leadId } = await lead('AC replacement', ago(5 * HOUR));
    await web(leadMoveStage, { workspaceId: t.wsId, leadId, stageId: stage.contacted }, t.owner);
    const { output, commandId } = await phone(
      leadMoveStage,
      { workspaceId: t.wsId, leadId, stageId: stage.won },
      t.member,
      ago(2 * HOUR),
    );
    expect(output).toMatchObject({
      stageId: stage.contacted,
      status: 'open',
      notApplied: ['stageId'],
    });
    expect((await leadRow(leadId)).stageId).toBe(stage.contacted);
    // The phone's queue sees it as sent: its receipt kept the answer, notApplied and all.
    const [receipt] = await admin()
      .select()
      .from(commandReceipts)
      .where(
        and(eq(commandReceipts.userId, t.member.id), eq(commandReceipts.commandId, commandId)),
      );
    expect(receipt).toMatchObject({
      outcome: 'applied',
      answer: { output: { stageId: stage.contacted, notApplied: ['stageId'] } },
    });
    // The member can't read the owner's events, so it doesn't say whose move it was.
    const said = [
      'Mike Member tried to move AC replacement to Won, but it was moved to Contacted after that',
    ];
    expect(await notApplied('lead', leadId)).toEqual(said);
    expect(await notApplied('person', personId)).toEqual(said);

    // Moved on the web by a member, and on an owner's phone before that: the owner may read who moved it.
    const second = await lead('Heat pump', ago(5 * HOUR));
    await web(
      leadMoveStage,
      { workspaceId: t.wsId, leadId: second.leadId, stageId: stage.estimate },
      t.member,
    );
    await phone(
      leadMoveStage,
      { workspaceId: t.wsId, leadId: second.leadId, stageId: stage.contacted },
      t.owner,
      ago(HOUR),
    );
    expect(await notApplied('lead', second.leadId)).toEqual([
      'Dale Owner tried to move Heat pump to Contacted, but Mike Member moved it to Estimate sent after that',
    ]);
  });

  it('a move made after the lead last moved goes through; the web’s always does', async () => {
    const { leadId } = await lead('Boiler', ago(5 * HOUR));
    const movedAt = ago(2 * HOUR);
    const { output } = await phone(
      leadMoveStage,
      { workspaceId: t.wsId, leadId, stageId: stage.contacted },
      t.member,
      movedAt,
    );
    expect(output).toMatchObject({ stageId: stage.contacted, notApplied: [] });
    expect((await leadRow(leadId)).stageEnteredAt.toISOString()).toBe(movedAt.toISOString());
    const fromWeb = await web(
      leadMoveStage,
      { workspaceId: t.wsId, leadId, stageId: stage.won },
      t.owner,
    );
    expect(fromWeb).toMatchObject({ stageId: stage.won, status: 'won', notApplied: [] });
    expect(await notApplied('lead', leadId)).toEqual([]);
  });
});

// ---------- tasks ----------

describe('ticking and reopening a task', () => {
  async function task(title: string) {
    const personId = await customer(title.split(' ')[0]!);
    const { taskId } = await web(taskCreate, { workspaceId: t.wsId, title, personId }, t.owner);
    return { personId, taskId };
  }
  const taskRow = async (id: string) =>
    (await admin().select().from(tasks).where(eq(tasks.id, id)))[0]!;

  it('a tick someone reopened after, or a reopen someone ticked after, stays as they left it', async () => {
    const a = await task('Order the condenser');
    await web(taskComplete, { workspaceId: t.wsId, taskId: a.taskId }, t.owner);
    await web(taskReopen, { workspaceId: t.wsId, taskId: a.taskId }, t.owner);
    const ticked = await phone(
      taskComplete,
      { workspaceId: t.wsId, taskId: a.taskId },
      t.member,
      ago(2 * HOUR),
    );
    expect(ticked.output).toEqual({ taskId: a.taskId, doneAt: null, notApplied: ['done'] });
    expect((await taskRow(a.taskId)).doneAt).toBeNull();
    expect(await notApplied('person', a.personId)).toEqual([
      'Mike Member tried to mark the task “Order the condenser” done, but it was reopened after that',
    ]);

    const b = await task('Call the supplier');
    await web(taskComplete, { workspaceId: t.wsId, taskId: b.taskId }, t.owner);
    const reopened = await phone(
      taskReopen,
      { workspaceId: t.wsId, taskId: b.taskId },
      t.member,
      ago(2 * HOUR),
    );
    expect(reopened.output).toEqual({ taskId: b.taskId, notApplied: ['done'] });
    expect((await taskRow(b.taskId)).doneAt).not.toBeNull();
    expect(await notApplied('person', b.personId)).toEqual([
      'Mike Member tried to reopen the task “Call the supplier”, but it was marked done after that',
    ]);
  });

  it('a tick or reopen made after the last one goes through, and says when', async () => {
    const c = await task('Send the invoice');
    const tickedAt = ago(3 * HOUR);
    const ticked = await phone(
      taskComplete,
      { workspaceId: t.wsId, taskId: c.taskId },
      t.member,
      tickedAt,
    );
    expect(ticked.output).toEqual({
      taskId: c.taskId,
      doneAt: tickedAt.toISOString(),
      notApplied: [],
    });
    expect((await taskRow(c.taskId)).fieldTimes.done_at).toBe(tickedAt.toISOString());
    const reopenedAt = ago(2 * HOUR);
    const reopened = await phone(
      taskReopen,
      { workspaceId: t.wsId, taskId: c.taskId },
      t.member,
      reopenedAt,
    );
    expect(reopened.output).toEqual({ taskId: c.taskId, notApplied: [] });
    const row = await taskRow(c.taskId);
    expect(row.doneAt).toBeNull();
    expect(row.fieldTimes.done_at).toBe(reopenedAt.toISOString());
    // A task ticked before done_at had a stamp says when by its done time.
    await rows(
      admin(),
      sql`update app.tasks set done_at = now() - interval '4 hours', field_times = field_times - 'done_at'
          where id = ${c.taskId}`,
    );
    expect(
      (await phone(taskReopen, { workspaceId: t.wsId, taskId: c.taskId }, t.member, ago(HOUR)))
        .output,
    ).toEqual({ taskId: c.taskId, notApplied: [] });
    // From the web, as before.
    expect(
      await web(taskComplete, { workspaceId: t.wsId, taskId: c.taskId }, t.owner),
    ).toMatchObject({ notApplied: [] });
    expect(await notApplied('person', c.personId)).toEqual([]);
  });
});

// ---------- tags ----------

describe('tags', () => {
  async function tagged(firstName: string) {
    const personId = await customer(firstName);
    const { tagId } = await web(tagCreate, { workspaceId: t.wsId, name: `VIP ${uniq()}` }, t.owner);
    const ref = { workspaceId: t.wsId, recordType: 'person', recordId: personId, tagId };
    return { personId, tagId, ref };
  }
  const isOn = async (personId: string, tagId: string) =>
    (
      await admin()
        .select()
        .from(recordTags)
        .where(and(eq(recordTags.recordId, personId), eq(recordTags.tagId, tagId)))
    ).length === 1;
  const name = async (tagId: string) =>
    (await rows<{ name: string }>(admin(), sql`select name from app.tags where id = ${tagId}`))[0]!
      .name;

  it('adding a tag someone removed after, or removing one someone added after, leaves theirs', async () => {
    const a = await tagged('Ana');
    await web(recordAddTag, a.ref, t.owner);
    await web(recordRemoveTag, a.ref, t.owner);
    const added = await phone(recordAddTag, a.ref, t.member, ago(2 * HOUR));
    expect(added.output).toMatchObject({ changed: false, notApplied: ['tagId'] });
    expect(await isOn(a.personId, a.tagId)).toBe(false);

    const b = await tagged('Bea');
    await web(recordAddTag, b.ref, t.owner);
    const removed = await phone(recordRemoveTag, b.ref, t.member, ago(2 * HOUR));
    expect(removed.output).toMatchObject({ changed: false, notApplied: ['tagId'] });
    expect(await isOn(b.personId, b.tagId)).toBe(true);

    expect(await notApplied('person', a.personId)).toEqual([
      `Mike Member tried to add the tag “${await name(a.tagId)}”, but it was removed after that`,
    ]);
    expect(await notApplied('person', b.personId)).toEqual([
      `Mike Member tried to remove the tag “${await name(b.tagId)}”, but it was added after that`,
    ]);
  });

  it('a change made after the tag last changed goes through, and a removal is remembered with its moment', async () => {
    const c = await tagged('Cy');
    const addedAt = ago(3 * HOUR);
    expect((await phone(recordAddTag, c.ref, t.member, addedAt)).output).toMatchObject({
      changed: true,
      notApplied: [],
    });
    const removedAt = ago(2 * HOUR);
    expect((await phone(recordRemoveTag, c.ref, t.member, removedAt)).output).toMatchObject({
      changed: true,
      notApplied: [],
    });
    const [removal] = await admin()
      .select()
      .from(recordTagRemovals)
      .where(and(eq(recordTagRemovals.recordId, c.personId), eq(recordTagRemovals.tagId, c.tagId)));
    expect(removal!.removedAt.toISOString()).toBe(removedAt.toISOString());
    // Put back on the phone an hour ago, after that removal: it goes on.
    expect((await phone(recordAddTag, c.ref, t.member, ago(HOUR))).output).toMatchObject({
      changed: true,
      notApplied: [],
    });
    // From the web, as before.
    expect(await web(recordRemoveTag, c.ref, t.owner)).toMatchObject({
      changed: true,
      notApplied: [],
    });
    expect(await notApplied('person', c.personId)).toEqual([]);
  });
});

// ---------- conversations ----------

describe('closing and snoozing a conversation', () => {
  async function chat(firstName: string) {
    const phoneNumber = nextPhone();
    const personId = await customer(firstName, { phone: phoneNumber });
    const { conversationId } = await web(
      conversationOpen,
      { workspaceId: t.wsId, personId, channel: 'sms' },
      t.owner,
    );
    return { personId, conversationId, phoneNumber };
  }
  const texts = (from: string, body: string, occurredAt?: Date) =>
    runSystem(
      messageReceive,
      {
        workspaceId: t.wsId,
        provider: 'fake',
        providerMessageId: `SMlc-${randomUUID()}`,
        from,
        to: number,
        body,
        ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}),
      },
      t.scope,
    );
  const conversationRow = async (id: string) =>
    (await admin().select().from(conversations).where(eq(conversations.id, id)))[0]!;
  const ref = (conversationId: string) => ({ workspaceId: t.wsId, conversationId });

  it('a close the customer wrote after stays open, and their message still waits for a reply', async () => {
    const maria = await chat('Maria');
    await texts(maria.phoneNumber, 'Can you come Tuesday instead?');
    const closed = await phone(
      conversationClose,
      ref(maria.conversationId),
      t.member,
      ago(2 * HOUR),
    );
    expect(closed.output).toEqual({ conversationId: maria.conversationId, notApplied: ['status'] });
    const row = await conversationRow(maria.conversationId);
    expect(row.status).toBe('open');
    expect(row.awaitingReplySince).not.toBeNull();
    expect(await notApplied('person', maria.personId)).toEqual([
      'Mike Member tried to close the conversation, but Maria wrote again after that',
    ]);
    // A snooze from before that message doesn't hide it either.
    const snoozed = await phone(
      conversationSnooze,
      { ...ref(maria.conversationId), until: later(3 * HOUR).toISOString() },
      t.member,
      ago(HOUR),
    );
    expect(snoozed.output).toEqual({
      conversationId: maria.conversationId,
      notApplied: ['status'],
    });
    expect((await conversationRow(maria.conversationId)).status).toBe('open');
  });

  it('a close someone reopened or snoozed after leaves it as they did', async () => {
    const olga = await chat('Olga');
    await web(conversationClose, ref(olga.conversationId), t.owner);
    await web(conversationReopen, ref(olga.conversationId), t.owner);
    expect(
      (await phone(conversationClose, ref(olga.conversationId), t.member, ago(2 * HOUR))).output,
    ).toEqual({ conversationId: olga.conversationId, notApplied: ['status'] });
    expect((await conversationRow(olga.conversationId)).status).toBe('open');

    const sol = await chat('Sol');
    await web(
      conversationSnooze,
      { ...ref(sol.conversationId), until: later(DAY).toISOString() },
      t.owner,
    );
    expect(
      (await phone(conversationClose, ref(sol.conversationId), t.member, ago(2 * HOUR))).output,
    ).toEqual({ conversationId: sol.conversationId, notApplied: ['status'] });
    expect((await conversationRow(sol.conversationId)).status).toBe('snoozed');
    expect(await notApplied('person', olga.personId)).toEqual([
      'Mike Member tried to close the conversation, but it was reopened after that',
    ]);
    expect(await notApplied('person', sol.personId)).toEqual([
      'Mike Member tried to close the conversation, but it was snoozed after that',
    ]);
  });

  it('a close or snooze made after the customer last wrote goes through; the web’s always does', async () => {
    const pat = await chat('Pat');
    await texts(pat.phoneNumber, 'Thanks!', ago(3 * HOUR));
    expect(
      (await phone(conversationClose, ref(pat.conversationId), t.member, ago(2 * HOUR))).output,
    ).toEqual({ conversationId: pat.conversationId, notApplied: [] });
    const closed = await conversationRow(pat.conversationId);
    expect(closed.status).toBe('closed');
    expect(closed.statusChangedAt!.toISOString()).toBe(closed.closedAt!.toISOString());

    const quinn = await chat('Quinn');
    await texts(quinn.phoneNumber, 'See you then.');
    expect(await web(conversationClose, ref(quinn.conversationId), t.owner)).toEqual({
      conversationId: quinn.conversationId,
      notApplied: [],
    });
    expect((await conversationRow(quinn.conversationId)).status).toBe('closed');
    expect(await notApplied('person', pat.personId)).toEqual([]);
  });
});

// ---------- the Action Center ----------

describe('snoozing and dismissing an Action Center card', () => {
  /** A lead typed in ten days ago with its next action far ahead and nobody in touch: its "Gone quiet" card. */
  async function card(firstName: string, openedAgo: number | null = null) {
    const personId = await customer(firstName);
    const { leadId } = await web(
      leadCreate,
      {
        workspaceId: t.wsId,
        title: 'Duct cleaning',
        personId,
        nextAction: 'Check in about the quote',
        nextActionAt: later(60 * DAY).toISOString(),
      },
      t.owner,
    );
    await rows(
      admin(),
      sql`update app.leads set created_at = now() - interval '10 days', stage_entered_at = now() - interval '10 days'
          where id = ${leadId}`,
    );
    const opened = await asWorker(testDbs().worker.db, t.scope, (tx) =>
      reconcile(tx, t.wsId, [{ type: 'lead', id: leadId }]),
    );
    const itemId = opened.transitions[0]!.itemId;
    if (openedAgo !== null)
      await rows(
        admin(),
        sql`update app.attention_items set opened_at = ${ago(openedAgo).toISOString()}::timestamptz where id = ${itemId}`,
      );
    return { personId, leadId, itemId };
  }
  const itemRow = async (id: string) =>
    (await admin().select().from(attentionItems).where(eq(attentionItems.id, id)))[0]!;

  it('a card that came back with something new after, or someone snoozed or dismissed after, stays as it is', async () => {
    // Opened just now: it came back after a dismissal made two hours ago.
    const fresh = await card('Fern');
    expect(
      (
        await phone(
          attentionDismiss,
          { workspaceId: t.wsId, itemId: fresh.itemId },
          t.member,
          ago(2 * HOUR),
        )
      ).output,
    ).toMatchObject({ state: 'open', changed: false, notApplied: ['state'] });

    const snoozedLater = await card('Gus', 5 * HOUR);
    await web(
      attentionSnooze,
      { workspaceId: t.wsId, itemId: snoozedLater.itemId, until: later(2 * HOUR).toISOString() },
      t.owner,
    );
    expect(
      (
        await phone(
          attentionDismiss,
          { workspaceId: t.wsId, itemId: snoozedLater.itemId },
          t.member,
          ago(2 * HOUR),
        )
      ).output,
    ).toMatchObject({ state: 'snoozed', notApplied: ['state'] });

    const dismissedLater = await card('Hana', 5 * HOUR);
    await web(attentionDismiss, { workspaceId: t.wsId, itemId: dismissedLater.itemId }, t.owner);
    // A snooze of a card someone dismissed later isn't refused: the dismissal stands.
    expect(
      (
        await phone(
          attentionSnooze,
          {
            workspaceId: t.wsId,
            itemId: dismissedLater.itemId,
            until: later(HOUR).toISOString(),
          },
          t.member,
          ago(2 * HOUR),
        )
      ).output,
    ).toMatchObject({ state: 'dismissed', notApplied: ['state'] });

    expect((await itemRow(fresh.itemId)).state).toBe('open');
    expect(await notApplied('lead', fresh.leadId)).toEqual([
      'Mike Member tried to dismiss the “Gone quiet” card, but it came back with something new after that',
    ]);
    expect(await notApplied('lead', snoozedLater.leadId)).toEqual([
      'Mike Member tried to dismiss the “Gone quiet” card, but Dale Owner snoozed it after that',
    ]);
    expect(await notApplied('lead', dismissedLater.leadId)).toEqual([
      'Mike Member tried to snooze the “Gone quiet” card, but Dale Owner dismissed it after that',
    ]);
  });

  it('a snooze or dismissal made after the card last changed goes through; the web’s always does', async () => {
    const early = await card('Ivo', 5 * HOUR);
    expect(
      (
        await phone(
          attentionDismiss,
          { workspaceId: t.wsId, itemId: early.itemId },
          t.member,
          ago(2 * HOUR),
        )
      ).output,
    ).toMatchObject({ state: 'dismissed', changed: true, notApplied: [] });
    const fromWeb = await card('Jo');
    expect(
      await web(
        attentionSnooze,
        { workspaceId: t.wsId, itemId: fromWeb.itemId, until: later(HOUR).toISOString() },
        t.owner,
      ),
    ).toMatchObject({ state: 'snoozed', changed: true, notApplied: [] });
    expect(await notApplied('lead', early.leadId)).toEqual([]);
  });
});

// ---------- a staff confirmation ----------

describe('a staff confirmation', () => {
  let clock = 9;
  const booked = () =>
    bookOnline(t, calendarId, isoAt(day, `${String(clock++).padStart(2, '0')}:00`), {
      smsConsent: true,
    });
  const seatRow = async (id: string) =>
    (await admin().select().from(appointmentAttendees).where(eq(appointmentAttendees.id, id)))[0]!;

  it('marking a visit confirmed that was moved after, or taking back one confirmed after, leaves it', async () => {
    const moved = await booked();
    await web(
      appointmentReschedule,
      {
        workspaceId: t.wsId,
        appointmentId: moved.appointmentId,
        startsAt: isoAt(day, '16:00'),
        notify: false,
        acknowledgeWarnings: true,
      },
      t.owner,
    );
    const confirmed = await phone(
      attendeeConfirm,
      { workspaceId: t.wsId, attendeeId: moved.attendeeId },
      t.member,
      ago(2 * HOUR),
    );
    expect(confirmed.output).toMatchObject({
      confirmedAt: null,
      changed: false,
      notApplied: ['confirmed'],
    });
    expect((await seatRow(moved.attendeeId)).confirmedAt).toBeNull();
    expect(await notApplied('person', moved.personId)).toEqual([
      'Mike Member tried to mark the visit confirmed, but it was moved to another time after that',
    ]);

    const again = await booked();
    await web(attendeeConfirm, { workspaceId: t.wsId, attendeeId: again.attendeeId }, t.owner);
    const takenBack = await phone(
      attendeeConfirm,
      { workspaceId: t.wsId, attendeeId: again.attendeeId, confirmed: false },
      t.member,
      ago(2 * HOUR),
    );
    expect(takenBack.output).toMatchObject({ confirmedVia: 'staff', notApplied: ['confirmed'] });
    expect(await notApplied('person', again.personId)).toEqual([
      'Mike Member tried to take back the visit’s confirmation, but Dale Owner confirmed it again after that',
    ]);
  });

  it('a confirmation made after the visit last moved goes through; the web’s always does', async () => {
    const seat = await booked();
    const markedAt = ago(2 * HOUR);
    expect(
      (
        await phone(
          attendeeConfirm,
          { workspaceId: t.wsId, attendeeId: seat.attendeeId },
          t.member,
          markedAt,
        )
      ).output,
    ).toMatchObject({ confirmedAt: markedAt.toISOString(), notApplied: [] });
    const other = await booked();
    await web(
      appointmentReschedule,
      {
        workspaceId: t.wsId,
        appointmentId: other.appointmentId,
        startsAt: isoAt(day, '17:00'),
        notify: false,
        acknowledgeWarnings: true,
      },
      t.owner,
    );
    expect(
      await web(attendeeConfirm, { workspaceId: t.wsId, attendeeId: other.attendeeId }, t.owner),
    ).toMatchObject({ confirmedVia: 'staff', notApplied: [] });
    expect(await notApplied('person', seat.personId)).toEqual([]);
  });
});
