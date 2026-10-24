/**
 * Stopped partway (funnels): every five minutes, the sheets whose person we know went quiet on a page half an hour
 * ago are marked stopped there, each page once (core's `form_response.mark_stopped`), which is what a workflow's
 * "Somebody stops partway through a form" starts on. The command checks again holding the row, so somebody who
 * carried on or sent it meanwhile isn't marked.
 */
import { randomUUID } from 'node:crypto';
import { executeCommand, FORM_STOPPED_MINUTES, formResponseMarkStopped } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';

export const FORM_JOBS = {
  /** Global, every few minutes (ensureRecurringJobs). */
  stopped: 'forms.stopped_sweep',
} as const;
export const FORMS_STOPPED_KEY = 'sweep:forms_stopped';

const EVERY_MS = 5 * 60_000;
/** Sheets marked a round; a busier round carries on at once. */
export const STOPPED_BATCH = 200;

/** The next sweep. */
export const nextStoppedSweep = (now: number): Date => new Date(now + EVERY_MS);

/** `forms.stopped_sweep`: the quiet sheets, each marked in its own business. */
export const formsStoppedSweep: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{ response_id: string; workspace_id: string; organization_id: string; page_id: string }>(
      tx,
      sql`select * from private.form_sheets_stopped(${FORM_STOPPED_MINUTES}, ${STOPPED_BATCH})`,
    ),
  );
  for (const d of due) {
    try {
      await executeCommand(
        ctx.db,
        formResponseMarkStopped,
        { workspaceId: d.workspace_id, responseId: d.response_id, pageId: d.page_id },
        { type: 'system', workspaceId: d.workspace_id, organizationId: d.organization_id },
        { correlationId: randomUUID(), channel: 'worker' },
      );
    } catch (e) {
      // One sheet that can't be marked mustn't hold up the rest; it's tried again next round.
      ctx.log.warn(
        { err: e, responseId: d.response_id },
        'a stopped form sheet could not be marked',
      );
    }
  }
  return {
    rescheduleAt: due.length >= STOPPED_BATCH ? new Date(ctx.now) : nextStoppedSweep(ctx.now),
  };
};

export const formJobs = {
  [FORM_JOBS.stopped]: formsStoppedSweep,
};
