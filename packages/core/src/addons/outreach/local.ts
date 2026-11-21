/**
 * What each person does and where, and the person's own town, radius and local focus (docs/outreach.md, decision 177;
 * the owner, 18 Nov 2026: "this means we should be keeping track of the area people are in and service if they are a
 * local business", "we should have a setting to focus on groups in our local area ... this means we need to add our
 * location and a radius for local meetings").
 *
 * - **What they do and where** (1a): the AI says their line of work, the town and state they work in, and whether they
 *   serve local customers, nationwide or online, from their page and the chat, as it writes to them or checks them
 *   (`THEIR_WORK_ASK`). It's kept on their profile, the business's, with how it's known; a person can change it on
 *   their card, and what a person typed the AI never writes over.
 * - **Where you are** (2a): each person's own town and how far from it is near (`RADIUS_CHOICES`), in Settings → You.
 *   It starts from the business's address when there's one.
 * - **Focus on local groups** (3): group searches add their town and the towns near it, groups named for those towns
 *   rank higher, and people who work near them go first on Today.
 *
 * A town is a known US town ("austin-tx", the US Census Bureau's places, ./us-towns.ts), so how far apart two are is
 * worked out on the server (./ops/local.ts) with no lookup. Browser-safe: the web, the phone and the worker read these
 * words and shapes.
 */
import { z } from 'zod';
import { US_STATES } from '../../onboarding-setup/address';
import { NEAR_MILES } from './towns';

/** Whom they serve: customers near them, all over the country, or online. */
export const REACH = {
  local: 'Local',
  nationwide: 'Nationwide',
  online: 'Online',
} as const;
export type Reach = keyof typeof REACH;
export const REACH_KEYS = Object.keys(REACH) as [Reach, ...Reach[]];

/** How what they do and where is known: their page, the chat, or a person typed it (which the AI never writes over). */
export const AREA_HOWS = ['page', 'chat', 'typed'] as const;
export type AreaHow = (typeof AREA_HOWS)[number];

export const WORK_MOST = 80;
export const AREA_MOST = 80;

/** How far from the person's town is near, in miles: 25 to start, as near towns on Alignable are (decision 115). */
export const RADIUS_START = NEAR_MILES;
export const RADIUS_CHOICES = [10, 25, 50, 100] as const;
export const RADIUS_LEAST = 5;
export const RADIUS_MOST = 100;

/** How many of the person's towns their group searches take in turn, theirs first, while they focus on local groups. */
export const LOCAL_SEARCH_TOWNS = 5;

/** How many of the towns near the person Settings shows by name. */
export const NEAR_SHOWN = 8;

const STATE_BY_NAME = new Map(US_STATES.map((s) => [s.name.toLowerCase(), s.code]));
const STATE_CODES = new Set(US_STATES.map((s) => s.code));
const STATE_NAME = new Map(US_STATES.map((s) => [s.code, s.name]));

/** A town as Alignable writes it, and as ./us-towns.ts keys it: "round-rock-tx". */
const slug = (words: string) =>
  words
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * An area as a US town, when it names one with its state: "Austin, TX", "Austin, Texas" or "Austin TX" is
 * "austin-tx". Null when no state is named, or it's more than a town ("the Dallas area" still reads as Dallas). The
 * server checks the town is a known one.
 */
