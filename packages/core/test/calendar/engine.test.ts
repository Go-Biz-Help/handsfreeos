import { describe, expect, it } from 'vitest';
import {
  addDays,
  applyPatch,
  chooseAssignment,
  computeSlots,
  defaultConfig,
  expandWeeklyHours,
  localInstant,
  startOfLocalDay,
  type AssignmentState,
  type CatalogService,
  type ConfigPatch,
  type Interval,
  type ResourceInput,
  type Slot,
  type SlotInput,
  type StaffInput,
} from '../../src/calendar/index';
import { uid } from './fixtures';
import { forSeeds, type Rng } from './random';

const MIN = 60_000;
const TZ = 'America/Chicago';
const MON = '2026-06-01';
const T0 = Date.parse('2026-06-01T05:00:00Z'); // Monday 2026-06-01 00:00 in Chicago
const DOMAIN_START = T0 - 1440 * MIN;
const DOMAIN = 4 * 1440;
const USERS = [11, 12, 13, 14, 15].map(uid);
const [A, B, C] = USERS as [string, string, string];
const RES = [21, 22].map(uid);
const TER = [31, 32].map(uid);
const CAL = 'this-calendar';
const ASSIGNMENTS = [
  'fixed',
  'customer_choice',
  'round_robin',
  'weighted',
  'first_available',
  'collective',
] as const;
type Mode = (typeof ASSIGNMENTS)[number];

const at = (minute: number) => DOMAIN_START + minute * MIN;

// ---- Random small worlds ----

/** Spans land around the requested ranges (T0 - 8 h to T0 + 36 h) so the worlds are dense. */
function randomSpan(r: Rng, minLen: number, maxLen: number): Interval {
  const s = r.int(960, 3600);
  return { start: at(s), end: at(Math.min(DOMAIN, s + r.int(minLen, maxLen))) };
}
const spans = (r: Rng, max: number, minLen: number, maxLen: number) =>
  Array.from({ length: r.int(0, max) }, () => randomSpan(r, minLen, maxLen));
function booking(r: Rng) {
  const during = randomSpan(r, 15, 120);
  const before = r.pick([0, 0, 15, 30]) * MIN;
  const after = r.pick([0, 15]) * MIN;
  return {
    during,
    blocked: { start: during.start - before, end: during.end + after },
    calendarId: r.chance(0.7) ? CAL : 'other',
  };
}
const randomStaff = (r: Rng, userId: string): StaffInput => ({
  userId,
  windows: Array.from({ length: r.int(1, 4) }, () => randomSpan(r, 120, 900)),
  busy: spans(r, 2, 15, 180),
  bookings: Array.from({ length: r.int(0, 4) }, () => booking(r)),
});

function randomWorld(r: Rng, modes: readonly Mode[] = ASSIGNMENTS): SlotInput {
  const members = r.subset(USERS, 1).slice(0, 4);
  const assignment = r.pick(modes);
  const d = r.pick([15, 30, 45, 60, 90]);
  const dateFrom = r.chance(0.2) ? addDays(MON, r.int(-1, 1)) : null;
  const dateTo = r.chance(0.2) ? addDays(dateFrom ?? MON, r.int(0, 2)) : null;
  const config = applyPatch(defaultConfig(), {
    team: {
      members: members.map((userId) => ({ userId, required: r.chance(0.3) })),
      assignment,
      crewSize: assignment === 'collective' ? 1 : r.pick([1, 1, 1, 1, 2, 3]),
    },
    durations: { minutes: [d], step: r.pick([5, 10, 15, 30, 45, 60]) },
    buffers: {
      before: r.pick([0, 0, 5, 15, 30]),
      after: r.pick([0, 0, 10, 15]),
      travelMinutes: r.pick([0, 0, 15, 30]),
    },
    locations: { options: [{ kind: r.pick(['customer_address', 'business'] as const) }] },
    window: {
      minNoticeMinutes: r.pick([0, 0, 60, 240, 600]),
      maxDaysAhead: r.pick([1, 2, 60, 60]),
      dateFrom,
      dateTo,
      dailyLimitPerPerson: r.chance(0.3) ? r.int(1, 3) : null,
    },
    territory: {
      routing: r.chance(0.25) ? 'zip' : 'off',
      territoryIds: r.chance(0.5) ? [] : [TER[0]!],
    },
    resources: {
      required: (r.chance(0.4) ? r.subset(RES, 1).slice(0, 1) : []).map((resourceId) => ({
        resourceId,
        quantity: r.int(1, 2),
      })),
    },
  });
  const service: CatalogService | null = r.chance(0.3)
    ? {
        id: uid(41),
        name: 'Visit',
        durations: [d],
        bufferBefore: r.pick([0, 20]),
        bufferAfter: r.pick([0, 10]),
        eligibleUserIds: r.subset(USERS),
        requiredResources: r.chance(0.3) ? [{ resourceId: RES[0]!, quantity: 1 }] : [],
        archived: false,
      }
    : null;
  const from = at(1440 + r.int(-360, 720));
  const extra = !members.includes(USERS[4]!) && r.chance(0.2) ? [USERS[4]!] : [];
  return {
    config,
    calendarId: CAL,
    timeZone: TZ,
    now: from - r.int(0, 600) * MIN,
    from,
    to: from + r.int(360, 2160) * MIN,
    service,
    durationMinutes: d,
    postalCode: r.pick([null, '75201', '75202-1234', '99999']),
    chosenUserId: assignment === 'customer_choice' && r.chance(0.5) ? r.pick(USERS) : null,
    calendarWindows: r.chance(0.5) ? spans(r, 3, 60, 900) : null,
    serviceWindows: r.chance(0.3) ? spans(r, 3, 60, 900) : null,
    staff: [...members.filter(() => r.chance(0.9)), ...extra].map((u) => randomStaff(r, u)),
    resources: RES.filter(() => r.chance(0.92)).map((resourceId): ResourceInput => ({
      resourceId,
      quantity: r.int(1, 3),
      windows: r.chance(0.5) ? null : spans(r, 3, 120, 900),
      bookings: Array.from({ length: r.int(0, 4) }, () => ({
        ...booking(r),
        quantity: r.int(1, 2),
      })),
    })),
    territories: [
      { id: TER[0]!, name: 'A', postalCodes: ['75201'], userIds: r.subset(USERS) },
      { id: TER[1]!, name: 'B', postalCodes: ['75202', '75203'], userIds: r.subset(USERS) },
    ],
  };
}

