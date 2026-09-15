/**
 * Arming follow-up nudges (plan M7, "Other work"). When the teammate's message asks the customer something, a
 * nudge waits in case they go quiet (follow-up.ts decides when it's due, then runs it). Each message it sends
 * that asks again arms the next, up to followUp.maxNudges since the customer last wrote. A reply, a booking, a
 * hand-off or a take-over stops them: the follow-up job checks before each one.
 */
import type { TeammateConfig } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { scheduleDebouncedJob } from '../jobs';
import type { TenantScope } from '../services';
import { FIRST_NUDGE_MS, followUpJobKey, LATER_NUDGE_MS, TEAMMATE_JOBS } from './constants';

/** A message that asks them something. */
export const asksSomething = (body: string): boolean => body.includes('?');

/**
 * The teammate's messages since the customer last wrote, less the one that asked: the nudges so far. (Its
 * hand-off lines don't count: the conversation is a person's by then.)
 */
export async function nudgesSoFar(tx: Tx, conversationId: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from app.messages m
        where m.conversation_id = ${conversationId} and m.direction = 'outbound'
          and m.sent_by_teammate_id is not null and coalesce(m.client_id, '') not like 'handoff:%'
          and m.occurred_at > coalesce(
            (select max(i.occurred_at) from app.messages i
              where i.conversation_id = ${conversationId} and i.direction = 'inbound'),
            '-infinity'::timestamptz)`,
  );
  return Math.max(0, (r?.n ?? 0) - 1);
}

/**
 * After the teammate's message went out: when it asks something and follow-ups are on, the next nudge waits
 * (the first a few hours out, later ones a day apart). A later question moves it.
 */
export async function scheduleFollowUp(
  tx: Tx,
  scope: TenantScope,
  conversationId: string,
  config: TeammateConfig,
  body: string,
  now: number = Date.now(),
): Promise<void> {
  if (!config.followUp.enabled || !asksSomething(body)) return;
  const sent = await nudgesSoFar(tx, conversationId);
  if (sent >= config.followUp.maxNudges) return;
  await scheduleDebouncedJob(tx, {
    kind: TEAMMATE_JOBS.followUp,
    dedupeKey: followUpJobKey(conversationId),
    runAt: new Date(now + (sent === 0 ? FIRST_NUDGE_MS : LATER_NUDGE_MS)),
    payload: { conversationId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
}
