/**
 * Files out (the owner, 25 Nov 2026: "a spreadsheet or PDF report to download or email"). The tools are in core
 * (assistant/tools-files-out.ts), the table and its words in core's assistant/files-out.ts; here the file is made,
 * kept for its person alone (files-out/store.ts) and emailed.
 *
 * - **make_file** runs on its own: it only reads, as the person, so a look-up their role can't run refuses, and a row
 *   they can't see never comes back to be written. A screen's look-up is read page by page, up to FILE_ROWS_MAX rows.
 * - **The card** has the name and Download; the model is told not to write a link, since the file isn't a page.
 * - **make_qr_code** is the same kind of file: a page to print with a QR code for one of the business's own public
 *   pages (a form, the booking page, a listing's page), as the Share tab and the phone show one.
 * - **email_file** sends it on to someone else, from HandsFreeOS in the business's name, replies to the person and a
 *   copy to them, once they press Confirm.
 */
import { randomUUID } from 'node:crypto';
import {
  buildFileTable,
  dayTime,
  fileDetail,
  fileNameOf,
  fileTableCsv,
  FILE_FORMATS,
  FILE_KEEP_DAYS,
  FILE_ROWS_MAX,
  GIVEN_ROWS_MAX,
  HfosError,
  isPublicPagePath,
  listOf,
  PDF_COLUMNS_MAX,
  SCREEN_READS,
  screenReadName,
  valueAt,
  type AssistantCard,
  type CellKind,
  type FileColumnSpec,
  type FileFormat,
  type FileTable,
  type HumanActor,
} from '@hfos/core/server';
import { asUser, rows, sql, type Db } from '@hfos/db/client';
import { madeFileEmail } from '../emails/templates';
import type { WorkerServices } from '../services';
import { fileTablePdf } from './files-out/pdf';
import { qrCodePdf } from './files-out/qr';
import { FILES_BUCKET, fileKeyOf, madeFileGone, madeFilePath } from './files-out/store';
import { fileTableXlsx } from './files-out/xlsx';
import { publicOriginFor } from './full-links';
import type { ToolContext, ToolOutcome } from './runtime';
import { query } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;

/** A look-up read this many pages at most, whatever its pages hold. */
const PAGES_MAX = 60;
/** Bigger than this, a file isn't kept (the bucket takes 25 MB). */
const FILE_BYTES_MAX = 20 * 1024 * 1024;
/** Bigger than this, a file isn't emailed: most mail servers refuse it. */
const EMAIL_BYTES_MAX = 10 * 1024 * 1024;

const READS: ReadonlyMap<string, string> = new Map(SCREEN_READS.map((q) => [screenReadName(q), q]));
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const unavailable = () =>
  HfosError.rule('files_unavailable', 503, 'Files can’t be made right now. Try again in a minute.');

interface Me {
  user: { fullName: string };
  workspaces: { id: string; name: string }[];
}

async function whoAndWhere(db: Db, ctx: ToolContext) {
  const me = await query<Me>(db, ctx, 'account.me');
  return {
    person: me.user.fullName?.trim() || ctx.actor.email,
    business: me.workspaces.find((w) => w.id === ctx.workspaceId)?.name ?? 'HandsFreeOS',
  };
}

/** The fields a look-up's rows have, one level in, for a column whose path matched nothing. */
function fieldsOf(row: Record<string, unknown> | undefined): string {
  if (!row) return 'nothing';
  const names: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && !Array.isArray(v))
      names.push(...Object.keys(v as object).map((inner) => `${k}.${inner}`));
    else names.push(k);
  }
  return names.slice(0, 60).join(', ');
}

/**
 * One of core's own look-ups (list_customers, money_owed, list_tasks…), run as the person exactly as the model would
 * call it; what it answers, or undefined when the name isn't a look-up. The executor hands this in (tools-write.ts).
 */
export type CoreLookUp = (tool: string, input: Args) => Promise<unknown>;

/**
 * Every page of a look-up, as the person, up to FILE_ROWS_MAX rows: a screen's own query (a read_… tool), read whole
 * rather than cut short for the model, or one of core's look-ups, page after page by its nextCursor.
 */
