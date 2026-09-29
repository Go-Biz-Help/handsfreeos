import {
  addDays,
  executeCommand,
  formatDuration,
  HfosError,
  isLocalDate,
  localDateOf,
  registry,
  startOfLocalDay,
  type AppointmentOut,
  type AppointmentWarning,
  type AssistantCard,
  type CalendarConfig,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import {
  atLabel,
  clockLabel,
  clockRange,
  dayLabel,
  firstName,
  hourLabel,
  isoWithOffset,
  joinAnd,
  longDayLabel,
  rangeLabel,
  zoneLabel,
} from './calendar-format';
import { personQuery } from './context';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';

/**
 * The calendar in the Assistant: open times on its own; booking, moving and cancelling as cards that wait
 * for the person's Confirm. Each card is prepared by running the very command Confirm will run inside a
 * transaction that is always rolled back, so it shows who the calendar picks, where, and every warning the
 * command raises (outside hours, busy, time off, too close to another visit) without keeping anything.
 */

type Args = Record<string, unknown>;
type Warning = { kind: string; text: string };
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type AppointmentCard = Extract<AssistantCard, { type: 'appointment' }>;
type ListCard = Extract<AssistantCard, { type: 'list' }>;

const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** /calendar with the day, the appointment, the view or the people to show (the calendar page reads these). */
export function calendarPath(
  workspaceId: string,
  p: { view?: string; date?: string; people?: string; appt?: string } = {},
): string {
  const qs = new URLSearchParams(defined(p) as Record<string, string>).toString();
  return `/app/w/${workspaceId}/calendar${qs ? `?${qs}` : ''}`;
}

// The business id goes on last: an input can never point these at another business (audit AI-3).
const q = <T>(db: Db, ctx: ToolContext, name: string, input: Args = {}) =>
  personQuery<T>(
    db,
    name,
    { ...input, workspaceId: ctx.workspaceId },
    ctx.actor,
    ctx.correlationId,
  );

async function cmd<T>(db: Db, ctx: ToolContext, name: string, input: Args): Promise<T> {
  const def = registry.command(name);
  if (!def) throw new Error(`Unknown command ${name}`);
  const done = await executeCommand(
    db,
    def,
    { ...input, workspaceId: ctx.workspaceId },
    ctx.actor,
    { correlationId: ctx.correlationId, channel: 'assistant' },
  );
  return done.output as T;
}

/** Thrown at the end of a dry run so its transaction rolls back. */
class RolledBack extends Error {}

/**
 * Runs `fn` inside a transaction that always rolls back: real commands and queries as the person (their
 * permissions, the calendar's rules, the database's overlap check), with nothing kept. The commands' own
 * transactions become savepoints inside it.
 */
async function dryRun<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const held: { done: boolean; value?: T } = { done: false };
  try {
    await db.transaction(async (tx) => {
      held.value = await fn(tx as unknown as Db);
      held.done = true;
      throw new RolledBack();
    });
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
  }
  if (!held.done) throw new Error('The dry run did not finish.');
  return held.value as T;
}

// ---------- reading ----------

interface CalendarGet {
  calendar: {
    id: string;
    name: string;
    status: string;
    timezone: string;
    config: CalendarConfig;
  };
}
interface Attendee {
  personId: string;
  fullName: string;
  status: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
  smsOk?: boolean;
}
type Appointment = Omit<AppointmentOut, 'attendees'> & { attendees: Attendee[] };
interface PersonGet {
  person: {
    id: string;
    fullName: string;
    phone: string | null;
    address: {
      line1: string | null;
      city: string | null;
      state: string | null;
      postalCode: string | null;
    };
  };
}

const calendarGet = (db: Db, ctx: ToolContext, calendarId: unknown) =>
  q<CalendarGet>(db, ctx, 'calendar.get', { calendarId });
const appointmentGet = async (db: Db, ctx: ToolContext, appointmentId: unknown) =>
  (await q<{ appointment: Appointment }>(db, ctx, 'appointment.get', { appointmentId }))
    .appointment;

