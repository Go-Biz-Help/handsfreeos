/**
 * Files the Assistant makes (the owner, 25 Nov 2026: "a spreadsheet or PDF report to download or email"): a table of
 * what the person can see, as an Excel sheet, a CSV or a PDF, with a title, a line or two above it, and totals.
 * Browser-safe: the cells and their words are worked out here once, and the worker draws each format from them.
 *
 * - **Where the rows come from.** Either a screen's own look-up, run again as the person for every page of it (so
 *   "all my customers" is all of them, up to FILE_ROWS_MAX), with each column a path into its rows; or rows the
 *   Assistant wrote itself from what it looked up (a summary, a short report), up to GIVEN_ROWS_MAX.
 * - **Cells keep their kind.** Money stays a number with a dollar format, a date stays a date, so the sheet sorts and
 *   adds up. A CSV writes plain numbers and dates a spreadsheet reads. Nothing anyone typed runs as a formula.
 * - **The person's own.** Only they can open it, for FILE_KEEP_DAYS; then it's gone and they ask again.
 */
import { isLocalDate, zonedParts } from '../calendar/engine/zoned';
import { money } from '../money/format';
import { csvCell } from '../forms/export';

export const FILE_FORMAT_IDS = ['excel', 'csv', 'pdf'] as const;
export type FileFormat = (typeof FILE_FORMAT_IDS)[number];

export const FILE_FORMATS: Readonly<
  Record<FileFormat, { readonly ext: string; readonly mime: string; readonly label: string }>
> = {
  excel: {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel',
  },
  csv: { ext: 'csv', mime: 'text/csv', label: 'CSV' },
  pdf: { ext: 'pdf', mime: 'application/pdf', label: 'PDF' },
};

/** What a column's values are, so each format writes them right. Unsaid: worked out from the values. */
export const CELL_KINDS = [
  'text',
  'number',
  'dollars',
  'cents',
  'date',
  'datetime',
  'yesno',
] as const;
export type CellKind = (typeof CELL_KINDS)[number];

/** Rows read from a look-up, at most: enough for every customer of a small business, small enough to send. */
export const FILE_ROWS_MAX = 5_000;
/** Rows the Assistant writes itself, at most: a report, not a copy of a list. */
export const GIVEN_ROWS_MAX = 500;
export const FILE_COLUMNS_MAX = 30;
/** A PDF page holds this many columns, landscape, before they're too narrow to read. */
export const PDF_COLUMNS_MAX = 10;
/** How long the person can open it from the chat. */
export const FILE_KEEP_DAYS = 30;
/** The longest cell kept: a note or a message, not a whole email thread. */
const CELL_TEXT_MAX = 2_000;

export type FileCell =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'number'; readonly n: number }
  | { readonly kind: 'money'; readonly cents: number }
  /** A day on the calendar, the same wherever it's opened. */
  | { readonly kind: 'date'; readonly y: number; readonly m: number; readonly d: number }
  /** A moment, shown on the business's clock. */
  | { readonly kind: 'datetime'; readonly at: number };

export interface FileColumnSpec {
  readonly label: string;
  /** Into each row of a look-up: "fullName", "person.fullName", "lines.0.name". */
  readonly path?: string;
  readonly as?: CellKind;
  /** Add the column up under the last row (numbers and money). */
  readonly total?: boolean;
}

export interface FileTable {
  readonly title: string;
  /** Lines above the table: what it covers, the totals in words. */
  readonly intro: readonly string[];
  readonly columns: readonly { readonly label: string; readonly total: boolean }[];
  readonly rows: readonly (readonly FileCell[])[];
  /** Under the last row, for the columns that add up; null when none does. */
  readonly totals: readonly FileCell[] | null;
}

const EMPTY: FileCell = { kind: 'empty' };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** The value at a dot path in one row: "person.fullName", "lines.0.name". */
export function valueAt(row: unknown, path: string): unknown {
  let at: unknown = row;
  for (const key of path.split('.')) {
    if (at === null || at === undefined) return undefined;
    if (Array.isArray(at)) at = /^\d+$/.test(key) ? at[Number(key)] : undefined;
    else if (typeof at === 'object') at = (at as Record<string, unknown>)[key];
    else return undefined;
  }
  return at;
}

const isRow = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The list in a look-up's answer: the answer itself when it's one, else its `items`, else the first list of rows it
 * holds (one level in: `{ customers: [...] }`, `{ page: { rows: [...] } }`). Null when it holds none.
 */
