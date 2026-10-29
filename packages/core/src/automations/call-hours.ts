/**
 * The hours a call to a lead may go (AI calls, part 3): a campaign's call and a workflow's ring only when it's
 * within the legal calling hours where the lead is, and within the business's own calling hours, which can only
 * narrow them (Settings → Automations → AI calls → Adjust, Calling hours). Browser-safe.
 *
 * The legal hours are the federal 8 AM to 9 PM in the lead's own time, stricter where a state is stricter: 8 PM in
 * Florida, Oklahoma, Maryland and a few more, 9 AM in Texas and noon on its Sundays, none on Sundays or holidays in
 * Alabama, Louisiana, Mississippi, Rhode Island and Utah. Canada's are the CRTC's: 9 AM to 9:30 PM on weekdays and
 * 10 AM to 6 PM at weekends. Where public summaries disagree, the stricter reading is kept. Gathered 2026-10-28 from
 * public summaries, for the owner's lawyer to confirm; one change here is every call.
 *
 * Where the lead is comes from `call-places.ts`: their number's area code and their address. A lead who could be in
 * more than one zone is called only at a time that's fine in every one, and a call starts no later than 15 minutes
 * before the hours end.
 */
import { z } from 'zod';
import {
  addDays,
  formatLocalDate,
  isClock,
  localDateOf,
  localInstant,
  parseClock,
  parseLocalDate,
  weekdayOf,
} from '../calendar/engine/zoned';
import { AREA_CODE_ZONES, AREA_CODES, REGION_ZONES, ZIP3_STATES } from './call-places';

/** The federal window: 8 AM to 9 PM in the lead's own time. The business's calling hours sit inside it. */
export const LEGAL_CALL_HOURS = { start: '08:00', end: '21:00' } as const;
/** How many times a campaign's or a workflow's call may ring someone who doesn't answer: once a day. */
export const CALL_TRIES_MAX = 3;
/** A call starts no later than this long before the hours end, so it's over in time. */
const LAST_START_MINUTES = 15;
/** How far ahead it looks for a time that works before giving up. */
const HORIZON_DAYS = 14;

/** A day's window, minutes past midnight, the end exclusive; null: no calls that day. */
type Window = readonly [number, number] | null;
interface CallRule {
  readonly weekday: Window;
  readonly saturday: Window;
  readonly sunday: Window;
  /** No calls on holidays: the federal ones, the day after Thanksgiving, and the state's own below. */
  readonly holidays: boolean;
}

const h = (from: number, to: number): Window => [from * 60, to * 60];
const every = (w: Window, more: Partial<CallRule> = {}): CallRule => ({
  weekday: w,
  saturday: w,
  sunday: w,
  holidays: false,
  ...more,
});

const FEDERAL = every(h(8, 21));
/** Canada's telemarketing rules (CRTC). */
const CANADA: CallRule = {
  weekday: [9 * 60, 21 * 60 + 30],
  saturday: h(10, 18),
  sunday: h(10, 18),
  holidays: false,
};

/** The states stricter than the federal window. */
const STATE_RULES: Readonly<Record<string, CallRule>> = {
  AK: every(h(9, 21)),
  AL: every(h(8, 20), { sunday: null, holidays: true }),
  CT: every(h(9, 20)),
  FL: every(h(8, 20), { holidays: true }),
  GA: every(h(8, 21), { sunday: null }),
  IN: every(h(8, 21), { sunday: null }),
  KY: every(h(10, 21)),
  LA: every(h(8, 20), { sunday: null, holidays: true }),
  MA: every(h(8, 20)),
  MD: every(h(8, 20)),
  // Its rule for automated calls: weekdays, 9 to 5.
  ME: { weekday: h(9, 17), saturday: null, sunday: null, holidays: false },
  MI: every(h(9, 21), { holidays: true }),
  MN: every(h(9, 21), { sunday: null, holidays: true }),
  MS: every(h(8, 20), { sunday: null, holidays: true }),
  NV: every(h(9, 20)),
  OK: every(h(8, 20)),
  PA: every(h(8, 21), { sunday: h(12, 21), holidays: true }),
  RI: { weekday: h(9, 18), saturday: h(10, 17), sunday: null, holidays: true },
  TN: every(h(8, 21), { sunday: null }),
  TX: every(h(9, 21), { sunday: h(12, 21) }),
  UT: every(h(8, 21), { sunday: null, holidays: true }),
  WA: every(h(8, 20)),
  WY: every(h(8, 20)),
};

const ruleOf = (region: string | null): CallRule =>
  region?.startsWith('CA-') ? CANADA : ((region ? STATE_RULES[region] : undefined) ?? FEDERAL);

// ---------- holidays ----------

/** The nth weekday (0 Sunday) of a month; n = -1 is the last. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = weekdayOf(formatLocalDate(year, month, 1));
    return formatLocalDate(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = parseLocalDate(formatLocalDate(year, month + 1, 0)).day;
  const last = weekdayOf(formatLocalDate(year, month, lastDay));
  return formatLocalDate(year, month, lastDay - ((last - weekday + 7) % 7));
}

/** Easter Sunday (the Gregorian computus). */
function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const hh = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - hh - k) % 7;
  const m = Math.floor((a + 11 * hh + 22 * l) / 451);
  const month = Math.floor((hh + l - 7 * m + 114) / 31);
  const day = ((hh + l - 7 * m + 114) % 31) + 1;
  return formatLocalDate(year, month, day);
}

