/**
 * Files sent to the Assistant (the owner, 2026-11-24: "we should include being able to add files as well"), without a
 * database: how each kind is read for the model, what it's shown, and how a file made to be huge or slow is refused.
 */
import {
  ASSISTANT_DOCX_TYPE,
  ASSISTANT_FILES_MAX_BASE64,
  ASSISTANT_XLSX_TYPE,
  AssistantAskInput,
  assistantFileRefusal,
  assistantFileType,
} from '@hfos/core/server';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_PDF_PAGES,
  fileContent,
  filesForModel,
  plainText,
} from '../src/assistant/attachments';
import { modelMessages } from '../src/assistant/runtime';
import { photosAsPdf, signersOf } from '../src/assistant/tools-documents';
import { officeLayout, wordLayout, workbookRows } from '../src/files/office-text';
import { stagedOf, stagedPath } from '../src/housekeeping/assistant-staging';
import { workbook, zip } from './office-zip';

const docxText = (file: Buffer) => {
  const read = officeLayout(file);
  if (!read.ok) throw new Error(read.why);
  return read.text;
};
const xlsxText = docxText;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (text: string) => `<w:tc><w:tcPr/>${para(text)}</w:tc>`;

/** A Word file with a heading, a paragraph and a price table. */
const priceListDocx = () =>
  zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>
      ${para('Spring price list')}
      <w:p><w:r><w:t>Mugs &amp; tumblers</w:t><w:tab/><w:t>call for bulk</w:t></w:r></w:p>
      <w:tbl><w:tr>${cell('Item')}${cell('Size')}${cell('Price')}</w:tr>
      <w:tr>${cell('T-shirt')}${cell('Adult M')}${cell('$12')}</w:tr>
      <w:tr>${cell('T-shirt')}${cell('Adult 2XL')}${cell('$14')}</w:tr></w:tbl>
      ${para('Prices before tax.')}
    </w:body></w:document>`,
  });

/** A spreadsheet with shared words, a number, an inline word and a skipped column. */
const priceListXlsx = () =>
  zip({
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets><sheet name="Menu" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Item</t></si><si><t>Price</t></si><si><r><t>Latte</t></r><r><t xml:space="preserve"> (16 oz)</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>4.5</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>Tea &lt;hot&gt;</t></is></c><c r="C3"><f>C2-1</f><v>3.5</v></c></row>
    </sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  });

async function pdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

describe('the files the Assistant takes', () => {
  it('knows each kind by its type, or by its name when the type says nothing', () => {
    expect(assistantFileType('Prices.PDF', '')).toBe('application/pdf');
    expect(assistantFileType('notes.md', '')).toBe('text/markdown');
    expect(assistantFileType('list.csv', 'application/vnd.ms-excel')).toBe('text/csv');
    expect(assistantFileType('book.xlsx', 'application/octet-stream')).toBe(ASSISTANT_XLSX_TYPE);
    expect(assistantFileType('contract', ASSISTANT_DOCX_TYPE)).toBe(ASSISTANT_DOCX_TYPE);
    expect(assistantFileType('old.doc', 'application/msword')).toBeNull();
    // A phone's or Google's contacts export, however the system labels it.
    expect(assistantFileType('Contacts.vcf', '')).toBe('text/vcard');
    expect(assistantFileType('Contacts.vcf', 'text/x-vcard')).toBe('text/vcard');
    expect(assistantFileType('card', 'text/directory')).toBe('text/vcard');
  });

  it('says what to do with a kind it can’t read', () => {
    expect(assistantFileRefusal('Contract.doc')).toMatch(/Save it as a PDF or a Word \.docx/);
    expect(assistantFileRefusal('Prices.xls')).toMatch(/\.xlsx or a \.csv/);
    expect(assistantFileRefusal('movie.mov')).toMatch(/isn’t a kind of file.* a contacts \.vcf/);
  });

  it('takes a question that is only a file, and refuses files that come to too much together', () => {
    const base = { workspaceId: '00000000-0000-4000-8000-000000000001' };
    const file = { name: 'a.txt', mediaType: 'text/plain' as const, data: 'aGk=' };
    expect(AssistantAskInput.safeParse({ ...base, files: [file] }).success).toBe(true);
    const half = 'A'.repeat(Math.ceil(ASSISTANT_FILES_MAX_BASE64 / 2) + 4);
    const big = AssistantAskInput.safeParse({
      ...base,
      text: 'Read these',
      files: [
        { ...file, data: half },
        { ...file, data: half },
      ],
    });
    expect(big.success).toBe(false);
    expect(JSON.stringify(big.error)).toContain('MB together');
  });
});

describe('reading a file for the model', () => {
  it('reads a Word file’s paragraphs, and each table row on one line', () => {
    expect(docxText(priceListDocx())).toBe(
      [
        'Spring price list',
        'Mugs & tumblers\tcall for bulk',
        'Item | Size | Price',
        'T-shirt | Adult M | $12',
        'T-shirt | Adult 2XL | $14',
        'Prices before tax.',
      ].join('\n'),
    );
  });

  it('reads a spreadsheet’s sheets by name, a row a line, in their columns', () => {
    expect(xlsxText(priceListXlsx())).toBe(
      ['Sheet “Menu”:', 'Item |  | Price', 'Latte (16 oz) |  | 4.5', 'Tea <hot> |  | 3.5'].join(
        '\n',
      ),
    );
  });

  it('reads a sheet’s rows of cells for the contacts import, from its first sheet with anything on it', () => {
    expect(workbookRows(priceListXlsx())).toEqual({
      ok: true,
      sheet: 'Menu',
      rows: [
        ['Item', '', 'Price'],
        ['Latte (16 oz)', '', '4.5'],
        ['Tea <hot>', '', '3.5'],
      ],
    });
    expect(workbookRows(workbook([], 'Empty'))).toEqual({ ok: false, why: 'none' });
    expect(workbookRows(Buffer.from('Name,Phone'))).toEqual({ ok: false, why: 'not_zip' });
  });

  it('reads text as UTF-8, or as Latin-1 when it isn’t', () => {
    expect(plainText(Buffer.from('\uFEFFCafé, $4', 'utf8'))).toBe('Café, $4');
    expect(plainText(Buffer.from('Caf\xe9 '.repeat(20), 'latin1'))).toContain('Café');
  });

  it('refuses a zip part that says it unpacks to too much, and one that isn’t a zip', () => {
    const honest = zip({ 'word/document.xml': `<w:document ${W}>${para('Hello')}</w:document>` });
    expect(officeLayout(honest)).toMatchObject({ ok: true, text: 'Hello' });
    // Say the part unpacks to 30 MB: it's refused before anything is unpacked.
    const at = honest.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const lying = Buffer.from(honest);
    lying.writeUInt32LE(30 * 1024 * 1024, at + 24);
    expect(officeLayout(lying)).toEqual({ ok: false, why: 'refused' });
    expect(officeLayout(Buffer.from('not a zip at all, just words'))).toEqual({
      ok: false,
      why: 'not_zip',
    });
  });

  it('walks a huge run of odd XML in one pass', () => {
    const odd = `<w:document ${W}><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>${'&amp'.repeat(200_000)}${'<a b="'.repeat(20_000)}</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const started = Date.now();
    wordLayout(odd);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('readies each kind, naming the file in what the model reads', async () => {
    const files = await filesForModel([
      {
        name: 'Prices.docx',
        mediaType: ASSISTANT_DOCX_TYPE,
        data: priceListDocx().toString('base64'),
      },
      {
        name: 'Menu.xlsx',
        mediaType: ASSISTANT_XLSX_TYPE,
        data: priceListXlsx().toString('base64'),
      },
      {
        name: 'Contract.pdf',
        mediaType: 'application/pdf',
        data: (await pdf(2)).toString('base64'),
      },
    ]);
    expect(files.map((f) => [f.kind, f.name])).toEqual([
      ['text', 'Prices.docx'],
      ['text', 'Menu.xlsx'],
      ['pdf', 'Contract.pdf'],
    ]);
    expect(fileContent(files[0]!)).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /^--- The file Prices\.docx ---\nSpring price list\n[\s\S]*\n--- End of Prices\.docx ---$/,
        ),
      },
    ]);
    expect(fileContent(files[2]!)).toEqual([
      expect.objectContaining({ type: 'document', title: 'Contract.pdf', pages: 2 }),
    ]);
  });

  it('sends only a long PDF’s first pages, and says so', async () => {
    const [long] = await filesForModel([
      {
        name: 'Catalogue.pdf',
        mediaType: 'application/pdf',
        data: (await pdf(ASSISTANT_PDF_PAGES + 5)).toString('base64'),
      },
    ]);
    expect(long).toMatchObject({
      kind: 'pdf',
      pages: ASSISTANT_PDF_PAGES,
      of: ASSISTANT_PDF_PAGES + 5,
    });
    const sent = await PDFDocument.load(Buffer.from((long as { data: string }).data, 'base64'));
    expect(sent.getPageCount()).toBe(ASSISTANT_PDF_PAGES);
    expect(fileContent(long!)[1]).toEqual({
      type: 'text',
      text: `(Only the first ${ASSISTANT_PDF_PAGES} of the ${ASSISTANT_PDF_PAGES + 5} pages of Catalogue.pdf came through.)`,
    });
  });

  it('refuses a file it can’t open, by name, before anything is asked', async () => {
    await expect(
      filesForModel([{ name: 'Broken.pdf', mediaType: 'application/pdf', data: 'AAAA' }]),
    ).rejects.toMatchObject({
      rule: 'file_unreadable',
      message: expect.stringContaining('Broken.pdf'),
    });
    await expect(
      filesForModel([
        {
          name: 'Blank.docx',
          mediaType: ASSISTANT_DOCX_TYPE,
          data: zip({ 'word/document.xml': `<w:document ${W}/>` }).toString('base64'),
        },
      ]),
    ).rejects.toMatchObject({
      rule: 'file_unreadable',
      message: expect.stringContaining('no words'),
    });
    await expect(
      filesForModel([
        {
          name: 'Contacts.vcf',
          mediaType: 'text/vcard',
          data: Buffer.from('BEGIN:VCARD\nVERSION:3.0\nEND:VCARD').toString('base64'),
        },
      ]),
    ).rejects.toMatchObject({
      rule: 'file_unreadable',
      message:
        'Contacts.vcf has no contacts in it. Export the contacts again from your phone or contacts app, and send that file.',
    });
  });

  it('shows a contacts file as a list of its people, never its raw lines or photos', async () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Dana Smith',
      'TEL;TYPE=CELL:512-555-0101',
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD',
      ' /2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR',
      'END:VCARD',
    ].join('\r\n');
    const [file] = await filesForModel([
      { name: 'Dana.vcf', mediaType: 'text/vcard', data: Buffer.from(vcf).toString('base64') },
    ]);
    expect(file).toMatchObject({
      kind: 'text',
      mediaType: 'text/vcard',
      text: 'A contacts file with 1 contact.\nName | Phones | Emails | Company | Job title\nDana Smith | 512-555-0101',
      // The file as sent, for the import to read whole.
      data: Buffer.from(vcf).toString('base64'),
    });
  });
});

