/**
 * Files sent with a question, made ready for the model (docs/operations.md, "Pictures and files sent to the
 * Assistant"). A PDF goes as it is, pages and all, so the model sees its layout, tables and handwriting; a long one is
 * cut to its first pages. A Word file's paragraphs and tables, a spreadsheet's rows and a text file's words are read
 * out here and go as text. Nothing is kept: like pictures, the model reads them with this one question.
 *
 * Word and Excel files are zip files of XML. They're read here with Node's own zlib and a small scanner that walks
 * the XML once from start to end, so a file made to be slow or huge can't hold the worker up: each part's size is
 * capped before and while it's unpacked.
 */
import { inflateRawSync } from 'node:zlib';
import {
  ASSISTANT_DOCX_TYPE,
  ASSISTANT_XLSX_TYPE,
  HfosError,
  type AssistantFile,
} from '@hfos/core/server';
import type { AiContent } from '@hfos/ai';
import { PDFDocument } from 'pdf-lib';

/** The most pages of PDF one question shows the model, all its PDFs together: each page costs about 2,500 tokens. */
export const ASSISTANT_PDF_PAGES = 40;
/** The most characters of words read out of one file. About 15,000 tokens. */
export const ASSISTANT_FILE_TEXT = 60_000;
/** The most a Word or Excel file's parts may come to once unpacked: room for a long price list, not a zip bomb. */
const UNPACKED_MAX = 40 * 1024 * 1024;
/** The most rows read from one sheet of a spreadsheet. */
const SHEET_ROWS = 3_000;

/** A file as the model is shown it. */
export type AssistantModelFile =
  | {
      readonly kind: 'pdf';
      readonly name: string;
      /** Base64 of the PDF it sees: the one sent, or its first pages. */
      readonly data: string;
      readonly pages: number;
      /** How many pages the PDF sent had, when only the first `pages` go. */
      readonly of?: number;
    }
  | {
      readonly kind: 'text';
      readonly name: string;
      readonly text: string;
      /** Only the start was kept: the file has more. */
      readonly cut: boolean;
    };

const unreadable = (name: string, why = 'couldn’t be opened') =>
  HfosError.rule(
    'file_unreadable',
    400,
    `${name} ${why}. Open it on your computer to check it, or save it as a PDF and send that.`,
  );

/**
 * Each file sent with a question, ready for the model. One that can't be read refuses the question before anything
 * is asked, so nothing is half-read, and the refusal names the file.
 */
export async function filesForModel(
  files: readonly AssistantFile[],
): Promise<AssistantModelFile[]> {
  const out: AssistantModelFile[] = [];
  let pagesLeft = ASSISTANT_PDF_PAGES;
  for (const file of files) {
    const bytes = Buffer.from(file.data, 'base64');
    if (!bytes.length) throw unreadable(file.name, 'is empty');
    if (file.mediaType === 'application/pdf') {
      const pdf = await pdfForModel(file.name, bytes, pagesLeft);
      pagesLeft -= pdf.pages;
      out.push(pdf);
      continue;
    }
    let text: string;
    try {
      text =
        file.mediaType === ASSISTANT_DOCX_TYPE
          ? docxText(bytes)
          : file.mediaType === ASSISTANT_XLSX_TYPE
            ? xlsxText(bytes)
            : plainText(bytes);
    } catch (e) {
      if (e instanceof HfosError) throw e;
      throw unreadable(file.name);
    }
    text = text.trim();
    if (!text) throw unreadable(file.name, 'has no words in it to read');
    const cut = text.length > ASSISTANT_FILE_TEXT;
    out.push({
      kind: 'text',
      name: file.name,
      text: cut ? text.slice(0, ASSISTANT_FILE_TEXT) : text,
      cut,
    });
  }
  return out;
}