/** A booking on a bed: 15 to 60 minutes, a few minutes' setup sometimes, cleanup after, from either calendar. */
function bedBooking(r: Rng) {
  const s = r.int(960, 3600);
  const during = { start: at(s), end: at(Math.min(DOMAIN, s + r.pick([15, 20, 30, 45, 60]))) };
  const before = r.pick([0, 0, 5]) * MIN;
  const after = r.pick([0, 10, 10, 15]) * MIN;
  return {
    during,
    blocked: { start: during.start - before, end: during.end + after },
    calendarId: r.chance(0.5) ? CAL : 'other',
    quantity: r.int(1, 2),
  };
}

/** No staff: only hours, beds (quantities, staggered bookings, cleanup, shared with another calendar) and ZIPs. */
function randomNoStaffWorld(r: Rng): SlotInput {
  const d = r.pick([15, 20, 30, 45, 60]);
  const config = applyPatch(defaultConfig(), {
    // People listed on a calendar without staff are ignored.
    team: { members: r.chance(0.2) ? [{ userId: A }] : [], assignment: 'none' },
    durations: { minutes: [d], step: r.pick([5, 10, 15, 30]) },
    buffers: { before: r.pick([0, 0, 5]), after: r.pick([0, 10, 15]) },
    window: {
      minNoticeMinutes: r.pick([0, 0, 60, 240]),
      maxDaysAhead: r.pick([1, 60, 60]),
      dailyLimitPerPerson: r.chance(0.2) ? 1 : null,
    },
    territory: {
      routing: r.chance(0.25) ? 'zip' : 'off',
      territoryIds: r.chance(0.5) ? [] : [TER[0]!],
    },
    resources: {
      required: r.subset(RES, 1).map((resourceId) => ({ resourceId, quantity: r.int(1, 2) })),
    },
  });
  const service: CatalogService | null = r.chance(0.3)
    ? {
        id: uid(41),
        name: 'Session',
        durations: [d],
        bufferBefore: r.pick([0, 5]),
        bufferAfter: r.pick([0, 10]),
        eligibleUserIds: [],
        requiredResources: r.chance(0.5) ? [{ resourceId: RES[1]!, quantity: 1 }] : [],
        archived: false,
      }
    : null;
  const from = at(1440 + r.int(-360, 720));
  return {
    config,
    calendarId: CAL,
    timeZone: TZ,
    now: from - r.int(0, 600) * MIN,
    from,
    to: from + r.int(360, 2160) * MIN,
    service,
    durationMinutes: d,
    postalCode: r.pick([null, '75201', '75203', '99999']),
    calendarWindows: r.chance(0.5) ? spans(r, 3, 60, 900) : null,
    serviceWindows: r.chance(0.3) ? spans(r, 3, 60, 900) : null,
    staff: r.chance(0.3) ? [randomStaff(r, A)] : [],
    resources: RES.filter(() => r.chance(0.95)).map((resourceId): ResourceInput => ({
      resourceId,
      quantity: r.int(1, 4),
      windows: r.chance(0.6) ? null : spans(r, 3, 120, 900),
      bookings: Array.from({ length: r.int(0, 8) }, () => bedBooking(r)),
    })),
    territories: [
      { id: TER[0]!, name: 'A', postalCodes: ['75201'], userIds: [] },
      { id: TER[1]!, name: 'B', postalCodes: ['75202', '75203'], userIds: [] },
    ],
  };
}

// ---- The oracle: every minute, checked one minute at a time ----