async function teamNames(db: Db, ctx: ToolContext): Promise<Map<string, string>> {
  const team = await q<{
    members: { userId: string; fullName: string; email: string }[];
    organizationAdmins: { userId: string; fullName: string; email: string }[];
  }>(db, ctx, 'workspace.members');
  return new Map(
    [...team.organizationAdmins, ...team.members].map((m) => [m.userId, m.fullName || m.email]),
  );
}

/** Whether the business can text at all yet (a number, approved by the carriers). */
async function textingReady(db: Db, ctx: ToolContext): Promise<boolean> {
  const setup = await q<{ number: unknown; messagingReady: boolean }>(
    db,
    ctx,
    'phone.setup_status',
  ).catch(() => null);
  return setup ? !!setup.number && setup.messagingReady : true;
}

const whatOf = (a: Pick<Appointment, 'service' | 'title'>) => a.service?.name ?? a.title;
const booked = (a: Appointment) => a.attendees.filter((p) => p.status !== 'cancelled');
const customersOf = (a: Appointment) => {
  const names = booked(a).map((p) => p.fullName);
  return names.length > 3
    ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
    : joinAnd(names);
};
const staffOf = (a: Appointment) => a.staff.map((s) => s.fullName);
const isGroup = (a: Appointment) => a.kind === 'session' || a.capacity > 1;

/** One appointment as a card: what, who it's for, when, who works it, and where it stands. */
export function appointmentCard(
  ctx: ToolContext,
  a: Appointment,
  timeZone: string,
): AppointmentCard {
  const start = Date.parse(a.startsAt);
  return {
    type: 'appointment',
    appointmentId: a.id,
    what: isGroup(a) ? `${whatOf(a)} · ${a.seatsTaken}/${a.capacity}` : whatOf(a),
    customer: isGroup(a) ? null : customersOf(a) || null,
    when: rangeLabel(start, Date.parse(a.endsAt), timeZone),
    with: joinAnd(staffOf(a)) || null,
    status: a.status,
    href: calendarPath(ctx.workspaceId, { date: localDateOf(start, timeZone), appt: a.id }),
  };
}

/** What the model reads about an appointment: its id and plain words. */
const appointmentResult = (a: Appointment, timeZone: string) => ({
  id: a.id,
  calendarId: a.calendar.id,
  what: whatOf(a),
  customers: booked(a).map((p) => p.fullName),
  when: rangeLabel(Date.parse(a.startsAt), Date.parse(a.endsAt), timeZone),
  startsAt: isoWithOffset(Date.parse(a.startsAt), timeZone),
  with: staffOf(a),
  status: a.status,
});

/** A customer's appointments that haven't ended, soonest first (the next 60 days). */
export async function upcomingFor(
  db: Db,
  ctx: ToolContext,
  personId: string,
): Promise<{ items: Appointment[]; results: ReturnType<typeof appointmentResult>[] }> {
  const now = Date.now();
  const { items } = await q<{ items: Appointment[] }>(db, ctx, 'appointment.list', {
    personId,
    from: iso(now),
    to: iso(now + 60 * DAY),
    status: ['scheduled'],
  });
  const left = items.filter((a) => Date.parse(a.endsAt) > now);
  return { items: left, results: left.slice(0, 5).map((a) => appointmentResult(a, ctx.timezone)) };
}

