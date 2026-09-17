/**
 * Intl's own spaces, as plain ones. Engines put a narrow no-break space (U+202F) before AM and PM, some locales a
 * no-break space (U+00A0, "p. m."), and ranges thin spaces (U+2009) around their dash; a figure space (U+2007) turns
 * up too. V8's `format()` hides the narrow one, but its `formatToParts` and `formatRange` don't, and neither do the
 * phones (Hermes wrote "2:30 PM" with U+202F on both). Any of them sends a text as UCS-2, so a phone would show two
 * segments where the server sends one.
 *
 * Every time or date core writes for a person goes through this, so a preview on any engine matches what is sent.
 * Browser-safe.
 */
const INTL_SPACES = /[\u00a0\u2007\u2009\u202f]/g;

/** "2:30 PM" with U+202F becomes "2:30 PM" with a plain space. Nothing else changes. */
export const plainSpaces = (text: string): string => text.replace(INTL_SPACES, ' ');
