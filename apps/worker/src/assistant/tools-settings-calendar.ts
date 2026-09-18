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
  slugify,
  type AssistantCard,
  type CalendarConfig,
  type ConfigPatch,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { CommittedAction, PreparedAction, ToolContext } from './runtime';
import { command, query } from './tools-read';

type Args = Record<string, unknown>;
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type Field = { label: string; value: string };

export interface SettingsConfirmTool {
  prepare(db: Db, ctx: ToolContext, args: Args, toolCallId: string): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    extra: { lostReason?: string; toolCallId: string },
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

const manageService: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const { items } = await query<{ items: Named[] }>(db, ctx, 'service.list').catch(() => ({
      items: [] as Named[],
    }));
    const current = items.find((s) => s.id === args['serviceId']);
    if (act === 'archive')
      return {
        card: settingsCard(toolCallId, 'manage_service', {
          title: `Archive ${current?.name ?? 'the service'}`,
          fields: [{ label: 'Service', value: current?.name ?? '' }],
          confirmLabel: 'Archive it',
          warnings: [
            { kind: 'note', text: 'Visits already booked stay; it can’t be booked again.' },
          ],
        }),
        result: { waiting: true, service: current?.name },
      };
    const durations = list(args['durationsMinutes']) as unknown as number[] | undefined;
    const price = args['priceDollars'];
    const fields: Field[] = [
      { label: 'Service', value: str(args['name']) ?? current?.name ?? '' },
      ...(durations
        ? [{ label: 'How long', value: durations.map((d) => `${d} min`).join(' or ') }]
        : []),
      ...(price === undefined
        ? []
        : [
            {
              label: 'Price',
              value: price === null ? 'No set price' : dollars(Number(price) * 100),
            },
          ]),
      ...(num(args['bufferBeforeMinutes']) === undefined &&
      num(args['bufferAfterMinutes']) === undefined
        ? []
        : [
            {
              label: 'Gap around it',
              value: [
                num(args['bufferBeforeMinutes']) === undefined
                  ? null
                  : `${num(args['bufferBeforeMinutes'])} min before`,
                num(args['bufferAfterMinutes']) === undefined
                  ? null
                  : `${num(args['bufferAfterMinutes'])} min after`,
              ]
                .filter(Boolean)
                .join(', '),
            },
          ]),
      ...(list(args['staffUserIds'])
        ? [{ label: 'Who can do it', value: await teamNames(db, ctx, list(args['staffUserIds'])!) }]
        : []),
    ];
    return {
      card: settingsCard(toolCallId, 'manage_service', {
        title:
          act === 'create'
            ? `Add ${str(args['name']) ?? 'a service'}`
            : `Change ${current?.name ?? 'the service'}`,
        fields,
        confirmLabel: act === 'create' ? 'Add it' : 'Save the change',
      }),
      result: { waiting: true, creating: act === 'create' },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    if (act === 'archive') {
      await command(db, ctx, 'service.archive', { serviceId: args['serviceId'] });
      return { outcome: 'Archived', href: null, command: 'service.archive' };
    }
    const price = args['priceDollars'];
    const input = defined({
      name: str(args['name']),
      description: str(args['description']),
      durations: list(args['durationsMinutes']),
      priceCents:
        price === undefined ? undefined : price === null ? null : Math.round(Number(price) * 100),
      bufferBefore: num(args['bufferBeforeMinutes']),
      bufferAfter: num(args['bufferAfterMinutes']),
      staffUserIds: list(args['staffUserIds']),
    });
    if (act === 'create') {
      await command(db, ctx, 'service.create', input);
      return {
        outcome: `${str(args['name'])} is ready to book`,
        href: `/app/w/${ctx.workspaceId}/settings/calendars/services`,
        command: 'service.create',
      };
    }
    await command(db, ctx, 'service.update', { serviceId: args['serviceId'], ...input });
    return {
      outcome: 'Changed',
      href: `/app/w/${ctx.workspaceId}/settings/calendars/services`,
      command: 'service.update',
    };
  },
};

