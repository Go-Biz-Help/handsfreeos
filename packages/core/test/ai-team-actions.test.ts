/**
 * M18 step 1 on the local database: the AI teammate's repeat visits and waitlist places for the customer in the
 * conversation it's answering, held in a draft and carried out when a person approves it.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { appointments, events, leads, waitlistEntries } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { applyTeammatePatch, parseTeammateConfig, type TeammatePatch } from '../src/ai-team/index';
import { addDays } from '../src/calendar/index';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  AiEmployeeActor,
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  aiTeammateCreate,
  aiTeammateDecideDraft,
  aiTeammateGet,
  aiTeammateSaveConfig,
  aiTeammateSendDraft,
  aiTeammateSetStatus,
  appointmentBookForCustomer,
  conversationHandToAi,
  estimateAnswerForCustomer,
  estimateCreateForCustomer,
  invoiceCreateForCustomer,
  leadCreate,
  leadMoveStage,
  leadUpdate,
  messageReceive,
  organizationCreate,
  personCreate,
  phoneUpdateSettings,
  planCreate,
  productCreate,
  scheduleSet,
  seriesBookForCustomer,
  subscriptionStartForCustomer,
  waitlistJoinForCustomer,
} from '../src/server';
import {
  isoAt,
  makeCalendar,
  nextWeekday,
  saveCalendar,
  WEEKDAYS,
  type Team,
} from './calendar-helpers';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (channel: RequestMeta['channel'] = 'test'): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});

interface Biz {
  readonly owner: TestUser;
  readonly wsId: string;
  readonly orgId: string;
  readonly number: string;
  teammateId: string;
}
let a: Biz;

const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());
const system = (biz: Biz): SystemActor => ({
  type: 'system',
  workspaceId: biz.wsId,
  organizationId: biz.orgId,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(
  biz: Biz,
  cmd: CommandDef<I, O>,
  input: unknown,
) => executeCommand(worker(), cmd, input, system(biz), meta('worker'));
const ava = (biz: Biz, over: Partial<AiEmployeeActor> = {}): AiEmployeeActor => ({
  type: 'ai_employee',
  workspaceId: biz.wsId,
  organizationId: biz.orgId,
  teammateId: biz.teammateId,
  teammateName: 'Ava',
  runId: null,
  conversationId: null,
  approvedBy: null,
  origin: null,
  test: false,
  ...over,
});
const asAva = <I extends z.ZodType, O extends z.ZodType>(
  biz: Biz,
  over: Partial<AiEmployeeActor>,
  cmd: CommandDef<I, O>,
  input: unknown,
) => executeCommand(worker(), cmd, input, ava(biz, over), meta('ai_employee'));

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
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

const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
let phoneSeq = 0;
const nextPhone = () => `+1832556${String(1000 + phoneSeq++).padStart(4, '0')}`;

async function readyTexting(wsId: string): Promise<string> {
  const e164 = randomE164();
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`ACm18${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNm18${randomUUID().slice(0, 8)}`}, ${e164}, 'toll_free', 'active')
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${wsId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHm18${randomUUID().slice(0, 8)}`}, now())`,
  );
  return e164;
}

async function setupBusiness(label: string): Promise<Biz> {
  const owner = await createTestUser(`m18-${label}-owner`, { fullName: 'Dale Owner' });
  const org = await run(organizationCreate, { businessName: `${label} HVAC` }, owner);
  const biz: Biz = {
    owner,
    wsId: org.workspaceId,
    orgId: org.organizationId,
    number: await readyTexting(org.workspaceId),
    teammateId: '',
  };
  biz.teammateId = (
    await run(
      aiTeammateCreate,
      { workspaceId: biz.wsId, preset: 'lead_responder', name: 'Ava', disclosure: 'when_asked' },
      owner,
    )
  ).teammateId;
  await run(
    aiTeammateSetStatus,
    { workspaceId: biz.wsId, teammateId: biz.teammateId, status: 'training' },
    owner,
  );
  await run(
    phoneUpdateSettings,
    { workspaceId: biz.wsId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
    owner,
  );
  return biz;
}

/** A customer who texted in, in a conversation handed to the AI teammate. */
async function aiChat(biz: Biz, firstName: string) {
  const phone = nextPhone();
  const { personId } = await run(
    personCreate,
    { workspaceId: biz.wsId, firstName, lastName: 'Test', phone, ignoreDuplicates: true },
    biz.owner,
  );
  const { output } = await sys(biz, messageReceive, {
    workspaceId: biz.wsId,
    provider: 'fake',
    providerMessageId: `SM${randomUUID()}`,
    from: phone,
    to: biz.number,
    body: 'Hi, can you come every week?',
    occurredAt: new Date().toISOString(),
    reminderAfterMs: 86_400_000,
  });
  await run(
    conversationHandToAi,
    { workspaceId: biz.wsId, conversationId: output.conversationId },
    biz.owner,
  );
  return { personId, phone, conversationId: output.conversationId };
}

