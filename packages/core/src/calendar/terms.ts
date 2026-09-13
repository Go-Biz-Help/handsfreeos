/**
 * The effective terms of one booking on a calendar: the calendar's settings, the service's catalog entry and
 * this calendar's overrides for that service, composed. Rules and the engine both read terms from here.
 */
import type { CatalogService } from './catalogs';
import type { CalendarConfig, LocationKind, RequiredResource } from './config';

export interface Terms {
  readonly serviceId: string | null;
  /** Allowed lengths in minutes (the first is the default). */
  readonly durations: readonly number[];
  readonly bufferBefore: number;
  readonly bufferAfter: number;
  /** Added on both sides, customer-address visits only. */
  readonly travelMinutes: number;
  readonly seats: number;
  readonly maxPartySize: number;
  /** Who may do it among the calendar's people; null means all of them. */
  readonly eligibleUserIds: readonly string[] | null;
  readonly requiredResources: readonly RequiredResource[];
}

/**
 * Lengths: the override, else the service, else the calendar. Buffers: the larger of the calendar's and the
 * service's (the override replaces the service's). Seats and party size: the override, else the calendar.
 * Staff: the service's eligible people narrowed by the override. Resources: the calendar's plus the
 * service's, taking the larger quantity of each.
 */
export function resolveTerms(config: CalendarConfig, service?: CatalogService | null): Terms {
  const item = service ? config.services.items.find((i) => i.serviceId === service.id) : undefined;
  const o = item?.overrides ?? {};
  const durations = o.minutes?.length
    ? o.minutes
    : service?.durations.length
      ? service.durations
      : config.durations.minutes;
  let eligible: string[] | null = service?.eligibleUserIds.length
    ? [...service.eligibleUserIds]
    : null;
  if (o.userIds)
    eligible = eligible ? eligible.filter((u) => o.userIds!.includes(u)) : [...o.userIds];
  const resources = new Map<string, number>();
  for (const r of [...config.resources.required, ...(service?.requiredResources ?? [])])
    resources.set(r.resourceId, Math.max(resources.get(r.resourceId) ?? 0, r.quantity));
  const seats = o.seats ?? config.capacity.seats;
  return {
    serviceId: service?.id ?? null,
    durations: [...durations],
    bufferBefore: Math.max(config.buffers.before, o.bufferBefore ?? service?.bufferBefore ?? 0),
    bufferAfter: Math.max(config.buffers.after, o.bufferAfter ?? service?.bufferAfter ?? 0),
    travelMinutes: config.buffers.travelMinutes,
    seats,
    maxPartySize: Math.min(o.maxPartySize ?? config.capacity.maxPartySize, seats),
    eligibleUserIds: eligible,
    requiredResources: [...resources].map(([resourceId, quantity]) => ({ resourceId, quantity })),
  };
}

/** The lengths a customer can pick: all of them when they choose, else the default. */
export function bookableDurations(
  config: CalendarConfig,
  service?: CatalogService | null,
): number[] {
  const { durations } = resolveTerms(config, service);
  return config.durations.customerChooses ? [...durations] : durations.slice(0, 1);
}

/** The location used when the customer doesn't pick one. */
export function defaultLocationKind(config: CalendarConfig): LocationKind | null {
  return config.locations.options[0]?.kind ?? null;
}

export function hasCustomerAddress(config: CalendarConfig): boolean {
  return config.locations.options.some((o) => o.kind === 'customer_address');
}

/** Calendar people allowed by the terms, in team order. */
export function eligibleMembers(config: CalendarConfig, terms: Terms): string[] {
  return config.team.members
    .map((m) => m.userId)
    .filter((u) => terms.eligibleUserIds === null || terms.eligibleUserIds.includes(u));
}
