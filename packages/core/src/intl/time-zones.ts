/**
 * Which time zones are valid, answered from the list shipped in core (time-zone-names.ts, from tzdb) and never by
 * Intl, whose engines disagree: iPhones accept "GMT+5", Android refuses "CST", and V8 reads "CST" as Chicago. The
 * phone, the web and the server give the same answer.
 *
 * - A zone on the list ("America/Chicago", "UTC") is itself.
 * - An older name browsers and phones still report is read as its current zone: "Asia/Calcutta" is "Asia/Kolkata",
 *   "US/Central" is "America/Chicago", "Etc/UTC" is "UTC". Letter case doesn't matter, as in Intl.
 * - Anything else is refused: abbreviations ("CST", and tzdb's own "EST"), fixed offsets ("GMT+5", "Etc/GMT+5") and
 *   misspellings. Abbreviations and offsets don't follow daylight saving the way a business's clocks do.
 *
 * A zone on the list can still be newer than an old phone's own time-zone data, which only a run on that phone shows
 * (the app's self-test screen). Browser-safe.
 */
import { TIME_ZONE_ALIASES, TIME_ZONES } from './time-zone-names';

let byName: Map<string, string> | undefined;

function names(): Map<string, string> {
  if (!byName) {
    byName = new Map(TIME_ZONES.map((zone) => [zone.toLowerCase(), zone]));
    for (const [alias, zone] of Object.entries(TIME_ZONE_ALIASES))
      byName.set(alias.toLowerCase(), zone);
  }
  return byName;
}

/** The zone a name is stored as ("US/Central" → "America/Chicago"), or null when it isn't on the list. */
export function canonicalTimeZone(name: unknown): string | null {
  if (typeof name !== 'string' || !name) return null;
  return names().get(name.toLowerCase()) ?? null;
}

/** On the list, as a zone or an older name. */
export function isValidTimeZone(tz: string): boolean {
  return canonicalTimeZone(tz) !== null;
}

/**
 * A zone someone's browser or phone reported, as its current name, or `fallback` when it isn't on the list ("CST",
 * "GMT+05:30", "Etc/Unknown", nothing at all). For public pages, which never refuse a visitor for their own zone.
 */
export function timeZoneOr(reported: unknown, fallback: string): string {
  return canonicalTimeZone(reported) ?? fallback;
}
