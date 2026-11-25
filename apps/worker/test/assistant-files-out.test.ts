/**
 * Files out (the owner, 25 Nov 2026: "a spreadsheet or PDF report to download or email"): make_file reads a screen's
 * look-up as the person and writes every row, or writes the rows the Assistant gave; the file is theirs alone, kept
 * for 30 days, emailed to them when they say, and to someone else on a Confirm card. Every customer here is made up.
 */
import { randomUUID } from 'node:crypto';
import {
  AssistantCard,
  assistantToolByName,
  buildFileTable,
  personCreate,
} from '@hfos/core/server';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import { rows, sql } from '@hfos/db/client';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILES_BUCKET, madeFilePath } from '../src/assistant/files-out/store';
import { fileTablePdf } from '../src/assistant/files-out/pdf';
import { columnLetters, fileTableXlsx, sheetName } from '../src/assistant/files-out/xlsx';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor } from '../src/assistant/tools-write';
import { cleanUpStaged } from '../src/housekeeping/assistant-staging';
import { workbookRows } from '../src/files/office-text';
import { admin, makeWorld, run, type World } from './booking-world';
import { consentToAssistant } from './assistant-consent';

let w: World;
let member: TestUser;
let ownerToken: string;
let memberToken: string;

beforeAll(async () => {
  w = await makeWorld('filesout');
  member = await createTestUser('filesout-member');
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  await consentToAssistant(w.owner, member);
  [ownerToken, memberToken] = await Promise.all([signInTestUser(w.owner), signInTestUser(member)]);
  for (const [firstName, lastName] of [
    ['Dana', 'Smith'],
    ['Lee', 'Park'],
    ['Sam', 'Ortiz'],
  ] as const)
    await run(w, personCreate, {
      workspaceId: w.workspaceId,
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`,
    });
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

type Confirm = Extract<AssistantCard, { type: 'confirm' }>;
type FileCard = Extract<AssistantCard, { type: 'file' }>;

const ctx = (): ToolContext => ({
  actor: { type: 'human', userId: w.owner.id, email: w.owner.email, claims: w.owner.claims },
  workspaceId: w.workspaceId,
  organizationId: w.organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});
// As the runtime runs them: with the worker's services, for its file store and mailer.
const tools = () =>
  createToolExecutor(testDbs().worker.db, null, null, '', undefined, { services: w.s });
const argsOf = (name: string, args: Record<string, unknown>) =>
  assistantToolByName.get(name)!.input.parse(args) as Record<string, unknown>;
const make = async (args: Record<string, unknown>) => {
  const out = await tools().run(
    assistantToolByName.get('make_file')!,
    argsOf('make_file', args),
    ctx(),
  );
  const file = out.card as FileCard;
  // The runtime keeps the call with what it recorded; here it's written as the runtime writes it.
  await keepCall(out.record ?? {});
  return { ...out, file, result: out.result as Record<string, unknown> };
};
const stored = (card: FileCard) =>
  w.s.store.download(FILES_BUCKET, madeFilePath(w.workspaceId, w.owner.id, card.fileKey)!);

/** What the person sees after pressing Download: the five-minute link, or the refusal. */
const link = (token: string, fileKey: string) =>
  w.app.inject({
    method: 'POST',
    url: '/v1/assistant/files/link',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: w.workspaceId, fileKey },
  });

interface Mail {
  ID: string;
  Subject: string;
}
async function mailWithFile(to: string, subject: string) {
  const env = testEnv();
  for (let i = 0; i < 50; i++) {
    const res = await fetch(
      `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const hit = ((await res.json()) as { messages: Mail[] }).messages.find((m) =>
      m.Subject.startsWith(subject),
    );
    if (hit)
      return (await (await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
        Cc: { Address: string }[];
        ReplyTo: { Address: string }[];
        From: { Name: string };
        Attachments: { FileName: string; ContentType: string }[];
      };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no email starting "${subject}" reached ${to}`);
}

describe('the files themselves', () => {
  const table = buildFileTable(
    {
      title: 'Who owes: November',
      columns: [
        { label: 'Customer', path: 'name' },
        { label: 'Owes', path: 'cents', as: 'cents', total: true },
        { label: 'Since', path: 'since' },
      ],
      records: [
        { name: 'Bob Ortiz', cents: 12_000, since: '2026-11-01' },
        { name: '=cmd|"/c calc"!A1', cents: 8_050, since: '2026-11-03' },
      ],
    },
    'America/Chicago',
  );

  it('writes a workbook any spreadsheet opens, where a formula someone typed stays words', () => {
    const read = workbookRows(fileTableXlsx(table, 'America/Chicago'));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sheet).toBe('Who owes November');
    expect(read.rows[0]).toEqual(['Customer', 'Owes', 'Since']);
    expect(read.rows[1]![0]).toBe('Bob Ortiz');
    expect(read.rows[2]![0]).toBe('=cmd|"/c calc"!A1');
    expect(read.rows[3]![0]).toBe('Total');
    expect(Number(read.rows[3]![1])).toBe(200.5);
    expect(columnLetters(0)).toBe('A');
    expect(columnLetters(27)).toBe('AB');
    expect(sheetName('[Q4] report: a/b?')).toBe('Q4 report a b');
  });

  it('writes a PDF report, turned sideways when it has more than five columns', async () => {
    const narrow = await PDFDocument.load(
      await fileTablePdf(table, 'America/Chicago', { business: 'Lone Star', made: 'Made today' }),
    );
    expect(narrow.getPageCount()).toBe(1);
    expect(narrow.getPage(0).getWidth()).toBe(612);
    const wide = buildFileTable(
      {
        title: 'Wide',
        columns: ['A', 'B', 'C', 'D', 'E', 'F'].map((label) => ({ label })),
        given: Array.from({ length: 120 }, (_, i) => [
          '日本 and ñ',
          i,
          'x',
          'y',
          'z',
          'line\nbreak',
        ]),
      },
      'America/Chicago',
    );
    const pdf = await PDFDocument.load(
      await fileTablePdf(wide, 'America/Chicago', { business: 'Lone Star', made: 'Made today' }),
    );
    expect(pdf.getPage(0).getWidth()).toBe(792);
    expect(pdf.getPageCount()).toBeGreaterThan(2);
  });
});

describe('make_file', () => {
  it('reads every page of a look-up as the person, into a spreadsheet only they can open', async () => {
    const { file, result } = await make({
      title: 'Customers',
      from: { tool: 'list_customers', input: { limit: 2 } },
      columns: [
        { label: 'Name', path: 'name' },
        { label: 'Email', path: 'email' },
      ],
    });
    expect(AssistantCard.safeParse(file).success).toBe(true);
    expect(file).toMatchObject({ type: 'file', format: 'excel', emailedTo: null });
    expect(file.name).toMatch(/^Customers \d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(result['rows']).toBe(3);
    const read = workbookRows(await stored(file));
    expect(
      read.ok &&
        read.rows
          .slice(1)
          .map((r) => r[0])
          .sort(),
    ).toEqual(['Dana Smith', 'Lee Park', 'Sam Ortiz']);

    // Download: theirs, under its name; nobody else's key opens it.
    const mine = await link(ownerToken, file.fileKey);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json()).toMatchObject({ name: file.name });
    expect(new URL(mine.json().url).searchParams.get('download')).toBe(file.name);
    const theirs = await link(memberToken, file.fileKey);
    expect(theirs.statusCode).toBe(404);
  });

  it('says what the rows have when a column’s path matches nothing', async () => {
    await expect(
      make({
        title: 'Customers',
        from: { tool: 'list_customers' },
        columns: [{ label: 'Owes', path: 'balance' }],
      }),
    ).rejects.toThrow(/No row has “balance”\. Its rows have: .*name/);
    await expect(
      make({ title: 'Nope', from: { tool: 'send_text' }, columns: [{ label: 'A', path: 'a' }] }),
    ).rejects.toThrow('isn’t a look-up a file can be made from');
  });

  it('makes a PDF report from the Assistant’s own rows, and emails it to them', async () => {
    const { file } = await make({
      title: 'Jobs by month',
      format: 'pdf',
      columns: [{ label: 'Month' }, { label: 'Jobs', as: 'number', total: true }],
      rows: [
        ['October', 12],
        ['November', 9],
      ],
      intro: ['21 jobs in two months.'],
      emailMe: true,
    });
    expect(file.format).toBe('pdf');
    expect(file.emailedTo).toBe(w.owner.email);
    expect((await PDFDocument.load(await stored(file))).getPageCount()).toBe(1);
    const mail = await mailWithFile(w.owner.email, 'Jobs by month');
    expect(mail.Attachments).toEqual([
      expect.objectContaining({ FileName: file.name, ContentType: 'application/pdf' }),
    ]);
    expect(mail.Text).toContain('which you asked the Assistant for');
  });

  it('sends it to someone else on a card, in the business’s name, with a copy to them', async () => {
    const { file } = await make({
      title: 'Paid in November',
      format: 'csv',
      columns: [{ label: 'Customer' }, { label: 'Paid', as: 'dollars', total: true }],
      rows: [['Bob Ortiz', 120]],
    });
    const tool = assistantToolByName.get('email_file')!;
    const args = argsOf('email_file', {
      fileKey: file.fileKey,
      to: 'books@accountant.example.test',
      note: 'For the November books.',
    });
    const callId = randomUUID();
    const prepared = await tools().prepare(tool, args, ctx(), callId);
    const card = prepared.card as Confirm;
    expect(card.fields).toEqual([
      { label: 'To', value: 'books@accountant.example.test' },
      { label: 'File', value: file.name },
      { label: 'Note', value: 'For the November books.' },
    ]);
    const done = await tools().commit(tool, args, ctx(), { toolCallId: callId });
    expect(done.outcome).toBe('Sent to books@accountant.example.test');
    const mail = await mailWithFile('books@accountant.example.test', 'Paid in November');
    expect(mail.Cc.map((c) => c.Address)).toContain(w.owner.email);
    expect(mail.ReplyTo.map((c) => c.Address)).toContain(w.owner.email);
    expect(mail.Attachments[0]).toMatchObject({ FileName: file.name });
    expect(mail.Text).toContain('For the November books.');
  });

  it('is gone after 30 days, and says so', async () => {
    const { file } = await make({ title: 'Old', columns: [{ label: 'A' }], rows: [['x']] });
    const oldKey = `20200101_${file.fileKey.slice(9)}`;
    const old = await link(ownerToken, oldKey);
    expect(old.statusCode).toBe(404);
    expect(old.json().error.message).toContain('kept 30 days');
    // The nightly clean-up takes away what's past keeping and leaves the rest.
    const path = madeFilePath(w.workspaceId, w.owner.id, oldKey)!;
    await w.s.store.upload(FILES_BUCKET, path, Buffer.from('x'), 'text/csv');
    await cleanUpStaged({
      ...w.s,
      now: Date.now(),
      job: { payload: {} },
      log: w.s.log,
    } as never);
    expect(await w.s.store.exists(FILES_BUCKET, path)).toBe(false);
    expect(
      await w.s.store.exists(FILES_BUCKET, madeFilePath(w.workspaceId, w.owner.id, file.fileKey)!),
    ).toBe(true);
  });
});

/** A make_file call as the runtime keeps it: its record, under the person's own thread. */
async function keepCall(record: Record<string, unknown>): Promise<void> {
  const [thread] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.assistant_threads (workspace_id, user_id, title)
        values (${w.workspaceId}, ${w.owner.id}, 'Files') returning id`,
  );
  const [runRow] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.assistant_runs (workspace_id, user_id, thread_id, model, status, correlation_id)
        values (${w.workspaceId}, ${w.owner.id}, ${thread!.id}, 'test', 'done', ${randomUUID()}) returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.assistant_tool_calls (workspace_id, user_id, thread_id, run_id, tool, autonomy, status, result)
        values (${w.workspaceId}, ${w.owner.id}, ${thread!.id}, ${runRow!.id}, 'make_file', 'auto', 'done',
          ${JSON.stringify(record)}::jsonb)`,
  );
}