async function saveTeammate(biz: Biz, patch: TeammatePatch) {
  const got = await ask(aiTeammateGet, { workspaceId: biz.wsId }, biz.owner);
  return run(
    aiTeammateSaveConfig,
    {
      workspaceId: biz.wsId,
      teammateId: biz.teammateId,
      baseRevision: got.teammate!.revision,
      config: applyTeammatePatch(parseTeammateConfig(got.teammate!.config), patch),
    },
    biz.owner,
  );
}

async function eventTypes(entityId: string) {
  const list = await admin()
    .select({ type: events.eventType })
    .from(events)
    .where(eq(events.entityId, entityId));
  return list.map((e) => e.type);
}

let weekly: { id: string };
let plain: { id: string };

beforeAll(async () => {
  a = await setupBusiness('m18');
  const t = { owner: a.owner, wsId: a.wsId } as unknown as Team;
  await run(scheduleSet, { workspaceId: a.wsId, ownerId: a.owner.id, weekly: WEEKDAYS }, a.owner);
  const team = { members: [{ userId: a.owner.id }], assignment: 'round_robin' as const };
  weekly = await makeCalendar(t, 'Cleaning', {
    public: true,
    team,
    recurring: { customerSeries: true, maxOccurrences: 6 },
    waitlist: { enabled: true },
  });
  plain = await makeCalendar(t, 'Estimates', { public: true, team });
  await saveTeammate(a, { book: { enabled: true, calendarIds: [weekly.id, plain.id] } });
});
afterAll(closeTestDbs);

describe('repeat visits for the customer in the conversation', () => {
  const day = nextWeekday(3);

  it('need the teammate’s repeats switch and a calendar that lets customers repeat', async () => {
    const bo = await aiChat(a, 'Bo');
    const me = { conversationId: bo.conversationId };
    const book = (calendarId: string) =>
      asAva(a, me, seriesBookForCustomer, {
        workspaceId: a.wsId,
        calendarId,
        startsAt: isoAt(day, '09:00'),
        every: 'week',
        times: 3,
        clientId: randomUUID(),
      });
    await expectHfos(() => book(weekly.id), 'rule_violation', 'repeats_off');
    await saveTeammate(a, { book: { repeats: true } });
    await expectHfos(() => book(plain.id), 'rule_violation', 'series_off');
  });

  it('books every visit that fits, skips the rest, and does it once per clientId', async () => {
    await saveTeammate(a, { book: { repeats: true } });
    const cy = await aiChat(a, 'Cy');
    const dee = await aiChat(a, 'Dee');
    // Someone already has the third week's 10:00.
    const third = isoAt(addDays(day, 14), '10:00');
    await asAva(a, { conversationId: dee.conversationId }, appointmentBookForCustomer, {
      workspaceId: a.wsId,
      calendarId: weekly.id,
      startsAt: third,
      clientId: randomUUID(),
    });
    const clientId = randomUUID();
    const book = () =>
      asAva(a, { conversationId: cy.conversationId }, seriesBookForCustomer, {
        workspaceId: a.wsId,
        calendarId: weekly.id,
        startsAt: isoAt(day, '10:00'),
        every: 'week',
        // More than the calendar allows: it stops at its own limit of six.
        times: 10,
        notes: 'Every week, please',
        clientId,
      });
    const { output } = await book();
    expect(output.duplicate).toBe(false);
    expect(output.appointmentIds).toHaveLength(5);
    expect(output.skipped).toHaveLength(1);
    expect(output.skipped[0]!.startsAt).toBe(third);
    const booked = await admin()
      .select({ seriesId: appointments.seriesId, source: appointments.source })
      .from(appointments)
      .where(eq(appointments.seriesId, output.seriesId));
    expect(booked).toHaveLength(5);
    expect(new Set(booked.map((b) => b.source))).toEqual(new Set(['ai_teammate']));
    // The customer hears about the first visit; the series arms reminders for all of them.
    expect(await eventTypes(output.appointmentIds[0]!)).toContain('appointment.booked');
    expect(await eventTypes(output.seriesId)).toContain('series.created');
    const again = await book();
    expect(again.output).toMatchObject({ seriesId: output.seriesId, duplicate: true });
    expect(again.output.appointmentIds).toHaveLength(5);
  });

  it('won’t start from a time the calendar doesn’t offer', async () => {
    await saveTeammate(a, { book: { repeats: true } });
    const ed = await aiChat(a, 'Ed');
    await expectHfos(
      () =>
        asAva(a, { conversationId: ed.conversationId }, seriesBookForCustomer, {
          workspaceId: a.wsId,
          calendarId: weekly.id,
          startsAt: isoAt(day, '03:00'),
          every: 'week',
          times: 2,
          clientId: randomUUID(),
        }),
      'conflict',
      'slot_taken',
    );
  });
});

