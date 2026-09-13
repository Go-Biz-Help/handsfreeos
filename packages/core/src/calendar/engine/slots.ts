/**
 * Open times for one request. Pipeline: candidates (hours mode: stepped starts inside the calendar ∩ service
 * windows; sessions mode: sessions with seats left) → constraints (notice, date window, daily limits, ZIP
 * territory) → staff feasibility by strategy → resources by quantity → seats and party size.
 *
 * Conflict rule, for people and resources alike: the new appointment's `blocked` span (buffers and travel
 * included) must not overlap anyone's `during`, and its `during` must not overlap anyone's `blocked`.
 * Busy times count as appointments without buffers. Intervals are half-open, so back-to-back is fine.
 *
 * Each person's feasible start times are worked out once as intervals, then every candidate is a lookup,
 * which keeps 62 days × 50 people at a 5-minute step well inside the budget.
 */
import { zip5 } from '../catalogs';
import type { CalendarConfig } from '../config';
import { bookableDurations, defaultLocationKind, resolveTerms, type Terms } from '../terms';
import { containsPoint, intersect, normalize, subtract, type Interval } from './intervals';
import type { Booking, ResourceInput, SessionInput, Slot, SlotInput, StaffInput } from './types';
import { addDays, localDateOf, startOfLocalDay } from './zoned';

export const MAX_RANGE_DAYS = 62;
export const MAX_MEMBERS = 50;
const MIN = 60_000;
const DAY = 86_400_000;
const FAR = 8.64e15;

/** Earliest and latest start a customer may book now: notice, days ahead and the date range. */
export function bookingWindow(config: CalendarConfig, now: number, timeZone: string): Interval {
  const w = config.window;
  let start = now + w.minNoticeMinutes * MIN;
  if (w.dateFrom) start = Math.max(start, startOfLocalDay(w.dateFrom, timeZone));
  let end = startOfLocalDay(addDays(localDateOf(now, timeZone), w.maxDaysAhead + 1), timeZone);
  if (w.dateTo) end = Math.min(end, startOfLocalDay(addDays(w.dateTo, 1), timeZone));
  return { start, end };
}

/** The calendar's people who may take this booking: team order, service eligibility, ZIP territory. */
export function candidatePool(input: SlotInput, terms: Terms): string[] {
  const { config } = input;
  let pool = config.team.members
    .map((m) => m.userId)
    .filter((u) => terms.eligibleUserIds === null || terms.eligibleUserIds.includes(u));
  const zip = zip5(input.postalCode);
  if (config.territory.routing === 'zip' && zip) {
    const chosen = config.territory.territoryIds;
    const allowed = new Set<string>();
    for (const t of input.territories ?? []) {
      if (chosen.length && !chosen.includes(t.id)) continue;
      if (t.postalCodes.some((p) => zip5(p) === zip)) for (const u of t.userIds) allowed.add(u);
    }
    pool = pool.filter((u) => allowed.has(u));
  }
  return pool;
}

/** Starts s where [s, s + d) fits inside one window, as integer-millisecond half-open intervals. */
function startsInside(windows: readonly Interval[] | null, d: number): Interval[] {
  if (windows === null) return [{ start: -FAR, end: FAR }];
  return normalize(windows)
    .filter((w) => w.end - w.start >= d)
    .map((w) => ({ start: w.start, end: w.end - d + 1 }));
}

/** Starts whose blocked span [s - before, s + d + after) would overlap a `during` interval. */
function blockedHits(
  durings: readonly Interval[],
  d: number,
  before: number,
  after: number,
): Interval[] {
  return durings.map((c) => ({ start: c.start - d - after + 1, end: c.end + before }));
}

/** Starts whose during span [s, s + d) would overlap a `blocked` interval. */
function duringHits(blockeds: readonly Interval[], d: number): Interval[] {
  return blockeds.map((c) => ({ start: c.start - d + 1, end: c.end }));
}

