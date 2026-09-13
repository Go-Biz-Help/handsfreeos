/**
 * Answers to "How do you want this calendar to work?". A preset only prefills settings: the result is an
 * ordinary settings document that can be changed in any way afterwards.
 */
import {
  applyPatch,
  defaultConfig,
  type CalendarConfig,
  type ConfigPatch,
  type TeamMember,
} from './config';

export const PRESET_KEYS = [
  'personal',
  'round_robin',
  'service',
  'group',
  'event',
  'resource',
  'collective',
  'dispatch',
  'scratch',
] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

export interface CalendarPreset {
  readonly key: PresetKey;
  readonly name: string;
  readonly description: string;
  /** The settings it fills in (people, services and resources come from the context). */
  readonly config: ConfigPatch;
}

export const CALENDAR_PRESETS: readonly CalendarPreset[] = [
  {
    key: 'personal',
    name: 'Personal',
    description: 'Customers book time with you.',
    config: { public: true, team: { assignment: 'fixed' }, durations: { minutes: [60] } },
  },
  {
    key: 'round_robin',
    name: 'Round Robin',
    description: 'Bookings take turns across the people you pick.',
    config: { public: true, team: { assignment: 'round_robin' } },
  },
  {
    key: 'service',
    name: 'Service',
    description: 'Customers pick a service and the first free person takes it.',
    config: { public: true, team: { assignment: 'first_available' }, services: { mode: 'choice' } },
  },
  {
    key: 'group',
    name: 'Group/Class',
    description: 'Several customers book the same time, with a waitlist when it’s full.',
    config: { public: true, capacity: { seats: 10, maxPartySize: 4 }, waitlist: { enabled: true } },
  },
  {
    key: 'event',
    name: 'Event',
    description: 'You publish dates and customers take seats.',
    config: {
      public: true,
      schedule: { mode: 'sessions' },
      capacity: { seats: 50 },
      waitlist: { enabled: true },
      durations: { minutes: [60], customerChooses: false },
      recurring: { customerSeries: false },
    },
  },
  {
    key: 'resource',
    name: 'Resource',
    description: 'Books a bed, room or piece of equipment. No staff needed.',
    config: { public: true, team: { assignment: 'none' } },
  },
  {
    key: 'collective',
    name: 'Collective',
    description: 'Two people attend every booking together.',
    config: { public: true, team: { assignment: 'collective' } },
  },
  {
    key: 'dispatch',
    name: 'Dispatch',
    description: 'Visits at the customer’s address, routed by ZIP with travel time.',
    config: {
      public: true,
      team: { assignment: 'round_robin' },
      territory: { routing: 'zip' },
      buffers: { travelMinutes: 30 },
      locations: { options: [{ kind: 'customer_address' }] },
    },
  },
  {
    key: 'scratch',
    name: 'Start from scratch',
    description: 'Every setting at its default.',
    config: {},
  },
];

export interface PresetContext {
  /** The person creating the calendar. */
  readonly me: string;
  /** People picked in the preset step (Round Robin and Dispatch use them instead of you; Resource has none). */
  readonly teammates?: readonly string[];
  readonly services?: readonly string[];
  readonly resources?: readonly string[];
}

const member = (userId: string, required = false): TeamMember => ({
  userId,
  weight: 1,
  priority: 0,
  required,
});
const unique = (ids: readonly string[]) => [...new Set(ids)];

function people(key: PresetKey, ctx: PresetContext): TeamMember[] {
  const picked = unique(ctx.teammates ?? []);
  switch (key) {
    case 'scratch':
    case 'resource':
      return [];
    case 'round_robin':
    case 'dispatch':
      return (picked.length ? picked : [ctx.me]).map((u) => member(u));
    case 'service':
      return unique([ctx.me, ...picked]).map((u) => member(u));
    case 'collective':
      // Needs a teammate; without one, collective_needs_two shows with its fixes.
      return unique([ctx.me, ...picked.slice(0, 1)]).map((u) => member(u, true));
    default:
      return [member(ctx.me)];
  }
}

/** A complete settings document from a preset. */
export function configFromPreset(preset: PresetKey, ctx: PresetContext): CalendarConfig {
  const found = CALENDAR_PRESETS.find((p) => p.key === preset);
  if (!found) throw new RangeError(`Unknown preset: ${preset}`);
  const members = people(preset, ctx);
  let config = applyPatch(applyPatch(defaultConfig(), found.config), { team: { members } });
  if (preset === 'service' && ctx.services?.length)
    config = applyPatch(config, {
      services: { items: unique(ctx.services).map((serviceId) => ({ serviceId })) },
    });
  if (preset === 'resource') {
    // No staff: the resource and the hours alone decide what can be booked.
    const [resourceId] = ctx.resources ?? [];
    if (resourceId)
      config = applyPatch(config, { resources: { required: [{ resourceId, quantity: 1 }] } });
  }
  return config;
}
