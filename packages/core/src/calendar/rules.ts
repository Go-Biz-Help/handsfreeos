/**
 * The conflict rules. Settings never lock each other out: when two of them fight, an issue explains it in a
 * short sentence and offers fixes as settings patches. Errors block saving an active calendar (drafts and
 * paused calendars can be saved with them); warnings never block.
 *
 * `seats_below_booked` is not here: it depends on upcoming bookings, so impact.ts reports it on save.
 */
import { personName, resourceName, type CalendarCatalogs, type CatalogService } from './catalogs';
import type { CalendarConfig, ConfigPatch, TeamMember, WeeklyHours } from './config';
import { intersect, longest, normalize, union, type Interval } from './engine/intervals';
import { localDateOf, parseClock } from './engine/zoned';
import { formatDuration } from './format';
import { eligibleMembers, hasCustomerAddress, resolveTerms } from './terms';

export const ISSUE_CODES = [
  'collective_needs_two',
  'crew_exceeds_team',
  'weights_ignored',
  'choice_with_one',
  'none_without_limit',
  'members_ignored',
  'open_all_day',
  'sessions_multi_duration',
  'sessions_customer_series',
  'travel_without_visits',
  'zip_without_visits',
  'zip_uncovered',
  'party_over_seats',
  'resource_archived',
  'resource_quantity',
  'service_archived',
  'service_no_staff',
  'duration_no_fit',
  'window_inverted',
  'window_past',
  'payment_unavailable',
  'deposit_without_amount',
  'payment_without_price',
  'payment_account_gone',
  'member_gone',
  'public_without_team',
  'lead_stage_gone',
  'text_not_ready',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface IssueFix {
  readonly id: string;
  readonly label: string;
  readonly patch: ConfigPatch;
}

export interface CalendarIssue {
  readonly code: IssueCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Dotted settings paths the builder highlights, e.g. 'team.assignment'. */
  readonly fields: readonly string[];
  readonly fixes: readonly IssueFix[];
}
export type Issue = CalendarIssue;

export function hasBlockingIssues(issues: readonly CalendarIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

const WEEK = 7 * 1440;
const FULL_WEEK: Interval[] = [{ start: 0, end: WEEK }];

/** Weekly hours as minutes-of-week intervals (Sunday 00:00 is 0). */
function weekIntervals(hours: WeeklyHours | null | undefined): Interval[] {
  if (!hours) return FULL_WEEK;
  return normalize(
    hours.map((h) => ({
      start: h.day * 1440 + parseClock(h.start),
      end: h.day * 1440 + parseClock(h.end),
    })),
  );
}

const withMembers = (members: readonly TeamMember[]): ConfigPatch => ({
  team: { members: [...members] },
});
const newMember = (userId: string, required = false): TeamMember => ({
  userId,
  weight: 1,
  priority: 0,
  required,
});

interface Ctx {
  readonly config: CalendarConfig;
  readonly catalogs: CalendarCatalogs;
  readonly now: number;
  readonly memberIds: ReadonlySet<string>;
  readonly activeIds: ReadonlySet<string>;
  readonly push: (issue: CalendarIssue) => void;
}

function customerAddressFix(config: CalendarConfig): IssueFix[] {
  if (config.locations.options.length >= 10) return [];
  return [
    {
      id: 'add_customer_address',
      label: 'Add customer address',
      patch: {
        locations: {
          options: [
            ...config.locations.options,
            { kind: 'customer_address', address: null, meetingUrl: null },
          ],
        },
      },
    },
  ];
}

function teamRules({ config, catalogs, memberIds, activeIds, push }: Ctx): void {
  const { members, assignment, crewSize } = config.team;
  // With no staff, people are ignored: only members_ignored speaks about them.
  const none = assignment === 'none';
  const firstOutsider = catalogs.team.find((p) => p.active && !memberIds.has(p.userId));
  const toFixed: IssueFix = {
    id: 'switch_to_fixed',
    label: 'Switch to fixed person',
    patch: { team: { assignment: 'fixed' } },
  };

  if (assignment === 'collective' && members.length < 2)
    push({
      code: 'collective_needs_two',
      severity: 'error',
      message: 'Collective needs at least two people',
      fields: ['team.assignment', 'team.members'],
      fixes: [
        toFixed,
        ...(firstOutsider
          ? [
              {
                id: 'add_teammate',
                label: `Add ${firstOutsider.name}`,
                patch: withMembers([...members, newMember(firstOutsider.userId, true)]),
              },
            ]
          : []),
      ],
    });

  if (!none && crewSize > 1 && crewSize > members.length)
    push({
      code: 'crew_exceeds_team',
      severity: 'error',
      message: `Crew of ${crewSize} but only ${members.length} ${members.length === 1 ? 'person' : 'people'}`,
      fields: ['team.crewSize', 'team.members'],
      fixes: [
        {
          id: 'shrink_crew',
          label: `Set crew to ${Math.max(1, members.length)}`,
          patch: { team: { crewSize: Math.max(1, members.length) } },
        },
      ],
    });

  if (!none && assignment !== 'weighted' && members.some((m) => m.weight !== 1))
    push({
      code: 'weights_ignored',
      severity: 'warning',
      message: 'Weights only matter for weighted round robin',
      fields: ['team.members', 'team.assignment'],
      fixes: [
        {
          id: 'clear_weights',
          label: 'Clear weights',
          patch: withMembers(members.map((m) => ({ ...m, weight: 1 }))),
        },
        {
          id: 'switch_to_weighted',
          label: 'Switch to weighted',
          patch: { team: { assignment: 'weighted' } },
        },
      ],
    });

  if (assignment === 'customer_choice' && members.length === 1)
    push({
      code: 'choice_with_one',
      severity: 'warning',
      message: 'Customer’s choice with one person',
      fields: ['team.assignment', 'team.members'],
      fixes: [toFixed],
    });

  if (none && members.length)
    push({
      code: 'members_ignored',
      severity: 'warning',
      message: 'With no staff, the people listed are ignored',
      fields: ['team.members', 'team.assignment'],
      fixes: [{ id: 'clear_people', label: 'Clear people', patch: withMembers([]) }],
    });

  for (const m of members) {
    if (none || activeIds.has(m.userId)) continue;
    const name = personName(catalogs, m.userId);
    push({
      code: 'member_gone',
      severity: 'error',
      message: `${name} is no longer on the team`,
      fields: ['team.members'],
      fixes: [
        {
          id: 'remove_member',
          label: `Remove ${name}`,
          patch: withMembers(members.filter((x) => x.userId !== m.userId)),
        },
      ],
    });
  }

  if (config.public && !none && !members.some((m) => activeIds.has(m.userId)))
    push({
      code: 'public_without_team',
      severity: 'error',
      message: 'A public calendar needs someone to book',
      fields: ['public', 'team.members'],
      fixes: [
        ...(firstOutsider
          ? [
              {
                id: 'add_person',
                label: `Add ${firstOutsider.name}`,
                patch: withMembers([...members, newMember(firstOutsider.userId)]),
              },
            ]
          : []),
        { id: 'make_private', label: 'Make it private', patch: { public: false } },
      ],
    });
}

function scheduleRules({ config, push }: Ctx): void {
  if (config.schedule.mode !== 'sessions') return;
  const [first] = config.durations.minutes;
  if (config.durations.minutes.length > 1 && first !== undefined)
    push({
      code: 'sessions_multi_duration',
      severity: 'error',
      message: 'Fixed sessions use one length',
      fields: ['schedule.mode', 'durations.minutes'],
      fixes: [
        {
          id: 'keep_first_length',
          label: `Keep ${formatDuration(first)}`,
          patch: { durations: { minutes: [first], customerChooses: false } },
        },
      ],
    });
  if (config.recurring.customerSeries)
    push({
      code: 'sessions_customer_series',
      severity: 'error',
      message: 'Customers can’t repeat fixed sessions',
      fields: ['schedule.mode', 'recurring.customerSeries'],
      fixes: [
        {
          id: 'customer_series_off',
          label: 'Turn off customer repeats',
          patch: { recurring: { customerSeries: false } },
        },
      ],
    });
}

function visitRules({ config, catalogs, push }: Ctx): void {
  const visits = hasCustomerAddress(config);
  if (config.buffers.travelMinutes > 0 && !visits)
    push({
      code: 'travel_without_visits',
      severity: 'warning',
      message: 'Travel time needs a customer-address location',
      fields: ['buffers.travelMinutes', 'locations.options'],
      fixes: [
        { id: 'travel_zero', label: 'Set travel to 0', patch: { buffers: { travelMinutes: 0 } } },
        ...customerAddressFix(config),
      ],
    });
  if (config.territory.routing !== 'zip') return;
  if (!visits)
    push({
      code: 'zip_without_visits',
      severity: 'error',
      message: 'ZIP routing needs a customer-address location',
      fields: ['territory.routing', 'locations.options'],
      fixes: [
        { id: 'routing_off', label: 'Turn off routing', patch: { territory: { routing: 'off' } } },
        ...customerAddressFix(config),
      ],
    });
  // With no staff, routing only checks the customer's ZIP against the territories; nobody needs covering.
  if (config.team.assignment === 'none') return;
  const chosen = config.territory.territoryIds;
  const selected = chosen.length
    ? catalogs.territories.filter((t) => chosen.includes(t.id))
    : catalogs.territories;
  const covered = new Set(selected.flatMap((t) => t.userIds));
  for (const m of config.team.members) {
    if (covered.has(m.userId)) continue;
    const name = personName(catalogs, m.userId);
    const theirs = chosen.length
      ? catalogs.territories.find((t) => t.userIds.includes(m.userId))
      : undefined;
    push({
      code: 'zip_uncovered',
      severity: 'warning',
      message: `${name} isn’t in any selected territory`,
      fields: ['territory.territoryIds', 'team.members'],
      fixes: [
        ...(theirs
          ? [
              {
                id: 'add_territory',
                label: `Add ${theirs.name}`,
                patch: { territory: { territoryIds: [...chosen, theirs.id] } },
              },
            ]
          : []),
        {
          id: 'remove_member',
          label: `Remove ${name}`,
          patch: withMembers(config.team.members.filter((x) => x.userId !== m.userId)),
        },
      ],
    });
  }
}

function capacityRules({ config, catalogs, push }: Ctx): void {
  const { seats, maxPartySize } = config.capacity;
  if (maxPartySize > seats)
    push({
      code: 'party_over_seats',
      severity: 'error',
      message: 'Party size larger than seats',
      fields: ['capacity.maxPartySize', 'capacity.seats'],
      fixes: [
        {
          id: 'party_to_seats',
          label: `Set party size to ${seats}`,
          patch: { capacity: { maxPartySize: seats } },
        },
      ],
    });
  const required = config.resources.required;
  for (const r of required) {
    const resource = catalogs.resources.find((x) => x.id === r.resourceId);
    const name = resourceName(catalogs, r.resourceId);
    if (!resource || resource.archived) {
      push({
        code: 'resource_archived',
        severity: 'error',
        message: resource ? `${name} was archived` : 'A required resource was archived',
        fields: ['resources.required'],
        fixes: [
          {
            id: 'remove_resource',
            label: `Remove ${resource ? name : 'it'}`,
            patch: { resources: { required: required.filter((x) => x !== r) } },
          },
        ],
      });
    } else if (r.quantity > resource.quantity) {
      push({
        code: 'resource_quantity',
        severity: 'error',
        message: `${name}: needs ${r.quantity} but only ${resource.quantity} ${resource.quantity === 1 ? 'exists' : 'exist'}`,
        fields: ['resources.required'],
        fixes: [
          {
            id: 'lower_quantity',
            label: `Set to ${resource.quantity}`,
            patch: {
              resources: {
                required: required.map((x) =>
                  x === r ? { ...x, quantity: resource.quantity } : x,
                ),
              },
            },
          },
        ],
      });
    }
  }
}

/** The calendar's services that are live in the catalog, with their catalog entries. */
function liveServices(config: CalendarConfig, catalogs: CalendarCatalogs) {
  if (config.services.mode === 'none') return [];
  return config.services.items.flatMap((item) => {
    const service = catalogs.services.find((s) => s.id === item.serviceId);
    return service && !service.archived ? [{ item, service }] : [];
  });
}

function serviceRules({ config, catalogs, memberIds, activeIds, push }: Ctx): void {
  const items = config.services.items;
  if (config.services.mode !== 'none')
    for (const item of items) {
      const service = catalogs.services.find((s) => s.id === item.serviceId);
      if (service && !service.archived) continue;
      const rest = items.filter((i) => i !== item);
      push({
        code: 'service_archived',
        severity: 'error',
        message: service ? `${service.name} was archived` : 'A service was archived',
        fields: ['services.items'],
        fixes: [
          {
            id: 'remove_service',
            label: `Remove ${service ? service.name : 'it'}`,
            patch: { services: { items: rest, ...(rest.length ? {} : { mode: 'none' as const }) } },
          },
        ],
      });
    }
  if (config.team.assignment === 'none') return;
  for (const { item, service } of liveServices(config, catalogs)) {
    const terms = resolveTerms(config, service);
    if (eligibleMembers(config, terms).some((u) => activeIds.has(u))) continue;
    const allowed = item.overrides.userIds;
    const candidate = catalogs.team.find(
      (p) =>
        p.active &&
        (service.eligibleUserIds.length === 0 || service.eligibleUserIds.includes(p.userId)),
    );
    const fixes: IssueFix[] = [];
    if (candidate) {
      const members = memberIds.has(candidate.userId)
        ? [...config.team.members]
        : [...config.team.members, newMember(candidate.userId)];
      const patch: ConfigPatch =
        allowed && !allowed.includes(candidate.userId)
          ? {
              team: { members },
              services: {
                items: items.map((i) =>
                  i === item
                    ? {
                        ...i,
                        overrides: { ...i.overrides, userIds: [...allowed, candidate.userId] },
                      }
                    : i,
                ),
              },
            }
          : { team: { members } };
      fixes.push({ id: 'add_eligible_staff', label: `Add ${candidate.name}`, patch });
    }
    const rest = items.filter((i) => i !== item);
    fixes.push({
      id: 'remove_service',
      label: `Remove ${service.name}`,
      patch: { services: { items: rest, ...(rest.length ? {} : { mode: 'none' as const }) } },
    });
    push({
      code: 'service_no_staff',
      severity: 'error',
      message: `No one on this calendar can do ${service.name}`,
      fields: ['services.items', 'team.members'],
      fixes,
    });
  }
}

/** What a booking can be for: each live service, or the calendar's own terms when none are offered. */
function bookingTargets(
  config: CalendarConfig,
  catalogs: CalendarCatalogs,
): (CatalogService | null)[] {
  const live = liveServices(config, catalogs).map((s) => s.service);
  return live.length ? live : [null];
}

const WEEKDAYS_9_TO_5: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));