export function townOfArea(area: string | null | undefined): string | null {
  if (!area) return null;
  const words = area
    .replace(/\b(the|greater|metro|area|region|county|and surrounding areas?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const comma = words.lastIndexOf(',');
  const [town, state] =
    comma > 0
      ? [words.slice(0, comma), words.slice(comma + 1)]
      : [words.replace(/\s+\S+$/, ''), (/\S+$/.exec(words) ?? [''])[0]];
  // "Austin, TX 78701": the state is the first word after the comma.
  const said = state.trim().replace(/\s+\d{5}(-\d{4})?$/, '');
  const code = STATE_CODES.has(said.toUpperCase())
    ? said.toUpperCase()
    : (STATE_BY_NAME.get(said.toLowerCase()) ?? null);
  const name = slug(town);
  return code && name ? `${name}-${code.toLowerCase()}` : null;
}

/** A town's own words: "round-rock-tx" is "Round Rock, TX". */
export function areaOfTown(town: string): string {
  const code = town.slice(-2).toUpperCase();
  const name = town
    .slice(0, -3)
    .split('-')
    .map((w) => (w.length <= 2 && /^(st|ft|mt)$/.test(w) ? `${w[0]!.toUpperCase()}${w[1]}.` : w))
    .map((w) => `${w.charAt(0).toUpperCase()}${w.slice(1)}`)
    .join(' ');
  return `${name}, ${code}`;
}

/** A town's name alone, as a group's name says it: "round-rock-tx" is "Round Rock". */
export const townName = (town: string): string => areaOfTown(town).replace(/, [A-Z]{2}$/, '');

/** A state's name from its two letters, for the AI. */
export const stateName = (code: string): string => STATE_NAME.get(code.toUpperCase()) ?? code;

const work = z.string().trim().max(WORK_MOST, `Keep what they do under ${WORK_MOST} characters.`);
const area = z
  .string()
  .trim()
  .max(AREA_MOST, `Keep where they work under ${AREA_MOST} characters.`);
/** What the AI said of one part: an empty answer is none, and a long one is cut to what's kept. */
const found = (most: number) =>
  z
    .string()
    .nullable()
    .default(null)
    .transform((v) => v?.replace(/\s+/g, ' ').trim().slice(0, most).trim() || null);

/** What they do and where, as kept. */
export const TheirWork = z.object({
  work: z.string().nullable(),
  area: z.string().nullable(),
  reach: z.enum(REACH_KEYS).nullable(),
});
export type TheirWork = z.output<typeof TheirWork>;

/** What they do and where as the AI gives it: an empty answer is none, and a missing one is too. */
export const TheirWorkFound = z.object({
  work: found(WORK_MOST),
  area: found(AREA_MOST),
  reach: z.enum(REACH_KEYS).nullable().default(null),
});

/** What they do and where as a profile shows it, on their card and wherever they're listed. */
export const TheirWorkShown = TheirWork.extend({
  /** How it's known, and when; null when nothing is yet. */
  how: z.enum(AREA_HOWS).nullable(),
  /** How far their town is from the person's, in whole miles, when both are known towns. */
  miles: z.number().int().nonnegative().nullable(),
  /** Whether that's inside the person's radius. */
  near: z.boolean(),
});
export type TheirWorkShown = z.output<typeof TheirWorkShown>;

export const TheirWorkSetInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  /** Null or empty clears it; a field left out keeps what's there. */
  work: work.nullable().optional(),
  area: area.nullable().optional(),
  reach: z.enum(REACH_KEYS).nullable().optional(),
});
export type TheirWorkSetInput = z.input<typeof TheirWorkSetInput>;
export const TheirWorkSetOutput = z.object({ profileId: z.uuid(), shown: TheirWorkShown });

export const TheirWorkNoteInput = z.object({
  workspaceId: z.uuid(),
  /** The person the AI wrote or checked for: how far away it is is theirs. */
  userId: z.uuid(),
  profileId: z.uuid(),
  how: z.enum(['page', 'chat']),
  them: TheirWorkFound,
});
export type TheirWorkNoteInput = z.input<typeof TheirWorkNoteInput>;
export const TheirWorkNoteOutput = z.object({ saved: z.boolean() });

export const LocationGetInput = z.object({ workspaceId: z.uuid() });
export type LocationGetInput = z.input<typeof LocationGetInput>;

