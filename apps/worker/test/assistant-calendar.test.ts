import { randomUUID } from 'node:crypto';
import { emptyUsage, type AiProvider, type AiRequest } from '@hfos/ai';
import {
  addDays,
  appointmentCreate,
  appointmentSetStatus,
  applyPatch,
  assistantToolByName,
  attendeeConfirm,
  calendarAvailability,
  calendarCreate,
  calendarGet,
  calendarSave,
  calendarSetStatus,
  createTokenVerifier,
  executeCommand,
  executeQuery,
  localDateOf,
  localInstant,
  organizationCreate,
  personCreate,
  resourceCreate,
  ROLE_PERMISSIONS,
  scheduleSet,
  serviceCreate,
  startOfLocalDay,
  taskCreate,
  type AssistantCard,
  type AssistantEvent,
  type CalendarConfig,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentToAssistant } from './assistant-consent';
import { atLabel, rangeLabel } from '../src/assistant/calendar-format';
import { questionContext, toolsFor } from '../src/assistant/context';
import { ask as runQuestion } from '../src/assistant/runtime';
import { scriptedAssistant } from '../src/assistant/scripted';
import { calendarConfirmTools, calendarReadTools } from '../src/assistant/tools-calendar';
import { screenActionToolByName } from '../src/assistant/tools-screen-actions';
import { createToolExecutor } from '../src/assistant/tools-write';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

/**
 * The Assistant on the calendar, against the scripted stand-in model: open times from real availability,
 * booking, moving and cancelling as cards that change nothing until Confirm (and then run as the person,
 * marked "via Assistant"), Cancel and a card that lapses, and nobody offered tools their role lacks.
 */

const CHI = 'America/Chicago';
const HOUR = 3_600_000;
const env = testEnv();
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const iso = (ms: number) => new Date(ms).toISOString();
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => (await executeCommand(api(), cmd, input, actor(u), meta())).output;

const tomorrow = () => addDays(localDateOf(Date.now(), CHI), 1);
const tomorrowAt = (hour: number) =>
  localInstant(tomorrow(), `${String(hour).padStart(2, '0')}:00`, CHI);

let owner: TestUser;
let member: TestUser;
let priya: TestUser;
let ownerToken: string;
let workspaceId: string;
let organizationId: string;
let calendarId: string;
let serviceId: string;
let mikeId: string;
let app: FastifyInstance;

