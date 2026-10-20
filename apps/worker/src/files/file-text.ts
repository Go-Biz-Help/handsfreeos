import {
  ATTACHMENT_MAX_BYTES,
  executeCommand,
  FILE_TEXT_CHARS,
  fileSaveText,
  HfosError,
  scheduleJob,
  sqlStateOf,
  type FileTextState,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { files } from '@hfos/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { HandlerContext } from '../handlers/types';
import type { JobContext, JobHandler, JobMap } from '../jobs';
import { MAX_ATTEMPTS } from '../outbox';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { documentText, pdfPages, tidy } from './document-text';
import { officeText } from './office-text';
import { readFileBytes } from './read';

/**
 * Words inside files (Search 5): the words of each file people add, read by the worker alone, with no provider and no
 * AI, and kept for search through `file.save_text`.
 *
 * - **`file.attached`** schedules a `file.text` job for the file, so nothing is downloaded inside the outbox's
 *   transaction. Never for knowledge files (their words are knowledge items) or port papers.
 * - **The job** never trusts the declared type, which comes from storage: it sniffs the first bytes. A PDF is read
 *   page by page (pdf.js, ./document-text.ts), plain text and CSV as written, Word and Excel by ./office-text.ts.
 *   Photos, voice notes and zips are never downloaded. 25 MB at most; 100,000 characters kept, and no reader builds
 *   more than twice that, so a small file can't make words without end. Scans, photos and voice notes are Not yet; a
 *   file's name is found all the same.
 * - **The sweep** catches up once a day, or every ten minutes while it has a full batch: files from before this,
 *   files written straight into the database (imports), and every file again when `FILE_READER` goes up.
 */

/** The reader's version. A better reader goes up one, and the sweep reads every file again. */
export const FILE_READER = 1;

export const FILE_TEXT_JOBS = { read: 'file.text', sweep: 'file.text_sweep' } as const;
export const FILE_TEXT_SWEEP_KEY = 'sweep:file_text';

export const FILE_TEXT_LIMITS = {
  /** What a person may upload (ATTACHMENT_MAX_BYTES), and what the 512 MB machine already reads for Real Estate. */
  bytes: ATTACHMENT_MAX_BYTES,
  chars: FILE_TEXT_CHARS,
  /** A PDF with fewer characters than this a page, on average, is a scan. */
  scanBelowCharsAPage: 40,
  /** The most pages or sheets whose starts are kept. */
  pages: 2_000,
} as const;

/** Files a sweep asks for at once. Jobs run one after another, so they're spread out rather than all due at once. */
const SWEEP_BATCH = 20;
const SWEEP_SPREAD_MS = 5 * 60_000;
const DAY = 86_400_000;

const jobKey = (fileId: string) => `file.text:${fileId}`;

/** What reading a file came to: its words, and where each page or sheet starts in them. */
export interface ReadText {
  readonly state: FileTextState;
  readonly text: string;
  readonly pages: readonly number[];
}

const nothing = (state: FileTextState): ReadText => ({ state, text: '', pages: [] });

/** Declared types never downloaded: photos, voice notes, videos and zips have no words to read. */
export function skippedType(mimeType: string | null): boolean {
  return /^(image|audio|video)\//.test(mimeType ?? '') || mimeType === 'application/zip';
}

/** What a file is by its first bytes, never its name or declared type; text only when it's declared as text. */
export function fileKindOf(
  bytes: Uint8Array,
  mimeType: string | null,
): 'pdf' | 'zip' | 'text' | 'unsupported' {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 8));
  if (head.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
  if (mimeType === 'text/plain' || mimeType === 'text/csv') return 'text';
  return 'unsupported';
}