/** Today's appointments still to come, for "What's on my calendar?", as a list card. */
export async function todaysAppointments(
  db: Db,
  ctx: ToolContext,
): Promise<{ result: Record<string, unknown>; card: ListCard | null }> {
  const tz = ctx.timezone;
  const now = Date.now();
  const today = localDateOf(now, tz);
  const { items } = await q<{ items: Appointment[] }>(db, ctx, 'appointment.list', {
    from: iso(startOfLocalDay(today, tz)),
    to: iso(startOfLocalDay(addDays(today, 1), tz)),
  });
  const live = items.filter((a) => a.status === 'scheduled' || a.status === 'completed');
  const left = live.filter((a) => a.status === 'scheduled' && Date.parse(a.endsAt) > now);
  const happening = (a: Appointment) => Date.parse(a.startsAt) <= now;
  const title = (a: Appointment) => {
    const who = isGroup(a)
      ? `${a.seatsTaken}/${a.capacity}`
      : booked(a)
          .map((p) => firstName(p.fullName))
          .join(', ');
    return [clockLabel(Date.parse(a.startsAt), tz), whatOf(a), who].filter(Boolean).join(' · ');
  };
  return {
    result: {
      today: longDayLabel(now, tz),
      stillToCome: left.map((a) => ({
        ...appointmentResult(a, tz),
        happeningNow: happening(a),
        yours: a.staff.some((s) => s.userId === ctx.actor.userId),
      })),
      doneEarlierToday: live.length - left.length,
    },
    card: left.length
      ? {
          type: 'list',
          title: 'Still to come today',
          aside: `${dayLabel(now, tz)} · ${zoneLabel(tz, now)}`,
          items: left.slice(0, 12).map((a) => ({
            title: title(a),
            detail: [...staffOf(a).map(firstName), ...(happening(a) ? ['now'] : [])].join(', '),
            tone: happening(a) ? 'warning' : 'accent',
            href: calendarPath(ctx.workspaceId, { date: today, appt: a.id }),
          })),
        }
      : null,
  };
}

/** Up to `n` times spread over the day, so a full day isn't only its first hours. */
function spread<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]!);
}

