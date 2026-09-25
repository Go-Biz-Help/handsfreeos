/**
 * Draft expiry (plan M7, pitfall 5). A draft nobody decides in its time (autonomy.draftExpiresMinutes) is marked
 * expired, by 'system', and its conversation goes to a person with reason draft_expired, the customer hearing
 * the hand-off line. The worker reads one business at a time, so each business has one sweep job, due when its
 * next draft expires (run.ts books it as it makes a draft): it expires everything due, then books itself for the
 * next. Playwright's route runs it at once (test-routes.ts).
 */
import { randomUUID } from 'node:crypto';
import { loadTeammate, scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { tenantOf, workerMeta, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { runtimeConfigOf } from './config';
import { expireDraftsJobKey, TEAMMATE_JOBS } from './constants';
import { handOffAsSystem } from './handoff';

/** The business's sweep, due by `at` (an earlier draft pulls it earlier). */
export async function scheduleExpirySweep(tx: Tx, scope: TenantScope, at: Date): Promise<void> {
  await scheduleJob(
    tx,
    {
      kind: TEAMMATE_JOBS.expireDrafts,
      dedupeKey: expireDraftsJobKey(scope.workspaceId),
      runAt: at,
      payload: {},
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

const waited = (minutes: number): string =>
  minutes === 60
    ? 'an hour'
    : minutes > 60 && minutes % 60 === 0
      ? `${minutes / 60} hours`
      : `${minutes} minutes`;

/** Expires the business's drafts that are due, one at a time; returns how many, and when the next one is due. */
export async function expireDueDrafts(
  db: Db,
  scope: TenantScope,
): Promise<{ readonly expired: number; readonly next: Date | null }> {
  let expired = 0;
  for (let i = 0; i < 500; i++) {
    const one = await asWorker(db, scope, async (tx) => {
      const [d] = await rows<{
        id: string;
        kind: string;
        conversation_id: string | null;
        person_id: string | null;
        teammate_id: string;
      }>(
        tx,
        sql`select id, kind, conversation_id, person_id, teammate_id from app.ai_teammate_drafts
            where workspace_id = ${scope.workspaceId} and status = 'pending' and expires_at <= now()
            order by expires_at, id limit 1
            for update skip locked`,
      );
      if (!d) return false;
      const teammate = await loadTeammate(tx, scope.workspaceId, { teammateId: d.teammate_id });
      const minutes = teammate
        ? ` in ${waited(runtimeConfigOf(teammate.config).autonomy.draftExpiresMinutes)}`
        : ' in time';
      const note =
        d.kind === 'approval'
          ? `Nobody decided its discount request${minutes}, and the customer is waiting to hear back.`
          : `Nobody approved its reply${minutes}, so a person should answer.`;
      await tx.execute(
        sql`update app.ai_teammate_drafts
            set status = 'expired', decided_at = now(), via = 'system', reason = 'Nobody decided it in time.'
            where id = ${d.id} and status = 'pending'`,
      );
      const meta = workerMeta(null, null);
      await recordSystemEvent(tx, {
        type: 'ai_teammate.draft_expired',
        action: 'ai_teammate.expire_draft',
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        entityType: 'ai_teammate_draft',
        entityId: d.id,
        payload: {
          draftId: d.id,
          kind: d.kind,
          conversationId: d.conversation_id,
          personId: d.person_id,
          teammateId: d.teammate_id,
        },
        before: { status: 'pending' },
        after: { status: 'expired' },
        correlationId: meta.correlationId,
        causationId: randomUUID(),
      });
      // A call nobody approved in time is simply not made (AI outbound calls): nobody is waiting on it.
      if (d.kind === 'call') {
        await tx.execute(
          sql`update app.ai_calls set status = 'cancelled', reason = 'not_approved_in_time'
              where draft_id = ${d.id} and status = 'awaiting_approval'`,
        );
        return true;
      }
      if (d.conversation_id) {
        const [c] = await rows<{ handled_by: string; ai_teammate_id: string | null }>(
          tx,
          sql`select handled_by::text as handled_by, ai_teammate_id from app.conversations
              where id = ${d.conversation_id}`,
        );
        // Still the teammate's: a person answers now. (A first message's draft had no conversation yet.)
        if (c?.handled_by === 'ai' && c.ai_teammate_id === d.teammate_id)
          await handOffAsSystem(tx, scope, d.conversation_id, 'draft_expired', note, meta);
      }
      return true;
    });
    if (!one) break;
    expired++;
  }
  const [next] = await asWorker(db, scope, (tx) =>
    rows<{ at: Date | string | null }>(
      tx,
      sql`select min(expires_at) as at from app.ai_teammate_drafts
          where workspace_id = ${scope.workspaceId} and status = 'pending'`,
    ),
  );
  return { expired, next: next?.at ? new Date(next.at) : null };
}

/** `ai_teammate.expire_drafts`: one business's sweep. */
export const expireDraftsJob: JobHandler = async (ctx) => {
  const { next } = await expireDueDrafts(ctx.db, tenantOf(ctx.scope));
  return next
    ? { rescheduleAt: new Date(Math.max(next.getTime(), Date.now() + 1_000)) }
    : undefined;
};