async function pdfForModel(
  name: string,
  bytes: Buffer,
  pagesLeft: number,
): Promise<Extract<AssistantModelFile, { kind: 'pdf' }>> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof Error && /encrypt/i.test(e.message))
      throw HfosError.rule(
        'file_unreadable',
        400,
        `${name} is locked with a password, so it can’t be read. Save a copy without the password and send that.`,
      );
    throw unreadable(name);
  }
  const total = doc.getPageCount();
  if (!total) throw unreadable(name, 'has no pages');
  if (pagesLeft <= 0)
    throw HfosError.rule(
      'files_too_long',
      400,
      `The PDFs sent with this question come to more than ${ASSISTANT_PDF_PAGES} pages, which is the most the Assistant reads at once. Send ${name} with its own question.`,
    );
  if (total <= pagesLeft)
    return { kind: 'pdf', name, data: bytes.toString('base64'), pages: total };
  // Only its first pages go: a new PDF with copies of them.
  const first = await PDFDocument.create();
  const pages = await first.copyPages(
    doc,
    Array.from({ length: pagesLeft }, (_, i) => i),
  );
  for (const p of pages) first.addPage(p);
  const data = Buffer.from(await first.save()).toString('base64');
  return { kind: 'pdf', name, data, pages: pagesLeft, of: total };
}

/** What the model is shown for a file, before the question's words. */
export function fileContent(file: AssistantModelFile): AiContent[] {
  if (file.kind === 'pdf')
    return [
      {
        type: 'document',
        mediaType: 'application/pdf',
        data: file.data,
        title: file.name,
        pages: file.pages,
      },
      ...(file.of
        ? [
            {
              type: 'text' as const,
              text: `(Only the first ${file.pages} of the ${file.of} pages of ${file.name} came through.)`,
            },
          ]
        : []),
    ];
  return [
    {
      type: 'text',
      text: `--- The file ${file.name}${file.cut ? ' (only its start: it goes on)' : ''} ---\n${file.text}\n--- End of ${file.name} ---`,
    },
  ];
}

// ---------- plain text ----------

/** A text file's words: UTF-8 (a byte-order mark dropped), or Windows' Latin-1 when it isn't UTF-8. */
export function plainText(bytes: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  const broken = (utf8.match(/\uFFFD/g) ?? []).length;
  return broken > 8 && broken > utf8.length / 200 ? bytes.toString('latin1') : utf8;
}

// ---------- zip ----------

/**
 * The parts of a zip file whose names `want` picks, unpacked. Reads the central directory at the end, so a part's
 * size is known before it's unpacked, and caps what all of them come to together (UNPACKED_MAX).
 */
export function unzip(bytes: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const end = endOfDirectory(bytes);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const parts = new Map<string, Buffer>();
  let unpacked = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50)
      throw new Error('Not a zip file');
    const method = bytes.readUInt16LE(at + 10);
    const packed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (!want(name)) continue;
    if (size === 0xffffffff || packed === 0xffffffff) throw new Error('Too big');
    unpacked += size;
    if (unpacked > UNPACKED_MAX) throw new Error('Too big');
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
      throw new Error('Not a zip file');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + packed);
    if (data.length !== packed) throw new Error('Cut short');
    if (method === 0) parts.set(name, Buffer.from(data));
    else if (method === 8)
      // The size the directory gives is checked again as it unpacks: a part can't come to more than it says.
      parts.set(name, inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }));
    else throw new Error('Packed a way this can’t read');
  }
  return parts;
}