type ReadTool = (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>;

export const calendarReadTools: Record<string, ReadTool> = {
  async find_availability(db, ctx, args) {
    const [{ calendar }, names] = await Promise.all([
      calendarGet(db, ctx, args['calendarId']),
      teamNames(db, ctx),
    ]);
    const tz = calendar.timezone;
    const { team } = calendar.config;
    const userId = str(args['userId']);
    const person = userId ? (names.get(userId) ?? 'That teammate') : null;
    if (userId && team.assignment === 'none')
      return {
        result: {
          error: `The ${calendar.name} calendar books without staff, so there’s nobody to pick.`,
        },
        isError: true,
      };
    if (userId && !team.members.some((m) => m.userId === userId))
      return {
        result: { error: `${person} isn’t on the ${calendar.name} calendar.` },
        isError: true,
      };
    const host = team.assignment === 'fixed' ? team.members[0]?.userId : undefined;
    if (userId && host && host !== userId)
      return {
        result: {
          error: `The ${calendar.name} calendar books ${names.get(host) ?? 'someone else'}, not ${person}.`,
        },
        isError: true,
      };
    const from = String(args['from']);
    const to = str(args['to']);
    const fromMs = isLocalDate(from) ? startOfLocalDay(from, tz) : Date.parse(from);
    const toMs = to
      ? isLocalDate(to)
        ? startOfLocalDay(addDays(to, 1), tz)
        : Date.parse(to)
      : startOfLocalDay(addDays(localDateOf(fromMs, tz), 1), tz);
    if (!(toMs > fromMs))
      throw HfosError.validation(
        [{ path: 'to', message: 'The end comes before the start.' }],
        `The range ends (${to}) before it starts (${from}). Give a to that’s later than from, or leave to out for the rest of that day.`,
      );
    const [open, services] = await Promise.all([
      q<{
        serviceId: string | null;
        durationMinutes: number;
        slots: { startsAt: string; userIds: string[] }[];
      }>(
        db,
        ctx,
        'calendar.availability',
        defined({
          calendarId: calendar.id,
          from: iso(fromMs),
          to: iso(Math.min(toMs, fromMs + 31 * DAY)),
          serviceId: str(args['serviceId']),
          durationMinutes: args['durationMinutes'],
          chosenUserId: team.assignment === 'customer_choice' ? userId : undefined,
        }),
      ),
      q<{ items: { id: string; name: string }[] }>(db, ctx, 'service.list', {
        includeArchived: true,
      }),
    ]);
    const service = services.items.find((s) => s.id === open.serviceId) ?? null;
    const byDay = new Map<string, number[]>();
    for (const s of open.slots) {
      if (userId && !s.userIds.includes(userId)) continue;
      const at = Date.parse(s.startsAt);
      const date = localDateOf(at, tz);
      byDay.set(date, [...(byDay.get(date) ?? []), at]);
    }
    const dates = [...byDay.keys()].sort();
    const shown = dates.slice(0, 3);
    const label = (at: number) => clockLabel(at, tz);
    return {
      result: {
        calendar: calendar.name,
        service: service?.name ?? null,
        person,
        length: formatDuration(open.durationMinutes),
        timeZone: tz,
        days: shown.map((date) => ({
          date,
          day: longDayLabel(byDay.get(date)![0]!, tz),
          times: byDay
            .get(date)!
            .slice(0, 24)
            .map((at) => ({ time: label(at), startsAt: isoWithOffset(at, tz) })),
        })),
        moreDaysWithTimes: dates.length - shown.length,
        ...(dates.length ? {} : { note: 'No open times in that range.' }),
      },
      card: {
        type: 'slots',
        title: person ?? calendar.name,
        zone: zoneLabel(tz, fromMs),
        timezone: tz,
        calendar: { id: calendar.id, name: calendar.name },
        service: service ? { id: service.id, name: service.name } : null,
        person: userId && person ? { userId, fullName: person } : null,
        durationMinutes: open.durationMinutes,
        days: shown.map((date) => ({
          date,
          label: dayLabel(byDay.get(date)![0]!, tz),
          times: spread(byDay.get(date)!, 8).map((at) => ({ startsAt: iso(at), label: label(at) })),
        })),
        href: calendarPath(ctx.workspaceId, {
          ...(userId ? { view: 'week' } : {}),
          date: shown[0] ?? localDateOf(fromMs, tz),
          people: userId,
        }),
      },
    };
  },
};

// ---------- booking, moving and cancelling: cards that wait for Confirm ----------

const WARNING_KIND: Record<AppointmentWarning['code'], string> = {
  buffer_clash: 'conflict',
  outside_hours: 'outside_hours',
  calendar_busy: 'busy',
  time_off: 'time_off',
  in_past: 'in_past',
};

/** "Priya is busy in Outlook 2:00–2:30 PM." from the busy times read from her calendar. */
async function busyText(
  db: Db,
  ctx: ToolContext,
  userId: string,
  span: { start: number; end: number; timeZone: string },
): Promise<string | null> {
  const team = await q<{
    people: {
      fullName: string;
      busy: { startsAt: string; endsAt: string }[];
      connection: { provider: string } | null;
    }[];
  }>(db, ctx, 'schedule.team', {
    from: iso(span.start),
    to: iso(span.end),
    userIds: [userId],
  }).catch(() => null);
  const p = team?.people[0];
  const block = p?.busy.find(
    (b) => Date.parse(b.startsAt) < span.end && Date.parse(b.endsAt) > span.start,
  );
  if (!p || !block) return null;
  const where =
    p.connection?.provider === 'google'
      ? 'in Google Calendar'
      : p.connection
        ? 'in Outlook'
        : 'on their calendar';
  return `${firstName(p.fullName)} is busy ${where} ${clockRange(Date.parse(block.startsAt), Date.parse(block.endsAt), span.timeZone)}.`;
}

/** The command's warnings in the card's words (each once, the busy ones with their times). */
async function warningsFor(
  db: Db,
  ctx: ToolContext,
  warnings: readonly AppointmentWarning[],
  span: { start: number; end: number; timeZone: string },
): Promise<Warning[]> {
  const out: Warning[] = [];
  for (const w of warnings) {
    const busy =
      w.code === 'calendar_busy' && w.userId ? await busyText(db, ctx, w.userId, span) : null;
    const text = busy ?? (/[.!?]$/.test(w.message) ? w.message : `${w.message}.`);
    if (!out.some((o) => o.text === text)) out.push({ kind: WARNING_KIND[w.code] ?? w.code, text });
  }
  return out;
}

/** How the customer hears about it: by text when they can get texts, else by email, else not at all. */
function reachOf(a: Attendee | undefined, canText: boolean): 'text' | 'email' | null {
  if (a?.smsOk && a.contactPhone && canText) return 'text';
  return a?.contactEmail ? 'email' : null;
}

/** "Text now, the day before at 4 PM, and 2 hours before", or why it goes by email or not at all. */
function remindersLine(
  config: CalendarConfig,
  a: Attendee | undefined,
  first: string,
  canText: boolean,
): { line: string; warning: Warning | null } {
  const n = config.notifications;
  const when = [
    n.confirmation.text || n.confirmation.email ? 'now' : null,
    ...n.reminders.map((r) =>
      r.kind === 'day_before'
        ? `the day before at ${hourLabel(r.at)}`
        : `${formatDuration(r.minutes)} before`,
    ),
  ].filter((w): w is string => !!w);
  if (!when.length) return { line: 'None for this calendar', warning: null };
  const list =
    when.length > 2 ? `${when.slice(0, -1).join(', ')}, and ${when.at(-1)}` : joinAnd(when);
  const texts = n.confirmation.text || n.reminderChannels.text;
  const emails = n.confirmation.email || n.reminderChannels.email;
  const reach = reachOf(a, canText);
  if (reach === 'text' && texts) return { line: `Text ${list}`, warning: null };
  if (reach !== null && emails) {
    if (!texts) return { line: `Email ${list}`, warning: null };
    const why = !canText
      ? 'texting isn’t set up yet'
      : !a?.contactPhone
        ? `there’s no mobile number for ${first}`
        : `${first} hasn’t agreed to texts`;
    return { line: `By email, since ${why}`, warning: null };
  }
  return {
    line: 'None',
    warning: {
      kind: 'no_text_consent',
      text: `${first} can’t get texts and has no email, so they won’t hear about this booking.`,
    },
  };
}

function whereOf(l: AppointmentOut['location']): string | null {
  if (l.address) return l.address;
  switch (l.kind) {
    case 'customer_address':
      return 'At the customer’s address';
    case 'business':
      return 'At the business';
    case 'virtual':
      return l.meetingUrl ?? 'Video call';
    case 'phone':
      return 'Phone call';
    default:
      return null;
  }
}

const PICKS: Partial<Record<CalendarConfig['team']['assignment'], string>> = {
  round_robin: 'next in turn',
  weighted: 'next in turn',
  first_available: 'first available',
};

function confirmCard(
  toolCallId: string,
  tool: string,
  card: Pick<ConfirmCard, 'title' | 'fields' | 'warnings' | 'confirmLabel'> &
    Partial<Pick<ConfirmCard, 'personId' | 'body'>>,
): ConfirmCard {
  return {
    type: 'confirm',
    toolCallId,
    tool,
    personId: null,
    conversationId: null,
    body: null,
    stageFrom: null,
    stageTo: null,
    reasons: [],
    editable: false,
    ...card,
    warnings: card.warnings.slice(0, 3),
  };
}

interface ConfirmTool {
  prepare(db: Db, ctx: ToolContext, args: Args, toolCallId: string): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    extra: { lostReason?: string; toolCallId: string },
  ): Promise<CommittedAction>;
}

