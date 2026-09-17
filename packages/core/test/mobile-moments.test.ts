/**
 * M10 on the local database: a change made on a phone with no signal records when the person made it, not when it
 * reached the server. Each change below is sent from the phone with the moment it was made, hours ago, and stamps
 * that moment; the same change from the web stamps now, as before.
 * - **Leads:** a move enters its stage, is won and goes on the timeline when it was made, unless someone else moved
 *   the lead since (then it counts from when it arrived); a lead made offline enters its first stage then, with its
 *   tags; archiving, restoring, an assignment and a next action go on the timeline when they were done.
 * - **Customers and companies** are made, archived (their open leads with them) and restored when it was done.
 * - **Tags and files:** a tag goes on, and a photo is added, when it was done, and a file is never added before it was
 *   reserved.
 * - **The inbox, bookings and the Action Center:** a conversation closed, a booking confirmed, a visit marked done or
 *   cancelled, and an item snoozed, dismissed, handled or its automatic message cancelled.
 * - **What reads these times:** a stage move made offline sorts before a note written after it, the Action Center
 *   still opens and closes its cards, and a lead's last contact only moves forward.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  activities,
  appointmentAttendees,
  attentionItems,
  companies,
  conversations,
  files,
  leads,
  people,
  recordTags,
} from '@hfos/db/schema';
import { closeTestDbs, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { reconcile, type AttentionSubjectRef } from '../src/attention/load';
import { addDays, localDateOf, weekdayOf } from '../src/calendar/index';
import { executeCommand } from '../src/kernel/execute';
import type { CommandDef, RequestMeta } from '../src/kernel/types';
import {
  activityLog,
  appointmentCancel,
  appointmentSetStatus,
  attendeeConfirm,
  attentionCancelAuto,
  attentionDismiss,
  attentionLetHandle,
  attentionSaveSettings,
  attentionSnooze,
  companyArchive,
  companyCreate,
  companyRestore,
  conversationClose,
  conversationOpen,
  conversationReopen,
  fileBeginUpload,
  fileConfirm,
  fileList,
  leadArchive,
  leadCreate,
  leadMoveStage,
  leadRestore,
  leadSetNextAction,
  leadUpdate,
  personArchive,
  personCreate,
  personRestore,
  recordAddTag,
  tagCreate,
  taskComplete,
  taskCreate,
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
  setupTeam,
  type Team,
} from './calendar-helpers';

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const later = (ms: number) => new Date(Date.now() + ms);
/** Stamped just now (the web's changes, and bookkeeping), allowing for the database's clock. */
const recent = (at: Date | null | undefined) =>
  at !== null && at !== undefined && Math.abs(Date.now() - at.getTime()) < MIN;
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

/** A change made on the phone at `madeAt` (already on the server's clock), arriving now. */
const phone = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
  madeAt: Date,
  opts: { confirmedAt?: Date } = {},
) => {
  const meta: RequestMeta = {
    correlationId: randomUUID(),
    channel: 'mobile',
    commandId: randomUUID(),
    occurredAt: madeAt,
    sentAt: new Date(),
    confirmedAt: opts.confirmedAt ?? null,
    appVersion: '1.0.0',
  };
  return executeCommand(testDbs().api.db, cmd, input, human(u), meta).then((r) => r.output);
};

let t: Team;
let calendarId: string;
/** The next weekday (Chicago), so bookings fall inside the Action Center's window. */
let day: string;
/** The default pipeline's stages, in order: New, Contacted and Estimate sent are open, then Won and Lost. */
const stage = { new: '', contacted: '', estimate: '', won: '' };
const stageName = { new: 'New', contacted: 'Contacted', estimate: 'Estimate sent' };

