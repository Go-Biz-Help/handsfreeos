/**
 * An add-on's rows as a phone holds them (`addon_phone_rows`, records_v1; apps/sync/README.md): each row's id is
 * `<source>:<the row's key>`, and `data` its kept columns as JSON text. Every synced column arrives as text, an
 * integer or nothing, and a JSON column's times are Postgres's. Any add-on's phone views read their rows through these,
 * so the cells are read one way everywhere (Real Estate's `views/synced.ts`, Social Outreach's `views/waiting.ts`).
 *
 * Browser-safe and pure.
 */

/** Every synced column reads as text, an integer or nothing. */
export type Cell = string | number | null | undefined;

/** One of an add-on's rows (`addon_phone_rows`): `id` is `<source>:<the row's key>`, `data` its columns as JSON. */
export interface SyncedPhoneRow {
  readonly id: Cell;
  readonly source: Cell;
  readonly record_id: Cell;
  readonly data: Cell;
}

/** A cell as text: nothing for null, undefined or empty. */
export const cellText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
};

/** A time as milliseconds: PowerSync's "2026-10-03 14:31:03.785Z", Postgres's "…+00", or JSON's "…T…+00:00". */
export const cellMs = (v: unknown): number | null => {
  const s = cellText(v);
  if (!s) return null;
  const t = Date.parse(s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(t) ? null : t;
};

/** A JSON cell, parsed; nothing when it isn't JSON. */
export const cellJson = (v: Cell): unknown => {
  const s = cellText(v);
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};

/** A JSON cell holding an object (a row's `data`): its fields, or none. */
export const cellObject = (v: Cell): Record<string, unknown> => {
  const parsed = cellJson(v);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

/** The row's own key, after `<source>:`. */
export const rowKey = (id: Cell): string => {
  const s = cellText(id) ?? '';
  return s.slice(s.indexOf(':') + 1);
};