interface CreateOut {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  userIds: string[];
  warnings: AppointmentWarning[];
}
interface MoveOut {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  warnings: AppointmentWarning[];
}

/** "123 Main St, Houston, TX 77002" from a customer's address, when it has a street. */
function addressLine(a: PersonGet['person']['address']): string | null {
  if (!a.line1) return null;
  return [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}

/**
 * What appointment.create gets: the model's arguments, plus the customer's street when the calendar goes to
 * customers (as the booking dialog fills it in). Prepare and Confirm build it the same way.
 */
function bookingInput(args: Args, calendar: CalendarGet['calendar'], person: PersonGet['person']) {
  const visits = calendar.config.locations.options[0]?.kind === 'customer_address';
  const address = visits ? addressLine(person.address) : null;
  return defined({
    calendarId: calendar.id,
    personId: person.id,
    startsAt: args['startsAt'],
    durationMinutes: args['durationMinutes'],
    serviceId: str(args['serviceId']),
    // A calendar without staff books nobody; people the model named are dropped.
    userIds: calendar.config.team.assignment === 'none' ? undefined : args['userIds'],
    leadId: str(args['leadId']),
    notes: str(args['notes']),
    location: address
      ? { kind: 'customer_address', address, postalCode: person.address.postalCode }
      : undefined,
    // "Tell Mike": a confirmation by text or email, unless the person said not to.
    notify: args['notify'] !== false,
  });
}

const bookAppointment: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const [{ calendar }, { person }, canText] = await Promise.all([
      calendarGet(db, ctx, args['calendarId']),
      q<PersonGet>(db, ctx, 'person.get', { personId: args['personId'] }),
      textingReady(db, ctx),
    ]);
    const input = bookingInput(args, calendar, person);
    const { created, appt } = await dryRun(db, async (tx) => {
      const created = await cmd<CreateOut>(tx, ctx, 'appointment.create', {
        ...input,
        acknowledgeWarnings: true,
      });
      return { created, appt: await appointmentGet(tx, ctx, created.appointmentId) };
    });
    const tz = calendar.timezone;
    const start = Date.parse(created.startsAt);
    const end = Date.parse(created.endsAt);
    const first = firstName(person.fullName);
    const staff = staffOf(appt);
    const picked =
      !args['userIds'] && staff.length === 1 ? PICKS[calendar.config.team.assignment] : undefined;
    const warnings = await warningsFor(db, ctx, created.warnings, { start, end, timeZone: tz });
    const reminders = remindersLine(
      calendar.config,
      appt.attendees.find((p) => p.personId === person.id),
      first,
      canText,
    );
    const where = whereOf(appt.location);
    const what = `${whatOf(appt)} · ${formatDuration(Math.round((end - start) / MIN))}`;
    const notify = args['notify'] !== false;
    const tell = tellRow(appt, first, notify, canText, 'with the details');
    return {
      card: confirmCard(toolCallId, 'book_appointment', {
        personId: person.id,
        title: 'Book this appointment?',
        fields: [
          { label: 'Customer', value: [person.fullName, person.phone].filter(Boolean).join(' · ') },
          { label: 'What', value: what },
          { label: 'When', value: `${rangeLabel(start, end, tz)} ${zoneLabel(tz, start)}` },
          // Nobody works it on a calendar without staff: no With row.
          ...(staff.length
            ? [{ label: 'With', value: `${joinAnd(staff)}${picked ? `, ${picked}` : ''}` }]
            : []),
          ...(where ? [{ label: 'Where', value: where }] : []),
          { label: 'Reminders', value: reminders.line },
          ...(tell ? [tell] : []),
        ],
        warnings: [...warnings, ...(reminders.warning ? [reminders.warning] : [])],
        confirmLabel: warnings.length ? 'Book anyway' : 'Book',
      }),
      result: {
        customer: person.fullName,
        what,
        when: atLabel(start, tz),
        with: staff,
        tellCustomer: notify,
        ...(warnings.length ? { warnings: warnings.map((w) => w.text) } : {}),
      },
    };
  },
  async commit(db, ctx, args, extra) {
    const [{ calendar }, { person }] = await Promise.all([
      calendarGet(db, ctx, args['calendarId']),
      q<PersonGet>(db, ctx, 'person.get', { personId: args['personId'] }),
    ]);
    const out = await cmd<CreateOut>(db, ctx, 'appointment.create', {
      ...bookingInput(args, calendar, person),
      acknowledgeWarnings: true,
      clientId: `assistant-${extra.toolCallId}`,
    });
    const start = Date.parse(out.startsAt);
    const tz = calendar.timezone;
    return {
      outcome: `Booked for ${atLabel(start, tz)}.`,
      href: calendarPath(ctx.workspaceId, {
        date: localDateOf(start, tz),
        appt: out.appointmentId,
      }),
      command: 'appointment.create',
    };
  },
};

