import { z } from 'zod';

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
export const industry = z.enum(['home_services', 'other']);
export const isoDateTime = z.iso.datetime();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { error: 'Unknown time zone.' });

export const settings = z.record(z.string(), z.unknown());