function oracle(input: SlotInput): Slot[] {
  const { config } = input;
  const d = input.durationMinutes!;
  const svc = input.service ?? null;
  const travel =
    config.locations.options[0]?.kind === 'customer_address' ? config.buffers.travelMinutes : 0;
  const before = Math.max(config.buffers.before, svc?.bufferBefore ?? 0) + travel;
  const after = Math.max(config.buffers.after, svc?.bufferAfter ?? 0) + travel;
  const need = new Map<string, number>();
  for (const x of [...config.resources.required, ...(svc?.requiredResources ?? [])])
    need.set(x.resourceId, Math.max(need.get(x.resourceId) ?? 0, x.quantity));

  const minute = (t: number) => Math.round((t - DOMAIN_START) / MIN);
  const paint = (list: readonly { start: number; end: number; q?: number }[]) => {
    const arr = new Int32Array(DOMAIN);
    for (const i of list)
      for (let m = Math.max(0, minute(i.start)); m < Math.min(DOMAIN, minute(i.end)); m++)
        arr[m]! += i.q ?? 1;
    return arr;
  };
  const get = (arr: Int32Array, m: number) => (m >= 0 && m < DOMAIN ? arr[m]! : 0);

  const days = Array.from({ length: 8 }, (_, k) => {
    const date = addDays(MON, k - 2);
    return { date, start: startOfLocalDay(date, TZ) };
  });
  const dayOf = (t: number) => days.filter((x) => x.start <= t).at(-1)!;
  const w = config.window;
  const lastDate = addDays(dayOf(input.now).date, w.maxDaysAhead);
  const inBounds = (t: number) => {
    const date = dayOf(t).date;
    return (
      t >= input.from &&
      t < input.to &&
      t >= input.now + w.minNoticeMinutes * MIN &&
      date <= lastDate &&
      (!w.dateFrom || date >= w.dateFrom) &&
      (!w.dateTo || date <= w.dateTo)
    );
  };

  let pool = config.team.members.map((m) => m.userId);
  if (svc?.eligibleUserIds.length) pool = pool.filter((u) => svc.eligibleUserIds.includes(u));
  const digits = (input.postalCode ?? '').replace(/\D/g, '');
  const zip = digits.length >= 5 ? digits.slice(0, 5) : null;
  const mode = config.team.assignment;
  if (config.territory.routing === 'zip' && zip) {
    const ids = config.territory.territoryIds;
    const serving = (input.territories ?? []).filter(
      (t) => (!ids.length || ids.includes(t.id)) && t.postalCodes.includes(zip),
    );
    // No staff: the ZIP only has to be in a selected territory.
    if (mode === 'none' && !serving.length) return [];
    const ok = new Set(serving.flatMap((t) => t.userIds));
    pool = pool.filter((u) => ok.has(u));
  }
  const k = config.team.crewSize;
  const host =
    mode === 'fixed'
      ? (config.team.members[0]?.userId ?? null)
      : mode === 'customer_choice'
        ? (input.chosenUserId ?? null)
        : null;
  const marked = config.team.members.filter((m) => m.required).map((m) => m.userId);
  const required =
    mode === 'collective'
      ? marked.length
        ? marked
        : config.team.members.map((m) => m.userId)
      : [];
  if (host !== null && !pool.includes(host)) return [];
  if (!required.every((u) => pool.includes(u))) return [];
  const resources = new Map((input.resources ?? []).map((r) => [r.resourceId, r]));
  if ([...need.keys()].some((id) => !resources.has(id))) return [];

  const staff = new Map(
    input.staff
      .filter((s) => pool.includes(s.userId))
      .map((s) => {
        const perDay = new Map<string, number>();
        for (const b of s.bookings)
          if (b.calendarId === CAL)
            perDay.set(
              dayOf(b.during.start).date,
              (perDay.get(dayOf(b.during.start).date) ?? 0) + 1,
            );
        return [
          s.userId,
          {
            win: paint(s.windows),
            D: paint([...s.busy, ...s.bookings.map((b) => b.during)]),
            K: paint([...s.busy, ...s.bookings.map((b) => b.blocked)]),
            perDay,
          },
        ] as const;
      }),
  );
  const isFree = (u: string, t: number) => {
    const a = staff.get(u);
    if (!a) return false;
    const m0 = minute(t);
    for (let m = m0; m < m0 + d; m++) if (!get(a.win, m) || get(a.K, m)) return false;
    for (let m = m0 - before; m < m0 + d + after; m++) if (get(a.D, m)) return false;
    const limit = w.dailyLimitPerPerson;
    return limit === null || (a.perDay.get(dayOf(t).date) ?? 0) < limit;
  };
  const res = [...need].map(([id, q]) => {
    const r = resources.get(id)!;
    return {
      q,
      Q: r.quantity,
      win: r.windows ? paint(r.windows) : null,
      D: paint(r.bookings.map((b) => ({ ...b.during, q: b.quantity }))),
      K: paint(r.bookings.map((b) => ({ ...b.blocked, q: b.quantity }))),
    };
  });
  const resourcesOk = (t: number) =>
    res.every(({ q, Q, win, D, K }) => {
      if (q > Q) return false;
      const m0 = minute(t);
      for (let m = m0; m < m0 + d; m++)
        if ((win && !get(win, m)) || get(K, m) > Q - q) return false;
      for (let m = m0 - before; m < m0 + d + after; m++) if (get(D, m) > Q - q) return false;
      return true;
    });

  const step = config.durations.step;
  const layers = [input.calendarWindows, input.serviceWindows].filter(
    (l): l is readonly Interval[] => l != null,
  );
  let aligned: (m: number) => boolean;
  if (layers.length) {
    const painted = layers.map((l) => paint(l));
    const base = new Int32Array(DOMAIN).map((_, m) => (painted.every((p) => p[m]! > 0) ? 1 : 0));
    const runStart = new Int32Array(DOMAIN);
    for (let m = 0; m < DOMAIN; m++)
      runStart[m] = base[m] ? (m > 0 && base[m - 1] ? runStart[m - 1]! : m) : -1;
    aligned = (m) => {
      for (let x = m; x < m + d; x++) if (!get(base, x)) return false;
      return (m - runStart[m]!) % step === 0;
    };
  } else aligned = (m) => ((at(m) - dayOf(at(m)).start) / MIN) % step === 0;

  const out: Slot[] = [];
  for (let t = input.from; t < input.to; t += MIN) {
    if (!aligned(minute(t)) || !inBounds(t) || !resourcesOk(t)) continue;
    const free = pool.filter((u) => isFree(u, t));
    let userIds: string[] | null = null;
    if (mode === 'none') userIds = [];
    else if (mode === 'collective') {
      if (required.every((u) => free.includes(u))) userIds = free;
    } else if (host !== null) {
      const others = free.filter((u) => u !== host);
      if (free.includes(host) && others.length >= k - 1) userIds = [host, ...others];
    } else if (free.length >= k) userIds = free;
    if (userIds)
      out.push({
        start: t,
        end: t + d * MIN,
        userIds,
        seatsLeft: config.capacity.seats,
        sessionId: null,
      });
  }
  return out;
}

