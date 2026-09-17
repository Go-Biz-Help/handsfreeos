/**
 * Dates on the customer's own money pages.
 *
 * Two kinds of date arrive from the worker and they are read differently:
 * - A **day** (`expiresOn`, `dueOn`) is already the business's own local day, so it is printed as it stands —
 *   "good until Wed, Sep 30" means that day where the business is, and shifting it into the reader's zone
 *   would move it.
 * - A **moment** (approved at, paid at) is shown in the reader's own zone, because that is the only clock the
 *   person looking at the page has. The business sees the same moment in its zone in the Money section.
 *
 * The public routes deliberately don't hand out the business's time zone, so there is nothing else to use.
 */
import { plainSpaces, timeZoneOr } from '@hfos/core';
import { dateLong, dateShort } from '@/components/booking/format';

export { dateLong, dateShort };

const LONG = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const SHORT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** "Fri, Sep 18" for a moment, in the reader's own zone. */
export const momentShort = (iso: string): string => SHORT.format(new Date(iso));

/** "Thursday, September 17 at 2:14 PM" for a moment, in the reader's own zone. */
export function momentLong(iso: string): string {
  const at = new Date(iso);
  // Some browsers put a narrow no-break space before AM/PM; the rest of the app prints a plain one.
  return plainSpaces(`${LONG.format(at)} at ${TIME.format(at)}`);
}

/** "Wed, Sep 30" for a business-local day, or null when there isn't one. */
export const dayShort = (day: string | null): string | null => (day ? dateShort(day) : null);

/** "Wednesday, September 30" for a business-local day. */
export const dayLong = (day: string | null): string | null => (day ? dateLong(day) : null);

/** Joins the parts of a sub-heading, leaving out the ones there aren't: "New AC install · Due Fri, Oct 2". */
export const joinParts = (...parts: (string | null | undefined)[]): string =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join(' · ');

/**
 * The zone the reader's browser is in. Core's `dueWording` and `expiryPhrase` count days in a zone, and the
 * public routes deliberately hand out no business zone, so the reader's own is the only clock this page has:
 * "Due today" then means today where they are, which is what the words say to them. An older name is read as its
 * current zone; one that isn't on core's list (a browser that can't tell, "Etc/Unknown") reads days in UTC rather
 * than failing the page.
 */
export const viewerZone = (): string =>
  timeZoneOr(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC');