beforeAll(async () => {
  t = await setupTeam('moments');
  const list = await rows<{ id: string; name: string }>(
    admin(),
    sql`select s.id, s.name from app.pipeline_stages s where s.workspace_id = ${t.wsId} order by s.position`,
  );
  const byName = new Map(list.map((s) => [s.name, s.id]));
  stage.new = byName.get('New')!;
  stage.contacted = byName.get('Contacted')!;
  stage.estimate = byName.get('Estimate sent')!;
  stage.won = byName.get('Won')!;
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

async function customer(firstName: string, extra: Record<string, unknown> = {}) {
  const out = await web(
    personCreate,
    { workspaceId: t.wsId, firstName, lastName: uniq(), ignoreDuplicates: true, ...extra },
    t.owner,
  );
  return out.personId;
}
/** A lead the phone made at `madeAt`, in the first open stage. */
async function phoneLead(personId: string, madeAt: Date, title = 'New AC') {
  const out = await phone(
    leadCreate,
    { workspaceId: t.wsId, id: randomUUID(), title, personId },
    t.member,
    madeAt,
  );
  return out.leadId;
}
const leadRow = async (id: string) =>
  (await admin().select().from(leads).where(eq(leads.id, id)))[0]!;
/** The timeline entries of one kind on a lead, person or company. */
const entries = (
  subtype: string,
  on: { leadId: string } | { personId: string } | { companyId: string },
) =>
  admin()
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.subtype, subtype),
        'leadId' in on
          ? eq(activities.leadId, on.leadId)
          : 'personId' in on
            ? eq(activities.personId, on.personId)
            : eq(activities.companyId, on.companyId),
      ),
    );
const settle = (subjects: readonly AttentionSubjectRef[], at: Date = new Date()) =>
  asWorker(testDbs().worker.db, t.scope, (tx) => reconcile(tx, t.wsId, subjects, at));
const itemOn = async (subjectId: string, kind: string) =>
  (
    await admin()
      .select()
      .from(attentionItems)
      .where(and(eq(attentionItems.subjectId, subjectId), eq(attentionItems.kind, kind)))
  )[0];
/** A lead someone on the team typed in ten days ago, next action well ahead, nobody in touch since: stale. */
async function staleLead(firstName: string) {
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
  const opened = await settle([{ type: 'lead', id: leadId }]);
  expect(opened.transitions).toMatchObject([{ type: 'opened', kind: 'stale_opportunity' }]);
  return { leadId, itemId: opened.transitions[0]!.itemId };
}
let clock = 8;
/** A booking on the next weekday, an hour after the last one. */
const booked = () =>
  bookOnline(t, calendarId, isoAt(day, `${String(clock++).padStart(2, '0')}:00`), {
    smsConsent: true,
  });

// ---------- leads ----------