async function recordsFrom(
  db: Db,
  ctx: ToolContext,
  from: Args,
  coreLookUp: CoreLookUp,
): Promise<{ records: Record<string, unknown>[]; more: boolean }> {
  const tool = str(from['tool']) ?? '';
  const screen = READS.get(tool) ?? (SCREEN_READS.includes(tool as never) ? tool : null);
  const base = { ...((from['input'] as Args | undefined) ?? {}) };
  delete base['cursor'];
  delete base['workspaceId'];
  const page = async (cursor: string | null): Promise<unknown> => {
    const input = cursor ? { ...base, cursor } : base;
    return screen ? query<Args>(db, ctx, screen, input) : coreLookUp(tool, input);
  };
  const records: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < PAGES_MAX; n++) {
    const answer: unknown = await page(cursor);
    if (answer === undefined)
      throw HfosError.validation(
        [{ path: 'from.tool', message: 'Use a look-up.' }],
        `${tool || 'That'} isn’t a look-up a file can be made from. Use one that lists things, like list_customers, list_tasks, money_owed or a read_… tool.`,
      );
    const list = listOf(answer);
    if (!list)
      throw HfosError.validation(
        [{ path: 'from.tool', message: 'It gives no list.' }],
        `${tool} doesn’t give a list of rows to make a file from. Write the rows yourself, from what you looked up.`,
      );
    records.push(...list);
    const next: unknown =
      answer && typeof answer === 'object' ? (answer as Args)['nextCursor'] : null;
    cursor = typeof next === 'string' && next ? next : null;
    if (!cursor || records.length >= FILE_ROWS_MAX) break;
  }
  return {
    records: records.slice(0, FILE_ROWS_MAX),
    more: records.length > FILE_ROWS_MAX || cursor !== null,
  };
}

function columnsOf(args: Args): FileColumnSpec[] {
  const raw = Array.isArray(args['columns']) ? (args['columns'] as Args[]) : [];
  return raw.map((c) => ({
    label: String(c['label'] ?? '').trim() || 'Column',
    ...(str(c['path']) ? { path: str(c['path'])! } : {}),
    ...(typeof c['as'] === 'string' ? { as: c['as'] as CellKind } : {}),
    ...(c['total'] === true ? { total: true } : {}),
  }));
}

/** The table, from a look-up or from the Assistant's own rows. */
async function tableOf(
  db: Db,
  ctx: ToolContext,
  args: Args,
  format: FileFormat,
  coreLookUp: CoreLookUp,
): Promise<{ table: FileTable; more: boolean }> {
  const title = str(args['title']) ?? 'Report';
  const columns = columnsOf(args);
  if (format === 'pdf' && columns.length > PDF_COLUMNS_MAX)
    throw HfosError.validation(
      [{ path: 'columns', message: `At most ${PDF_COLUMNS_MAX} on a PDF.` }],
      `A PDF page fits ${PDF_COLUMNS_MAX} columns, and this has ${columns.length}. Leave some out, or make it a spreadsheet.`,
    );
  const intro = Array.isArray(args['intro']) ? (args['intro'] as unknown[]).map(String) : [];
  const from = args['from'] && typeof args['from'] === 'object' ? (args['from'] as Args) : null;
  if (from) {
    const unpathed = columns.filter((c) => !c.path).map((c) => c.label);
    if (unpathed.length)
      throw HfosError.validation(
        [{ path: 'columns', message: 'Each needs a path.' }],
        `With a look-up, each column needs the field it shows. ${unpathed.join(', ')} has none.`,
      );
    const { records, more } = await recordsFrom(db, ctx, from, coreLookUp);
    // A path no row has is a guess: say what the rows do have, so the next try can pick right.
    const missing = records.length
      ? columns.filter((c) => records.every((r) => valueAt(r, c.path!) === undefined))
      : [];
    if (missing.length)
      throw HfosError.validation(
        [{ path: 'columns', message: 'A path matched nothing.' }],
        `No row has ${missing.map((c) => `“${c.path}”`).join(' or ')}. Its rows have: ${fieldsOf(records[0])}.`,
      );
    return { table: buildFileTable({ title, intro, columns, records }, ctx.timezone), more };
  }
  const rows = Array.isArray(args['rows']) ? (args['rows'] as unknown[][]) : null;
  if (!rows)
    throw HfosError.validation(
      [{ path: 'rows', message: 'Give rows or from.' }],
      'A file needs its rows: give them, or a look-up to read them from.',
    );
  if (rows.length > GIVEN_ROWS_MAX)
    throw HfosError.validation(
      [{ path: 'rows', message: `At most ${GIVEN_ROWS_MAX}.` }],
      `Written out, a file holds ${GIVEN_ROWS_MAX} rows. For more, read them from a look-up.`,
    );
  return {
    table: buildFileTable({ title, intro, columns, given: rows }, ctx.timezone),
    more: false,
  };
}

