/**
 * The AI's pass over the whole customer list (0107), started by an owner or admin (`contact_ai.start_sweep`, from
 * Settings or the Assistant). A job goes through the customers in id order, a few at a time, each one a look like
 * any other (review.ts), and writes down how far it has got after each, so the screen can show it and a restart
 * picks up where it stopped. Stopping it (`contact_ai.cancel_sweep`) is read before every customer.
 *
 * When today's AI limit or the balance runs out it waits and carries on by itself an hour later; with no AI at
 * all it stops and says so. It ends with one line in the audit log: how many it looked at and what it changed.
 */
import { randomUUID } from 'node:crypto';
import { scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError } from '../ai/ask';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { tenantOf, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { reviewPerson } from './review';

export const CONTACT_AI_SWEEP_JOB = 'contact_ai.sweep';
export const contactAiSweepKey = (sweepId: string): string => `contact_ai.sweep:${sweepId}`;
/** Customers looked at in one run of the job, before it hands the worker back. */
export const CONTACT_AI_SWEEP_BATCH = 10;
/** How long it waits when today's AI limit or the balance has run out. */
const WAIT_MS = 60 * 60_000;
/** How long it waits when the AI is busy. */
const BUSY_MS = 5 * 60_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

interface SweepRow extends Record<string, unknown> {
  id: string;
  status: string;
  instructions: string;
  tag_ids: string[];
  only_tag_id: string | null;
  fix_details: boolean;
  cursor_id: string | null;
  total: number;
  reviewed: number;
  changed: number;
  tags_added: number;
  tags_removed: number;
  details_changed: number;
  requested_by: string | null;
}

/** contact_ai.sweep_started: the pass's job, at once. */
export const onSweepStarted: EventHandler = async (ctx) => {
  const sweepId = str(ctx.event.entityId);
  if (!sweepId) return;
  const scope = tenantOf(ctx.scope);
  await scheduleJob(ctx.tx, {
    kind: CONTACT_AI_SWEEP_JOB,
    dedupeKey: contactAiSweepKey(sweepId),
    runAt: new Date(),
    payload: { sweepId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};

async function loadSweep(
  db: Parameters<typeof asWorker>[0],
  scope: TenantScope,
  id: string,
): Promise<SweepRow | null> {
  return asWorker(db, scope, async (tx) => {
    const [s] = await rows<SweepRow>(
      tx,
      sql`select id, status, instructions, tag_ids, only_tag_id, fix_details, cursor_id, total, reviewed, changed,
            tags_added, tags_removed, details_changed, requested_by
          from app.contact_ai_sweeps where id = ${id} and workspace_id = ${scope.workspaceId}`,
    );
    return s ?? null;
  });
}

/** Ends the pass (done or failed) and writes its line in the audit log. */
async function finish(
  db: Parameters<typeof asWorker>[0],
  scope: TenantScope,
  sweep: SweepRow,
  status: 'done' | 'failed',
  note: string,
  causationId: string,
): Promise<void> {
  await asWorker(db, scope, async (tx) => {
    const [ended] = await rows<SweepRow>(
      tx,
      sql`update app.contact_ai_sweeps set status = ${status}, note = ${note}, finished_at = now()
          where id = ${sweep.id} and status = 'running'
          returning reviewed, changed, tags_added, tags_removed, details_changed, total`,
    );
    if (!ended) return;
    await recordSystemEvent(tx, {
      type: 'contact_ai.sweep_finished',
      action: 'contact_ai.sweep_finished',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'contact_ai_sweep',
      entityId: sweep.id,
      payload: { sweepId: sweep.id, requestedBy: sweep.requested_by },
      before: { status: 'running' },
      after: {
        status,
        note,
        total: ended.total,
        reviewed: ended.reviewed,
        changed: ended.changed,
        tagsAdded: ended.tags_added,
        tagsRemoved: ended.tags_removed,
        detailsChanged: ended.details_changed,
      },
      correlationId: randomUUID(),
      causationId,
    });
  });
}

const doneNote = (s: SweepRow) =>
  `Looked at ${s.reviewed} of ${s.total}: ${s.changed} changed (${s.tags_added} tags on, ${s.tags_removed} off, ${s.details_changed} details).`;

/** `contact_ai.sweep`: the next few customers of a pass, then again until it's through. */
export const contactAiSweepJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const sweepId = str((ctx.job.payload as Record<string, unknown>)['sweepId']);
  if (!sweepId) return;
  let sweep = await loadSweep(ctx.db, scope, sweepId);
  if (!sweep || sweep.status !== 'running') return;
  if (!ctx.ai.provider) {
    await finish(ctx.db, scope, sweep, 'failed', 'The AI isn’t set up, so it stopped.', ctx.job.id);
    return;
  }
  const people = await asWorker(ctx.db, scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`select p.id from app.people p
          where p.workspace_id = ${scope.workspaceId} and p.archived_at is null
            ${sweep!.cursor_id ? sql`and p.id > ${sweep!.cursor_id}` : sql``}
            ${
              sweep!.only_tag_id
                ? sql`and exists (select 1 from app.record_tags rt where rt.workspace_id = p.workspace_id
                    and rt.record_type = 'person' and rt.record_id = p.id and rt.tag_id = ${sweep!.only_tag_id})`
                : sql``
            }
          order by p.id limit ${CONTACT_AI_SWEEP_BATCH}`,
    ),
  );
  if (!people.length) {
    await finish(ctx.db, scope, sweep, 'done', doneNote(sweep), ctx.job.id);
    return;
  }
  for (const person of people) {
    // Stopped by a person since the last one.
    sweep = await loadSweep(ctx.db, scope, sweepId);
    if (!sweep || sweep.status !== 'running') return;
    let result;
    try {
      result = await reviewPerson(ctx, scope, person.id, {
        trigger: 'sweep',
        sweepId,
        causeEventId: null,
        tags: true,
        tagIds: sweep.tag_ids.length ? sweep.tag_ids : null,
        details: sweep.fix_details,
        instructions: sweep.instructions,
      });
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      if (e.code === 'ai_unavailable') {
        await finish(
          ctx.db,
          scope,
          sweep,
          'failed',
          'The AI isn’t set up, so it stopped.',
          ctx.job.id,
        );
        return;
      }
      const waiting =
        e.code === 'budget_reached' || e.code === 'wallet_empty'
          ? `Waiting: ${e.message} It carries on by itself.`
          : `Waiting: the AI is busy. It carries on by itself.`;
      await asWorker(ctx.db, scope, (tx) =>
        rows(
          tx,
          sql`update app.contact_ai_sweeps set note = ${waiting.slice(0, 500)}
              where id = ${sweepId} and status = 'running'`,
        ),
      );
      const wait = e.code === 'budget_reached' || e.code === 'wallet_empty' ? WAIT_MS : BUSY_MS;
      return { rescheduleAt: new Date(ctx.now + wait) };
    }
    await asWorker(ctx.db, scope, (tx) =>
      rows(
        tx,
        sql`update app.contact_ai_sweeps set cursor_id = ${person.id}, note = null,
              reviewed = reviewed + 1,
              changed = changed + ${result.outcome === 'changed' ? 1 : 0},
              tags_added = tags_added + ${result.tagsAdded},
              tags_removed = tags_removed + ${result.tagsRemoved},
              details_changed = details_changed + ${result.detailsChanged}
            where id = ${sweepId} and status = 'running'`,
      ),
    );
  }
  // More to go: straight back into the queue.
  return { rescheduleAt: new Date(ctx.now + 1000) };
};