function endOfDirectory(bytes: Buffer): number {
  // The end record is 22 bytes, after which a comment of up to 65,535 bytes may follow.
  const last = Math.max(0, bytes.length - 22 - 65_535);
  for (let i = bytes.length - 22; i >= last; i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  throw new Error('Not a zip file');
}

// ---------- XML ----------

interface Tag {
  /** The tag's name, like "w:t". */
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  /** Everything after the name, for `attr`. */
  readonly rest: string;
}

/**
 * Walks XML once, start to end, handing each tag and each run of text between tags to `on`. Comments, declarations
 * and processing instructions are skipped. No regular expressions, so nothing in a file can make it slow.
 */
export function walkXml(xml: string, on: (tag: Tag | null, text: string) => void): void {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      on(null, decodeXml(xml.slice(i)));
      return;
    }
    if (lt > i) on(null, decodeXml(xml.slice(i, lt)));
    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt + 4);
      i = close < 0 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      on(null, xml.slice(lt + 9, close < 0 ? xml.length : close));
      i = close < 0 ? xml.length : close + 3;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) return;
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('?') || body.startsWith('!')) continue;
    const closing = body.startsWith('/');
    const selfClosing = body.endsWith('/');
    const inner = body.slice(closing ? 1 : 0, selfClosing ? -1 : undefined);
    let n = 0;
    while (n < inner.length && !isSpace(inner.charCodeAt(n))) n++;
    on({ name: inner.slice(0, n), closing, selfClosing, rest: inner.slice(n) }, '');
  }
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/** One attribute's value on a tag, decoded, or null. Scanned by hand, like the tags. */
export function attr(tag: Tag, name: string): string | null {
  const s = tag.rest;
  let i = 0;
  while (i < s.length) {
    while (i < s.length && isSpace(s.charCodeAt(i))) i++;
    const eq = s.indexOf('=', i);
    if (eq < 0) return null;
    const key = s.slice(i, eq).trim();
    let q = eq + 1;
    while (q < s.length && isSpace(s.charCodeAt(q))) q++;
    const quote = s[q];
    if (quote !== '"' && quote !== "'") return null;
    const close = s.indexOf(quote, q + 1);
    if (close < 0) return null;
    if (key === name) return decodeXml(s.slice(q + 1, close));
    i = close + 1;
  }
  return null;
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** XML's &…; spelled-out characters, put back. */
export function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    const semi = s.indexOf(';', amp + 1);
    if (semi < 0 || semi - amp > 10) {
      out += '&';
      i = amp + 1;
      continue;
    }
    const name = s.slice(amp + 1, semi);
    let ch: string | undefined = NAMED[name];
    if (!ch && name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      ch =
        Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : undefined;
    }
    if (ch === undefined) {
      out += '&';
      i = amp + 1;
      continue;
    }
    out += ch;
    i = semi + 1;
  }
  return out;
}

// ---------- Word ----------

/**
 * A Word file's words, in order: each paragraph on its own line, and each table row on one line with its cells
 * between bars, so a price list made as a table keeps each item with its price. Headers, footers and notes aren't
 * read.
 */
export function docxText(bytes: Buffer): string {
  const xml = unzip(bytes, (n) => n === 'word/document.xml').get('word/document.xml');
  if (!xml) throw new Error('No document in it');
  const lines: string[] = [];
  let line = '';
  let cells: string[] | null = null;
  let tables = 0;
  let inText = false;
  const endLine = () => {
    const t = line.trimEnd();
    if (t || lines[lines.length - 1]) lines.push(t);
    line = '';
  };
  walkXml(xml.toString('utf8'), (tag, text) => {
    if (!tag) {
      if (inText) line += text;
      return;
    }
    switch (tag.name) {
      case 'w:t':
        inText = !tag.closing && !tag.selfClosing;
        break;
      case 'w:tab':
        if (!tag.closing) line += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        if (!tag.closing) line += tables ? ' ' : '\n';
        break;
      case 'w:p':
        // A paragraph inside a table cell runs on in the cell; elsewhere it ends the line.
        if (tag.closing && !tables) endLine();
        else if (tag.closing && line && !line.endsWith(' ')) line += ' ';
        break;
      case 'w:tbl':
        if (tag.closing) tables = Math.max(0, tables - 1);
        else if (!tag.selfClosing) tables++;
        break;
      case 'w:tr':
        if (tables > 1) break;
        if (!tag.closing) {
          if (line.trim()) endLine();
          line = '';
          cells = [];
        } else if (cells) {
          while (cells.length && !cells[cells.length - 1]) cells.pop();
          if (cells.length) lines.push(cells.join(' | '));
          cells = null;
          line = '';
        }
        break;
      case 'w:tc':
        if (tables > 1) break;
        if (tag.closing && cells) {
          cells.push(line.trim());
          line = '';
        }
        break;
    }
  });
  if (line.trim()) endLine();
  return lines.join('\n');
}

// ---------- Excel ----------

/** A column's letters (A, B… AA) as a number from 0. */
const column = (ref: string) => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

