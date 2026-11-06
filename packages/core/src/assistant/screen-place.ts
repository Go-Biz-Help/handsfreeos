/**
 * The screen a question is asked from, named the way the Assistant names places (M12): its place in the everyday
 * work (APP_PLACES) or in the setup (the settings map), the way there, and the ids in its address. The web and the
 * phone send the address inside the business with each question (`assistantScreenPath`), and the worker names it
 * here, so "this" can mean the calendar, invoice or form that is open, not only a customer, lead or appointment.
 * Browser-safe and pure: a test reads it against the maps.
 */
import { APP_PLACES, placeWay } from './places-map';
import { settingsAreas, type SettingsArea } from './settings-map';

export interface ScreenPlace {
  /** What it is called, as the maps say it ("An invoice", "Calendars"); null for a page neither map has. */
  readonly label: string | null;
  /** The way there ("Money → Invoices, then press the invoice"); null for a page neither map has. */
  readonly way: string | null;
  /** The setup's area, when the page is one (get_settings reads it by this). */
  readonly area: SettingsArea | null;
  /** The address itself, without its query string: what a page neither map has is named by. */
  readonly path: string;
  /** The ids in the address, each named for what it is: `{ name: 'calendar', id }`. */
  readonly ids: readonly { readonly name: string; readonly id: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A word of a route ("calendars", "open-houses"): the only kind of segment the Assistant is told as it is. */
const WORD = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A query's key short for something longer (a Map, so no key reads anything else off an object). */
const KEY_NAMES: ReadonlyMap<string, string> = new Map([['appt', 'appointment']]);

interface Candidate {
  readonly segments: readonly string[];
  readonly label: string;
  readonly way: string;
  readonly area: SettingsArea | null;
  /**
   * Matches only the very address, never one under it: Home (the business's own address) and Settings itself (the
   * person's Account), since every page sits under those and most of them are something else.
   */
  readonly exact: boolean;
}

const segmentsOf = (path: string) => path.split('/').filter(Boolean);

let candidates: readonly Candidate[] | null = null;
/** The places first, then the setup: on an equal match, the first named wins. */
function allCandidates(): readonly Candidate[] {
  return (candidates ??= [
    // The agency area is outside the business, so it is never a screen a question is asked from.
    ...APP_PLACES.filter((p) => !p.path.startsWith('/app/')).map((p) => ({
      segments: segmentsOf(p.path),
      label: p.label,
      way: placeWay(p),
      area: null,
      exact: p.path === '',
    })),
    ...settingsAreas().map((a) => ({
      segments: segmentsOf(a.path),
      label: a.label,
      way: a.where.join(' → '),
      area: a.area,
      exact: a.path === '/settings',
    })),
  ]);
}

/** A placeholder in a place's path ("[invoiceId]"), which an id fills. */
const placeholder = (segment: string) => /^\[(\w+)\]$/.exec(segment)?.[1] ?? null;

/** "invoiceId" → "invoice", "checkInId" → "check in". */
const nameOfKey = (key: string) =>
  key
    .replace(/Id$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

/**
 * Words of a route that don't name the id after them, so a tool is never handed it as the wrong kind: the phone opens
 * an appointment at /calendar/<id> (a calendar's own is /settings/calendars/<id>), Money → Plans opens a customer's
 * plan (its subscriptionId, not the planId of a plan sold), and the phone's Changes open one change to fix or text.
 */
const SEGMENT_NAMES: ReadonlyMap<string, string> = new Map([
  ['calendar', 'appointment'],
  ['plans', 'customer plan'],
  ['safety', 'check in'],
  ['chats', 'chat widget'],
  ['fix', 'change'],
  ['text', 'change'],
]);

/** "calendars" → "calendar", "companies" → "company", "open-houses" → "open house". */
function singular(segment: string): string {
  const named = SEGMENT_NAMES.get(segment);
  if (named) return named;
  const words = segment.replace(/-/g, ' ');
  if (words === 'people') return 'person';
  if (/ies$/.test(words)) return words.replace(/ies$/, 'y');
  if (/[^s]s$/.test(words)) return words.slice(0, -1);
  return words;
}

/** How many parts of the address the place takes, and how many of them are its own words: null when it doesn't fit. */
function fit(c: Candidate, segments: readonly string[]): number | null {
  if (c.segments.length > segments.length || (c.exact && c.segments.length !== segments.length))
    return null;
  let words = 0;
  for (const [i, part] of c.segments.entries()) {
    const at = segments[i]!;
    if (placeholder(part)) {
      if (!UUID.test(at)) return null;
    } else if (part === at) words++;
    else return null;
  }
  // The longest match wins, and among those the one with more of its own words.
  return c.segments.length * 100 + words;
}

/**
 * The place the address is, the longest match in the maps, with the ids in it kept; a page neither map has keeps its
 * address as its name (an add-on's pages, for now). Null for one that can't be read as an address of the app.
 */
export function screenPlace(address: string | null | undefined): ScreenPlace | null {
  if (!address?.startsWith('/')) return null;
  const [pathPart = '', query = ''] = address.split(/\?(.*)/s, 2);
  const segments = segmentsOf(pathPart.split('#')[0]!);
  // Only the app's own route words and ids are ever repeated to the model, never words typed into an address.
  if (!segments.every((s) => WORD.test(s) || UUID.test(s))) return null;

  let best: Candidate | null = null;
  let bestFit = -1;
  for (const c of allCandidates()) {
    const f = fit(c, segments);
    if (f !== null && f > bestFit) {
      best = c;
      bestFit = f;
    }
  }

  const ids: { name: string; id: string }[] = [];
  segments.forEach((s, i) => {
    if (!UUID.test(s)) return;
    const named = best ? placeholder(best.segments[i] ?? '') : null;
    const before = segments[i - 1];
    const name = named
      ? nameOfKey(named)
      : before && !UUID.test(before)
        ? singular(before)
        : 'record';
    ids.push({ name, id: s.toLowerCase() });
  });
  for (const pair of query.split('&')) {
    const [key = '', value = ''] = pair.split('=', 2);
    let id: string;
    try {
      id = decodeURIComponent(value);
    } catch {
      continue;
    }
    if (UUID.test(id) && /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(key))
      ids.push({ name: KEY_NAMES.get(key) ?? nameOfKey(key), id: id.toLowerCase() });
  }

  return {
    label: best?.label ?? null,
    way: best?.way ?? null,
    area: best?.area ?? null,
    path: `/${segments.join('/')}`,
    ids,
  };
}
