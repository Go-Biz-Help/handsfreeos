/**
 * Times to meet, in the chat (docs/outreach.md, decision 149; Chris, 3 Nov 2026: "since we are using a HFOS calendar
 * can't the ai in the social outreach tool suggest times instead of just sending a booking calendar", answered
 * "1a 2a 3a 4a"). When a playbook's link is one of the business's own booking pages:
 *
 * - **Send the link**, the follow-up after it, **Offer another time** and a reply that leads to a call offer three open
 *   times on that calendar, with the link kept for any other time (1a). Said the way a person texts them (the owner's
 *   own examples: "tomorrow at 11 ct", "this friday at noon ct", "tues 3pm ct", "wednesday 10am ct"), never as a list.
 * - **When they pick one** (2a), the reply asks for the email to send the invite to, and once they've given it (or a
 *   mobile number), confirms the time. The booking is made just before that reply goes, as their Replies setting says,
 *   through the person's demo link, so it counts as their demo (decision 24).
 * - **Whose times** (3a): the person's own, booked with them, when they're on that calendar; anyone's otherwise.
 * - **Which** (4a): one on each of the next three days with open times from tomorrow, spread out (a morning, an
 *   afternoon, around midday), in their time zone when a "Lives in" on their profile shows it, else the calendar's,
 *   always with the zone named.
 *
 * Browser-safe: the worker works out the times (apps/worker/src/addons/outreach/times.ts), core's today.ts tells the AI.
 */
import { z } from 'zod';
import { addDays, localDateOf, startOfLocalDay, zonedParts } from '../../calendar/engine/zoned';
import { quoteData } from '../../knowledge/prompt';

/** How many times a message offers (4a). */
export const TIMES_OFFERED = 3;
/** How far ahead it looks for days with open times. */
export const TIMES_LOOK_DAYS = 14;
/** How many days of open times a reply reads, to find the one they picked. */
export const OPEN_LIST_DAYS = 8;
/** The most open times listed for one day: past that, spread across it. */
const OPEN_A_DAY_MOST = 24;
/**
 * The hour each offered day aims for, in their time zone: a morning, an afternoon, then around midday, so three
 * times never sit in a row.
 */
const AIM_HOURS = [11, 15, 12] as const;

/** The kinds of message that offer times (1a). A follow-up does only after the link. */
export const TIME_KINDS = ['pitch', 'rebook', 'follow_up', 'reply'] as const;
export type TimeKind = (typeof TIME_KINDS)[number];
export const isTimeKind = (kind: string): kind is TimeKind =>
  (TIME_KINDS as readonly string[]).includes(kind);

// ---- The playbook's link ----

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The booking page a link is, by its address: `/book/<site>/<calendar>`, or `/book/c/<calendar id>` (which the
 * booking route reads as site "c"). On any host: the business's own domain serves its pages too. Null for anything
 * else (a form, Calendly, a website).
 */
export function bookingPageOf(
  link: string | null | undefined,
): { readonly site: string; readonly calendar: string } | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'book') return null;
  const site = parts[1]!.toLowerCase();
  const calendar = parts[2]!.toLowerCase();
  if (site === 'c') return UUID.test(calendar) ? { site, calendar } : null;
  return SLUG.test(site) && SLUG.test(calendar) ? { site, calendar } : null;
}

// ---- Time zones ----

/** A US state's main time zone, by its name or two letters. */
const STATE_ZONES: Readonly<Record<string, string>> = (() => {
  const zones: Record<string, readonly string[]> = {
    'America/New_York': [
      'connecticut ct',
      'delaware de',
      'district of columbia dc',
      'washington dc',
      'florida fl',
      'georgia ga',
      'indiana in',
      'kentucky ky',
      'maine me',
      'maryland md',
      'massachusetts ma',
      'michigan mi',
      'new hampshire nh',
      'new jersey nj',
      'new york ny',
      'north carolina nc',
      'ohio oh',
      'pennsylvania pa',
      'rhode island ri',
      'south carolina sc',
      'vermont vt',
      'virginia va',
      'west virginia wv',
    ],
    'America/Chicago': [
      'alabama al',
      'arkansas ar',
      'illinois il',
      'iowa ia',
      'kansas ks',
      'louisiana la',
      'minnesota mn',
      'mississippi ms',
      'missouri mo',
      'nebraska ne',
      'north dakota nd',
      'oklahoma ok',
      'south dakota sd',
      'tennessee tn',
      'texas tx',
      'wisconsin wi',
    ],
    'America/Denver': [
      'colorado co',
      'idaho id',
      'montana mt',
      'new mexico nm',
      'utah ut',
      'wyoming wy',
    ],
    'America/Phoenix': ['arizona az'],
    'America/Los_Angeles': ['california ca', 'nevada nv', 'oregon or', 'washington wa'],
    'America/Anchorage': ['alaska ak'],
    'Pacific/Honolulu': ['hawaii hi'],
  };
  const out: Record<string, string> = {};
  for (const [zone, states] of Object.entries(zones))
    for (const s of states) {
      const words = s.split(' ');
      out[words.slice(0, -1).join(' ')] = zone;
      out[words.at(-1)!] = zone;
    }
  // "Washington" alone is the state; "Washington, DC" names DC by its two letters.
  out['washington'] = 'America/Los_Angeles';
  return out;
})();

