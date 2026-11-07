/**
 * Documents to sign (docs/documents.md): a template changed a piece at a time, its fields placed by the AI, a PDF's
 * pages read, and the signed copy opened.
 *
 * Each runs as the person, with the same rules the screens have: changing a template and placing its fields are
 * `documents.manage`, as the editor is, and wait for the person's OK on a card that says what changes. Reading the
 * pages and opening a PDF are look-ups, for whoever can see the document or template. Sending, reminding and voiding
 * are the screens' own commands (do_document_send, do_document_remind, do_document_void), each on a Confirm card.
 */
import { z } from 'zod';
import { DocumentTemplateChange } from '../documents/change';
import { uuid } from '../schemas/common';
import { define, type AssistantTool } from './tool-kit';

export const documentTools: readonly AssistantTool[] = [
  define({
    name: 'change_document_template',
    description:
      'Change a document template the way its editor does, a piece at a time: When it’s sent (one after another or all at once, Ask for a code, reminders, Out of time after, the note with the link); Who signs (add someone, rename them, make them a customer or someone on your team, move them earlier or later, take them off with their fields); a field (Who fills it in, its kind, What it asks for, Has to be filled in, Fill in from HandsFreeOS, Choices, Text size, where it sits, or take it off; leave out its id to add one); or the PDF’s words (change what a line says, add words, or put the original back). Pass only what changes: everything else on the template stays as it is. Read it first with read_document_template_get for its keys and ids, and get_document_pages for where the PDF’s words are. Documents already sent never change; fix one by voiding it and sending it again. The card shows each change before anything is saved.',
    input: z.object({
      templateId: uuid.describe('From read_document_template_list'),
      ...DocumentTemplateChange.shape,
    }),
    autonomy: 'confirm',
    permission: 'documents.manage',
  }),
  define({
    name: 'place_template_fields',
    description:
      'Place fields for me, as the template editor’s button does: the AI reads the template’s PDF and puts a field on each line, box and label that looks like one, for each person on Who signs. Fields already there stay, and a spot that already has one is skipped. It counts toward the business’s daily AI limit, and is saved only when the person says yes on the card. The template needs its PDF; check the fields it placed with read_document_template_get after, and change any with change_document_template.',
    input: z.object({ templateId: uuid.describe('From read_document_template_list') }),
    autonomy: 'confirm',
    permission: 'documents.manage',
  }),
  define({
    name: 'get_document_pages',
    description:
      'Read the words on a template’s or a sent document’s PDF, a few pages at a time, as the editor and the phone read them: each line with its box on the page (fractions from the top left, the page counted from 0), its size, font, and the colours of its words and of the page behind it. Use it to say what a contract says, and to change a line: in change_document_template’s words, or in do_document_send’s edits for one customer’s copy, with that line’s page, box and colours and its text as original. It doesn’t show fields or what was filled in (read_document_get and read_document_template_get have those).',
    input: z
      .object({
        templateId: uuid.optional().describe('A template, from read_document_template_list'),
        documentId: uuid.optional().describe('Or a sent document, from read_document_list'),
        from: z.int().min(0).max(99).default(0).describe('The first page to read, counted from 0'),
        count: z.int().min(1).max(4).default(2).describe('How many pages, up to 4'),
      })
      .refine((v) => !!v.templateId !== !!v.documentId, {
        error: 'Say which template or document, one of them.',
      }),
    autonomy: 'auto',
    permission: 'records.read',
  }),
  define({
    name: 'get_document_file',
    description:
      'Open a sent document’s PDF, as Open the signed copy does on its page: a link to the signed copy once everyone has signed (with its proof page at the end), or to the original PDF it was sent from. The link works for 5 minutes and opens the file to whoever has it, so give it only to the person asking. The signed copy is also on the customer’s Files, locked.',
    input: z.object({
      documentId: uuid.describe('From read_document_list'),
      which: z
        .enum(['signed', 'original'])
        .default('signed')
        .describe(
          'signed: the signed copy. original: the PDF as it was sent, before anyone signed',
        ),
    }),
    autonomy: 'auto',
    permission: 'records.read',
  }),
];
