/**
 * M8 step 3 follow-ups on the local database: what Home and Settings read beside the items. A "Not confirmed" item
 * carries its appointment and its start; each item says which channel it would use, by the same rules as
 * preview_handle; the preview lists the checks it ran, in the Let HandsFreeOS Handle sheet's words; and
 * attention.settings gives the typical job value HandsFreeOS works out.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcile, type AttentionSubjectRef } from '../src/attention/load';
import { addDays, localDateOf, weekdayOf } from '../src/calendar/index';
import { localMinutes } from '../src/messaging/quiet-hours';
import {
  attentionForRecord,
  attentionList,
  attentionPreviewHandle,
  attentionSaveSettings,
  attentionSettingsGet,
  leadCreate,
  leadMoveStage,
  messageReceive,
  personCreate,
  personSetSmsConsent,
  phoneUpdateSettings,
  taskCreate,
} from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  CHI,
  isoAt,
  makeCalendar,
  nextPhone,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const later = (ms: number) => new Date(Date.now() + ms);

let t: Team;
let calendarId: string;
/** The first weekday after today (Chicago). */
let day: string;
let businessNumber: string;

const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

/** An active toll-free number the carriers approved, so texts can go. */
async function readyTexting(wsId: string): Promise<string> {
  const e164 = randomE164();
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`AChn${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNhn${randomUUID().slice(0, 8)}`}, ${e164}, 'toll_free', 'active')
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${wsId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHhn${randomUUID().slice(0, 8)}`}, now())`,
  );
  return e164;
}

const settle = (subjects: readonly AttentionSubjectRef[]) =>
  asWorker(testDbs().worker.db, t.scope, (tx) => reconcile(tx, t.wsId, subjects));
const itemFor = async (subjectId: string) =>
  (await ask(attentionList, { workspaceId: t.wsId, scope: 'everyone' }, t.owner)).items.find(
    (i) => i.subject.id === subjectId,
  )!;
const preview = (itemId: string) =>
  ask(attentionPreviewHandle, { workspaceId: t.wsId, itemId }, t.owner);
const text = (from: string, body: string) =>
  runSystem(
    messageReceive,
    {
      workspaceId: t.wsId,
      provider: 'fake',
      providerMessageId: `SMhn-${randomUUID()}`,
      from,
      to: businessNumber,
      body,
    },
    t.scope,
  );
/** Someone on the team typed them in. */
const customer = async (firstName: string, extra: Record<string, unknown> = {}) =>
  (
    await run(
      personCreate,
      { workspaceId: t.wsId, firstName, lastName: 'Hint', ignoreDuplicates: true, ...extra },
      t.owner,
    )
  ).personId;
