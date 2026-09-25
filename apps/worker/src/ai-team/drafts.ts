/**
 * An approved draft goes out (plan M7, "Approving a held booking"). decide_draft, run by the person, claims the
 * draft and emits `ai_teammate.draft_decided`; this runs `ai_teammate.send_draft` as the worker, which carries
 * out the held changes and then the message as the teammate with the approver's name, all or nothing, once.
 *
 * A held booking is booked for real there (bookAppointment works the calendar's open times out again), so a
 * time taken since the draft was made is refused as slot_taken instead of double-booked: the conversation then
 * goes to a person with a note. Quiet hours hold the message until they end (the send_draft job).
 */
import {
  aiTeammateSendDraft,
  disclosesAi,
  executeCommandIn,
  HfosError,
  loadTeammate,
  scheduleJob,
  workspaceMessaging,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import { quietEndAt } from '../booking/deliver';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { runtimeConfigOf } from './config';
import { QUIET_GRACE_MS, sendDraftJobKey, TEAMMATE_JOBS } from './constants';
import { onCallDraftDecided } from '../ai-calls/index';
import { handOffAsSystem } from './handoff';
import { scheduleFollowUp } from './nudges';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Sends an approved draft. Returns when to try again when quiet hours held it back; otherwise it went out, had
 * already gone, or couldn't (and the conversation went to a person).
 */
export async function sendApprovedDraft(
  log: Logger,
  tx: Tx,
  scope: TenantScope,
  draftId: string,
  meta: RequestMeta,
): Promise<{ readonly waitUntil: Date | null }> {
  try {
    const { output } = await executeCommandIn(
      tx,
      aiTeammateSendDraft,
      { workspaceId: scope.workspaceId, draftId },
      systemActor(scope),
      meta,
    );
    if (output.messageId && output.conversationId && !output.duplicate) {
      const [m] = await rows<{ body_text: string | null }>(
        tx,
        sql`select body_text from app.messages where id = ${output.messageId}`,
      );
      if (m?.body_text && disclosesAi(m.body_text))
        await tx.execute(
          sql`update app.conversations set ai_disclosed_at = coalesce(ai_disclosed_at, now())
              where id = ${output.conversationId}`,
        );
      // An approved question arms a follow-up nudge, as one the teammate sends on its own does.
      const teammate = m?.body_text ? await loadTeammate(tx, scope.workspaceId) : null;
      if (teammate && m?.body_text)
        await scheduleFollowUp(
          tx,
          scope,
          output.conversationId,
          runtimeConfigOf(teammate.config),
          m.body_text,
        );
    }
    return { waitUntil: null };
  } catch (e) {
    if (!(e instanceof HfosError)) throw e;
    if (e.rule === 'draft_not_approved') return { waitUntil: null };
    if (e.rule === 'quiet_hours') {
      const m = await workspaceMessaging(tx, scope.workspaceId);
      const end =
        quietEndAt(m.settings.quietHours, m.timezone, Date.now()) ?? Date.now() + 5 * 60_000;
      return { waitUntil: new Date(end + QUIET_GRACE_MS) };
    }
    log.warn(
      { err: e.message, rule: e.rule, draftId },
      'an approved AI teammate draft couldn’t go out',
    );
    const [d] = await rows<{ conversation_id: string | null }>(
      tx,
      sql`select conversation_id from app.ai_teammate_drafts where id = ${draftId}`,
    );
    if (d?.conversation_id)
      await handOffAsSystem(
        tx,
        scope,
        d.conversation_id,
        'error',
        `The approved reply couldn’t go out: ${e.message}`,
        meta,
      ).catch((err: unknown) =>
        log.warn({ err, draftId }, 'could not hand the conversation to a person'),
      );
    return { waitUntil: null };
  }
}

/** `ai_teammate.draft_decided`: an approval sends the draft, in the outbox transaction. */
export const onDraftDecided: EventHandler = async (ctx) => {
  const e = ctx.event;
  const p = isRecord(e.payload) ? e.payload : {};
  const draftId = str(p['draftId']);
  if (!draftId || !e.workspaceId || !e.organizationId) return;
  const scope: TenantScope = { workspaceId: e.workspaceId, organizationId: e.organizationId };
  // A call draft (AI outbound calls): approved, the call is placed at the next good moment; rejected, it isn't.
  if (p['kind'] === 'call')
    return onCallDraftDecided(ctx.tx, scope, draftId, p['decision'] === 'approved');
  if (p['decision'] !== 'approved') return;
  const { waitUntil } = await sendApprovedDraft(
    ctx.log,
    ctx.tx,
    scope,
    draftId,
    workerMeta(e.correlationId, e.id),
  );
  if (waitUntil)
    await scheduleJob(ctx.tx, {
      kind: TEAMMATE_JOBS.sendDraft,
      dedupeKey: sendDraftJobKey(draftId),
      runAt: waitUntil,
      payload: { draftId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    });
};

/** `ai_teammate.send_draft`: an approved draft quiet hours held back, once they end. */
export const sendDraftJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const draftId = str(ctx.job.payload['draftId']);
  if (!draftId) return;
  const { waitUntil } = await asWorker(ctx.db, scope, (tx) =>
    sendApprovedDraft(ctx.log, tx, scope, draftId, workerMeta(null, ctx.job.id)),
  );
  return waitUntil ? { rescheduleAt: waitUntil } : undefined;
};
