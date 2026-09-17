/**
 * The zone name to hand this engine's Intl for a stored zone. Intl reads the device's own time-zone data, which on a
 * phone can be older than core's list (an Android 16 emulator image has no America/Coyhaique), and it throws for a
 * name that data doesn't have. Every Intl call in core takes its timeZone from here (intl.test.ts checks), so an
 * older phone shows the zone's clock instead of failing. In order:
 * 1. the zone itself;
 * 2. for an older name ("US/Central"), the zone it's stored as;
 * 3. the zone's fallbacks: its older names and zones with the same clock (time-zone-fallbacks.ts, from tzdb);
 * 4. UTC, logged once, when this engine knows none of them.
 * Each answer is kept for as long as the app runs: an engine's time-zone data doesn't change under it. Browser-safe.
 */
import { TIME_ZONE_FALLBACKS } from './time-zone-fallbacks';
import { canonicalTimeZone } from './time-zones';

const answers = new Map<string, string>();

function engineKnows(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The name this engine's Intl takes for `zone`, with the same clock; UTC when it knows none. */
export function intlTimeZone(zone: string): string {
  let answer = answers.get(zone);
  if (answer === undefined) {
    const current = canonicalTimeZone(zone) ?? zone;
    const fallbacks = Object.prototype.hasOwnProperty.call(TIME_ZONE_FALLBACKS, current)
      ? TIME_ZONE_FALLBACKS[current]!
      : [];
    answer = [...new Set([zone, current, ...fallbacks])].find(engineKnows);
    if (answer === undefined) {
      answer = 'UTC';
      console.warn(
        `This device's time-zone data has no ${zone}, and no zone with its clock: its times show in UTC.`,
      );
    }
    answers.set(zone, answer);
  }
  return answer;
}