describe('leads', () => {
  it('a move made offline enters its stage, is won and goes on the timeline when it was made', async () => {
    const personId = await customer('Rita');
    const leadId = await phoneLead(personId, ago(3 * HOUR));
    const wonAt = ago(2 * HOUR);
    const moved = await phone(
      leadMoveStage,
      { workspaceId: t.wsId, leadId, stageId: stage.won },
      t.member,
      wonAt,
    );
    expect(moved.status).toBe('won');
    const lead = await leadRow(leadId);
    expect(lead.stageEnteredAt.toISOString()).toBe(wonAt.toISOString());
    expect(lead.wonAt!.toISOString()).toBe(wonAt.toISOString());
    const [won] = await entries('won', { leadId });
    expect(won!.occurredAt.toISOString()).toBe(wonAt.toISOString());

    // The same move from the web is made now.
    const other = await phoneLead(personId, ago(3 * HOUR), 'Furnace');
    await web(
      leadMoveStage,
      { workspaceId: t.wsId, leadId: other, stageId: stage.contacted },
      t.owner,
    );
    const fromWeb = await leadRow(other);
    expect(recent(fromWeb.stageEnteredAt)).toBe(true);
    const [changed] = await entries('stage_changed', { leadId: other });
    expect(changed!.occurredAt.getTime()).toBe(fromWeb.stageEnteredAt.getTime());
  });

  it('a move made before someone else’s later move counts from when it arrived', async () => {
    const personId = await customer('Ola');
    const leadId = await phoneLead(personId, ago(5 * HOUR));
    await web(leadMoveStage, { workspaceId: t.wsId, leadId, stageId: stage.contacted }, t.owner);
    const webMove = await leadRow(leadId);
    // Moved on a phone two hours ago, before the web's move, and only now arriving.
    await phone(
      leadMoveStage,
      { workspaceId: t.wsId, leadId, stageId: stage.estimate },
      t.member,
      ago(2 * HOUR),
    );
    const lead = await leadRow(leadId);
    expect(lead.stageId).toBe(stage.estimate);
    expect(recent(lead.stageEnteredAt)).toBe(true);
    expect(lead.stageEnteredAt.getTime()).toBeGreaterThan(webMove.stageEnteredAt.getTime());
    // So the timeline reads in the order the lead really moved.
    const { items } = await ask(
      timelineList,
      { workspaceId: t.wsId, recordType: 'lead', recordId: leadId },
      t.owner,
    );
    expect(items.filter((i) => i.subtype === 'stage_changed').map((i) => i.body)).toEqual([
      `${stageName.contacted} → ${stageName.estimate}`,
      `${stageName.new} → ${stageName.contacted}`,
    ]);
  });

  it('a lead made offline starts in its stage, with its tags, when it was made', async () => {
    const personId = await customer('Omar');
    const { tagId } = await web(
      tagCreate,
      { workspaceId: t.wsId, name: `Offline ${uniq()}` },
      t.owner,
    );
    const madeAt = ago(2 * HOUR);
    const { leadId } = await phone(
      leadCreate,
      { workspaceId: t.wsId, id: randomUUID(), title: 'Heat pump', personId, tagIds: [tagId] },
      t.member,
      madeAt,
    );
    const lead = await leadRow(leadId);
    expect(lead.stageEnteredAt.toISOString()).toBe(madeAt.toISOString());
    // The row itself says when it arrived.
    expect(recent(lead.createdAt)).toBe(true);
    const [created] = await entries('lead_created', { leadId });
    expect(created!.occurredAt.toISOString()).toBe(madeAt.toISOString());
    const [tag] = await admin().select().from(recordTags).where(eq(recordTags.recordId, leadId));
    expect(tag!.createdAt.toISOString()).toBe(madeAt.toISOString());
  });

  it('archiving, restoring, an assignment and a next action go on the timeline when they were done', async () => {
    const personId = await customer('Nell');
    const leadId = await phoneLead(personId, ago(5 * HOUR));
    const archivedAt = ago(4 * HOUR);
    await phone(leadArchive, { workspaceId: t.wsId, leadId }, t.owner, archivedAt);
    expect((await leadRow(leadId)).archivedAt!.toISOString()).toBe(archivedAt.toISOString());
    const restoredAt = ago(3 * HOUR);
    await phone(leadRestore, { workspaceId: t.wsId, leadId }, t.owner, restoredAt);
    const assignedAt = ago(2 * HOUR);
    await phone(
      leadUpdate,
      { workspaceId: t.wsId, leadId, assigneeUserId: t.priya.id },
      t.owner,
      assignedAt,
    );
    const nextAt = ago(HOUR);
    await phone(
      leadSetNextAction,
      { workspaceId: t.wsId, leadId, text: 'Send the quote', dueAt: later(DAY).toISOString() },
      t.member,
      nextAt,
    );
    const when = async (subtype: string) =>
      (await entries(subtype, { leadId }))[0]!.occurredAt.toISOString();
    expect({
      archived: await when('archived'),
      restored: await when('restored'),
      assigned: await when('assigned'),
      next_action: await when('next_action'),
    }).toEqual({
      archived: archivedAt.toISOString(),
      restored: restoredAt.toISOString(),
      assigned: assignedAt.toISOString(),
      next_action: nextAt.toISOString(),
    });

    // From the web, now.
    await web(leadArchive, { workspaceId: t.wsId, leadId }, t.owner);
    expect(recent((await leadRow(leadId)).archivedAt)).toBe(true);
  });
});