/** How many characters a text holds, as Postgres counts them: a character outside the BMP is one. */
function charsIn(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * Pages or sheets as one text: each tidied, a blank line between them, and where each starts, in characters from 0.
 * Cut at 100,000 characters, and at 2,000 pages: whatever starts past the cut is left out, and the text says it was
 * cut. Each page is cut before it's tidied, never after, to twice the room left, so what tidying takes out still
 * leaves enough.
 */
export function joinPages(parts: readonly string[]): {
  text: string;
  pages: number[];
  cut: boolean;
} {
  let text = '';
  let chars = 0;
  const pages: number[] = [];
  let cut = parts.length > FILE_TEXT_LIMITS.pages;
  for (const raw of parts.slice(0, FILE_TEXT_LIMITS.pages)) {
    if (pages.length) {
      text += '\n\n';
      chars += 2;
    }
    if (text.length >= FILE_TEXT_LIMITS.chars) {
      cut = true;
      break;
    }
    pages.push(chars);
    const room = 2 * (FILE_TEXT_LIMITS.chars - text.length);
    if (raw.length > room) cut = true;
    const page = tidy(raw.length > room ? raw.slice(0, room) : raw);
    text += page;
    chars += charsIn(page);
  }
  if (text.length > FILE_TEXT_LIMITS.chars) {
    cut = true;
    text = text.slice(0, FILE_TEXT_LIMITS.chars);
    // Never half of a character outside the BMP.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  text = text.trimEnd();
  const kept = charsIn(text);
  return { text, pages: pages.filter((p) => p < kept), cut };
}

/** A file's words, from its bytes. */
export async function readFileText(bytes: Uint8Array, mimeType: string | null): Promise<ReadText> {
  switch (fileKindOf(bytes, mimeType)) {
    case 'pdf': {
      const pdf = await pdfPages(bytes, FILE_TEXT_LIMITS.chars);
      if (!pdf) return nothing('unreadable');
      const joined = joinPages(pdf.pages);
      const words = pdf.pages.reduce((n, page) => n + page.length, 0);
      // Next to no words a page is a scan. What little it holds is kept, and found. Pages left unread held plenty.
      const scan =
        !pdf.cut && words < FILE_TEXT_LIMITS.scanBelowCharsAPage * Math.max(1, pdf.total);
      return {
        state: scan ? 'no_text' : joined.cut || pdf.cut ? 'truncated' : 'done',
        text: joined.text,
        pages: joined.pages,
      };
    }
    case 'zip': {
      const office = officeText(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (!office.ok) return nothing(office.why === 'refused' ? 'unreadable' : 'unsupported');
      const joined = joinPages(office.parts);
      if (!joined.text) return nothing('no_text');
      return {
        state: joined.cut || office.cut ? 'truncated' : 'done',
        text: joined.text,
        // A Word document has no pages of its own in it; a workbook's sheets do.
        pages: office.kind === 'excel' ? joined.pages : [],
      };
    }
    case 'text': {
      const read = await documentText(bytes, 'text', FILE_TEXT_LIMITS.chars);
      const state: FileTextState =
        read.note === null ? 'done' : read.note === 'too_large' ? 'too_large' : read.note;
      return { state, text: read.text, pages: [] };
    }
    case 'unsupported':
      return nothing('unsupported');
  }
}

/**
 * Keeps what was read. A file deleted or put in the bin meanwhile is "File not found.", and is let be. Any other
 * database error is thrown again as `file.save_text failed: <SQLSTATE>`, with no message, cause or parameters: Drizzle
 * puts a statement's parameters in its error, and those hold the file's words, which the job's log and its row would
 * keep after the file is deleted for good.
 */
async function saveText(
  ctx: JobContext,
  scope: TenantScope,
  fileId: string,
  read: ReadText,
): Promise<void> {
  try {
    await executeCommand(
      ctx.db,
      fileSaveText,
      {
        workspaceId: scope.workspaceId,
        fileId,
        state: read.state,
        text: read.text,
        pages: [...read.pages],
        reader: FILE_READER,
      },
      systemActor(scope),
      workerMeta(),
    );
  } catch (e) {
    if (e instanceof HfosError && e.status === 404) {
      ctx.log.info({ fileId }, 'file removed before its words were kept');
      return;
    }
    if (e instanceof HfosError) throw e;
    throw new Error(`file.save_text failed: ${sqlStateOf(e) ?? 'unknown'}`);
  }
}

/** `file.attached`: queue reading the file's words, unless it's a knowledge file or port papers. */
export async function onFileText(ctx: HandlerContext): Promise<void> {
  const { fileId } = ctx.event.payload as { fileId?: string };
  if (!fileId) throw new Error(`${ctx.event.eventType} payload is missing fileId`);
  const [file] = await rows<{ record_type: string }>(
    ctx.tx,
    sql`select record_type::text as record_type from app.files
        where id = ${fileId}::uuid and workspace_id = ${ctx.event.workspaceId}`,
  );
  if (!file || file.record_type === 'knowledge' || file.record_type === 'port') return;
  await scheduleJob(ctx.tx, {
    kind: FILE_TEXT_JOBS.read,
    dedupeKey: jobKey(fileId),
    runAt: new Date(),
    payload: { fileId },
    workspaceId: ctx.event.workspaceId,
    organizationId: ctx.event.organizationId,
  });
}

/** One file's words, read and kept. */
export const fileTextJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const fileId = String(ctx.job.payload['fileId'] ?? '');
  if (!fileId) return;
  const [file] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select({ mimeType: files.mimeType, recordType: files.recordType })
      .from(files)
      .where(
        and(
          eq(files.id, fileId),
          eq(files.workspaceId, scope.workspaceId),
          eq(files.status, 'ready'),
          isNull(files.deletedAt),
        ),
      ),
  );
  // Deleted, in the bin or never finished: nothing to read, and the sweep never asks for it again.
  if (!file || file.recordType === 'knowledge' || file.recordType === 'port') return;
  if (skippedType(file.mimeType)) return saveText(ctx, scope, fileId, nothing('unsupported'));
  let read: ReadText;
  try {
    const bytes = await readFileBytes(ctx, scope, fileId, FILE_TEXT_LIMITS.bytes);
    if (!bytes.ok && bytes.why === 'removed') return;
    read = bytes.ok ? await readFileText(bytes.bytes, bytes.mimeType) : nothing('too_large');
  } catch (e) {
    // Storage not answering: try again later. The last try keeps the file as unreadable, so the sweep lets it be.
    if (ctx.attempt < MAX_ATTEMPTS) throw e;
    ctx.log.error({ err: e, fileId }, 'file words could not be read');
    read = nothing('unreadable');
  }
  await saveText(ctx, scope, fileId, read);
};

/** The sweep's batch as jobs: each due a little after the one before, over five minutes; back soon only when full. */
export function sweepPlan(
  found: readonly { readonly file_id: string }[],
  now: number,
): { runAt: Map<string, Date>; rescheduleAt: Date } {
  const runAt = new Map(
    found.map((f, i) => [
      f.file_id,
      new Date(now + Math.floor((i * SWEEP_SPREAD_MS) / SWEEP_BATCH)),
    ]),
  );
  return {
    runAt,
    rescheduleAt: new Date(now + (found.length >= SWEEP_BATCH ? 10 * 60_000 : DAY)),
  };
}

/** Across every business: files with no words yet, or read by an older reader, each queued in its own business. */
export const fileTextSweep: JobHandler = async (ctx) => {
  const found = await asWorker(ctx.db, {}, (tx) =>
    rows<{ file_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select file_id, workspace_id, organization_id
          from private.files_without_text(${SWEEP_BATCH}, ${FILE_READER}::smallint)`,
    ),
  );
  const plan = sweepPlan(found, Date.now());
  for (const f of found) {
    const scope = { workspaceId: f.workspace_id, organizationId: f.organization_id };
    await asWorker(ctx.db, scope, (tx) =>
      scheduleJob(tx, {
        kind: FILE_TEXT_JOBS.read,
        dedupeKey: jobKey(f.file_id),
        runAt: plan.runAt.get(f.file_id)!,
        payload: { fileId: f.file_id },
        workspaceId: f.workspace_id,
        organizationId: f.organization_id,
      }),
    );
  }
  return { rescheduleAt: plan.rescheduleAt };
};

export const fileTextJobs: JobMap = {
  [FILE_TEXT_JOBS.read]: fileTextJob,
  [FILE_TEXT_JOBS.sweep]: fileTextSweep,
};
