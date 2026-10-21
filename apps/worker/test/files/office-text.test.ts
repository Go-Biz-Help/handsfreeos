/**
 * The Word and Excel reader (src/files/office-text.ts), with no database: a .docx and a .xlsx made here as Office
 * makes them, read back as their words; zips it won't open (made to blow up, too many entries, encrypted, zip64); a
 * workbook repeating one long shared string, whose words stop at 200,000 characters; and the job's sniffing, which
 * reads a PDF named .docx as a PDF.
 */
import { describe, expect, it } from 'vitest';
import { fileKindOf, joinPages, readFileText } from '../../src/files/file-text';
import {
  decodeXml,
  OFFICE_LIMITS,
  officeText,
  sharedStrings,
  sheetText,
  wordText,
} from '../../src/files/office-text';
import { pdfPages } from '../../src/files/document-text';
import { makeZip } from '../../src/files/zip';
import { textPdf } from '../pdf-maker';

const xml = (s: string) =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`);
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A Word document with these paragraphs, the way Word splits a paragraph's words into runs. */
function docx(paragraphs: readonly string[]): Buffer {
  const body = paragraphs
    .map(
      (p) =>
        `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${p
          .split('\t')
          .map(
            (part, i) =>
              `${i ? '<w:r><w:tab/></w:r>' : ''}<w:r><w:t xml:space="preserve">${part}</w:t></w:r>`,
          )
          .join('')}</w:p>`,
    )
    .join('');
  return makeZip([
    { name: '[Content_Types].xml', data: xml('<Types/>') },
    {
      name: 'word/document.xml',
      data: xml(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
    },
    { name: 'word/styles.xml', data: xml('<w:styles/>') },
  ]);
}

/** A workbook with these sheets, listed in the workbook in this order though their parts are numbered backwards. */
function xlsx(sheets: readonly (readonly (readonly (string | number)[])[])[]): Buffer {
  const shared: string[] = [];
  const at = (s: string) => {
    const i = shared.indexOf(s);
    return i >= 0 ? i : shared.push(s) - 1;
  };
  const parts = sheets.map((rows, n) => ({
    name: `xl/worksheets/sheet${sheets.length - n}.xml`,
    data: xml(
      `<worksheet><sheetData>${rows
        .map(
          (row, r) =>
            `<row r="${r + 1}">${row
              .map((cell, c) =>
                typeof cell === 'number'
                  ? `<c r="${String.fromCharCode(65 + c)}${r + 1}"><v>${cell}</v></c>`
                  : cell.startsWith('=')
                    ? `<c t="inlineStr"><is><r><t>${cell.slice(1)}</t></r></is></c>`
                    : `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="s"><v>${at(cell)}</v></c>`,
              )
              .join('')}<c r="Z${r + 1}" s="1"/></row>`,
        )
        .join('')}</sheetData></worksheet>`,
    ),
  }));
  return makeZip([
    {
      name: 'xl/workbook.xml',
      data: xml(
        `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
          .map((_, n) => `<sheet name="S${n + 1}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`)
          .join('')}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xml(
        `<Relationships>${sheets
          .map(
            (_, n) =>
              `<Relationship Id="rId${n + 1}" Type="worksheet" Target="worksheets/sheet${sheets.length - n}.xml"/>`,
          )
          .join('')}</Relationships>`,
      ),
    },
    {
      name: 'xl/sharedStrings.xml',
      data: xml(
        `<sst>${shared.map((s) => `<si><t>${s}</t><rPh><t>PHONETIC</t></rPh></si>`).join('')}</sst>`,
      ),
    },
    ...parts,
  ]);
}

/** A copy with one central directory entry's fields changed, the way a tampered zip would read. */
function tamper(zip: Buffer, name: string, edit: (zip: Buffer, at: number) => void): Buffer {
  const copy = Buffer.from(zip);
  for (let at = 0; at < copy.length - 46; at++)
    if (
      copy.readUInt32LE(at) === 0x02014b50 &&
      copy.toString('utf8', at + 46, at + 46 + name.length) === name
    ) {
      edit(copy, at);
      return copy;
    }
  throw new Error(`no ${name}`);
}

