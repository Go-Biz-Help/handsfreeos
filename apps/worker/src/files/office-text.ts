/**
 * The words in a Word (.docx) or Excel (.xlsx) file, for search (Search 5). A .docx or .xlsx is a zip of XML parts,
 * and Node has the raw inflate a zip needs, so this reads them with no library to pin, as the worker's zip writer is
 * made (./zip.ts).
 *
 * It's handed whatever a person uploaded, so:
 * - **The zip is checked before anything is inflated**: its end record, then its central directory. No zip64, no
 *   encrypted entry, no method but stored (0) or deflate (8), and 2,000 entries at most.
 * - **Only the parts that hold words are inflated**: `word/document.xml`; `xl/sharedStrings.xml` and each sheet, in
 *   the workbook's order. Each at most 20 MB inflated and 50 MB in all, and never one that says it grows more than
 *   200 times, so a zip made to blow up is refused before it costs anything.
 * - **The words stop at 200,000 characters**, across every part, as they're built: each cell repeats the shared
 *   string it points at, so a small workbook could otherwise make words without end.
 * - **XML is read with a small tag scanner** that decodes the five named entities and numeric ones, and nothing else:
 *   never an XML library, which would expand entities a document declares.
 *
 * The words are data, never instructions, and never sent to a model.
 */
import { inflateRawSync } from 'node:zlib';

export const OFFICE_LIMITS = {
  entries: 2_000,
  partBytes: 20 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  ratio: 200,
  /** The most characters of words built from one file: twice the 100,000 kept, so tidying them leaves enough. */
  chars: 200_000,
} as const;

/**
 * A Word document's words in one part, or a workbook's a part a sheet, in the workbook's order, and whether they were
 * `cut` at `OFFICE_LIMITS.chars`. `not_zip`: it isn't a zip at all; `not_office`: a zip with no document or workbook
 * in it; `refused`: a zip this won't open.
 */
export type OfficeText =
  | {
      readonly ok: true;
      readonly kind: 'word' | 'excel';
      readonly parts: readonly string[];
      readonly cut: boolean;
    }
  | { readonly ok: false; readonly why: 'not_zip' | 'not_office' | 'refused' };

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;

/** A zip this won't open. */
class Refused extends Error {}

interface Entry {
  readonly method: number;
  readonly compressed: number;
  readonly size: number;
  readonly offset: number;
}

/** The zip's entries by name, from its central directory, checked whole before anything is inflated. */
function entriesOf(zip: Buffer): Map<string, Entry> {
  // The end record is 22 bytes, then a comment of up to 65,535.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--)
    if (zip.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  if (end < 0) throw new Refused('no end record');
  if (end >= 20 && zip.readUInt32LE(end - 20) === ZIP64_LOCATOR) throw new Refused('zip64');
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const start = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0)
    throw new Refused('split');
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new Refused('zip64');
  if (count > OFFICE_LIMITS.entries || zip.readUInt16LE(end + 8) !== count)
    throw new Refused('entries');
  if (start + size > end) throw new Refused('directory');
  const entries = new Map<string, Entry>();
  let at = start;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== CENTRAL) throw new Refused('directory');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const inflated = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    if (next > end) throw new Refused('directory');
    if (flags & 1) throw new Refused('encrypted');
    if (method !== 0 && method !== 8) throw new Refused('method');
    if (compressed === 0xffffffff || inflated === 0xffffffff || offset === 0xffffffff)
      throw new Refused('zip64');
    entries.set(zip.toString('utf8', at + 46, at + 46 + nameLength), {
      method,
      compressed,
      size: inflated,
      offset,
    });
    at = next;
  }
  return entries;
}

/** Reads parts, keeping to the limits across them all. */
function partReader(zip: Buffer, entries: ReadonlyMap<string, Entry>) {
  let left: number = OFFICE_LIMITS.totalBytes;
  return (name: string): string | null => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.size > OFFICE_LIMITS.partBytes || e.size > left) throw new Refused('too big');
    if (e.size > Math.max(e.compressed, 1) * OFFICE_LIMITS.ratio) throw new Refused('ratio');
    if (e.offset + 30 > zip.length || zip.readUInt32LE(e.offset) !== LOCAL)
      throw new Refused('local header');
    const from = e.offset + 30 + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28);
    if (from + e.compressed > zip.length) throw new Refused('cut short');
    const data = zip.subarray(from, from + e.compressed);
    let out: Buffer;
    if (e.method === 0) out = data;
    else
      try {
        // Held to what it says it holds, and to the ratio, whatever the stream really inflates to.
        out = inflateRawSync(data, {
          maxOutputLength: Math.max(
            1,
            Math.min(OFFICE_LIMITS.partBytes, left, e.compressed * OFFICE_LIMITS.ratio),
          ),
        });
      } catch {
        throw new Refused('inflate');
      }
    left -= out.length;
    return out.toString('utf8');
  };
}