describe('property tests against a minute-by-minute oracle', () => {
  it('matches the oracle on 300 random worlds', () => {
    let found = 0;
    forSeeds(300, (r) => {
      const world = randomWorld(r);
      const want = oracle(world);
      found += want.length;
      expect(computeSlots(world)).toEqual(want);
    });
    // Not vacuous: the fixed seeds produce about 1,900 slots (skipped when replaying one seed).
    if (!process.env.CALENDAR_SEED) expect(found, `slots found: ${found}`).toBeGreaterThan(1500);
  });

  it('never adds slots when busy time is added', () => {
    forSeeds(
      300,
      (r) => {
        const world = randomWorld(r);
        if (!world.staff.length) return;
        const i = r.int(0, world.staff.length - 1);
        const staff = world.staff.map((s, j) =>
          j === i ? { ...s, busy: [...s.busy, randomSpan(r, 15, 300)] } : s,
        );
        const before = new Map(computeSlots(world).map((s) => [s.start, s]));
        for (const s of computeSlots({ ...world, staff })) {
          expect(before.has(s.start)).toBe(true);
          expect(before.get(s.start)!.userIds).toEqual(expect.arrayContaining([...s.userIds]));
        }
      },
      7_000,
    );
  });

  it('never removes slots when someone joins the pool', () => {
    forSeeds(
      300,
      (r) => {
        const world = {
          ...randomWorld(r, ['round_robin', 'weighted', 'first_available', 'customer_choice']),
          chosenUserId: null,
        };
        const newcomer = USERS.find((u) => !world.config.team.members.some((m) => m.userId === u))!;
        const config = applyPatch(world.config, {
          team: { members: [...world.config.team.members, { userId: newcomer }] },
        });
        const staff = [
          ...world.staff.filter((s) => s.userId !== newcomer),
          randomStaff(r, newcomer),
        ];
        const after = new Map(computeSlots({ ...world, config, staff }).map((s) => [s.start, s]));
        for (const s of computeSlots(world)) {
          expect(after.has(s.start)).toBe(true);
          expect(after.get(s.start)!.userIds).toEqual(expect.arrayContaining([...s.userIds]));
        }
      },
      14_000,
    );
  });

  it('keeps collective slots inside each member’s own slots', () => {
    let together = 0;
    forSeeds(
      300,
      (r) => {
        const world = randomWorld(r, ['collective']);
        const config = applyPatch(world.config, {
          team: { members: world.config.team.members.map((m) => ({ ...m, required: false })) },
        });
        const slots = computeSlots({ ...world, config });
        together += slots.length;
        for (const m of config.team.members) {
          const solo = applyPatch(config, {
            team: { members: [{ userId: m.userId }], assignment: 'fixed' },
          });
          const starts = new Set(computeSlots({ ...world, config: solo }).map((s) => s.start));
          for (const s of slots) expect(starts.has(s.start)).toBe(true);
        }
      },
      21_000,
    );
    if (!process.env.CALENDAR_SEED) expect(together).toBeGreaterThan(0);
  });

  it('keeps weighted round-robin shares within one booking of the weights', () => {
    forSeeds(
      300,
      (r) => {
        const users = Array.from({ length: r.int(2, 6) }, (_, i) => uid(60 + i));
        const weights = users.map(() => r.int(1, 10));
        const total = weights.reduce((a, b) => a + b, 0);
        const config = applyPatch(defaultConfig(), {
          team: {
            members: users.map((userId, i) => ({ userId, weight: weights[i]! })),
            assignment: 'weighted',
          },
        });
        const slot: Slot = { start: 0, end: 1, userIds: users, seatsLeft: 1, sessionId: null };
        let state: AssignmentState = {};
        const counts = new Map<string, number>();
        let worst = 0;
        for (let n = 1; n <= 200; n++) {
          const { userIds, nextState } = chooseAssignment(slot, config, state, { now: n });
          state = nextState;
          counts.set(userIds[0]!, (counts.get(userIds[0]!) ?? 0) + 1);
          users.forEach((u, i) => {
            worst = Math.max(worst, Math.abs((counts.get(u) ?? 0) - (n * weights[i]!) / total));
          });
        }
        expect(worst).toBeLessThanOrEqual(1);
        expect(users.reduce((sum, u) => sum + state[u]!.credit, 0)).toBe(0);
      },
      28_000,
    );
  });
});

describe('property tests without staff (resources and hours alone)', () => {
  it('matches the oracle on 300 resource-only worlds', () => {
    let found = 0;
    forSeeds(
      300,
      (r) => {
        const world = randomNoStaffWorld(r);
        const want = oracle(world);
        found += want.length;
        expect(computeSlots(world)).toEqual(want);
      },
      40_000,
    );
    // Not vacuous: the fixed seeds produce about 7,100 slots (skipped when replaying one seed).
    if (!process.env.CALENDAR_SEED) expect(found, `slots found: ${found}`).toBeGreaterThan(5000);
  });

  it('never adds slots when a bed is booked', () => {
    forSeeds(
      300,
      (r) => {
        const world = randomNoStaffWorld(r);
        const list = world.resources ?? [];
        if (!list.length) return;
        const i = r.int(0, list.length - 1);
        const resources = list.map((x, j) =>
          j === i ? { ...x, bookings: [...x.bookings, bedBooking(r)] } : x,
        );
        const before = new Set(computeSlots(world).map((s) => s.start));
        for (const s of computeSlots({ ...world, resources }))
          expect(before.has(s.start)).toBe(true);
      },
      47_000,
    );
  });

  it('never removes slots when there are more beds', () => {
    forSeeds(
      300,
      (r) => {
        const world = randomNoStaffWorld(r);
        const resources = (world.resources ?? []).map((x) => ({
          ...x,
          quantity: x.quantity + r.int(0, 2),
        }));
        const after = new Set(computeSlots({ ...world, resources }).map((s) => s.start));
        for (const s of computeSlots(world)) expect(after.has(s.start)).toBe(true);
      },
      54_000,
    );
  });

  it('counts a shared bed the same whichever calendar booked it, and never looks at people', () => {
    forSeeds(
      300,
      (r) => {
        const world = randomNoStaffWorld(r);
        const shared = (world.resources ?? []).map((x) => ({
          ...x,
          bookings: x.bookings.map((b) => ({ ...b, calendarId: r.pick([CAL, 'other']) })),
        }));
        const want = computeSlots(world);
        expect(computeSlots({ ...world, resources: shared })).toEqual(want);
        expect(computeSlots({ ...world, staff: [] })).toEqual(want);
      },
      61_000,
    );
  });
});

// ---- Hand-made scenarios ----

const local = (date: string, clock: string) => localInstant(date, clock, TZ);
const span = (date: string, from: string, to: string): Interval => ({
  start: local(date, from),
  end: local(date, to),
});
const person = (
  userId: string,
  windows: Interval[],
  extra: Partial<StaffInput> = {},
): StaffInput => ({
  userId,
  windows,
  busy: [],
  bookings: [],
  ...extra,
});
const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const clocks = (slots: readonly Slot[]) => slots.map((s) => clockFormat.format(s.start));