/** The person's own town, radius and local focus, as Settings → You shows them. */
export const LocationShown = z.object({
  /** Their town as it reads ("Dallas, TX"), or null when they haven't set one. */
  area: z.string().nullable(),
  /** The business's town, from its address, to start from when they haven't set their own. */
  suggested: z.string().nullable(),
  radiusMiles: z.number().int(),
  localFocus: z.boolean(),
  /** The towns inside their radius, closest first, the first `NEAR_SHOWN` by name, and how many in all. */
  near: z.array(z.string()),
  nearCount: z.number().int().nonnegative(),
});
export type LocationShown = z.output<typeof LocationShown>;

export const LocationSetInput = z.object({
  workspaceId: z.uuid(),
  /** Their town and state ("Dallas, TX"); null clears it. Left out, it stays. */
  area: area.nullable().optional(),
  radiusMiles: z
    .number()
    .int()
    .min(RADIUS_LEAST, `Pick at least ${RADIUS_LEAST} miles.`)
    .max(RADIUS_MOST, `Pick ${RADIUS_MOST} miles or fewer.`)
    .optional(),
  localFocus: z.boolean().optional(),
});
export type LocationSetInput = z.input<typeof LocationSetInput>;

/**
 * A calendar a person can pick for their networking calls or their demos (decision 178): one of the business's that
 * customers can book online now. `mine` when they own it.
 */
export const CalendarChoice = z.object({ id: z.uuid(), name: z.string(), mine: z.boolean() });
export type CalendarChoice = z.output<typeof CalendarChoice>;

/** The person's Networking calendar and Lead calendar, as Settings → You shows them. */
export const MyCalendarsShown = z.object({
  /** The picks, or null for none (a pick that stopped taking bookings shows as none). */
  networking: CalendarChoice.nullable(),
  lead: CalendarChoice.nullable(),
  /** Where a networking call goes with none picked: their own calendar, when they have one that takes bookings. */
  networkingOtherwise: z.string().nullable(),
  /** The calendars they can pick from, theirs first. */
  choices: z.array(CalendarChoice),
});
export type MyCalendarsShown = z.output<typeof MyCalendarsShown>;

export const MyCalendarsGetInput = z.object({ workspaceId: z.uuid() });
export type MyCalendarsGetInput = z.input<typeof MyCalendarsGetInput>;

export const MyCalendarsSetInput = z.object({
  workspaceId: z.uuid(),
  /** A calendar's id, or null for none. Left out, it stays. */
  networkingCalendarId: z.uuid().nullable().optional(),
  leadCalendarId: z.uuid().nullable().optional(),
});
export type MyCalendarsSetInput = z.input<typeof MyCalendarsSetInput>;

/** The words Settings → You and a person's card show, on the web and the phone. */
export const LOCAL_WORDS = {
  where: 'Where you are',
  whereHint:
    'Your town and how far you’ll go to meet. The AI uses it to tell who’s local to you, and for local groups.',
  whereNone: 'Not set yet',
  townLabel: 'Your town',
  townPlaceholder: 'Dallas, TX',
  radiusLabel: 'How far is local',
  focus: 'Focus on local groups',
  focusHint:
    'Group searches add your town and the towns near it, local groups rank higher, and people who work near you go first on Today.',
  focusNeedsTown: 'Set your town first.',
  theirWork: 'What they do and where',
  theirWorkNone: 'Not known yet',
  workLabel: 'What they do',
  workPlaceholder: 'Roofing',
  areaLabel: 'Where they work',
  areaPlaceholder: 'Austin, TX',
  reachLabel: 'Who they serve',
  typed: 'You set this',
  fromPage: 'From their page',
  fromChat: 'From your chat',
  save: 'Save',
  change: 'Change',
  cancel: 'Cancel',
  saved: 'Saved',
  clear: 'Clear',
  miles: (n: number) => `${n} miles`,
  /** "Local takes in Plano, Frisco and Richardson, and 23 more towns." */
  nearLine: (l: Pick<LocationShown, 'near' | 'nearCount'>) =>
    l.near.length
      ? `Local takes in ${l.near.join(', ')}${l.nearCount > l.near.length ? `, and ${l.nearCount - l.near.length} more towns` : ''}.`
      : 'No other towns are that close.',
  noReach: 'Not sure',
  unknownTown: (area: string) =>
    `We couldn’t find “${area}”. Write it as a US town and its state, like Dallas, TX.`,
  profileGone: 'That person isn’t in Social Outreach anymore. Refresh the page and try again.',
  calendars: 'Your calendars',
  calendarsHint:
    'Where people book with you. A networking call goes on your Networking calendar, and a demo on your Lead calendar.',
  networkingCalendar: 'Networking calendar',
  leadCalendar: 'Lead calendar',
  pickNone: 'None picked',
  /** What the Networking calendar row says with none picked. */
  networkingOtherwise: (name: string | null) =>
    name ? `None picked, so calls go on ${name}` : 'None picked, so calls go without a link',
  leadOtherwise: 'None picked, so demos use your playbook’s booking link',
  noCalendars:
    'No calendar takes bookings online yet. Turn on Public booking for one in Settings → Calendars.',
  calendarNotBookable: (name: string) =>
    `${name} isn’t taking bookings online. Turn on Public booking for it in Settings → Calendars, then pick it again.`,
  calendarGone: 'That calendar isn’t there anymore. Refresh the page and pick another.',
} as const;

