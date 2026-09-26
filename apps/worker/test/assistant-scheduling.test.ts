import { randomUUID } from 'node:crypto';
import {
  addDays,
  appointmentCreate,
  applyPatch,
  AssistantCard,
  assistantToolByName,
  calendarCreate,
  calendarGet,
  calendarSave,
  calendarSetStatus,
  executeCommand,
  executeQuery,
  localDateOf,
  localInstant,
  organizationCreate,
  personCreate,
  pipelineCreate,
  registry,
  scheduleSet,
  serviceCreate,
  sessionPublish,
  territoryCreate,
  type CalendarConfig,
  type CommandDef,
  type ConfigPatch,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import {
  schedulingAutoTools,
  schedulingConfirmTools,
  schedulingStepLabels,
} from '../src/assistant/tools-scheduling';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';

/**
 * The Assistant after a visit is booked, and on the parts of a calendar it couldn't reach before: marking a visit
 * done or a no-show, confirmed, its details, the job's status the customer is texted about, seats on a group
 * session, repeat visits, the waitlist, and a calendar's seats, rules, reminders, CRM and payments. Every change is
 * a card first — nothing moves until Confirm — and then runs the screen's own command as the person.
 */

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => (await executeCommand(api(), cmd, input, actor(u), meta())).output;
/** A command by name, for the few steps the tests take themselves. */
const byName = (name: string) => registry.command(name)! as CommandDef<z.ZodType, z.ZodType>;

/** A local day this many days from today, and a time on it, in Chicago. */
const day = (n: number) => addDays(localDateOf(Date.now(), CHI), n);
const at = (n: number, clock: string) => new Date(localInstant(day(n), clock, CHI)).toISOString();
/** The same instant as the model writes it: local time with the offset. */
const offsetAt = (n: number, clock: string) => {
  const ms = localInstant(day(n), clock, CHI);
  const local = new Date(ms).toLocaleString('sv-SE', { timeZone: CHI }).replace(' ', 'T');
  const offset = -Math.round((Date.parse(`${local}Z`) - ms) / 60_000);
  const abs = Math.abs(offset);
  return `${local}${offset > 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let serviceId: string;
let tuneUps: string;
let classes: string;
let ducts: string;
let mikeId: string;
let anaId: string;
let boId: string;
let cyId: string;

const ctx = (): ToolContext => ({
  actor: actor(owner),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});

type Confirm = Extract<AssistantCard, { type: 'confirm' }>;
/** Prepares a confirm tool the way the runtime does: the input parsed as the model's call would be. */
const prepare = async (name: string, args: Record<string, unknown>) => {
  const tool = assistantToolByName.get(name)!;
  const parsed = tool.input.parse(args) as Record<string, unknown>;
  const out = await createToolExecutor(api()).prepare(tool, parsed, ctx(), randomUUID());
  expect(AssistantCard.safeParse(out.card).success).toBe(true);
  return { card: out.card as Confirm, result: out.result as Record<string, unknown>, parsed };
};
const confirm = (name: string, parsed: Record<string, unknown>) =>
  createToolExecutor(api()).commit(assistantToolByName.get(name)!, parsed, ctx(), {
    toolCallId: randomUUID(),
  });
const read = async (name: string, args: Record<string, unknown>) => {
  const tool = assistantToolByName.get(name)!;
  const out = await createToolExecutor(api()).run(tool, tool.input.parse(args) as never, ctx());
  if (out.card) expect(AssistantCard.safeParse(out.card).success).toBe(true);
  return out as { result: Record<string, unknown>; card?: AssistantCard | null };
};
const field = (card: Confirm, label: string) => card.fields.find((f) => f.label === label)?.value;

const book = async (personId: string, startsAt: string, calendarId = tuneUps) =>
  (
    await run(
      appointmentCreate,
      {
        workspaceId,
        calendarId,
        personId,
        startsAt,
        serviceId,
        acknowledgeWarnings: true,
        notify: false,
      },
      owner,
    )
  ).appointmentId;

const appointmentRow = async (id: string) =>
  (
    await rows<{ status: string; title: string; notes: string | null; location: unknown }>(
      admin(),
      sql`select status::text as status, title, notes, location from app.appointments where id = ${id}`,
    )
  )[0]!;
const seatsOf = (id: string) =>
  rows<{ person_id: string; status: string; confirmed_via: string | null }>(
    admin(),
    sql`select person_id, status::text as status, confirmed_via from app.appointment_attendees
        where appointment_id = ${id} order by created_at`,
  );
const waitlistOf = (calendarId: string) =>
  rows<{ id: string; person_id: string; status: string; appointment_id: string | null }>(
    admin(),
    sql`select id, person_id, status::text as status, appointment_id from app.waitlist_entries
        where calendar_id = ${calendarId} order by created_at`,
  );
const calendarNow = async (calendarId: string) =>
  (await executeQuery(api(), calendarGet, { workspaceId, calendarId }, actor(owner), meta()))
    .calendar as { revision: number; config: CalendarConfig };

async function configure(calendarId: string, patch: ConfigPatch, activate = true) {
  const current = await calendarNow(calendarId);
  await run(
    calendarSave,
    {
      workspaceId,
      calendarId,
      baseRevision: current.revision,
      draft: applyPatch(current.config, patch),
      impactDecisions: {},
    },
    owner,
  );
  if (activate) await run(calendarSetStatus, { workspaceId, calendarId, status: 'active' }, owner);
}

const person = async (firstName: string, lastName: string, extra: Record<string, unknown> = {}) =>
  (await run(personCreate, { workspaceId, firstName, lastName, ...extra }, owner)).personId;

beforeAll(async () => {
  owner = await createTestUser('asch-dale', { fullName: 'Dale Owner' });
  const org = await run(
    organizationCreate,
    { businessName: `Scheduling HVAC ${randomUUID().slice(0, 6)}`, timezone: CHI },
    owner,
  );
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  // Dale works 8 to 5 every day, so any day has hours.
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, start: '08:00', end: '17:00' }));
  await run(scheduleSet, { workspaceId, ownerId: owner.id, weekly: everyDay }, owner);
  serviceId = (
    await run(serviceCreate, { workspaceId, name: 'AC tune-up', durations: [60] }, owner)
  ).serviceId;

  tuneUps = (await run(calendarCreate, { workspaceId, name: 'Tune-ups', preset: 'scratch' }, owner))
    .calendarId;
  await configure(tuneUps, {
    team: { members: [{ userId: owner.id }], assignment: 'fixed' },
    services: { mode: 'one', items: [{ serviceId }] },
    locations: { options: [{ kind: 'customer_address' }] },
    window: { minNoticeMinutes: 0 },
    waitlist: { enabled: true },
  });
  classes = (
    await run(calendarCreate, { workspaceId, name: 'HVAC class', preset: 'scratch' }, owner)
  ).calendarId;
  await configure(classes, {
    team: { members: [{ userId: owner.id }], assignment: 'fixed' },
    schedule: { mode: 'sessions' },
    capacity: { seats: 3, maxPartySize: 3 },
    window: { minNoticeMinutes: 0 },
    waitlist: { enabled: true },
  });
  // Set up but not taking bookings yet: its settings can be changed freely.
  ducts = (
    await run(
      calendarCreate,
      {
        workspaceId,
        name: 'Duct cleaning',
        teammates: [owner.id],
        services: [serviceId],
        resources: [],
      },
      owner,
    )
  ).calendarId;

  mikeId = await person('Mike', 'Johnson', {
    phone: '(713) 555-0142',
    email: 'mike.johnson@example.com',
    address: { line1: '123 Main St', city: 'Houston', state: 'TX', postalCode: '77002' },
  });
  anaId = await person('Ana', 'Lopez', { email: 'ana@example.com' });
  boId = await person('Bo', 'Nguyen', { email: 'bo@example.com' });
  cyId = await person('Cy', 'Park', { email: 'cy@example.com' });
}, 90_000);

afterAll(closeTestDbs);

describe('the scheduling tools', () => {
  it('each have an executor and a step label, and only the reads run on their own', () => {
    const names = [...Object.keys(schedulingAutoTools), ...Object.keys(schedulingConfirmTools)];
    expect(names.sort()).toEqual(
      [
        'get_appointment',
        'get_calendar_settings',
        'get_waitlist',
        'list_appointments',
        'manage_attendees',
        'manage_repeat_visits',
        'manage_waitlist',
        'update_appointment',
        'update_calendar_settings',
        'update_job_status',
      ].sort(),
    );
    for (const name of names) {
      const tool = assistantToolByName.get(name);
      expect(tool, name).toBeTruthy();
      expect(executorFor(name), name).toBeTruthy();
      expect(schedulingStepLabels[name], name).toBeTruthy();
      expect(tool!.autonomy, name).toBe(name in schedulingAutoTools ? 'auto' : 'confirm');
    }
    expect(assistantToolByName.get('update_calendar_settings')!.permission).toBe(
      'calendars.manage',
    );
    // A member books and changes visits, but doesn't set up calendars.
    const member = toolsFor((p) => p !== 'calendars.manage').map((t) => t.name);
    expect(member).toContain('update_job_status');
    expect(member).not.toContain('update_calendar_settings');
  });
});

describe('looking appointments up', () => {
  let visit: string;
  beforeAll(async () => {
    visit = await book(mikeId, at(-1, '10:00'));
  });

  it('lists a customer’s visits, including ones already over, with their ids', async () => {
    const { result, card } = await read('list_appointments', { personId: mikeId });
    const list = result['appointments'] as { id: string; status: string; customers: unknown[] }[];
    const mine = list.find((a) => a.id === visit)!;
    expect(mine.status).toBe('Not marked done yet');
    expect(mine.customers).toEqual([{ name: 'Mike Johnson', personId: mikeId }]);
    expect(card).toMatchObject({ type: 'list', title: 'Mike’s appointments' });
  });

  it('opens one with its customers, job, series and waitlist', async () => {
    const { result, card } = await read('get_appointment', { appointmentId: visit });
    expect(result).toMatchObject({
      id: visit,
      what: 'AC tune-up',
      kind: 'one customer',
      // Booked straight through the command, so it has the calendar's kind of place and no street yet.
      where: 'At the customer’s address',
      customers: [{ personId: mikeId, name: 'Mike Johnson', confirmed: 'not yet' }],
      job: { status: 'Scheduled' },
      series: null,
      waitlist: [],
    });
    expect(card).toMatchObject({ type: 'appointment', appointmentId: visit });
  });
});

describe('after a visit is booked', () => {
  let past: string;
  let next: string;
  beforeAll(async () => {
    past = await book(mikeId, at(-2, '09:00'));
    next = await book(mikeId, at(2, '10:00'));
  });

  it('marks it done only on Confirm, and switches it to a no-show', async () => {
    const { card, parsed } = await prepare('update_appointment', {
      appointmentId: past,
      outcome: 'done',
    });
    expect(card.title).toBe('Mark Mike’s AC tune-up done?');
    expect(field(card, 'How it went')).toBe('Not marked done yet → Done');
    expect(card.confirmLabel).toBe('Mark it done');
    expect(card.warnings.map((w) => w.text).join(' ')).toContain('thank-you after the job');
    expect((await appointmentRow(past)).status).toBe('scheduled');
    const done = await confirm('update_appointment', parsed);
    expect(done.command).toBe('appointment.set_status');
    expect((await appointmentRow(past)).status).toBe('completed');
    expect((await seatsOf(past))[0]!.status).toBe('attended');

    const again = await prepare('update_appointment', { appointmentId: past, outcome: 'no_show' });
    expect(field(again.card, 'How it went')).toBe('Done → No-show');
    await confirm('update_appointment', again.parsed);
    expect((await appointmentRow(past)).status).toBe('no_show');
  });

  it('refuses to propose a change that changes nothing', async () => {
    await expect(
      prepare('update_appointment', { appointmentId: past, outcome: 'no_show' }),
    ).rejects.toThrow('Nothing would change.');
  });

  it('changes the title, notes and where, and says nothing is sent', async () => {
    const { card, parsed } = await prepare('update_appointment', {
      appointmentId: next,
      title: 'AC tune-up and filter',
      notes: 'Gate code 4411',
      location: { kind: 'customer_address', address: '9 Elm St, Houston, TX 77008' },
    });
    expect(card.title).toBe('Change Mike’s AC tune-up?');
    expect(field(card, 'Title')).toBe('AC tune-up → AC tune-up and filter');
    expect(field(card, 'Notes')).toBe('Gate code 4411');
    expect(field(card, 'Where')).toBe('At the customer’s address → 9 Elm St, Houston, TX 77008');
    expect(card.warnings).toContainEqual({ kind: 'note', text: 'Nothing is sent to Mike.' });
    expect((await appointmentRow(next)).notes).toBeNull();
    await confirm('update_appointment', parsed);
    const row = await appointmentRow(next);
    expect(row).toMatchObject({ title: 'AC tune-up and filter', notes: 'Gate code 4411' });
    expect(row.location).toMatchObject({
      address: '9 Elm St, Houston, TX 77008',
      postalCode: '77008',
    });
  });

  it('marks the customer confirmed, and takes a team mark back', async () => {
    const { card, parsed } = await prepare('update_appointment', {
      appointmentId: next,
      confirmed: true,
    });
    expect(card.title).toBe('Mark Mike’s visit confirmed?');
    expect((await seatsOf(next))[0]!.confirmed_via).toBeNull();
    const done = await confirm('update_appointment', parsed);
    expect(done.command).toBe('attendee.confirm');
    expect((await seatsOf(next))[0]!.confirmed_via).toBe('staff');

    const back = await prepare('update_appointment', { appointmentId: next, confirmed: false });
    expect(back.card.title).toBe('Take back Mike’s confirmation?');
    await confirm('update_appointment', back.parsed);
    expect((await seatsOf(next))[0]!.confirmed_via).toBeNull();
  });

  it('won’t mark a visit that’s over as confirmed', async () => {
    await expect(
      prepare('update_appointment', { appointmentId: past, confirmed: true }),
    ).rejects.toThrow(/still to come/);
  });

  it('moves the job along with a note, and says whether the customer gets a text', async () => {
    const { card, parsed, result } = await prepare('update_job_status', {
      appointmentId: next,
      status: 'waiting_on_parts',
      note: 'The part is due Friday.',
    });
    expect(card.title).toBe('Mark Mike’s AC tune-up waiting on parts?');
    expect(field(card, 'Status')).toBe('Scheduled → Waiting on parts');
    expect(field(card, 'Note they may see')).toBe('The part is due Friday.');
    // No business number in a test workspace: the card says so instead of promising a text.
    expect(field(card, 'Text Mike')).toBe('No: texting isn’t set up yet');
    expect(result['textsCustomer']).toBe(false);
    const jobOf = async () =>
      (
        await rows<{ status: string; customer_note: string | null }>(
          admin(),
          sql`select j.status::text as status, j.customer_note from app.jobs j
              join app.appointments a on a.job_id = j.id where a.id = ${next}`,
        )
      )[0];
    expect(await jobOf()).toMatchObject({ status: 'scheduled' });
    const done = await confirm('update_job_status', parsed);
    expect(done).toMatchObject({ command: 'job.set_status', outcome: 'Marked waiting on parts.' });
    expect(await jobOf()).toEqual({
      status: 'waiting_on_parts',
      customer_note: 'The part is due Friday.',
    });
  });
});

describe('seats on a group session', () => {
  let session: string;
  beforeAll(async () => {
    session = (
      await run(
        sessionPublish,
        { workspaceId, calendarId: classes, startsAt: at(3, '14:00'), acknowledgeWarnings: true },
        owner,
      )
    ).appointmentId;
  });

  it('adds a customer on Confirm and says how they hear', async () => {
    const { card, parsed } = await prepare('manage_attendees', {
      action: 'add',
      appointmentId: session,
      personId: anaId,
    });
    expect(card.title).toBe('Add Ana to the HVAC class?');
    expect(field(card, 'Seats')).toBe('0 of 3 taken → 1 of 3');
    expect(field(card, 'Tell Ana')).toBe('An email with the details');
    expect(await seatsOf(session)).toEqual([]);
    const done = await confirm('manage_attendees', parsed);
    expect(done.outcome).toBe('Added. 1 of 3 seats taken.');
    expect((await seatsOf(session)).map((s) => [s.person_id, s.status])).toEqual([
      [anaId, 'booked'],
    ]);
  });

  it('won’t add someone to a one-customer visit', async () => {
    const visit = await book(boId, at(4, '11:00'));
    await expect(
      prepare('manage_attendees', { action: 'add', appointmentId: visit, personId: cyId }),
    ).rejects.toThrow(/one-customer visit/);
  });

  it('confirms and moves jobs along only for one-customer visits, as the appointment sheet does', async () => {
    await expect(
      prepare('update_appointment', { appointmentId: session, confirmed: true }),
    ).rejects.toThrow(/one customer/);
    await expect(
      prepare('update_job_status', { appointmentId: session, status: 'on_the_way' }),
    ).rejects.toThrow(/no job/);
  });

  it('puts someone on a full session’s waitlist, and hands them the seat when it frees up', async () => {
    await run(
      byName('appointment.add_attendee'),
      { workspaceId, appointmentId: session, personId: boId, seats: 2, notify: false },
      owner,
    );
    // Full now: Cy can only wait.
    await expect(
      prepare('manage_attendees', { action: 'add', appointmentId: session, personId: cyId }),
    ).rejects.toThrow(/waitlist/);
    const wait = await prepare('manage_waitlist', {
      action: 'add',
      calendarId: classes,
      appointmentId: session,
      personId: cyId,
    });
    expect(wait.card.title).toBe('Put Cy on the waitlist?');
    expect(field(wait.card, 'Place in line')).toBe('1st');
    expect(field(wait.card, 'Then')).toBe('When a seat opens they’re booked in and told');
    expect(await waitlistOf(classes)).toEqual([]);
    await confirm('manage_waitlist', wait.parsed);
    expect((await waitlistOf(classes)).map((w) => [w.person_id, w.status])).toEqual([
      [cyId, 'waiting'],
    ]);

    const off = await prepare('manage_attendees', {
      action: 'remove',
      appointmentId: session,
      personId: boId,
    });
    expect(off.card.title).toBe('Take Bo off the HVAC class?');
    expect(field(off.card, 'Seats')).toBe('3 of 3 taken → 1 of 3');
    expect(off.card.warnings.map((w) => w.text)).toContain(
      'The seat goes to Cy, first on its waitlist, who is booked in and told.',
    );
    await confirm('manage_attendees', off.parsed);
    expect((await seatsOf(session)).find((s) => s.person_id === boId)!.status).toBe('cancelled');

    // Booked by hand from the waitlist: their wait is over.
    const add = await prepare('manage_attendees', {
      action: 'add',
      appointmentId: session,
      personId: cyId,
    });
    expect(add.card.warnings.map((w) => w.text)).toContain('They come off its waitlist.');
    await confirm('manage_attendees', add.parsed);
    expect((await waitlistOf(classes)).map((w) => w.status)).toEqual(['removed']);
  });

  it('takes someone off a session’s waitlist', async () => {
    await run(
      byName('waitlist.add'),
      { workspaceId, calendarId: classes, appointmentId: session, personId: boId },
      owner,
    );
    const { card, parsed } = await prepare('manage_waitlist', {
      action: 'remove',
      appointmentId: session,
      personId: boId,
    });
    expect(card.title).toBe('Take Bo off the waitlist?');
    expect((await waitlistOf(classes)).at(-1)!.status).toBe('waiting');
    await confirm('manage_waitlist', parsed);
    expect((await waitlistOf(classes)).at(-1)!.status).toBe('removed');
  });

  it('puts someone on a calendar’s waitlist for a window of time', async () => {
    const { card, parsed } = await prepare('manage_waitlist', {
      action: 'add',
      calendarId: tuneUps,
      personId: anaId,
      wantedFrom: offsetAt(6, '08:00'),
      wantedTo: offsetAt(6, '17:00'),
    });
    expect(field(card, 'Waiting for')).toMatch(/^Any time /);
    expect(await waitlistOf(tuneUps)).toEqual([]);
    await confirm('manage_waitlist', parsed);
    expect(await waitlistOf(tuneUps)).toMatchObject([
      { person_id: anaId, status: 'waiting', appointment_id: null },
    ]);
  });

  it('lists a calendar’s waitlist, a window of time too, and takes someone off it by the entry id', async () => {
    // Ana, from the test before, waits for any time on a day: no appointment shows her.
    const [ana] = await waitlistOf(tuneUps);
    const { result, card } = await read('get_waitlist', { calendarId: tuneUps });
    expect(result).toMatchObject({
      calendar: { id: tuneUps, name: 'Tune-ups' },
      waitlistOn: true,
      waiting: [
        {
          entryId: ana!.id,
          personId: anaId,
          name: 'Ana Lopez',
          waitingFor: expect.stringMatching(/^Any time /),
        },
      ],
    });
    expect(card).toMatchObject({ type: 'list', title: 'Tune-ups waitlist' });

    // The entry id alone doesn't say whose waitlist it's on.
    await expect(
      prepare('manage_waitlist', { action: 'remove', entryId: ana!.id }),
    ).rejects.toThrow(/calendarId/);
    const { card: off, parsed } = await prepare('manage_waitlist', {
      action: 'remove',
      calendarId: tuneUps,
      entryId: ana!.id,
    });
    expect(off.title).toBe('Take Ana off the waitlist?');
    expect(field(off, 'Waiting for')).toMatch(/^Any time /);
    expect((await waitlistOf(tuneUps))[0]!.status).toBe('waiting');
    const done = await confirm('manage_waitlist', parsed);
    expect(done.outcome).toBe('Took Ana off the waitlist.');
    expect((await waitlistOf(tuneUps)).map((w) => w.status)).toEqual(['removed']);
    expect((await read('get_waitlist', { calendarId: tuneUps })).result).toMatchObject({
      waiting: [],
      note: 'Nobody is waiting.',
    });
  });

  it('leaves out someone whose window of time has passed', async () => {
    const { entryId } = (await run(
      byName('waitlist.add'),
      {
        workspaceId,
        calendarId: tuneUps,
        personId: boId,
        wantedFrom: at(2, '08:00'),
        wantedTo: at(2, '12:00'),
      },
      owner,
    )) as { entryId: string };
    expect((await read('get_waitlist', { calendarId: tuneUps })).result).toMatchObject({
      waiting: [{ entryId, name: 'Bo Nguyen' }],
    });
    // The morning comes and goes with no opening, before the worker has marked it over.
    await rows(
      admin(),
      sql`update app.waitlist_entries set wanted_from = now() - interval '5 hours',
            wanted_to = now() - interval '1 hour'
          where id = ${entryId}`,
    );
    const { result, card } = await read('get_waitlist', { calendarId: tuneUps });
    expect(result).toMatchObject({ waiting: [], note: 'Nobody is waiting.' });
    expect(card).toBeNull();
  });

  it('says the waitlist is off rather than adding to it', async () => {
    await expect(
      prepare('manage_waitlist', {
        action: 'add',
        calendarId: ducts,
        personId: anaId,
        wantedFrom: offsetAt(6, '08:00'),
        wantedTo: offsetAt(6, '17:00'),
      }),
    ).rejects.toThrow(/waitlist is off/);
  });
});

describe('repeat visits', () => {
  const series = () =>
    rows<{ id: string; status: string; occurrence: number }>(
      admin(),
      sql`select id, status::text as status, occurrence from app.appointments
          where workspace_id = ${workspaceId} and series_id is not null order by starts_at`,
    );

  it('books a weekly series on Confirm, and lists the dates that don’t fit', async () => {
    // Dale is already out on the second week's date.
    await book(anaId, at(12, '09:00'));
    const { card, parsed, result } = await prepare('manage_repeat_visits', {
      action: 'book',
      calendarId: tuneUps,
      personId: mikeId,
      firstVisit: offsetAt(5, '09:00'),
      repeats: 'weekly',
      visits: 4,
      tellCustomer: false,
    });
    expect(card.title).toBe('Book 3 visits for Mike?');
    expect(field(card, 'Visits')).toMatch(/^3 of 4, the last on /);
    expect(field(card, 'Repeats')).toMatch(/^Every week from /);
    expect(field(card, 'Won’t be booked')).toBeTruthy();
    expect(field(card, 'Tell Mike')).toBe('No');
    expect(card.warnings[0]).toEqual({
      kind: 'caution',
      text: '1 date doesn’t fit and won’t be booked.',
    });
    expect((result['skipped'] as unknown[]).length).toBe(1);
    expect(await series()).toEqual([]);

    const done = await confirm('manage_repeat_visits', parsed);
    expect(done.command).toBe('series.create');
    expect(done.outcome).toMatch(
      /^Booked 3 visits, every week from .+ One date didn’t fit and wasn’t booked: /,
    );
    expect((await series()).map((s) => s.occurrence)).toEqual([1, 3, 4]);
  });

  it('cancels a visit and the ones after it, and tells the customer once', async () => {
    const [, third] = await series();
    const { card, parsed } = await prepare('manage_repeat_visits', {
      action: 'cancel',
      appointmentId: third!.id,
      which: 'this_and_following',
    });
    expect(card.title).toBe('Cancel 2 visits of Mike’s AC tune-up?');
    expect(field(card, 'Which')).toBe('This one and the ones after it');
    expect(field(card, 'Tell Mike')).toBe('An email that these 2 visits are cancelled');
    expect(card.warnings[0]).toEqual({
      kind: 'caution',
      text: 'Mike is sent one notice now, not one for each visit.',
    });
    expect((await series()).map((s) => s.status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    await confirm('manage_repeat_visits', parsed);
    expect((await series()).map((s) => s.status)).toEqual(['scheduled', 'cancelled', 'cancelled']);
  });

  it('says repeats are off rather than booking one', async () => {
    await configure(tuneUps, { recurring: { staffSeries: false } }, false);
    await expect(
      prepare('manage_repeat_visits', {
        action: 'book',
        calendarId: tuneUps,
        personId: mikeId,
        firstVisit: offsetAt(30, '09:00'),
        repeats: 'monthly',
        visits: 2,
      }),
    ).rejects.toThrow(/Repeats are off/);
    await configure(tuneUps, { recurring: { staffSeries: true } }, false);
  });
});

describe('a calendar’s other sections', () => {
  it('reads them in the words the change takes', async () => {
    const { result } = await read('get_calendar_settings', { calendarId: tuneUps });
    expect(result).toMatchObject({
      calendar: { name: 'Tune-ups', books: 'open hours' },
      waitlist: { on: true, offersLastMinutes: 60 },
      repeats: { staffCanRepeat: true },
      payments: { take: 'none' },
      crm: { customerOwner: 'who_takes_the_booking', createLead: null },
    });
    expect((result['earlierVersions'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('shows each change as before → after, saves nothing until Confirm, then saves it', async () => {
    const before = await calendarNow(ducts);
    const { card, parsed } = await prepare('update_calendar_settings', {
      calendarId: ducts,
      capacity: { seatsPerTime: 2, largestGroup: 2 },
      waitlist: { on: true, offersLastMinutes: 30 },
      repeats: { mostVisits: 6 },
      changeRules: { cancelUpToHoursBefore: 48 },
      notifications: { reminders: [{ kind: 'day_before', at: '17:00' }] },
      questions: [{ label: 'Gate code', kind: 'short_text' }],
    });
    expect(card.title).toBe('Change Duct cleaning?');
    expect(card.fields[0]).toEqual({ label: 'Calendar', value: 'Duct cleaning' });
    expect(field(card, 'Seats')).toBe('1 → 2');
    expect(field(card, 'Waitlist')).toBe('off → on');
    expect(field(card, 'Cancel cutoff')).toBe('24 hours before → 48 hours before');
    expect(field(card, 'Most repeats')).toBe('12 → 6');
    expect(card.fields.map((f) => f.value)).toContain('Added question “Gate code”');
    expect((await calendarNow(ducts)).revision).toBe(before.revision);

    const done = await confirm('update_calendar_settings', parsed);
    expect(done.command).toBe('calendar.save');
    const after = await calendarNow(ducts);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.config.capacity).toMatchObject({ seats: 2, maxPartySize: 2 });
    expect(after.config.waitlist).toEqual({ enabled: true, offerMinutes: 30 });
    expect(after.config.recurring.maxOccurrences).toBe(6);
    expect(after.config.policies.cancel.cutoffHours).toBe(48);
    expect(after.config.notifications.reminders).toEqual([{ kind: 'day_before', at: '17:00' }]);
    expect(after.config.intake.questions.map((q) => q.label)).toEqual(['Gate code']);
  });

  it('routes by ZIP code, starts a lead for each booking, and warns before customers pay', async () => {
    const territoryId = (
      await run(
        territoryCreate,
        { workspaceId, name: 'Inner loop', postalCodes: ['77002'], userIds: [owner.id] },
        owner,
      )
    ).territoryId;
    const pipelineId = (await run(pipelineCreate, { workspaceId, name: 'Duct jobs' }, owner))
      .pipelineId;
    const { card, parsed } = await prepare('update_calendar_settings', {
      calendarId: ducts,
      locations: { places: [{ kind: 'customer_address' }] },
      zipRouting: { on: true, territoryIds: [territoryId] },
      crm: { createLead: { pipelineId } },
      payments: { take: 'deposit', depositDollars: 50 },
    });
    expect(field(card, 'ZIP routing')).toBe('off → on');
    expect(field(card, 'Territories')).toBe('all → Inner loop');
    expect(field(card, 'Create a lead')).toBe('off → Duct jobs · New');
    expect(field(card, 'Deposit')).toBe('what the business asks for → $50.00');
    expect(card.warnings[0]).toEqual({
      kind: 'caution',
      text: 'Customers pay a deposit when they book online. The time is held while they pay.',
    });
    // No payment account: the calendar isn't taking bookings yet, so it saves, and the card says what's missing.
    expect(card.warnings.map((w) => w.text)).toContain(
      'Taking payment at booking needs a connected payment account.',
    );
    await confirm('update_calendar_settings', parsed);
    const after = await calendarNow(ducts);
    expect(after.config.territory).toEqual({ routing: 'zip', territoryIds: [territoryId] });
    expect(after.config.payments.deposit).toEqual({ kind: 'amount', amountCents: 5000 });
    expect(after.config.crm.createLead?.pipelineId).toBe(pipelineId);
  });

  it('blocks a change that would stop a calendar taking bookings, as the builder does', async () => {
    const before = await calendarNow(tuneUps);
    const { card, result } = await prepare('update_calendar_settings', {
      calendarId: tuneUps,
      payments: { take: 'full' },
    });
    expect(card.confirmLabel).toBe('');
    expect(card.warnings[0]).toEqual({
      kind: 'blocked',
      text: 'Taking payment at booking needs a connected payment account.',
    });
    expect(result['blocked']).toBe(true);
    expect((await calendarNow(tuneUps)).revision).toBe(before.revision);
  });

  it('puts an earlier version back on Confirm', async () => {
    const before = await calendarNow(ducts);
    const { card, parsed } = await prepare('update_calendar_settings', {
      calendarId: ducts,
      action: 'restore',
      revision: 1,
    });
    expect(card.title).toBe('Put Duct cleaning back to version 1?');
    expect(field(card, 'Waitlist')).toBe('on → off');
    expect(card.confirmLabel).toBe('Restore it');
    expect((await calendarNow(ducts)).revision).toBe(before.revision);
    const done = await confirm('update_calendar_settings', parsed);
    expect(done.command).toBe('calendar.restore_revision');
    const after = await calendarNow(ducts);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.config.waitlist.enabled).toBe(false);
    expect(after.config.payments.mode).toBe('none');
  });
});