describe('waitlist places for the customer in the conversation', () => {
  const day = nextWeekday(4);

  it('go on calendars that keep a waitlist, once for overlapping times', async () => {
    const fay = await aiChat(a, 'Fay');
    const me = { conversationId: fay.conversationId };
    const join = (calendarId: string, from = '08:00', to = '12:00') =>
      asAva(a, me, waitlistJoinForCustomer, {
        workspaceId: a.wsId,
        calendarId,
        wantedFrom: isoAt(day, from),
        wantedTo: isoAt(day, to),
      });
    await expectHfos(() => join(plain.id), 'rule_violation', 'waitlist_off');
    const first = await join(weekly.id);
    expect(first.output.alreadyWaiting).toBe(false);
    const [entry] = await admin()
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.id, first.output.entryId));
    expect(entry).toMatchObject({
      personId: fay.personId,
      source: 'ai_teammate',
      status: 'waiting',
      contactPhoneE164: fay.phone,
      // They're texting us, so the spot's offer may go by text.
      smsOk: true,
    });
    const again = await join(weekly.id, '10:00', '14:00');
    expect(again.output).toMatchObject({ entryId: first.output.entryId, alreadyWaiting: true });
    const later = await join(weekly.id, '13:00', '16:00');
    expect(later.output.alreadyWaiting).toBe(false);
  });

  it('won’t wait for times that have passed, in the booking page’s words', async () => {
    const ida = await aiChat(a, 'Ida');
    const passed = () =>
      asAva(a, { conversationId: ida.conversationId }, waitlistJoinForCustomer, {
        workspaceId: a.wsId,
        calendarId: weekly.id,
        wantedFrom: new Date(Date.now() - 3 * 3600_000).toISOString(),
        wantedTo: new Date(Date.now() - 3600_000).toISOString(),
      });
    await expect(passed()).rejects.toThrow('Pick times that haven’t passed.');
  });

  it('are off when the teammate’s settings say so', async () => {
    await saveTeammate(a, { book: { waitlist: false } });
    const gus = await aiChat(a, 'Gus');
    await expectHfos(
      () =>
        asAva(a, { conversationId: gus.conversationId }, waitlistJoinForCustomer, {
          workspaceId: a.wsId,
          calendarId: weekly.id,
          wantedFrom: isoAt(day, '08:00'),
          wantedTo: isoAt(day, '12:00'),
        }),
      'rule_violation',
      'waitlist_not_allowed',
    );
    await saveTeammate(a, { book: { waitlist: true } });
  });
});

