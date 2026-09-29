import { z } from 'zod';
import { INDUSTRY_IDS } from '../industries';
import { canonicalTimeZone, isValidTimeZone } from '../intl/time-zones';

export const uuid = z.uuid();
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address.' }).max(254));
export const workspaceRole = z.enum(['owner', 'admin', 'member']);
export const orgRole = z.enum(['owner', 'admin']);
export const displayName = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(120, 'Keep it under 120 characters.');
/** A kind of business on core's list (industries.ts). */
export const industry = z.enum(INDUSTRY_IDS, {
  error: 'Pick the kind of business from the list, or Other.',
});
export const isoDateTime = z.iso.datetime();

/**
 * A time zone on core's list (intl/time-zones.ts), never whatever this engine's Intl accepts. An older name
 * ("US/Central") is stored as its current zone ("America/Chicago").
 */
export const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { error: 'Unknown time zone.' })
  .overwrite((tz) => canonicalTimeZone(tz) ?? tz);

export const settings = z.record(z.string(), z.unknown());