/** Asks one question and returns the server-sent events it streamed. */
async function ask(
  token: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<AssistantEvent[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId, text, ...extra },
  });
  expect(res.statusCode).toBe(200);
  return res.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
}
const cardsOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'card' ? [e.card] : []));
const textOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
function cardOf<T extends AssistantCard['type']>(
  events: AssistantEvent[],
  type: T,
): Extract<AssistantCard, { type: T }> {
  const card = cardsOf(events).find((c) => c.type === type);
  if (!card) throw new Error(`No ${type} card. The answer: ${textOf(events)}`);
  return card as Extract<AssistantCard, { type: T }>;
}
const decide = (id: string, action: 'confirm' | 'cancel') =>
  app.inject({
    method: 'POST',
    url: `/v1/assistant/tool-calls/${id}/${action}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { workspaceId },
  });
const toolCallStatus = async (id: string) =>
  (
    await rows<{ status: string }>(
      admin(),
      sql`select status from app.assistant_tool_calls where id = ${id}`,
    )
  )[0]!.status;
const appointments = () =>
  rows<{
    id: string;
    source: string;
    client_id: string | null;
    created_by: string;
    starts_at: Date;
    status: string;
  }>(
    admin(),
    sql`select id, source::text as source, client_id, created_by, starts_at, status::text as status
        from app.appointments where workspace_id = ${workspaceId} order by created_at`,
  );
const audits = (action: string) =>
  rows<{ actor_id: string; channel: string }>(
    admin(),
    sql`select actor_id, channel from app.audit_logs where workspace_id = ${workspaceId} and action = ${action}
        order by created_at`,
  );

beforeAll(async () => {
  [owner, member, priya] = await Promise.all([
    createTestUser('acal-dale', { fullName: 'Dale Owner' }),
    createTestUser('acal-marco', { fullName: 'Marco Member' }),
    createTestUser('acal-priya', { fullName: 'Priya Natarajan' }),
  ]);
  await consentToAssistant(owner, member, priya);
  const org = await run(
    organizationCreate,
    { businessName: 'Calendar Assistant HVAC', timezone: CHI },
    owner,
  );
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  for (const u of [member, priya])
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${u.id}, 'member')`,
    );
  // Priya works 8 to 5 every day, so "tomorrow" always has hours.
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '08:00', end: '17:00' }));
  await run(scheduleSet, { workspaceId, ownerId: priya.id, weekly: everyDay }, owner);
  serviceId = (
    await run(serviceCreate, { workspaceId, name: 'AC tune-up', durations: [60] }, owner)
  ).serviceId;
  calendarId = (
    await run(calendarCreate, { workspaceId, name: 'Tune-ups', preset: 'scratch' }, owner)
  ).calendarId;
  const { calendar } = await executeQuery(
    api(),
    calendarGet,
    { workspaceId, calendarId },
    actor(owner),
    meta(),
  );
  const draft = applyPatch(calendar.config as CalendarConfig, {
    team: { members: [{ userId: priya.id }], assignment: 'round_robin' },
    services: { mode: 'one', items: [{ serviceId }] },
    locations: { options: [{ kind: 'customer_address' }] },
    window: { minNoticeMinutes: 0 },
  });
  await run(
    calendarSave,
    { workspaceId, calendarId, baseRevision: calendar.revision, draft },
    owner,
  );
  await run(calendarSetStatus, { workspaceId, calendarId, status: 'active' }, owner);
  mikeId = (
    await run(
      personCreate,
      {
        workspaceId,
        firstName: 'Mike',
        lastName: 'Johnson',
        phone: '(713) 555-0142',
        email: 'mike.johnson@example.com',
        address: { line1: '123 Main St', city: 'Houston', state: 'TX', postalCode: '77002' },
      },
      owner,
    )
  ).personId;
  ownerToken = await signInTestUser(owner);
  const s = testServices();
  const httpDb = testDbs().worker.db;
  app = await buildHttpServer({
    ...s,
    httpDb,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    assistant: {
      provider: scriptedAssistant(),
      tools: createToolExecutor(httpDb),
    },
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('the Assistant on the calendar', () => {
  it('shows the open times the calendar really has', async () => {
    const events = await ask(ownerToken, 'When is Priya free tomorrow?');
    const card = cardOf(events, 'slots');
    const day = tomorrow();
    const open = await executeQuery(
      api(),
      calendarAvailability,
      {
        workspaceId,
        calendarId,
        from: iso(startOfLocalDay(day, CHI)),
        to: iso(startOfLocalDay(addDays(day, 1), CHI)),
      },
      actor(owner),
      meta(),
    );
    const starts = open.slots.map((s) => s.startsAt);
    // 8:00 AM to 4:00 PM every half hour; the card spreads eight of them over the day.
    expect(starts.length).toBeGreaterThan(8);
    expect(card).toMatchObject({
      title: 'Priya Natarajan',
      zone: 'Central Time',
      timezone: CHI,
      calendar: { id: calendarId, name: 'Tune-ups' },
      service: { id: serviceId, name: 'AC tune-up' },
      person: { userId: priya.id, fullName: 'Priya Natarajan' },
      durationMinutes: 60,
      href: `/app/w/${workspaceId}/calendar?view=week&date=${day}&people=${priya.id}`,
    });
    expect(card.days.map((d) => d.date)).toEqual([day]);
    const times = card.days[0]!.times;
    expect(times).toHaveLength(8);
    expect(times[0]).toEqual({ startsAt: starts[0], label: '8:00 AM' });
    expect(times.at(-1)!.startsAt).toBe(starts.at(-1));
    for (const t of times) expect(starts).toContain(t.startsAt);
    expect(textOf(events)).toContain(`Priya has ${starts.length} open times for a 1 hour visit`);
  });

  it('books only after Confirm: as the person, through the Assistant, once', async () => {
    const page = { type: 'person', id: mikeId };
    const events = await ask(ownerToken, 'Book him for a tune-up tomorrow at 10 am', { page });
    expect(textOf(events)).toBe(
      'Here’s the booking for Mike Johnson. Nothing is booked until you OK it.',
    );
    const card = cardOf(events, 'confirm');
    const start = tomorrowAt(10);
    expect(card).toMatchObject({
      tool: 'book_appointment',
      personId: mikeId,
      title: 'Book this appointment?',
      fields: [
        { label: 'Customer', value: 'Mike Johnson · (713) 555-0142' },
        { label: 'What', value: 'AC tune-up · 1 hour' },
        { label: 'When', value: `${rangeLabel(start, start + HOUR, CHI)} Central Time` },
        { label: 'With', value: 'Priya Natarajan, next in turn' },
        { label: 'Where', value: '123 Main St, Houston, TX 77002' },
        // No business number yet, so reminders can only go by email.
        { label: 'Reminders', value: 'By email, since texting isn’t set up yet' },
        { label: 'Tell Mike', value: 'An email with the details' },
      ],
      warnings: [],
      confirmLabel: 'Book',
      editable: false,
    });
    // The card came from a dry run: nothing was booked, announced or audited.
    expect(await appointments()).toHaveLength(0);
    expect(await audits('appointment.create')).toHaveLength(0);

    const ok = await decide(card.toolCallId, 'confirm');
    expect(ok.json()).toMatchObject({
      status: 'confirmed',
      outcome: `Booked for ${atLabel(start, CHI)}.`,
      href: expect.stringMatching(
        new RegExp(`^/app/w/${workspaceId}/calendar\\?date=${tomorrow()}&appt=[0-9a-f-]{36}$`),
      ),
    });
    const [booked] = await appointments();
    expect(booked).toMatchObject({
      source: 'assistant',
      client_id: `assistant-${card.toolCallId}`,
      created_by: owner.id,
      status: 'scheduled',
    });
    expect(new Date(booked!.starts_at).getTime()).toBe(start);
    const attendees = await rows<{ person_id: string }>(
      admin(),
      sql`select person_id from app.appointment_attendees where appointment_id = ${booked!.id}`,
    );
    expect(attendees).toEqual([{ person_id: mikeId }]);
    expect(await audits('appointment.create')).toEqual([
      { actor_id: owner.id, channel: 'assistant' },
    ]);
    expect((await decide(card.toolCallId, 'confirm')).statusCode).toBe(409);
    expect(await appointments()).toHaveLength(1);
  });

  it('warns outside hours, and books nothing on Cancel or once the card lapses', async () => {
    const page = { type: 'person', id: mikeId };
    const late = cardOf(
      await ask(ownerToken, 'Book him for a tune-up tomorrow at 7 pm', { page }),
      'confirm',
    );
    expect(late.warnings).toEqual([
      { kind: 'outside_hours', text: 'Outside Priya Natarajan’s hours.' },
    ]);
    expect(late.confirmLabel).toBe('Book anyway');
    expect((await decide(late.toolCallId, 'cancel')).json()).toMatchObject({
      status: 'cancelled',
    });

    const first = await ask(ownerToken, 'Book him for a tune-up tomorrow at 2 pm', { page });
    const threadId = first[0]!.type === 'run' ? first[0]!.threadId : '';
    const lapsing = cardOf(first, 'confirm');
    await ask(ownerToken, 'What’s on my calendar?', { threadId });
    expect(await toolCallStatus(lapsing.toolCallId)).toBe('expired');
    expect((await decide(lapsing.toolCallId, 'confirm')).statusCode).toBe(409);
    // Only the 10 AM visit from before.
    expect(await appointments()).toHaveLength(1);
  });

  it('moves and then cancels his appointment, each after Confirm', async () => {
    const page = { type: 'person', id: mikeId };
    // The 10 AM visit booked above, on whatever day was tomorrow then: past midnight in Chicago, that's today.
    const was = new Date((await appointments())[0]!.starts_at).getTime();
    const events = await ask(ownerToken, 'Move his appointment to tomorrow at 1 pm', { page });
    const now = tomorrowAt(13);
    expect(textOf(events)).toBe('Here’s the change. Nothing moves until you OK it.');
    const move = cardOf(events, 'confirm');
    expect(move).toMatchObject({
      tool: 'reschedule_appointment',
      title: 'Move Mike’s AC tune-up?',
      fields: [
        { label: 'Was', value: rangeLabel(was, was + HOUR, CHI) },
        { label: 'Now', value: rangeLabel(now, now + HOUR, CHI) },
        { label: 'With', value: 'Priya Natarajan' },
        { label: 'Tell Mike', value: 'An email with the new time' },
      ],
      warnings: [],
      confirmLabel: 'Move',
    });
    expect(new Date((await appointments())[0]!.starts_at).getTime()).toBe(was);
    expect((await decide(move.toolCallId, 'confirm')).json()).toMatchObject({
      status: 'confirmed',
      outcome: `Moved to ${atLabel(now, CHI)}.`,
    });
    expect(new Date((await appointments())[0]!.starts_at).getTime()).toBe(now);
    expect(await audits('appointment.reschedule')).toEqual([
      { actor_id: owner.id, channel: 'assistant' },
    ]);

    const cancel = cardOf(await ask(ownerToken, 'Cancel his appointment', { page }), 'confirm');
    expect(cancel).toMatchObject({
      tool: 'cancel_appointment',
      title: 'Cancel Mike’s AC tune-up?',
      fields: [
        { label: 'When', value: rangeLabel(now, now + HOUR, CHI) },
        { label: 'With', value: 'Priya Natarajan' },
        { label: 'Tell Mike', value: 'An email that it’s cancelled' },
      ],
      confirmLabel: 'Cancel appointment',
    });
    expect((await appointments())[0]!.status).toBe('scheduled');
    expect((await decide(cancel.toolCallId, 'confirm')).json()).toMatchObject({
      status: 'confirmed',
      outcome: 'Cancelled. Priya has the time back.',
    });
    expect((await appointments())[0]!.status).toBe('cancelled');
    expect(await audits('appointment.cancel')).toEqual([
      { actor_id: owner.id, channel: 'assistant' },
    ]);
  });

  it('lists today’s appointments before tasks, and a customer’s upcoming ones', async () => {
    // A visit going on right now (begun half an hour ago, or at midnight when that was later), and a task that is
    // already late.
    const { appointmentId } = await run(
      appointmentCreate,
      {
        workspaceId,
        calendarId,
        personId: mikeId,
        startsAt: iso(
          Math.max(Date.now() - HOUR / 2, startOfLocalDay(localDateOf(Date.now(), CHI), CHI)),
        ),
        acknowledgeWarnings: true,
      },
      owner,
    );
    await run(
      taskCreate,
      {
        workspaceId,
        title: 'Order filters',
        dueAt: iso(Date.now() - HOUR),
        assigneeUserId: owner.id,
      },
      owner,
    );
    const events = await ask(ownerToken, 'What’s on my calendar?');
    expect(textOf(events)).toBe('One appointment is still to come today. Here’s what’s due too.');
    const [today, due] = cardsOf(events);
    expect(today).toMatchObject({
      type: 'list',
      title: 'Still to come today',
      items: [
        {
          title: expect.stringMatching(/ · AC tune-up · Mike$/),
          detail: 'Priya, now',
          href: expect.stringContaining(`appt=${appointmentId}`),
        },
      ],
    });
    expect(due).toMatchObject({ type: 'list', title: 'Due today' });

    const getCustomer = assistantToolByName.get('get_customer')!;
    const out = await createToolExecutor(testDbs().worker.db).run(
      getCustomer,
      { personId: mikeId },
      {
        actor: actor(owner),
        workspaceId,
        organizationId,
        correlationId: randomUUID(),
        timezone: CHI,
      },
    );
    expect(out.result).toMatchObject({ upcomingAppointments: [{ id: appointmentId }] });
    expect(out.cards).toEqual([
      expect.objectContaining({
        type: 'appointment',
        appointmentId,
        what: 'AC tune-up',
        customer: 'Mike Johnson',
        with: 'Priya Natarajan',
        status: 'scheduled',
      }),
    ]);
  });

  it('says, as Home’s Today card does, whether each customer confirmed, and how many tomorrow are confirmed so far', async () => {
    const tools = createToolExecutor(testDbs().worker.db);
    const today = async () =>
      (
        await tools.run(
          assistantToolByName.get('todays_schedule')!,
          {},
          {
            actor: actor(owner),
            workspaceId,
            organizationId,
            correlationId: randomUUID(),
            timezone: CHI,
          },
        )
      ).result as {
        stillToCome: Record<string, unknown>[];
        tomorrow: { appointments: number; confirmedSoFar: number; yours: number };
        tasksDueToday: Record<string, unknown>[];
      };
    const before = await today();
    // Mike's visit now hasn't been confirmed, so it says so; the task due comes with its id, for complete_task.
    expect(before.stillToCome).toContainEqual(
      expect.objectContaining({ customers: ['Mike Johnson'], confirmed: false }),
    );
    expect(before.tasksDueToday).toContainEqual(
      expect.objectContaining({ id: expect.any(String), title: 'Order filters' }),
    );

    // Two more tomorrow, and Mike confirms one of them.
    const first = await run(
      appointmentCreate,
      {
        workspaceId,
        calendarId,
        personId: mikeId,
        startsAt: iso(tomorrowAt(15)),
        acknowledgeWarnings: true,
      },
      owner,
    );
    await run(
      appointmentCreate,
      {
        workspaceId,
        calendarId,
        personId: mikeId,
        startsAt: iso(tomorrowAt(16)),
        acknowledgeWarnings: true,
      },
      owner,
    );
    const [seat] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.appointment_attendees where appointment_id = ${first.appointmentId}`,
    );
    await run(attendeeConfirm, { workspaceId, attendeeId: seat!.id }, owner);

    const after = await today();
    expect(after.tomorrow).toEqual({
      appointments: before.tomorrow.appointments + 2,
      confirmedSoFar: before.tomorrow.confirmedSoFar + 1,
      // Priya works them, not Dale.
      yours: before.tomorrow.yours,
    });
  });

  it('never offers booking, moving or cancelling to someone without appointments.write', async () => {
    const lacking = toolsFor(
      (p) =>
        (ROLE_PERMISSIONS.member as readonly string[]).includes(p) && p !== 'appointments.write',
    );
    const writes = ['book_appointment', 'reschedule_appointment', 'cancel_appointment'];
    const offered: string[][] = [];
    const scripted = scriptedAssistant();
    const provider: AiProvider = {
      id: scripted.id,
      model: scripted.model,
      stream: (request, options) => {
        offered.push((request.tools ?? []).map((t) => t.name));
        return scripted.stream(request, options);
      },
    };
    const db = testDbs().worker.db;
    const page = { type: 'person' as const, id: mikeId };
    const context = await questionContext(db, actor(member), workspaceId, page, randomUUID());
    // Members book today; the tools follow the permission, not the role.
    expect(context.tools.map((t) => t.name)).toEqual(expect.arrayContaining(writes));
    const events: AssistantEvent[] = [];
    await runQuestion(
      {
        db,
        provider,
        tools: createToolExecutor(db),
        log: pino({ level: 'silent' }),
        wallet: { db, log: pino({ level: 'silent' }), mode: 'off' },
      },
      {
        actor: actor(member),
        workspaceId,
        organizationId,
        text: 'Book him for a tune-up tomorrow at 3 pm',
        page,
        tools: lacking,
        prompt: context.prompt,
      },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(offered.length).toBeGreaterThan(0);
    for (const names of offered) {
      expect(names).toContain('find_availability');
      for (const w of writes) expect(names).not.toContain(w);
    }
    // The stand-in model asks for it anyway: there is no card, no tool call and no booking.
    expect(cardsOf(events)).toEqual([]);
    expect(textOf(events)).toMatch(/^That can’t be booked/);
    expect(
      await rows(
        admin(),
        sql`select id from app.assistant_tool_calls where user_id = ${member.id} and tool = 'book_appointment'`,
      ),
    ).toHaveLength(0);
    expect(
      (await appointments()).filter((a) => a.status === 'scheduled' && a.source === 'assistant'),
    ).toHaveLength(0);
  });

  it('with tool search, keeps the tools its instructions name loaded and lets it find the rest', async () => {
    const db = testDbs().worker.db;
    const page = { type: 'person' as const, id: mikeId };
    const context = await questionContext(db, actor(member), workspaceId, page, randomUUID());
    const sent: AiRequest[] = [];
    const ask = async (toolSearch: boolean) => {
      const provider: AiProvider = {
        id: 'searches',
        model: 'claude-opus-5-5',
        ...(toolSearch ? { toolSearch } : {}),
        stream: async (request) => {
          sent.push(request);
          return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', usage: emptyUsage };
        },
      };
      await runQuestion(
        {
          db,
          provider,
          tools: createToolExecutor(db),
          log: pino({ level: 'silent' }),
          wallet: { db, log: pino({ level: 'silent' }), mode: 'off' },
        },
        {
          actor: actor(member),
          workspaceId,
          organizationId,
          text: 'What’s on today?',
          page,
          tools: context.tools,
          prompt: context.prompt,
        },
        () => undefined,
        new AbortController().signal,
      );
      return sent.at(-1)!;
    };

    const searching = await ask(true);
    const loaded = searching.tools!.filter((t) => !t.deferred).map((t) => t.name);
    // What the instructions tell it to call, and the everyday look-ups.
    expect(loaded).toEqual(
      expect.arrayContaining([
        'find_availability',
        'book_appointment',
        'search_customers',
        'get_settings',
      ]),
    );
    expect(loaded.length).toBeLessThanOrEqual(30);
    expect(searching.tools!.length).toBeGreaterThan(loaded.length + 50);
    expect(searching.system).toContain('search for the tool in plain words');

    const plain = await ask(false);
    expect(plain.tools!.some((t) => t.deferred)).toBe(false);
    expect(plain.system).not.toContain('search for the tool');
  });

  it('still answers in words when the model declines or runs out of room', async () => {
    const db = testDbs().worker.db;
    const page = { type: 'person' as const, id: mikeId };
    const context = await questionContext(db, actor(member), workspaceId, page, randomUUID());
    for (const [stopReason, said] of [
      ['refusal', 'I can’t help with that one.'],
      ['max_tokens', 'That answer ran too long. Ask again with a smaller piece of it.'],
    ] as const) {
      const provider: AiProvider = {
        id: 'declines',
        model: 'claude-opus-5-5',
        stream: async () => ({ text: '', toolCalls: [], stopReason, usage: emptyUsage }),
      };
      const events: AssistantEvent[] = [];
      await runQuestion(
        {
          db,
          provider,
          tools: createToolExecutor(db),
          log: pino({ level: 'silent' }),
          wallet: { db, log: pino({ level: 'silent' }), mode: 'off' },
        },
        {
          actor: actor(member),
          workspaceId,
          organizationId,
          text: 'Book him for a tune-up tomorrow at 3 pm',
          page,
          tools: context.tools,
          prompt: context.prompt,
        },
        (e) => events.push(e),
        new AbortController().signal,
      );
      expect(textOf(events)).toBe(said);
      expect(events.at(-1)!.type).toBe('done');
    }
  });

  it('offers a bed’s open times and books one with nobody on the card', async () => {
    const { resourceId } = await run(
      resourceCreate,
      { workspaceId, name: 'Red light bed', kind: 'equipment', quantity: 2 },
      owner,
    );
    const created = await run(
      calendarCreate,
      { workspaceId, name: 'Book a bed', preset: 'resource', resources: [resourceId] },
      owner,
    );
    const { calendar } = await executeQuery(
      api(),
      calendarGet,
      { workspaceId, calendarId: created.calendarId },
      actor(owner),
      meta(),
    );
    const draft = applyPatch(calendar.config as CalendarConfig, {
      durations: { minutes: [20] },
      window: { minNoticeMinutes: 0 },
      schedule: {
        hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '08:00', end: '17:00' })),
      },
    });
    await run(
      calendarSave,
      { workspaceId, calendarId: created.calendarId, baseRevision: calendar.revision, draft },
      owner,
    );
    await run(
      calendarSetStatus,
      { workspaceId, calendarId: created.calendarId, status: 'active' },
      owner,
    );
    const ctx = {
      actor: actor(owner),
      workspaceId,
      organizationId,
      correlationId: randomUUID(),
      timezone: CHI,
    };
    const db = testDbs().worker.db;

    const open = await calendarReadTools.find_availability!(db, ctx, {
      calendarId: created.calendarId,
      from: tomorrow(),
    });
    expect(open.card).toMatchObject({
      type: 'slots',
      title: 'Book a bed',
      person: null,
      calendar: { id: created.calendarId, name: 'Book a bed' },
      durationMinutes: 20,
    });
    expect(open.result).toMatchObject({ person: null });
    expect(
      await calendarReadTools.find_availability!(db, ctx, {
        calendarId: created.calendarId,
        from: tomorrow(),
        userId: priya.id,
      }),
    ).toMatchObject({
      isError: true,
      result: { error: 'The Book a bed calendar books without staff, so there’s nobody to pick.' },
    });

    // People the model names are dropped: nobody works a bed.
    const { card, result } = await calendarConfirmTools.book_appointment!.prepare(
      db,
      ctx,
      {
        calendarId: created.calendarId,
        personId: mikeId,
        startsAt: iso(tomorrowAt(10)),
        userIds: [priya.id],
      },
      randomUUID(),
    );
    const confirm = card as Extract<AssistantCard, { type: 'confirm' }>;
    expect(confirm.fields.map((f) => f.label)).toEqual([
      'Customer',
      'What',
      'When',
      'Reminders',
      'Tell Mike',
    ]);
    expect(confirm.warnings).toEqual([]);
    expect(result).toMatchObject({ with: [] });
  });
});

describe('moving and booking, as the Move dialog and New appointment do', () => {
  const MIN = 60_000;
  const ctx = () => ({
    actor: actor(owner),
    workspaceId,
    organizationId,
    correlationId: randomUUID(),
    timezone: CHI,
  });
  const db = () => testDbs().worker.db;
  /** A local time this many days ahead, in Chicago. */
  const dayAt = (n: number, clock: string) =>
    localInstant(addDays(localDateOf(Date.now(), CHI), n), clock, CHI);
  const visitAt = async (n: number, clock: string) =>
    (
      await run(
        appointmentCreate,
        {
          workspaceId,
          calendarId,
          personId: mikeId,
          startsAt: iso(dayAt(n, clock)),
          serviceId,
          acknowledgeWarnings: true,
          notify: false,
        },
        owner,
      )
    ).appointmentId;
  const timesOf = async (id: string) =>
    (
      await rows<{ starts_at: Date; ends_at: Date }>(
        admin(),
        sql`select starts_at, ends_at from app.appointments where id = ${id}`,
      )
    )[0]!;
  const asConfirm = (card: AssistantCard | null | undefined) =>
    card as Extract<AssistantCard, { type: 'confirm' }>;
  const tool = calendarConfirmTools;

  it('makes a visit longer without moving it, and can leave the customer untold', async () => {
    const id = await visitAt(5, '09:00');
    const start = dayAt(5, '09:00');
    const args = { appointmentId: id, durationMinutes: 90, tellCustomer: false };
    const { card, result } = await tool.reschedule_appointment!.prepare(
      db(),
      ctx(),
      args,
      randomUUID(),
    );
    expect(asConfirm(card)).toMatchObject({
      title: 'Move Mike’s AC tune-up?',
      fields: expect.arrayContaining([
        { label: 'Now', value: rangeLabel(start, start + 90 * MIN, CHI) },
        { label: 'Tell Mike', value: 'No' },
      ]),
    });
    expect(result).toMatchObject({ length: '90 minutes', tellCustomer: false });
    // Nothing changes before Confirm.
    expect(new Date((await timesOf(id)).ends_at).getTime()).toBe(start + 60 * MIN);
    const done = await tool.reschedule_appointment!.commit(db(), ctx(), args, {
      toolCallId: randomUUID(),
    });
    expect(done).toMatchObject({ command: 'appointment.reschedule' });
    const after = await timesOf(id);
    expect(new Date(after.starts_at).getTime()).toBe(start);
    expect(new Date(after.ends_at).getTime()).toBe(start + 90 * MIN);
  });

  it('hands a visit to someone else without moving it, as Who’s going? does', async () => {
    const id = await visitAt(5, '13:00');
    const args = { appointmentId: id, userIds: [owner.id] };
    const { card } = await tool.reschedule_appointment!.prepare(db(), ctx(), args, randomUUID());
    const confirm = asConfirm(card);
    expect(confirm.title).toBe('Change who goes to Mike’s AC tune-up?');
    expect(confirm.fields).toEqual(
      expect.arrayContaining([
        { label: 'Was with', value: 'Priya Natarajan' },
        { label: 'With', value: 'Dale Owner' },
        { label: 'Tell Mike', value: 'An email with who’s coming' },
      ]),
    );
    expect(confirm.fields.map((f) => f.label)).not.toContain('Now');
    const done = await tool.reschedule_appointment!.commit(db(), ctx(), args, {
      toolCallId: randomUUID(),
    });
    expect(done).toMatchObject({ command: 'appointment.reassign', outcome: 'Dale is going now.' });
    expect(new Date((await timesOf(id)).starts_at).getTime()).toBe(dayAt(5, '13:00'));
  });

  it('asks what changes when the model names nothing', async () => {
    const id = await visitAt(6, '09:00');
    await expect(
      tool.reschedule_appointment!.prepare(db(), ctx(), { appointmentId: id }, randomUUID()),
    ).rejects.toMatchObject({ message: expect.stringContaining('Say what changes') });
  });

  it('says a visit is running over on its own, as Still there on “How did it go?” does', async () => {
    const id = await visitAt(7, '09:00');
    const still = screenActionToolByName('do_appointment_still_going')!;
    expect(still.autonomy).toBe('auto');
    expect(still.description).toContain('Still there');
    const exec = createToolExecutor(api());
    await exec.run(still, still.input.parse({ appointmentId: id }) as never, ctx());
    // Nothing about the visit changes: the push asks again in an hour, from the event it leaves.
    expect(
      await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.events
            where event_type = 'appointment.still_going' and entity_id = ${id}`,
      ),
    ).toEqual([{ n: 1 }]);
    expect((await appointments()).find((a) => a.id === id)?.status).toBe('scheduled');

    // Once someone said how it went, there's nothing to check on, as the push's button is told.
    await run(appointmentSetStatus, { workspaceId, appointmentId: id, status: 'completed' }, owner);
    await expect(
      exec.run(still, still.input.parse({ appointmentId: id }) as never, ctx()),
    ).rejects.toMatchObject({ rule: 'appointment_not_scheduled' });
  });

  it('books a time with no customer, as New appointment allows', async () => {
    const start = dayAt(6, '14:00');
    const args = { calendarId, startsAt: iso(start), serviceId };
    const { card, result } = await tool.book_appointment!.prepare(db(), ctx(), args, randomUUID());
    const confirm = asConfirm(card);
    expect(confirm.fields[0]).toEqual({ label: 'Customer', value: 'None, just the time' });
    expect(confirm.fields.map((f) => f.label)).not.toContain('Reminders');
    expect(result).toMatchObject({ customer: null });
    await tool.book_appointment!.commit(db(), ctx(), args, { toolCallId: randomUUID() });
    const [made] = await rows<{ seats: number }>(
      admin(),
      sql`select (select count(*)::int from app.appointment_attendees t where t.appointment_id = a.id) as seats
          from app.appointments a
          where a.workspace_id = ${workspaceId} and a.starts_at = ${iso(start)}::timestamptz`,
    );
    expect(made).toEqual({ seats: 0 });
  });

  it('books at the place named, and says the time in the customer’s own zone', async () => {
    const start = dayAt(7, '10:00');
    const { card, result } = await tool.book_appointment!.prepare(
      db(),
      ctx(),
      {
        calendarId,
        personId: mikeId,
        startsAt: iso(start),
        serviceId,
        timeZone: 'America/Los_Angeles',
        location: { kind: 'customer_address', address: '500 Elm St, Houston, TX 77003' },
        notify: false,
      },
      randomUUID(),
    );
    const confirm = asConfirm(card);
    expect(confirm.fields.find((f) => f.label === 'Their time')?.value).toContain(
      rangeLabel(start, start + 60 * MIN, 'America/Los_Angeles'),
    );
    expect(confirm.fields.find((f) => f.label === 'Where')?.value).toContain('500 Elm St');
    expect(result).toMatchObject({ where: expect.stringContaining('500 Elm St') });
  });

  it('won’t book at a place the calendar doesn’t offer, and says which places it does', async () => {
    await expect(
      tool.book_appointment!.prepare(
        db(),
        ctx(),
        {
          calendarId,
          personId: mikeId,
          startsAt: iso(dayAt(7, '15:00')),
          serviceId,
          location: { kind: 'virtual' },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      rule: 'place_not_offered',
      message: expect.stringContaining('It offers visits at the customer’s address'),
    });
  });
});
