/**
 * Follow-up nudges (plan M7, "Other work"), `ai_teammate.follow_up`: the customer went quiet after the teammate
 * asked them something (nudges.ts armed it). Before each nudge it checks that it still should: the teammate still
 * has the conversation (no hand-off, no take-over), they haven't written since, nothing got booked, no draft
 * waits for a person, and the cap isn't reached. Then it waits for the teammate's working hours (and, for a text,
 * the end of quiet hours) and runs the nudge (run.ts runNudge), which in training becomes a draft.
 */
import { eq } from 'drizzle-orm';
import { loadTeammate, openHoursOf, workspaceMessaging } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { quietEndAt } from '../booking/deliver';
import type { JobHandler } from '../jobs';
import { tenantOf } from '../services';
import { answersChannel, runtimeConfigOf } from './config';
import { QUIET_GRACE_MS, TEAMMATE_JOBS } from './constants';
import { nextWorkingAt } from './hours';
import { asksSomething, nudgesSoFar } from './nudges';
import { runNudge } from './run';

type Due = { readonly wait: Date } | { readonly n: number; readonly lastAt: number };

export const followUpJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const conversationId =
    typeof ctx.job.payload['conversationId'] === 'string'
      ? ctx.job.payload['conversationId']
      : null;
  if (!conversationId) return;
  const due = await asWorker(ctx.db, scope, async (tx): Promise<Due | null> => {
    const teammate = await loadTeammate(tx, scope.workspaceId);
    if (!teammate || teammate.status === 'off') return null;
    const config = runtimeConfigOf(teammate.config);
    if (!config.followUp.enabled) return null;
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (
      !conv ||
      conv.handledBy !== 'ai' ||
      conv.aiTeammateId !== teammate.id ||
      !answersChannel(config, conv.channel)
    )
      return null;
    const [last] = await rows<{ body_text: string | null; occurred_at: Date | string }>(
      tx,
      sql`select body_text, occurred_at from app.messages
          where conversation_id = ${conv.id} and direction = 'outbound' and sent_by_teammate_id is not null
          order by occurred_at desc, created_at desc limit 1`,
    );
    if (!last?.body_text || !asksSomething(last.body_text)) return null;
    const lastAt = new Date(last.occurred_at);
    const [since] = await rows<{ wrote: boolean; booked: boolean; waiting: boolean }>(
      tx,
      sql`select
            exists (select 1 from app.messages m where m.conversation_id = ${conv.id}
              and m.direction = 'inbound' and m.occurred_at > ${lastAt.toISOString()}::timestamptz) as wrote,
            exists (select 1 from app.appointment_attendees t where t.workspace_id = ${scope.workspaceId}
              and t.person_id = ${conv.personId} and t.status = 'booked'
              and t.created_at > ${lastAt.toISOString()}::timestamptz) as booked,
            exists (select 1 from app.ai_teammate_drafts d where d.conversation_id = ${conv.id}
              and d.status = 'pending') as waiting`,
    );
    if (since?.wrote || since?.booked || since?.waiting) return null;
    const sent = await nudgesSoFar(tx, conv.id);
    if (sent >= config.followUp.maxNudges) return null;
    const m = await workspaceMessaging(tx, scope.workspaceId);
    const tz = m.timezone || 'UTC';
    const now = Date.now();
    const working = nextWorkingAt(config, openHoursOf(m.rawSettings), tz, now);
    if (working > now) return { wait: new Date(working) };
    if (conv.channel === 'sms') {
      const end = quietEndAt(m.settings.quietHours, tz, now);
      if (end !== null) return { wait: new Date(end + QUIET_GRACE_MS) };
    }
    return { n: sent + 1, lastAt: lastAt.getTime() };
  });
  if (!due) return;
  if ('wait' in due) return { rescheduleAt: due.wait };
  return runNudge(ctx, scope, conversationId, due, TEAMMATE_JOBS.followUp);
};