/** A fixed-date holiday and, when it falls at a weekend, the weekday it's kept on. */
function fixed(year: number, month: number, day: number): string[] {
  const date = formatLocalDate(year, month, day);
  const wd = weekdayOf(date);
  return wd === 6 ? [date, addDays(date, -1)] : wd === 0 ? [date, addDays(date, 1)] : [date];
}

const holidayCache = new Map<string, ReadonlySet<string>>();

/** The holidays a state that has them keeps calls off, in a year. */
function holidaysOf(year: number, region: string): ReadonlySet<string> {
  const key = `${region}:${year}`;
  const kept = holidayCache.get(key);
  if (kept) return kept;
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const days = [
    ...fixed(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    nthWeekday(year, 5, 1, -1),
    ...fixed(year, 6, 19),
    ...fixed(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 10, 1, 2),
    ...fixed(year, 11, 11),
    thanksgiving,
    addDays(thanksgiving, 1),
    ...fixed(year, 12, 25),
  ];
  if (region === 'AL') days.push(nthWeekday(year, 4, 1, 4), nthWeekday(year, 6, 1, 1));
  if (region === 'MS') days.push(nthWeekday(year, 4, 1, -1));
  if (region === 'LA') days.push(addDays(easter(year), -47), addDays(easter(year), -2));
  if (region === 'RI') days.push(nthWeekday(year, 8, 1, 2));
  if (region === 'UT') days.push(...fixed(year, 7, 24));
  const set = new Set(days);
  holidayCache.set(key, set);
  return set;
}

// ---------- the business's own hours ----------

const clockField = (fallback: string) =>
  z.string().refine(isClock, 'Pick a time like 9:00 AM.').default(fallback);

/**
 * The business's calling hours for campaign and workflow calls, in each lead's own time. They only narrow the legal
 * hours: a start before 8 AM or an end after 9 PM isn't kept.
 */
export const CallHours = z
  .object({
    start: clockField(LEGAL_CALL_HOURS.start),
    end: clockField(LEGAL_CALL_HOURS.end),
    /** Saturdays and Sundays too, where the law allows them. */
    weekends: z.boolean().default(true),
  })
  .refine((v) => v.start >= LEGAL_CALL_HOURS.start, {
    error: 'Calls can’t start before 8 AM: that’s the earliest the law allows.',
    path: ['start'],
  })
  .refine((v) => v.end <= LEGAL_CALL_HOURS.end, {
    error: 'Calls can’t go on past 9 PM: that’s the latest the law allows.',
    path: ['end'],
  })
  .refine(
    (v) => !isClock(v.start) || !isClock(v.end) || parseClock(v.end) - parseClock(v.start) >= 60,
    {
      error: 'Leave at least an hour between when calls start and end.',
      path: ['end'],
    },
  );
export type CallHours = z.infer<typeof CallHours>;

// ---------- where the lead is ----------

/** One place the lead may be: a state, territory or Canadian province (null: unknown), and a time zone there. */
export interface CallPlace {
  readonly region: string | null;
  readonly timeZone: string;
}

/** What the lead's record says about where they live. */
export interface CallAddress {
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
}

let byCode: ReadonlyMap<string, string> | null = null;
let zipRanges: readonly (readonly [number, number, string])[] | null = null;

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'puerto rico': 'PR',
  guam: 'GU',
};
const PROVINCE_NAMES: Readonly<Record<string, string>> = {
  alberta: 'AB',
  'british columbia': 'BC',
  manitoba: 'MB',
  'new brunswick': 'NB',
  'newfoundland and labrador': 'NL',
  newfoundland: 'NL',
  'nova scotia': 'NS',
  ontario: 'ON',
  'prince edward island': 'PE',
  quebec: 'QC',
  québec: 'QC',
  saskatchewan: 'SK',
  yukon: 'YT',
  'northwest territories': 'NT',
  nunavut: 'NU',
};
/** A Canadian postal code's first letter. */
const POSTAL_PROVINCES: Readonly<Record<string, string>> = {
  A: 'NL',
  B: 'NS',
  C: 'PE',
  E: 'NB',
  G: 'QC',
  H: 'QC',
  J: 'QC',
  K: 'ON',
  L: 'ON',
  M: 'ON',
  N: 'ON',
  P: 'ON',
  R: 'MB',
  S: 'SK',
  T: 'AB',
  V: 'BC',
  X: 'NT',
  Y: 'YT',
};

/** The state or province an area code is in, or null when it's one this list doesn't know. */
export function regionOfAreaCode(code: string): string | null {
  if (!byCode) {
    const m = new Map<string, string>();
    for (const [region, codes] of Object.entries(AREA_CODES))
      for (const c of codes.split(' ')) m.set(c, region);
    byCode = m;
  }
  return byCode.get(code) ?? null;
}

