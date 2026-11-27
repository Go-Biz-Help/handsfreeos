/**
 * Files out (the owner, 25 Nov 2026: "a spreadsheet or PDF report to download or email"). make_file runs on its own:
 * it only looks things up, as the person, and the file is theirs alone. Emailing it to someone else (an accountant, a
 * partner) waits for their OK on a card, as every email that leaves the business does. make_qr_code is the same kind
 * of file: a page to print with a QR code for one of the business's own public pages.
 */
import { z } from 'zod';
import {
  CELL_KINDS,
  FILE_COLUMNS_MAX,
  FILE_FORMAT_IDS,
  FILE_KEEP_DAYS,
  FILE_ROWS_MAX,
  GIVEN_ROWS_MAX,
  PDF_COLUMNS_MAX,
} from './files-out';
import { define, text, type AssistantTool } from './tool-kit';

const Cell = z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]);

const FileKey = z
  .string()
  .regex(/^\d{8}_[0-9a-f-]{36}\.(?:xlsx|csv|pdf)$/)
  .describe('The file’s key, from make_file or make_qr_code');

export const filesOutTools: readonly AssistantTool[] = [
  define({
    name: 'make_file',
    description: `Make a spreadsheet (Excel or CSV) or a PDF report for the person to download, like "a spreadsheet of everyone who owes me money", "export my customers", "a PDF of last month's jobs" or "email me a list of this week's appointments". Two ways to fill it: from, a look-up that lists things (list_customers, list_tasks, money_owed or a screen's read_… tool) run again as them for every page, up to ${FILE_ROWS_MAX} rows, with each column a path into its rows (call that read tool once first to see its fields); or rows you write yourself from what you looked up, up to ${GIVEN_ROWS_MAX}, for a summary or a short report. Only what they can see goes in. A PDF fits ${PDF_COLUMNS_MAX} columns. The file is theirs alone: a card with Download shows in the chat, kept ${FILE_KEEP_DAYS} days. emailMe sends it to their own email too. To send it to someone else, call email_file after.`,
    input: z.object({
      title: text(120).describe(
        'What it is, as its name and heading: "Who owes money", "Customers"',
      ),
      format: z
        .enum(FILE_FORMAT_IDS)
        .default('excel')
        .describe('excel (the default), csv, or pdf for a report to read or print'),
      from: z
        .object({
          tool: text(80).describe(
            'A look-up that lists things, like list_customers or read_invoice_list',
          ),
          input: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'Its input, as you would call it (filters, a status); the pages are read for you',
            ),
        })
        .optional(),
      columns: z
        .array(
          z.object({
            label: text(60).describe('The column’s heading'),
            path: text(120)
              .optional()
              .describe(
                'With from: the field in each row, like "fullName", "person.fullName", "balanceCents"',
              ),
            as: z
              .enum(CELL_KINDS)
              .optional()
              .describe(
                'What the values are: text, number, dollars, cents (a whole number of cents, like balanceCents), date, datetime or yesno. Unsaid: worked out',
              ),
            total: z.boolean().optional().describe('Add this column up under the last row'),
          }),
        )
        .min(1)
        .max(FILE_COLUMNS_MAX),
      rows: z
        .array(z.array(Cell).max(FILE_COLUMNS_MAX))
        .max(GIVEN_ROWS_MAX)
        .optional()
        .describe('Without from: each row’s cells, in column order'),
      intro: z
        .array(text(300))
        .max(8)
        .optional()
        .describe(
          'Short lines above the table: what it covers ("November 1–30"), the totals in words',
        ),
      emailMe: z.boolean().optional().describe('Email it to them too (no unless they said)'),
    }),
    autonomy: 'auto',
    permission: 'assistant.use',
  }),
  define({
    name: 'email_file',
    description:
      'Email a file made with make_file or make_qr_code to someone else, like their accountant or a partner, with a short note. It goes from HandsFreeOS in their name, with replies to them and a copy to them. Waits for their OK on a card. For a customer, the same: the address on file. To email it to themselves, make_file’s emailMe.',
    input: z.object({
      fileKey: FileKey,
      to: z.email().max(254).describe('The address to send it to'),
      note: z
        .string()
        .trim()
        .max(1_000)
        .optional()
        .describe('A short note above the file, in their words'),
    }),
    autonomy: 'confirm',
    permission: 'assistant.use',
  }),
  // A QR code, as a form's Share tab, the phone's link sheet and a listing's Marketing page show one (27 Nov 2026).
  define({
    name: 'make_qr_code',
    description: `Make a QR code for one of the business’s own public pages, as a form’s Share tab and the phone show one: a page to print for a truck door, a yard sign or the counter, with the code big, the title over it and the link under it, as a PDF with a card to Download. The link is the whole one a look-up gave (list_forms or get_form for a form, get_settings for the booking page, a listing’s public page or open house sign-in); a page of this business only, never another website. The file is theirs alone, kept ${FILE_KEEP_DAYS} days. emailMe sends it to their own email too; email_file after sends it to someone else.`,
    input: z.object({
      link: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe('The page’s whole link, as the look-up gave it'),
      title: text(120).describe(
        'The words over the code: what scanning it does, like "Get a free quote" or "Book online"',
      ),
      emailMe: z.boolean().optional().describe('Email it to them too (no unless they said)'),
    }),
    autonomy: 'auto',
    permission: 'assistant.use',
  }),
];