describe('what the model is shown with a file', () => {
  it('shows the newest question’s files before its words, and only names older ones', async () => {
    const [file] = await filesForModel([
      {
        name: 'Prices.csv',
        mediaType: 'text/csv',
        data: Buffer.from('Item,Price\nMug,8').toString('base64'),
      },
    ]);
    const messages = modelMessages(
      [
        { role: 'user', text: 'Add these', pictures: 0, files: ['Old list.pdf'], actions: [] },
        { role: 'assistant', text: 'Done.', pictures: 0, files: [], actions: [] },
        { role: 'user', text: '', pictures: 0, files: ['Prices.csv'], actions: [] },
      ],
      [],
      [file!],
    );
    expect(messages[0]).toEqual({
      role: 'user',
      content: expect.stringMatching(
        /^Add these\n\(A file came with this: Old list\.pdf\. It isn’t kept/,
      ),
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '--- The file Prices.csv ---\nItem,Price\nMug,8\n--- End of Prices.csv ---',
        },
        { type: 'text', text: '(They sent only this, with no words.)' },
      ],
    });
  });
});

describe('a contract sent to make a template from', () => {
  it('makes photos of its pages one PDF, a Letter page each, in the order sent', async () => {
    const photo = async (width: number, height: number) => ({
      mediaType: 'image/jpeg' as const,
      data: (
        await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
          .jpeg()
          .toBuffer()
      ).toString('base64'),
    });
    const pdf = await PDFDocument.load(
      await photosAsPdf([await photo(600, 800), await photo(1200, 400)]),
    );
    expect(pdf.getPages().map((p) => p.getSize())).toEqual([
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ]);
  });

  it('gives each signer a key of their own, and one customer when none are named', () => {
    expect(signersOf({})).toEqual([{ key: 'customer', label: 'Customer', kind: 'customer' }]);
    expect(
      signersOf({
        signers: [
          { label: 'Tenant', kind: 'customer' },
          { label: 'Tenant', kind: 'customer' },
          { label: 'Sender', kind: 'team' },
          { label: '2nd signer!', kind: 'customer' },
          { label: '¿Qué?', kind: 'team' },
        ],
      }).map((r) => r.key),
    ).toEqual(['tenant', 'tenant_2', 'sender_2', 'nd_signer', 'que']);
  });

  it('keeps it under a name of its business and its card only', () => {
    const ws = '7b0c3c1e-8a7d-4a54-9a3a-0c1b2d3e4f50';
    const call = '0f1e2d3c-4b5a-4968-8776-655443322110';
    expect(stagedPath(ws, call)).toBe(`assistant-staging/${ws}_${call}.pdf`);
    expect(stagedOf(`${ws}_${call}.pdf`)).toEqual({ workspaceId: ws, toolCallId: call });
    expect(stagedOf('stray.pdf')).toBeNull();
    // A list of contacts waits as the CSV the import reads, and the nightly sweep knows it too.
    expect(stagedPath(ws, call, 'csv')).toBe(`assistant-staging/${ws}_${call}.csv`);
    expect(stagedOf(`${ws}_${call}.csv`)).toEqual({ workspaceId: ws, toolCallId: call });
    expect(stagedOf(`${ws}_${call}.exe`)).toBeNull();
    expect(() => stagedPath(ws, '../other')).toThrow();
  });
});
