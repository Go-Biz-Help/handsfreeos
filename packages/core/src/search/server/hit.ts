/**
 * What the server's searchers build hits with: the browser-safe helpers in `search/hit.ts`, which the phone's own
 * search shares, and the times the driver gives back. Nothing here reads the database.
 */
export {
  digitsIn,
  fieldHolding,
  fieldSnippet,
  hitOf,
  holdsAll,
  holdsAny,
  listedValues,
  stretchSnippet,
  wordsLeft,
} from '../hit';

/** An ISO time from what the driver gives back, or null. */
export const isoOf = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;