/** A country with one time zone, by its two letters (./countries.ts). */
const COUNTRY_ZONES: Readonly<Record<string, string>> = {
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  IN: 'Asia/Kolkata',
  PH: 'Asia/Manila',
  ZA: 'Africa/Johannesburg',
  NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi',
  GH: 'Africa/Accra',
  JM: 'America/Jamaica',
  PR: 'America/Puerto_Rico',
};

const LIVES = /^(?:lives in|currently lives in)\s+(.+?)\.?$/i;

/**
 * Their time zone, from a "Lives in" line on their profile ("Lives in Austin, Texas", "Lives in Tampa, FL"): a US
 * state's main zone, or a country's with only one. Null when no line shows it.
 */
export function zoneFromLines(
  lines: readonly string[],
  country: string | null = null,
): string | null {
  // Someone known to live outside the US: their country's zone, when it has only one.
  const abroad = country !== null && country.toUpperCase() !== 'US';
  if (abroad) return COUNTRY_ZONES[country.toUpperCase()] ?? null;
  for (const line of lines) {
    const m = line.trim().match(LIVES);
    if (!m) continue;
    const parts = m[1]!
      .split(',')
      .map((p) =>
        p
          .trim()
          .toLowerCase()
          .replace(/\./g, '')
          .replace(/\s+usa?$|\s+united states$/, ''),
      )
      .filter(Boolean);
    // "Austin, Texas, United States": the part before the country.
    const named = parts.filter((p) => p !== 'usa' && p !== 'us' && p !== 'united states');
    // A state or its two letters after a town ("Austin, TX"); a full name alone ("Texas").
    const last = named.at(-1);
    if (last && (named.length > 1 || last.length > 2) && STATE_ZONES[last])
      return STATE_ZONES[last];
  }
  return null;
}

/** US zones by their short name, the way people text them ("ct"). */
const ZONE_WORDS: Readonly<Record<string, string>> = {
  'America/New_York': 'et',
  'America/Detroit': 'et',
  'America/Toronto': 'et',
  'America/Indiana/Indianapolis': 'et',
  'America/Kentucky/Louisville': 'et',
  'America/Chicago': 'ct',
  'America/Winnipeg': 'ct',
  'America/Menominee': 'ct',
  'America/Indiana/Knox': 'ct',
  'America/Indiana/Tell_City': 'ct',
  'America/Denver': 'mt',
  'America/Boise': 'mt',
  'America/Edmonton': 'mt',
  'America/Phoenix': 'mt',
  'America/Los_Angeles': 'pt',
  'America/Vancouver': 'pt',
  'America/Anchorage': 'akt',
  'America/Juneau': 'akt',
  'Pacific/Honolulu': 'ht',
};

/**
 * A zone as a person texts it: "ct", "et", "mt", "pt"; else its city, "london time". The rest of a zone's family
 * (America/Indiana/Vincennes, America/North_Dakota/Center) goes by its place in the US.
 */
export function zoneWord(zone: string): string {
  const known = ZONE_WORDS[zone];
  if (known) return known;
  if (zone.startsWith('America/Indiana/') || zone.startsWith('America/Kentucky/')) return 'et';
  if (zone.startsWith('America/North_Dakota/')) return 'ct';
  const city = zone.split('/').at(-1)?.replace(/_/g, ' ').toLowerCase();
  return city ? `${city} time` : 'utc';
}

// ---- Open times ----

/** An open time on the calendar, as the engine gave it. */
export interface OpenTime {
  /** Epoch ms. */
  readonly at: number;
  readonly sessionId: string | null;
  readonly userIds: readonly string[];
}

/**
 * The times a message offers (4a): from tomorrow in their zone, one on each of the first three days with any, the one
 * nearest that day's aimed hour (a morning, an afternoon, around midday). Fewer when fewer days have any.
 */
