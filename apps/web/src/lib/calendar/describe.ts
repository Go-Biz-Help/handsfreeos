/**
 * Plain words about a calendar's settings: the builder's "How this calendar works" list and each module's
 * one-line summary. Computed from the draft, so they change as it is edited.
 */
import {
  formatDuration,
  formatHours,
  formatNotice,
  LOCATION_NAMES,
  personName,
  type CalendarCatalogs,
  type CalendarConfig,
} from '@hfos/core';
import { fmtLength } from './time';

export const MODULES = [
  { key: 'team', name: 'Team & assignment' },
  { key: 'services', name: 'Services & lengths' },
  { key: 'availability', name: 'Availability' },
  { key: 'capacity', name: 'Capacity' },
  { key: 'locations', name: 'Locations' },
  { key: 'resources', name: 'Resources' },
  { key: 'buffers', name: 'Buffers & travel' },
  { key: 'territories', name: 'Territories' },
  { key: 'window', name: 'Booking window' },
  { key: 'repeats', name: 'Repeats' },
  { key: 'waitlist', name: 'Waitlist' },
  { key: 'intake', name: 'Intake questions' },
  { key: 'rules', name: 'Cancel & reschedule rules' },
  { key: 'notify', name: 'Notifications' },
  { key: 'connections', name: 'Calendar connections' },
  { key: 'crm', name: 'CRM' },
  { key: 'payments', name: 'Payments', soon: 'Coming with Payments' },
  { key: 'automations', name: 'Automations' },
] as const;
export type ModuleKey = (typeof MODULES)[number]['key'];

/** Which module a rule's settings path belongs to ('team.assignment' → team). */
const FIELD_MODULE: Record<string, ModuleKey> = {
  public: 'team',
  team: 'team',
  services: 'services',
  durations: 'services',
  schedule: 'availability',
  capacity: 'capacity',
  locations: 'locations',
  resources: 'resources',
  buffers: 'buffers',
  territory: 'territories',
  window: 'window',
  recurring: 'repeats',
  waitlist: 'waitlist',
  intake: 'intake',
  policies: 'rules',
  notifications: 'notify',
  integrations: 'connections',
  crm: 'crm',
  payments: 'payments',
  automations: 'automations',
};