/**
 * No staff (hours mode): the required resources and the hours are all that limit bookings. Every service a
 * customer can pick must need a resource, or one time could be booked without end; and with no calendar,
 * service or resource hours the calendar takes bookings around the clock.
 */
function noStaffRules({ config, catalogs, push }: Ctx): void {
  if (config.team.assignment !== 'none' || config.schedule.mode !== 'hours') return;
  const targets = bookingTargets(config, catalogs);
  const needs = (service: CatalogService | null) => resolveTerms(config, service).requiredResources;
  if (targets.some((service) => needs(service).length === 0)) {
    const resource = catalogs.resources.find((r) => !r.archived);
    push({
      code: 'none_without_limit',
      severity: 'error',
      message: 'With no staff, something has to limit bookings: add a resource',
      fields: ['team.assignment', 'resources.required'],
      fixes: [
        ...(resource
          ? [
              {
                id: 'add_resource',
                label: `Add ${resource.name}`,
                patch: {
                  resources: {
                    required: [
                      ...config.resources.required,
                      { resourceId: resource.id, quantity: 1 },
                    ],
                  },
                },
              },
            ]
          : []),
        {
          id: 'switch_to_fixed',
          label: 'Switch to fixed person',
          patch: { team: { assignment: 'fixed' } },
        },
      ],
    });
  }
  if (config.schedule.hours) return;
  const hoursOf = (id: string) => catalogs.resources.find((r) => r.id === id)?.hours;
  if (
    targets.some(
      (service) => !service?.hours && needs(service).every((r) => !hoursOf(r.resourceId)),
    )
  )
    push({
      code: 'open_all_day',
      severity: 'warning',
      message: 'Open all day, every day',
      fields: ['schedule.hours', 'resources.required'],
      fixes: [
        {
          id: 'set_hours',
          label: 'Set hours Mon–Fri 9–5',
          patch: { schedule: { hours: WEEKDAYS_9_TO_5 } },
        },
      ],
    });
}