/** The appointment as it stands, which must still be on (not cancelled or done). */
async function scheduledAppointment(db: Db, ctx: ToolContext, appointmentId: unknown) {
  const appt = await appointmentGet(db, ctx, appointmentId);
  if (appt.status !== 'scheduled')
    throw HfosError.rule(
      'appointment_not_scheduled',
      409,
      appt.status === 'cancelled'
        ? 'That appointment was already cancelled, so it can’t be changed. Book a new one if it’s still needed.'
        : appt.status === 'no_show'
          ? 'That appointment is already marked as a no-show, so it can’t be changed. Book a new one if they still want to come.'
          : 'That appointment is already marked done, so it can’t be changed. Book a new one if they need another visit.',
    );
  const { calendar } = await calendarGet(db, ctx, appt.calendar.id);
  return {
    appt,
    timeZone: calendar.timezone,
    noStaff: calendar.config.team.assignment === 'none',
  };
}

/** "Mike’s AC tune-up", or "the HVAC class" when it isn't one customer's. */
function whose(appt: Appointment): { name: string; first: string | null } {
  const people = booked(appt);
  const first = !isGroup(appt) && people.length === 1 ? firstName(people[0]!.fullName) : null;
  return { name: first ? `${first}’s ${whatOf(appt)}` : `the ${whatOf(appt)}`, first };
}