function world(patch: ConfigPatch, over: Partial<SlotInput> = {}): SlotInput {
  return {
    config: applyPatch(applyPatch(defaultConfig(), { window: { minNoticeMinutes: 0 } }), patch),
    calendarId: CAL,
    timeZone: TZ,
    now: local('2026-05-31', '12:00'),
    from: local(MON, '00:00'),
    to: local(MON, '24:00'),
    staff: [],
    ...over,
  };
}
const solo = { team: { members: [{ userId: A }] } };
const nineToFive = (userId: string, date = MON, extra: Partial<StaffInput> = {}) =>
  person(userId, [span(date, '09:00', '17:00')], extra);

describe('hours mode', () => {
  it('steps from local midnight inside a person’s hours', () => {
    const slots = computeSlots(world(solo, { staff: [person(A, [span(MON, '09:00', '12:00')])] }));
    expect(clocks(slots)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
    expect(
      slots.every((s) => s.userIds.join() === A && s.seatsLeft === 1 && s.sessionId === null),
    ).toBe(true);
  });

  it('steps from the start of the calendar’s hours', () => {
    const slots = computeSlots(
      world(solo, { staff: [nineToFive(A)], calendarWindows: [span(MON, '09:15', '12:00')] }),
    );
    expect(clocks(slots)).toEqual(['09:15', '09:45', '10:15', '10:45']);
  });

  it('keeps buffers off other appointments but lets buffers touch', () => {
    const booked = { during: span(MON, '10:00', '11:00'), blocked: span(MON, '10:00', '11:15') };
    const slots = computeSlots(
      world(
        { ...solo, buffers: { before: 15 }, durations: { step: 15 } },
        { staff: [person(A, [span(MON, '09:00', '13:00')], { bookings: [booked] })] },
      ),
    );
    expect(clocks(slots)).toEqual(['09:00', '11:15', '11:30', '11:45', '12:00']);
  });

  it('adds travel only for customer-address visits', () => {
    const staff = [
      person(A, [span(MON, '09:00', '13:00')], {
        bookings: [{ during: span(MON, '11:00', '12:00'), blocked: span(MON, '11:00', '12:00') }],
      }),
    ];
    const patch = {
      ...solo,
      buffers: { travelMinutes: 30 },
      locations: {
        options: [{ kind: 'customer_address' as const }, { kind: 'business' as const }],
      },
    };
    expect(clocks(computeSlots(world(patch, { staff })))).toEqual(['09:00', '09:30']);
    expect(clocks(computeSlots(world(patch, { staff, locationKind: 'business' })))).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '12:00',
    ]);
  });

  it('treats busy times as appointments', () => {
    const staff = [nineToFive(A, MON, { busy: [span(MON, '09:30', '16:00')] })];
    expect(clocks(computeSlots(world(solo, { staff })))).toEqual(['16:00']);
  });

  it('applies minimum notice, days ahead and the date range', () => {
    const staff = [nineToFive(A), nineToFive(A, '2026-06-02')].reduce<StaffInput[]>(
      (acc, s) => (acc[0] ? [{ ...acc[0], windows: [...acc[0].windows, ...s.windows] }] : [s]),
      [],
    );
    const twoDays = { staff, to: local('2026-06-02', '24:00') };
    const notice = computeSlots(
      world(
        { ...solo, window: { minNoticeMinutes: 60 } },
        { ...twoDays, now: local(MON, '09:10') },
      ),
    );
    expect(clocks(notice)[0]).toBe('10:30');
    const oneDayAhead = computeSlots(world({ ...solo, window: { maxDaysAhead: 1 } }, twoDays));
    expect(new Set(oneDayAhead.map((s) => s.start < local('2026-06-02', '00:00')))).toEqual(
      new Set([true]),
    );
    const ended = computeSlots(
      world({ ...solo, window: { dateFrom: '2026-05-01', dateTo: '2026-05-31' } }, twoDays),
    );
    expect(ended).toEqual([]);
    const tuesdayOnly = computeSlots(
      world({ ...solo, window: { dateFrom: '2026-06-02', dateTo: '2026-06-02' } }, twoDays),
    );
    expect(tuesdayOnly.length).toBeGreaterThan(0);
    expect(tuesdayOnly.every((s) => s.start >= local('2026-06-02', '00:00'))).toBe(true);
  });

  it('stops a person at the daily limit, counting only this calendar', () => {
    const early = { during: span(MON, '07:00', '07:30'), blocked: span(MON, '07:00', '07:30') };
    const patch = { ...solo, window: { dailyLimitPerPerson: 1 } };
    expect(
      computeSlots(
        world(patch, {
          staff: [nineToFive(A, MON, { bookings: [{ ...early, calendarId: CAL }] })],
        }),
      ),
    ).toEqual([]);
    expect(
      computeSlots(
        world(patch, {
          staff: [nineToFive(A, MON, { bookings: [{ ...early, calendarId: 'other' }] })],
        }),
      ).length,
    ).toBe(15);
  });

  it('routes by 5-digit ZIP through the selected territories', () => {
    const patch = {
      team: { members: [{ userId: A }, { userId: B }], assignment: 'round_robin' as const },
      territory: { routing: 'zip' as const },
    };
    const base = {
      staff: [nineToFive(A), nineToFive(B)],
      territories: [{ id: TER[0]!, name: 'North', postalCodes: ['75201'], userIds: [A] }],
    };
    expect(computeSlots(world(patch, { ...base, postalCode: '75201-4400' }))[0]!.userIds).toEqual([
      A,
    ]);
    expect(computeSlots(world(patch, { ...base, postalCode: '75203' }))).toEqual([]);
    expect(computeSlots(world(patch, { ...base, postalCode: null }))[0]!.userIds).toEqual([A, B]);
  });

  it('counts resource quantity across overlapping bookings', () => {
    const truck: ResourceInput = {
      resourceId: RES[0]!,
      quantity: 2,
      windows: null,
      bookings: [
        { during: span(MON, '10:00', '11:00'), blocked: span(MON, '10:00', '11:00'), quantity: 1 },
        { during: span(MON, '10:30', '11:30'), blocked: span(MON, '10:30', '11:30'), quantity: 1 },
      ],
    };
    const patch = { ...solo, resources: { required: [{ resourceId: RES[0]!, quantity: 1 }] } };
    const slots = computeSlots(
      world(patch, { staff: [person(A, [span(MON, '09:00', '12:30')])], resources: [truck] }),
    );
    // 10:00 is refused: from 10:30 to 11:00 both trucks are already out.
    expect(clocks(slots)).toEqual(['09:00', '09:30', '11:00', '11:30']);
    expect(computeSlots(world(patch, { staff: [nineToFive(A)] }))).toEqual([]);
  });

  it('applies each strategy to who must be free', () => {
    const team = [{ userId: A }, { userId: B }];
    const staff = [nineToFive(A, MON, { busy: [span(MON, '09:00', '12:00')] }), nineToFive(B)];
    const first = (patch: ConfigPatch, over: Partial<SlotInput> = {}) =>
      computeSlots(world(patch, { staff, ...over }))[0];
    expect(clockFormat.format(first({ team: { members: team } })!.start)).toBe('12:00');
    expect(first({ team: { members: team, assignment: 'round_robin' } })!.userIds).toEqual([B]);
    expect(
      first({ team: { members: team, assignment: 'customer_choice' } }, { chosenUserId: B })!
        .userIds,
    ).toEqual([B]);
    expect(
      first({ team: { members: team, assignment: 'customer_choice' } }, { chosenUserId: C }),
    ).toBeUndefined();
    const together = first({ team: { members: team, assignment: 'collective' } })!;
    expect([clockFormat.format(together.start), together.userIds]).toEqual(['12:00', [A, B]]);
    const crew = first({ team: { members: team, assignment: 'round_robin', crewSize: 2 } })!;
    expect([clockFormat.format(crew.start), crew.userIds]).toEqual(['12:00', [A, B]]);
    const optional = first({
      team: { members: [{ userId: A, required: true }, { userId: B }], assignment: 'collective' },
    })!;
    expect([clockFormat.format(optional.start), optional.userIds]).toEqual(['12:00', [A, B]]);
  });

  it('refuses a party larger than allowed', () => {
    expect(computeSlots(world(solo, { staff: [nineToFive(A)], partySize: 2 }))).toEqual([]);
  });
});