async function bytesOf(
  table: FileTable,
  format: FileFormat,
  ctx: ToolContext,
  heading: { person: string; business: string },
): Promise<Buffer> {
  if (format === 'excel') return fileTableXlsx(table, ctx.timezone);
  if (format === 'csv') return Buffer.from(fileTableCsv(table, ctx.timezone), 'utf8');
  return fileTablePdf(table, ctx.timezone, {
    business: heading.business,
    made: `Made ${dayTime(new Date().toISOString(), ctx.timezone)} for ${heading.person}`,
  });
}

/** emailMe: the file to their own address, or why it didn't go. */
async function emailToThem(
  services: WorkerServices,
  ctx: ToolContext,
  file: { business: string; title: string; name: string; bytes: Buffer; mime: string },
): Promise<{ emailedTo: string | null; emailNote: string | null }> {
  if (!ctx.actor.email)
    return {
      emailedTo: null,
      emailNote: 'Not emailed: there’s no email address on their account.',
    };
  if (file.bytes.length > EMAIL_BYTES_MAX)
    return {
      emailedTo: null,
      emailNote: 'Not emailed: it’s too big for most mailboxes. Download it from the card.',
    };
  try {
    await services.mailer.send({
      to: ctx.actor.email,
      ...madeFileEmail({
        business: file.business,
        title: file.title,
        fileName: file.name,
        from: null,
        note: null,
      }),
      attachments: [{ filename: file.name, content: file.bytes, contentType: file.mime }],
    });
    return { emailedTo: ctx.actor.email, emailNote: null };
  } catch (e) {
    services.log.warn({ err: e }, 'a made file’s email did not send');
    return {
      emailedTo: null,
      emailNote: 'Not emailed: the email didn’t go. Download it from the card, or ask again.',
    };
  }
}

/** make_file: the file made, kept for them, emailed to them if they said, and a card with Download. */
export async function makeFile(
  db: Db,
  ctx: ToolContext,
  args: Args,
  services: WorkerServices | null,
  coreLookUp: CoreLookUp,
): Promise<ToolOutcome> {
  if (!services) throw unavailable();
  const format: FileFormat =
    args['format'] === 'csv' || args['format'] === 'pdf' ? args['format'] : 'excel';
  const { table, more } = await tableOf(db, ctx, args, format, coreLookUp);
  const who = await whoAndWhere(db, ctx);
  const bytes = await bytesOf(table, format, ctx, who);
  if (bytes.length > FILE_BYTES_MAX)
    throw HfosError.validation(
      [{ path: 'columns', message: 'Too big.' }],
      'That file is too big to keep. Leave some columns out, or narrow the look-up.',
    );
  const now = Date.now();
  const { ext, mime } = FILE_FORMATS[format];
  const fileKey = fileKeyOf(now, randomUUID(), ext);
  const name = fileNameOf(table.title, format, now, ctx.timezone);
  await services.store.upload(
    FILES_BUCKET,
    madeFilePath(ctx.workspaceId, ctx.actor.userId, fileKey)!,
    bytes,
    mime,
  );
  const { emailedTo, emailNote } =
    args['emailMe'] === true
      ? await emailToThem(services, ctx, {
          business: who.business,
          title: table.title,
          name,
          bytes,
          mime,
        })
      : { emailedTo: null, emailNote: null };
  const rows = table.rows.length;
  const card: AssistantCard = {
    type: 'file',
    name,
    format,
    detail: fileDetail(format, rows),
    fileKey,
    emailedTo,
  };
  return {
    result: {
      made: name,
      rows,
      ...(more
        ? {
            more: `Only the first ${FILE_ROWS_MAX.toLocaleString('en-US')} rows fit. Say so, and offer to narrow it.`,
          }
        : {}),
      fileKey,
      ...(emailedTo ? { emailedTo } : {}),
      ...(emailNote ? { emailNote } : {}),
      shown: `A card with its name and Download is under your answer, kept ${FILE_KEEP_DAYS} days. Don't write a link to it.`,
    },
    card,
    // Kept with the tool call: its name, for Download and email_file to give it again.
    record: { made: name, fileKey, rows },
  };
}