// ---------- customers and companies ----------

describe('customers and companies', () => {
  it('are made, archived with their open leads, and restored when it was done', async () => {
    const madeAt = ago(5 * HOUR);
    const { personId } = await phone(
      personCreate,
      { workspaceId: t.wsId, id: randomUUID(), firstName: 'Ivy', lastName: uniq() },
      t.member,
      madeAt,
    );
    expect((await entries('created', { personId }))[0]!.occurredAt.toISOString()).toBe(
      madeAt.toISOString(),
    );
    const leadId = await phoneLead(personId, madeAt);
    const archivedAt = ago(4 * HOUR);
    const archived = await phone(
      personArchive,
      { workspaceId: t.wsId, personId, force: true },
      t.owner,
      archivedAt,
    );
    expect(archived.archivedLeads).toBe(1);
    const [person] = await admin().select().from(people).where(eq(people.id, personId));
    expect(person!.archivedAt!.toISOString()).toBe(archivedAt.toISOString());
    expect((await leadRow(leadId)).archivedAt!.toISOString()).toBe(archivedAt.toISOString());
    expect((await entries('archived', { personId }))[0]!.occurredAt.toISOString()).toBe(
      archivedAt.toISOString(),
    );
    const restoredAt = ago(3 * HOUR);
    await phone(personRestore, { workspaceId: t.wsId, personId }, t.owner, restoredAt);
    expect((await entries('restored', { personId }))[0]!.occurredAt.toISOString()).toBe(
      restoredAt.toISOString(),
    );

    const { companyId } = await phone(
      companyCreate,
      { workspaceId: t.wsId, id: randomUUID(), name: `Acme ${uniq()}` },
      t.member,
      madeAt,
    );
    expect((await entries('created', { companyId }))[0]!.occurredAt.toISOString()).toBe(
      madeAt.toISOString(),
    );
    await phone(companyArchive, { workspaceId: t.wsId, companyId }, t.owner, archivedAt);
    const [company] = await admin().select().from(companies).where(eq(companies.id, companyId));
    expect(company!.archivedAt!.toISOString()).toBe(archivedAt.toISOString());
    // From the web, now.
    await web(companyRestore, { workspaceId: t.wsId, companyId }, t.owner);
    expect(recent((await entries('restored', { companyId }))[0]!.occurredAt)).toBe(true);
  });
});

// ---------- tags and files ----------