export function listOf(answer: unknown): Record<string, unknown>[] | null {
  const rowsIn = (v: unknown) => (Array.isArray(v) && v.every(isRow) ? v : null);
  const direct = rowsIn(answer);
  if (direct) return direct;
  if (!isRow(answer)) return null;
  const items = rowsIn(answer['items']);
  if (items) return items;
  for (const v of Object.values(answer)) {
    const found = Array.isArray(v) && v.length > 0 ? rowsIn(v) : null;
    if (found) return found;
  }
  for (const v of Object.values(answer)) {
    if (!isRow(v)) continue;
    for (const inner of Object.values(v)) {
      const found = Array.isArray(inner) && inner.length > 0 ? rowsIn(inner) : null;
      if (found) return found;
    }
  }
  // An answer whose list is empty this time: an empty list is still the list.
  for (const v of Object.values(answer)) if (Array.isArray(v) && v.length === 0) return [];
  return null;
}

const clip = (s: string) => (s.length > CELL_TEXT_MAX ? `${s.slice(0, CELL_TEXT_MAX - 1)}…` : s);

/** A name for a thing a look-up nests: a customer, a teammate, a stage. */
function nameOfThing(v: Record<string, unknown>): string | null {
  for (const key of [
    'fullName',
    'name',
    'customer_wrote',
    'title',
    'label',
    'displayName',
    'email',
    'number',
  ]) {
    const s = v[key];
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  return null;
}

const numberOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return v.trim() && Number.isFinite(n) ? n : null;
  }
  return null;
};

function dayOf(v: unknown, timeZone: string): FileCell {
  if (typeof v === 'string' && ISO_DAY.test(v.trim()) && isLocalDate(v.trim())) {
    const [y, m, d] = v.trim().split('-').map(Number) as [number, number, number];
    return { kind: 'date', y, m, d };
  }
  const at = momentOf(v);
  if (at === null) return textOf(v);
  const p = zonedParts(at, timeZone);
  return { kind: 'date', y: p.year, m: p.month, d: p.day };
}

function momentOf(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 1e11) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!ISO_MOMENT.test(s) && !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return null;
    const at = Date.parse(s);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

function textOf(v: unknown): FileCell {
  if (v === null || v === undefined) return EMPTY;
  if (typeof v === 'string') return v.trim() ? { kind: 'text', text: clip(v.trim()) } : EMPTY;
  if (typeof v === 'boolean') return { kind: 'text', text: v ? 'Yes' : 'No' };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'number', n: v } : EMPTY;
  if (Array.isArray(v)) {
    const parts = v
      .map((x) => (isRow(x) ? nameOfThing(x) : typeof x === 'object' ? null : String(x)))
      .filter((x): x is string => !!x && x.trim() !== '');
    return parts.length ? { kind: 'text', text: clip(parts.join(', ')) } : EMPTY;
  }
  if (isRow(v)) {
    const name = nameOfThing(v);
    return name ? { kind: 'text', text: clip(name) } : EMPTY;
  }
  return { kind: 'text', text: clip(String(v)) };
}

/** One value as its column keeps it. */
export function cellOf(value: unknown, as: CellKind | undefined, timeZone: string): FileCell {
  if (value === null || value === undefined || value === '') return EMPTY;
  switch (as) {
    case 'text':
      return typeof value === 'number' ? { kind: 'text', text: String(value) } : textOf(value);
    case 'number': {
      const n = numberOf(value);
      return n === null ? textOf(value) : { kind: 'number', n };
    }
    case 'dollars': {
      const n = numberOf(value);
      return n === null ? textOf(value) : { kind: 'money', cents: Math.round(n * 100) };
    }
    case 'cents': {
      const n = numberOf(value);
      return n === null ? textOf(value) : { kind: 'money', cents: Math.round(n) };
    }
    case 'date':
      return dayOf(value, timeZone);
    case 'datetime': {
      const at = momentOf(value);
      return at === null ? dayOf(value, timeZone) : { kind: 'datetime', at };
    }
    case 'yesno':
      if (typeof value === 'boolean') return { kind: 'text', text: value ? 'Yes' : 'No' };
      return textOf(value);
    default: {
      // Unsaid: a day, a moment, or what the value is.
      if (typeof value === 'string' && ISO_DAY.test(value.trim())) return dayOf(value, timeZone);
      const at =
        typeof value === 'string' && ISO_MOMENT.test(value.trim()) ? momentOf(value) : null;
      return at === null ? textOf(value) : { kind: 'datetime', at };
    }
  }
}

const addsUp = (c: FileCell) => c.kind === 'number' || c.kind === 'money';

/**
 * The table: each column read from the look-up's rows by its path, or the Assistant's own rows cell by cell. Totals
 * under the columns asked to add up, in money when the column is money.
 */
