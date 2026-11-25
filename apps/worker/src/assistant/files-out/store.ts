/**
 * Where a file the Assistant made waits (assistant/files-out.ts in core): the attachments bucket, under FILES_FOLDER,
 * named by the day it was made, its business, the person who asked and its own id. Only the worker's key reaches the
 * folder, and the worker hands it out only to the person its name says (assistant/routes.ts, `files/link`), so
 * nobody else in the business can open it, whatever they can see.
 *
 * Kept FILE_KEEP_DAYS from the day it was made; the nightly `assistant_staging.clean_up` takes the older ones away.
 */
import { FILE_KEEP_DAYS } from '@hfos/core/server';
import type { JobContext } from '../../jobs';

export const FILES_BUCKET = 'attachments';
export const FILES_FOLDER = 'assistant-files';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^(\d{8})_([0-9a-f-]{36})\.(xlsx|csv|pdf)$/;
const STORED = /^(\d{8})_([0-9a-f-]{36})_([0-9a-f-]{36})_([0-9a-f-]{36})\.(xlsx|csv|pdf)$/;
const DAY_MS = 86_400_000;

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10).replace(/-/g, '');

/** The card's key for a new file: the day (UTC) and its id, "20261125_<id>.xlsx". */
export function fileKeyOf(at: number, fileId: string, ext: string): string {
  const key = `${dayOf(at)}_${fileId}.${ext}`;
  if (!KEY.test(key) || !UUID.test(fileId))
    throw new Error('A made file is named by its day and its id.');
  return key;
}

/** Where the file a key names is kept, for this person in this business. Null for a key the Assistant never writes. */
export function madeFilePath(workspaceId: string, userId: string, fileKey: string): string | null {
  const m = KEY.exec(fileKey);
  if (!m || !UUID.test(m[2]!) || !UUID.test(workspaceId) || !UUID.test(userId)) return null;
  return `${FILES_FOLDER}/${m[1]}_${workspaceId}_${userId}_${m[2]}.${m[3]}`;
}

/** Whether a key's file is past keeping: made more than FILE_KEEP_DAYS days ago. */
export function madeFileGone(fileKey: string, now: number): boolean {
  const m = KEY.exec(fileKey);
  return !m || madeOn(m[1]!) < now - FILE_KEEP_DAYS * DAY_MS;
}

const madeOn = (day: string) =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)));

/** Part of `assistant_staging.clean_up`: every made file older than FILE_KEEP_DAYS, and any name it never writes. */
export async function cleanUpMadeFiles(
  ctx: Pick<JobContext, 'store' | 'log' | 'now'>,
): Promise<number> {
  let removed = 0;
  for (const name of await ctx.store.list(FILES_BUCKET, FILES_FOLDER)) {
    const m = STORED.exec(name);
    if (m && madeOn(m[1]!) >= ctx.now - (FILE_KEEP_DAYS + 1) * DAY_MS) continue;
    try {
      await ctx.store.remove(FILES_BUCKET, `${FILES_FOLDER}/${name}`);
      removed += 1;
    } catch (e) {
      ctx.log.warn({ err: e, name }, 'assistant files: a made file could not be removed');
    }
  }
  return removed;
}
