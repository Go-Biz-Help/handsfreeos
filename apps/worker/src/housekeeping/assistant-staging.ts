/**
 * A file the Assistant keeps between a card and its Confirm (docs/operations.md, "Pictures and files sent to the
 * Assistant"). What's sent with a question is gone once it's answered (assistant/attachments.ts), but a template made
 * from a contract, contacts added from a list, or an expense filed with its receipt, happen on Confirm, which can come later: so the card's PDF or CSV
 * waits in the attachments bucket, under STAGING_FOLDER, named by the business and the card. Only the worker's own key
 * reaches it there.
 *
 * Confirm takes it and removes it. Daily, at night, the rest go: each one whose card was answered, replaced or is
 * gone, and each one older than STAGING_DAYS, so a card left waiting for weeks says to send the file again. The same
 * job takes away the spreadsheets and reports it made once they're past keeping (assistant/files-out/store.ts).
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import { cleanUpMadeFiles } from '../assistant/files-out/store';
import type { JobHandler } from '../jobs';
import { nextReceiptCleanUp } from './receipts';

export const STAGING_BUCKET = 'attachments';
export const STAGING_FOLDER = 'assistant-staging';
export const STAGING_DAYS = 14;

export const STAGING_JOBS = {
  /** Global, daily at night (ensureRecurringJobs). */
  cleanUp: 'assistant_staging.clean_up',
} as const;
export const STAGING_CLEAN_UP_KEY = 'clean-up:assistant_staging';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGED = /^([0-9a-f-]{36})_([0-9a-f-]{36})\.(?:pdf|csv|jpg)$/;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * Where a card's file waits: one place a card, so asking again for the same card finds the same file. A contract
 * waits as a PDF, a list of contacts as a CSV, a receipt as the photo (a JPEG) or the PDF that was sent.
 */
export function stagedPath(
  workspaceId: string,
  toolCallId: string,
  kind: 'pdf' | 'csv' | 'jpg' = 'pdf',
): string {
  if (!UUID.test(workspaceId) || !UUID.test(toolCallId))
    throw new Error('A staged file is named by its business and its card.');
  return `${STAGING_FOLDER}/${workspaceId}_${toolCallId}.${kind}`;
}

/** The business and the card a staged file's name says, or null for a name the Assistant never writes. */
export function stagedOf(name: string): { workspaceId: string; toolCallId: string } | null {
  const m = STAGED.exec(name);
  return m && UUID.test(m[1]!) && UUID.test(m[2]!)
    ? { workspaceId: m[1]!, toolCallId: m[2]! }
    : null;
}

/** `assistant_staging.clean_up`: every staged file whose card isn't waiting anymore, or has waited too long. */
export const cleanUpStaged: JobHandler = async (ctx) => {
  const since = new Date(ctx.now - STAGING_DAYS * DAY).toISOString();
  for (const name of await ctx.store.list(STAGING_BUCKET, STAGING_FOLDER)) {
    const of = stagedOf(name);
    try {
      // Read in the card's own business: the worker sees a business's cards only there.
      const waiting = of
        ? await asWorker(ctx.db, { workspaceId: of.workspaceId }, (tx) =>
            rows<{ id: string }>(
              tx,
              sql`select id from app.assistant_tool_calls
                where id = ${of.toolCallId}::uuid and status = 'awaiting_confirmation' and created_at > ${since}::timestamptz`,
            ),
          )
        : [];
      if (!waiting.length) await ctx.store.remove(STAGING_BUCKET, `${STAGING_FOLDER}/${name}`);
    } catch (e) {
      ctx.log.warn({ err: e, name }, 'assistant staging: a staged file could not be checked');
    }
  }
  await cleanUpMadeFiles(ctx);
  return { rescheduleAt: nextReceiptCleanUp(ctx.now + MIN) };
};

export const stagingJobs = {
  [STAGING_JOBS.cleanUp]: cleanUpStaged,
};
