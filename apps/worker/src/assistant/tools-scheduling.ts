/**
 * The Assistant's scheduling tools (packages/core/src/assistant/tools-scheduling.ts): what each does when it runs on its own
 * ("auto"), and the card it shows and the command it runs once the person presses Confirm ("confirm").
 *
 * An appointment after it's booked (done or a no-show, confirmed, its details, the job's status, the seats on a
 * session), repeat visits, the waitlist, and the calendar sections manage_calendar doesn't reach. Where a card has
 * to say what the command will do — which dates of a series fit, where someone lands on a waitlist, what a
 * calendar save changes — it runs that command inside a transaction that always rolls back, so the card shows the
 * command's own answer and nothing is kept until Confirm.
 */
import {
  addDays,
  applyPatch,
  automationSettingsOf,
  diffConfigs,
  formatDuration,
  HfosError,
  isLocalDate,
  JOB_STATUS_WORDS,
  localDateOf,
  startOfLocalDay,
  zonedParts,
  type AppointmentOut,
  type AssistantCard,
  type CalendarConfig,
  type ConfigPatch,
  type JobStatus,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { jobText } from '../booking/job-texts';
import {
  atLabel,
  clockLabel,
  dayLabel,
  firstName,
  isoWithOffset,
  joinAnd,
  rangeLabel,
  zoneLabel,
} from './calendar-format';
import type { ToolContext, ToolOutcome } from './runtime';
import { appointmentCard, calendarPath } from './tools-calendar';
import { command, query, quoted } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Warning = { kind: string; text: string };
type Field = { label: string; value: string };
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type ListCard = Extract<AssistantCard, { type: 'list' }>;

const DAY = 86_400_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const defined = <T extends Args>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ordinal = (n: number) => {
  const v = n % 100;
  const end = v >= 11 && v <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${end}`;
};
/** The calendar rules' messages end without a full stop; a card line has one. */
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------- reading ----------

interface Seat {
  id: string;
  personId: string;
  fullName: string;
  status: string;
  seats: number;
  contactPhone?: string | null;
  contactEmail?: string | null;
  smsOk?: boolean;
  confirmedAt?: string | null;
  confirmedVia?: 'sms' | 'link' | 'staff' | 'ai' | null;
  confirmedBy?: { id: string; fullName: string } | null;
  heldUntil?: string | null;
}
interface Job {
  id: string;
  title: string;
  status: JobStatus;
  customerNote: string | null;
  visits: { appointmentId: string }[];
}
interface Waiting {
  id: string;
  personId: string;
  fullName: string;
  seats: number;
  status: string;
  position: number;
}
/** One entry of waitlist.list: for a full session, or for a window of time. */
interface WaitlistEntry extends Waiting {
  appointment: { id: string; title: string; startsAt: string; endsAt: string } | null;
  wantedFrom: string | null;
  wantedTo: string | null;
  offerExpiresAt: string | null;
}
type Appt = Omit<AppointmentOut, 'attendees'> & {
  attendees: Seat[];
  job?: Job | null;
  series?: { id: string; rule: Record<string, unknown> } | null;
  waitlist?: Waiting[];
};
interface CalendarFull {
  calendar: {
    id: string;
    name: string;
    status: string;
    revision: number;
    timezone: string;
    config: CalendarConfig;
    issues: { code: string; severity: 'error' | 'warning'; message: string }[];
  };
  revisions: {
    revision: number;
    diff: string[];
    changedBy: { id: string; fullName: string } | null;
    createdAt: string;
  }[];
}
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

const appointmentOf = async (db: Db, ctx: ToolContext, appointmentId: unknown) =>
  (await query<{ appointment: Appt }>(db, ctx, 'appointment.get', { appointmentId })).appointment;
const calendarOf = (db: Db, ctx: ToolContext, calendarId: unknown) =>
  query<CalendarFull>(db, ctx, 'calendar.get', { calendarId });
const personOf = async (db: Db, ctx: ToolContext, personId: unknown) =>
  (await query<PersonGet>(db, ctx, 'person.get', { personId })).person;
const waitlistOf = async (db: Db, ctx: ToolContext, calendarId: unknown) =>
  (await query<{ items: WaitlistEntry[] }>(db, ctx, 'waitlist.list', { calendarId })).items;

/** "HVAC class · Fri, Sep 18, 10:00–11:00 AM", or "Any time Fri, Sep 18, 9:00 AM–12:00 PM". */
const waitingFor = (w: WaitlistEntry, tz: string) =>
  w.appointment
    ? `${w.appointment.title} · ${rangeLabel(Date.parse(w.appointment.startsAt), Date.parse(w.appointment.endsAt), tz)}`
    : `Any time ${rangeLabel(Date.parse(w.wantedFrom!), Date.parse(w.wantedTo!), tz)}`;

/** Whether the business can text at all yet (a number, approved by the carriers). */
async function textingReady(db: Db, ctx: ToolContext): Promise<boolean> {
  const setup = await query<{ number: unknown; messagingReady: boolean }>(
    db,
    ctx,
    'phone.setup_status',
  ).catch(() => null);
  return setup ? !!setup.number && setup.messagingReady : true;
}

const whatOf = (a: Pick<Appt, 'service' | 'title'>) => a.service?.name ?? a.title;
const booked = (a: Appt) => a.attendees.filter((p) => p.status !== 'cancelled');
const isGroup = (a: Pick<Appt, 'kind' | 'capacity'>) => a.kind === 'session' || a.capacity > 1;
const staffOf = (a: Appt) => a.staff.map((s) => s.fullName);

/** "Mike’s AC tune-up", or "the HVAC class" when it isn't one customer's. */
function whose(a: Appt): { name: string; first: string | null } {
  const people = booked(a);
  const first = !isGroup(a) && people.length === 1 ? firstName(people[0]!.fullName) : null;
  return { name: first ? `${first}’s ${whatOf(a)}` : `the ${whatOf(a)}`, first };
}

const STATUS_WORDS: Record<string, string> = {
  scheduled: 'Booked',
  completed: 'Done',
  no_show: 'No-show',
  cancelled: 'Cancelled',
};
/** A booked visit whose time is over is waiting for someone to say how it went. */
const statusWords = (a: Pick<Appt, 'status' | 'endsAt'>, now = Date.now()) =>
  a.status === 'scheduled' && Date.parse(a.endsAt) <= now
    ? 'Not marked done yet'
    : (STATUS_WORDS[a.status] ?? a.status);

type Place = { kind: string | null; address: string | null; meetingUrl: string | null };
function whereOf(l: Place | null | undefined): string | null {
  if (!l) return null;
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

/** How a customer hears about something: by text when they take texts, else by email, else not at all. */
function reachOf(s: Seat | undefined, canText: boolean): 'text' | 'email' | null {
  if (s?.smsOk && s.contactPhone && canText) return 'text';
  return s?.contactEmail ? 'email' : null;
}
function tellValue(s: Seat | undefined, notify: boolean, canText: boolean, about: string) {
  if (!notify) return 'No';
  const r = reachOf(s, canText);
  return r === 'text'
    ? `A text ${about}`
    : r === 'email'
      ? `An email ${about}`
      : 'No text or email on file';
}

const CONFIRMED_VIA: Record<string, string> = {
  sms: 'by text',
  link: 'online',
  staff: 'by someone on the team',
  ai: 'with the AI teammate',
};

/** "every 2 weeks, 6 visits" from a series' stored rule. */
function repeatWords(rule: Record<string, unknown>): string {
  const n = typeof rule['interval'] === 'number' ? rule['interval'] : 1;
  const unit = rule['freq'] === 'weekly' ? 'week' : 'month';
  const every = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  const nth = rule['freq'] === 'monthly_nth' ? ' on the same weekday' : '';
  const count = typeof rule['count'] === 'number' ? `, ${plural(rule['count'], 'visit')}` : '';
  return `${every}${nth}${count}`;
}

/** Runs `fn` inside a transaction that always rolls back: real commands as the person, nothing kept. */
class RolledBack extends Error {}
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

function card(
  toolCallId: string,
  tool: string,
  c: {
    title: string;
    fields: Field[];
    confirmLabel: string;
    warnings?: Warning[];
    personId?: string | null;
  },
): ConfirmCard {
  return { ...settingsCard(toolCallId, tool, c), personId: c.personId ?? null };
}

const nothingChanges = () => HfosError.validation([], 'Nothing would change.');

// ---------- look-ups ----------

type ReadTool = (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>;

/** The range list_appointments reads: the model's dates, today, or a customer's month either side. */
function rangeOf(args: Args, tz: string): { from: number; to: number } {
  const today = localDateOf(Date.now(), tz);
  const start = (v: string) => (isLocalDate(v) ? startOfLocalDay(v, tz) : Date.parse(v));
  const end = (v: string) => (isLocalDate(v) ? startOfLocalDay(addDays(v, 1), tz) : Date.parse(v));
  const from = str(args['from']);
  const to = str(args['to']);
  let range: { from: number; to: number };
  if (from) range = { from: start(from), to: to ? end(to) : start(from) + DAY };
  else if (to) range = { from: end(to) - (args['personId'] ? 30 : 1) * DAY, to: end(to) };
  else if (args['personId'])
    range = {
      from: startOfLocalDay(addDays(today, -30), tz),
      to: startOfLocalDay(addDays(today, 31), tz),
    };
  else range = { from: startOfLocalDay(today, tz), to: startOfLocalDay(addDays(today, 1), tz) };
  if (!(range.to > range.from))
    throw HfosError.validation([{ path: 'to', message: 'The end comes before the start.' }]);
  return { from: range.from, to: Math.min(range.to, range.from + 62 * DAY) };
}

const TONE: Record<string, ListCard['items'][number]['tone']> = {
  scheduled: 'accent',
  completed: 'muted',
  no_show: 'warning',
  cancelled: 'danger',
};

export const schedulingAutoTools: Record<string, ReadTool> = {
  async list_appointments(db, ctx, args) {
    const tz = ctx.timezone;
    const { from, to } = rangeOf(args, tz);
    const { items } = await query<{ items: Appt[] }>(
      db,
      ctx,
      'appointment.list',
      defined({
        from: iso(from),
        to: iso(to),
        personId: str(args['personId']),
        calendarIds: str(args['calendarId']) ? [args['calendarId']] : undefined,
        userIds: str(args['userId']) ? [args['userId']] : undefined,
        status: args['status'],
      }),
    );
    const list = [...items].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const who = str(args['personId'])
      ? await personOf(db, ctx, args['personId']).catch(() => null)
      : null;
    const span = `${dayLabel(from, tz)}${to - from > DAY ? ` to ${dayLabel(to - 1, tz)}` : ''}`;
    const shown = list.slice(0, 25);
    return {
      result: {
        range: span,
        timeZone: tz,
        appointments: shown.map((a) => ({
          id: a.id,
          calendar: a.calendar.name,
          calendarId: a.calendar.id,
          what: whatOf(a),
          customers: booked(a)
            .slice(0, 4)
            .map((p) => ({ name: p.fullName, personId: p.personId })),
          when: rangeLabel(Date.parse(a.startsAt), Date.parse(a.endsAt), tz),
          startsAt: isoWithOffset(Date.parse(a.startsAt), tz),
          with: staffOf(a),
          status: statusWords(a),
          ...(isGroup(a) ? { seats: `${a.seatsTaken} of ${a.capacity} taken` } : {}),
          ...(a.seriesId ? { repeatVisit: a.occurrence } : {}),
        })),
        ...(list.length > shown.length ? { more: list.length - shown.length } : {}),
        ...(list.length ? {} : { note: 'No appointments in that range.' }),
      },
      card: list.length
        ? {
            type: 'list',
            title: who ? `${firstName(who.fullName)}’s appointments` : 'Appointments',
            aside: `${span} · ${zoneLabel(tz, from)}`,
            items: list.slice(0, 12).map((a) => {
              const start = Date.parse(a.startsAt);
              const people = isGroup(a)
                ? `${a.seatsTaken}/${a.capacity}`
                : booked(a)
                    .map((p) => firstName(p.fullName))
                    .join(', ');
              return {
                title: [clockLabel(start, tz), whatOf(a), people].filter(Boolean).join(' · '),
                detail: `${dayLabel(start, tz)} · ${statusWords(a)}`,
                tone: TONE[a.status] ?? 'muted',
                href: calendarPath(ctx.workspaceId, { date: localDateOf(start, tz), appt: a.id }),
              };
            }),
          }
        : null,
    };
  },

  async get_appointment(db, ctx, args) {
    const a = await appointmentOf(db, ctx, args['appointmentId']);
    const { calendar } = await calendarOf(db, ctx, a.calendar.id);
    const tz = calendar.timezone;
    const canText = await textingReady(db, ctx);
    const start = Date.parse(a.startsAt);
    return {
      result: {
        id: a.id,
        calendar: { id: a.calendar.id, name: a.calendar.name },
        what: whatOf(a),
        ...(a.service && a.title !== a.service.name ? { title: a.title } : {}),
        kind: isGroup(a) ? 'group session' : 'one customer',
        when: `${rangeLabel(start, Date.parse(a.endsAt), tz)} ${zoneLabel(tz, start)}`,
        startsAt: isoWithOffset(start, tz),
        status: statusWords(a),
        with: staffOf(a),
        where: whereOf(a.location),
        notes: quoted(a.notes),
        ...(isGroup(a) ? { seats: { taken: a.seatsTaken, of: a.capacity } } : {}),
        customers: a.attendees.map((s) => ({
          personId: s.personId,
          name: s.fullName,
          status: s.status,
          ...(isGroup(a) ? { seats: s.seats } : {}),
          confirmed: s.confirmedAt
            ? `yes, ${CONFIRMED_VIA[s.confirmedVia ?? 'staff'] ?? 'by the team'}`
            : 'not yet',
          hearsBy: reachOf(s, canText) ?? 'nothing on file',
        })),
        job: a.job
          ? {
              status: JOB_STATUS_WORDS[a.job.status] ?? a.job.status,
              noteForCustomer: quoted(a.job.customerNote),
              visits: a.job.visits.length,
            }
          : null,
        series: a.series
          ? { repeats: repeatWords(a.series.rule), thisIsVisit: a.occurrence }
          : null,
        dealId: a.leadId,
        forRecord: a.customRecord,
        waitlist: (a.waitlist ?? []).map((w) => ({
          entryId: w.id,
          personId: w.personId,
          name: w.fullName,
          seats: w.seats,
          status: w.status,
        })),
      },
      card: appointmentCard(ctx, a, tz),
    };
  },

  async get_calendar_settings(db, ctx, args) {
    const { calendar, revisions } = await calendarOf(db, ctx, args['calendarId']);
    const c = calendar.config;
    const tz = calendar.timezone;
    const [territories, pipelines] = await Promise.all([
      c.territory.territoryIds.length
        ? query<{ items: { id: string; name: string }[] }>(db, ctx, 'territory.list').catch(
            () => null,
          )
        : null,
      c.crm.createLead ? pipelinesOf(db, ctx) : null,
    ]);
    const lead = c.crm.createLead;
    const pipeline = lead ? pipelines?.find((p) => p.id === lead.pipelineId) : undefined;
    const deposit = c.payments.deposit;
    return {
      result: {
        calendar: {
          id: calendar.id,
          name: calendar.name,
          status: calendar.status,
          books: c.schedule.mode === 'sessions' ? 'fixed sessions' : 'open hours',
          onTheBookingSite: c.public,
          timeZone: tz,
        },
        capacity: {
          seatsPerTime: c.capacity.seats,
          largestGroup: c.capacity.maxPartySize,
          showSeatsLeft: c.capacity.showSeatsLeft,
        },
        locations: {
          places: c.locations.options.map((o) =>
            defined({
              kind: o.kind,
              address: o.address ?? undefined,
              meetingLink: o.meetingUrl ?? undefined,
            }),
          ),
          customerPicks: c.locations.customerChooses,
        },
        zipRouting: {
          on: c.territory.routing === 'zip',
          territoryIds: c.territory.territoryIds,
          ...(territories
            ? {
                territories: c.territory.territoryIds.map(
                  (id) => territories.items.find((t) => t.id === id)?.name ?? 'a territory',
                ),
              }
            : {}),
        },
        repeats: {
          staffCanRepeat: c.recurring.staffSeries,
          customersCanRepeat: c.recurring.customerSeries,
          mostVisits: c.recurring.maxOccurrences,
        },
        waitlist: { on: c.waitlist.enabled, offersLastMinutes: c.waitlist.offerMinutes },
        questions: c.intake.questions.map((q) => ({
          id: q.id,
          label: q.label,
          kind: q.kind,
          required: q.required,
          ...(q.options.length ? { choices: q.options } : {}),
        })),
        changeRules: {
          customersCanCancel: c.policies.cancel.allowed,
          cancelUpToHoursBefore: c.policies.cancel.cutoffHours,
          customersCanReschedule: c.policies.reschedule.allowed,
          rescheduleUpToHoursBefore: c.policies.reschedule.cutoffHours,
          mostReschedules: c.policies.reschedule.maxTimes,
          policyText: c.policies.policyText,
        },
        notifications: {
          confirmationByText: c.notifications.confirmation.text,
          confirmationByEmail: c.notifications.confirmation.email,
          reminders: c.notifications.reminders,
          remindersByText: c.notifications.reminderChannels.text,
          remindersByEmail: c.notifications.reminderChannels.email,
          emailTeamOnNewBooking: c.notifications.staffEmail,
        },
        crm: {
          customerOwner: OWNER_WORDS[c.crm.ownership],
          setOwnerWhenNone: c.crm.assignContactOwner,
          createLead: lead
            ? {
                ...lead,
                ...(pipeline
                  ? {
                      pipeline: pipeline.name,
                      stage: pipeline.stages.find((s) => s.id === lead.stageId)?.name,
                    }
                  : {}),
              }
            : null,
        },
        payments: {
          take: c.payments.mode,
          deposit: !deposit
            ? 'what the business asks for (Settings → Payments)'
            : deposit.kind === 'percent'
              ? { depositPercent: (deposit.percentBp ?? 0) / 100 }
              : { depositDollars: (deposit.amountCents ?? 0) / 100 },
          accountId: c.payments.connectionId,
        },
        needsFixing: calendar.issues.map(
          (i) => `${i.severity === 'error' ? 'Must fix' : 'Worth a look'}: ${i.message}`,
        ),
        version: calendar.revision,
        earlierVersions: revisions
          .filter((r) => r.revision !== calendar.revision)
          .slice(0, 8)
          .map((r) => ({
            revision: r.revision,
            saved: atLabel(Date.parse(r.createdAt), tz),
            by: r.changedBy?.fullName ?? 'HandsFreeOS',
            changes: r.diff.slice(0, 4),
          })),
      },
    };
  },

  async get_waitlist(db, ctx, args) {
    const { calendar } = await calendarOf(db, ctx, args['calendarId']);
    const tz = calendar.timezone;
    const list = await waitlistOf(db, ctx, calendar.id);
    const offered = (w: WaitlistEntry) =>
      w.status === 'offered' && w.offerExpiresAt
        ? `A freed time is offered to them until ${atLabel(Date.parse(w.offerExpiresAt), tz)}`
        : null;
    return {
      result: {
        calendar: { id: calendar.id, name: calendar.name },
        waitlistOn: calendar.config.waitlist.enabled,
        timeZone: tz,
        waiting: list.map((w) => ({
          entryId: w.id,
          personId: w.personId,
          name: w.fullName,
          waitingFor: waitingFor(w, tz),
          ...(w.appointment ? { appointmentId: w.appointment.id } : {}),
          ...(w.seats > 1 ? { seats: w.seats } : {}),
          ...(offered(w) ? { offer: offered(w) } : {}),
        })),
        ...(list.length ? {} : { note: 'Nobody is waiting.' }),
      },
      card: list.length
        ? {
            type: 'list',
            title: `${calendar.name} waitlist`,
            aside: zoneLabel(tz),
            items: list.slice(0, 12).map((w) => ({
              title: `${w.fullName} · ${waitingFor(w, tz)}`,
              detail: offered(w) ?? (w.seats > 1 ? `Waiting, ${w.seats} seats` : 'Waiting'),
              tone: w.status === 'offered' ? 'accent' : 'muted',
              href: `/app/w/${ctx.workspaceId}/settings/calendars/${calendar.id}`,
            })),
          }
        : null,
    };
  },
};

// ---------- after it's booked: done, no-show, confirmed, its details ----------

/** A 5-digit ZIP code at the end of an address, for routing. */
const zipOf = (address: string | null) => address?.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1] ?? null;

type StoredLocation = {
  kind: string | null;
  address: string | null;
  meetingUrl: string | null;
  postalCode: string | null;
};

/** The appointment's new location from the model's place: what it said, else what was there for that kind. */
function locationFrom(place: Args | null, was: StoredLocation): StoredLocation {
  if (!place) return { kind: null, address: null, meetingUrl: null, postalCode: null };
  const kind = String(place['kind']);
  const same = was.kind === kind;
  const address =
    kind === 'customer_address' || kind === 'business'
      ? (str(place['address']) ?? (same ? was.address : null))
      : null;
  return {
    kind,
    address,
    meetingUrl:
      kind === 'virtual' ? (str(place['meetingLink']) ?? (same ? was.meetingUrl : null)) : null,
    postalCode:
      kind === 'customer_address'
        ? (zipOf(address) ?? (address === was.address ? was.postalCode : null))
        : null,
  };
}

interface UpdatePlan {
  a: Appt;
  tz: string;
  fields: Field[];
  warnings: Warning[];
  details: Args | null;
  status: 'completed' | 'no_show' | null;
  confirm: { attendeeId: string; confirmed: boolean; first: string } | null;
  what: string[];
}

/** What update_appointment would change, worked out the same way for the card and for Confirm. */
async function planUpdate(db: Db, ctx: ToolContext, args: Args): Promise<UpdatePlan> {
  const a = await appointmentOf(db, ctx, args['appointmentId']);
  const { calendar } = await calendarOf(db, ctx, a.calendar.id);
  const tz = calendar.timezone;
  const now = Date.now();
  const plan: UpdatePlan = {
    a,
    tz,
    fields: [],
    warnings: [],
    details: null,
    status: null,
    confirm: null,
    what: [],
  };

  const outcome = args['outcome'] as 'done' | 'no_show' | undefined;
  if (outcome) {
    if (a.status === 'cancelled')
      throw HfosError.rule('appointment_not_scheduled', 409, 'That appointment was cancelled.');
    const to = outcome === 'done' ? 'completed' : 'no_show';
    if (a.status !== to) {
      plan.status = to;
      plan.what.push(outcome);
      plan.fields.push({
        label: 'How it went',
        value: `${statusWords(a, now)} → ${STATUS_WORDS[to]}`,
      });
      if (Date.parse(a.startsAt) > now)
        plan.warnings.push({ kind: 'note', text: 'It hasn’t started yet.' });
    }
  }

  if (typeof args['confirmed'] === 'boolean') {
    // Confirming is for one-customer visits, as on the appointment sheet: a class's seats aren't asked.
    const people = booked(a);
    const seat = !isGroup(a) && people.length === 1 ? people[0] : undefined;
    if (!seat)
      throw HfosError.rule(
        'confirm_one_customer',
        409,
        'Only a visit for one customer can be marked confirmed.',
      );
    const first = firstName(seat.fullName);
    if (args['confirmed'] && !seat.confirmedAt) {
      // The screen offers it only for a visit still to come that is really theirs: a time held while they pay a
      // deposit hasn't been promised to them, so there is nothing to confirm yet.
      if (a.status !== 'scheduled' || Date.parse(a.startsAt) <= now)
        throw HfosError.rule(
          'appointment_not_upcoming',
          409,
          'Only a visit still to come can be marked confirmed.',
        );
      if (seat.heldUntil && Date.parse(seat.heldUntil) > now)
        throw HfosError.rule(
          'booking_held',
          409,
          `The time is only held while ${first} pays the deposit, so there’s nothing to confirm yet.`,
        );
      plan.confirm = { attendeeId: seat.id, confirmed: true, first };
      plan.what.push('confirm');
      plan.fields.push({ label: `${first} confirmed`, value: 'Not yet → Yes, marked by you' });
    }
    if (!args['confirmed'] && seat.confirmedAt) {
      if (seat.confirmedVia !== 'staff')
        throw HfosError.rule(
          'confirmation_not_staff',
          409,
          `${first} confirmed this themselves, so it stays confirmed.`,
        );
      plan.confirm = { attendeeId: seat.id, confirmed: false, first };
      plan.what.push('unconfirm');
      plan.fields.push({ label: `${first} confirmed`, value: 'Yes → Not yet' });
    }
  }

  const details: Args = {};
  const title = str(args['title']);
  if (title && title !== a.title) {
    details['title'] = title;
    plan.fields.push({ label: 'Title', value: `${a.title} → ${title}` });
  }
  if (args['notes'] !== undefined) {
    const notes = str(args['notes']) ?? null;
    if (notes !== (a.notes ?? null)) {
      details['notes'] = notes;
      plan.fields.push({ label: 'Notes', value: notes ? clip(notes) : 'Cleared' });
    }
  }
  if (args['location'] !== undefined) {
    const was = a.location as StoredLocation;
    const next = locationFrom(args['location'] as Args | null, was);
    const keys = ['kind', 'address', 'meetingUrl', 'postalCode'] as const;
    if (keys.some((k) => (next[k] ?? null) !== (was[k] ?? null))) {
      details['location'] = next;
      plan.fields.push({
        label: 'Where',
        value: `${whereOf(was) ?? 'Not set'} → ${whereOf(next) ?? 'Not set'}`,
      });
    }
  }
  if (args['leadId'] !== undefined) {
    const leadId = str(args['leadId']) ?? null;
    if (leadId !== a.leadId) {
      details['leadId'] = leadId;
      const lead = leadId
        ? await query<{ lead: { title: string } }>(db, ctx, 'lead.get', { leadId })
        : null;
      plan.fields.push({ label: 'Deal', value: lead ? lead.lead.title : 'Not linked to a deal' });
    }
  }
  if (Object.keys(details).length) {
    plan.details = details;
    plan.what.push('details');
  }
  return plan;
}

const updateAppointment: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const plan = await planUpdate(db, ctx, args);
    if (!plan.what.length) throw nothingChanges();
    const { a, tz } = plan;
    const { name, first } = whose(a);
    const only = plan.what.length === 1 ? plan.what[0] : null;
    const who = plan.confirm?.first ?? first;
    const thankYou =
      plan.status === 'completed' &&
      booked(a).length > 0 &&
      (await query<{ workspace: { settings: Record<string, unknown> | null } }>(
        db,
        ctx,
        'workspace.get',
      )
        .then((w) => automationSettingsOf(w.workspace.settings).switches.thankYou)
        .catch(() => false));
    const warnings: Warning[] = [
      ...plan.warnings,
      thankYou
        ? {
            kind: 'note',
            text: 'Nothing is sent now. The thank-you after the job follows in about 2 hours (Settings → Automations).',
          }
        : { kind: 'note', text: `Nothing is sent to ${who ?? 'the customer'}.` },
    ];
    const start = Date.parse(a.startsAt);
    return {
      card: card(toolCallId, 'update_appointment', {
        personId: booked(a)[0]?.personId ?? null,
        title:
          only === 'done'
            ? `Mark ${name} done?`
            : only === 'no_show'
              ? `Mark ${name} a no-show?`
              : only === 'confirm'
                ? `Mark ${plan.confirm!.first}’s visit confirmed?`
                : only === 'unconfirm'
                  ? `Take back ${plan.confirm!.first}’s confirmation?`
                  : `Change ${name}?`,
        fields: [
          {
            label: 'Appointment',
            value: `${whatOf(a)} · ${rangeLabel(start, Date.parse(a.endsAt), tz)}`,
          },
          ...plan.fields,
        ],
        confirmLabel:
          only === 'done'
            ? 'Mark it done'
            : only === 'no_show'
              ? 'Mark a no-show'
              : only === 'confirm'
                ? 'Mark confirmed'
                : only === 'unconfirm'
                  ? 'Take it back'
                  : 'Save the change',
        warnings,
      }),
      result: {
        waiting: true,
        appointment: whatOf(a),
        when: atLabel(start, tz),
        changes: plan.fields.map((f) => `${f.label}: ${f.value}`),
      },
    };
  },

  async commit(db, ctx, args) {
    const plan = await planUpdate(db, ctx, args);
    const { a, tz } = plan;
    const done: string[] = [];
    // The audit names the last command it ran; a change to the details alone is appointment.update.
    let last = 'appointment.update';
    if (plan.details) {
      await command(db, ctx, 'appointment.update', { appointmentId: a.id, ...plan.details });
      done.push('Saved the changes.');
    }
    if (plan.status) {
      await command(db, ctx, 'appointment.set_status', {
        appointmentId: a.id,
        status: plan.status,
      });
      last = 'appointment.set_status';
      done.push(plan.status === 'completed' ? 'Marked done.' : 'Marked a no-show.');
    }
    if (plan.confirm) {
      await command(db, ctx, 'attendee.confirm', {
        attendeeId: plan.confirm.attendeeId,
        confirmed: plan.confirm.confirmed,
      });
      last = 'attendee.confirm';
      done.push(
        plan.confirm.confirmed
          ? `Marked ${plan.confirm.first}’s visit confirmed.`
          : 'Took the confirmation back.',
      );
    }
    const start = Date.parse(a.startsAt);
    return {
      outcome: done.join(' ') || 'It was already that way.',
      href: calendarPath(ctx.workspaceId, { date: localDateOf(start, tz), appt: a.id }),
      command: last,
    };
  },
};

// ---------- the job's status, which the customer is texted about ----------

const STATUS_TITLE: Record<string, string> = {
  on_the_way: 'on the way',
  in_progress: 'started',
  waiting_on_parts: 'waiting on parts',
  done: 'done',
};

interface JobPlan {
  a: Appt;
  tz: string;
  was: JobStatus;
  status: JobStatus;
  note: string | null | undefined;
  statusChanged: boolean;
  noteChanged: boolean;
}

async function planJob(db: Db, ctx: ToolContext, args: Args): Promise<JobPlan> {
  const a = await appointmentOf(db, ctx, args['appointmentId']);
  if (a.status === 'cancelled')
    throw HfosError.rule('visit_cancelled', 409, 'That visit was cancelled.');
  // The appointment sheet shows a job only where there is one; a class published for seats has none to move.
  if (!a.job && a.kind === 'session')
    throw HfosError.rule('no_job', 409, 'A group session has no job to move along.');
  const was: JobStatus = a.job?.status ?? 'scheduled';
  if (was === 'cancelled')
    throw HfosError.rule('visit_cancelled', 409, 'That job was cancelled with its visits.');
  const status = (str(args['status']) as JobStatus | undefined) ?? was;
  const note = args['note'] === undefined ? undefined : (str(args['note']) ?? null);
  const { calendar } = await calendarOf(db, ctx, a.calendar.id);
  return {
    a,
    tz: calendar.timezone,
    was,
    status,
    note,
    statusChanged: status !== was,
    noteChanged: note !== undefined && note !== (a.job?.customerNote ?? null),
  };
}

/** The business name the customer's texts start with: the booking page's, else the workspace's. */
async function businessName(db: Db, ctx: ToolContext): Promise<string> {
  const [site, ws] = await Promise.all([
    query<{ site: { name: string } | null }>(db, ctx, 'booking_site.get').catch(() => null),
    query<{ workspace: { name: string } }>(db, ctx, 'workspace.get').catch(() => null),
  ]);
  return site?.site?.name || ws?.workspace.name || 'The business';
}

const updateJobStatus: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const plan = await planJob(db, ctx, args);
    if (!plan.statusChanged && !plan.noteChanged) throw nothingChanges();
    const { a, tz, was, status } = plan;
    const [canText, business] = await Promise.all([textingReady(db, ctx), businessName(db, ctx)]);
    const { name } = whose(a);
    // The worker texts the visit's first customer only (booking/job-texts.ts), host first among the staff.
    const seat = a.attendees[0];
    const first = seat ? firstName(seat.fullName) : null;
    const notify = args['tellCustomer'] !== false;
    const staff = [...a.staff]
      .sort((x, y) =>
        x.role === y.role ? x.userId.localeCompare(y.userId) : x.role === 'host' ? -1 : 1,
      )
      .map((s) => firstName(s.fullName));
    const note = plan.note === undefined ? (a.job?.customerNote ?? null) : plan.note;
    const text = jobText({
      business,
      title: a.title,
      status,
      noteOnly: !plan.statusChanged,
      note,
      staff,
      eta: null,
      first: false,
    });
    const texted =
      notify && !!text && seat?.status === 'booked' && reachOf(seat, canText) === 'text';
    const why = !seat
      ? null
      : !notify
        ? 'No'
        : !text
          ? 'No text for going back to scheduled'
          : seat.status !== 'booked'
            ? `No: ${first} isn’t booked on it any more`
            : !canText
              ? 'No: texting isn’t set up yet'
              : !seat.contactPhone
                ? `No: there’s no mobile number for ${first}`
                : !seat.smsOk
                  ? `No: ${first} hasn’t agreed to texts`
                  : text;
    const warnings: Warning[] = [];
    if (texted)
      warnings.push({
        kind: 'caution',
        text: `This texts ${first} now. In quiet hours it doesn’t go at all.`,
      });
    if (status === 'on_the_way' && plan.statusChanged)
      warnings.push({
        kind: 'note',
        text: 'It won’t say when you’ll get there: On my way in the phone app adds that.',
      });
    if (isGroup(a) && booked(a).length > 1)
      warnings.push({ kind: 'note', text: `Only ${first} hears about it, not everyone on it.` });
    const words = STATUS_TITLE[status];
    return {
      card: card(toolCallId, 'update_job_status', {
        personId: seat?.personId ?? null,
        title: !plan.statusChanged
          ? `Change the note on ${name}?`
          : status === 'scheduled'
            ? `Put ${name} back to scheduled?`
            : `Mark ${name} ${words}?`,
        fields: [
          {
            label: 'Job',
            value: `${a.job?.title ?? whatOf(a)} · ${atLabel(Date.parse(a.startsAt), tz)}`,
          },
          ...(plan.statusChanged
            ? [{ label: 'Status', value: `${JOB_STATUS_WORDS[was]} → ${JOB_STATUS_WORDS[status]}` }]
            : []),
          ...(plan.noteChanged
            ? [{ label: 'Note they may see', value: plan.note ? clip(plan.note) : 'Cleared' }]
            : []),
          ...(why && first ? [{ label: `Text ${first}`, value: why }] : []),
        ],
        confirmLabel: texted ? `Update and text ${first}` : 'Update the job',
        warnings,
      }),
      result: {
        waiting: true,
        job: a.job?.title ?? whatOf(a),
        status: JOB_STATUS_WORDS[status],
        textsCustomer: texted,
        ...(texted ? { text } : {}),
      },
    };
  },

  async commit(db, ctx, args) {
    const plan = await planJob(db, ctx, args);
    const { a, tz, status } = plan;
    const out = await command<{ changed: boolean }>(
      db,
      ctx,
      'job.set_status',
      defined({
        appointmentId: a.id,
        status,
        customerNote: plan.note,
        notify: args['tellCustomer'] !== false,
      }),
    );
    const start = Date.parse(a.startsAt);
    return {
      outcome: !out.changed
        ? 'It was already that way.'
        : !plan.statusChanged
          ? 'Note saved.'
          : status === 'scheduled'
            ? 'Back to scheduled.'
            : `Marked ${STATUS_TITLE[status]}.`,
      href: calendarPath(ctx.workspaceId, { date: localDateOf(start, tz), appt: a.id }),
      command: 'job.set_status',
    };
  },
};

// ---------- seats on a group session ----------

async function sessionFor(db: Db, ctx: ToolContext, args: Args) {
  const a = await appointmentOf(db, ctx, args['appointmentId']);
  const act = String(args['action']);
  if (!isGroup(a))
    throw HfosError.rule(
      'not_a_session',
      409,
      act === 'add'
        ? 'That’s a one-customer visit. Book them a time of their own instead.'
        : 'That’s a one-customer visit. Cancel the appointment instead.',
    );
  const { calendar } = await calendarOf(db, ctx, a.calendar.id);
  return { a, calendar };
}

const manageAttendees: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = String(args['action']);
    const personId = String(args['personId']);
    const notify = args['tellCustomer'] !== false;
    const [{ a, calendar }, canText] = await Promise.all([
      sessionFor(db, ctx, args),
      textingReady(db, ctx),
    ]);
    const tz = calendar.timezone;
    const start = Date.parse(a.startsAt);
    const session = `${whatOf(a)} · ${rangeLabel(start, Date.parse(a.endsAt), tz)}`;
    if (act === 'add') {
      if (a.status !== 'scheduled')
        throw HfosError.rule('appointment_not_scheduled', 409, 'That session isn’t on any more.');
      if (booked(a).some((p) => p.personId === personId && p.status === 'booked'))
        throw HfosError.rule('already_booked', 409, 'They’re already on it.');
      const seats = Number(args['seats'] ?? 1);
      const left = Math.max(0, a.capacity - a.seatsTaken);
      if (seats > left)
        throw HfosError.rule(
          'session_full',
          409,
          left === 0
            ? 'It’s full. Put them on its waitlist instead.'
            : `Only ${plural(left, 'seat')} left.`,
        );
      // The command's own answer, rolled back: who they are to it and how they'd hear.
      const seat = await dryRun(db, async (tx) => {
        await command(tx, ctx, 'appointment.add_attendee', {
          appointmentId: a.id,
          personId,
          seats,
          notify,
        });
        return (await appointmentOf(tx, ctx, a.id)).attendees.find(
          (p) => p.personId === personId && p.status === 'booked',
        );
      });
      const name = seat?.fullName ?? 'They';
      const first = firstName(name);
      const waiting = (a.waitlist ?? []).some((w) => w.personId === personId);
      const tell = tellValue(seat, notify, canText, 'with the details');
      return {
        card: card(toolCallId, 'manage_attendees', {
          personId,
          title: `Add ${first} to the ${whatOf(a)}?`,
          fields: [
            { label: 'Customer', value: name },
            { label: 'Session', value: session },
            {
              label: 'Seats',
              value: `${a.seatsTaken} of ${a.capacity} taken → ${a.seatsTaken + seats} of ${a.capacity}`,
            },
            { label: `Tell ${first}`, value: tell },
          ],
          confirmLabel: 'Add them',
          warnings: [
            ...(notify && reachOf(seat, canText)
              ? [{ kind: 'caution', text: `${first} is sent a confirmation now.` }]
              : []),
            ...(waiting ? [{ kind: 'note', text: 'They come off its waitlist.' }] : []),
          ],
        }),
        result: { waiting: true, customer: name, session, seats },
      };
    }
    const seat = booked(a).find((p) => p.personId === personId);
    if (!seat) throw HfosError.notFound('They aren’t booked on this.');
    const first = firstName(seat.fullName);
    const next = (a.waitlist ?? []).filter((w) => w.status === 'waiting');
    return {
      card: card(toolCallId, 'manage_attendees', {
        personId,
        title: `Take ${first} off the ${whatOf(a)}?`,
        fields: [
          { label: 'Customer', value: seat.fullName },
          { label: 'Session', value: session },
          {
            label: 'Seats',
            value: `${a.seatsTaken} of ${a.capacity} taken → ${Math.max(0, a.seatsTaken - seat.seats)} of ${a.capacity}`,
          },
          {
            label: `Tell ${first}`,
            value: tellValue(seat, notify, canText, 'that they’re off it'),
          },
        ],
        confirmLabel: 'Take them off',
        warnings: [
          ...(notify && reachOf(seat, canText)
            ? [{ kind: 'caution', text: `${first} is told it’s cancelled for them.` }]
            : []),
          ...(calendar.config.waitlist.enabled && next.length && a.status === 'scheduled'
            ? [
                {
                  kind: 'note',
                  text: `The seat goes to ${firstName(next[0]!.fullName)}, first on its waitlist, who is booked in and told.`,
                },
              ]
            : []),
        ],
      }),
      result: { waiting: true, customer: seat.fullName, session },
    };
  },

  async commit(db, ctx, args) {
    const act = String(args['action']);
    const personId = String(args['personId']);
    const notify = args['tellCustomer'] !== false;
    const { a, calendar } = await sessionFor(db, ctx, args);
    const tz = calendar.timezone;
    const href = calendarPath(ctx.workspaceId, {
      date: localDateOf(Date.parse(a.startsAt), tz),
      appt: a.id,
    });
    if (act === 'add') {
      const out = await command<{ seatsTaken: number; capacity: number }>(
        db,
        ctx,
        'appointment.add_attendee',
        { appointmentId: a.id, personId, seats: args['seats'] ?? 1, notify },
      );
      // Booked by hand from the waitlist: their wait is over, so the next freed seat skips them.
      const entry = (a.waitlist ?? []).find((w) => w.personId === personId);
      if (entry) await command(db, ctx, 'waitlist.remove', { entryId: entry.id });
      return {
        outcome: `Added. ${out.seatsTaken} of ${out.capacity} seats taken.`,
        href,
        command: 'appointment.add_attendee',
      };
    }
    const out = await command<{ seatsTaken: number }>(db, ctx, 'appointment.remove_attendee', {
      appointmentId: a.id,
      personId,
      notify,
    });
    return {
      outcome: `Taken off. ${out.seatsTaken} of ${a.capacity} seats taken.`,
      href,
      command: 'appointment.remove_attendee',
    };
  },
};

// ---------- repeat visits ----------

const REPEATS = {
  weekly: { label: 'Every week', freq: 'weekly', interval: 1 },
  every_2_weeks: { label: 'Every 2 weeks', freq: 'weekly', interval: 2 },
  monthly: { label: 'Every month', freq: 'monthly_date', interval: 1 },
} as const;
type RepeatKey = keyof typeof REPEATS;

const need = (args: Args, keys: string[]) => {
  const missing = keys.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length)
    throw HfosError.validation(
      missing.map((path) => ({ path, message: 'Needed for this.' })),
      `Say ${missing.join(', ')}.`,
    );
};

/** "123 Main St, Houston, TX 77002" from a customer's address, when it has a street. */
function addressLine(a: PersonGet['person']['address']): string | null {
  if (!a.line1) return null;
  return [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}

/** What series.create gets: the first visit's local date and time, the repeat, and the customer's street. */
function seriesInput(args: Args, calendar: CalendarFull['calendar'], person: PersonGet['person']) {
  const tz = calendar.timezone;
  const start = Date.parse(String(args['firstVisit']));
  const at = zonedParts(start, tz);
  const repeat = REPEATS[args['repeats'] as RepeatKey];
  // A calendar that goes to customers books at their address, as the booking dialog fills it in.
  const visits = calendar.config.locations.options[0]?.kind === 'customer_address';
  const address = visits ? addressLine(person.address) : null;
  return defined({
    calendarId: calendar.id,
    firstDate: localDateOf(start, tz),
    rule: {
      freq: repeat.freq,
      interval: repeat.interval,
      weekdays: [],
      count: args['visits'],
      until: null,
      localTime: `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`,
    },
    durationMinutes: args['durationMinutes'],
    serviceId: str(args['serviceId']),
    userIds: calendar.config.team.assignment === 'none' ? undefined : args['userIds'],
    personId: person.id,
    partySize: 1,
    notes: str(args['notes']),
    location: address
      ? {
          kind: 'customer_address',
          address,
          meetingUrl: null,
          postalCode: person.address.postalCode,
        }
      : undefined,
    leadId: str(args['leadId']),
    customRecordId: str(args['customRecordId']),
    notify: args['tellCustomer'] !== false,
  });
}

interface SeriesOut {
  seriesId: string;
  appointmentIds: string[];
  skipped: { occurrence: number; date: string; startsAt: string; reason: string }[];
}

/** Checks the calendar allows it, then the series input. */
async function seriesPlan(db: Db, ctx: ToolContext, args: Args) {
  need(args, ['calendarId', 'personId', 'firstVisit', 'repeats', 'visits']);
  const [{ calendar }, person] = await Promise.all([
    calendarOf(db, ctx, args['calendarId']),
    personOf(db, ctx, args['personId']),
  ]);
  const { config } = calendar;
  if (config.schedule.mode === 'sessions')
    throw HfosError.rule(
      'series_sessions',
      409,
      `${calendar.name} books fixed sessions. Repeat visits are for one-customer bookings.`,
    );
  if (!config.recurring.staffSeries)
    throw HfosError.rule(
      'series_off',
      409,
      `Repeats are off for ${calendar.name}. Turn on “Staff can repeat visits” in its settings first.`,
    );
  const max = config.recurring.maxOccurrences;
  if (Number(args['visits']) > max)
    throw HfosError.validation(
      [{ path: 'visits', message: `At most ${max} visits in a series here.` }],
      `${calendar.name} books at most ${max} visits in a series.`,
    );
  return { calendar, person, input: seriesInput(args, calendar, person) };
}

const skippedLine = (s: SeriesOut['skipped'], tz: string) =>
  s
    .map((k) => `${dayLabel(Date.parse(k.startsAt), tz)} (${k.reason.replace(/\.$/, '')})`)
    .join('; ');

const SCOPES = { this: 'this', this_and_following: 'following', all_upcoming: 'all' } as const;
const SCOPE_WORDS = {
  this: 'Just this one',
  this_and_following: 'This one and the ones after it',
  all_upcoming: 'Every upcoming one',
} as const;

const manageRepeatVisits: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    if (args['action'] === 'cancel') return prepareSeriesCancel(db, ctx, args, toolCallId);
    const { calendar, person, input } = await seriesPlan(db, ctx, args);
    const tz = calendar.timezone;
    const [dry, canText] = await Promise.all([
      dryRun(db, async (tx) => {
        const out = await command<SeriesOut>(tx, ctx, 'series.create', input);
        const first = await appointmentOf(tx, ctx, out.appointmentIds[0]);
        const last = await appointmentOf(tx, ctx, out.appointmentIds.at(-1));
        return { out, first, last };
      }),
      textingReady(db, ctx),
    ]);
    const { out, first, last } = dry;
    const n = out.appointmentIds.length;
    const who = firstName(person.fullName);
    const start = Date.parse(first.startsAt);
    const repeat = REPEATS[args['repeats'] as RepeatKey];
    const notify = args['tellCustomer'] !== false;
    const seat = first.attendees.find((p) => p.personId === person.id);
    const where = whereOf(first.location);
    const warnings: Warning[] = [];
    if (out.skipped.length)
      warnings.push({
        kind: 'caution',
        text: `${plural(out.skipped.length, 'date')} ${out.skipped.length === 1 ? 'doesn’t' : 'don’t'} fit and won’t be booked.`,
      });
    if (notify && reachOf(seat, canText))
      warnings.push({
        kind: 'caution',
        text: `${who} is sent the first visit’s confirmation now.`,
      });
    return {
      card: card(toolCallId, 'manage_repeat_visits', {
        personId: person.id,
        title: `Book ${plural(n, 'visit')} for ${who}?`,
        fields: [
          { label: 'Customer', value: [person.fullName, person.phone].filter(Boolean).join(' · ') },
          {
            label: 'What',
            value: `${whatOf(first)} · ${formatDuration(Math.round((Date.parse(first.endsAt) - start) / MIN))}`,
          },
          {
            label: 'Repeats',
            value: `${repeat.label} from ${atLabel(start, tz)} ${zoneLabel(tz, start)}`,
          },
          {
            label: 'Visits',
            value: `${n} of ${String(args['visits'])}${n > 1 ? `, the last on ${dayLabel(Date.parse(last.startsAt), tz)}` : ''}`,
          },
          ...(staffOf(first).length ? [{ label: 'With', value: joinAnd(staffOf(first)) }] : []),
          ...(where ? [{ label: 'Where', value: where }] : []),
          ...(out.skipped.length
            ? [{ label: 'Won’t be booked', value: clip(skippedLine(out.skipped, tz), 300) }]
            : []),
          {
            label: `Tell ${who}`,
            value: tellValue(seat, notify, canText, 'with the first visit’s details'),
          },
        ],
        confirmLabel: `Book ${plural(n, 'visit')}`,
        warnings,
      }),
      result: {
        waiting: true,
        customer: person.fullName,
        visits: n,
        from: atLabel(start, tz),
        skipped: out.skipped.map((k) => ({
          date: dayLabel(Date.parse(k.startsAt), tz),
          why: k.reason,
        })),
      },
    };
  },

  async commit(db, ctx, args) {
    if (args['action'] === 'cancel') return commitSeriesCancel(db, ctx, args);
    const { calendar, input } = await seriesPlan(db, ctx, args);
    const tz = calendar.timezone;
    const out = await command<SeriesOut>(db, ctx, 'series.create', input);
    const first = await appointmentOf(db, ctx, out.appointmentIds[0]);
    const start = Date.parse(first.startsAt);
    const repeat = REPEATS[args['repeats'] as RepeatKey];
    const skipped = out.skipped.length
      ? ` ${out.skipped.length === 1 ? 'One date didn’t fit and wasn’t booked' : `${out.skipped.length} dates didn’t fit and weren’t booked`}: ${skippedLine(out.skipped, tz)}.`
      : '';
    return {
      outcome: `Booked ${plural(out.appointmentIds.length, 'visit')}, ${repeat.label.toLowerCase()} from ${atLabel(start, tz)}.${skipped}`,
      href: calendarPath(ctx.workspaceId, { date: localDateOf(start, tz), appt: first.id }),
      command: 'series.create',
    };
  },
};

async function seriesCancelPlan(db: Db, ctx: ToolContext, args: Args) {
  need(args, ['appointmentId', 'which']);
  const a = await appointmentOf(db, ctx, args['appointmentId']);
  if (!a.seriesId)
    throw HfosError.validation(
      [{ path: 'appointmentId', message: 'That appointment isn’t part of a series.' }],
      'That appointment isn’t part of a series. Cancel it on its own instead.',
    );
  const which = args['which'] as keyof typeof SCOPES;
  return {
    a,
    which,
    input: {
      appointmentId: a.id,
      scope: SCOPES[which],
      reason: str(args['reason']) ?? null,
      // One notice a customer: their first cancelled visit, and how many after it went too.
      notify: args['tellCustomer'] !== false,
    },
  };
}

async function prepareSeriesCancel(db: Db, ctx: ToolContext, args: Args, toolCallId: string) {
  const { a, which, input } = await seriesCancelPlan(db, ctx, args);
  const { calendar } = await calendarOf(db, ctx, a.calendar.id);
  const tz = calendar.timezone;
  const { cancelled, first, last } = await dryRun(db, async (tx) => {
    const out = await command<{ cancelled: string[] }>(tx, ctx, 'series.cancel', input);
    if (!out.cancelled.length) return { cancelled: [] as string[], first: null, last: null };
    return {
      cancelled: out.cancelled,
      first: await appointmentOf(tx, ctx, out.cancelled[0]),
      last: await appointmentOf(tx, ctx, out.cancelled.at(-1)),
    };
  });
  if (!cancelled.length || !first || !last)
    throw HfosError.rule('nothing_to_cancel', 409, 'There are no visits left in it to cancel.');
  const n = cancelled.length;
  const { name, first: who } = whose(a);
  const reason = str(args['reason']);
  const from = Date.parse(first.startsAt);
  const canText = await textingReady(db, ctx);
  // The dry run has cancelled `first` already; the visit asked about still has them booked.
  const seat = booked(a)[0];
  const tell = tellValue(
    seat,
    input.notify,
    canText,
    n === 1 ? 'that it’s cancelled' : `that these ${n} visits are cancelled`,
  );
  const told = input.notify && !!reachOf(seat, canText);
  return {
    card: card(toolCallId, 'manage_repeat_visits', {
      personId: booked(a)[0]?.personId ?? null,
      title: n === 1 ? `Cancel one visit of ${name}?` : `Cancel ${n} visits of ${name}?`,
      fields: [
        { label: 'Which', value: SCOPE_WORDS[which] },
        {
          label: 'Visits',
          value:
            n === 1
              ? atLabel(from, tz)
              : `${n}: ${dayLabel(from, tz)} to ${dayLabel(Date.parse(last.startsAt), tz)}`,
        },
        ...(a.series ? [{ label: 'Series', value: repeatWords(a.series.rule) }] : []),
        ...(staffOf(a).length ? [{ label: 'With', value: joinAnd(staffOf(a)) }] : []),
        ...(reason ? [{ label: 'Reason', value: reason }] : []),
        ...(who ? [{ label: `Tell ${who}`, value: tell }] : []),
      ],
      confirmLabel: n === 1 ? 'Cancel the visit' : `Cancel ${n} visits`,
      warnings: [
        ...(told
          ? [
              {
                kind: 'caution',
                text: `${who ?? 'The customer'} is sent one notice now, not one for each visit.`,
              },
            ]
          : []),
        { kind: 'note', text: 'They stay in the customer’s history as cancelled.' },
      ],
    }),
    result: {
      waiting: true,
      visits: n,
      from: atLabel(from, tz),
      to: atLabel(Date.parse(last.startsAt), tz),
      customerIsTold: told,
    },
  };
}

async function commitSeriesCancel(db: Db, ctx: ToolContext, args: Args) {
  const { input } = await seriesCancelPlan(db, ctx, args);
  const out = await command<{ cancelled: string[] }>(db, ctx, 'series.cancel', input);
  return {
    outcome: out.cancelled.length
      ? `Cancelled ${plural(out.cancelled.length, 'visit')}.`
      : 'There was nothing left to cancel.',
    href: calendarPath(ctx.workspaceId),
    command: 'series.cancel',
  };
}

// ---------- the waitlist ----------

async function waitlistAddPlan(db: Db, ctx: ToolContext, args: Args) {
  need(args, ['calendarId', 'personId']);
  const [{ calendar }, person] = await Promise.all([
    calendarOf(db, ctx, args['calendarId']),
    personOf(db, ctx, args['personId']),
  ]);
  if (!calendar.config.waitlist.enabled)
    throw HfosError.rule(
      'waitlist_off',
      409,
      `${calendar.name}’s waitlist is off. Turn it on in its settings first.`,
    );
  const seats = Number(args['seats'] ?? 1);
  if (str(args['appointmentId'])) {
    const a = await appointmentOf(db, ctx, args['appointmentId']);
    if (a.calendar.id !== calendar.id)
      throw HfosError.notFound('That session isn’t on this calendar.');
    if (!isGroup(a))
      throw HfosError.rule(
        'not_a_session',
        409,
        'Only a group session has seats to wait for. For a one-customer time, give the window they want.',
      );
    if (a.status !== 'scheduled')
      throw HfosError.rule('appointment_not_scheduled', 409, 'That session isn’t on any more.');
    if (booked(a).some((p) => p.personId === person.id))
      throw HfosError.rule('already_booked', 409, 'They’re already on it.');
    return {
      calendar,
      person,
      a,
      window: null,
      seats,
      input: { calendarId: calendar.id, appointmentId: a.id, personId: person.id, seats } as Args,
    };
  }
  need(args, ['wantedFrom', 'wantedTo']);
  const window = {
    from: Date.parse(String(args['wantedFrom'])),
    to: Date.parse(String(args['wantedTo'])),
  };
  // waitlist.add itself refuses a window that ends before it starts or has already passed, in plain words the
  // Assistant passes on as they are (the dry run in prepare, the command in commit).
  return {
    calendar,
    person,
    a: null,
    window,
    seats,
    input: {
      calendarId: calendar.id,
      personId: person.id,
      wantedFrom: iso(window.from),
      wantedTo: iso(window.to),
      seats,
    } as Args,
  };
}

/**
 * Who comes off: someone waiting for a session, found on it, or any entry by its id on its calendar's waitlist
 * (the only place someone waiting for a window of time shows).
 */
async function waitlistRemovePlan(db: Db, ctx: ToolContext, args: Args) {
  if (!str(args['appointmentId'])) {
    need(args, ['calendarId', 'entryId']);
    const { calendar } = await calendarOf(db, ctx, args['calendarId']);
    const entry = (await waitlistOf(db, ctx, calendar.id)).find((w) => w.id === args['entryId']);
    if (!entry) throw HfosError.notFound('They aren’t on this calendar’s waitlist.');
    return {
      entry,
      waitingFor: waitingFor(entry, calendar.timezone),
      href: entry.appointment
        ? calendarPath(ctx.workspaceId)
        : `/app/w/${ctx.workspaceId}/settings/calendars/${calendar.id}`,
    };
  }
  const a = await appointmentOf(db, ctx, args['appointmentId']);
  const entry = (a.waitlist ?? []).find((w) =>
    str(args['entryId']) ? w.id === args['entryId'] : w.personId === args['personId'],
  );
  if (!entry) throw HfosError.notFound('They aren’t on this session’s waitlist.');
  const { calendar } = await calendarOf(db, ctx, a.calendar.id);
  const when = rangeLabel(Date.parse(a.startsAt), Date.parse(a.endsAt), calendar.timezone);
  return { entry, waitingFor: `${whatOf(a)} · ${when}`, href: calendarPath(ctx.workspaceId) };
}

const manageWaitlist: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    if (args['action'] === 'remove') {
      const { entry, waitingFor: what } = await waitlistRemovePlan(db, ctx, args);
      const first = firstName(entry.fullName);
      return {
        card: card(toolCallId, 'manage_waitlist', {
          personId: entry.personId,
          title: `Take ${first} off the waitlist?`,
          fields: [
            { label: 'Customer', value: entry.fullName },
            { label: 'Waiting for', value: what },
            ...(entry.seats > 1 ? [{ label: 'Seats', value: String(entry.seats) }] : []),
          ],
          confirmLabel: 'Take them off',
          warnings: [
            { kind: 'note', text: `Nothing is sent to ${first}.` },
            ...(entry.status === 'offered'
              ? [
                  {
                    kind: 'note',
                    text: `The time held for ${first} goes to the next person waiting for it.`,
                  },
                ]
              : []),
          ],
        }),
        result: { waiting: true, customer: entry.fullName, waitingFor: what },
      };
    }
    const { calendar, person, a, window, seats, input } = await waitlistAddPlan(db, ctx, args);
    const tz = calendar.timezone;
    // The command's own answer, rolled back: it refuses what the screen would (already waiting, and so on).
    await dryRun(db, (tx) => command(tx, ctx, 'waitlist.add', input));
    const first = firstName(person.fullName);
    const c = calendar.config;
    const offersGo = c.schedule.mode === 'hours' && c.public && calendar.status === 'active';
    const inLine = a ? (a.waitlist ?? []).filter((w) => w.personId !== person.id).length + 1 : null;
    const room = a ? a.capacity - a.seatsTaken : 0;
    const warnings: Warning[] = [{ kind: 'note', text: `Nothing is sent to ${first} now.` }];
    if (a && room >= seats)
      warnings.push({
        kind: 'note',
        text: `There’s room on it now, so I could add ${first} straight on instead.`,
      });
    // A freed 1:1 time is offered only on a calendar customers book online, and while Automations offers them.
    const switchedOn =
      a ||
      (await query<{ workspace: { settings: Record<string, unknown> | null } }>(
        db,
        ctx,
        'workspace.get',
      )
        .then((w) => automationSettingsOf(w.workspace.settings).switches.waitlist)
        .catch(() => true));
    if (!a && !offersGo)
      warnings.push({
        kind: 'caution',
        text: `${calendar.name} isn’t booked online, so freed times aren’t offered to anyone waiting.`,
      });
    else if (!switchedOn)
      warnings.push({
        kind: 'caution',
        text: 'Waitlist slot opened is off in Settings → Automations, so freed times aren’t offered.',
      });
    return {
      card: card(toolCallId, 'manage_waitlist', {
        personId: person.id,
        title: `Put ${first} on the waitlist?`,
        fields: [
          { label: 'Customer', value: person.fullName },
          { label: 'Calendar', value: calendar.name },
          {
            label: 'Waiting for',
            value: a
              ? `${whatOf(a)} · ${rangeLabel(Date.parse(a.startsAt), Date.parse(a.endsAt), tz)}`
              : `Any time ${rangeLabel(window!.from, window!.to, tz)}`,
          },
          ...(seats > 1 ? [{ label: 'Seats', value: String(seats) }] : []),
          ...(inLine ? [{ label: 'Place in line', value: ordinal(inLine) }] : []),
          {
            label: 'Then',
            value: a
              ? 'When a seat opens they’re booked in and told'
              : `When a time in it frees up, it’s offered to them for ${formatDuration(c.waitlist.offerMinutes)}`,
          },
        ],
        confirmLabel: 'Add to the waitlist',
        warnings,
      }),
      result: {
        waiting: true,
        customer: person.fullName,
        ...(inLine ? { placeInLine: inLine } : {}),
      },
    };
  },

  async commit(db, ctx, args) {
    const href = calendarPath(ctx.workspaceId);
    if (args['action'] === 'remove') {
      const { entry, href: where } = await waitlistRemovePlan(db, ctx, args);
      await command(db, ctx, 'waitlist.remove', { entryId: entry.id });
      return {
        outcome: `Took ${firstName(entry.fullName)} off the waitlist.`,
        href: where,
        command: 'waitlist.remove',
      };
    }
    const { person, a, input } = await waitlistAddPlan(db, ctx, args);
    await command(db, ctx, 'waitlist.add', input);
    return {
      outcome: `${firstName(person.fullName)} is on the waitlist${a ? ` for the ${whatOf(a)}` : ''}.`,
      href,
      command: 'waitlist.add',
    };
  },
};

// ---------- the calendar's other sections ----------

const OWNER_WORDS: Record<CalendarConfig['crm']['ownership'], string> = {
  assigned_staff: 'who_takes_the_booking',
  calendar_owner: 'calendar_owner',
  none: 'nobody',
};
const OWNERSHIP: Record<string, CalendarConfig['crm']['ownership']> = {
  who_takes_the_booking: 'assigned_staff',
  calendar_owner: 'calendar_owner',
  nobody: 'none',
};

interface Pipeline {
  id: string;
  name: string;
  archivedAt: string | null;
  stages: { id: string; name: string; kind: string }[];
}
const pipelinesOf = (db: Db, ctx: ToolContext) =>
  query<{ pipelines: Pipeline[] }>(db, ctx, 'pipeline.list')
    .then((p) => p.pipelines)
    .catch(() => null);

type Section = Record<string, unknown> | undefined;
const section = (args: Args, key: string) => args[key] as Section;
/** Keeps a patch section only when something in it is set. */
const some = (o: Record<string, unknown>) => {
  const kept = defined(o);
  return Object.keys(kept).length ? kept : undefined;
};

/**
 * The model's plain values as a patch on the calendar's settings. Lists replace the whole list (as the builder
 * saves them); a question given without an id keeps the id of the one with the same wording, so its answers stay.
 */
async function settingsPatch(
  db: Db,
  ctx: ToolContext,
  args: Args,
  config: CalendarConfig,
): Promise<ConfigPatch> {
  const patch: Record<string, unknown> = {};
  const cap = section(args, 'capacity');
  if (cap)
    patch['capacity'] = some({
      seats: cap['seatsPerTime'],
      maxPartySize: cap['largestGroup'],
      showSeatsLeft: cap['showSeatsLeft'],
    });
  const loc = section(args, 'locations');
  if (loc)
    patch['locations'] = some({
      options: Array.isArray(loc['places'])
        ? (loc['places'] as Args[]).map((p) => ({
            kind: p['kind'],
            address: p['kind'] === 'business' ? (str(p['address']) ?? null) : null,
            meetingUrl: p['kind'] === 'virtual' ? (str(p['meetingLink']) ?? null) : null,
          }))
        : undefined,
      customerChooses: loc['customerPicks'],
    });
  const zip = section(args, 'zipRouting');
  if (zip)
    patch['territory'] = some({
      routing: typeof zip['on'] === 'boolean' ? (zip['on'] ? 'zip' : 'off') : undefined,
      territoryIds: zip['territoryIds'],
    });
  const rep = section(args, 'repeats');
  if (rep)
    patch['recurring'] = some({
      staffSeries: rep['staffCanRepeat'],
      customerSeries: rep['customersCanRepeat'],
      maxOccurrences: rep['mostVisits'],
    });
  const wait = section(args, 'waitlist');
  if (wait)
    patch['waitlist'] = some({ enabled: wait['on'], offerMinutes: wait['offersLastMinutes'] });
  if (Array.isArray(args['questions'])) {
    const used = new Set<string>();
    patch['intake'] = {
      questions: (args['questions'] as Args[]).map((q) => {
        const label = String(q['label']);
        const old =
          config.intake.questions.find((x) => x.id === q['id']) ??
          config.intake.questions.find((x) => x.label.toLowerCase() === label.toLowerCase());
        let id = str(q['id']) ?? old?.id ?? `q${Math.random().toString(36).slice(2, 8)}`;
        while (used.has(id)) id = `q${Math.random().toString(36).slice(2, 8)}`;
        used.add(id);
        const choices = q['kind'] === 'select' || q['kind'] === 'multi_select';
        return {
          id,
          label,
          kind: q['kind'],
          required: q['required'] === true,
          options: choices ? ((q['choices'] as string[] | undefined) ?? old?.options ?? []) : [],
        };
      }),
    };
  }
  const rules = section(args, 'changeRules');
  if (rules)
    patch['policies'] = some({
      cancel: some({
        allowed: rules['customersCanCancel'],
        cutoffHours: rules['cancelUpToHoursBefore'],
      }),
      reschedule: some({
        allowed: rules['customersCanReschedule'],
        cutoffHours: rules['rescheduleUpToHoursBefore'],
        maxTimes: rules['mostReschedules'],
      }),
      policyText: typeof rules['policyText'] === 'string' ? rules['policyText'] : undefined,
    });
  const n = section(args, 'notifications');
  if (n)
    patch['notifications'] = some({
      confirmation: some({ text: n['confirmationByText'], email: n['confirmationByEmail'] }),
      reminders: n['reminders'],
      reminderChannels: some({ text: n['remindersByText'], email: n['remindersByEmail'] }),
      staffEmail: n['emailTeamOnNewBooking'],
    });
  const crm = section(args, 'crm');
  if (crm) {
    let createLead: unknown = undefined;
    const lead = crm['createLead'] as { pipelineId: string; stageId?: string } | null | undefined;
    if (lead === null) createLead = null;
    else if (lead) {
      let stageId = lead.stageId;
      if (!stageId) {
        // The first open stage, as the builder's switch picks it.
        const pipeline = (await pipelinesOf(db, ctx))?.find((p) => p.id === lead.pipelineId);
        stageId = (pipeline?.stages.find((s) => s.kind === 'open') ?? pipeline?.stages[0])?.id;
        if (!stageId)
          throw HfosError.validation(
            [{ path: 'crm.createLead.pipelineId', message: 'That pipeline isn’t there.' }],
            'Pick a pipeline from get_settings (pipelines).',
          );
      }
      createLead = { pipelineId: lead.pipelineId, stageId };
    }
    patch['crm'] = some({
      ownership: crm['customerOwner'] ? OWNERSHIP[String(crm['customerOwner'])] : undefined,
      assignContactOwner: crm['setOwnerWhenNone'],
      createLead,
    });
  }
  const pay = section(args, 'payments');
  if (pay) {
    const percent = pay['depositPercent'] as number | undefined;
    const amount = pay['depositDollars'] as number | undefined;
    if (
      [percent, amount, pay['useBusinessDeposit'] === true ? 1 : undefined].filter(
        (v) => v !== undefined,
      ).length > 1
    )
      throw HfosError.validation(
        [
          {
            path: 'payments',
            message: 'Give a percent, a dollar amount, or the business’s deposit.',
          },
        ],
        'Pick one kind of deposit.',
      );
    patch['payments'] = some({
      mode: pay['take'],
      deposit:
        pay['useBusinessDeposit'] === true
          ? null
          : percent !== undefined
            ? { kind: 'percent', percentBp: Math.round(percent * 100) }
            : amount !== undefined
              ? { kind: 'amount', amountCents: Math.round(amount * 100) }
              : undefined,
      connectionId: pay['accountId'],
    });
  }
  return defined(patch) as ConfigPatch;
}

/** The patch applied; a new deposit replaces the old one whole rather than merging into it. */
function draftOf(config: CalendarConfig, patch: ConfigPatch): CalendarConfig {
  try {
    const deposit = (patch as { payments?: { deposit?: unknown } }).payments?.deposit;
    const base = deposit ? applyPatch(config, { payments: { deposit: null } }) : config;
    return applyPatch(base, patch);
  } catch (e) {
    const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    if (!issues) throw e;
    throw HfosError.validation(
      issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      issues[0]?.message ?? 'Some settings need attention.',
    );
  }
}

type Decisions = Record<string, 'keep'>;
/**
 * Runs a save; when it touches visits already booked, runs it again keeping them as they are — the answer the
 * impact review always allows, so a settings change never moves or cancels someone's appointment.
 */
async function keepingBooked<T>(
  run: (decisions: Decisions) => Promise<T>,
): Promise<{ out: T; kept: number }> {
  try {
    return { out: await run({}), kept: 0 };
  } catch (e) {
    const impacts = (e as { details?: { impacts?: { key: string }[] } })?.details?.impacts;
    if (!impacts?.length) throw e;
    const decisions = Object.fromEntries(impacts.map((i) => [i.key, 'keep'])) as Decisions;
    return { out: await run(decisions), kept: impacts.length };
  }
}

interface SaveOut {
  revision: number;
  diff: string[];
  issues: { severity: 'error' | 'warning'; message: string }[];
}

/** The save (or restore) Confirm runs, on the revision the calendar is at now. */
async function saveSettings(
  db: Db,
  ctx: ToolContext,
  args: Args,
): Promise<{
  out: SaveOut;
  kept: number;
  calendar: CalendarFull['calendar'];
  draft: CalendarConfig | null;
}> {
  const { calendar } = await calendarOf(db, ctx, args['calendarId']);
  if (args['action'] === 'restore') {
    need(args, ['revision']);
    if (args['revision'] === calendar.revision)
      throw HfosError.validation([], 'That’s the version it’s on now.');
    const { out, kept } = await keepingBooked((impactDecisions) =>
      command<SaveOut>(db, ctx, 'calendar.restore_revision', {
        calendarId: calendar.id,
        revision: args['revision'],
        baseRevision: calendar.revision,
        impactDecisions,
      }),
    );
    return { out, kept, calendar, draft: null };
  }
  const patch = await settingsPatch(db, ctx, args, calendar.config);
  if (!Object.keys(patch).length) throw nothingChanges();
  const draft = draftOf(calendar.config, patch);
  const { out, kept } = await keepingBooked((impactDecisions) =>
    command<SaveOut>(db, ctx, 'calendar.save', {
      calendarId: calendar.id,
      baseRevision: calendar.revision,
      draft,
      impactDecisions,
    }),
  );
  return { out, kept, calendar, draft };
}

/** "Seats: 1 → 10" as a card row; a line with no before and after ("Added question “Gate code”") as a change. */
const diffField = (line: string): Field => {
  const at = line.indexOf(': ');
  return at > 0 && line.includes(' → ')
    ? { label: line.slice(0, at), value: line.slice(at + 2) }
    : { label: 'Change', value: line };
};

/** Who hears what less, and what starts costing customers money: said before anyone presses Confirm. */
function settingsWarnings(before: CalendarConfig, after: CalendarConfig | null): Warning[] {
  if (!after) return [];
  const out: Warning[] = [];
  const pay = after.payments;
  if (
    pay.mode !== 'none' &&
    (before.payments.mode !== pay.mode ||
      JSON.stringify(before.payments.deposit) !== JSON.stringify(pay.deposit))
  )
    out.push({
      kind: 'caution',
      text:
        pay.mode === 'full'
          ? 'Customers pay the full price when they book online. The time is held while they pay.'
          : 'Customers pay a deposit when they book online. The time is held while they pay.',
    });
  const n = after.notifications;
  const was = before.notifications;
  const quiet =
    (was.confirmation.text || was.confirmation.email) &&
    !n.confirmation.text &&
    !n.confirmation.email
      ? 'a confirmation'
      : was.reminders.length && !n.reminders.length
        ? 'reminders'
        : null;
  if (quiet)
    out.push({ kind: 'caution', text: `Customers won’t get ${quiet} from this calendar.` });
  if (
    !before.waitlist.enabled &&
    after.waitlist.enabled &&
    after.schedule.mode === 'hours' &&
    !after.public
  )
    out.push({
      kind: 'note',
      text: 'Freed times are only offered to people waiting on a calendar customers can book online.',
    });
  return out;
}

const updateCalendarSettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { calendar: current } = await calendarOf(db, ctx, args['calendarId']);
    const restoring = args['action'] === 'restore';
    const title = restoring
      ? `Put ${current.name} back to version ${String(args['revision'])}?`
      : `Change ${current.name}?`;
    let dry: Awaited<ReturnType<typeof saveSettings>>;
    try {
      dry = await dryRun(db, (tx) => saveSettings(tx, ctx, args));
    } catch (e) {
      // An active calendar can't be saved with settings that stop it booking: the builder refuses too.
      const issues =
        (e as { rule?: string; details?: { issues?: SaveOut['issues'] } }).rule ===
        'calendar_issues'
          ? ((e as { details?: { issues?: SaveOut['issues'] } }).details?.issues ?? [])
          : null;
      if (!issues) throw e;
      const blocking = issues.filter((i) => i.severity === 'error');
      const draft = restoring
        ? null
        : draftOf(current.config, await settingsPatch(db, ctx, args, current.config));
      const diff = draft ? diffConfigs(current.config, draft) : [];
      return {
        card: card(toolCallId, 'update_calendar_settings', {
          title,
          fields: [{ label: 'Calendar', value: current.name }, ...diff.slice(0, 9).map(diffField)],
          confirmLabel: '',
          warnings: blocking
            .slice(0, 3)
            .map((i) => ({ kind: 'blocked', text: sentence(i.message) })),
        }),
        result: {
          blocked: true,
          why: `${current.name} is taking bookings, and this would leave settings it can’t book with: ${blocking.map((i) => sentence(i.message)).join(' ')}`,
        },
      };
    }
    const { out, kept, draft } = dry;
    const diff = out.diff.filter((l) => !/^Restored revision/.test(l));
    if (!diff.length) throw nothingChanges();
    const fields =
      diff.length > 9
        ? [
            ...diff.slice(0, 8).map(diffField),
            { label: 'And', value: `${diff.length - 8} more changes` },
          ]
        : diff.map(diffField);
    const warnings: Warning[] = [
      ...settingsWarnings(current.config, draft),
      ...out.issues
        .filter((i) => !current.issues.some((c) => c.message === i.message))
        .map((i) => ({
          kind: i.severity === 'error' ? 'caution' : 'note',
          text: sentence(i.message),
        })),
      ...(kept
        ? [{ kind: 'note', text: 'Visits already booked keep the settings they were booked with.' }]
        : []),
      ...(restoring
        ? [{ kind: 'note', text: 'The booking link and appointments stay the same.' }]
        : []),
    ];
    return {
      card: card(toolCallId, 'update_calendar_settings', {
        title,
        fields: [{ label: 'Calendar', value: current.name }, ...fields],
        confirmLabel: restoring ? 'Restore it' : 'Save the change',
        warnings,
      }),
      result: { waiting: true, calendar: current.name, changes: diff },
    };
  },

  async commit(db, ctx, args) {
    const { out, calendar } = await saveSettings(db, ctx, args);
    const restoring = args['action'] === 'restore';
    return {
      outcome: restoring
        ? `${calendar.name} is back to version ${String(args['revision'])}, saved as version ${out.revision}.`
        : `${calendar.name} is changed.`,
      href: `/app/w/${ctx.workspaceId}/settings/calendars/${calendar.id}`,
      command: restoring ? 'calendar.restore_revision' : 'calendar.save',
    };
  },
};

export const schedulingConfirmTools: Record<string, SettingsConfirmTool> = {
  update_appointment: updateAppointment,
  update_job_status: updateJobStatus,
  manage_attendees: manageAttendees,
  manage_repeat_visits: manageRepeatVisits,
  manage_waitlist: manageWaitlist,
  update_calendar_settings: updateCalendarSettings,
};

/** What the panel says while each one runs. */
export const schedulingStepLabels: Record<string, string> = {
  list_appointments: 'Looking at appointments',
  get_appointment: 'Looking at the appointment',
  get_calendar_settings: 'Looking at the calendar’s settings',
  get_waitlist: 'Looking at the waitlist',
  update_appointment: 'Getting the change ready',
  update_job_status: 'Getting the job update ready',
  manage_attendees: 'Checking the seats',
  manage_repeat_visits: 'Checking the dates',
  manage_waitlist: 'Checking the waitlist',
  update_calendar_settings: 'Checking the calendar change',
};