/** The "Tell Mike" row: how the customer hears about a change, or that nobody is told. */
function tellRow(
  appt: Appointment,
  first: string | null,
  notify: boolean,
  canText: boolean,
  about: string,
): { label: string; value: string } | null {
  const people = booked(appt);
  if (!people.length) return null;
  const label = first ? `Tell ${first}` : 'Tell customers';
  if (!notify) return { label, value: 'No' };
  const reach = people.map((p) => reachOf(p, canText));
  if (reach.every((r) => r === 'text')) return { label, value: `A text ${about}` };
  if (reach.every((r) => r === null)) return { label, value: 'No text or email on file' };
  if (reach.every((r) => r === 'email')) return { label, value: `An email ${about}` };
  return { label, value: `A text or an email ${about}` };
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.join() === b.join();

/**
 * Moves it (and hands it to other people when asked, unless the calendar books without staff); Prepare and
 * Confirm run the same steps.
 */
async function move(db: Db, ctx: ToolContext, args: Args, appt: Appointment, noStaff: boolean) {
  const moved = await cmd<MoveOut>(db, ctx, 'appointment.reschedule', {
    appointmentId: appt.id,
    startsAt: args['startsAt'],
    acknowledgeWarnings: true,
    notify: true,
  });
  const userIds = noStaff ? undefined : (args['userIds'] as string[] | undefined);
  const warnings = [...moved.warnings];
  if (
    userIds?.length &&
    !sameOrder(
      userIds,
      appt.staff.map((s) => s.userId),
    )
  ) {
    const r = await cmd<{ warnings: AppointmentWarning[] }>(db, ctx, 'appointment.reassign', {
      appointmentId: appt.id,
      userIds,
      acknowledgeWarnings: true,
      // One notice for the customer: the new time's already tells them who is coming.
      notify: Date.parse(moved.startsAt) === Date.parse(appt.startsAt),
    });
    warnings.push(...r.warnings);
  }
  return { moved, warnings };
}

const rescheduleAppointment: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const [{ appt, timeZone: tz, noStaff }, canText] = await Promise.all([
      scheduledAppointment(db, ctx, args['appointmentId']),
      textingReady(db, ctx),
    ]);
    const {
      moved,
      warnings: raw,
      after,
    } = await dryRun(db, async (tx) => {
      const m = await move(tx, ctx, args, appt, noStaff);
      return { ...m, after: await appointmentGet(tx, ctx, appt.id) };
    });
    const was = { start: Date.parse(appt.startsAt), end: Date.parse(appt.endsAt) };
    const now = { start: Date.parse(moved.startsAt), end: Date.parse(moved.endsAt) };
    if (was.start === now.start && sameOrder(staffOf(appt), staffOf(after)))
      throw HfosError.rule(
        'same_time',
        409,
        `It’s already at ${atLabel(was.start, tz)} with the same people, so nothing would change. Give a different startsAt or userIds.`,
      );
    const warnings = await warningsFor(db, ctx, raw, { ...now, timeZone: tz });
    const { name, first } = whose(appt);
    const tell = tellRow(appt, first, true, canText, 'with the new time');
    return {
      card: confirmCard(toolCallId, 'reschedule_appointment', {
        personId: booked(appt)[0]?.personId ?? null,
        title: `Move ${name}?`,
        fields: [
          { label: 'Was', value: rangeLabel(was.start, was.end, tz) },
          { label: 'Now', value: rangeLabel(now.start, now.end, tz) },
          ...(noStaff ? [] : [{ label: 'With', value: joinAnd(staffOf(after)) || 'Nobody yet' }]),
          ...(tell ? [tell] : []),
        ],
        warnings,
        confirmLabel: warnings.length ? 'Move anyway' : 'Move',
      }),
      result: {
        appointment: whatOf(appt),
        customers: booked(appt).map((p) => p.fullName),
        was: atLabel(was.start, tz),
        now: atLabel(now.start, tz),
        with: staffOf(after),
        ...(warnings.length ? { warnings: warnings.map((w) => w.text) } : {}),
      },
    };
  },
  async commit(db, ctx, args) {
    const {
      appt,
      timeZone: tz,
      noStaff,
    } = await scheduledAppointment(db, ctx, args['appointmentId']);
    const { moved } = await move(db, ctx, args, appt, noStaff);
    const start = Date.parse(moved.startsAt);
    return {
      outcome: `Moved to ${atLabel(start, tz)}.`,
      href: calendarPath(ctx.workspaceId, { date: localDateOf(start, tz), appt: appt.id }),
      command: 'appointment.reschedule',
    };
  },
};

