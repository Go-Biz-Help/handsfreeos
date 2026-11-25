/**
 * An Excel workbook of one table (assistant/files-out.ts in core): one sheet named for it, the headings bold, frozen
 * and filterable, money with a dollar format, dates as real dates, and a bold Total row when there is one.
 *
 * Written by hand, with no library: a workbook is a zip of a few XML files. Every cell anyone typed is a string cell,
 * never a formula, so nothing in it runs when it's opened.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { zonedParts, type FileCell, type FileTable } from '@hfos/core/server';

/** Characters XML can't hold at all: they'd make Excel refuse the whole file. */
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const xml = (s: string) =>
  s
    .replace(NOT_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** "A", "B", … "Z", "AA": a column's letters. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Excel counts days from 30 December 1899. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
const serialOf = (y: number, m: number, d: number, hour = 0, minute = 0) =>
  (Date.UTC(y, m - 1, d, hour, minute) - EXCEL_EPOCH) / DAY_MS;

// Styles, by their place in cellXfs below.
const STYLE = {
  plain: 0,
  head: 1,
  money: 2,
  date: 3,
  datetime: 4,
  totalMoney: 5,
  totalNumber: 6,
  totalText: 7,
};

function cellXml(ref: string, cell: FileCell, timeZone: string, total: boolean): string {
  switch (cell.kind) {
    case 'empty':
      return '';
    case 'text':
      return `<c r="${ref}" t="inlineStr"${total ? ` s="${STYLE.totalText}"` : ''}><is><t xml:space="preserve">${xml(cell.text)}</t></is></c>`;
    case 'number':
      return `<c r="${ref}"${total ? ` s="${STYLE.totalNumber}"` : ''}><v>${cell.n}</v></c>`;
    case 'money':
      return `<c r="${ref}" s="${total ? STYLE.totalMoney : STYLE.money}"><v>${cell.cents / 100}</v></c>`;
    case 'date':
      return `<c r="${ref}" s="${STYLE.date}"><v>${serialOf(cell.y, cell.m, cell.d)}</v></c>`;
    case 'datetime': {
      const p = zonedParts(cell.at, timeZone);
      return `<c r="${ref}" s="${STYLE.datetime}"><v>${serialOf(p.year, p.month, p.day, p.hour, p.minute)}</v></c>`;
    }
  }
}

/** How wide a column shows: its longest heading or cell, in characters, within reason. */
function widthOf(table: FileTable, i: number): number {
  let longest = table.columns[i]!.label.length + 2;
  for (const row of table.rows.slice(0, 500)) {
    const c = row[i]!;
    const len =
      c.kind === 'text'
        ? Math.min(c.text.length, 60)
        : c.kind === 'money'
          ? 12
          : c.kind === 'date'
            ? 13
            : c.kind === 'datetime'
              ? 20
              : c.kind === 'number'
                ? String(c.n).length + 2
                : 0;
    if (len > longest) longest = len;
  }
  return Math.max(8, Math.min(60, longest + 1));
}

/** A sheet's name: at most 31 characters, none of the ones Excel refuses. */
export function sheetName(title: string): string {
  return (
    title
      .replace(/[[\]:*?/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^'+|'+$/g, '')
      .slice(0, 31)
      .trim() || 'Sheet1'
  );
}

function sheetXml(table: FileTable, timeZone: string): string {
  const width = table.columns.length;
  const last = columnLetters(width - 1);
  const head = `<row r="1">${table.columns
    .map(
      (c, i) =>
        `<c r="${columnLetters(i)}1" t="inlineStr" s="${STYLE.head}"><is><t xml:space="preserve">${xml(c.label)}</t></is></c>`,
    )
    .join('')}</row>`;
  const body = table.rows
    .map(
      (row, r) =>
        `<row r="${r + 2}">${row.map((c, i) => cellXml(`${columnLetters(i)}${r + 2}`, c, timeZone, false)).join('')}</row>`,
    )
    .join('');
  const totalRow = table.rows.length + 2;
  const totals = table.totals
    ? `<row r="${totalRow}">${table.totals
        .map((c, i) =>
          i === 0 && c.kind === 'empty'
            ? cellXml(`A${totalRow}`, { kind: 'text', text: 'Total' }, timeZone, true)
            : cellXml(`${columnLetters(i)}${totalRow}`, c, timeZone, true),
        )
        .join('')}</row>`
    : '';
  const cols = table.columns
    .map(
      (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${widthOf(table, i)}" customWidth="1"/>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${head}${body}${totals}</sheetData>` +
    (table.rows.length ? `<autoFilter ref="A1:${last}${table.rows.length + 1}"/>` : '') +
    '</worksheet>'
  );
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="mmm d, yyyy"/><numFmt numFmtId="166" formatCode="mmm d, yyyy h:mm AM/PM"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="8">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

function workbookFiles(table: FileTable, timeZone: string): [string, string][] {
  return [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xml(sheetName(table.title))}" sheetId="1" r:id="rId1"/></sheets>` +
        (table.rows.length
          ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xml(sheetName(table.title)).replace(/'/g, "''")}'!$A$1:$${columnLetters(table.columns.length - 1)}$${table.rows.length + 1}</definedName></definedNames>`
          : '') +
        '</workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    ],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheetXml(table, timeZone)],
  ];
}

/** A zip of these files, each deflated (what every spreadsheet app opens). */
export function zipFiles(files: readonly (readonly [string, string | Buffer])[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 1 Jan 2026, 00:00, in the zip's DOS clock: the same bytes for the same table.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names in UTF-8
    local.writeUInt16LE(8, 8); // deflated
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The table as an .xlsx file. */
export function fileTableXlsx(table: FileTable, timeZone: string): Buffer {
  return zipFiles(workbookFiles(table, timeZone));
}