describe('seats and sessions', () => {
  const sessions = [
    {
      id: 's1',
      start: local(MON, '10:00'),
      end: local(MON, '11:00'),
      capacity: 10,
      seatsTaken: 9,
      userIds: [A],
    },
    {
      id: 's2',
      start: local(MON, '14:00'),
      end: local(MON, '15:30'),
      capacity: 10,
      seatsTaken: 2,
      userIds: [A, B],
    },
  ];

  it('lists sessions with enough seats left in sessions mode', () => {
    const slots = computeSlots(
      world(
        { ...solo, schedule: { mode: 'sessions' }, capacity: { seats: 10, maxPartySize: 4 } },
        { sessions, partySize: 2 },
      ),
    );
    expect(slots).toEqual([
      {
        start: sessions[1]!.start,
        end: sessions[1]!.end,
        userIds: [A, B],
        seatsLeft: 8,
        sessionId: 's2',
      },
    ]);
  });

  it('lets customers join an open group time in hours mode instead of starting another', () => {
    const group = {
      id: 'g1',
      start: local(MON, '10:00'),
      end: local(MON, '11:00'),
      capacity: 4,
      seatsTaken: 3,
      userIds: [A],
    };
    const staff = [
      person(A, [span(MON, '09:00', '12:00')], {
        bookings: [{ during: span(MON, '10:00', '11:00'), blocked: span(MON, '10:00', '11:00') }],
      }),
    ];
    const slots = computeSlots(
      world({ ...solo, capacity: { seats: 4, maxPartySize: 2 } }, { staff, sessions: [group] }),
    );
    expect(slots.map((s) => [clockFormat.format(s.start), s.sessionId, s.seatsLeft])).toEqual([
      ['09:00', null, 4],
      ['10:00', 'g1', 1],
      ['11:00', null, 4],
    ]);
    const pair = computeSlots(
      world(
        { ...solo, capacity: { seats: 4, maxPartySize: 2 } },
        { staff, sessions: [group], partySize: 2 },
      ),
    );
    expect(clocks(pair)).toEqual(['09:00', '11:00']);
  });
});