const cancelAppointment: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const [{ appt, timeZone: tz }, canText] = await Promise.all([
      scheduledAppointment(db, ctx, args['appointmentId']),
      textingReady(db, ctx),
    ]);
    const { name, first } = whose(appt);
    const notify = args['notify'] !== false;
    const reason = str(args['reason']);
    const tell = tellRow(appt, first, notify, canText, 'that it’s cancelled');
    const start = Date.parse(appt.startsAt);
    return {
      card: confirmCard(toolCallId, 'cancel_appointment', {
        personId: booked(appt)[0]?.personId ?? null,
        title: `Cancel ${name}?`,
        fields: [
          { label: 'When', value: rangeLabel(start, Date.parse(appt.endsAt), tz) },
          ...(staffOf(appt).length ? [{ label: 'With', value: joinAnd(staffOf(appt)) }] : []),
          ...(reason ? [{ label: 'Reason', value: reason }] : []),
          ...(tell ? [tell] : []),
        ],
        warnings: [],
        confirmLabel: 'Cancel appointment',
      }),
      result: {
        appointment: whatOf(appt),
        customers: booked(appt).map((p) => p.fullName),
        when: atLabel(start, tz),
        tellCustomer: notify,
      },
    };
  },
  async commit(db, ctx, args) {
    const { appt } = await scheduledAppointment(db, ctx, args['appointmentId']);
    await cmd(db, ctx, 'appointment.cancel', {
      appointmentId: appt.id,
      reason: str(args['reason']) ?? null,
      notify: args['notify'] !== false,
    });
    const staff = staffOf(appt).map(firstName);
    return {
      outcome: staff.length
        ? `Cancelled. ${joinAnd(staff)} ${staff.length === 1 ? 'has' : 'have'} the time back.`
        : 'Cancelled.',
      href: null,
      command: 'appointment.cancel',
    };
  },
};

export const calendarConfirmTools: Record<string, ConfirmTool> = {
  book_appointment: bookAppointment,
  reschedule_appointment: rescheduleAppointment,
  cancel_appointment: cancelAppointment,
};
