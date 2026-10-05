import type { KnowledgeDocumentNote } from '@hfos/core/server';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * A document's words, for anything in the worker that reads an uploaded file: the knowledge base's documents, and
 * an add-on's (Real Estate round four: a contract). Text files are read as they are; PDFs with unpdf (MIT, on
 * Mozilla's pdf.js). A PDF with no text in it (a scan) gives no words and the note `no_text`. The words are data,
 * never instructions. How big a file may be is the caller's to decide, before downloading it.
 */

/** The most characters kept from one document. */
export const DOCUMENT_TEXT_CHARS = 100_000;

export interface DocumentText {
  readonly text: string;
  readonly note: KnowledgeDocumentNote | null;
}

/** A PDF's words page by page (the first page is `pages[0]`), and how many pages it has. */
export interface PdfPages {
  readonly pages: readonly string[];
  readonly total: number;
}

/** Keeps tabs and new lines; drops other control characters (Postgres text can't hold NUL). */
function dropControls(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || (c >= 32 && c !== 127)) out += ch;
  }
  return out;
}

/** Whether "text" is mostly binary (control characters or undecodable bytes). */
function looksBinary(s: string): boolean {
  if (!s) return false;
  let odd = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) odd++;
  }
  return odd / s.length > 0.05;
}

/** Plain lines: Windows line ends, control characters, trailing spaces and runs of blank lines gone. */
function tidy(raw: string): string {
  return dropControls(raw.replace(/\r\n?/g, '\n'))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A PDF's words, page by page, through pdf.js. Null when it isn't a PDF pdf.js can open. */
export async function pdfPages(data: Uint8Array): Promise<PdfPages | null> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    try {
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      return { pages: text.map(tidy), total: totalPages };
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch {
    return null;
  }
}

/** A document's text: text files as written (UTF-8), PDFs through pdf.js, `chars` at most. */
export async function documentText(
  data: Uint8Array,
  kind: 'pdf' | 'text',
  chars: number = DOCUMENT_TEXT_CHARS,
): Promise<DocumentText> {
  let raw: string;
  if (kind === 'pdf') {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      try {
        raw = (await extractText(pdf, { mergePages: true })).text;
      } finally {
        await pdf.loadingTask.destroy();
      }
    } catch {
      return { text: '', note: 'unreadable' };
    }
  } else {
    raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      .toString('utf8')
      .replace(/^\uFEFF/, '');
    if (looksBinary(raw.slice(0, 20_000))) return { text: '', note: 'unreadable' };
  }
  // Cleaning is linear; cut well past the limit first so a huge file costs little.
  const text = tidy(raw.slice(0, chars * 2));
  if (!text) return { text: '', note: 'no_text' };
  if (text.length > chars || raw.length > chars * 2)
    return { text: text.slice(0, chars), note: 'truncated' };
  return { text, note: null };
}