const manageResource: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const { items } = await query<{ items: Named[] }>(db, ctx, 'resource.list').catch(() => ({
      items: [] as Named[],
    }));
    const current = items.find((r) => r.id === args['resourceId']);
    const quantity = num(args['quantity']);
    return {
      card: settingsCard(toolCallId, 'manage_resource', {
        title:
          act === 'create'
            ? `Add ${str(args['name']) ?? 'a resource'}`
            : act === 'archive'
              ? `Archive ${current?.name ?? 'the resource'}`
              : `Change ${current?.name ?? 'the resource'}`,
        fields: [
          { label: 'Resource', value: str(args['name']) ?? current?.name ?? '' },
          ...(str(args['kind']) ? [{ label: 'What it is', value: str(args['kind'])! }] : []),
          ...(quantity === undefined ? [] : [{ label: 'How many', value: String(quantity) }]),
          ...(args['location'] === undefined
            ? []
            : [{ label: 'Where', value: str(args['location']) ?? 'Nowhere in particular' }]),
        ],
        confirmLabel:
          act === 'create' ? 'Add it' : act === 'archive' ? 'Archive it' : 'Save the change',
      }),
      result: { waiting: true, action: act },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    if (act === 'archive') {
      await command(db, ctx, 'resource.archive', { resourceId: args['resourceId'] });
      return { outcome: 'Archived', href: null, command: 'resource.archive' };
    }
    const input = defined({
      name: str(args['name']),
      kind: str(args['kind']),
      quantity: num(args['quantity']),
      location: args['location'] === undefined ? undefined : (str(args['location']) ?? null),
    });
    const href = `/app/w/${ctx.workspaceId}/settings/calendars/resources`;
    if (act === 'create') {
      await command(db, ctx, 'resource.create', input);
      return { outcome: `${str(args['name'])} is added`, href, command: 'resource.create' };
    }
    await command(db, ctx, 'resource.update', { resourceId: args['resourceId'], ...input });
    return { outcome: 'Changed', href, command: 'resource.update' };
  },
};

const manageTerritory: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const { items } = await query<{ items: Named[] }>(db, ctx, 'territory.list').catch(() => ({
      items: [] as Named[],
    }));
    const current = items.find((t) => t.id === args['territoryId']);
    const zips = list(args['postalCodes']);
    const people = list(args['userIds']);
    return {
      card: settingsCard(toolCallId, 'manage_territory', {
        title:
          act === 'create'
            ? `Add ${str(args['name']) ?? 'a territory'}`
            : act === 'delete'
              ? `Delete ${current?.name ?? 'the territory'}`
              : `Change ${current?.name ?? 'the territory'}`,
        fields: [
          { label: 'Territory', value: str(args['name']) ?? current?.name ?? '' },
          ...(zips
            ? [
                {
                  label: 'ZIP codes',
                  value: zips.length > 6 ? `${zips.length} ZIP codes` : zips.join(', '),
                },
              ]
            : []),
          ...(people ? [{ label: 'Who covers it', value: await teamNames(db, ctx, people) }] : []),
        ],
        confirmLabel:
          act === 'create' ? 'Add it' : act === 'delete' ? 'Delete it' : 'Save the change',
        warnings:
          act === 'delete'
            ? [{ kind: 'note', text: 'Visits already booked stay where they are.' }]
            : [],
      }),
      result: { waiting: true, action: act },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const href = `/app/w/${ctx.workspaceId}/settings/calendars/territories`;
    if (act === 'delete') {
      await command(db, ctx, 'territory.delete', { territoryId: args['territoryId'] });
      return { outcome: 'Deleted', href, command: 'territory.delete' };
    }
    const input = defined({
      name: str(args['name']),
      postalCodes: list(args['postalCodes']),
      userIds: list(args['userIds']),
    });
    if (act === 'create') {
      await command(db, ctx, 'territory.create', input);
      return { outcome: `${str(args['name'])} is added`, href, command: 'territory.create' };
    }
    await command(db, ctx, 'territory.update', { territoryId: args['territoryId'], ...input });
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