/**
 * The page a QR code opens, made whole: one of this business's own public pages, on the address those pages are on
 * (its own domain once that serves, else ours). The executor has already moved a link on one of our hosts onto that
 * address (full-links.ts, `onPublicOrigin`); a path alone is written out on it here. Anything else refuses, naming
 * the host, since a QR code to another website isn't one a screen makes.
 */
async function qrLinkOf(db: Db, ctx: ToolContext, given: string, webUrl: string): Promise<string> {
  const origin = (await publicOriginFor(db, ctx, webUrl)).replace(/\/+$/, '');
  const hosts = new Set<string>();
  for (const base of [origin, webUrl]) {
    try {
      if (base) hosts.add(new URL(base).host);
    } catch {
      // No address known (some tests).
    }
  }
  let url: URL | null = null;
  try {
    url = given.startsWith('/') && origin ? new URL(given, `${origin}/`) : new URL(given);
  } catch {
    url = null;
  }
  const ownPage = url && /^https?:$/.test(url.protocol) && isPublicPagePath(url.pathname);
  if (!url || !ownPage || !hosts.has(url.host))
    throw HfosError.validation(
      [{ path: 'link', message: 'Not one of the business’s pages.' }],
      url && ownPage === false && hosts.has(url.host)
        ? 'That page is one of the team’s own, which customers can’t open. Use the link of a form, the booking page or another page customers see.'
        : `I make QR codes for this business’s own pages only, like a form or the booking page${url ? `, and ${url.host} isn’t one of them` : ''}. Look up the page’s link first (list_forms, get_settings), then ask again.`,
    );
  return url.toString();
}

/** make_qr_code: a page to print with the code, kept for them, emailed to them if they said, and a card. */
export async function makeQrCode(
  db: Db,
  ctx: ToolContext,
  args: Args,
  services: WorkerServices | null,
  webUrl: string,
): Promise<ToolOutcome> {
  if (!services) throw unavailable();
  const link = await qrLinkOf(db, ctx, str(args['link']) ?? '', webUrl);
  const title = str(args['title']) ?? 'Scan me';
  const who = await whoAndWhere(db, ctx);
  const bytes = await qrCodePdf({ title, link, business: who.business });
  const now = Date.now();
  const { ext, mime } = FILE_FORMATS.pdf;
  const fileKey = fileKeyOf(now, randomUUID(), ext);
  const name = fileNameOf(`${title} QR code`, 'pdf', now, ctx.timezone);
  await services.store.upload(
    FILES_BUCKET,
    madeFilePath(ctx.workspaceId, ctx.actor.userId, fileKey)!,
    bytes,
    mime,
  );
  const { emailedTo, emailNote } =
    args['emailMe'] === true
      ? await emailToThem(services, ctx, {
          business: who.business,
          title: `${title} QR code`,
          name,
          bytes,
          mime,
        })
      : { emailedTo: null, emailNote: null };
  const card: AssistantCard = {
    type: 'file',
    name,
    format: 'pdf',
    detail: `PDF · QR code to print · Kept ${FILE_KEEP_DAYS} days`,
    fileKey,
    emailedTo,
  };
  return {
    result: {
      made: name,
      opens: link,
      fileKey,
      ...(emailedTo ? { emailedTo } : {}),
      ...(emailNote ? { emailNote } : {}),
      shown: `A card with its name and Download is under your answer, kept ${FILE_KEEP_DAYS} days. Don't write a link to it.`,
    },
    card,
    // Kept with the tool call: its name, for Download and email_file to give it again.
    record: { made: name, fileKey, opens: link },
  };
}

const extOf = (fileKey: string) => fileKey.slice(fileKey.lastIndexOf('.') + 1);

/**
 * The name a key's file was made with ("Who owes money 2026-11-25.xlsx"), read from the person's own make_file (or
 * make_qr_code) call
 * under their row security. "Report.xlsx" when it can't be found.
 */
