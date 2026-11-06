/**
 * Setting up the calendars by asking (M12, step two): calendars, services, resources, territories and the booking
 * site. Each one runs the command the settings screen runs, as the person, and only once they press Confirm.
 *
 * Changing a calendar is read-patch-save: the calendar is read for its revision and its settings, the patch is
 * applied with core's own `applyPatch`, and the save goes in on that revision — so two people changing a calendar
 * at once is the same 409 the builder gets, not a silent overwrite. The card runs the save first in a transaction
 * that rolls back, so it says what happens to visits already booked: kept, unless the person asked for them to be
 * reassigned or cancelled (`upcomingVisits`), as the builder's Before you save offers.
 */

import {
  applyPatch,
  CALENDAR_COLORS,
  CALENDAR_PRESETS,
  formatNotice,
  HfosError,
  slugify,
  type AssistantCard,
  type CalendarConfig,
  type ConfigPatch,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { Geocoder } from '../geo/geocoder';
import type { CommittedAction, PreparedAction, ToolContext } from './runtime';
import { publicOriginFor } from './full-links';
import { command, query } from './tools-read';

type Args = Record<string, unknown>;
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type Field = { label: string; value: string };

/** What a few settings tools need from the worker: the map, to find an address. */
export interface SettingsDeps {
  readonly geocoder?: Geocoder | null;
  /** The web app's address, which a public page's whole link starts with when the business has no domain of its own. */
  readonly webUrl?: string;
}

export interface SettingsConfirmTool {
  prepare(
    db: Db,
    ctx: ToolContext,
    args: Args,
    toolCallId: string,
    deps?: SettingsDeps,
  ): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    extra: { lostReason?: string; toolCallId: string } & SettingsDeps,
  ): Promise<CommittedAction>;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : undefined);
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const action = (args: Args) => String(args['action'] ?? 'change');