/** Longest open stretch in a week for these terms (minutes), and whether the calendar's hours cause the squeeze. */
function openStretch(
  config: CalendarConfig,
  catalogs: CalendarCatalogs,
  service: CatalogService | null,
  withCalendarHours: boolean,
): number | null {
  const terms = resolveTerms(config, service);
  let staff: Interval[];
  if (config.team.assignment === 'none') {
    // No people: the required resources' hours take their place (a resource without hours is always open).
    staff = terms.requiredResources.reduce<Interval[]>(
      (acc, r) =>
        intersect(acc, weekIntervals(catalogs.resources.find((x) => x.id === r.resourceId)?.hours)),
      FULL_WEEK,
    );
  } else {
    const people = eligibleMembers(config, terms).filter((u) =>
      catalogs.team.some((p) => p.userId === u && p.active),
    );
    if (!people.length) return null;
    const hoursOf = (u: string) => weekIntervals(catalogs.team.find((p) => p.userId === u)?.hours);
    if (config.team.assignment === 'collective') {
      const marked = config.team.members.filter((m) => m.required).map((m) => m.userId);
      const required = (marked.length ? marked : people).filter((u) => people.includes(u));
      staff = required.reduce<Interval[]>((acc, u) => intersect(acc, hoursOf(u)), FULL_WEEK);
    } else staff = people.reduce<Interval[]>((acc, u) => union(acc, hoursOf(u)), []);
  }
  const calendar = withCalendarHours ? weekIntervals(config.schedule.hours) : FULL_WEEK;
  return longest(intersect(intersect(calendar, weekIntervals(service?.hours)), staff));
}