export async function madeFileName(
  db: Db,
  claims: HumanActor['claims'],
  workspaceId: string,
  fileKey: string,
): Promise<string> {
  const fallback = `Report.${FILE_FORMATS[formatOfExt(extOf(fileKey))].ext}`;
  const [found] = await asUser(db, claims, (tx) =>
    rows<{ made: string | null }>(
      tx,
      sql`select result ->> 'made' as made from app.assistant_tool_calls
          where workspace_id = ${workspaceId} and tool in ('make_file', 'make_qr_code')
            and result ->> 'fileKey' = ${fileKey}
          order by created_at desc limit 1`,
    ),
  ).catch(() => []);
  const made = found?.made?.trim();
  return made && made.endsWith(`.${extOf(fileKey)}`) ? made : fallback;
}

async function madeFile(
  services: WorkerServices,
  ctx: ToolContext,
  fileKey: string,
): Promise<{ path: string; bytes: Buffer }> {
  const path = madeFilePath(ctx.workspaceId, ctx.actor.userId, fileKey);
  if (
    !path ||
    madeFileGone(fileKey, Date.now()) ||
    !(await services.store.exists(FILES_BUCKET, path))
  )
    throw HfosError.notFound(
      `That file is gone: files are kept ${FILE_KEEP_DAYS} days. Ask for it again and I’ll make a fresh one.`,
    );
  return { path, bytes: await services.store.download(FILES_BUCKET, path) };
}

/** email_file: to someone else, once they press Confirm. */
const emailFile: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId, deps) {
    const services = deps?.services ?? null;
    if (!services) throw unavailable();
    const fileKey = String(args['fileKey'] ?? '');
    const path = madeFilePath(ctx.workspaceId, ctx.actor.userId, fileKey);
    if (
      !path ||
      madeFileGone(fileKey, Date.now()) ||
      !(await services.store.exists(FILES_BUCKET, path))
    )
      throw HfosError.notFound(
        `That file is gone: files are kept ${FILE_KEEP_DAYS} days. Ask for it again and I’ll make a fresh one.`,
      );
    const note = str(args['note']);
    const who = await whoAndWhere(db, ctx);
    return {
      card: settingsCard(toolCallId, 'email_file', {
        title: 'Email this file',
        fields: [
          { label: 'To', value: String(args['to'] ?? '') },
          {
            label: 'File',
            value: await madeFileName(db, ctx.actor.claims, ctx.workspaceId, fileKey),
          },
          ...(note ? [{ label: 'Note', value: note }] : []),
        ],
        confirmLabel: 'Send it',
        warnings: [
          {
            kind: 'note',
            text: `It goes from HandsFreeOS as ${who.business}. Replies come to you, and you get a copy.`,
          },
        ],
      }),
      result: { waiting: true },
    };
  },
  async commit(db, ctx, args, extra) {
    const services = extra.services ?? null;
    if (!services) throw unavailable();
    const fileKey = String(args['fileKey'] ?? '');
    const to = String(args['to'] ?? '').trim();
    const { bytes } = await madeFile(services, ctx, fileKey);
    if (bytes.length > EMAIL_BYTES_MAX)
      throw HfosError.rule(
        'file_too_big_to_email',
        422,
        'That file is too big for most mailboxes. Download it from its card and share it another way.',
      );
    const who = await whoAndWhere(db, ctx);
    const format = formatOfExt(extOf(fileKey));
    const name = await madeFileName(db, ctx.actor.claims, ctx.workspaceId, fileKey);
    await services.mailer.send({
      to,
      ...madeFileEmail({
        business: who.business,
        title: name.replace(/ \d{4}-\d{2}-\d{2}\.\w+$|\.\w+$/, ''),
        fileName: name,
        from: who.person,
        note: str(args['note']) ?? null,
      }),
      fromName: `${who.business} via HandsFreeOS`,
      ...(ctx.actor.email ? { replyTo: ctx.actor.email, cc: [ctx.actor.email] } : {}),
      attachments: [{ filename: name, content: bytes, contentType: FILE_FORMATS[format].mime }],
    });
    return { outcome: `Sent to ${to}`, href: null, command: 'email_file' };
  },
};

function formatOfExt(ext: string): FileFormat {
  return ext === 'csv' ? 'csv' : ext === 'pdf' ? 'pdf' : 'excel';
}

export const filesOutConfirmTools: Record<string, SettingsConfirmTool> = {
  email_file: emailFile,
};

export const filesOutStepLabels: Record<string, string> = {
  make_file: 'Making the file',
  make_qr_code: 'Making the QR code',
  email_file: 'Getting the email ready',
};
