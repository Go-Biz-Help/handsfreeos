/**
 * What the AI makes of a recorded call (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §9). `appointment.transcript_ready`
 * queues `appointment.call_review`: it asks the AI for a summary, the tasks the business agreed to and a follow-up
 * to the customer, and hands the answer to `call_suggestion.record`, which notes the summary on the customer's
 * timeline, adds the tasks and keeps the rest waiting for a person. The tokens count as AI usage ('meetings'). A
 * HandsFreeOS video call that isn't for an appointment (`video_call.transcript_ready`, docs/video-calls.md part 5)
 * goes the same way, and so does a phone call on the business number that someone on the team answered or placed,
 * once its words are in (`call.transcribed`, 20261027023200). A voicemail, a call the AI teammate took, and a call
 * nobody answered aren't reviewed: nobody on the team said anything on them.
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
import {
  appointments,
  appointmentTranscripts,
  calls,
  videoCalls,
  workspaces,
} from '@hfos/db/schema';
import { AiAskError, askStructured } from '../ai/ask';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

/**
 * The call a transcript is of: an appointment's, or a HandsFreeOS video call that isn't for one (part 5). Or a phone
 * call, which keeps its words on itself, so it has no transcript row.
 */
export type ReviewedCall =
  | { readonly appointmentId: string }
  | { readonly videoCallId: string }
  | { readonly callId: string };

export async function queueCallReview(
  tx: Tx,
  scope: TenantScope,
  of: ReviewedCall,
  transcriptId: string | null,
): Promise<void> {
  const key =
    'callId' in of
      ? `appointment.call_review:call:${of.callId}`
      : `appointment.call_review:${transcriptId}`;
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${scope.organizationId}, ${scope.workspaceId}, 'appointment.call_review',
          ${key}, now(),
          ${JSON.stringify({ ...of, ...(transcriptId ? { transcriptId } : {}) })}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
  );
}

/**
 * `call.transcribed`: a phone call's words are in. Reviewed when someone on the team was on it: answered in a
 * browser, on a forwarding phone or through their own cell, or placed by them (in the browser or through their cell)
 * and picked up. Not a voicemail (the caller alone), not a call the AI teammate took or placed (it already did what
 * was asked), and only once.
 */
export const onPhoneCallTranscribed: EventHandler = async (ctx) => {
  const callId = ctx.event.entityId;
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (!callId || ctx.event.entityType !== 'call' || p['status'] !== 'completed') return;
  const scope = tenantOf(ctx.scope);
  const [c] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select (k.transcript is not null and k.summary is null and not k.is_voicemail
              and k.answered_at is not null and k.answered_via is distinct from 'ai'
              and (k.answered_via in ('browser', 'forwarding', 'bridge')
                   or (k.direction = 'outbound' and k.placed_by is not null))) as ok
        from app.calls k where k.id = ${callId} and k.workspace_id = ${scope.workspaceId}`,
  );
  if (c?.ok) await queueCallReview(ctx.tx, scope, { callId }, null);
};

/** A customer's open tasks, as the AI is shown them so none is made twice ("Send the quote (due Nov 6)"). */
export async function openTasksOf(
  tx: Tx,
  workspaceId: string,
  personId: string | null,
  timeZone: string,
): Promise<string[]> {
  if (!personId) return [];
  const open = await rows<{ title: string; due_at: Date | string | null }>(
    tx,
    sql`select title, due_at from app.tasks
        where workspace_id = ${workspaceId} and person_id = ${personId} and done_at is null
        order by created_at desc limit 20`,
  );
  return open.map((t) =>
    t.due_at
      ? `${t.title} (due ${new Date(t.due_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone })})`
      : t.title,
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
  /** Who the call was with, for their open tasks. */
  readonly personId: string | null;
}

/** A phone call: its words and summary are on the call itself; the host is whoever on the team was on it. */
async function seenOfPhoneCall(tx: Tx, scope: TenantScope, callId: string): Promise<Seen | null> {
  const [c] = await tx
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspaceId, scope.workspaceId)));
  if (!c?.transcript) return null;
  const [w] = await tx
    .select({ name: workspaces.name, timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  const hostId = c.answeredByUserId ?? (c.direction === 'outbound' ? c.placedBy : null);
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
             where u.id = ${hostId}::uuid) as host`,
  );
  return {
    t: { body: c.transcript, summary: c.summary },
    title:
      c.direction === 'outbound' ? 'Phone call the business placed' : 'Phone call to the business',
    at: c.answeredAt ?? c.startedAt,
    w,
    names,
    personId: c.personId,
  };
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
  return {
    t,
    title: 'Video call',
    at: c.startedAt ?? c.createdAt,
    w,
    names,
    personId: c.personId,
  };
}

/** An appointment's call: its first booked customer, and the first of its staff as the host. */
async function seenOfAppointment(
  tx: Tx,
  scope: TenantScope,
  appointmentId: string,
  transcriptId: string,
): Promise<Seen | null> {
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
    person_id: string | null;
  }>(
    tx,
    sql`select
          (select t.person_id from app.appointment_attendees t
             where t.appointment_id = ${appointmentId}::uuid and t.status = 'booked'
             order by t.created_at limit 1) as person_id,
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
  return a
    ? { t, title: a.title, at: a.startsAt, w, names, personId: names?.person_id ?? null }
    : null;
}

export const appointmentCallReview: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = String(ctx.job.payload['appointmentId'] ?? '');
  const videoCallId = String(ctx.job.payload['videoCallId'] ?? '');
  const callId = String(ctx.job.payload['callId'] ?? '');
  const transcriptId = String(ctx.job.payload['transcriptId'] ?? '');
  const seen = await asWorker(ctx.db, scope, async (tx) => {
    const s = callId
      ? await seenOfPhoneCall(tx, scope, callId)
      : videoCallId
        ? await seenOfVideoCall(tx, scope, videoCallId, transcriptId)
        : await seenOfAppointment(tx, scope, appointmentId, transcriptId);
    // What's already on the customer's list, so the AI doesn't add it twice.
    const open = s
      ? await openTasksOf(tx, scope.workspaceId, s.personId, s.w?.timezone ?? 'America/Chicago')
      : [];
    return s ? { ...s, open } : null;
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
            openTasks: seen.open,
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
        {
          appointmentId: appointmentId || null,
          videoCallId: videoCallId || null,
          callId: callId || null,
          code: e.code,
        },
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
      // A phone call keeps its words on itself: no transcript row.
      ...(callId
        ? { callId }
        : { ...(videoCallId ? { videoCallId } : { appointmentId }), transcriptId }),
      review,
    },
    systemActor(scope),
    workerMeta(),
  );
};