function durationRules({ config, catalogs, push }: Ctx): void {
  if (config.schedule.mode !== 'hours') return;
  const targets: {
    service: CatalogService | null;
    item?: CalendarConfig['services']['items'][number];
  }[] = config.services.mode === 'none' ? [{ service: null }] : liveServices(config, catalogs);
  for (const { service, item } of targets) {
    const room = openStretch(config, catalogs, service, true);
    if (room === null) continue;
    const lengths = resolveTerms(config, service).durations;
    const tooLong = lengths.filter((m) => m > room);
    if (!tooLong.length) continue;
    const worst = Math.max(...tooLong);
    const fitting = lengths.filter((m) => m <= room);
    const shorter = fitting.length ? fitting : room >= 5 ? [Math.floor(room / 5) * 5] : [];
    const fixes: IssueFix[] = [];
    if (shorter.length) {
      const patch: ConfigPatch = item
        ? {
            services: {
              items: config.services.items.map((i) =>
                i === item ? { ...i, overrides: { ...i.overrides, minutes: shorter } } : i,
              ),
            },
          }
        : { durations: { minutes: shorter } };
      fixes.push({
        id: 'shorten',
        label: `Shorten to ${formatDuration(Math.max(...shorter))}`,
        patch,
      });
    }
    const wider = config.schedule.hours ? openStretch(config, catalogs, service, false) : null;
    if (wider !== null && wider >= worst)
      fixes.push({ id: 'widen_hours', label: 'Widen hours', patch: { schedule: { hours: null } } });
    push({
      code: 'duration_no_fit',
      severity: 'warning',
      message: `${service ? `${service.name}: ` : ''}${formatDuration(worst)} doesn’t fit in any open window`,
      fields: item ? ['services.items', 'schedule.hours'] : ['durations.minutes', 'schedule.hours'],
      fixes,
    });
  }
}

