/**
 * A whole list of contacts sent to the Assistant (the owner, 2026-11-25: "will this be able to add contacts via a
 * csv file or vcf file?"): a CSV, an Excel sheet or a phone's .vcf, on one card, added on Confirm by the same import
 * as Settings → Imports. Every list here is made up in the test.
 */
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_XLSX_TYPE,
  AssistantCard,
  assistantToolByName,
  personCreate,
  type AssistantFileType,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filesForModel, type AssistantModelFile } from '../src/assistant/attachments';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor } from '../src/assistant/tools-write';
import { STAGING_BUCKET, stagedPath } from '../src/housekeeping/assistant-staging';
import { admin, drain, makeWorld, run, type World } from './booking-world';
import { workbook } from './office-zip';

let w: World;

beforeAll(async () => {
  w = await makeWorld('importlist');
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

type Confirm = Extract<AssistantCard, { type: 'confirm' }>;

const ctx = (files?: AssistantModelFile[]): ToolContext => ({
  actor: { type: 'human', userId: w.owner.id, email: w.owner.email, claims: w.owner.claims },
  workspaceId: w.workspaceId,
  organizationId: w.organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
  ...(files ? { files } : {}),
});
// As the runtime runs them: with the worker's services, for its file store.
const tools = () =>
  createToolExecutor(testDbs().worker.db, null, null, '', undefined, { services: w.s });
const tool = () => assistantToolByName.get('import_contacts')!;
/** The arguments as the runtime hands them over: checked against the tool's input, defaults filled. */
const argsOf = (args: Record<string, unknown>) =>
  tool().input.parse(args) as Record<string, unknown>;
/** A file as the question carries it, read by the same code the worker reads one with. */
const sent = async (name: string, mediaType: AssistantFileType, bytes: Buffer | string) =>
  filesForModel([
    {
      name,
      mediaType,
      data: (typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).toString('base64'),
    },
  ]);
const staged = (callId: string) =>
  w.s.store.exists(STAGING_BUCKET, stagedPath(w.workspaceId, callId, 'csv'));
const prepare = async (files: AssistantModelFile[], args: Record<string, unknown>) => {
  const callId = randomUUID();
  const out = await tools().prepare(tool(), argsOf(args), ctx(files), callId);
  expect(AssistantCard.safeParse(out.card).success).toBe(true);
  return { callId, card: out.card as Confirm, result: out.result as Record<string, unknown> };
};
const confirm = (callId: string, args: Record<string, unknown>) =>
  tools().commit(tool(), argsOf(args), ctx(), { toolCallId: callId });
const field = (card: Confirm, label: string) => card.fields.find((f) => f.label === label)?.value;
const imports = () =>
  rows<{
    id: string;
    file_name: string;
    kind: string;
    status: string;
    mapping: Record<string, string>;
    created_count: number;
    skipped_count: number;
  }>(
    admin(),
    sql`select id, file_name, kind, status::text, mapping, created_count, skipped_count
        from app.imports where workspace_id = ${w.workspaceId} order by created_at`,
  );
const person = async (first: string, last: string) => {
  const [p] = await rows<{
    first_name: string;
    last_name: string;
    email: string | null;
    phone_e164: string | null;
    other_phones: { phone: string }[];
    notes: string | null;
    company: string | null;
  }>(
    admin(),
    sql`select p.first_name, p.last_name, p.email::text, p.phone_e164, p.other_phones, p.notes,
          c.name::text as company
        from app.people p left join app.companies c on c.id = p.company_id
        where p.workspace_id = ${w.workspaceId} and p.first_name = ${first} and p.last_name = ${last}`,
  );
  return p;
};

describe('a list of contacts sent with the question', () => {
  it('adds a CSV on one card, with the columns it matched and the ones the AI said', async () => {
    await run(w, personCreate, {
      workspaceId: w.workspaceId,
      firstName: 'Pat',
      lastName: 'Already',
      email: 'pat@example.com',
    });
    const csv = [
      'Name,Cell #,E-mail,Biz,Birthday',
      'Dana Smith,512-555-0101,dana@example.com,Smith Roofing,4/12',
      'Lee Park,512-555-0102,lee@example.com,,',
      ',,,,',
      'Sam Ortiz,,sam@example.com,,',
      'Pat Again,,pat@example.com,,',
    ].join('\r\n');
    const files = await sent('Leads.csv', 'text/csv', csv);
    const args = { fromFile: 1, columns: { 'Cell #': 'phone', Biz: 'company' } };
    const { callId, card, result } = await prepare(files, args);
    expect(card).toMatchObject({
      title: 'Add 4 people from Leads.csv?',
      confirmLabel: 'Add 4 people',
      fields: [
        { label: 'File', value: 'Leads.csv' },
        { label: 'People', value: 'Dana Smith, Lee Park, Sam Ortiz and 1 more' },
        {
          label: 'Columns',
          value: 'Name → Full name, Cell # → Phone, E-mail → Email, Biz → Company',
        },
        { label: 'Left out', value: 'Birthday' },
        { label: 'Rows with nothing to add', value: '1: no name, email or phone' },
        { label: 'Already in Contacts', value: 'Left as they are (matched by email, then phone)' },
      ],
    });
    expect(card.warnings.map((x) => x.text)).toEqual([
      'Nobody is messaged: adding them sends nothing.',
      'It runs in the background. Settings → Imports shows how it went, and any row it couldn’t add.',
    ]);
    expect(result).toMatchObject({ waiting: true, rows: 5, adding: 4, leftOut: ['Birthday'] });
    // Nothing is added before Confirm; the list waits where only the worker reaches it.
    expect(await imports()).toEqual([]);
    expect(await staged(callId)).toBe(true);

    // Confirm comes in another request, after the question's files are gone.
    const done = await confirm(callId, args);
    const [made] = await imports();
    expect(done).toMatchObject({
      outcome:
        'Adding 4 people from Leads.csv now, leaving anyone already in Contacts as they are. They show in Contacts as they’re added; this import’s page shows how it went.',
      command: 'import.start',
      href: `/app/w/${w.workspaceId}/imports/${made!.id}`,
    });
    expect(made).toMatchObject({
      file_name: 'Leads.csv',
      kind: 'people',
      mapping: {
        Name: 'full_name',
        'Cell #': 'phone',
        'E-mail': 'email',
        Biz: 'company',
        Birthday: 'skip',
      },
    });
    expect(await staged(callId)).toBe(false);

    await drain(w);
    const [finished] = await imports();
    // The empty row and Pat, already here by email, are skipped; Pat is left as they were.
    expect(finished).toMatchObject({ status: 'done', created_count: 3, skipped_count: 2 });
    expect(await person('Dana', 'Smith')).toMatchObject({
      email: 'dana@example.com',
      phone_e164: '+15125550101',
      company: 'Smith Roofing',
    });
    expect(await person('Sam', 'Ortiz')).toMatchObject({ email: 'sam@example.com' });
    expect(await person('Pat', 'Already')).toMatchObject({ email: 'pat@example.com' });
    expect(await person('Pat', 'Again')).toBeUndefined();

    // A second go at the same card has nothing left to add from.
    await expect(confirm(callId, args)).rejects.toMatchObject({ rule: 'assistant_file_gone' });
  });

  it('adds a phone’s .vcf, each with their numbers, emails and a note for what has no box', async () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Lopez;Maria;;;',
      'FN:Maria Lopez',
      'ORG:Lopez Dental;',
      'TITLE:Office manager',
      'TEL;type=WORK;type=VOICE:(512) 555-0300',
      'TEL;type=CELL;type=VOICE:(512) 555-0301',
      'EMAIL;type=INTERNET:maria@lopezdental.example',
      'BDAY:1985-04-12',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Fox;Qu=C3=ADnn;;;',
      'TEL;CELL:512-555-0302',
      'END:VCARD',
    ].join('\r\n');
    // Sent as plain text, as some phones label a .vcf: it's read as a contacts file all the same.
    const files = await sent('Contacts.vcf', 'text/plain', vcf);
    const [file] = files;
    expect(file).toMatchObject({ kind: 'text', mediaType: 'text/vcard' });
    expect(file!.kind === 'text' && file!.text).toBe(
      [
        'A contacts file with 2 contacts.',
        'Name | Phones | Emails | Company | Job title',
        'Maria Lopez | (512) 555-0301, (512) 555-0300 | maria@lopezdental.example | Lopez Dental | Office manager',
        'Quínn Fox | 512-555-0302',
      ].join('\n'),
    );
    const { callId, card } = await prepare(files, { fromFile: 1 });
    expect(card.title).toBe('Add 2 people from Contacts.vcf?');
    expect(field(card, 'People')).toBe('Maria Lopez, Quínn Fox');
    expect(field(card, 'Each one brings')).toBe(
      'their names, phone numbers, emails, companies and notes (job title, website and birthday go there too)',
    );
    expect(field(card, 'Columns')).toBeUndefined();
    await confirm(callId, { fromFile: 1 });
    await drain(w);
    expect(await person('Maria', 'Lopez')).toMatchObject({
      phone_e164: '+15125550301',
      other_phones: [expect.objectContaining({ phone: '+15125550300' })],
      email: 'maria@lopezdental.example',
      company: 'Lopez Dental',
      notes: 'Job title: Office manager\nBirthday: Apr 12, 1985',
    });
    expect(await person('Quínn', 'Fox')).toMatchObject({ phone_e164: '+15125550302' });
    // A contacts file holds people.
    await expect(prepare(files, { fromFile: 1, kind: 'companies' })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('adds an Excel sheet, from its first row of headings', async () => {
    const book = workbook(
      [
        ['First Name', 'Last Name', 'Mobile', 'Email'],
        ['Ava', 'Reed', '512-555-0401', 'ava@example.com'],
      ],
      'Clients',
    );
    const files = await sent('Clients.xlsx', ASSISTANT_XLSX_TYPE, book);
    const { callId, card } = await prepare(files, { fromFile: 1 });
    expect(card).toMatchObject({
      title: 'Add 1 person from Clients.xlsx?',
      confirmLabel: 'Add 1 person',
    });
    expect(field(card, 'File')).toBe('Clients.xlsx, sheet “Clients”');
    expect(field(card, 'Columns')).toBe('First Name, Last Name, Mobile → Phone, Email');
    await confirm(callId, { fromFile: 1 });
    await drain(w);
    expect(await person('Ava', 'Reed')).toMatchObject({
      phone_e164: '+15125550401',
      email: 'ava@example.com',
    });
  });

  it('says what’s wrong with a list it can’t add, and what to do', async () => {
    const csv = (text: string) => sent('List.csv', 'text/csv', text);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const pdfFile = await sent('List.pdf', 'application/pdf', Buffer.from(await pdf.save()));
    await expect(prepare(pdfFile, { fromFile: 1 })).rejects.toMatchObject({
      rule: 'contacts_not_a_list',
      message: expect.stringMatching(/^List\.pdf is a PDF, and contacts are added from a list/),
    });
    await expect(prepare([], { fromFile: 1 })).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringMatching(/^No file came with this question/),
    });
    await expect(
      prepare(await csv('Phone,Email\n512-555-0500,x@example.com'), { fromFile: 1 }),
    ).rejects.toMatchObject({
      rule: 'contacts_no_name_column',
      message: expect.stringContaining('Its columns are Phone, Email.'),
    });
    await expect(
      prepare(await csv('Name,Phone\nRay,512-555-0501'), {
        fromFile: 1,
        columns: { Nope: 'phone' },
      }),
    ).rejects.toMatchObject({
      rule: 'contacts_no_such_column',
      message: 'List.csv has no column “Nope”. Its columns are Name, Phone.',
    });
    await expect(prepare(await csv('Name,Phone\n'), { fromFile: 1 })).rejects.toMatchObject({
      rule: 'contacts_list_empty',
    });
    // A column saying who agreed to calls needs where they agreed, as the import's own screen asks.
    const consent = await csv('Name,Phone,Agreed to calls\nRay,512-555-0501,Yes');
    await expect(prepare(consent, { fromFile: 1 })).rejects.toMatchObject({
      rule: 'contacts_call_consent_where',
    });
    const { card } = await prepare(consent, {
      fromFile: 1,
      callConsentSource: 'Website form, Oct 2026',
    });
    expect(field(card, 'Agreed to calls')).toBe(
      'From “Agreed to calls”: each yes is marked agreed in writing, at Website form, Oct 2026',
    );
  });
});