export function pickTimes(
  open: readonly OpenTime[],
  zone: string,
  now: number,
  most: number = TIMES_OFFERED,
): OpenTime[] {
  const today = localDateOf(now, zone);
  const byDay = new Map<string, OpenTime[]>();
  for (const t of [...open].sort((a, b) => a.at - b.at)) {
    const day = localDateOf(t.at, zone);
    if (day <= today) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), t]);
  }
  const picked: OpenTime[] = [];
  for (const [, times] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    if (picked.length >= most) break;
    const aim = AIM_HOURS[picked.length % AIM_HOURS.length]! * 60;
    const minutes = (t: OpenTime) => {
      const p = zonedParts(t.at, zone);
      return p.hour * 60 + p.minute;
    };
    const best = times.reduce((b, t) =>
      Math.abs(minutes(t) - aim) < Math.abs(minutes(b) - aim) ? t : b,
    );
    picked.push(best);
  }
  return picked;
}

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** "11am", "noon", "3pm", "10:30am". */
export function clockWords(hour: number, minute: number): string {
  if (hour === 12 && minute === 0) return 'noon';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const m = minute ? `:${String(minute).padStart(2, '0')}` : '';
  return `${h}${m}${hour < 12 ? 'am' : 'pm'}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/**
 * A time the way a person texts it, in their zone: "tomorrow at 11am ct", "friday at 3pm ct", and a week or more out
 * "tuesday the 18th at noon ct". The AI may word it as the owner does ("tues 3pm ct"), never change it.
 */
export function sayTime(at: number, zone: string, now: number): string {
  const p = zonedParts(at, zone);
  const day = localDateOf(at, zone);
  const today = localDateOf(now, zone);
  const clock = `${clockWords(p.hour, p.minute)} ${zoneWord(zone)}`;
  if (day === today) return `today at ${clock}`;
  if (day === addDays(today, 1)) return `tomorrow at ${clock}`;
  const weekday = WEEKDAY_NAMES[p.weekday]!;
  if (day < addDays(today, 7)) return `${weekday} at ${clock}`;
  return `${weekday} the ${ordinal(p.day)} at ${clock}`;
}

/** A time as the open times list it, and as the AI gives back the one they picked: "2026-11-05 15:00", their zone. */
export function timeKey(at: number, zone: string): string {
  const p = zonedParts(at, zone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}

/** The open time the AI said they picked, by its key: null when it isn't one of them. */
export function openTimeOf(
  key: string | null | undefined,
  open: readonly OpenTime[],
  zone: string,
): OpenTime | null {
  const k = key?.trim().replace('T', ' ').slice(0, 16);
  if (!k) return null;
  return open.find((t) => timeKey(t.at, zone) === k) ?? null;
}

/**
 * The open times a reply reads to find the one they picked, a line a day in their zone: "2026-11-05 (thursday,
 * november 5th): 09:00, 09:30, 13:00". Up to `OPEN_LIST_DAYS` days, and a day with many spread across it.
 */
export function openLines(open: readonly OpenTime[], zone: string, now: number): string[] {
  const today = localDateOf(now, zone);
  const last = addDays(today, OPEN_LIST_DAYS);
  const byDay = new Map<string, OpenTime[]>();
  for (const t of [...open].sort((a, b) => a.at - b.at)) {
    if (t.at < now) continue;
    const day = localDateOf(t.at, zone);
    if (day > last) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), t]);
  }
  return [...byDay].map(([day, times]) => {
    const p = zonedParts(times[0]!.at, zone);
    const shown = spreadOut(times, OPEN_A_DAY_MOST);
    const label = `${WEEKDAY_NAMES[p.weekday]}, ${MONTH_NAMES[p.month - 1]} ${ordinal(p.day)}`;
    return `${day} (${label}): ${shown.map((t) => timeKey(t.at, zone).slice(11)).join(', ')}`;
  });
}

/** Up to `n` of a list, spread from its first to its last. */
function spreadOut<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  const picked = new Set<number>();
  for (let i = 0; i < n; i++) picked.add(Math.round((i * (list.length - 1)) / (n - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => list[i]!);
}

/** The start of tomorrow in a zone: offered times start there. */
export const tomorrowIn = (now: number, zone: string): number =>
  startOfLocalDay(addDays(localDateOf(now, zone), 1), zone);

// ---- Who to book ----

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;

/**
 * The email, else the mobile number, they wrote in the chat, their latest first: what the invite goes to. Only what
 * they wrote themselves, never the owner's.
 */
export function contactIn(theirs: readonly string[]): {
  readonly email: string | null;
  readonly phone: string | null;
} {
  for (const text of [...theirs].reverse()) {
    const email = [...text.matchAll(EMAIL)].at(-1)?.[0];
    if (email) return { email: email.replace(/[.,;:]+$/, '').toLowerCase(), phone: null };
  }
  for (const text of [...theirs].reverse()) {
    const m = [...text.matchAll(PHONE)].at(-1);
    if (m) return { email: null, phone: `+1${m[1]}${m[2]}${m[3]}` };
  }
  return { email: null, phone: null };
}

// ---- What the AI is told ----

/** How the times read in a message: the owner's own examples (4a, "make sure it's natural and not robotic"). */
export const TIMES_SAY =
  'Say each time the way a person texts it, like “tomorrow at 11 ct”, “this friday at noon ct”, “tues 3pm ct” or “wednesday 10am ct”: in a natural sentence, never as a list, with the zone short, and never “11:00 AM CST” or a date in numbers. Word them your own way, but keep each day and time exactly as given.';

/** What a draft is told of the times to offer, and for a reply, what's open and who the invite goes to. */
export interface DraftTimes {
  /** The times to offer, in words (`sayTime`). */
  readonly offer: readonly string[];
  /** For a reply: the open times, a line a day (`openLines`). */
  readonly open?: readonly string[];
  /** Their zone, as texted ("ct"). */
  readonly zone: string;
  /** For a reply: the email or number they gave for the invite; null when they haven't. */
  readonly contact?: string | null;
}

/** The kinds' lines on offering times: what each one does with them. */
const OFFER_TASK: Readonly<Record<TimeKind, string>> = {
  pitch:
    'Offer the times below for the quick call, all in one natural sentence, and ask which works for them. Then give the link for any other time, as a short add-on (“or grab any time that works for you here: …”).',
  rebook:
    'Offer the times below for another call, in one natural sentence, and ask whether one works. Then give the link for any other time.',
  follow_up:
    'Ask lightly whether one of the times below works, in one natural sentence, with the link for any other time.',
  reply:
    'When the chat is heading to a call (they’re interested, asked how to start or when you could talk), offer the times below in one natural sentence and ask which works, with the link for any other time. Don’t offer them in a reply that only answers a question, signs off, or follows a no.',
};

/** The lines a draft gets for the times: what to offer, how to say them, and for a reply, how to book one. */
export function timesLines(kind: TimeKind, times: DraftTimes, link: string | null): string[] {
  const lines: string[] = [];
  if (times.offer.length)
    lines.push(
      `<times>\n${quoteData(times.offer.map((t) => `- ${t}`).join('\n'))}\n</times>`,
      OFFER_TASK[kind],
      TIMES_SAY,
    );
  if (kind === 'reply' && times.open?.length) {
    lines.push(
      `<open_times zone="${times.zone}">\n${quoteData(times.open.join('\n'))}\n</open_times>`,
      times.contact
        ? `The email or number they gave for the invite: ${quoteData(times.contact)}.`
        : 'They haven’t given an email or a mobile number for the invite yet.',
      [
        'When they agreed to one of the times offered, or named a day and time, look for it under <open_times> (their time zone).',
        times.contact
          ? 'When it’s there, write a short, warm confirmation that they’re booked for it, said the way a person texts it, and that the invite is on its way to their email (or a text, for a number). No pitch and no link.'
          : 'When it’s there, say that time works, and ask for the best email to send the invite to. No link.',
        'When it isn’t there, say kindly that one just got taken and offer two or three of the nearest that are open.',
      ].join(' '),
      TIME_ASK,
    );
  }
  if (link && kind !== 'reply' && times.offer.length)
    lines.push(`The link for any other time: ${quoteData(link)}`);
  return lines;
}

/** What the AI gives back for the time they picked (`TodayDraftAnswer.time`). */
export const TIME_ASK =
  'Also give time: for a reply where they agreed to, or named, a time that is under <open_times>, that time exactly as written there (like 2026-11-05 15:00). Otherwise leave it empty.';

// ---- What's kept with a message that offers times or books one ----

/** A time offered in a message, kept so it's checked again before the message goes. */
export const KeptTime = z.object({
  at: z.iso.datetime(),
  says: z.string().trim().min(1).max(80),
  sessionId: z.uuid().nullable().default(null),
});
export type KeptTime = z.output<typeof KeptTime>;

/** The booking a reply makes before it goes (2a): when, and who to book. */
export const TimeBooking = z
  .object({
    at: z.iso.datetime(),
    says: z.string().trim().min(1).max(80),
    sessionId: z.uuid().nullable().default(null),
    name: z.string().trim().min(1).max(160),
    email: z.email().max(254).nullable().default(null),
    phone: z.string().trim().max(20).nullable().default(null),
  })
  .refine((b) => b.email !== null || b.phone !== null, {
    error: 'A booking needs their email or mobile number.',
  });
export type TimeBooking = z.output<typeof TimeBooking>;

/** Where a message's times are (`time_offers.state`). */
export const TIME_OFFER_STATES = {
  drafted: 'Drafted',
  checking: 'Checking the times',
  ready: 'Times still open',
  booked: 'Booked',
  taken: 'A time was taken',
  failed: 'Couldn’t book it',
  dropped: 'Message skipped',
} as const;
export type TimeOfferState = keyof typeof TIME_OFFER_STATES;

/** States a message waits in before it goes: OK'd, it's held till the times are checked (and the booking made). */
export const TIME_HOLDS: readonly TimeOfferState[] = ['drafted', 'checking'];

/** How many times a message is written again when a time in it was taken, before it waits for the person. */
export const TIME_REDRAFTS_MOST = 2;

export const TIME_WORDS = {
  /** On a draft that books (web Today). */
  books: (says: string) => `Sending this books them in for ${says}.`,
  /** The web Today's copy of one that books, once booked. */
  booked: (says: string, messaging: string) => `Booked ${says}. Paste it in ${messaging}.`,
  /** Why a message waits for the person after its time was taken and it was written again. */
  rewritten:
    'A time in it was just taken, so it was written again with fresh times. Look it over, then OK it.',
  /** Why it waits when the booking couldn't be made. */
  notBooked: (says: string, why: string) =>
    `HandsFreeOS couldn’t book ${says} for them: ${why} Book it yourself on your calendar, or change the message and send your link instead.`,
  /** Why it waits when a time in it was taken and it couldn't be written again. */
  takenWaits: (says: string) =>
    `${capital(says)} was just taken, so nothing was booked and the message didn’t go. Change it to another time, or skip it.`,
  /** The web Today's copy of one whose time was just taken. */
  takenNow: (says: string) =>
    `${capital(says)} was just taken, so nothing was booked. Press Draft again for fresh times.`,
} as const;

function capital(words: string): string {
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

// ---- What the worker keeps and settles ----

/** The worker keeps a draft's times and booking (`outreach.times.keep`), as the person's, while it drafts. */
export const TimesKeepInput = z.object({
  workspaceId: z.uuid(),
  userId: z.uuid(),
  profileId: z.uuid(),
  calendarId: z.uuid(),
  hostUserId: z.uuid().nullable().default(null),
  zone: z.string().trim().min(1).max(64),
  times: z.array(KeptTime).max(TIMES_OFFERED).default([]),
  booking: TimeBooking.nullable().default(null),
  drafts: z.array(z.string().trim().min(1).max(2_000)).min(1).max(5),
});
export type TimesKeepInput = z.input<typeof TimesKeepInput>;
export const TimesKeepOutput = z.object({ offerId: z.uuid().nullable() });

/**
 * How the worker's check of a message's times came out (`outreach.times.settle`): all still open (`ready`), the
 * booking made (`booked`), a time taken (`taken`, with the message written again when it could be), the booking
 * refused for another reason (`failed`, with why), or the message gone (`dropped`).
 */
export const TimesSettleInput = z.object({
  workspaceId: z.uuid(),
  offerId: z.uuid(),
  state: z.enum(['ready', 'booked', 'taken', 'failed', 'dropped']),
  appointmentId: z.uuid().nullable().default(null),
  why: z.string().trim().max(500).nullable().default(null),
  /** Taken: the message written again with fresh times, and the new draft's own offer when it has one. */
  rewrite: z
    .object({ text: z.string().trim().min(1).max(2_000), offerId: z.uuid().nullable() })
    .nullable()
    .default(null),
});
export type TimesSettleInput = z.input<typeof TimesSettleInput>;
export const TimesSettleOutput = z.object({ settled: z.boolean() });

/**
 * The web's Today books the time in a reply the person copies to send themselves (`outreach.times.book`): the one
 * of their drafts for them, by its words. Booked, or nothing to book; a time just taken is refused.
 */
export const TimesBookInput = z.object({
  profileId: z.uuid(),
  text: z.string().trim().min(1).max(2_000),
});
export type TimesBookInput = z.input<typeof TimesBookInput>;
export const TimesBookOutput = z.object({
  /** What was booked, in words; null when the draft books nothing. */
  booked: z.string().nullable(),
});