function regionOfZip(zip: string): string | null {
  if (!zipRanges)
    zipRanges = ZIP3_STATES.split(' ').map((part) => {
      const [range, state] = part.split(':') as [string, string];
      const [from, to = from] = range.split('-') as [string, string?];
      return [Number(from), Number(to), state] as const;
    });
  const prefix = Number(zip.slice(0, 3));
  return zipRanges.find(([from, to]) => prefix >= from && prefix <= to)?.[2] ?? null;
}

/** The state or province an address is in, or null when it doesn't say. */
export function regionOfAddress(a: CallAddress | null): string | null {
  if (!a) return null;
  const country = (a.country ?? 'US').trim().toLowerCase();
  const state = (a.state ?? '').trim();
  const postal = (a.postalCode ?? '').trim().toUpperCase();
  if (['us', 'usa', 'united states', 'united states of america', ''].includes(country)) {
    const code = state.length === 2 ? state.toUpperCase() : STATE_NAMES[state.toLowerCase()];
    if (code && REGION_ZONES[code]) return code;
    return /^\d{5}(-?\d{4})?$/.test(postal) ? regionOfZip(postal) : null;
  }
  if (['ca', 'can', 'canada'].includes(country)) {
    const code = state.length === 2 ? state.toUpperCase() : PROVINCE_NAMES[state.toLowerCase()];
    if (code && REGION_ZONES[`CA-${code}`]) return `CA-${code}`;
    const fromPostal = /^[A-Z]\d[A-Z]/.test(postal) ? POSTAL_PROVINCES[postal[0]!] : undefined;
    return fromPostal ? `CA-${fromPostal}` : null;
  }
  return null;
}

/**
 * Every place the lead may be, from their number (`+15125550123`) and their address; the business's own time zone
 * when neither says.
 */
export function callPlacesOf(
  phone: string,
  address: CallAddress | null,
  businessTimeZone: string,
): CallPlace[] {
  const places: CallPlace[] = [];
  const add = (region: string, zones: readonly string[]) => {
    for (const timeZone of zones)
      if (!places.some((p) => p.region === region && p.timeZone === timeZone))
        places.push({ region, timeZone });
  };
  const code = /^\+1(\d{3})\d{7}$/.exec(phone)?.[1] ?? null;
  const fromPhone = code ? regionOfAreaCode(code) : null;
  const fromAddress = regionOfAddress(address);
  if (fromPhone)
    add(fromPhone, (code ? AREA_CODE_ZONES[code] : undefined) ?? REGION_ZONES[fromPhone] ?? []);
  // The same state as the number's: the area code already said which of its zones.
  if (fromAddress && fromAddress !== fromPhone) add(fromAddress, REGION_ZONES[fromAddress] ?? []);
  return places.length ? places : [{ region: null, timeZone: businessTimeZone }];
}

// ---------- when ----------

/** The calls window on a local date for a place (minutes past midnight), or null when no call may go that day. */
export function callWindowOn(
  region: string | null,
  date: string,
  hours: CallHours | null = null,
): { readonly start: number; readonly end: number } | null {
  const rule = ruleOf(region);
  const wd = weekdayOf(date);
  const day = wd === 0 ? rule.sunday : wd === 6 ? rule.saturday : rule.weekday;
  if (!day) return null;
  if (rule.holidays && region && holidaysOf(parseLocalDate(date).year, region).has(date))
    return null;
  if (hours && !hours.weekends && (wd === 0 || wd === 6)) return null;
  const start = Math.max(day[0], hours ? parseClock(hours.start) : 0);
  const end = Math.min(day[1], hours ? parseClock(hours.end) : 1440);
  return end - start > LAST_START_MINUTES ? { start, end } : null;
}

const clockOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The first moment from `t` a call may start in one place; null when there's none in the next two weeks. */
function nextOpenIn(place: CallPlace, hours: CallHours | null, t: number): number | null {
  let date = localDateOf(t, place.timeZone);
  for (let k = 0; k <= HORIZON_DAYS; k++, date = addDays(date, 1)) {
    const w = callWindowOn(place.region, date, hours);
    if (!w) continue;
    const opens = localInstant(date, clockOf(w.start), place.timeZone);
    const lastStart = localInstant(date, clockOf(w.end - LAST_START_MINUTES), place.timeZone);
    if (t <= lastStart) return Math.max(t, opens);
  }
  return null;
}

/**
 * The first moment from `now` a call may start in every place the lead may be, within the business's calling
 * hours: `now` itself when it may go at once. Null when no such time comes in the next two weeks (calling hours
 * that fit nowhere the lead might be).
 */
export function nextCallMoment(
  places: readonly CallPlace[],
  hours: CallHours | null,
  now: number,
): number | null {
  let t = now;
  for (let i = 0; i < 64; i++) {
    let latest = t;
    for (const place of places) {
      const opens = nextOpenIn(place, hours, t);
      if (opens === null) return null;
      latest = Math.max(latest, opens);
    }
    if (latest === t) return t;
    t = latest;
    if (t - now > HORIZON_DAYS * 86_400_000) return null;
  }
  return null;
}