/** A lead typed in ten days ago, its next action well ahead: stale, nothing else. */
async function staleLead(personId: string, title: string) {
  const { leadId } = await run(
    leadCreate,
    {
      workspaceId: t.wsId,
      title,
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
  return leadId;
}
const optIn = (personId: string) =>
  run(personSetSmsConsent, { workspaceId: t.wsId, personId, consent: 'opted_in' }, t.owner);
const quietHours = (quiet: { enabled: boolean; start: string; end: string }) =>
  run(phoneUpdateSettings, { workspaceId: t.wsId, quietHours: quiet }, t.owner);

beforeAll(async () => {
  t = await setupTeam('hints');
  businessNumber = await readyTexting(t.wsId);
  await quietHours({ enabled: false, start: '20:00', end: '08:00' });
  calendarId = (
    await makeCalendar(t, 'Visits', { public: true, team: { members: [{ userId: t.priya.id }] } })
  ).id;
  day = addDays(localDateOf(Date.now(), CHI), 1);
  while (weekdayOf(day) === 0 || weekdayOf(day) === 6) day = addDays(day, 1);
  // Unconfirmed bookings open within a week, and nudges are on (the owner read the message).
  await run(
    attentionSaveSettings,
    {
      workspaceId: t.wsId,
      settings: {
        appointments: { windowHours: 168 },
        auto: { nudges: true, nudgeReviewedAt: new Date().toISOString() },
      },
    },
    t.owner,
  );
});
afterAll(closeTestDbs);

describe('beside each item', () => {
  it('a “Not confirmed” item carries its appointment, its start, and how the request would go', async () => {
    const texted = await bookOnline(t, calendarId, isoAt(day, '09:00'), {
      customer: { firstName: 'Nathan', lastName: 'Cole', phone: nextPhone() },
      smsConsent: true,
    });
    const emailed = await bookOnline(t, calendarId, isoAt(day, '10:00'), {
      customer: { firstName: 'Ivy', lastName: 'Park', email: 'ivy.park@example.com' },
    });
    await settle([
      { type: 'attendee', id: texted.attendeeId },
      { type: 'attendee', id: emailed.attendeeId },
    ]);
    const byText = await itemFor(texted.attendeeId);
    expect(byText).toMatchObject({
      kind: 'unconfirmed_appointment',
      appointmentId: texted.appointmentId,
      startsAt: texted.startsAt,
      reach: 'sms',
    });
    expect(await itemFor(emailed.attendeeId)).toMatchObject({
      appointmentId: emailed.appointmentId,
      startsAt: emailed.startsAt,
      reach: 'email',
    });
    // The preview agrees, and the appointment's banner carries it too.
    expect((await preview(byText.id)).auto).toMatchObject({
      action: 'confirm_request',
      channel: 'sms',
    });
    const banner = await ask(
      attentionForRecord,
      { workspaceId: t.wsId, recordType: 'appointment', recordId: texted.appointmentId },
      t.member,
    );
    expect(banner.items).toEqual([
      expect.objectContaining({
        id: byText.id,
        appointmentId: texted.appointmentId,
        startsAt: texted.startsAt,
      }),
    ]);
  });

  it('a group time opens no “Not confirmed” item: only a one-on-one booking is asked', async () => {
    const group = await bookOnline(t, calendarId, isoAt(day, '11:00'), {
      customer: { firstName: 'Gus', lastName: 'Group', phone: nextPhone() },
      smsConsent: true,
    });
    // A group time holds several customers, like a session: HandsFreeOS never asks them to confirm.
    await rows(
      admin(),
      sql`update app.appointments set capacity = 4 where id = ${group.appointmentId}`,
    );
    expect((await settle([{ type: 'attendee', id: group.attendeeId }])).transitions).toEqual([]);
    expect(
      await rows(
        admin(),
        sql`select 1 from app.attention_items
            where workspace_id = ${t.wsId} and subject_id = ${group.attendeeId}`,
      ),
    ).toHaveLength(0);
  });

  it('each item says which channel it would use, by the preview’s rules', async () => {
    // A nudge: an email to someone who never agreed to texts, a text once they do.
    const sam = await customer('Sam', { phone: nextPhone(), email: 'sam.hint@example.com' });
    const staleId = await staleLead(sam, 'Attic insulation');
    // A hot lead's reply goes in her text conversation.
    const valPhone = nextPhone();
    const val = (
      await runSystem(
        personCreate,
        {
          workspaceId: t.wsId,
          firstName: 'Val',
          lastName: 'Hint',
          phone: valPhone,
          email: 'val.hint@example.com',
          ignoreDuplicates: true,
        },
        t.scope,
      )
    ).personId;
    const hotId = (
      await runSystem(
        leadCreate,
        { workspaceId: t.wsId, title: 'Heat pump', personId: val },
        t.scope,
      )
    ).leadId;
    await text(valPhone, 'Can someone come out today? The heat quit.');
    const { taskId } = await run(
      taskCreate,
      {
        workspaceId: t.wsId,
        title: 'Order the part',
        dueAt: later(-2 * HOUR).toISOString(),
        allDay: false,
      },
      t.owner,
    );
    await settle([
      { type: 'lead', id: staleId },
      { type: 'person', id: val },
      { type: 'task', id: taskId },
    ]);

    const stale = await itemFor(staleId);
    expect(stale).toMatchObject({ kind: 'stale_opportunity', reach: 'email', appointmentId: null });
    expect((await preview(stale.id)).auto).toMatchObject({ channel: 'email' });
    await optIn(sam);
    expect((await itemFor(staleId)).reach).toBe('sms');
    expect((await preview(stale.id)).auto).toMatchObject({ channel: 'sms', blocked: null });

    const hot = await itemFor(hotId);
    expect(hot).toMatchObject({ kind: 'hot_lead', reach: 'sms', startsAt: null });
    // Her number says STOP: the reply goes by email, and the preview offers the same.
    await text(valPhone, 'STOP');
    expect((await itemFor(hotId)).reach).toBe('email');
    expect((await preview(hot.id)).options).toContainEqual(
      expect.objectContaining({
        action: 'reply',
        available: true,
        channel: 'email',
        label: 'Email them',
        conversationId: null,
      }),
    );
    // A task is a person's own to-do.
    expect((await itemFor(taskId)).reach).toBeNull();
  });
});

describe('the checks behind a preview', () => {
  it('lists the checks it ran, in the sheet’s words', async () => {
    // Quiet hours that start a few hours from now: the text goes before them.
    const hour = (Math.floor(localMinutes(new Date(), CHI) / 60) + 3) % 24;
    const clock = (h: number) => `${String(h).padStart(2, '0')}:00`;
    const said = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
    await quietHours({ enabled: true, start: clock(hour), end: clock((hour + 1) % 24) });
    try {
      const phone = nextPhone();
      const nathan = await customer('Nathan', { phone });
      await optIn(nathan);
      const leadId = await staleLead(nathan, 'Duct cleaning');
      await settle([{ type: 'lead', id: leadId }]);
      const item = await itemFor(leadId);
      const ready = await preview(item.id);
      expect(ready.auto).toMatchObject({ action: 'nudge', channel: 'sms', blocked: null });
      expect(ready.auto!.checks).toEqual([
        { code: 'texts', label: 'Nathan said texts are OK', ok: true },
        {
          code: 'quiet_hours',
          label: `Outside quiet hours (${said(hour)} to ${said((hour + 1) % 24)})`,
          ok: true,
        },
        { code: 'talking', label: 'Nobody on your team is talking with Nathan', ok: true },
        { code: 'busy', label: 'No workflow running and no draft waiting', ok: true },
        { code: 'cooldown', label: 'No other automatic message in the last 14 days', ok: true },
      ]);

      // He writes in: he's waiting on a reply, so the nudge waits.
      await text(phone, 'Any word on the quote?');
      const waiting = await preview(item.id);
      expect(waiting.auto!.blocked).toMatchObject({ code: 'customer_waiting' });
      expect(waiting.auto!.checks).toContainEqual({
        code: 'talking',
        label: 'Nathan is waiting on a reply',
        ok: false,
      });

      // Someone who never agreed to texts: the email check comes in, and quiet hours don't apply.
      const ivy = await customer('Ivy', { phone: nextPhone(), email: 'ivy.hint@example.com' });
      const ivyLead = await staleLead(ivy, 'Water heater');
      await settle([{ type: 'lead', id: ivyLead }]);
      const byEmail = await preview((await itemFor(ivyLead)).id);
      expect(byEmail.auto).toMatchObject({ channel: 'email', blocked: null });
      expect(byEmail.auto!.checks.map((c) => [c.code, c.ok])).toEqual([
        ['texts', false],
        ['email', true],
        ['talking', true],
        ['busy', true],
        ['cooldown', true],
      ]);
      expect(byEmail.auto!.checks.slice(0, 2).map((c) => c.label)).toEqual([
        'Ivy hasn’t said texts are OK',
        'It can go by email to ivy.hint@example.com',
      ]);
      expect(byEmail.auto!.notes).toContain('They haven’t agreed to texts, so this goes by email.');
    } finally {
      await quietHours({ enabled: false, start: '20:00', end: '08:00' });
    }
  });
});

describe('attention.settings', () => {
  it('gives the settings and the typical job value HandsFreeOS works out', async () => {
    const fresh = await ask(attentionSettingsGet, { workspaceId: t.wsId }, t.member);
    expect(fresh).toMatchObject({
      typicalJobValueCents: 50_000,
      typicalFrom: 'default',
      settings: { appointments: { windowHours: 168 }, typicalJobValueCents: null },
    });

    // Two jobs won this year, $1,200 and $3,000: the median is $2,100.
    for (const cents of [120_000, 300_000]) {
      const personId = await customer(`Won ${cents}`);
      const { leadId } = await run(
        leadCreate,
        { workspaceId: t.wsId, title: 'Install', personId, valueCents: cents },
        t.owner,
      );
      const [won] = await rows<{ id: string }>(
        admin(),
        sql`select s.id from app.pipeline_stages s join app.leads l on l.pipeline_id = s.pipeline_id
            where l.id = ${leadId} and s.kind = 'won' order by s.position limit 1`,
      );
      await run(leadMoveStage, { workspaceId: t.wsId, leadId, stageId: won!.id }, t.owner);
    }
    expect(await ask(attentionSettingsGet, { workspaceId: t.wsId }, t.member)).toMatchObject({
      typicalJobValueCents: 210_000,
      typicalFrom: 'won_median',
    });

    // The business's own figure is in the settings; the worked-out one stays beside it.
    await run(
      attentionSaveSettings,
      { workspaceId: t.wsId, settings: { ...fresh.settings, typicalJobValueCents: 99_900 } },
      t.owner,
    );
    expect(await ask(attentionSettingsGet, { workspaceId: t.wsId }, t.owner)).toMatchObject({
      typicalJobValueCents: 210_000,
      typicalFrom: 'won_median',
      settings: { typicalJobValueCents: 99_900 },
    });
  });
});