/** Where the summed quantity of intervals goes above a threshold. */
function levelAbove(
  items: readonly { span: Interval; quantity: number }[],
  threshold: number,
): Interval[] {
  const events: [number, number][] = [];
  for (const i of items) {
    if (i.span.end <= i.span.start) continue;
    events.push([i.span.start, i.quantity], [i.span.end, -i.quantity]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Interval[] = [];
  let level = 0;
  let openedAt: number | null = null;
  for (const [at, delta] of events) {
    level += delta;
    if (level > threshold && openedAt === null) openedAt = at;
    else if (level <= threshold && openedAt !== null) {
      if (at > openedAt) out.push({ start: openedAt, end: at });
      openedAt = null;
    }
  }
  return normalize(out);
}

interface Spans {
  readonly d: number;
  readonly before: number;
  readonly after: number;
}

function staffStarts(
  staff: StaffInput,
  spans: Spans,
  limit: { perDay: number; calendarId: string | null | undefined; timeZone: string } | null,
  dayStart: (date: string) => number,
): Interval[] {
  const { d, before, after } = spans;
  const durings = [...staff.busy, ...staff.bookings.map((b) => b.during)];
  const blockeds = [...staff.busy, ...staff.bookings.map((b) => b.blocked)];
  const forbidden = [...blockedHits(durings, d, before, after), ...duringHits(blockeds, d)];
  if (limit) {
    const counts = new Map<string, number>();
    for (const b of staff.bookings as readonly Booking[]) {
      if (limit.calendarId != null && b.calendarId !== limit.calendarId) continue;
      const date = localDateOf(b.during.start, limit.timeZone);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    for (const [date, count] of counts)
      if (count >= limit.perDay)
        forbidden.push({ start: dayStart(date), end: dayStart(addDays(date, 1)) });
  }
  return subtract(startsInside(staff.windows, d), forbidden);
}

function resourceStarts(resource: ResourceInput, need: number, spans: Spans): Interval[] {
  const { d, before, after } = spans;
  const room = resource.quantity - need;
  if (room < 0) return [];
  const duringLoad = levelAbove(
    resource.bookings.map((b) => ({ span: b.during, quantity: b.quantity })),
    room,
  );
  const blockedLoad = levelAbove(
    resource.bookings.map((b) => ({ span: b.blocked, quantity: b.quantity })),
    room,
  );
  return subtract(startsInside(resource.windows, d), [
    ...blockedHits(duringLoad, d, before, after),
    ...duringHits(blockedLoad, d),
  ]);
}

function seatsLeft(s: SessionInput): number {
  return s.capacity - s.seatsTaken;
}

function sessionFits(s: SessionInput, terms: Terms, party: number, bounds: Interval): boolean {
  if (s.start < bounds.start || s.start >= bounds.end) return false;
  if (terms.serviceId !== null && s.serviceId != null && s.serviceId !== terms.serviceId)
    return false;
  return seatsLeft(s) >= party;
}

function joinSlot(s: SessionInput): Slot {
  return {
    start: s.start,
    end: s.end,
    userIds: [...s.userIds],
    seatsLeft: seatsLeft(s),
    sessionId: s.id,
  };
}

const bySlot = (a: Slot, b: Slot) =>
  a.start - b.start || (a.sessionId ?? '').localeCompare(b.sessionId ?? '');

export function computeSlots(input: SlotInput): Slot[] {
  const { config } = input;
  if (input.to - input.from > MAX_RANGE_DAYS * DAY)
    throw new RangeError('Ask for 62 days or fewer.');
  if (config.team.members.length > MAX_MEMBERS)
    throw new RangeError('A calendar holds at most 50 people.');
  const terms = resolveTerms(config, input.service);
  const party = input.partySize ?? 1;
  if (!Number.isInteger(party) || party < 1 || party > terms.maxPartySize) return [];
  const window = bookingWindow(config, input.now, input.timeZone);
  const bounds = { start: Math.max(input.from, window.start), end: Math.min(input.to, window.end) };
  if (bounds.end <= bounds.start) return [];
  const sessions = (input.sessions ?? []).filter((s) => sessionFits(s, terms, party, bounds));

  if (config.schedule.mode === 'sessions') return sessions.map(joinSlot).sort(bySlot);

  const d = (input.durationMinutes ?? bookableDurations(config, input.service)[0] ?? 60) * MIN;
  const step = config.durations.step * MIN;
  const location =
    input.locationKind === undefined ? defaultLocationKind(config) : input.locationKind;
  const travel = location === 'customer_address' ? terms.travelMinutes : 0;
  const spans: Spans = {
    d,
    before: (terms.bufferBefore + travel) * MIN,
    after: (terms.bufferAfter + travel) * MIN,
  };

  const joins = terms.seats > 1 ? sessions.filter((s) => s.end - s.start === d) : [];
  const joinStarts = new Set(joins.map((s) => s.start));

  const pool = candidatePool(input, terms);
  const staffById = new Map(input.staff.map((s) => [s.userId, s]));
  const mode = config.team.assignment;
  const k = config.team.crewSize;
  let host: string | null = null;
  let required: string[] = [];
  if (mode === 'fixed') host = config.team.members[0]?.userId ?? null;
  if (mode === 'customer_choice' && input.chosenUserId) host = input.chosenUserId;
  if (mode === 'collective') {
    const marked = config.team.members.filter((m) => m.required).map((m) => m.userId);
    required = marked.length ? marked : config.team.members.map((m) => m.userId);
    if (!required.every((u) => pool.includes(u))) return joins.map(joinSlot).sort(bySlot);
  }
  if (host !== null && !pool.includes(host)) return joins.map(joinSlot).sort(bySlot);

  const dayCache = new Map<string, number>();
  const dayStart = (date: string) => {
    let at = dayCache.get(date);
    if (at === undefined) dayCache.set(date, (at = startOfLocalDay(date, input.timeZone)));
    return at;
  };
  const limit = config.window.dailyLimitPerPerson
    ? {
        perDay: config.window.dailyLimitPerPerson,
        calendarId: input.calendarId,
        timeZone: input.timeZone,
      }
    : null;
  const feasible = new Map<string, Interval[]>();
  for (const u of pool) {
    const staff = staffById.get(u);
    feasible.set(u, staff ? staffStarts(staff, spans, limit, dayStart) : []);
  }

  const resourcesById = new Map((input.resources ?? []).map((r) => [r.resourceId, r]));
  const resourceFeasible: Interval[][] = [];
  for (const need of terms.requiredResources) {
    const resource = resourcesById.get(need.resourceId);
    if (!resource) return joins.map(joinSlot).sort(bySlot);
    resourceFeasible.push(resourceStarts(resource, need.quantity, spans));
  }

  const slots: Slot[] = joins.map(joinSlot);
  for (const s of candidateStarts(input, bounds, d, step, dayStart)) {
    if (joinStarts.has(s)) continue;
    if (!resourceFeasible.every((r) => containsPoint(r, s))) continue;
    const free = pool.filter((u) => containsPoint(feasible.get(u)!, s));
    let userIds: string[] | null = null;
    if (mode === 'collective') {
      if (required.every((u) => free.includes(u))) userIds = free;
    } else if (host !== null) {
      const others = free.filter((u) => u !== host);
      if (free.includes(host) && others.length >= k - 1) userIds = [host, ...others];
    } else if (free.length >= k) userIds = free;
    if (userIds)
      slots.push({ start: s, end: s + d, userIds, seatsLeft: terms.seats, sessionId: null });
  }
  return slots.sort(bySlot);
}

/**
 * Hours-mode start times, ascending. With a calendar or service layer: every `step` from the start of each
 * open stretch of calendar ∩ service windows, fitting inside it. Without one: every `step` from each local
 * midnight, so who is on the team never moves the grid (people's own windows are checked per person).
 */
function candidateStarts(
  input: SlotInput,
  bounds: Interval,
  d: number,
  step: number,
  dayStart: (date: string) => number,
): number[] {
  const out: number[] = [];
  const layers = [input.calendarWindows, input.serviceWindows].filter(
    (l): l is readonly Interval[] => l != null,
  );
  if (layers.length) {
    const base = layers
      .slice(1)
      .reduce<Interval[]>((acc, l) => intersect(acc, l), normalize(layers[0]!));
    for (const w of base) {
      const first = w.start + Math.max(0, Math.ceil((bounds.start - w.start) / step)) * step;
      for (let s = first; s + d <= w.end && s < bounds.end; s += step) out.push(s);
    }
    return out;
  }
  for (
    let date = localDateOf(bounds.start, input.timeZone);
    dayStart(date) < bounds.end;
    date = addDays(date, 1)
  ) {
    const start = dayStart(date);
    const next = dayStart(addDays(date, 1));
    const from = Math.max(bounds.start, start);
    for (
      let s = start + Math.ceil((from - start) / step) * step;
      s < next && s < bounds.end;
      s += step
    )
      out.push(s);
  }
  return out;
}
