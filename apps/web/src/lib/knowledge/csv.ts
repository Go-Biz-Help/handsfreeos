import Papa from 'papaparse';

/**
 * FAQs from a spreadsheet: question, answer and (optionally) tags. A header row naming the columns is
 * optional; without one the first three columns are question, answer, tags. Each row is checked against the
 * same limits as the knowledge base, so the preview shows problems before anything is imported.
 */

export const FAQ_IMPORT_MAX_ROWS = 500;
const MAX_QUESTION = 300;
const MAX_ANSWER = 5000;
const MAX_TAG = 40;
const MAX_TAGS = 20;

export interface FaqCsvRow {
  /** The row as a spreadsheet numbers it (the header, when there is one, is row 1). */
  readonly line: number;
  readonly question: string;
  readonly answer: string;
  readonly tags: readonly string[];
  readonly problems: readonly string[];
}

export interface FaqCsv {
  readonly rows: readonly FaqCsvRow[];
  /** A problem with the whole file (nothing to import, too many rows). */
  readonly error: string | null;
}

const QUESTION = ['question', 'questions', 'q', 'faq'];
const ANSWER = ['answer', 'answers', 'a', 'response'];
const TAGS = ['tags', 'tag', 'labels', 'categories', 'category'];

const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** "Financing; New systems" → ["Financing", "New systems"], each tag once. */
export function splitTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw.split(/[;,|]/)) {
    const tag = clean(t);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** The byte-order mark some spreadsheets put at the start of a CSV. */
const BOM = 0xfeff;

export function parseFaqCsv(raw: string): FaqCsv {
  const text = raw.charCodeAt(0) === BOM ? raw.slice(1) : raw;
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  const table = parsed.data.filter((r) => Array.isArray(r) && r.some((c) => clean(c)));
  if (!table.length) return { rows: [], error: 'That file has no rows to import.' };
  const head = table[0]!.map((c) => clean(c).toLowerCase());
  const col = (names: readonly string[]) => head.findIndex((h) => names.includes(h));
  const hasHeader = col(QUESTION) >= 0 && col(ANSWER) >= 0;
  const q = hasHeader ? col(QUESTION) : 0;
  const a = hasHeader ? col(ANSWER) : 1;
  const t = hasHeader ? col(TAGS) : 2;
  const body = hasHeader ? table.slice(1) : table;
  if (!body.length) return { rows: [], error: 'That file has a header but no FAQs under it.' };
  if (body.length > FAQ_IMPORT_MAX_ROWS)
    return {
      rows: [],
      error: `That file has ${body.length.toLocaleString()} rows. Import at most ${FAQ_IMPORT_MAX_ROWS} at a time.`,
    };
  const rows = body.map((r, i): FaqCsvRow => {
    const question = clean(r[q]);
    const answer = typeof r[a] === 'string' ? r[a].trim() : '';
    const tags = t >= 0 ? splitTags(typeof r[t] === 'string' ? r[t] : '') : [];
    const problems: string[] = [];
    if (!question) problems.push('The question is missing.');
    else if (question.length > MAX_QUESTION)
      problems.push(`The question is over ${MAX_QUESTION} characters.`);
    if (!answer) problems.push('The answer is missing.');
    else if (answer.length > MAX_ANSWER)
      problems.push(`The answer is over ${MAX_ANSWER.toLocaleString()} characters.`);
    if (tags.some((tag) => tag.length > MAX_TAG))
      problems.push(`A tag is over ${MAX_TAG} characters.`);
    if (tags.length > MAX_TAGS) problems.push(`There are more than ${MAX_TAGS} tags.`);
    return { line: i + (hasHeader ? 2 : 1), question, answer, tags, problems };
  });
  return { rows, error: null };
}