// ---------- XML ----------

interface Tag {
  /** Its name without a namespace prefix: `t` for `<w:t>`. */
  readonly name: string;
  readonly close: boolean;
  readonly empty: boolean;
  readonly attrs: string;
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** XML text with its five named entities and numeric ones decoded; any other entity is left as it's written. */
export function decodeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g,
    (whole, e: string) => {
      if (e[0] !== '#') return NAMED[e] ?? whole;
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
        ? String.fromCodePoint(cp)
        : whole;
    },
  );
}

/** Each tag and run of text in an XML part, in order. Comments, declarations and instructions are skipped. */
function* xmlParts(xml: string): Generator<Tag | string> {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      yield decodeXml(xml.slice(i));
      return;
    }
    if (lt > i) yield decodeXml(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? xml.length : e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      yield xml.slice(lt + 9, e < 0 ? xml.length : e);
      i = e < 0 ? xml.length : e + 3;
      continue;
    }
    // The tag's end, past any ">" inside a quoted value.
    let gt = lt + 1;
    let quote = '';
    for (; gt < xml.length; gt++) {
      const c = xml[gt];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '?' || body[0] === '!') continue;
    const close = body[0] === '/';
    const empty = body.endsWith('/');
    const qualified = /^\/?([^\s/>]+)/.exec(body)?.[1] ?? '';
    yield {
      name: qualified.slice(qualified.indexOf(':') + 1),
      close,
      empty,
      attrs: body.slice(qualified.length + (close ? 1 : 0)),
    };
  }
}

/** One attribute of a tag by its name without a prefix: `id` for `r:id`. */
function attrOf(tag: Tag, name: string): string | null {
  for (const m of tag.attrs.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const qualified = m[1]!;
    if (qualified.slice(qualified.indexOf(':') + 1) === name) return decodeXml(m[2] ?? m[3] ?? '');
  }
  return null;
}

/** A text at most `room` characters long. */
const within = (text: string, room: number): string =>
  text.length > room ? text.slice(0, room) : text;

// ---------- Word ----------

/**
 * A Word document's words: each `<w:t>`'s text, a new line a paragraph or break, a tab a `<w:tab/>`. `room`
 * characters at most.
 */
export function wordText(xml: string, room = Infinity): string {
  let out = '';
  let inText = false;
  // `<w:tabs>` lists a paragraph's tab stops, each a `<w:tab>` that isn't one typed.
  let inTabStops = 0;
  for (const part of xmlParts(xml)) {
    if (out.length >= room) break;
    if (typeof part === 'string') {
      if (inText) out += part;
      continue;
    }
    if (part.close) {
      if (part.name === 't') inText = false;
      else if (part.name === 'p') out += '\n';
      else if (part.name === 'tabs') inTabStops = Math.max(0, inTabStops - 1);
      continue;
    }
    if (part.name === 't') inText = !part.empty;
    else if (part.name === 'tabs') inTabStops += part.empty ? 0 : 1;
    else if (part.name === 'tab' && inTabStops === 0) out += '\t';
    else if (part.name === 'br' || part.name === 'cr' || (part.name === 'p' && part.empty))
      out += '\n';
  }
  return within(out, room);
}

// ---------- Excel ----------

/**
 * A workbook's shared strings, in order: each `<si>`'s text, its phonetic guides (`<rPh>`) left out, and `room`
 * characters at most of each.
 */
export function sharedStrings(xml: string, room = Infinity): string[] {
  const out: string[] = [];
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  for (const part of xmlParts(xml)) {
    if (typeof part === 'string') {
      if (inText && phonetic === 0 && current !== null && current.length < room) current += part;
      continue;
    }
    if (part.name === 'si') {
      if (part.close || part.empty) {
        out.push(within(current ?? '', room));
        current = null;
      } else current = '';
    } else if (part.name === 't') inText = !part.close && !part.empty;
    else if (part.name === 'rPh' && !part.empty) phonetic += part.close ? -1 : 1;
  }
  return out;
}