function windowRules({ config, catalogs, now, push }: Ctx): void {
  const w = config.window;
  if (w.maxDaysAhead * 1440 < w.minNoticeMinutes) {
    const days = Math.min(365, Math.ceil(w.minNoticeMinutes / 1440) + 1);
    push({
      code: 'window_inverted',
      severity: 'error',
      message: 'Maximum notice shorter than minimum notice',
      fields: ['window.maxDaysAhead', 'window.minNoticeMinutes'],
      fixes: [
        {
          id: 'raise_max_notice',
          label: `Raise to ${days} days`,
          patch: { window: { maxDaysAhead: days } },
        },
      ],
    });
  }
  if (w.dateTo && w.dateTo < localDateOf(now, catalogs.timeZone))
    push({
      code: 'window_past',
      severity: 'warning',
      message: 'Date range already ended',
      fields: ['window.dateFrom', 'window.dateTo'],
      fixes: [
        {
          id: 'clear_dates',
          label: 'Clear the date range',
          patch: { window: { dateFrom: null, dateTo: null } },
        },
      ],
    });
}

function outsideRules({ config, catalogs, push }: Ctx): void {
  if (config.payments.mode !== 'none' && !catalogs.paymentsAvailable)
    push({
      code: 'payment_unavailable',
      severity: 'error',
      // The other way out of this one is connecting an account in Settings → Payments, which is a page to
      // visit rather than a settings patch: the builder puts that beside these fixes as a link.
      message: 'Taking payment at booking needs a connected payment account',
      fields: ['payments.mode'],
      fixes: [
        { id: 'payment_off', label: 'Turn off payment', patch: { payments: { mode: 'none' } } },
      ],
    });

  const pay = config.payments;
  // A deposit of 0% or $0 would hold a time for nothing and take nothing: say so before it's saved.
  if (pay.mode === 'deposit' && pay.deposit) {
    const figure = pay.deposit.kind === 'percent' ? pay.deposit.percentBp : pay.deposit.amountCents;
    if (!figure || figure <= 0)
      push({
        code: 'deposit_without_amount',
        severity: 'error',
        message: 'The deposit has no amount set',
        fields: ['payments.deposit'],
        fixes: [
          {
            id: 'deposit_business',
            label: 'Ask for what the business asks for',
            patch: { payments: { deposit: null } },
          },
          {
            id: 'deposit_quarter',
            label: 'Ask for 25%',
            patch: { payments: { deposit: { kind: 'percent', percentBp: 2_500 } } },
          },
        ],
      });
  }
  /**
   * It asks for a share of the price, and nothing it books has a price — so every booking would work out to
   * nothing and go through free. The page does exactly that rather than holding a time for $0, which is why
   * this is caught here, when the calendar is being set up, and not at the moment a customer books.
   */
  if (pay.mode !== 'none') {
    const terms = pay.deposit ?? catalogs.businessDeposit;
    const setAmount =
      pay.mode === 'deposit' && terms.kind === 'amount' && (terms.amountCents ?? 0) > 0;
    const priced = config.services.items.some((item) => {
      const service = catalogs.services.find((s) => s.id === item.serviceId);
      return !!service && !service.archived && (service.priceCents ?? 0) > 0;
    });
    if (!setAmount && !priced)
      push({
        code: 'payment_without_price',
        severity: 'error',
        message:
          pay.mode === 'full'
            ? 'This calendar asks for the full price, but nothing it books has a price'
            : 'This calendar asks for a deposit, but nothing it books has a price',
        fields: ['payments.mode', 'payments.deposit', 'services.items'],
        fixes: [
          { id: 'payment_off', label: 'Turn off payment', patch: { payments: { mode: 'none' } } },
          {
            id: 'deposit_set_amount',
            label: 'Ask for a set amount',
            patch: {
              payments: { mode: 'deposit', deposit: { kind: 'amount', amountCents: 5_000 } },
            },
          },
        ],
      });
  }
  // The account this calendar names was disconnected: money would land nowhere, so nobody could book.
  if (
    pay.mode !== 'none' &&
    pay.connectionId &&
    catalogs.paymentAccounts.length > 0 &&
    !catalogs.paymentAccounts.some((a) => a.id === pay.connectionId)
  )
    push({
      code: 'payment_account_gone',
      severity: 'error',
      message: 'The account this calendar is paid into isn’t connected any more',
      fields: ['payments.connectionId'],
      fixes: [
        {
          id: 'payment_default_account',
          label: 'Use the business’s account',
          patch: { payments: { connectionId: null } },
        },
      ],
    });

  const lead = config.crm.createLead;
  if (lead) {
    const pipeline = catalogs.pipelines.find((p) => p.id === lead.pipelineId);
    const stage = pipeline?.stages.find((s) => s.id === lead.stageId);
    if (!pipeline || pipeline.archived || !stage || stage.archived) {
      const candidates = [
        ...(pipeline && !pipeline.archived ? [pipeline] : []),
        ...catalogs.pipelines.filter((p) => !p.archived && p !== pipeline),
      ];
      const pick = candidates
        .map((p) => ({ p, s: p.stages.find((s) => !s.archived) }))
        .find((c) => c.s !== undefined);
      push({
        code: 'lead_stage_gone',
        severity: 'error',
        message:
          !pipeline || pipeline.archived
            ? 'The lead pipeline was archived'
            : 'The lead stage was archived',
        fields: ['crm.createLead'],
        fixes: [
          ...(pick && pick.s
            ? [
                {
                  id: 'pick_stage',
                  label: `Use ${pick.p.name} · ${pick.s.name}`,
                  patch: { crm: { createLead: { pipelineId: pick.p.id, stageId: pick.s.id } } },
                },
              ]
            : []),
          { id: 'lead_off', label: 'Turn off lead creation', patch: { crm: { createLead: null } } },
        ],
      });
    }
  }

  const n = config.notifications;
  if (
    !catalogs.textingReady &&
    (n.confirmation.text || (n.reminders.length > 0 && n.reminderChannels.text))
  )
    push({
      code: 'text_not_ready',
      severity: 'warning',
      message: 'Text reminders wait until texting is set up',
      fields: ['notifications.confirmation', 'notifications.reminderChannels'],
      fixes: [
        {
          id: 'email_only',
          label: 'Email only for now',
          patch: {
            notifications: {
              confirmation: { text: false, email: true },
              reminderChannels: { text: false, email: true },
            },
          },
        },
      ],
    });
}

/** Every conflict in a settings document, in a stable order. */
export function validateCalendar(
  config: CalendarConfig,
  catalogs: CalendarCatalogs,
  now: Date | number = Date.now(),
): CalendarIssue[] {
  const issues: CalendarIssue[] = [];
  const ctx: Ctx = {
    config,
    catalogs,
    now: typeof now === 'number' ? now : now.getTime(),
    memberIds: new Set(config.team.members.map((m) => m.userId)),
    activeIds: new Set(catalogs.team.filter((p) => p.active).map((p) => p.userId)),
    push: (issue) => issues.push(issue),
  };
  teamRules(ctx);
  noStaffRules(ctx);
  scheduleRules(ctx);
  visitRules(ctx);
  capacityRules(ctx);
  serviceRules(ctx);
  durationRules(ctx);
  windowRules(ctx);
  outsideRules(ctx);
  const order = new Map(ISSUE_CODES.map((c, i) => [c, i]));
  return issues.sort((a, b) => order.get(a.code)! - order.get(b.code)!);
}