describe('Word', () => {
  it('reads each paragraph as a line, a typed tab as a tab, and never a tab stop', () => {
    const read = officeText(docx(['Invoice INV-001042 &amp; quote', 'Call\t(504) 555-0142', '']));
    expect(read).toEqual({
      ok: true,
      kind: 'word',
      parts: ['Invoice INV-001042 & quote\nCall\t(504) 555-0142\n\n'],
      cut: false,
    });
  });

  it('decodes the five named entities and numeric ones, and expands nothing else', () => {
    expect(
      decodeXml('&lt;b&gt; &quot;x&quot; &apos;y&apos; &amp;amp; &#233; &#x2019; &bogus; &#xD800;'),
    ).toBe('<b> "x" \'y\' &amp; é ’ &bogus; &#xD800;');
    // A document that declares its own entities gets nothing from them.
    expect(
      wordText(
        `<!DOCTYPE d [<!ENTITY big "boom">]><w:document ${W}><w:p><w:r><w:t>&big;</w:t></w:r></w:p></w:document>`,
      ),
    ).toBe('&big;\n');
  });

  it('keeps words with a ">" inside a quoted value, and leaves comments and CDATA as they are', () => {
    expect(
      wordText(
        `<w:p><!-- a <w:t>note</w:t> --><w:r w:rsid="a>b"><w:t>Gate</w:t></w:r><w:r><w:t><![CDATA[ & code]]></w:t></w:r></w:p>`,
      ),
    ).toBe('Gate & code\n');
  });
});

describe('Excel', () => {
  it('reads each sheet in the workbook’s order: a line a row, its cells joined by tabs, numbers as written', () => {
    const read = officeText(
      xlsx([
        [
          ['Customer', 'Phone', 'Invoice'],
          ['Dana Smith', 5045550142, 'INV-001042'],
        ],
        [['=Inline words', 3.5]],
      ]),
    );
    expect(read).toEqual({
      ok: true,
      kind: 'excel',
      parts: [
        'Customer\tPhone\tInvoice\nDana Smith\t5045550142\tINV-001042\n',
        'Inline words\t3.5\n',
      ],
      cut: false,
    });
  });

  it('leaves out phonetic guides, true or false and errors', () => {
    expect(
      sharedStrings(
        '<sst><si><r><t>Ka</t></r><r><t>ri</t></r><rPh><t>カリ</t></rPh></si><si/></sst>',
      ),
    ).toEqual(['Kari', '']);
    expect(
      sheetText(
        '<sheetData><row><c t="s"><v>0</v></c><c t="b"><v>1</v></c><c t="e"><v>#N/A</v></c><c t="str"><f>A1</f><v>Kari</v></c></row></sheetData>',
        ['Kari'],
      ),
    ).toBe('Kari\tKari\n');
  });
});

describe('zips it won’t open', () => {
  it('refuses one made to blow up: a part that says it grows more than 200 times', () => {
    const bomb = makeZip([
      { name: 'word/document.xml', data: Buffer.alloc(5 * 1024 * 1024, 0x20) },
    ]);
    expect(officeText(bomb)).toEqual({ ok: false, why: 'refused' });
    // And one that lies about what it holds is held to it anyway.
    const liar = tamper(bomb, 'word/document.xml', (zip, at) => zip.writeUInt32LE(100, at + 24));
    expect(officeText(liar)).toEqual({ ok: false, why: 'refused' });
  });

  it('refuses more than 2,000 entries', () => {
    const many = makeZip(
      Array.from({ length: 2001 }, (_, i) => ({
        name: `word/media/${i}.txt`,
        data: Buffer.from('x'),
      })),
    );
    expect(officeText(many)).toEqual({ ok: false, why: 'refused' });
  });

  it('refuses an encrypted entry, another method and zip64', () => {
    const doc = docx(['Gate code 4471']);
    const encrypted = tamper(doc, 'word/styles.xml', (zip, at) =>
      zip.writeUInt16LE(zip.readUInt16LE(at + 8) | 1, at + 8),
    );
    const bzip = tamper(doc, 'word/styles.xml', (zip, at) => zip.writeUInt16LE(12, at + 10));
    const zip64 = tamper(doc, 'word/document.xml', (zip, at) =>
      zip.writeUInt32LE(0xffffffff, at + 24),
    );
    for (const zip of [encrypted, bzip, zip64])
      expect(officeText(zip)).toEqual({ ok: false, why: 'refused' });
    expect(officeText(doc)).toMatchObject({ ok: true });
  });

  it('says a zip with no document or workbook isn’t Office, and a non-zip isn’t a zip', () => {
    const photos = makeZip([{ name: 'photo.txt', data: Buffer.from('hello') }]);
    expect(officeText(photos)).toEqual({ ok: false, why: 'not_office' });
    expect(officeText(Buffer.from('%PDF-1.4 not a zip'))).toEqual({ ok: false, why: 'not_zip' });
    expect(officeText(Buffer.from('PK\x03\x04 cut short'))).toEqual({ ok: false, why: 'refused' });
    // A document cut off before its directory: refused, never thrown.
    const doc = docx(['Gate code 4471']);
    expect(officeText(doc.subarray(0, doc.length - 30))).toEqual({ ok: false, why: 'refused' });
  });
});

