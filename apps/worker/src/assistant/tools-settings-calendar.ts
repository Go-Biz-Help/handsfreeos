/**
 * Setting up the calendars by asking (M12, step two): calendars, services, resources, territories and the booking
 * site. Each one runs the command the settings screen runs, as the person, and only once they press Confirm.
 *
 * Changing a calendar is read-patch-save: the calendar is read for its revision and its settings, the patch is
 * applied with core's own `applyPatch`, and the save goes in on that revision — so two people changing a calendar
 * at once is the same 409 the builder gets, not a silent overwrite. Taking someone off a calendar that has visits
 * booked keeps those visits (`keep`), which is what the impact review calls the safe answer, and the card says so.
 */

import {
  applyPatch,
  HfosError,
  slugify,
  type AssistantCard,
  type CalendarConfig,
  type ConfigPatch,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { Geocoder } from '../geo/geocoder';
import type { CommittedAction, PreparedAction, ToolContext } from './runtime';
import { command, query } from './tools-read';

type Args = Record<string, unknown>;
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type Field = { label: string; value: string };

/** What a few settings tools need from the worker: the map, to find an address. */
export interface SettingsDeps {
  readonly geocoder?: Geocoder | null;
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

/** The parts of a calendar the Assistant may change, as a patch on its settings. */
function calendarPatch(args: Args): ConfigPatch {
  const patch: Record<string, unknown> = {};
  const teammates = list(args['teammates']);
  if (teammates) patch['team'] = { members: teammates.map((userId) => ({ userId })) };
  const services = list(args['services']);
  if (services)
    patch['services'] = {
      mode: services.length > 1 ? 'choice' : services.length === 1 ? 'one' : 'none',
      items: services.map((serviceId) => ({ serviceId })),
    };
  const resources = list(args['resources']);
  if (resources)
    patch['resources'] = { items: resources.map((resourceId) => ({ resourceId, quantity: 1 })) };
  if (args['hours'] !== undefined)
    patch['schedule'] = { hours: (args['hours'] as Hours | null) ?? null };
  const before = num(args['bufferBeforeMinutes']);
  const after = num(args['bufferAfterMinutes']);
  if (before !== undefined || after !== undefined)
    patch['buffers'] = defined({ before, after }) as Record<string, number>;
  const notice = num(args['minNoticeHours']);
  const ahead = num(args['maxDaysAhead']);
  if (notice !== undefined || ahead !== undefined)
    patch['window'] = defined({
      minNoticeMinutes: notice === undefined ? undefined : notice * 60,
      maxDaysAhead: ahead,
    }) as Record<string, number>;
  if (typeof args['listedOnBookingSite'] === 'boolean')
    patch['public'] = args['listedOnBookingSite'];
  return patch as ConfigPatch;
}

/** What the card shows for a change, so someone can see what they are saying yes to. */
async function calendarFields(
  db: Db,
  ctx: ToolContext,
  args: Args,
  current: CalendarGet['calendar'] | null,
): Promise<Field[]> {
  const fields: Field[] = [];
  const name = str(args['name']);
  if (name) fields.push({ label: 'Name', value: name });
  if (current && name && current.name !== name) fields.push({ label: 'Was', value: current.name });
  const teammates = list(args['teammates']);
  if (teammates) fields.push({ label: 'Who works it', value: await teamNames(db, ctx, teammates) });
  const services = list(args['services']);
  if (services)
    fields.push({
      label: 'What it offers',
      value: await namesOf(db, ctx, 'service.list', services),
    });
  const resources = list(args['resources']);
  if (resources)
    fields.push({
      label: 'What it needs',
      value: await namesOf(db, ctx, 'resource.list', resources),
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
  const notice = num(args['minNoticeHours']);
  if (notice !== undefined)
    fields.push({ label: 'Notice to book', value: `${notice} hour${notice === 1 ? '' : 's'}` });
  const ahead = num(args['maxDaysAhead']);
  if (ahead !== undefined) fields.push({ label: 'Books up to', value: `${ahead} days ahead` });
  const link = str(args['bookingLink']);
  if (link) fields.push({ label: 'Booking link', value: link });
  if (typeof args['listedOnBookingSite'] === 'boolean')
    fields.push({
      label: 'On the booking site',
      value: args['listedOnBookingSite'] ? 'Yes' : 'No',
    });
  const timezone = str(args['timezone']);
  if (timezone) fields.push({ label: 'Time zone', value: timezone });
  return fields;
}

/** Someone taken off a calendar with visits booked keeps them; the card warns rather than surprising anyone. */
function removalWarning(
  current: CalendarGet['calendar'] | null,
  args: Args,
): { kind: string; text: string }[] {
  const teammates = list(args['teammates']);
  if (!current || !teammates) return [];
  const gone = current.config.team.members.filter((m) => !teammates.includes(m.userId));
  return gone.length
    ? [
        {
          kind: 'note',
          text: `Visits already booked with ${gone.length === 1 ? 'them' : 'those people'} stay as they are.`,
        },
      ]
    : [];
}

const manageCalendar: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const current = args['calendarId']
      ? (await calendarOf(db, ctx, args['calendarId'])).calendar
      : null;
    if (act === 'turn_on' || act === 'turn_off') {
      const on = act === 'turn_on';
      return {
        card: settingsCard(toolCallId, 'manage_calendar', {
          title: on
            ? `Turn on ${current?.name ?? 'the calendar'}`
            : `Pause ${current?.name ?? 'the calendar'}`,
          fields: [
            { label: 'Calendar', value: current?.name ?? '' },
            { label: 'Now', value: on ? 'Taking bookings' : 'Paused' },
          ],
          confirmLabel: on ? 'Turn it on' : 'Pause it',
          warnings: on
            ? []
            : [{ kind: 'note', text: 'Visits already booked stay; no new ones can be made.' }],
        }),
        result: { waiting: true, calendar: current?.name, status: on ? 'active' : 'paused' },
      };
    }
    const creating = act === 'create';
    const fields = await calendarFields(db, ctx, args, current);
    return {
      card: settingsCard(toolCallId, 'manage_calendar', {
        title: creating
          ? `Set up ${str(args['name']) ?? 'a calendar'}`
          : `Change ${current?.name ?? 'the calendar'}`,
        fields: creating ? fields : [{ label: 'Calendar', value: current?.name ?? '' }, ...fields],
        confirmLabel: creating ? 'Set it up' : 'Save the change',
        warnings: removalWarning(current, args),
      }),
      result: { waiting: true, creating, changes: fields.map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    if (act === 'turn_on' || act === 'turn_off') {
      const status = act === 'turn_on' ? 'active' : 'paused';
      const { calendar } = await calendarOf(db, ctx, args['calendarId']);
      await command(db, ctx, 'calendar.set_status', { calendarId: calendar.id, status });
      return {
        outcome:
          act === 'turn_on' ? `${calendar.name} is taking bookings` : `${calendar.name} is paused`,
        href: null,
        command: 'calendar.set_status',
      };
    }
    if (act === 'create') {
      const out = await command<{ calendarId: string }>(
        db,
        ctx,
        'calendar.create',
        defined({
          name: args['name'],
          description: str(args['description']),
          timezone: str(args['timezone']),
          teammates: list(args['teammates']) ?? [],
          services: list(args['services']) ?? [],
          resources: list(args['resources']) ?? [],
        }),
      );
      // Anything the create command doesn't take (hours, buffers, the booking window) is a save on top.
      const patch = calendarPatch({
        ...args,
        teammates: undefined,
        services: undefined,
        resources: undefined,
      });
      if (Object.keys(patch).length) await saveConfig(db, ctx, out.calendarId, patch);
      if (str(args['bookingLink']))
        await command(db, ctx, 'calendar.set_slug', {
          calendarId: out.calendarId,
          slug: args['bookingLink'],
        });
      return {
        outcome: `${str(args['name']) ?? 'The calendar'} is set up`,
        href: `/app/w/${ctx.workspaceId}/settings/calendars/${out.calendarId}`,
        command: 'calendar.create',
      };
    }
    const { calendar } = await calendarOf(db, ctx, args['calendarId']);
    const patch = calendarPatch(args);
    const named = defined({
      name: str(args['name']),
      description: str(args['description']),
      timezone: str(args['timezone']),
    });
    if (Object.keys(patch).length || Object.keys(named).length)
      await saveConfig(db, ctx, calendar.id, patch, named);
    if (str(args['bookingLink']))
      await command(db, ctx, 'calendar.set_slug', {
        calendarId: calendar.id,
        slug: args['bookingLink'],
      });
    return {
      outcome: `${str(args['name']) ?? calendar.name} is changed`,
      href: `/app/w/${ctx.workspaceId}/settings/calendars/${calendar.id}`,
      command: 'calendar.save',
    };
  },
};

/**
 * Read, patch, save on the revision it was read at. Visits already booked keep their terms ("keep"), the answer
 * the impact review always allows, so a change never cancels or moves someone's appointment behind their back.
 */
async function saveConfig(
  db: Db,
  ctx: ToolContext,
  calendarId: string,
  patch: ConfigPatch,
  named: Record<string, unknown> = {},
): Promise<void> {
  const { calendar } = await calendarOf(db, ctx, calendarId);
  const draft = applyPatch(calendar.config, patch);
  await command(db, ctx, 'calendar.save', {
    calendarId,
    baseRevision: calendar.revision,
    draft,
    ...named,
    impactDecisions: {},
  }).catch(async (e: unknown) => {
    const impacts = (e as { details?: { impacts?: { key: string }[] } })?.details?.impacts;
    if (!impacts?.length) throw e;
    await command(db, ctx, 'calendar.save', {
      calendarId,
      baseRevision: calendar.revision,
      draft,
      ...named,
      impactDecisions: Object.fromEntries(impacts.map((i) => [i.key, 'keep'])),
    });
  });
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
  if (zips && args['milesFrom'])
    throw HfosError.validation(
      [{ path: 'milesFrom', message: 'Give ZIP codes or a distance, not both.' }],
      'A territory covers ZIP codes or so many miles from an address, not both. Say which.',
    );
  const radius = await milesFrom(args, geocoder);
  const shape: Shape | undefined = radius ?? (zips || !current ? { kind: 'zip' } : undefined);
  return {
    act,
    current,
    next: {
      name,
      shape,
      postalCodes:
        shape?.kind === 'zip' ? [...new Set(zips ?? current?.postalCodes ?? [])] : undefined,
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
      fields.push({ label: 'Covers', value: after });
      if (before) fields.push({ label: 'Was', value: before });
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

const updateBookingSite: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { site, input, derivedSlug } = await bookingSiteInput(db, ctx, args);
    const on = typeof args['enabled'] === 'boolean' ? args['enabled'] : undefined;
    return {
      card: settingsCard(toolCallId, 'update_booking_site', {
        title: site ? 'Change your booking page' : 'Set up your booking page',
        fields: [
          { label: 'Name', value: input.name },
          { label: 'Address', value: `/book/${input.slug}` },
          ...(args['intro'] === undefined
            ? []
            : [{ label: 'Intro', value: input.intro ?? 'None' }]),
          ...(on === undefined ? [] : [{ label: 'Booking page', value: on ? 'On' : 'Off' }]),
        ],
        confirmLabel: site ? 'Save the change' : 'Set it up',
        warnings: [
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
      result: { waiting: true, address: input.slug },
    };
  },

  async commit(db, ctx, args) {
    const { input, derivedSlug } = await bookingSiteInput(db, ctx, args);
    const slug = await saveBookingSite(db, ctx, input, derivedSlug);
    return {
      outcome: `Your booking page is at /book/${slug}`,
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