describe('no staff: beds and hours alone', () => {
  const BED = RES[0]!;
  /** A bed calendar: 20-minute sessions every 10 minutes, 10 minutes' cleanup after. */
  const beds = (patch: ConfigPatch = {}): ConfigPatch => ({
    team: { assignment: 'none' },
    resources: { required: [{ resourceId: BED, quantity: 1 }] },
    durations: { minutes: [20], step: 10 },
    buffers: { after: 10 },
    ...patch,
  });
  const taken = (from: string, to: string, clean: string, calendarId = CAL) => ({
    during: span(MON, from, to),
    blocked: span(MON, from, clean),
    calendarId,
    quantity: 1,
  });
  const bedsOf = (quantity: number, bookings: ResourceInput['bookings'] = []): ResourceInput => ({
    resourceId: BED,
    quantity,
    windows: null,
    bookings,
  });
  const morning = [span(MON, '09:00', '11:00')];
  const tenToEleven = [span(MON, '10:00', '11:00')];

  it('offers a start when the hours fit and a bed is free, staggered starts included', () => {
    const staggered = [taken('09:00', '09:20', '09:30'), taken('09:10', '09:30', '09:40')];
    const two = computeSlots(
      world(beds(), { calendarWindows: morning, resources: [bedsOf(2, staggered)] }),
    );
    // Both beds are busy or being cleaned from 09:10 to 09:30.
    expect(clocks(two)).toEqual([
      '09:30',
      '09:40',
      '09:50',
      '10:00',
      '10:10',
      '10:20',
      '10:30',
      '10:40',
    ]);
    expect(two.every((s) => s.userIds.length === 0 && s.seatsLeft === 1 && !s.sessionId)).toBe(
      true,
    );
    const three = computeSlots(
      world(beds(), { calendarWindows: morning, resources: [bedsOf(3, staggered)] }),
    );
    expect(clocks(three)[0]).toBe('09:00');
    expect(three).toHaveLength(11);
  });

  it('takes as many bookings at one time as there are beds', () => {
    const at10 = (n: number) => Array.from({ length: n }, () => taken('10:00', '10:20', '10:30'));
    const open = (n: number) =>
      clocks(
        computeSlots(
          world(beds(), { calendarWindows: tenToEleven, resources: [bedsOf(4, at10(n))] }),
        ),
      );
    expect(open(3)).toEqual(['10:00', '10:10', '10:20', '10:30', '10:40']);
    expect(open(4)).toEqual(['10:30', '10:40']);
  });

  it('keeps a bed out until it is clean, and its own cleanup off the next booking', () => {
    const slots = computeSlots(
      world(beds(), {
        calendarWindows: [span(MON, '10:00', '11:30')],
        resources: [
          bedsOf(1, [taken('10:00', '10:20', '10:30'), taken('11:00', '11:20', '11:30')]),
        ],
      }),
    );
    expect(clocks(slots)).toEqual(['10:30']);
  });

  it('counts another calendar’s bookings on a shared bed', () => {
    const other = Array.from({ length: 4 }, () => taken('10:00', '10:20', '10:30', 'other'));
    expect(
      clocks(
        computeSlots(
          world(beds(), { calendarWindows: tenToEleven, resources: [bedsOf(4, other)] }),
        ),
      ),
    ).toEqual(['10:30', '10:40']);
  });

  it('with ZIP routing, asks only that the ZIP is in a selected territory', () => {
    const territories = [
      { id: TER[0]!, name: 'North', postalCodes: ['75201'], userIds: [] },
      { id: TER[1]!, name: 'South', postalCodes: ['75215'], userIds: [] },
    ];
    const north = beds({ territory: { routing: 'zip', territoryIds: [TER[0]!] } });
    const count = (postalCode: string | null, patch = north) =>
      computeSlots(
        world(patch, { calendarWindows: morning, resources: [bedsOf(1)], territories, postalCode }),
      ).length;
    expect(count('75201-1234')).toBe(11);
    expect(count('75215')).toBe(0);
    expect(count(null)).toBe(11);
    expect(count('75215', beds({ territory: { routing: 'zip' } }))).toBe(11);
  });

  it('lets customers join an open group time, and counts its bed', () => {
    const group = {
      id: 'g1',
      start: local(MON, '10:00'),
      end: local(MON, '10:20'),
      capacity: 4,
      seatsTaken: 3,
      userIds: [],
    };
    const open = (partySize: number) =>
      computeSlots(
        world(beds({ capacity: { seats: 4, maxPartySize: 2 } }), {
          calendarWindows: tenToEleven,
          resources: [bedsOf(1, [taken('10:00', '10:20', '10:30')])],
          sessions: [group],
          partySize,
        }),
      );
    expect(
      open(1).map((s) => [clockFormat.format(s.start), s.sessionId, s.seatsLeft, s.userIds]),
    ).toEqual([
      ['10:00', 'g1', 1, []],
      ['10:30', null, 4, []],
      ['10:40', null, 4, []],
    ]);
    expect(clocks(open(2))).toEqual(['10:30', '10:40']);
  });

  it('never looks at people, even ones listed', () => {
    const busy = person(A, [], { busy: [span(MON, '00:00', '24:00')] });
    const slots = computeSlots(
      world(beds({ team: { members: [{ userId: A }], assignment: 'none' } }), {
        calendarWindows: morning,
        resources: [bedsOf(1)],
        staff: [busy],
      }),
    );
    expect(slots).toHaveLength(11);
  });

  it('opens every start in the hours when nothing limits it (none_without_limit says so)', () => {
    const slots = computeSlots(
      world(
        { team: { assignment: 'none' }, durations: { minutes: [30] } },
        { calendarWindows: [span(MON, '09:00', '10:00')] },
      ),
    );
    expect(clocks(slots)).toEqual(['09:00', '09:30']);
  });

  it('picks nobody', () => {
    const config = applyPatch(defaultConfig(), { team: { assignment: 'none' } });
    const state: AssignmentState = { [A]: { assignedCount: 1, lastAssignedAt: 1, credit: 0 } };
    const slot: Slot = { start: 0, end: 1, userIds: [], seatsLeft: 1, sessionId: null };
    expect(chooseAssignment(slot, config, state, { now: 5 })).toEqual({
      userIds: [],
      nextState: state,
    });
    expect(chooseAssignment({ ...slot, sessionId: 'g1' }, config, state)).toEqual({
      userIds: [],
      nextState: state,
    });
  });
});