describe('words without end', () => {
  /** Letters that don't compress much, the same each run, so the zip stays well under the 200-times rule. */
  const letters = (n: number) => {
    let seed = 7;
    return Array.from({ length: n }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return String.fromCharCode(97 + (seed % 26));
    }).join('');
  };

  it('stops at 200,000 characters however often cells repeat a long shared string, reading no sheet after', async () => {
    const long = letters(300_000);
    const workbook = xlsx([Array.from({ length: 1_000 }, () => [long]), [['Second sheet']]]);
    // A 1,000-row sheet that would be 300 million characters.
    expect(workbook.length).toBeLessThan(400_000);
    const started = Date.now();
    const read = officeText(workbook);
    expect(read).toMatchObject({ ok: true, kind: 'excel', cut: true });
    const parts = read.ok ? read.parts : [];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(OFFICE_LIMITS.chars);
    // The job keeps 100,000 of them, and says they were cut.
    const kept = await readFileText(workbook, 'application/pdf');
    expect(kept.state).toBe('truncated');
    expect(kept.text).toHaveLength(100_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Each reader keeps to the room it's given.
    expect(sheetText(`<row><c t="s"><v>0</v></c><c t="s"><v>0</v></c></row>`, ['abc'], 6)).toBe(
      'abc\tab',
    );
    expect(sharedStrings(`<sst><si><t>${long}</t></si><si><t>b</t></si></sst>`, 10)).toEqual([
      long.slice(0, 10),
      'b',
    ]);
    expect(wordText(`<w:p><w:r><w:t>${long}</w:t></w:r></w:p>`, 10)).toBe(long.slice(0, 10));
  });

  it('reads a PDF no further than the characters asked for, every page still counted', async () => {
    const pdf = textPdf([['Backflow test passed on building 2'], ['Second page'], ['Third page']]);
    expect(await pdfPages(pdf, 10)).toEqual({
      // Twice the room cut before tidying, and no page after.
      pages: ['Backflow test passed'],
      total: 3,
      cut: true,
    });
    expect(await pdfPages(pdf)).toMatchObject({ total: 3, cut: false });
  });
});

describe('what the job reads a file as', () => {
  it('reads a PDF named .docx as a PDF, by its first bytes, and a .docx declared as a PDF as Word', async () => {
    const pdf = textPdf([['Backflow test passed on building 2, both valves replaced']]);
    expect(
      fileKindOf(pdf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('pdf');
    expect(
      await readFileText(
        pdf,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toEqual({
      state: 'done',
      text: 'Backflow test passed on building 2, both valves replaced',
      pages: [0],
    });
    const doc = docx(['Gate code 4471, dog in the yard, side door']);
    expect(fileKindOf(doc, 'application/pdf')).toBe('zip');
    expect(await readFileText(doc, 'application/pdf')).toEqual({
      state: 'done',
      text: 'Gate code 4471, dog in the yard, side door',
      pages: [],
    });
  });

  it('reads text only when it’s declared as text, and anything else as unsupported', async () => {
    expect(fileKindOf(Buffer.from('Name,Phone\nDana,555'), 'text/csv')).toBe('text');
    expect(fileKindOf(Buffer.from('Name,Phone\nDana,555'), 'application/octet-stream')).toBe(
      'unsupported',
    );
    expect(await readFileText(Buffer.from('\x89PNG\r\n'), 'image/png')).toEqual({
      state: 'unsupported',
      text: '',
      pages: [],
    });
  });

  it('joins pages with where each starts, counting a character outside the BMP as one, and cuts at 100,000', () => {
    expect(joinPages(['One 😀', '', 'Three'])).toEqual({
      text: 'One 😀\n\n\n\nThree',
      pages: [0, 7, 9],
      cut: false,
    });
    const long = joinPages(['a'.repeat(60_000), 'b'.repeat(60_000), 'c']);
    expect(long.cut).toBe(true);
    expect(long.text).toHaveLength(100_000);
    expect(long.pages).toEqual([0, 60_002]);
    const pages = joinPages(Array.from({ length: 2_500 }, (_, i) => `Page ${i + 1}`));
    expect(pages.pages).toHaveLength(2_000);
    expect(pages.cut).toBe(true);
    // A page far past the room is cut before it's tidied, never after.
    const huge = joinPages(['Lead in', `${'word '.repeat(2_000_000)}`]);
    expect(huge).toMatchObject({ cut: true, pages: [0, 9] });
    expect(huge.text).toHaveLength(100_000);
  });
});