describe('tags and files', () => {
  it('a tag goes on when it was put on', async () => {
    const personId = await customer('Tad');
    const [first, second] = await Promise.all(
      ['Gate code', 'Dog'].map((name) =>
        web(tagCreate, { workspaceId: t.wsId, name: `${name} ${uniq()}` }, t.owner),
      ),
    );
    const taggedAt = ago(2 * HOUR);
    const input = { workspaceId: t.wsId, recordType: 'person', recordId: personId };
    await phone(recordAddTag, { ...input, tagId: first!.tagId }, t.member, taggedAt);
    await web(recordAddTag, { ...input, tagId: second!.tagId }, t.owner);
    const tags = await admin().select().from(recordTags).where(eq(recordTags.recordId, personId));
    const at = (tagId: string) => tags.find((r) => r.tagId === tagId)!.createdAt;
    expect(at(first!.tagId).toISOString()).toBe(taggedAt.toISOString());
    expect(recent(at(second!.tagId))).toBe(true);
  });

  it('a photo added offline shows when it was added, and never before it was reserved', async () => {
    const personId = await customer('Pia');
    const putObject = (path: string) =>
      rows(
        admin(),
        sql`insert into storage.objects (bucket_id, name, metadata)
            values ('attachments', ${path}, ${JSON.stringify({ size: 42_362, mimetype: 'image/jpeg' })}::jsonb)`,
      );
    const begin = (madeAt: Date | null) => {
      const input = {
        workspaceId: t.wsId,
        id: randomUUID(),
        recordType: 'person',
        recordId: personId,
        name: `Photo ${uniq()}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 42_362,
      };
      return madeAt
        ? phone(fileBeginUpload, input, t.member, madeAt)
        : web(fileBeginUpload, input, t.member);
    };
    const addedAt = (fileId: string) =>
      entries('file_added', { personId }).then(
        (list) => list.find((e) => (e.meta as { fileId?: string }).fileId === fileId)!.occurredAt,
      );

    // Taken two hours ago. Its confirmation's moment, corrected for the phone's clock on its own, came out a little
    // earlier than the reservation's: it's added when it was reserved.
    const takenAt = ago(2 * HOUR);
    const photo = await begin(takenAt);
    const [row] = await admin().select().from(files).where(eq(files.id, photo.fileId));
    expect(row!.createdAt.toISOString()).toBe(takenAt.toISOString());
    await putObject(photo.objectPath);
    await phone(
      fileConfirm,
      { workspaceId: t.wsId, fileId: photo.fileId },
      t.member,
      new Date(takenAt.getTime() - 1500),
    );
    expect((await addedAt(photo.fileId)).toISOString()).toBe(takenAt.toISOString());

    // One confirmed with a later moment keeps it.
    const second = await begin(takenAt);
    await putObject(second.objectPath);
    const confirmedAt = new Date(takenAt.getTime() + 5 * MIN);
    await phone(fileConfirm, { workspaceId: t.wsId, fileId: second.fileId }, t.member, confirmedAt);
    expect((await addedAt(second.fileId)).toISOString()).toBe(confirmedAt.toISOString());

    // From the web, a file is reserved and added now.
    const fromWeb = await begin(null);
    await putObject(fromWeb.objectPath);
    await web(fileConfirm, { workspaceId: t.wsId, fileId: fromWeb.fileId }, t.member);
    expect(recent(await addedAt(fromWeb.fileId))).toBe(true);

    // The record's files say the same.
    const { files: list } = await ask(
      fileList,
      { workspaceId: t.wsId, recordType: 'person', recordId: personId },
      t.member,
    );
    expect(list.find((f) => f.id === photo.fileId)!.createdAt).toBe(takenAt.toISOString());
    expect(recent(new Date(list.find((f) => f.id === fromWeb.fileId)!.createdAt))).toBe(true);
  });
});

// ---------- the inbox, bookings and the Action Center ----------

describe('the inbox and bookings', () => {
  it('a conversation closed offline says when it was closed', async () => {
    const personId = await customer('Cleo', { email: `cleo-${uniq()}@example.com` });
    const { conversationId } = await web(
      conversationOpen,
      { workspaceId: t.wsId, personId, channel: 'email' },
      t.owner,
    );
    const closedAt = ago(2 * HOUR);
    await phone(conversationClose, { workspaceId: t.wsId, conversationId }, t.member, closedAt);
    const closedRow = async () =>
      (await admin().select().from(conversations).where(eq(conversations.id, conversationId)))[0]!;
    expect(await closedRow()).toMatchObject({ status: 'closed' });
    expect((await closedRow()).closedAt!.toISOString()).toBe(closedAt.toISOString());
    await web(conversationReopen, { workspaceId: t.wsId, conversationId }, t.owner);
    await web(conversationClose, { workspaceId: t.wsId, conversationId }, t.owner);
    expect(recent((await closedRow()).closedAt)).toBe(true);
  });

  it('a booking confirmed, a visit marked done and one cancelled offline say when', async () => {
    const seat = await booked();
    const confirmedAt = ago(2 * HOUR);
    const marked = await phone(
      attendeeConfirm,
      { workspaceId: t.wsId, attendeeId: seat.attendeeId },
      t.member,
      confirmedAt,
    );
    expect(marked.confirmedAt).toBe(confirmedAt.toISOString());
    const [confirmed] = await entries('appointment_confirmed', { personId: seat.personId });
    expect(confirmed!.occurredAt.toISOString()).toBe(confirmedAt.toISOString());

    const doneAt = ago(90 * MIN);
    await phone(
      appointmentSetStatus,
      { workspaceId: t.wsId, appointmentId: seat.appointmentId, status: 'completed' },
      t.member,
      doneAt,
    );
    const [done] = await entries('appointment_completed', { personId: seat.personId });
    expect(done!.occurredAt.toISOString()).toBe(doneAt.toISOString());

    // Cancelled two hours ago; it went once the person said "Still send".
    const other = await booked();
    const cancelledAt = ago(2 * HOUR);
    await phone(
      appointmentCancel,
      { workspaceId: t.wsId, appointmentId: other.appointmentId, notify: false },
      t.owner,
      cancelledAt,
      { confirmedAt: new Date() },
    );
    const [cancelledSeat] = await admin()
      .select()
      .from(appointmentAttendees)
      .where(eq(appointmentAttendees.id, other.attendeeId));
    expect(cancelledSeat!.cancelledAt!.toISOString()).toBe(cancelledAt.toISOString());
    const [cancelled] = await entries('appointment_cancelled', { personId: other.personId });
    expect(cancelled!.occurredAt.toISOString()).toBe(cancelledAt.toISOString());

    // From the web, a confirmation is marked now.
    const third = await booked();
    const fromWeb = await web(
      attendeeConfirm,
      { workspaceId: t.wsId, attendeeId: third.attendeeId },
      t.member,
    );
    expect(recent(new Date(fromWeb.confirmedAt!))).toBe(true);
  });
});

describe('the Action Center’s items', () => {
  it('an item snoozed, dismissed or its automatic message cancelled offline says when', async () => {
    const snoozed = await staleLead('Sam');
    const snoozedAt = ago(2 * HOUR);
    // "Snooze 3 hours", pressed two hours ago: it comes back in an hour, not three hours after it arrived.
    const until = new Date(snoozedAt.getTime() + 3 * HOUR);
    await phone(
      attentionSnooze,
      { workspaceId: t.wsId, itemId: snoozed.itemId, until: until.toISOString() },
      t.member,
      snoozedAt,
    );
    const item = (await itemOn(snoozed.leadId, 'stale_opportunity'))!;
    expect(item.snoozedAt!.toISOString()).toBe(snoozedAt.toISOString());
    expect(item.snoozedUntil!.toISOString()).toBe(until.toISOString());
    const lead = [{ type: 'lead' as const, id: snoozed.leadId }];
    expect((await settle(lead, later(30 * MIN))).transitions).toEqual([]);
    expect((await settle(lead, later(90 * MIN))).transitions).toMatchObject([
      { type: 'unsnoozed' },
    ]);

    const dismissed = await staleLead('Dot');
    const dismissedAt = ago(2 * HOUR);
    await phone(
      attentionDismiss,
      { workspaceId: t.wsId, itemId: dismissed.itemId, reason: 'Called her from the truck' },
      t.member,
      dismissedAt,
    );
    expect((await itemOn(dismissed.leadId, 'stale_opportunity'))!.dismissedAt!.toISOString()).toBe(
      dismissedAt.toISOString(),
    );

    const waiting = await staleLead('Wes');
    await rows(
      admin(),
      sql`update app.attention_items set auto_state = 'scheduled', auto_scheduled_for = now() + interval '1 hour'
          where id = ${waiting.itemId}`,
    );
    const cancelledAt = ago(2 * HOUR);
    await phone(
      attentionCancelAuto,
      { workspaceId: t.wsId, itemId: waiting.itemId },
      t.member,
      cancelledAt,
    );
    expect((await itemOn(waiting.leadId, 'stale_opportunity'))!.autoDoneAt!.toISOString()).toBe(
      cancelledAt.toISOString(),
    );

    // From the web, now.
    const fromWeb = await staleLead('Web');
    await web(attentionDismiss, { workspaceId: t.wsId, itemId: fromWeb.itemId }, t.member);
    expect(recent((await itemOn(fromWeb.leadId, 'stale_opportunity'))!.dismissedAt)).toBe(true);
  });

  it('Let HandsFreeOS handle, sent once the person said "Still send", is handled when they pressed it', async () => {
    const personId = await customer('Hal');
    const leadId = await phoneLead(personId, ago(3 * HOUR));
    const opened = await settle([{ type: 'lead', id: leadId }]);
    expect(opened.transitions).toMatchObject([{ type: 'opened', kind: 'missing_next_action' }]);
    const pressedAt = ago(2 * HOUR);
    await phone(
      attentionLetHandle,
      {
        workspaceId: t.wsId,
        itemId: opened.transitions[0]!.itemId,
        action: 'set_next_action',
        text: 'Call about the quote',
        dueAt: later(DAY).toISOString(),
      },
      t.owner,
      pressedAt,
      { confirmedAt: new Date() },
    );
    expect((await itemOn(leadId, 'missing_next_action'))!.handledAt!.toISOString()).toBe(
      pressedAt.toISOString(),
    );
    const lead = await leadRow(leadId);
    expect(lead.fieldTimes.next_action).toBe(pressedAt.toISOString());
    expect((await entries('next_action', { leadId }))[0]!.occurredAt.toISOString()).toBe(
      pressedAt.toISOString(),
    );
  });
});

// ---------- what reads these times ----------

describe('what reads these times', () => {
  it('a stage move made offline sorts before a note written after it', async () => {
    const { personId } = await phone(
      personCreate,
      { workspaceId: t.wsId, id: randomUUID(), firstName: 'Tia', lastName: uniq() },
      t.member,
      ago(4 * HOUR),
    );
    const leadId = await phoneLead(personId, ago(3 * HOUR));
    // The note, written an hour ago, reached the server first; the move, made two hours ago, only now.
    await phone(
      activityLog,
      {
        workspaceId: t.wsId,
        id: randomUUID(),
        kind: 'note',
        body: 'Wants it before summer',
        leadId,
        personId,
      },
      t.member,
      ago(HOUR),
    );
    await phone(
      leadMoveStage,
      { workspaceId: t.wsId, leadId, stageId: stage.contacted },
      t.member,
      ago(2 * HOUR),
    );
    const timeline = async (recordType: 'lead' | 'person', recordId: string) =>
      (await ask(timelineList, { workspaceId: t.wsId, recordType, recordId }, t.owner)).items.map(
        (i) => i.subtype ?? i.kind,
      );
    expect(await timeline('lead', leadId)).toEqual(['note', 'stage_changed', 'lead_created']);
    expect(await timeline('person', personId)).toEqual([
      'note',
      'stage_changed',
      'lead_created',
      'created',
    ]);
    // Something done on the web just now goes on top.
    await web(
      activityLog,
      { workspaceId: t.wsId, kind: 'note', body: 'Booked the survey', leadId, personId },
      t.owner,
    );
    expect(await timeline('lead', leadId)).toEqual([
      'note',
      'note',
      'stage_changed',
      'lead_created',
    ]);
  });

  it('the Action Center still opens and closes its cards with the older times', async () => {
    // A lead won offline closes its card.
    const wonPerson = await customer('Wendy');
    const wonLead = await phoneLead(wonPerson, ago(3 * HOUR));
    const opened = await settle([{ type: 'lead', id: wonLead }]);
    expect(opened.transitions).toMatchObject([{ type: 'opened', kind: 'missing_next_action' }]);
    await phone(
      leadMoveStage,
      { workspaceId: t.wsId, leadId: wonLead, stageId: stage.won },
      t.member,
      ago(2 * HOUR),
    );
    expect((await settle([{ type: 'lead', id: wonLead }])).transitions).toMatchObject([
      { type: 'resolved', kind: 'missing_next_action' },
    ]);

    // A lead moved offline counts its time in the new stage from the move, not from when it arrived.
    const movedPerson = await customer('Mo');
    const { leadId: movedLead } = await web(
      leadCreate,
      { workspaceId: t.wsId, title: 'Boiler', personId: movedPerson },
      t.owner,
    );
    await rows(
      admin(),
      sql`update app.leads set created_at = now() - interval '10 days', stage_entered_at = now() - interval '10 days'
          where id = ${movedLead}`,
    );
    // In touch today, so it isn't stale: its only card is the missing next action.
    await web(
      activityLog,
      { workspaceId: t.wsId, kind: 'call', body: 'Called about the boiler', leadId: movedLead },
      t.owner,
    );
    const lead = [{ type: 'lead' as const, id: movedLead }];
    await settle(lead);
    expect((await itemOn(movedLead, 'missing_next_action'))!.sinceAt!.getTime()).toBeLessThan(
      ago(9 * DAY).getTime(),
    );
    const movedAt = ago(2 * HOUR);
    await phone(
      leadMoveStage,
      { workspaceId: t.wsId, leadId: movedLead, stageId: stage.contacted },
      t.member,
      movedAt,
    );
    await settle(lead);
    const moved = (await itemOn(movedLead, 'missing_next_action'))!;
    expect(moved.state).toBe('open');
    expect(moved.sinceAt!.toISOString()).toBe(movedAt.toISOString());

    // A task ticked offline closes its overdue card.
    const { taskId } = await web(
      taskCreate,
      {
        workspaceId: t.wsId,
        title: 'Order the condenser',
        dueAt: ago(DAY).toISOString(),
        allDay: false,
      },
      t.owner,
    );
    const task = [{ type: 'task' as const, id: taskId }];
    expect((await settle(task)).transitions).toMatchObject([
      { type: 'opened', kind: 'overdue_task' },
    ]);
    await phone(taskComplete, { workspaceId: t.wsId, taskId }, t.member, ago(2 * HOUR));
    expect((await settle(task)).transitions).toMatchObject([
      { type: 'resolved', kind: 'overdue_task' },
    ]);

    // A booking confirmed offline closes its card.
    const seat = await booked();
    const attendee = [{ type: 'attendee' as const, id: seat.attendeeId }];
    expect((await settle(attendee)).transitions).toMatchObject([
      { type: 'opened', kind: 'unconfirmed_appointment' },
    ]);
    await phone(
      attendeeConfirm,
      { workspaceId: t.wsId, attendeeId: seat.attendeeId },
      t.member,
      ago(2 * HOUR),
    );
    expect((await settle(attendee)).transitions).toMatchObject([
      { type: 'resolved', kind: 'unconfirmed_appointment' },
    ]);
  });

  it('a lead’s last contact only moves forward when a call logged offline arrives late', async () => {
    const personId = await customer('Lou');
    const leadId = await phoneLead(personId, ago(5 * HOUR));
    const log = (madeAt: Date) =>
      phone(
        activityLog,
        { workspaceId: t.wsId, id: randomUUID(), kind: 'call', body: 'Left a message', leadId },
        t.member,
        madeAt,
      );
    const hourAgo = ago(HOUR);
    await log(hourAgo);
    expect((await leadRow(leadId)).lastContactAt!.toISOString()).toBe(hourAgo.toISOString());
    // A call made before it, logged with no signal, arrives now: the latest contact is still the hour-old one.
    await log(ago(3 * HOUR));
    expect((await leadRow(leadId)).lastContactAt!.toISOString()).toBe(hourAgo.toISOString());
  });
});