/**
 * A spreadsheet's sheets, each under its name, a row a line with its cells between bars. Words shared between cells
 * are looked up; a formula shows what it last worked out to. Dates show as Excel keeps them (a day number), and the
 * model is told so.
 */
export function xlsxText(bytes: Buffer): string {
  const parts = unzip(
    bytes,
    (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      (n.startsWith('xl/worksheets/') && n.endsWith('.xml')),
  );
  const workbook = parts.get('xl/workbook.xml');
  if (!workbook) throw new Error('No workbook in it');

  const shared: string[] = [];
  const strings = parts.get('xl/sharedStrings.xml');
  if (strings) {
    let item: string | null = null;
    let inText = false;
    let phonetic = false;
    walkXml(strings.toString('utf8'), (tag, text) => {
      if (!tag) {
        if (item !== null && inText && !phonetic) item += text;
        return;
      }
      if (tag.name === 'si') {
        if (!tag.closing) item = '';
        if (tag.closing || tag.selfClosing) {
          shared.push(item ?? '');
          item = null;
        }
      } else if (tag.name === 't') inText = !tag.closing && !tag.selfClosing;
      else if (tag.name === 'rPh') phonetic = !tag.closing && !tag.selfClosing;
    });
  }

  const targets = new Map<string, string>();
  const rels = parts.get('xl/_rels/workbook.xml.rels');
  if (rels)
    walkXml(rels.toString('utf8'), (tag) => {
      if (tag?.name !== 'Relationship' || tag.closing) return;
      const id = attr(tag, 'Id');
      const target = attr(tag, 'Target');
      if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    });

  const sheets: { name: string; path: string }[] = [];
  walkXml(workbook.toString('utf8'), (tag) => {
    if (tag?.name !== 'sheet' || tag.closing) return;
    const id = attr(tag, 'r:id');
    const path = id ? targets.get(id) : undefined;
    if (path) sheets.push({ name: attr(tag, 'name') ?? 'Sheet', path });
  });
  if (!sheets.length)
    for (const path of parts.keys())
      if (path.startsWith('xl/worksheets/')) sheets.push({ name: 'Sheet', path });

  const out: string[] = [];
  let chars = 0;
  for (const sheet of sheets) {
    const xml = parts.get(sheet.path);
    if (!xml || chars > ASSISTANT_FILE_TEXT) continue;
    const rows = sheetRows(xml.toString('utf8'), shared);
    if (!rows.length) continue;
    const text = [`Sheet “${sheet.name}”:`, ...rows].join('\n');
    chars += text.length;
    out.push(text);
  }
  return out.join('\n\n');
}

function sheetRows(xml: string, shared: readonly string[]): string[] {
  const rows: string[] = [];
  let cells: string[] | null = null;
  let col = 0;
  let type = '';
  let value: string | null = null;
  let reading = false;
  walkXml(xml, (tag, text) => {
    if (!tag) {
      if (reading && value !== null) value += text;
      return;
    }
    if (rows.length >= SHEET_ROWS) return;
    switch (tag.name) {
      case 'row':
        if (!tag.closing) cells = [];
        if ((tag.closing || tag.selfClosing) && cells) {
          while (cells.length && !cells[cells.length - 1]) cells.pop();
          if (cells.length) rows.push(cells.join(' | '));
          cells = null;
        }
        break;
      case 'c':
        if (!tag.closing) {
          const ref = attr(tag, 'r');
          col = ref ? column(ref) : (cells?.length ?? 0);
          type = attr(tag, 't') ?? '';
          value = '';
        }
        if ((tag.closing || tag.selfClosing) && cells && col >= 0 && col < 200) {
          let shown = value ?? '';
          if (type === 's') shown = shared[Number(shown)] ?? '';
          else if (type === 'b') shown = shown === '1' ? 'TRUE' : shown === '0' ? 'FALSE' : shown;
          while (cells.length < col) cells.push('');
          cells[col] = shown.replace(/\s+/g, ' ').trim();
          value = null;
        }
        break;
      case 'v':
      case 't':
        reading = !tag.closing && !tag.selfClosing;
        break;
    }
  });
  return rows;
}
