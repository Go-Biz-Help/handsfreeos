import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/** E.164 for a phone typed by a person, or null when it is not a phone number. US by default. */
export function normalizePhone(
  input: string | null | undefined,
  defaultCountry: CountryCode = 'US',
): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  return parsed && parsed.isPossible() ? parsed.number : null;
}

/** The way people read a number: national format at home, international elsewhere. */
export function formatPhone(
  e164: string | null | undefined,
  homeCountry: CountryCode = 'US',
): string {
  if (!e164) return '';
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return parsed.country === homeCountry ? parsed.formatNational() : parsed.formatInternational();
}
