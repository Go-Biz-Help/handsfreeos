/**
 * What the AI makes of a recorded call (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §9). `appointment.transcript_ready`
 * queues `appointment.call_review`: it asks the AI for a summary, the tasks the business agreed to and a follow-up
 * to the customer, and hands the answer to `call_suggestion.record`, which notes the summary on the customer's
 * timeline and keeps the rest waiting for a person. The tokens count as AI usage ('meetings'). A HandsFreeOS video
 * call that isn't for an appointment (`video_call.transcript_ready`, docs/video-calls.md part 5) goes the same way.
 */
import { and, eq } from 'drizzle-orm';
import {
  CALL_REVIEW_JSON_SCHEMA,
  CALL_REVIEW_SYSTEM,
  CallReview,
  callReviewPrompt,
  callSuggestionRecord,
  executeCommand,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { appointments, appointmentTranscripts, videoCalls, workspaces } from '@hfos/db/schema';
import { AiAskError, askStructured } from '../ai/ask';
import type { JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

/** The call a transcript is of: an appointment's, or a HandsFreeOS video call that isn't for one (part 5). */
export type ReviewedCall = { readonly appointmentId: string } | { readonly videoCallId: string };

export async function queueCallReview(
  tx: Tx,
  scope: TenantScope,
  of: ReviewedCall,
  transcriptId: string,
): Promise<void> {
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${scope.organizationId}, ${scope.workspaceId}, 'appointment.call_review',
          ${`appointment.call_review:${transcriptId}`}, now(),
          ${JSON.stringify({ ...of, transcriptId })}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
  );
}

/** What the AI is told about the call, besides what was said. */
interface Seen {
  readonly t: { readonly body: string; readonly summary: string | null } | undefined;
  readonly title: string;
  readonly at: Date;
  readonly w: { readonly name: string; readonly timezone: string } | undefined;
  readonly names:
    { customer: string | null; on_file: string | null; host: string | null } | undefined;
}

/** A video call that isn't for an appointment: its customer and host, as an appointment's are read below. */
async function seenOfVideoCall(
  tx: Tx,
  scope: TenantScope,
  videoCallId: string,
  transcriptId: string,
): Promise<Seen | null> {
  const [t] = await tx
    .select()
    .from(appointmentTranscripts)
    .where(
      and(
        eq(appointmentTranscripts.id, transcriptId),
        eq(appointmentTranscripts.videoCallId, videoCallId),
      ),
    );
  const [c] = await tx.select().from(videoCalls).where(eq(videoCalls.id, videoCallId));
  if (!c) return null;
  const [w] = await tx
    .select({ name: workspaces.name, timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  const [names] = await rows<{
    customer: string | null;
    on_file: string | null;
    host: string | null;
  }>(
    tx,
    sql`select
          (select btrim(concat_ws(' ', p.first_name, p.last_name)) from app.people p
             where p.id = ${c.personId}::uuid) as customer,
          (select nullif(concat_ws(', ', 'email ' || p.email, 'phone ' || p.phone), '') from app.people p
             where p.id = ${c.personId}::uuid) as on_file,
          (select coalesce(nullif(u.full_name, ''), u.email::text) from app.users u
             where u.id = ${c.hostUserId}::uuid) as host`,
  );
  return { t, title: 'Video call', at: c.startedAt ?? c.createdAt, w, names };
}

export const appointmentCallReview: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = String(ctx.job.payload['appointmentId'] ?? '');
  const videoCallId = String(ctx.job.payload['videoCallId'] ?? '');
  const transcriptId = String(ctx.job.payload['transcriptId'] ?? '');
  const seen = await asWorker(ctx.db, scope, async (tx): Promise<Seen | null> => {
    if (videoCallId) return seenOfVideoCall(tx, scope, videoCallId, transcriptId);
    const [t] = await tx
      .select()
      .from(appointmentTranscripts)
      .where(
        and(
          eq(appointmentTranscripts.id, transcriptId),
          eq(appointmentTranscripts.appointmentId, appointmentId),
        ),
      );
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId));
    const [w] = await tx
      .select({ name: workspaces.name, timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId));
    const [names] = await rows<{
      customer: string | null;
      on_file: string | null;
      host: string | null;
    }>(
      tx,
      sql`select
            (select btrim(concat_ws(' ', p.first_name, p.last_name)) from app.appointment_attendees t
               join app.people p on p.id = t.person_id
               where t.appointment_id = ${appointmentId}::uuid and t.status = 'booked'
               order by t.created_at limit 1) as customer,
            (select nullif(concat_ws(', ', 'email ' || p.email, 'phone ' || p.phone), '')
               from app.appointment_attendees t
               join app.people p on p.id = t.person_id
               where t.appointment_id = ${appointmentId}::uuid and t.status = 'booked'
               order by t.created_at limit 1) as on_file,
            (select coalesce(nullif(u.full_name, ''), u.email::text) from app.appointment_staff s
               join app.users u on u.id = s.user_id
               where s.appointment_id = ${appointmentId}::uuid order by s.role limit 1) as host`,
    );
    return a ? { t, title: a.title, at: a.startsAt, w, names } : null;
  });
  // Gone, or already reviewed.
  if (!seen?.t || seen.t.summary !== null) return;
  const when = seen.at.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: seen.w?.timezone ?? 'America/Chicago',
  });
  let review: CallReview;
  try {
    const answer = await askStructured(ctx, scope, {
      system: CALL_REVIEW_SYSTEM,
      messages: [
        {
          role: 'user',
          content: callReviewPrompt({
            business: seen.w?.name ?? 'the business',
            title: seen.title,
            when,
            customer: seen.names?.customer || null,
            onFile: seen.names?.on_file || null,
            host: seen.names?.host || null,
            transcript: seen.t.body,
          }),
        },
      ],
      schema: CALL_REVIEW_JSON_SCHEMA as unknown as Record<string, unknown>,
      zod: CallReview,
      maxTokens: 1500,
      usage: { source: 'meetings' },
    });
    review = answer.value;
  } catch (e) {
    // Out of budget, no AI, or an answer in the wrong shape: the transcript stays, with no review.
    if (e instanceof AiAskError && !e.retryable) {
      ctx.log.warn(
        { appointmentId: appointmentId || null, videoCallId: videoCallId || null, code: e.code },
        'a call review was skipped',
      );
      return;
    }
    throw e;
  }
  await executeCommand(
    ctx.db,
    callSuggestionRecord,
    {
      workspaceId: scope.workspaceId,
      ...(videoCallId ? { videoCallId } : { appointmentId }),
      transcriptId,
      review,
    },
    systemActor(scope),
    workerMeta(),
  );
};