export function moduleOfField(field: string): ModuleKey | null {
  return FIELD_MODULE[field.split('.')[0] ?? ''] ?? null;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const COUNT = ['', 'one', 'both', 'all three', 'all four', 'all five', 'all six', 'all seven'];

/** "Priya, Marco and Dale" / "Priya or Marco". */
export function joinWords(list: readonly string[], word = 'and'): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} ${word} ${list[list.length - 1]}`;
}

const lengths = (list: readonly number[], word = 'or') => joinWords(list.map(fmtLength), word);

/** What a booking reserves: the calendar's resources and those of its services, by name. */
export function reservedNames(config: CalendarConfig, catalogs: CalendarCatalogs): string[] {
  const ids = [
    ...config.resources.required.map((r) => r.resourceId),
    ...config.services.items.flatMap(
      (i) =>
        catalogs.services
          .find((s) => s.id === i.serviceId)
          ?.requiredResources.map((r) => r.resourceId) ?? [],
    ),
  ];
  return [...new Set(ids)].map(
    (id) => catalogs.resources.find((r) => r.id === id)?.name ?? 'a resource',
  );
}

export function teamSentence(config: CalendarConfig, catalogs: CalendarCatalogs): string {
  const { members, assignment, crewSize } = config.team;
  if (assignment === 'none') {
    const reserved = reservedNames(config, catalogs);
    return reserved.length
      ? `No staff needed. A time is open while the calendar is open and a ${joinWords(reserved, 'or')} is free.`
      : 'No staff needed. Nothing limits how many bookings share a time until you add a resource.';
  }
  const name = (userId: string) => firstName(personName(catalogs, userId));
  const names = members.map((m) => name(m.userId));
  if (!names.length) return 'Nobody is on this calendar yet, so nobody can be booked.';
  const crew =
    crewSize > 1 && assignment !== 'collective' ? ` Each booking sends ${crewSize} people.` : '';
  switch (assignment) {
    case 'fixed':
      return `Every booking goes to ${names[0]}.${crew}`;
    case 'customer_choice':
      return `Customers pick ${joinWords(names, 'or')} when they book.${crew}`;
    case 'round_robin':
      return names.length > 1
        ? `${joinWords(names)} take turns. Whoever went longest ago goes next.${crew}`
        : `Every booking goes to ${names[0]} until someone else joins.${crew}`;
    case 'weighted': {
      const total = members.reduce((n, m) => n + m.weight, 0);
      return `Out of every ${total} bookings, ${joinWords(members.map((m) => `${name(m.userId)} gets ${m.weight}`))}.${crew}`;
    }
    case 'first_available': {
      const ordered = members
        .map((m, i) => ({ m, i }))
        .sort((a, b) => b.m.priority - a.m.priority || a.i - b.i)
        .map(({ m }) => name(m.userId));
      return ordered.length > 1
        ? `The first free person takes it, in this order: ${ordered.join(', then ')}.${crew}`
        : `Every booking goes to ${ordered[0]} when free.${crew}`;
    }
    case 'collective': {
      const required = members.filter((m) => m.required);
      const list = (required.length ? required : members).map((m) => name(m.userId));
      if (list.length < 2) return `${list[0]} goes to every booking.`;
      return `${joinWords(list)} all go together, so only times when ${COUNT[list.length] ?? 'all of them'} are free show.`;
    }
  }
}

function whatSentence(config: CalendarConfig, catalogs: CalendarCatalogs): string {
  if (config.services.mode === 'none') {
    const mins = config.durations.minutes;
    return config.durations.customerChooses && mins.length > 1
      ? `Customers pick ${lengths(mins)}.`
      : `Each booking is ${fmtLength(mins[0] ?? 60)}.`;
  }
  const items = config.services.items.map((i) => {
    const svc = catalogs.services.find((s) => s.id === i.serviceId);
    const mins = i.overrides.minutes ?? svc?.durations ?? [];
    return `${svc?.name ?? 'A service'}${mins.length ? ` (${lengths(mins)})` : ''}`;
  });
  if (!items.length) return 'Services are on, but none are picked yet.';
  if (config.services.mode === 'one' || items.length === 1) return `Every booking is ${items[0]}.`;
  return `Customers pick ${joinWords(items, 'or')}.`;
}

function reminderWords(config: CalendarConfig): string[] {
  return config.notifications.reminders.map((r) =>
    r.kind === 'day_before' ? 'the day before' : `${formatDuration(r.minutes)} before`,
  );
}

/** "How this calendar works": a handful of short sentences. */
export function describeCalendar(config: CalendarConfig, catalogs: CalendarCatalogs): string[] {
  const out = [whatSentence(config, catalogs), teamSentence(config, catalogs)];
  const kinds = config.locations.options.map((o) => o.kind);
  if (kinds.includes('customer_address'))
    out.push(
      `We go to the customer’s address.${config.territory.routing === 'zip' ? ' Their ZIP code decides who can take it.' : ''}`,
    );
  else if (kinds.includes('business')) {
    const address = config.locations.options.find((o) => o.kind === 'business')?.address;
    out.push(`Customers come to ${address || 'the business'}.`);
  } else if (kinds.includes('virtual')) out.push('It happens on a video call.');
  else if (kinds.includes('phone')) out.push('It happens on a phone call.');
  if (kinds.length > 1 && config.locations.customerChooses)
    out.push(
      `Customers pick where: ${joinWords(
        kinds.map((k) => LOCATION_NAMES[k]),
        'or',
      )}.`,
    );
  const { before, after, travelMinutes } = config.buffers;
  if (travelMinutes && kinds.includes('customer_address'))
    out.push(`${fmtLength(travelMinutes)} of travel is kept before and after each visit.`);
  if (before || after)
    out.push(
      before === after
        ? `${fmtLength(before)} is kept free before and after each booking.`
        : `${[before ? `${fmtLength(before)} before` : '', after ? `${fmtLength(after)} after` : ''].filter(Boolean).join(' and ')} each booking is kept free.`,
    );
  if (config.capacity.seats > 1)
    out.push(
      `Up to ${config.capacity.seats} people per time, in groups of up to ${Math.min(config.capacity.maxPartySize, config.capacity.seats)}.${config.waitlist.enabled ? ' A waitlist opens when it’s full.' : ''}`,
    );
  const notice = config.window.minNoticeMinutes;
  const ahead = `${notice ? `from ${formatNotice(notice)}` : 'from right now'} to ${config.window.maxDaysAhead} days ahead`;
  out.push(
    config.schedule.mode === 'sessions'
      ? `Customers take seats in the dates you publish, ${ahead}.`
      : `Bookable ${
          config.schedule.hours
            ? formatHours(config.schedule.hours)
            : config.team.assignment === 'none'
              ? 'at any hour of every day'
              : 'during each person’s own hours'
        }, ${ahead}.`,
  );
  const reminders = reminderWords(config);
  const confirm = config.notifications.confirmation.text || config.notifications.confirmation.email;
  out.push(
    reminders.length
      ? `Customers get ${confirm ? 'a confirmation, then ' : ''}reminders ${joinWords(reminders)}.`
      : confirm
        ? 'Customers get a confirmation and no reminders.'
        : 'Customers don’t get a confirmation or reminders.',
  );
  if (!config.public) out.push('It isn’t on the booking page. Staff book it from the calendar.');
  return out;
}

const METHOD = {
  fixed: 'fixed person',
  customer_choice: 'customer’s choice',
  round_robin: 'taking turns',
  weighted: 'weighted turns',
  first_available: 'first available',
  collective: 'all together',
  none: 'no staff needed',
} as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The line under each module's name in the builder's list. */
export function moduleSummary(
  key: ModuleKey,
  config: CalendarConfig,
  catalogs: CalendarCatalogs,
): string {
  switch (key) {
    case 'team': {
      if (config.team.assignment === 'none') return 'No staff needed';
      const n = config.team.members.length;
      return n
        ? `${plural(n, 'person', 'people')} · ${METHOD[config.team.assignment]}`
        : 'Nobody yet';
    }
    case 'services':
      return config.services.mode === 'none'
        ? lengths(config.durations.minutes, config.durations.customerChooses ? 'or' : 'and')
        : plural(config.services.items.length, 'service', 'services');
    case 'availability':
      return config.schedule.mode === 'sessions'
        ? 'Fixed sessions'
        : config.schedule.hours
          ? formatHours(config.schedule.hours)
          : config.team.assignment === 'none'
            ? 'Open all day, every day'
            : 'Each person’s own hours';
    case 'capacity':
      return config.capacity.seats === 1
        ? '1 customer per visit'
        : `${config.capacity.seats} seats · groups up to ${config.capacity.maxPartySize}`;
    case 'locations':
      return config.locations.options.length
        ? joinWords(
            config.locations.options.map(
              (o) => LOCATION_NAMES[o.kind][0]!.toUpperCase() + LOCATION_NAMES[o.kind].slice(1),
            ),
            'or',
          )
        : 'Not set';
    case 'resources':
      return config.resources.required.length
        ? config.resources.required
            .map((r) => catalogs.resources.find((x) => x.id === r.resourceId)?.name ?? 'A resource')
            .join(', ')
        : 'None on the calendar';
    case 'buffers': {
      const b = config.buffers;
      if (b.travelMinutes) return `${fmtLength(b.travelMinutes)} travel`;
      if (b.before || b.after) return `${b.before} / ${b.after} min`;
      return 'None';
    }
    case 'territories':
      return config.territory.routing === 'zip'
        ? `ZIP routing · ${config.territory.territoryIds.length ? plural(config.territory.territoryIds.length, 'area', 'areas') : 'every area'}`
        : 'Off';
    case 'window':
      return `${config.window.minNoticeMinutes ? formatNotice(config.window.minNoticeMinutes) : 'Right away'} to ${config.window.maxDaysAhead} days ahead`;
    case 'repeats':
      return config.recurring.customerSeries
        ? 'Customers can repeat'
        : config.recurring.staffSeries
          ? 'Staff can repeat visits'
          : 'Off';
    case 'waitlist':
      return config.waitlist.enabled
        ? `On · offers last ${formatDuration(config.waitlist.offerMinutes)}`
        : 'Off';
    case 'intake':
      return config.intake.questions.length
        ? plural(config.intake.questions.length, 'question', 'questions')
        : 'No questions';
    case 'rules':
      return config.policies.cancel.allowed
        ? config.policies.cancel.cutoffHours
          ? `Up to ${plural(config.policies.cancel.cutoffHours, 'hour', 'hours')} before`
          : 'Any time before'
        : 'Customers can’t cancel online';
    case 'notify': {
      const c = config.notifications.reminderChannels;
      return c.text && c.email
        ? 'Text and email'
        : c.text
          ? 'Text only'
          : c.email
            ? 'Email only'
            : 'Off';
    }
    case 'connections':
      return config.integrations.checkStaffCalendars
        ? 'Checks Google and Outlook'
        : 'Doesn’t check calendars';
    case 'crm': {
      const lead = config.crm.createLead;
      if (lead) {
        const p = catalogs.pipelines.find((x) => x.id === lead.pipelineId);
        return `Creates a lead in ${p?.name ?? 'a pipeline'}`;
      }
      return config.crm.ownership === 'none'
        ? 'Doesn’t touch the CRM'
        : 'Keeps the customer’s owner';
    }
    case 'payments':
      return 'Coming with Payments';
    case 'automations':
      return 'Workflows for its appointments';
  }
}