describe('a draft holding repeat visits and a waitlist place', () => {
  it('carries both out, once, when a person approves it', async () => {
    await saveTeammate(a, { book: { repeats: true, waitlist: true } });
    const hal = await aiChat(a, 'Hal');
    const day = nextWeekday(1);
    const preview = {
      message: {
        channel: 'sms',
        body: 'You’re set for Mondays at 1, and on the waitlist for mornings.',
      },
      actions: [
        {
          kind: 'book_series',
          calendarId: weekly.id,
          startsAt: isoAt(day, '13:00'),
          every: 'week',
          times: 2,
          summary: 'Book 2 weekly visits on Cleaning',
        },
        {
          kind: 'waitlist',
          calendarId: weekly.id,
          wantedFrom: isoAt(day, '08:00'),
          wantedTo: isoAt(day, '11:00'),
          summary: 'Add them to the Cleaning waitlist',
        },
      ],
    };
    const [d] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.ai_teammate_drafts (workspace_id, teammate_id, conversation_id, person_id, kind, preview, client_id, expires_at)
          values (${a.wsId}, ${a.teammateId}, ${hal.conversationId}, ${hal.personId}, 'reply',
            ${JSON.stringify(preview)}::jsonb, ${`ai:${randomUUID()}`}, now() + interval '2 hours')
          returning id`,
    );
    await run(
      aiTeammateDecideDraft,
      { workspaceId: a.wsId, draftId: d!.id, decision: 'approve' },
      a.owner,
    );
    const sent = await sys(a, aiTeammateSendDraft, { workspaceId: a.wsId, draftId: d!.id });
    expect(sent.output.actions.map((x) => x.kind)).toEqual(['book_series', 'waitlist']);
    expect(sent.output.actions[0]!.appointmentId).not.toBeNull();
    expect(sent.output.actions[1]!.appointmentId).toBeNull();
    const again = await sys(a, aiTeammateSendDraft, { workspaceId: a.wsId, draftId: d!.id });
    expect(again.output.duplicate).toBe(true);
    const places = await admin()
      .select({ id: waitlistEntries.id })
      .from(waitlistEntries)
      .where(
        and(eq(waitlistEntries.personId, hal.personId), eq(waitlistEntries.status, 'waiting')),
      );
    expect(places).toHaveLength(1);
  });
});

describe('the calendar settings it follows', () => {
  it('stops repeats as soon as the calendar stops letting customers repeat', async () => {
    await saveTeammate(a, { book: { repeats: true } });
    const t = { owner: a.owner, wsId: a.wsId } as unknown as Team;
    await saveCalendar(t, weekly.id, { recurring: { customerSeries: false } });
    const ivy = await aiChat(a, 'Ivy');
    await expectHfos(
      () =>
        asAva(a, { conversationId: ivy.conversationId }, seriesBookForCustomer, {
          workspaceId: a.wsId,
          calendarId: weekly.id,
          startsAt: isoAt(nextWeekday(2), '11:00'),
          every: 'month',
          times: 2,
          clientId: randomUUID(),
        }),
      'rule_violation',
      'series_off',
    );
    await saveCalendar(t, weekly.id, { recurring: { customerSeries: true } });
  });
});

describe('deals, when the teammate’s settings let it handle them', () => {
  it('sets what its customer’s lead is worth and marks it won or lost, and only then', async () => {
    const jo = await aiChat(a, 'Jo');
    const me = { conversationId: jo.conversationId };
    const { leadId } = (
      await asAva(a, me, leadCreate, {
        workspaceId: a.wsId,
        title: 'New furnace',
        personId: jo.personId,
      })
    ).output;
    const worth = () =>
      asAva(a, me, leadUpdate, { workspaceId: a.wsId, leadId, valueCents: 480_000 });
    const [won, lost] = await Promise.all(
      (['won', 'lost'] as const).map(async (kind) => {
        const [s] = await rows<{ id: string }>(
          admin(),
          sql`select s.id from app.pipeline_stages s join app.leads l on l.pipeline_id = s.pipeline_id
              where l.id = ${leadId} and s.kind = ${kind} order by s.position limit 1`,
        );
        return s!.id;
      }),
    );
    const close = (stageId: string, lostReason?: string) =>
      asAva(a, me, leadMoveStage, {
        workspaceId: a.wsId,
        leadId,
        stageId,
        ...(lostReason ? { lostReason } : {}),
      });
    // Off: only the next action, and open stages.
    await expectHfos(worth, 'validation');
    await expectHfos(() => close(won!), 'rule_violation', 'stage_not_open');
    await saveTeammate(a, { deals: { enabled: true } });
    await worth();
    await close(lost!, 'Went with another company');
    const [row] = await admin()
      .select({ status: leads.status, value: leads.valueCents, reason: leads.lostReason })
      .from(leads)
      .where(eq(leads.id, leadId));
    expect(row).toMatchObject({ status: 'lost', reason: 'Went with another company' });
    expect(Number(row!.value)).toBe(480_000);
    // Reopening a closed lead stays a person's call.
    const [open] = await rows<{ id: string }>(
      admin(),
      sql`select s.id from app.pipeline_stages s join app.leads l on l.pipeline_id = s.pipeline_id
          where l.id = ${leadId} and s.kind = 'open' order by s.position limit 1`,
    );
    await expectHfos(() => close(open!.id), 'rule_violation', 'stage_not_open');
    await saveTeammate(a, { deals: { enabled: false } });
  });
});

describe('money, only with an owner’s or admin’s OK', () => {
  let tuneUp: string;
  let filter: string;
  let planId: string;
  let marco: TestUser;

  beforeAll(async () => {
    tuneUp = (
      await run(
        productCreate,
        { workspaceId: a.wsId, name: 'AC tune-up', unitPriceCents: 12_900, taxable: false },
        a.owner,
      )
    ).productId;
    filter = (
      await run(
        productCreate,
        { workspaceId: a.wsId, name: 'Filter', unitPriceCents: 2_500, taxable: false },
        a.owner,
      )
    ).productId;
    planId = (
      await run(
        planCreate,
        {
          workspaceId: a.wsId,
          name: 'Comfort Club',
          priceCents: 1_900,
          includes: ['Two tune-ups'],
        },
        a.owner,
      )
    ).planId;
    marco = await createTestUser('m18-marco', { fullName: 'Marco Member' });
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${a.wsId}, ${marco.id}, 'member')`,
    );
  });

  it('bills from the price list, at its prices, only once an owner approved and the settings allow', async () => {
    const kay = await aiChat(a, 'Kay');
    const bill = (approvedBy: string | null) =>
      asAva(a, { conversationId: kay.conversationId, approvedBy }, invoiceCreateForCustomer, {
        workspaceId: a.wsId,
        title: 'Tune-up',
        lines: [
          { productId: tuneUp, quantity: 1 },
          { productId: filter, quantity: 2 },
        ],
      });
    await expectHfos(() => bill(null), 'forbidden', 'money_needs_approval');
    // Someone who doesn't manage money can't be the OK.
    await expectHfos(() => bill(marco.id), 'forbidden', 'money_needs_approval');
    await expectHfos(() => bill(a.owner.id), 'rule_violation', 'money_not_allowed');
    await saveTeammate(a, { money: { newBills: true } });
    const { output } = await bill(a.owner.id);
    expect(output).toMatchObject({ status: 'sent', totalCents: 17_900 });
    const [row] = await rows<{ origin: string; created_by: string; person_id: string }>(
      admin(),
      sql`select origin::text as origin, created_by, person_id from app.invoices where id = ${output.invoiceId}`,
    );
    expect(row).toEqual({ origin: 'ai_teammate', created_by: a.owner.id, person_id: kay.personId });
    // A product that isn't on the price list is refused, whatever the model says.
    await expectHfos(
      () =>
        asAva(
          a,
          { conversationId: kay.conversationId, approvedBy: a.owner.id },
          invoiceCreateForCustomer,
          {
            workspaceId: a.wsId,
            lines: [{ productId: randomUUID(), quantity: 1 }],
          },
        ),
      'validation',
    );
    await saveTeammate(a, { money: { newBills: false } });
  });

  it('quotes from the price list only in build mode, and records the answer in the approver’s name', async () => {
    const lee = await aiChat(a, 'Lee');
    const me = { conversationId: lee.conversationId, approvedBy: a.owner.id };
    const quote = () =>
      asAva(a, me, estimateCreateForCustomer, {
        workspaceId: a.wsId,
        lines: [{ productId: tuneUp, quantity: 1 }],
      });
    await saveTeammate(a, { money: { quotes: 'send_only' } });
    await expectHfos(quote, 'rule_violation', 'money_not_allowed');
    await saveTeammate(a, { money: { quotes: 'build' } });
    const sent = (await quote()).output;
    expect(sent).toMatchObject({ status: 'sent', totalCents: 12_900 });
    await asAva(a, me, estimateAnswerForCustomer, {
      workspaceId: a.wsId,
      estimateId: sent.estimateId,
      accepted: true,
      name: 'Lee Test',
    });
    const [yes] = await rows<{ status: string; accepted_via: string; accepted_by: string }>(
      admin(),
      sql`select status::text as status, accepted_via, accepted_by from app.estimates where id = ${sent.estimateId}`,
    );
    expect(yes).toEqual({ status: 'accepted', accepted_via: 'staff', accepted_by: a.owner.id });
    const second = (await quote()).output;
    await asAva(a, me, estimateAnswerForCustomer, {
      workspaceId: a.wsId,
      estimateId: second.estimateId,
      accepted: false,
      name: 'Lee Test',
      reason: 'Too much right now',
    });
    const [no] = await rows<{ status: string; declined_reason: string }>(
      admin(),
      sql`select status::text as status, declined_reason from app.estimates where id = ${second.estimateId}`,
    );
    expect(no).toEqual({ status: 'declined', declined_reason: 'Too much right now' });
    // Another customer's quote is never this conversation's to answer.
    const mo = await aiChat(a, 'Mo');
    await expectHfos(
      () =>
        asAva(
          a,
          { conversationId: mo.conversationId, approvedBy: a.owner.id },
          estimateAnswerForCustomer,
          {
            workspaceId: a.wsId,
            estimateId: second.estimateId,
            accepted: true,
            name: 'Mo',
          },
        ),
      'forbidden',
      'not_this_customer',
    );
    await saveTeammate(a, { money: { quotes: 'off' } });
  });

  it('signs the customer up for a plan, waiting on the card they’re sent a link for', async () => {
    await saveTeammate(a, { money: { plans: true } });
    const ned = await aiChat(a, 'Ned');
    const { output } = await asAva(
      a,
      { conversationId: ned.conversationId, approvedBy: a.owner.id },
      subscriptionStartForCustomer,
      { workspaceId: a.wsId, planId },
    );
    const [sub] = await rows<{ plan_name: string; price_cents: string; created_by: string }>(
      admin(),
      sql`select plan_name, price_cents::text as price_cents, created_by from app.subscriptions
          where id = ${output.subscriptionId}`,
    );
    expect(sub).toEqual({ plan_name: 'Comfort Club', price_cents: '1900', created_by: a.owner.id });
    expect(await eventTypes(output.subscriptionId)).toEqual(
      expect.arrayContaining(['subscription.started', 'subscription.card_requested']),
    );
    await saveTeammate(a, { money: { plans: false } });
  });

  it('goes out from an approval draft only an owner or admin may decide', async () => {
    await saveTeammate(a, { money: { newBills: true } });
    const ola = await aiChat(a, 'Ola');
    const preview = {
      message: { channel: 'sms', body: 'Here’s your bill for the tune-up.' },
      actions: [
        {
          kind: 'create_invoice',
          title: 'Tune-up',
          lines: [{ productId: tuneUp, quantity: 1 }],
          summary: 'Bill them $129.00 for AC tune-up',
        },
      ],
    };
    const [d] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.ai_teammate_drafts (workspace_id, teammate_id, conversation_id, person_id, kind, preview, client_id, expires_at)
          values (${a.wsId}, ${a.teammateId}, ${ola.conversationId}, ${ola.personId}, 'approval',
            ${JSON.stringify(preview)}::jsonb, ${`ai:${randomUUID()}:m`}, now() + interval '2 hours')
          returning id`,
    );
    await expectHfos(
      () =>
        run(
          aiTeammateDecideDraft,
          { workspaceId: a.wsId, draftId: d!.id, decision: 'approve' },
          marco,
        ),
      'forbidden',
      'not_an_approver',
    );
    await run(
      aiTeammateDecideDraft,
      { workspaceId: a.wsId, draftId: d!.id, decision: 'approve' },
      a.owner,
    );
    const sent = await sys(a, aiTeammateSendDraft, { workspaceId: a.wsId, draftId: d!.id });
    expect(sent.output.actions).toEqual([{ kind: 'create_invoice', appointmentId: null }]);
    expect(sent.output.messageId).not.toBeNull();
    const bills = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.invoices where person_id = ${ola.personId}`,
    );
    expect(bills).toEqual([{ status: 'sent' }]);
    await saveTeammate(a, { money: { newBills: false } });
  });
});
