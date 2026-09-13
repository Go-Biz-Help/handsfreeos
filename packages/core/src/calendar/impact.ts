/**
 * What a settings change does to upcoming bookings. The save command runs this against a summary of future
 * appointments; any impact without a decision turns the save into 409 impact_review_required.
 * Existing appointments keep their revision's terms, so "keep" is always allowed.
 */
import { personName, resourceName, type CalendarCatalogs } from './catalogs';
import type { CalendarConfig } from './config';
import { countOf } from './format';

export interface UpcomingSummary {
  /** Future, not-cancelled appointments on this calendar per staff member. */
  readonly members: readonly { readonly userId: string; readonly appointments: number }[];
  /** Future appointments on this calendar holding each resource. */
  readonly resources: readonly { readonly resourceId: string; readonly appointments: number }[];
  /** Future sessions and group appointments with the seats already booked. */
  readonly sessions: readonly {
    readonly appointmentId: string;
    readonly seatsBooked: number;
    readonly serviceId?: string | null;
  }[];
}

export const IMPACT_DECISIONS = ['keep', 'reassign', 'cancel_and_notify'] as const;
export type ImpactDecision = (typeof IMPACT_DECISIONS)[number];

export interface Impact {
  /** Key for the decision map: 'member:<userId>', 'resource:<resourceId>' or 'seats'. */
  readonly key: string;
  readonly code: 'member_removed' | 'seats_below_booked' | 'resource_removed';
  readonly message: string;
  /** Appointments (or sessions) affected. */
  readonly count: number;
  readonly userId?: string;
  readonly resourceId?: string;
  readonly appointmentIds?: readonly string[];
  readonly decisions: readonly ImpactDecision[];
}

export interface ImpactAnalysis {
  readonly impacts: readonly Impact[];
  readonly requiresReview: boolean;
}

function seatsFor(config: CalendarConfig, serviceId: string | null | undefined): number {
  const item = serviceId ? config.services.items.find((i) => i.serviceId === serviceId) : undefined;
  return item?.overrides.seats ?? config.capacity.seats;
}

export function analyzeImpact(
  before: CalendarConfig,
  after: CalendarConfig,
  upcoming: UpcomingSummary,
  catalogs?: Pick<CalendarCatalogs, 'team' | 'resources'>,
): ImpactAnalysis {
  const impacts: Impact[] = [];
  const kept = new Set(after.team.members.map((m) => m.userId));
  // Without staff there is nobody to hand appointments to.
  const canReassign = after.team.assignment !== 'none' && after.team.members.length > 0;
  for (const m of before.team.members) {
    const count = upcoming.members.find((u) => u.userId === m.userId)?.appointments ?? 0;
    if (kept.has(m.userId) || count === 0) continue;
    impacts.push({
      key: `member:${m.userId}`,
      code: 'member_removed',
      message: `${personName(catalogs, m.userId)} has ${countOf(count, 'upcoming appointment', 'upcoming appointments')}`,
      count,
      userId: m.userId,
      decisions: canReassign
        ? ['keep', 'reassign', 'cancel_and_notify']
        : ['keep', 'cancel_and_notify'],
    });
  }

  const over = upcoming.sessions.filter((s) => {
    const seats = seatsFor(after, s.serviceId);
    return seats < seatsFor(before, s.serviceId) && s.seatsBooked > seats;
  });
  if (over.length)
    impacts.push({
      key: 'seats',
      code: 'seats_below_booked',
      message: `${countOf(over.length, 'upcoming session already has', 'upcoming sessions already have')} more people than the new seats`,
      count: over.length,
      appointmentIds: over.map((s) => s.appointmentId),
      decisions: ['keep'],
    });

  const stillRequired = new Set(after.resources.required.map((r) => r.resourceId));
  for (const r of before.resources.required) {
    const count = upcoming.resources.find((u) => u.resourceId === r.resourceId)?.appointments ?? 0;
    if (stillRequired.has(r.resourceId) || count === 0) continue;
    impacts.push({
      key: `resource:${r.resourceId}`,
      code: 'resource_removed',
      message: `${resourceName(catalogs, r.resourceId)} is on ${countOf(count, 'upcoming appointment', 'upcoming appointments')}`,
      count,
      resourceId: r.resourceId,
      decisions: ['keep', 'cancel_and_notify'],
    });
  }
  return { impacts, requiresReview: impacts.length > 0 };
}

/** Impacts still lacking an allowed decision. */
export function undecidedImpacts(
  analysis: ImpactAnalysis,
  decisions: Readonly<Record<string, ImpactDecision>>,
): Impact[] {
  return analysis.impacts.filter((i) => {
    const d = decisions[i.key];
    return d === undefined || !i.decisions.includes(d);
  });
}