/**
 * A sheet's words: a line a row, its cells joined by tabs. Shared strings, inline strings, and numbers as written,
 * so phone numbers and invoice numbers are found. Formulas themselves, true or false, and errors are left out.
 * `room` characters at most: a cell repeats its shared string, so this stops as soon as they're reached.
 */
export function sheetText(xml: string, shared: readonly string[], room = Infinity): string {
  let out = '';
  // The cells written in the row being read.
  let cells = 0;
  let cell: { type: string; value: string; inline: string } | null = null;
  let inValue = false;
  let inText = false;
  let inInline = 0;
  let phonetic = 0;
  for (const part of xmlParts(xml)) {
    if (out.length >= room) return within(out, room);
    if (typeof part === 'string') {
      if (!cell) continue;
      if (inValue) cell.value += part;
      else if (inText && inInline > 0 && phonetic === 0) cell.inline += part;
      continue;
    }
    switch (part.name) {
      case 'row':
        // A row's end ends its line; so does a row starting with cells left unended before it.
        if (cells) out += '\n';
        cells = 0;
        break;
      case 'c':
        if (part.close) {
          if (cell) {
            const text =
              cell.type === 's'
                ? (shared[Number(cell.value.trim())] ?? '')
                : cell.type === 'inlineStr'
                  ? cell.inline
                  : cell.type === 'b' || cell.type === 'e'
                    ? ''
                    : cell.value;
            const kept = within(text, room).trim();
            if (kept) out += `${cells++ ? '\t' : ''}${kept}`;
          }
          cell = null;
        } else if (!part.empty) cell = { type: attrOf(part, 't') ?? 'n', value: '', inline: '' };
        break;
      case 'v':
        inValue = !part.close && !part.empty;
        break;
      case 'is':
        if (!part.empty) inInline += part.close ? -1 : 1;
        break;
      case 't':
        inText = !part.close && !part.empty;
        break;
      case 'rPh':
        if (!part.empty) phonetic += part.close ? -1 : 1;
        break;
    }
  }
  // A row left open at the end still counts.
  if (cells) out += '\n';
  return within(out, room);
}

/** The workbook's worksheets, in its own order: each sheet's part, through the workbook's relationships. */
function sheetPartsOf(read: (name: string) => string | null, names: readonly string[]): string[] {
  const numbered = names
    .map((n) => ({ n, at: /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(n) }))
    .filter((x) => x.at)
    .sort((a, b) => Number(a.at![1]) - Number(b.at![1]))
    .map((x) => x.n);
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) return numbered;
  const targets = new Map<string, string>();
  for (const part of xmlParts(rels))
    if (typeof part !== 'string' && part.name === 'Relationship') {
      const id = attrOf(part, 'Id');
      const target = attrOf(part, 'Target');
      if (id && target)
        targets.set(
          id,
          target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`,
        );
    }
  const ordered: string[] = [];
  for (const part of xmlParts(workbook))
    if (typeof part !== 'string' && part.name === 'sheet' && !part.close) {
      const target = targets.get(attrOf(part, 'id') ?? '');
      // A chart sheet has no cells; a sheet whose part can't be found falls back to the parts' own order.
      if (!target) return numbered;
      if (/^xl\/worksheets\//.test(target) && names.includes(target)) ordered.push(target);
    }
  return ordered.length ? ordered : numbered;
}

/** A Word document's or an Excel workbook's words, or why there are none. */
export function officeText(file: Buffer): OfficeText {
  if (file.length < 4 || file.readUInt32LE(0) !== LOCAL) return { ok: false, why: 'not_zip' };
  try {
    const entries = entriesOf(file);
    const read = partReader(file, entries);
    const room = OFFICE_LIMITS.chars;
    const document = read('word/document.xml');
    if (document !== null) {
      const words = wordText(document, room);
      return { ok: true, kind: 'word', parts: [words], cut: words.length >= room };
    }
    if (!entries.has('xl/workbook.xml')) return { ok: false, why: 'not_office' };
    const shared = sharedStrings(read('xl/sharedStrings.xml') ?? '', room);
    // What's left of the room across the sheets: once it's spent, no sheet after is read at all.
    const parts: string[] = [];
    let left = room;
    for (const name of sheetPartsOf(read, [...entries.keys()])) {
      if (left <= 0) return { ok: true, kind: 'excel', parts, cut: true };
      const words = sheetText(read(name) ?? '', shared, left);
      parts.push(words);
      left -= words.length;
    }
    return { ok: true, kind: 'excel', parts, cut: left <= 0 };
  } catch {
    return { ok: false, why: 'refused' };
  }
}
