/**
 * A form's answers as a spreadsheet (M17): what `form.response_export` sends, as a CSV file any spreadsheet opens.
 * Browser-safe, so the phone and the web build the same file.
 *
 * - **One row per answer sheet**, newest first: when it was answered (in the business's time zone), who, where it came
 *   from, the score on a quiz, then a column per question.
 * - **Opens right in Excel**: a byte-order mark so accents and emoji survive, and CRLF line ends, as RFC 4180 asks.
 * - **Nobody's answer runs as a formula.** A cell a customer typed that starts `=`, `+`, `-` or `@` is a formula to a
 *   spreadsheet (CSV injection), so it is kept as text with a leading apostrophe. A plain number like `-5` is left
 *   alone: it isn't one.
 */
import { zonedParts } from '../calendar/engine/zoned';

/** Where an answer sheet came from, as its column says it. */
export const FORM_SOURCE_LABELS: Readonly<Record<string, string>> = {
  link: 'Link',
  qr: 'QR code',
  embed: 'Website',
  chat: 'Conversation',
  app: 'Phone app',
  api: 'API',
};

export interface AnswersSheet {
  readonly columns: readonly { readonly questionId: string; readonly title: string }[];
  readonly rows: readonly {
    readonly personName: string | null;
    readonly source: string;
    readonly completedAt: string;
    readonly scorePercent: number | null;
    readonly passed: boolean | null;
    readonly answers: Readonly<Record<string, string>>;
  }[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-09-17 10:02": sorts as text, and every spreadsheet reads it as a date and time. */
export function spreadsheetTime(iso: string, timeZone: string): string {
  const p = zonedParts(Date.parse(iso), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** One cell: kept as text if it would run as a formula, and quoted if it holds a comma, a quote or a line break. */
export function csvCell(value: string): string {
  const safe =
    /^[=+\-@\t\r]/.test(value) && !/^[+-]?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The whole file. The score columns are there only when something on it was scored (a quiz). */
export function formAnswersCsv(sheet: AnswersSheet, timeZone: string): string {
  const scored = sheet.rows.some((r) => r.scorePercent !== null);
  const head = [
    'Answered',
    'Name',
    'From',
    ...(scored ? ['Score %', 'Passed'] : []),
    ...sheet.columns.map((c) => c.title),
  ];
  const body = sheet.rows.map((r) => [
    spreadsheetTime(r.completedAt, timeZone),
    r.personName ?? '',
    FORM_SOURCE_LABELS[r.source] ?? r.source,
    ...(scored
      ? [
          r.scorePercent === null ? '' : String(r.scorePercent),
          r.passed === null ? '' : r.passed ? 'Yes' : 'No',
        ]
      : []),
    ...sheet.columns.map((c) => r.answers[c.questionId] ?? ''),
  ]);
  return `\uFEFF${[head, ...body].map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** "job-feedback-answers-2026-09-24.csv": the form's link name and the day, in the business's time zone. */
export function formAnswersFileName(slug: string, now: number, timeZone: string): string {
  const p = zonedParts(now, timeZone);
  const name = slug.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'form';
  return `${name}-answers-${p.year}-${pad(p.month)}-${pad(p.day)}.csv`;
}