describe('daylight saving in America/Chicago', () => {
  const hours = [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' }));

  it('keeps 9:00 AM the first slot across the spring change', () => {
    const from = local('2026-03-06', '00:00');
    const to = local('2026-03-10', '00:00');
    const slots = computeSlots(
      world(solo, {
        from,
        to,
        now: from - 86_400_000,
        staff: [person(A, expandWeeklyHours(hours, from, to, TZ))],
      }),
    );
    const firstOf = (date: string) =>
      new Date(slots.find((s) => s.start >= local(date, '00:00'))!.start).toISOString();
    expect(firstOf('2026-03-06')).toBe('2026-03-06T15:00:00.000Z');
    expect(firstOf('2026-03-09')).toBe('2026-03-09T14:00:00.000Z');
    expect(slots.filter((s) => s.start >= local('2026-03-09', '00:00'))).toHaveLength(15);
  });

  it('steps through the repeated hour on 2026-11-01', () => {
    const date = '2026-11-01';
    const slots = computeSlots(
      world(
        { ...solo, durations: { step: 60 } },
        {
          from: local(date, '00:00'),
          to: local(date, '24:00'),
          now: local('2026-10-30', '00:00'),
          staff: [person(A, [span(date, '00:00', '04:00')])],
        },
      ),
    );
    expect(slots.map((s) => new Date(s.start).toISOString().slice(11, 16))).toEqual([
      '05:00',
      '06:00',
      '07:00',
      '08:00',
      '09:00',
    ]);
    expect(clocks(slots)).toEqual(['00:00', '01:00', '01:00', '02:00', '03:00']);
  });
});

describe('chooseAssignment', () => {
  const slot = (userIds: string[]): Slot => ({
    start: 0,
    end: 1,
    userIds,
    seatsLeft: 1,
    sessionId: null,
  });
  const cfg = (patch: ConfigPatch) => applyPatch(defaultConfig(), patch);
  const trio = [{ userId: A }, { userId: B }, { userId: C }];

  it('round robin picks the free person assigned least recently', () => {
    const config = cfg({ team: { members: trio, assignment: 'round_robin' } });
    const state: AssignmentState = {
      [A]: { assignedCount: 4, lastAssignedAt: 100, credit: 0 },
      [B]: { assignedCount: 4, lastAssignedAt: 50, credit: 0 },
    };
    const first = chooseAssignment(slot([A, B, C]), config, state, { now: 200 });
    expect(first.userIds).toEqual([C]);
    expect(first.nextState[C]).toEqual({ assignedCount: 1, lastAssignedAt: 200, credit: 0 });
    const second = chooseAssignment(slot([A, B, C]), config, first.nextState, { now: 300 });
    expect(second.userIds).toEqual([B]);
    expect(chooseAssignment(slot([A]), config, second.nextState, { now: 400 }).userIds).toEqual([
      A,
    ]);
  });

  it('first available asks the highest priority, ties in team order', () => {
    const config = cfg({
      team: {
        members: [
          { userId: A, priority: 1 },
          { userId: B, priority: 5 },
          { userId: C, priority: 5 },
        ],
        assignment: 'first_available',
      },
    });
    expect(chooseAssignment(slot([A, B, C]), config, {}, { now: 1 }).userIds).toEqual([B]);
    expect(chooseAssignment(slot([A, C]), config, {}, { now: 1 }).userIds).toEqual([C]);
  });

  it('fixed keeps the calendar’s person and fills a crew by round robin without repeats', () => {
    const config = cfg({ team: { members: trio, assignment: 'fixed', crewSize: 2 } });
    const state: AssignmentState = { [B]: { assignedCount: 1, lastAssignedAt: 10, credit: 0 } };
    const { userIds } = chooseAssignment(slot([A, B, C]), config, state, { now: 20 });
    expect(userIds).toEqual([A, C]);
  });

  it('crew runs the strategy k times without repeats', () => {
    const config = cfg({ team: { members: trio, assignment: 'weighted', crewSize: 3 } });
    const { userIds } = chooseAssignment(slot([A, B, C]), config, {}, { now: 1 });
    expect([...userIds].sort()).toEqual([A, B, C].sort());
  });

  it('customer’s choice and series continuity keep the wanted person', () => {
    const choice = cfg({ team: { members: trio, assignment: 'customer_choice' } });
    expect(
      chooseAssignment(slot([A, B, C]), choice, {}, { now: 1, chosenUserId: B }).userIds,
    ).toEqual([B]);
    const rr = cfg({ team: { members: trio, assignment: 'round_robin' } });
    expect(
      chooseAssignment(slot([A, B, C]), rr, {}, { now: 1, preferUserIds: [C] }).userIds,
    ).toEqual([C]);
    expect(chooseAssignment(slot([A, B]), rr, {}, { now: 1, preferUserIds: [C] }).userIds).toEqual([
      A,
    ]);
  });

  it('collective takes everyone the slot lists; joining a session changes nothing', () => {
    const config = cfg({ team: { members: trio, assignment: 'collective' } });
    const together = chooseAssignment(slot([A, B, C]), config, {}, { now: 5 });
    expect(together.userIds).toEqual([A, B, C]);
    expect(Object.values(together.nextState).map((s) => s.assignedCount)).toEqual([1, 1, 1]);
    const state: AssignmentState = { [A]: { assignedCount: 2, lastAssignedAt: 1, credit: 0 } };
    const join = chooseAssignment({ ...slot([A]), sessionId: 'g1' }, config, state);
    expect(join).toEqual({ userIds: [A], nextState: state });
  });
});

describe('bounds and speed', () => {
  it('refuses more than 62 days or 50 people', () => {
    expect(() => computeSlots(world(solo, { to: local(MON, '00:00') + 63 * 86_400_000 }))).toThrow(
      /62 days/,
    );
    const crowd = Array.from({ length: 51 }, (_, i) => ({
      userId: uid(1000 + i),
      weight: 1,
      priority: 0,
      required: false,
    }));
    const base = defaultConfig();
    expect(() =>
      computeSlots({ ...world(solo), config: { ...base, team: { ...base.team, members: crowd } } }),
    ).toThrow(/50 people/);
  });

  function bigWorld(days: number, people: number): SlotInput {
    const from = local(MON, '00:00');
    const to = from + days * 86_400_000;
    const hours = [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '17:00' }));
    const windows = expandWeeklyHours(hours, from, to, TZ);
    const ids = Array.from({ length: people }, (_, i) => uid(2000 + i));
    const staff = ids.map((userId, i) => ({
      userId,
      windows,
      busy: windows.map((w) => ({ start: w.start + 3 * 3_600_000, end: w.start + 4 * 3_600_000 })),
      bookings: windows.flatMap((w) =>
        [1, 5, 7].map((h) => {
          const start = w.start + (h * 60 + (i % 4) * 15) * MIN;
          return {
            during: { start, end: start + 60 * MIN },
            blocked: { start: start - 15 * MIN, end: start + 75 * MIN },
            calendarId: CAL,
          };
        }),
      ),
    }));
    return world(
      {
        team: { members: ids.map((userId) => ({ userId })), assignment: 'round_robin' },
        durations: { minutes: [30], step: 5 },
        buffers: { before: 10, after: 10 },
      },
      { from, to, now: from - 86_400_000, staff },
    );
  }

  it('handles 31 days × 10 people and 62 days × 50 people at a 5-minute step quickly', () => {
    const time = (input: SlotInput) => {
      computeSlots(input);
      const t = performance.now();
      const slots = computeSlots(input);
      return { ms: performance.now() - t, slots: slots.length };
    };
    const small = time(bigWorld(31, 10));
    const large = time(bigWorld(62, 50));
    expect(small.slots).toBeGreaterThan(0);
    expect(large.slots).toBeGreaterThan(0);
    expect(small.ms).toBeLessThan(150);
    expect(large.ms).toBeLessThan(1500);
  });
});
