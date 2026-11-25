/**
 * Files sent with a question, made ready for the model (docs/operations.md, "Pictures and files sent to the
 * Assistant"). A PDF goes as it is, pages and all, so the model sees its layout, tables and handwriting; a long one is
 * cut to its first pages. A Word file's paragraphs and tables, a spreadsheet's rows and a text file's words are read
 * out here and go as text. Nothing is kept: like pictures, the model reads them with this one question.
 *
 * Word and Excel files are opened by the reader that finds the words in files for search (files/office-text.ts),
 * with its checks on what a zip holds, and laid out for the model there: a Word table's row on one line, a sheet's
 * cells in their columns, each sheet under its name.
 */
import {
  ASSISTANT_DOCX_TYPE,
  ASSISTANT_VCARD_TYPE,
  ASSISTANT_XLSX_TYPE,
  HfosError,
  looksLikeVcard,
  parseVcards,
  vcardName,
  type AssistantFile,
  type AssistantFileType,
} from '@hfos/core/server';
import type { AiContent } from '@hfos/ai';
import { PDFDocument } from 'pdf-lib';
import { officeLayout } from '../files/office-text';

/** The most pages of PDF one question shows the model, all its PDFs together: each page costs about 2,500 tokens. */
export const ASSISTANT_PDF_PAGES = 40;
/** The most characters of words read out of one file. About 15,000 tokens. */
export const ASSISTANT_FILE_TEXT = 60_000;

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
      /**
       * The file as it was sent, and its kind (a .vcf is a contacts file even when it came as text): what a tool
       * that reads the whole of it works from, like the contacts import. Never shown to the model, never kept.
       */
      readonly mediaType: AssistantFileType;
      readonly data: string;
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
    let cut = false;
    let mediaType: AssistantFileType = file.mediaType;
    if (file.mediaType === ASSISTANT_DOCX_TYPE || file.mediaType === ASSISTANT_XLSX_TYPE) {
      const office = officeLayout(bytes, ASSISTANT_FILE_TEXT);
      if (!office.ok) throw unreadable(file.name);
      text = office.text;
      cut = office.cut;
    } else {
      text = plainText(bytes);
      if (
        file.mediaType === ASSISTANT_VCARD_TYPE ||
        (file.mediaType === 'text/plain' && looksLikeVcard(text))
      ) {
        mediaType = ASSISTANT_VCARD_TYPE;
        text = contactsLayout(file.name, text);
      }
    }
    text = text.trim();
    if (!text) throw unreadable(file.name, 'has no words in it to read');
    cut ||= text.length > ASSISTANT_FILE_TEXT;
    out.push({
      kind: 'text',
      name: file.name,
      text: text.slice(0, ASSISTANT_FILE_TEXT),
      cut,
      mediaType,
      data: file.data,
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

// ---------- contacts ----------

/**
 * A contacts file laid out for the model: how many, then a line each with its name, numbers, emails and company. Its
 * raw lines (and any photos in them) never go: the contacts import reads the file itself.
 */
export function contactsLayout(name: string, text: string): string {
  const contacts = parseVcards(text);
  if (!contacts.length)
    throw HfosError.rule(
      'file_unreadable',
      400,
      `${name} has no contacts in it. Export the contacts again from your phone or contacts app, and send that file.`,
    );
  const lines = contacts.map((c) => {
    const cells = [
      vcardName(c),
      c.phones.join(', '),
      c.emails.join(', '),
      c.company ?? '',
      c.jobTitle ?? '',
    ];
    while (cells.length > 1 && !cells[cells.length - 1]) cells.pop();
    return cells.join(' | ');
  });
  return [
    `A contacts file with ${contacts.length === 1 ? '1 contact' : `${contacts.length} contacts`}.`,
    'Name | Phones | Emails | Company | Job title',
    ...lines,
  ].join('\n');
}

// ---------- plain text ----------

/** A text file's words: UTF-8 (a byte-order mark dropped), or Windows' Latin-1 when it isn't UTF-8. */
export function plainText(bytes: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  const broken = (utf8.match(/\uFFFD/g) ?? []).length;
  return broken > 8 && broken > utf8.length / 200 ? bytes.toString('latin1') : utf8;
}