/** "Networking: Chris’s calendar · Leads: Demo", for the Your calendars row. */
export function myCalendarsLine(c: Pick<MyCalendarsShown, 'networking' | 'lead'>): string {
  if (!c.networking && !c.lead) return LOCAL_WORDS.pickNone;
  return [
    `Networking: ${c.networking?.name ?? LOCAL_WORDS.pickNone.toLowerCase()}`,
    `Leads: ${c.lead?.name ?? LOCAL_WORDS.pickNone.toLowerCase()}`,
  ].join(' · ');
}

/** "Within 25 miles of Dallas, TX", for the Where you are row. */
export const locationLine = (l: Pick<LocationShown, 'area' | 'radiusMiles'>): string =>
  l.area ? `Within ${l.radiusMiles} miles of ${l.area}` : LOCAL_WORDS.whereNone;

/** "Roofing · Austin, TX · Local · 12 miles away", for their card; null when nothing is known. */
export function theirWorkLine(t: Omit<TheirWorkShown, 'how'>): string | null {
  const parts = [
    t.work ? `${t.work.charAt(0).toUpperCase()}${t.work.slice(1)}` : null,
    t.area,
    t.reach ? REACH[t.reach] : null,
    t.miles !== null ? (t.miles <= 1 ? 'In your town' : `${t.miles} miles away`) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * What the AI is asked of them as it writes to them or checks them (1a): asked of every draft, so the schema stays
 * one, and kept only where it reads their page or the chat.
 */
export const THEIR_WORK_ASK =
  'Also say, from the facts, their pages and the chat only: work, what they do for a living in a few words, the way they’d say it (“roofing”, “real estate”, “mobile car detailing”); area, the town they work in with its state’s two letters (“Austin, TX”), or the metro or region when that’s all that shows; and reach, local when they serve customers near them, nationwide when all over the country, online when online. Give an empty string for anything that doesn’t show, and never guess it from the playbook or the owner’s business.';

/**
 * What a draft is told of them (decision 177): what they do, where, and how far from the owner, for the line about
 * sending people their way and anything local.
 */
export function theirWorkFact(t: Omit<TheirWorkShown, 'how'> | null): string | null {
  if (!t || (!t.work && !t.area && !t.reach)) return null;
  return [
    t.work ? `What they do: ${t.work}.` : null,
    t.area ? `Where they work: ${t.area}.` : null,
    t.reach === 'local'
      ? 'They serve customers near them.'
      : t.reach === 'nationwide'
        ? 'They serve customers all over the country.'
        : t.reach === 'online'
          ? 'They serve customers online.'
          : null,
    t.miles !== null
      ? t.near
        ? `They’re local to the owner, about ${Math.max(1, t.miles)} miles away.`
        : `They’re about ${t.miles} miles from the owner, outside where the owner meets in person.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
}
