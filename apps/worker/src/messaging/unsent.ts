/**
 * Texts, emails and Messenger and Instagram replies the worker stopped trying to send without saying so. A send that fails on the outbox's last try
 * marks its message "Not delivered" (handlers/telephony.ts, handlers/email.ts, mailbox/send.ts), but one that failed
 * before that was in place, or whose last try stopped half way, stays queued: "Sending…" for good, and message.retry
 * turns it away as still on its way. Hourly, from a minute after the worker starts, each one the outbox gave up on in
 * the last week is marked "Not delivered", so a person can send it again.
 */
import { CANCELLED_TEXT, SCHEDULED_TEXT } from '@hfos/core';
import { executeCommand, messageUpdateStatus } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { systemActor, workerMeta } from '../services';

export const UNSENT_JOBS = {
  /** The hourly sweep. */
  sweep: 'messages.unsent_sweep',
} as const;
export const UNSENT_SWEEP_KEY = 'sweep:unsent_messages';
/** The first sweep after the worker starts. */
export const UNSENT_FIRST_SWEEP_MS = 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;

/** The events that hand a message to the sender (handlers/index.ts sends both). */
const SENDS = sql`('message.queued', 'email.private_queued')`;

export const sweepUnsent: JobHandler = async (ctx) => {
  // The outbox keeps what it gave up on for 90 days; a week back reaches anything somebody still waits on.
  const businesses = await asWorker(ctx.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select distinct workspace_id, organization_id from app.outbox
          where status = 'failed' and event_type in ${SENDS}
            and workspace_id is not null and organization_id is not null
            and created_at > now() - interval '7 days'`,
    ),
  );
  for (const b of businesses) {
    const scope = { workspaceId: b.workspace_id, organizationId: b.organization_id };
    // Still queued after the outbox gave up on its latest send: nothing sent it again or held it since, and it
    // isn't a text waiting for quiet hours to end.
    const unsent = await asWorker(ctx.db, scope, (tx) =>
      rows<{ id: string; channel: string; event_id: string }>(
        tx,
        sql`select m.id, m.channel::text as channel, e.id as event_id
            from app.outbox o
            join app.events e on e.id = o.event_id
            join app.messages m on m.id = e.entity_id and m.workspace_id = o.workspace_id
            where o.workspace_id = ${b.workspace_id} and o.status = 'failed' and o.event_type in ${SENDS}
              and o.created_at > now() - interval '7 days'
              and m.direction = 'outbound' and m.status = 'queued'
              and coalesce(m.error_code, '') not in (${SCHEDULED_TEXT}, ${CANCELLED_TEXT})
              and not exists (
                select 1 from app.events later
                where later.entity_type = 'message' and later.entity_id = m.id
                  and later.event_type in ('message.queued', 'email.private_queued', 'message.scheduled')
                  and later.created_at > e.created_at)`,
      ),
    );
    for (const m of unsent) {
      const what =
        m.channel === 'email'
          ? 'email'
          : m.channel === 'messenger' || m.channel === 'instagram'
            ? 'message'
            : 'text';
      try {
        await executeCommand(
          ctx.db,
          messageUpdateStatus,
          {
            workspaceId: scope.workspaceId,
            messageId: m.id,
            status: 'failed',
            errorCode: 'not_sent',
            errorMessage: `This ${what} didn’t go out. Try again, and if it fails again, ask HandsFreeOS support.`,
          },
          systemActor(scope),
          workerMeta(null, m.event_id),
        );
        ctx.log.warn(
          { workspaceId: scope.workspaceId, messageId: m.id },
          'a message the worker gave up sending is now marked not delivered',
        );
      } catch (e) {
        ctx.log.warn(
          { workspaceId: scope.workspaceId, messageId: m.id, err: errorMessage(e) },
          'could not mark an unsent message not delivered',
        );
      }
    }
  }
  return { rescheduleAt: new Date(Date.now() + SWEEP_EVERY_MS) };
};

export const unsentJobs = {
  [UNSENT_JOBS.sweep]: sweepUnsent,
};