export function settingsCard(
  toolCallId: string,
  tool: string,
  card: {
    title: string;
    fields: Field[];
    confirmLabel: string;
    warnings?: { kind: string; text: string }[];
  },
): ConfirmCard {
  return {
    type: 'confirm',
    toolCallId,
    tool,
    personId: null,
    conversationId: null,
    title: card.title,
    fields: card.fields.filter((f) => f.value).slice(0, 10),
    body: null,
    stageFrom: null,
    stageTo: null,
    warnings: (card.warnings ?? []).slice(0, 3),
    reasons: [],
    confirmLabel: card.confirmLabel,
    editable: false,
  };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
type Hours = { day: number; start: string; end: string }[];

/** "Mon–Fri 8:00 AM–5:00 PM" is more than this needs; a line a day, in the words people use. */
export function hoursLine(hours: Hours | null): string {
  if (hours === null) return 'Each person’s own hours';
  if (!hours.length) return 'Closed';
  return hours.map((h) => `${DAYS[h.day]?.slice(0, 3)} ${h.start}–${h.end}`).join(', ');
}

const dollars = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

interface CalendarGet {
  calendar: {
    id: string;
    name: string;
    slug: string;
    status: string;
    revision: number;
    timezone: string | null;
    config: CalendarConfig;
    /** /book/<site>/<calendar>, or null until the business has a booking site. */
    bookingPath: string | null;
    issues: { severity: 'error' | 'warning'; message: string }[];
  };
}
interface Named {
  id: string;
  name: string;
}

const calendarOf = (db: Db, ctx: ToolContext, id: unknown) =>
  query<CalendarGet>(db, ctx, 'calendar.get', { calendarId: id });

const namesOf = async (
  db: Db,
  ctx: ToolContext,
  queryName: string,
  ids: readonly string[],
): Promise<string> => {
  if (!ids.length) return 'None';
  const out = await query<{ items: Named[] }>(db, ctx, queryName).catch(() => null);
  const items = out?.items ?? [];
  const named = ids.map((id) => items.find((i) => i.id === id)?.name).filter(Boolean);
  return named.length === ids.length ? named.join(', ') : `${ids.length} chosen`;
};

const teamNames = async (db: Db, ctx: ToolContext, ids: readonly string[]) => {
  if (!ids.length) return 'Nobody';
  const team = await query<{ members: { userId: string; fullName: string; email: string }[] }>(
    db,
    ctx,
    'workspace.members',
  ).catch(() => null);
  const named = ids.map(
    (id) =>
      team?.members.find((m) => m.userId === id)?.fullName ??
      team?.members.find((m) => m.userId === id)?.email,
  );
  return named.every(Boolean) ? named.join(', ') : `${ids.length} chosen`;
};

// ---------- a calendar's visits already booked, and the save a card is made from ----------

class RolledBack extends Error {}
/** Runs `fn` in a transaction that always rolls back, so a card shows a command's own answer and nothing is kept. */
export async function dryRun<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
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

/** The calendar rules' and the impact review's messages end without a full stop; a card line has one. */
export const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** A change that touches visits already booked, as the save command reports it, and the answer it got. */
export interface DecidedImpact {
  key: string;
  code: string;
  message: string;
  count: number;
  decisions: string[];
  decision: string;
}

/**
 * Runs a save; when it touches visits already booked, runs it again with the person's answer for each, as Before
 * you save takes it: their `upcomingVisits` where that impact offers it, else keep, which is always allowed. So a
 * change never moves or cancels an appointment unless the person asked for that on the card.
 */
export async function answeringImpacts<T>(
  run: (decisions: Record<string, string>) => Promise<T>,
  choice: unknown,
): Promise<{ out: T; impacts: DecidedImpact[] }> {
  try {
    return { out: await run({}), impacts: [] };
  } catch (e) {
    const impacts = (e as { details?: { impacts?: Omit<DecidedImpact, 'decision'>[] } })?.details
      ?.impacts;
    if (!impacts?.length) throw e;
    const decided = impacts.map((i) => ({
      ...i,
      decision: typeof choice === 'string' && i.decisions.includes(choice) ? choice : 'keep',
    }));
    return {
      out: await run(Object.fromEntries(decided.map((i) => [i.key, i.decision]))),
      impacts: decided,
    };
  }
}

const VISITS_WORDS: Record<string, (code: string) => string> = {
  keep: (code) =>
    code === 'resource_removed'
      ? 'They still hold it; new bookings don’t need it.'
      : code === 'seats_below_booked'
        ? 'Everyone already booked keeps their seat.'
        : 'Those visits stay as they are.',
  reassign: () =>
    'Each goes to someone else on this calendar who’s free, and its customer is told who’s coming instead; any that don’t fit stay as they are.',
  cancel_and_notify: () =>
    'They’re cancelled, and each customer is told by text, or by email if they don’t get texts.',
};

/** How much each answer needs seeing: a cancellation most, then a visit handed on, as both message the customer. */
const VISITS_ORDER: Record<string, number> = { cancel_and_notify: 0, reassign: 1, keep: 2 };

/**
 * What happens to visits already booked, said on the card before anyone presses Confirm. Cancelling and reassigning
 * both message the customers, so they are cautions, and come first.
 */
export function impactWarnings(
  impacts: readonly DecidedImpact[],
): { kind: string; text: string }[] {
  return [...impacts]
    .sort((a, b) => (VISITS_ORDER[a.decision] ?? 2) - (VISITS_ORDER[b.decision] ?? 2))
    .map((i) => ({
      kind: i.decision === 'keep' ? 'note' : 'caution',
      text: `${sentence(i.message)} ${(VISITS_WORDS[i.decision] ?? VISITS_WORDS['keep']!)(i.code)}`,
    }));
}

/** What a save did to visits already booked, as the builder says it after saving; "" when it left them be. */
export function visitsDone(actions: { reassigned: string[]; cancelled: string[] } | undefined) {
  const moved = actions?.reassigned.length ?? 0;
  const cancelled = actions?.cancelled.length ?? 0;
  return [
    moved
      ? `${moved === 1 ? '1 visit' : `${moved} visits`} went to someone else, and the customers are being told who’s coming.`
      : '',
    cancelled
      ? `${cancelled === 1 ? '1 visit was' : `${cancelled} visits were`} cancelled, and the customers are being told.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** A settings document with a patch on it, or a refusal in plain words when the result can't be saved. */
export function patched(config: CalendarConfig, patch: ConfigPatch): CalendarConfig {
  try {
    return applyPatch(config, patch);
  } catch (e) {
    const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    if (!issues) throw e;
    throw HfosError.validation(
      issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      issues[0]?.message ??
        'Some of those settings can’t be saved as they are. Check them and try again.',
    );
  }
}

/** The errors an active calendar can't be saved with, when that is why a save was refused; else null. */
export function blockingIssues(e: unknown): { severity: string; message: string }[] | null {
  const err = e as {
    rule?: string;
    details?: { issues?: { severity: string; message: string }[] };
  };
  return err.rule === 'calendar_issues'
    ? (err.details?.issues ?? []).filter((i) => i.severity === 'error')
    : null;
}

// ---------- manage_calendar ----------

const whichCalendar = () =>
  HfosError.validation(
    [{ path: 'calendarId', message: 'Say which calendar.' }],
    'Say which calendar to change. Each one’s id is in get_settings (calendars).',
  );

const resourceList = (v: unknown) =>
  Array.isArray(v) ? (v as { resourceId: string; quantity?: number }[]) : undefined;
/** null or "" clears it; a word is the new value; left out, it stays. */
const clearable = (v: unknown) => (v === null || v === '' ? null : str(v));
const PRESET_NAMES: Record<string, string> = Object.fromEntries(
  CALENDAR_PRESETS.map((p) => [p.key, p.name]),
);
const colorWords = (hex: string) =>
  CALENDAR_COLORS.find((c) => c.hex === hex.toLowerCase())?.name ?? hex;
const SERVICE_MODE_WORDS = { none: 'off', one: 'one service', choice: 'customers pick' } as const;
const servicesMode = (count: number) => (count > 1 ? 'choice' : count === 1 ? 'one' : 'none');

/** Its name, description, colour and time zone: saved beside its settings, as Name, color and time zone… does. */
const calendarDetails = (args: Args) =>
  defined({
    name: str(args['name']),
    description: clearable(args['description']),
    timezone: clearable(args['timezone']),
    color: str(args['color'])?.toLowerCase(),
  });

/**
 * The parts of a calendar manage_calendar changes, as a patch on its settings as they are now. Lists replace, so
 * someone kept on it is sent with their weight, place in line and Must go, and a service kept with its own settings
 * here (lengths, seats, video): only the people and services added start from the defaults.
 */
function calendarPatch(args: Args, config: CalendarConfig): ConfigPatch {
  const patch: Record<string, unknown> = {};
  const teammates = list(args['teammates']);
  if (teammates) {
    const had = new Map(config.team.members.map((m) => [m.userId, m]));
    patch['team'] = {
      members: [...new Set(teammates)].map((userId) => had.get(userId) ?? { userId }),
    };
  }
  const services = list(args['services']);
  if (services) {
    const had = new Map(config.services.items.map((i) => [i.serviceId, i]));
    const ids = [...new Set(services)];
    patch['services'] = {
      mode: servicesMode(ids.length),
      items: ids.map((serviceId) => had.get(serviceId) ?? { serviceId }),
    };
  }
  const resources = resourceList(args['resources']);
  if (resources) {
    const seen = new Set<string>();
    patch['resources'] = {
      required: resources
        .filter((r) => !seen.has(r.resourceId) && seen.add(r.resourceId))
        .map((r) => ({ resourceId: r.resourceId, quantity: r.quantity ?? 1 })),
    };
  }
  if (args['hours'] !== undefined)
    patch['schedule'] = { hours: (args['hours'] as Hours | null) ?? null };
  const buffers = defined({
    before: num(args['bufferBeforeMinutes']),
    after: num(args['bufferAfterMinutes']),
    travelMinutes: num(args['travelMinutes']),
  });
  if (Object.keys(buffers).length) patch['buffers'] = buffers;
  const window = defined({
    minNoticeMinutes: num(args['minNoticeMinutes']),
    maxDaysAhead: num(args['maxDaysAhead']),
    dateFrom: args['bookOnlyFrom'],
    dateTo: args['bookOnlyTo'],
    dailyLimitPerPerson: args['dailyLimitPerPerson'],
  });
  if (Object.keys(window).length) patch['window'] = window;
  if (typeof args['listedOnBookingSite'] === 'boolean')
    patch['public'] = args['listedOnBookingSite'];
  return patch as ConfigPatch;
}

/** A calendar's whole booking link with its link name changed; just the path when the web app's address isn't known. */
async function newBookingLink(
  db: Db,
  ctx: ToolContext,
  current: CalendarGet['calendar'],
  slug: string,
  webUrl = '',
): Promise<string> {
  if (!current.bookingPath) return `${slug} (once the booking site is set up)`;
  return wholeLink(db, ctx, current.bookingPath.replace(/[^/]+$/, slug), webUrl);
}

/** What the card shows for a change, so someone can see what they are saying yes to. */
async function calendarFields(
  db: Db,
  ctx: ToolContext,
  args: Args,
  current: CalendarGet['calendar'] | null,
  webUrl?: string,
): Promise<Field[]> {
  const fields: Field[] = [];
  const name = str(args['name']);
  if (name) fields.push({ label: 'Name', value: name });
  if (current && name && current.name !== name) fields.push({ label: 'Was', value: current.name });
  if (!current)
    fields.push({ label: 'How it works', value: PRESET_NAMES[str(args['preset']) ?? 'scratch']! });
  const teammates = list(args['teammates']);
  if (teammates) fields.push({ label: 'Who works it', value: await teamNames(db, ctx, teammates) });
  const services = list(args['services']);
  if (services)
    fields.push({
      label: 'What it offers',
      value: services.length
        ? `${await namesOf(db, ctx, 'service.list', services)} (${SERVICE_MODE_WORDS[servicesMode(new Set(services).size)]})`
        : 'No services',
    });
  const resources = resourceList(args['resources']);
  if (resources)
    fields.push({
      label: 'What each booking needs',
      value: needsWords(
        resources.map((r) => ({ resourceId: r.resourceId, quantity: r.quantity ?? 1 })),
        resources.length ? await resourcesOf(db, ctx).catch(() => []) : [],
      ),
    });
  if (args['hours'] !== undefined)
    fields.push({ label: 'Hours', value: hoursLine((args['hours'] as Hours | null) ?? null) });
  const before = num(args['bufferBeforeMinutes']);
  const after = num(args['bufferAfterMinutes']);
  if (before !== undefined || after !== undefined)
    fields.push({
      label: 'Gap around a visit',
      value: [
        before === undefined ? null : `${before} min before`,
        after === undefined ? null : `${after} min after`,
      ]
        .filter(Boolean)
        .join(', '),
    });
  const travel = num(args['travelMinutes']);
  if (travel !== undefined)
    fields.push({ label: 'Travel time', value: travel ? `${travel} min each way` : 'None' });
  const notice = num(args['minNoticeMinutes']);
  if (notice !== undefined)
    fields.push({ label: 'Notice to book', value: notice ? formatNotice(notice) : 'None' });
  const ahead = num(args['maxDaysAhead']);
  if (ahead !== undefined) fields.push({ label: 'Books up to', value: `${ahead} days ahead` });
  if (args['bookOnlyFrom'] !== undefined || args['bookOnlyTo'] !== undefined) {
    const from =
      args['bookOnlyFrom'] === undefined ? current?.config.window.dateFrom : args['bookOnlyFrom'];
    const to =
      args['bookOnlyTo'] === undefined ? current?.config.window.dateTo : args['bookOnlyTo'];
    fields.push({
      label: 'Only between',
      value: from || to ? `${String(from ?? 'now')} to ${String(to ?? 'no end')}` : 'Any dates',
    });
  }
  if (args['dailyLimitPerPerson'] !== undefined)
    fields.push({
      label: 'Daily limit per person',
      value:
        args['dailyLimitPerPerson'] === null ? 'No limit' : String(args['dailyLimitPerPerson']),
    });
  const link = str(args['bookingLink']);
  if (link)
    fields.push({
      label: 'Booking link',
      value: current ? await newBookingLink(db, ctx, current, link, webUrl) : link,
    });
  if (typeof args['listedOnBookingSite'] === 'boolean')
    fields.push({
      label: 'Customers can book it online',
      value: args['listedOnBookingSite'] ? 'Yes' : 'No, only the team books it',
    });
  const description = clearable(args['description']);
  if (description !== undefined)
    fields.push({ label: 'Description', value: description ?? 'None' });
  const color = str(args['color']);
  if (color) fields.push({ label: 'Colour', value: colorWords(color) });
  const timezone = clearable(args['timezone']);
  if (timezone !== undefined)
    fields.push({ label: 'Time zone', value: timezone ?? 'Same as the business' });
  return fields;
}

/** Turn on, pause, back to a draft, archive: the status each sets, and the card and outcome words. */
const STATUS_ACTIONS: Record<
  string,
  {
    status: 'active' | 'paused' | 'draft' | 'archived';
    title: (name: string, from: string) => string;
    now: string;
    confirm: string;
    warning: (from: string) => { kind: string; text: string } | null;
    done: (name: string) => string;
  }
> = {
  turn_on: {
    status: 'active',
    title: (name, from) => (from === 'paused' ? `Resume ${name}` : `Turn on ${name}`),
    now: 'Taking bookings',
    confirm: 'Turn it on',
    warning: () => null,
    done: (name) => `${name} is taking bookings`,
  },
  turn_off: {
    status: 'paused',
    title: (name) => `Pause ${name}`,
    now: 'Paused',
    confirm: 'Pause it',
    warning: () => ({ kind: 'note', text: 'Visits already booked stay; no new ones can be made.' }),
    done: (name) => `${name} is paused`,
  },
  to_draft: {
    status: 'draft',
    title: (name, from) =>
      from === 'archived' ? `Bring ${name} back as a draft` : `Put ${name} back to a draft`,
    now: 'A draft, not taking bookings',
    confirm: 'Make it a draft',
    warning: (from) =>
      from === 'archived'
        ? {
            kind: 'note',
            text: 'It comes back to the list, and takes bookings once it’s turned on.',
          }
        : {
            kind: 'note',
            text: 'Visits already booked stay; no new ones can be made until it’s turned on.',
          },
    done: (name) => `${name} is back to a draft. Turn it on when it’s ready`,
  },
  archive: {
    status: 'archived',
    title: (name) => `Archive ${name}`,
    now: 'Archived',
    confirm: 'Archive it',
    warning: () => ({
      kind: 'caution',
      text: 'It stops taking bookings and leaves the calendar. Its history stays.',
    }),
    done: (name) => `${name} is archived. Its history stays, and it can be brought back as a draft`,
  },
};
const STATUS_WORDS: Record<string, string> = {
  active: 'taking bookings',
  paused: 'paused',
  draft: 'a draft',
  archived: 'archived',
};

const manageCalendar: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const act = action(args);
    const current = args['calendarId']
      ? (await calendarOf(db, ctx, args['calendarId'])).calendar
      : null;
    if (act !== 'create' && !current) throw whichCalendar();
    const status = STATUS_ACTIONS[act];
    if (status) {
      const name = current?.name ?? 'the calendar';
      if (current?.status === status.status)
        throw nothingChanges(`${name} is already ${STATUS_WORDS[status.status]}.`);
      const warning = status.warning(current?.status ?? '');
      // What Things to check says blocks turning it on: the card says so rather than a refusal after Confirm.
      const blocking =
        status.status === 'active'
          ? (current?.issues ?? []).filter((i) => i.severity === 'error')
          : [];
      if (blocking.length)
        return {
          card: settingsCard(toolCallId, 'manage_calendar', {
            title: status.title(name, current?.status ?? ''),
            fields: [{ label: 'Calendar', value: name }],
            confirmLabel: '',
            warnings: blocking
              .slice(0, 3)
              .map((i) => ({ kind: 'blocked', text: sentence(i.message) })),
          }),
          result: {
            blocked: true,
            why: `${name} can’t be turned on until these are fixed: ${blocking.map((i) => sentence(i.message)).join(' ')} get_calendar_settings lists the fixes Things to check offers.`,
          },
        };
      return {
        card: settingsCard(toolCallId, 'manage_calendar', {
          title: status.title(name, current?.status ?? ''),
          fields: [
            { label: 'Calendar', value: current?.name ?? '' },
            { label: 'Now', value: status.now },
          ],
          confirmLabel: status.confirm,
          warnings: warning ? [warning] : [],
        }),
        result: { waiting: true, calendar: current?.name, status: status.status },
      };
    }
    const creating = act === 'create';
    if (creating && !str(args['name'])) throw nameIt('calendar');
    const fields = await calendarFields(db, ctx, args, current, deps?.webUrl);
    if (creating)
      return {
        card: settingsCard(toolCallId, 'manage_calendar', {
          title: `Set up ${str(args['name']) ?? 'a calendar'}`,
          fields,
          confirmLabel: 'Set it up',
          warnings: [
            {
              kind: 'note',
              text: 'It starts as a draft, not taking bookings until it’s turned on.',
            },
          ],
        }),
        result: { waiting: true, creating, changes: fields.map((f) => f.label) },
      };
    // The save itself, rolled back: what it does to visits already booked, and whether it can be saved at all.
    const title = `Change ${current!.name}`;
    let dry: Awaited<ReturnType<typeof changeCalendar>>;
    try {
      dry = await dryRun(db, (tx) => changeCalendar(tx, ctx, args));
    } catch (e) {
      const blocking = blockingIssues(e);
      if (!blocking) throw e;
      return {
        card: settingsCard(toolCallId, 'manage_calendar', {
          title,
          fields: [{ label: 'Calendar', value: current!.name }, ...fields],
          confirmLabel: '',
          warnings: blocking
            .slice(0, 3)
            .map((i) => ({ kind: 'blocked', text: sentence(i.message) })),
        }),
        result: {
          blocked: true,
          why: `${current!.name} is taking bookings, and this would leave settings it can’t book with: ${blocking.map((i) => sentence(i.message)).join(' ')}`,
        },
      };
    }
    if (!dry.saved?.diff.length && !dry.slug)
      throw nothingChanges(`${current!.name} already has those settings.`);
    return {
      card: settingsCard(toolCallId, 'manage_calendar', {
        title,
        fields: [{ label: 'Calendar', value: current!.name }, ...fields],
        confirmLabel: 'Save the change',
        warnings: [
          ...impactWarnings(dry.impacts),
          ...(dry.saved?.issues ?? [])
            .filter((i) => !current!.issues.some((c) => c.message === i.message))
            .map((i) => ({
              kind: i.severity === 'error' ? 'caution' : 'note',
              text: sentence(i.message),
            })),
        ],
      }),
      result: {
        waiting: true,
        creating,
        changes: dry.saved?.diff ?? fields.map((f) => f.label),
      },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const status = STATUS_ACTIONS[act];
    if (status) {
      const { calendar } = await calendarOf(db, ctx, args['calendarId']);
      await command(db, ctx, 'calendar.set_status', {
        calendarId: calendar.id,
        status: status.status,
      });
      return { outcome: status.done(calendar.name), href: null, command: 'calendar.set_status' };
    }
    if (act === 'create') {
      const resources = resourceList(args['resources']);
      // One unit: when the settings on top can't be saved (a service id that isn't there), no calendar is left
      // half made, to be made a second time when the person asks again.
      const calendarId = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const out = await command<{ calendarId: string }>(
          t,
          ctx,
          'calendar.create',
          defined({
            name: args['name'],
            preset: str(args['preset']),
            description: clearable(args['description']) ?? undefined,
            timezone: clearable(args['timezone']) ?? undefined,
            color: str(args['color'])?.toLowerCase(),
            teammates: list(args['teammates']) ?? [],
            services: list(args['services']) ?? [],
            resources: resources?.map((r) => r.resourceId) ?? [],
          }),
        );
        // The preset fills in its own people, services and resources; the ones asked for go on as asked, then
        // anything the create command doesn't take (hours, buffers, the booking window) is a save on top.
        await saveConfig(
          t,
          ctx,
          out.calendarId,
          (config) => calendarPatch(args, config),
          {},
          'keep',
        );
        if (str(args['bookingLink']))
          await command(t, ctx, 'calendar.set_slug', {
            calendarId: out.calendarId,
            slug: args['bookingLink'],
          });
        return out.calendarId;
      });
      return {
        outcome: `${str(args['name']) ?? 'The calendar'} is set up as a draft, so it isn’t taking bookings yet. It can be turned on when it’s ready.`,
        href: `/app/w/${ctx.workspaceId}/settings/calendars/${calendarId}`,
        command: 'calendar.create',
      };
    }
    const { calendar, saved, slug } = await changeCalendar(db, ctx, args);
    const name = str(args['name']) ?? calendar.name;
    return {
      outcome: [
        saved ? `${name} is changed, saved as version ${saved.revision}.` : `${name} is changed.`,
        slug ? `Its booking link is now ${slug}. The old link keeps working.` : '',
        visitsDone(saved?.actions),
      ]
        .filter(Boolean)
        .join(' '),
      href: `/app/w/${ctx.workspaceId}/settings/calendars/${calendar.id}`,
      command: 'calendar.save',
    };
  },
};

/**
 * The change Confirm runs (and the card runs rolled back): the settings and details saved on the revision read now,
 * then the link name. `slug` is the calendar's new booking path when the link name changed.
 */
async function changeCalendar(db: Db, ctx: ToolContext, args: Args) {
  const { calendar } = await calendarOf(db, ctx, args['calendarId']);
  const { out: saved, impacts } = await saveConfig(
    db,
    ctx,
    calendar.id,
    (config) => calendarPatch(args, config),
    calendarDetails(args),
    args['upcomingVisits'],
  );
  const link = str(args['bookingLink']);
  let slug: string | null = null;
  if (link && link !== calendar.slug) {
    await command(db, ctx, 'calendar.set_slug', { calendarId: calendar.id, slug: link });
    slug = calendar.bookingPath ? calendar.bookingPath.replace(/[^/]+$/, link) : link;
  }
  return { calendar, saved, impacts, slug };
}

interface SaveOut {
  revision: number;
  diff: string[];
  issues: { severity: 'error' | 'warning'; message: string }[];
  actions?: { reassigned: string[]; cancelled: string[] };
}

/**
 * Read, patch, save on the revision it was read at, so two people changing a calendar at once is the builder's 409,
 * not a silent overwrite. Visits already booked that it touches get the person's `upcomingVisits` (keep, unless they
 * asked otherwise on the card). Nothing to save is no save.
 */
async function saveConfig(
  db: Db,
  ctx: ToolContext,
  calendarId: string,
  patchFor: (config: CalendarConfig) => ConfigPatch,
  named: Record<string, unknown>,
  choice: unknown,
): Promise<{ out: SaveOut | null; impacts: DecidedImpact[] }> {
  const { calendar } = await calendarOf(db, ctx, calendarId);
  const patch = patchFor(calendar.config);
  if (!Object.keys(patch).length && !Object.keys(named).length) return { out: null, impacts: [] };
  const draft = patched(calendar.config, patch);
  return answeringImpacts(
    (impactDecisions) =>
      command<SaveOut>(db, ctx, 'calendar.save', {
        calendarId,
        baseRevision: calendar.revision,
        draft,
        ...named,
        impactDecisions,
      }),
    choice,
  );
}

// ---------- services, resources and territories: Settings → Calendars' own pages ----------

interface ServiceRow {
  id: string;
  name: string;
  durations: number[];
  bufferBefore: number;
  bufferAfter: number;
  priceCents: number | null;
  repeatMonths: number | null;
  staffUserIds: string[];
  resources: { resourceId: string; quantity: number }[];
  hours: Hours | null;
}
interface ResourceRow {
  id: string;
  name: string;
  kind: string;
  quantity: number;
  location: string | null;
  hours: Hours | null;
}
interface TerritoryRow {
  id: string;
  name: string;
  kind: 'zip' | 'radius' | 'polygon';
  postalCodes: string[];
  centerAddress: string | null;
  radiusMiles: number | null;
  polygon: number[][] | null;
  userIds: string[];
}

const servicesOf = async (db: Db, ctx: ToolContext) =>
  (await query<{ items: ServiceRow[] }>(db, ctx, 'service.list')).items;
const resourcesOf = async (db: Db, ctx: ToolContext) =>
  (await query<{ items: ResourceRow[] }>(db, ctx, 'resource.list')).items;
const territoriesOf = async (db: Db, ctx: ToolContext) =>
  (await query<{ items: TerritoryRow[] }>(db, ctx, 'territory.list')).items;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** A value as text with its keys in order, so two lists read from different places compare by what they hold. */
const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
const sameList = (a: readonly unknown[], b: readonly unknown[]) => canon(a) === canon(b);
const taken = (what: string, name: string) =>
  HfosError.conflict(
    `There’s already a ${what} called “${name}”. Pick a different name.`,
    'name_taken',
  );
const nameIt = (what: string) =>
  HfosError.validation([{ path: 'name', message: `Name the ${what}.` }], `Name the ${what}.`);
const nothingChanges = (why: string) => HfosError.validation([], `Nothing would change. ${why}`);
const noSuch = (what: string, area: string) =>
  HfosError.notFound(`No ${what} has that id. They’re in get_settings (area ${area}).`);

const minutesWords = (list: readonly number[]) => list.map((d) => `${d} min`).join(' or ');
const repeatWords = (months: number | null) =>
  months === null ? 'Doesn’t repeat' : months === 1 ? 'Every month' : `Every ${months} months`;
const ownHoursWords = (hours: Hours | null, none: string) =>
  hours === null ? none : hoursLine(hours);
const needsWords = (
  needs: readonly { resourceId: string; quantity: number }[],
  resources: readonly ResourceRow[],
) =>
  needs.length
    ? needs
        .map(
          (n) =>
            `${resources.find((r) => r.id === n.resourceId)?.name ?? 'A resource'} × ${n.quantity}`,
        )
        .join(', ')
    : 'Nothing else';
const RESOURCE_KIND_WORDS: Record<string, string> = {
  room: 'Room',
  equipment: 'Equipment',
  vehicle: 'Vehicle',
  property: 'Property',
  chair: 'Chair',
  other: 'Other',
};
const hoursOf = (v: unknown) =>
  v === undefined ? undefined : v === null ? null : (v as Hours).map((h) => ({ ...h }));
const needsOf = (v: unknown) =>
  Array.isArray(v)
    ? (v as { resourceId: string; quantity?: number }[]).map((n) => ({
        resourceId: n.resourceId,
        quantity: n.quantity ?? 1,
      }))
    : undefined;

/** A service as asked for: what is there now, with what was said on top. */
async function serviceChange(db: Db, ctx: ToolContext, args: Args) {
  const act = action(args);
  const [services, resources] = await Promise.all([servicesOf(db, ctx), resourcesOf(db, ctx)]);
  const current = act === 'create' ? undefined : services.find((s) => s.id === args['serviceId']);
  if (act !== 'create' && !current) throw noSuch('service', 'services');
  const name = str(args['name']);
  if (act === 'create' && !name) throw nameIt('service');
  if (name && services.some((s) => s.id !== current?.id && same(s.name, name)))
    throw taken('service', name);
  const needs = needsOf(args['resources']);
  const missing = needs?.find((n) => !resources.some((r) => r.id === n.resourceId));
  if (missing) throw noSuch('resource', 'resources');
  const price = args['priceDollars'];
  return {
    act,
    current,
    resources,
    next: {
      name,
      durations: list(args['durationsMinutes']) as unknown as number[] | undefined,
      priceCents:
        price === undefined ? undefined : price === null ? null : Math.round(Number(price) * 100),
      bufferBefore: num(args['bufferBeforeMinutes']),
      bufferAfter: num(args['bufferAfterMinutes']),
      repeatMonths:
        args['repeatMonths'] === undefined ? undefined : (num(args['repeatMonths']) ?? null),
      staffUserIds: list(args['staffUserIds']),
      resources: needs,
      hours: hoursOf(args['hours']),
    },
  };
}

const manageService: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { act, current, resources, next } = await serviceChange(db, ctx, args);
    if (act === 'archive')
      return {
        card: settingsCard(toolCallId, 'manage_service', {
          title: `Archive ${current!.name}`,
          fields: [{ label: 'Service', value: current!.name }],
          confirmLabel: 'Archive it',
          warnings: [
            {
              kind: 'note',
              text: 'Visits already booked keep it, but it can’t be booked again. Calendars offering it will show something to fix.',
            },
          ],
        }),
        result: { waiting: true, service: current!.name },
      };
    // What changes: everything said for a new one, only what differs for one already there.
    const differs = <T>(v: T | undefined, now: T | undefined) =>
      v !== undefined && (current === undefined || canon(v) !== canon(now));
    const fields: Field[] = [{ label: 'Service', value: current?.name ?? next.name! }];
    if (current && differs(next.name, current.name))
      fields.push({ label: 'New name', value: next.name! });
    const durations = next.durations ?? (current ? undefined : [60]);
    if (differs(durations, current?.durations))
      fields.push({ label: 'How long', value: minutesWords(durations!) });
    if (differs(next.priceCents, current?.priceCents))
      fields.push({
        label: 'Price shown',
        value: next.priceCents === null ? 'No price shown' : dollars(next.priceCents!),
      });
    if (differs(next.bufferBefore, current?.bufferBefore))
      fields.push({ label: 'Setup before', value: `${next.bufferBefore} min` });
    if (differs(next.bufferAfter, current?.bufferAfter))
      fields.push({ label: 'Cleanup after', value: `${next.bufferAfter} min` });
    if (differs(next.repeatMonths, current?.repeatMonths))
      fields.push({ label: 'Repeats', value: repeatWords(next.repeatMonths!) });
    if (differs(next.staffUserIds, current?.staffUserIds))
      fields.push({
        label: 'Who can do it',
        value: next.staffUserIds!.length
          ? await teamNames(db, ctx, next.staffUserIds!)
          : 'Everyone',
      });
    if (differs(next.resources, current?.resources))
      fields.push({ label: 'Needs', value: needsWords(next.resources!, resources) });
    if (differs(next.hours, current?.hours))
      fields.push({
        label: 'Hours',
        value: ownHoursWords(next.hours!, 'Any time the calendar is open'),
      });
    if (current && fields.length === 1)
      throw nothingChanges(`${current.name} is already set up that way.`);
    return {
      card: settingsCard(toolCallId, 'manage_service', {
        title: current ? `Change ${current.name}` : `Add ${next.name}`,
        fields,
        confirmLabel: current ? 'Save the change' : 'Add it',
      }),
      result: { waiting: true, creating: !current },
    };
  },

  async commit(db, ctx, args) {
    const { act, current, next } = await serviceChange(db, ctx, args);
    const href = `/app/w/${ctx.workspaceId}/settings/calendars/services`;
    if (act === 'archive') {
      const out = await command<{ calendars: Named[] }>(db, ctx, 'service.archive', {
        serviceId: current!.id,
      });
      const still = out.calendars.map((c) => c.name);
      return {
        outcome: still.length
          ? `Archived. ${still.join(', ')} still offer${still.length === 1 ? 's' : ''} it, so ${still.length === 1 ? 'its' : 'their'} settings show something to fix`
          : 'Archived',
        href,
        command: 'service.archive',
      };
    }
    const input = defined({
      ...next,
      description: str(args['description']),
      defaultDuration: next.durations?.[0],
    });
    if (!current) {
      await command(db, ctx, 'service.create', input);
      return { outcome: `${next.name} is ready to book`, href, command: 'service.create' };
    }
    await command(db, ctx, 'service.update', { serviceId: current.id, ...input });
    return { outcome: 'Changed', href, command: 'service.update' };
  },
};

async function resourceChange(db: Db, ctx: ToolContext, args: Args) {
  const act = action(args);
  const resources = await resourcesOf(db, ctx);
  const current = act === 'create' ? undefined : resources.find((r) => r.id === args['resourceId']);
  if (act !== 'create' && !current) throw noSuch('resource', 'resources');
  const name = str(args['name']);
  if (act === 'create' && !name) throw nameIt('resource');
  if (name && resources.some((r) => r.id !== current?.id && same(r.name, name)))
    throw taken('resource', name);
  return {
    act,
    current,
    next: {
      name,
      kind: str(args['kind']),
      quantity: num(args['quantity']),
      location: args['location'] === undefined ? undefined : (str(args['location']) ?? null),
      hours: hoursOf(args['hours']),
    },
  };
}

const manageResource: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { act, current, next } = await resourceChange(db, ctx, args);
    if (act === 'archive')
      return {
        card: settingsCard(toolCallId, 'manage_resource', {
          title: `Archive ${current!.name}`,
          fields: [{ label: 'Resource', value: current!.name }],
          confirmLabel: 'Archive it',
          warnings: [
            {
              kind: 'note',
              text: 'Visits already booked keep it. Services and calendars that need it will show something to fix.',
            },
          ],
        }),
        result: { waiting: true, action: act },
      };
    const differs = <T>(v: T | undefined, now: T | undefined) =>
      v !== undefined && (current === undefined || canon(v) !== canon(now));
    const fields: Field[] = [{ label: 'Resource', value: current?.name ?? next.name! }];
    if (current && differs(next.name, current.name))
      fields.push({ label: 'New name', value: next.name! });
    const kind = next.kind ?? (current ? undefined : 'other');
    if (differs(kind, current?.kind))
      fields.push({ label: 'What it is', value: RESOURCE_KIND_WORDS[kind!] ?? kind! });
    const quantity = next.quantity ?? (current ? undefined : 1);
    if (differs(quantity, current?.quantity))
      fields.push({ label: 'How many', value: String(quantity) });
    if (differs(next.location, current?.location))
      fields.push({ label: 'Where', value: next.location ?? 'Nowhere in particular' });
    if (differs(next.hours, current?.hours))
      fields.push({ label: 'Hours', value: ownHoursWords(next.hours!, 'Any time') });
    if (current && fields.length === 1)
      throw nothingChanges(`${current.name} is already set up that way.`);
    return {
      card: settingsCard(toolCallId, 'manage_resource', {
        title: current ? `Change ${current.name}` : `Add ${next.name}`,
        fields,
        confirmLabel: current ? 'Save the change' : 'Add it',
      }),
      result: { waiting: true, action: act },
    };
  },

  async commit(db, ctx, args) {
    const { act, current, next } = await resourceChange(db, ctx, args);
    const href = `/app/w/${ctx.workspaceId}/settings/calendars/resources`;
    if (act === 'archive') {
      const out = await command<{ calendars: Named[] }>(db, ctx, 'resource.archive', {
        resourceId: current!.id,
      });
      const still = out.calendars.map((c) => c.name);
      return {
        outcome: still.length
          ? `Archived. ${still.join(', ')} still need${still.length === 1 ? 's' : ''} it, so ${still.length === 1 ? 'its' : 'their'} settings show something to fix`
          : 'Archived',
        href,
        command: 'resource.archive',
      };
    }
    const input = defined(next);
    if (!current) {
      await command(db, ctx, 'resource.create', input);
      return { outcome: `${next.name} is added`, href, command: 'resource.create' };
    }
    await command(db, ctx, 'resource.update', { resourceId: current.id, ...input });
    return { outcome: 'Changed', href, command: 'resource.update' };
  },
};

type Shape =
  { kind: 'zip' } | { kind: 'radius'; address: string; lat: number; lng: number; miles: number };

const zipWords = (zips: readonly string[]) =>
  !zips.length
    ? 'No ZIP codes yet'
    : zips.length > 6
      ? `${zips.slice(0, 5).join(', ')} and ${zips.length - 5} more`
      : zips.join(', ');
const areaWords = (
  t: Pick<TerritoryRow, 'kind' | 'postalCodes' | 'centerAddress' | 'radiusMiles' | 'polygon'>,
) =>
  t.kind === 'radius'
    ? `${t.radiusMiles ?? 0} miles from ${t.centerAddress ?? 'a point on the map'}`
    : t.kind === 'polygon'
      ? `An area drawn on the map (${t.polygon?.length ?? 0} corners)`
      : zipWords(t.postalCodes);

/** So many miles from an address: found on the map, as the screen finds it before it saves. */
async function milesFrom(args: Args, geocoder: Geocoder | null | undefined): Promise<Shape | null> {
  const asked = args['milesFrom'] as { address: string; miles: number } | undefined;
  if (!asked) return null;
  if (!geocoder || geocoder.name === 'off')
    throw HfosError.rule(
      'maps_off',
      503,
      'I can’t look addresses up on the map right now. Give the ZIP codes it covers instead, or set the distance in Settings → Calendars → Territories.',
    );
  const place = await geocoder.geocode(asked.address);
  if (!place)
    throw HfosError.validation(
      [{ path: 'milesFrom.address', message: 'That address wasn’t found on the map.' }],
      `“${asked.address}” wasn’t found on the map. Check the address and try again.`,
    );
  return {
    kind: 'radius',
    address: asked.address,
    lat: place.lat,
    lng: place.lng,
    miles: asked.miles,
  };
}

async function territoryChange(
  db: Db,
  ctx: ToolContext,
  args: Args,
  geocoder: Geocoder | null | undefined,
) {
  const act = action(args);
  const territories = await territoriesOf(db, ctx);
  const current =
    act === 'create' ? undefined : territories.find((t) => t.id === args['territoryId']);
  if (act !== 'create' && !current) throw noSuch('territory', 'territories');
  if (act === 'delete') return { act, current, next: null };
  const name = str(args['name']);
  if (act === 'create' && !name) throw nameIt('territory');
  if (name && territories.some((t) => t.id !== current?.id && same(t.name, name)))
    throw taken('territory', name);
  const zips = list(args['postalCodes']);
  const adding = list(args['addPostalCodes']);
  const removing = list(args['removePostalCodes']);
  const zipsGiven = !!(zips || adding || removing);
  if (zipsGiven && args['milesFrom'])
    throw HfosError.validation(
      [{ path: 'milesFrom', message: 'Give ZIP codes or a distance, not both.' }],
      'A territory covers ZIP codes or so many miles from an address, not both. Say which.',
    );
  const radius = await milesFrom(args, geocoder);
  const shape: Shape | undefined = radius ?? (zipsGiven || !current ? { kind: 'zip' } : undefined);
  // Adding or taking off a few codes works on the list it has, so nobody re-sends 300 codes to add one.
  const off = new Set(removing ?? []);
  const codes = [...new Set([...(zips ?? current?.postalCodes ?? []), ...(adding ?? [])])].filter(
    (z) => !off.has(z),
  );
  return {
    act,
    current,
    next: {
      name,
      shape,
      postalCodes: shape?.kind === 'zip' ? codes : undefined,
      userIds: list(args['userIds']),
    },
  };
}

/** Whether what it covers changes: another kind, another list of ZIP codes, or another distance. */
function areaChanges(
  current: TerritoryRow | undefined,
  next: { shape?: Shape; postalCodes?: string[] },
): boolean {
  if (!next.shape) return false;
  if (!current || current.kind !== next.shape.kind) return true;
  if (next.shape.kind === 'radius')
    return next.shape.address !== current.centerAddress || next.shape.miles !== current.radiusMiles;
  return !sameList([...(next.postalCodes ?? [])].sort(), [...current.postalCodes].sort());
}

const manageTerritory: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const { act, current, next } = await territoryChange(db, ctx, args, deps?.geocoder);
    const back = 'Settings → Calendars → Territories';
    if (act === 'delete' || !next)
      return {
        card: settingsCard(toolCallId, 'manage_territory', {
          title: `Delete ${current!.name}`,
          fields: [
            { label: 'Territory', value: current!.name },
            { label: 'Covers', value: areaWords(current!) },
          ],
          confirmLabel: 'Delete it',
          warnings: [
            {
              kind: 'caution',
              text: 'Calendars that route by service area stop sending visits there to its people. It can’t be brought back.',
            },
            { kind: 'note', text: 'Visits already booked stay where they are.' },
          ],
        }),
        result: { waiting: true, action: act },
      };
    const after = next.shape
      ? next.shape.kind === 'radius'
        ? `${next.shape.miles} miles from ${next.shape.address}`
        : zipWords(next.postalCodes ?? [])
      : null;
    const before = current ? areaWords(current) : null;
    const fields: Field[] = [{ label: 'Territory', value: current?.name ?? next.name! }];
    if (current && next.name && next.name !== current.name)
      fields.push({ label: 'New name', value: next.name });
    if (after !== null && areaChanges(current, next)) {
      if (current?.kind === 'zip' && next.shape?.kind === 'zip') {
        // Still a ZIP area: the codes that come and go, not the first few of a long list.
        const now = new Set(next.postalCodes ?? []);
        const had = new Set(current.postalCodes);
        const added = [...now].filter((z) => !had.has(z));
        const gone = current.postalCodes.filter((z) => !now.has(z));
        if (added.length) fields.push({ label: 'Adds', value: zipWords(added) });
        if (gone.length) fields.push({ label: 'Takes off', value: zipWords(gone) });
        fields.push({
          label: 'Covers',
          value: now.size === 1 ? '1 ZIP code' : `${now.size} ZIP codes`,
        });
      } else {
        fields.push({ label: 'Covers', value: after });
        if (before) fields.push({ label: 'Was', value: before });
      }
    }
    if (
      next.userIds &&
      (!current || !sameList([...next.userIds].sort(), [...current.userIds].sort()))
    )
      fields.push({
        label: 'Who covers it',
        value: next.userIds.length ? await teamNames(db, ctx, next.userIds) : 'Nobody yet',
      });
    if (current && fields.length === 1)
      throw nothingChanges(`${current.name} is already set up that way.`);
    const warnings: { kind: string; text: string }[] = [];
    if (current && next.shape && current.kind !== next.shape.kind)
      warnings.push({
        kind: 'note',
        text:
          next.shape.kind === 'radius' && current.postalCodes.length
            ? `Its ${current.postalCodes.length === 1 ? 'ZIP code comes' : `${current.postalCodes.length} ZIP codes come`} off: it covers the distance instead.`
            : `It stops covering ${before}.`,
      });
    if (next.shape?.kind === 'zip' && !(next.postalCodes ?? []).length)
      warnings.push({
        kind: 'note',
        text: `It covers no ZIP codes yet, so no visits are sent there. Add them here or in ${back}.`,
      });
    return {
      card: settingsCard(toolCallId, 'manage_territory', {
        title: current ? `Change ${current.name}` : `Add ${next.name}`,
        fields,
        confirmLabel: current ? 'Save the change' : 'Add it',
        warnings,
      }),
      result: { waiting: true, action: act },
    };
  },

  async commit(db, ctx, args, extra) {
    const { act, current, next } = await territoryChange(db, ctx, args, extra.geocoder);
    const href = `/app/w/${ctx.workspaceId}/settings/calendars/territories`;
    if (act === 'delete' || !next) {
      await command(db, ctx, 'territory.delete', { territoryId: current!.id });
      return { outcome: 'Deleted', href, command: 'territory.delete' };
    }
    const changes = areaChanges(current, next);
    const area = defined({
      // A ZIP area staying one keeps its shape and takes the new list; anything else sends the shape.
      shape:
        changes && (next.shape!.kind === 'radius' || current?.kind !== 'zip')
          ? next.shape
          : undefined,
      postalCodes: changes ? next.postalCodes : undefined,
    });
    if (!current) {
      await command(db, ctx, 'territory.create', {
        name: next.name,
        ...area,
        ...defined({ userIds: next.userIds }),
      });
      return { outcome: `${next.name} is added`, href, command: 'territory.create' };
    }
    await command(db, ctx, 'territory.update', {
      territoryId: current.id,
      ...defined({ name: next.name, userIds: next.userIds }),
      ...area,
    });
    return { outcome: 'Changed', href, command: 'territory.update' };
  },
};

interface BookingSiteGet {
  site: { slug: string; name: string; intro: string | null; enabled: boolean } | null;
}

/**
 * The page needs an address and a name. A business that has never set one up gets its own name and a link made
 * from it, so "turn my booking page on" works on the first try instead of asking for two things nobody minds.
 */
async function bookingSiteInput(db: Db, ctx: ToolContext, args: Args) {
  const [{ site }, business] = await Promise.all([
    query<BookingSiteGet>(db, ctx, 'booking_site.get').catch(() => ({ site: null })),
    query<{ workspace: { name: string } }>(db, ctx, 'workspace.get').catch(() => null),
  ]);
  const businessName = business?.workspace.name ?? 'Book with us';
  // Made up rather than chosen: nobody picked this address, so a clash is ours to solve, not theirs.
  const derivedSlug = !site && !str(args['slug']);
  return {
    site,
    derivedSlug,
    input: {
      slug: str(args['slug']) ?? site?.slug ?? slugify(businessName),
      name: str(args['name']) ?? site?.name ?? businessName,
      intro: args['intro'] === undefined ? (site?.intro ?? null) : (str(args['intro']) ?? null),
      enabled: typeof args['enabled'] === 'boolean' ? args['enabled'] : (site?.enabled ?? true),
    },
  };
}

/** A public page's whole link, as Settings copies it; just its path when the web app's address isn't known. */
async function wholeLink(db: Db, ctx: ToolContext, path: string, webUrl = '') {
  const origin = webUrl ? await publicOriginFor(db, ctx, webUrl) : '';
  return `${origin}${path}`;
}
const bookingPageLink = (db: Db, ctx: ToolContext, slug: string, webUrl = '') =>
  wholeLink(db, ctx, `/book/${slug}`, webUrl);

const updateBookingSite: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const { site, input, derivedSlug } = await bookingSiteInput(db, ctx, args);
    const on = typeof args['enabled'] === 'boolean' ? args['enabled'] : undefined;
    const link = await bookingPageLink(db, ctx, input.slug, deps?.webUrl);
    return {
      card: settingsCard(toolCallId, 'update_booking_site', {
        title: site ? 'Change your booking page' : 'Set up your booking page',
        fields: [
          { label: 'Name', value: input.name },
          { label: 'Address', value: link },
          ...(args['intro'] === undefined
            ? []
            : [{ label: 'Intro', value: input.intro ?? 'None' }]),
          ...(on === undefined
            ? []
            : [{ label: 'Taking bookings online', value: on ? 'Yes' : 'No' }]),
        ],
        confirmLabel: site ? 'Save the change' : 'Set it up',
        warnings: [
          // booking_site.update keeps no old address, as the screen's hint under Link name says.
          ...(site && input.slug !== site.slug
            ? [{ kind: 'caution', text: 'Links you’ve already shared stop working.' }]
            : []),
          ...(on === false
            ? [
                {
                  kind: 'note',
                  text: 'Customers won’t be able to book themselves while it is off.',
                },
              ]
            : []),
          ...(derivedSlug
            ? [{ kind: 'note', text: 'If that address is taken I’ll add a number to it.' }]
            : []),
        ],
      }),
      result: { waiting: true, address: link },
    };
  },

  async commit(db, ctx, args, extra) {
    const { input, derivedSlug } = await bookingSiteInput(db, ctx, args);
    const slug = await saveBookingSite(db, ctx, input, derivedSlug);
    return {
      outcome: `Your booking page is at ${await bookingPageLink(db, ctx, slug, extra.webUrl)}`,
      href: `/app/w/${ctx.workspaceId}/settings/calendars/booking-site`,
      command: 'booking_site.update',
    };
  },
};

/**
 * Saves the page, and — only when nobody chose the address — walks past one already taken. An address the person
 * asked for is theirs: "that link name is taken" goes back to them so they can pick another.
 */
async function saveBookingSite(
  db: Db,
  ctx: ToolContext,
  input: { slug: string; name: string; intro: string | null; enabled: boolean },
  derivedSlug: boolean,
): Promise<string> {
  for (let n = 1; n <= 5; n++) {
    const slug = n === 1 ? input.slug : `${input.slug}-${n}`;
    try {
      await command(db, ctx, 'booking_site.update', { ...input, slug });
      return slug;
    } catch (e) {
      const taken = (e as { rule?: string }).rule === 'slug_taken';
      if (!taken || !derivedSlug || n === 5) throw e;
    }
  }
  return input.slug;
}

export const settingsCalendarConfirmTools: Record<string, SettingsConfirmTool> = {
  manage_calendar: manageCalendar,
  manage_service: manageService,
  manage_resource: manageResource,
  manage_territory: manageTerritory,
  update_booking_site: updateBookingSite,
};