export function buildFileTable(
  input: {
    readonly title: string;
    readonly intro?: readonly string[];
    readonly columns: readonly FileColumnSpec[];
    /** From a look-up: each row an object the paths read. */
    readonly records?: readonly unknown[];
    /** Written by the Assistant: each row its cells in column order. */
    readonly given?: readonly (readonly unknown[])[];
  },
  timeZone: string,
): FileTable {
  const { columns } = input;
  const rows: FileCell[][] = input.records
    ? input.records.map((r) =>
        columns.map((c) => cellOf(c.path ? valueAt(r, c.path) : undefined, c.as, timeZone)),
      )
    : (input.given ?? []).map((r) => columns.map((c, i) => cellOf(r[i], c.as, timeZone)));
  const wanted = columns.map((c) => c.total === true);
  const totals = wanted.some(Boolean)
    ? columns.map((_, i) => {
        if (!wanted[i]) return EMPTY;
        const cells = rows.map((r) => r[i]!).filter(addsUp);
        if (!cells.length) return EMPTY;
        if (cells.some((c) => c.kind === 'money'))
          return {
            kind: 'money' as const,
            cents: cells.reduce(
              (s, c) =>
                s +
                (c.kind === 'money' ? c.cents : Math.round(c.kind === 'number' ? c.n * 100 : 0)),
              0,
            ),
          };
        return {
          kind: 'number' as const,
          n: Math.round(cells.reduce((s, c) => s + (c.kind === 'number' ? c.n : 0), 0) * 100) / 100,
        };
      })
    : null;
  return {
    title: input.title.trim(),
    intro: (input.intro ?? []).map((l) => l.trim()).filter(Boolean),
    columns: columns.map((c, i) => ({ label: c.label.trim(), total: wanted[i]! })),
    rows,
    totals,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const numberWords = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function clockWords(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** A cell as a person reads it, on a PDF or in the chat: "$1,250.50", "Nov 25, 2026", "Nov 25, 2026, 3:00 PM". */
export function cellWords(cell: FileCell, timeZone: string): string {
  switch (cell.kind) {
    case 'empty':
      return '';
    case 'text':
      return cell.text;
    case 'number':
      return numberWords.format(cell.n);
    case 'money':
      return money(cell.cents);
    case 'date':
      return `${MONTHS[cell.m - 1]} ${cell.d}, ${cell.y}`;
    case 'datetime': {
      const p = zonedParts(cell.at, timeZone);
      return `${MONTHS[p.month - 1]} ${p.day}, ${p.year}, ${clockWords(p.hour, p.minute)}`;
    }
  }
}

/** A cell as a CSV keeps it: plain numbers and dates a spreadsheet reads ("1250.50", "2026-11-25 15:00"). */
function csvValue(cell: FileCell, timeZone: string): string {
  switch (cell.kind) {
    case 'money':
      return (cell.cents / 100).toFixed(2);
    case 'number':
      return String(cell.n);
    case 'date':
      return `${cell.y}-${pad(cell.m)}-${pad(cell.d)}`;
    case 'datetime': {
      const p = zonedParts(cell.at, timeZone);
      return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
    }
    default:
      return cellWords(cell, timeZone);
  }
}

/** The whole CSV: a byte-order mark so Excel keeps accents, CRLF line ends, and a Total row when there is one. */
export function fileTableCsv(table: FileTable, timeZone: string): string {
  const lines = [
    table.columns.map((c) => c.label),
    ...table.rows.map((r) => r.map((c) => csvValue(c, timeZone))),
    ...(table.totals
      ? [
          table.totals.map((c, i) =>
            i === 0 && c.kind === 'empty' ? 'Total' : csvValue(c, timeZone),
          ),
        ]
      : []),
  ];
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** "Who owes money 2026-11-25.xlsx": the title, kept to what every computer allows in a name, and the day. */
export function fileNameOf(
  title: string,
  format: FileFormat,
  now: number,
  timeZone: string,
): string {
  const p = zonedParts(now, timeZone);
  const base =
    title
      .replace(/[\\/:*?"<>|#%&{}$!'`@+=~^]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .trim() || 'Report';
  return `${base} ${p.year}-${pad(p.month)}-${pad(p.day)}.${FILE_FORMATS[format].ext}`;
}

/** The card's second line: "Excel · 42 rows · Kept 30 days". */
export function fileDetail(format: FileFormat, rows: number): string {
  return `${FILE_FORMATS[format].label} · ${rows === 1 ? '1 row' : `${numberWords.format(rows)} rows`} · Kept ${FILE_KEEP_DAYS} days`;
}
