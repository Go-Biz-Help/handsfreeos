/**
 * What the AI made of a recorded call (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §9). `call_suggestion.record`
 * (the worker) keeps the summary on the transcript, writes it to the customer's timeline as a note (on the
 * appointment's record too, so a tour on a private deal leaves a note sealed with the deal), makes each task it found
 * at once (owner, 4 Nov: "it should just create the task"), and stores the follow-up and record change, which wait.
 * `call_suggestion.decide` is a person's OK or no: approving runs `message.send` or `person.update` as that person,
 * with what they edited, in the same transaction (or `task.create`, for a task that waited: while "Add tasks from
 * what you say" is off, or from before it was on).
 *
 * A HandsFreeOS video call that isn't for an appointment (docs/video-calls.md, part 5) has the same: its summary goes
 * on the call's own line on the customer's timeline instead of a note, and its suggestions are the call's. So does a
 * phone call on the business number that someone on the team answered or placed (20261027023200): it keeps its words
 * and its summary on itself, and the summary is its timeline line's body.
 */
import { and, asc, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  appointmentAttendees,
  appointments,
  appointmentStaff,
  appointmentTranscripts,
  activities,
  calls,
  callSuggestions,
  customRecords,
  people,
  videoCalls,
  workspaces,
} from '@hfos/db/schema';
import { z } from 'zod';
import { aiTaskNotes, type AiTaskSource } from '../automations/ai-task-words';
import { automationSettingsOf } from '../automations/settings';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand, defineQuery } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import { CallReview } from '../meetings/review';
import { isoDateTime, uuid } from '../schemas/common';
import { activityLog } from './activity';
import { messageSend } from './message';
import { personUpdate } from './person.update';
import { taskCreate } from './task';

const DAY = 86_400_000;
const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const TaskPreview = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(1000).nullable().default(null),
  dueAt: isoDateTime.nullable().default(null),
});
const FollowUpPreview = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
});
const CHANGE_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const;
type ChangeField = (typeof CHANGE_FIELDS)[number];
/** The new details, and what the record said when the AI suggested them (`was`), for the person to compare. */
const RecordChangePreview = z.object({
  firstName: z.string().trim().min(1).max(80).nullable().default(null),
  lastName: z.string().trim().min(1).max(80).nullable().default(null),
  email: z.email().max(254).nullable().default(null),
  phone: z.string().trim().min(7).max(40).nullable().default(null),
  was: z.record(z.string(), z.string().nullable()).default({}),
});
const same = (a: string | null | undefined, b: string | null | undefined, field: ChangeField) => {
  const norm = (v: string | null | undefined) =>
    field === 'phone'
      ? (v ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
      : (v ?? '').trim().toLowerCase();
  return norm(a) === norm(b);
};

type Tx = Parameters<typeof executeCommandWithin>[0]['tx'];

/** What the call was: an appointment's, a HandsFreeOS video call that isn't for one, or a phone call. */
type CallOf = {
  readonly appointmentId: string | null;
  readonly videoCallId: string | null;
  readonly callId: string | null;
};

/** A phone call on the business number: who it was with, who on the team was on it, and its line on the timeline. */
async function phoneCallOf(tx: Tx, workspaceId: string, callId: string) {
  const [c] = await tx
    .select({
      personId: calls.personId,
      answeredByUserId: calls.answeredByUserId,
      placedBy: calls.placedBy,
      direction: calls.direction,
      activityId: calls.activityId,
      startedAt: calls.startedAt,
      endedAt: calls.endedAt,
    })
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspaceId, workspaceId)));
  return c
    ? {
        ...c,
        // Whoever picked up, else whoever placed it.
        hostUserId: c.answeredByUserId ?? (c.direction === 'outbound' ? c.placedBy : null),
      }
    : null;
}

/** A video call that isn't for an appointment: who it was with, who hosted it, and its line on the timeline. */
async function videoCallOf(tx: Tx, workspaceId: string, videoCallId: string) {
  const [c] = await tx
    .select({
      personId: videoCalls.personId,
      hostUserId: videoCalls.hostUserId,
      activityId: videoCalls.activityId,
      startedAt: videoCalls.startedAt,
      endedAt: videoCalls.endedAt,
    })
    .from(videoCalls)
    .where(and(eq(videoCalls.id, videoCallId), eq(videoCalls.workspaceId, workspaceId)));
  return c ?? null;
}

/** Who the call was with: an appointment's first booked customer, else its lead; or the video or phone call's. */
async function customerOf(tx: Tx, workspaceId: string, of: CallOf) {
  if (of.callId) {
    const c = await phoneCallOf(tx, workspaceId, of.callId);
    return { personId: c?.personId ?? null, leadId: null };
  }
  if (!of.appointmentId) {
    const c = of.videoCallId ? await videoCallOf(tx, workspaceId, of.videoCallId) : null;
    return { personId: c?.personId ?? null, leadId: null };
  }
  const appointmentId = of.appointmentId;
  const [a] = await tx
    .select({ leadId: appointments.leadId })
    .from(appointments)
    .where(eq(appointments.id, appointmentId));
  const [first] = await tx
    .select({ personId: appointmentAttendees.personId })
    .from(appointmentAttendees)
    .where(
      and(
        eq(appointmentAttendees.appointmentId, appointmentId),
        eq(appointmentAttendees.status, 'booked'),
      ),
    )
    .orderBy(asc(appointmentAttendees.createdAt))
    .limit(1);
  return { personId: first?.personId ?? null, leadId: a?.leadId ?? null };
}

/**
 * The record the call was on, when it still reads for whoever acts. Binning a record leaves its appointments on it,
 * and one in the Deleted bin reads for nobody, the worker included, so `activity.log` and `task.create` would refuse
 * it as gone.
 */
async function recordThatReads(
  tx: Tx,
  workspaceId: string,
  customRecordId: string | null,
): Promise<string | null> {
  if (!customRecordId) return null;
  const [r] = await tx
    .select({ id: customRecords.id })
    .from(customRecords)
    .where(and(eq(customRecords.id, customRecordId), eq(customRecords.workspaceId, workspaceId)));
  return r?.id ?? null;
}

type SuggestionKind = 'task' | 'follow_up' | 'record_change';

/** A record change only when the customer is on file and something actually differs from what's there. */
async function recordChangeRow(
  tx: Tx,
  workspaceId: string,
  personId: string | null,
  changes: CallReview['recordChanges'],
): Promise<{ kind: 'record_change'; preview: Record<string, unknown> }[]> {
  if (!personId || !changes) return [];
  const [p] = await tx
    .select({
      firstName: people.firstName,
      lastName: people.lastName,
      email: people.email,
      phone: people.phone,
    })
    .from(people)
    .where(and(eq(people.id, personId), eq(people.workspaceId, workspaceId)));
  if (!p) return [];
  const preview: Record<string, unknown> = {};
  const was: Record<string, string | null> = {};
  for (const f of CHANGE_FIELDS) {
    const next = changes[f];
    const now = (p[f] as string | null) ?? null;
    if (next && !same(next, now, f)) {
      preview[f] = next;
      was[f] = now;
    }
  }
  if (!Object.keys(was).length) return [];
  return [{ kind: 'record_change', preview: { ...preview, was } }];
}

/** The call: an appointment's, a video call that isn't for one, or a phone call. */
const CallInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid.optional(),
  videoCallId: uuid.optional(),
  /** A phone call on the business number (20261027023200). */
  callId: uuid.optional(),
});
type CallRef = { appointmentId?: string; videoCallId?: string; callId?: string };
const oneCall = (i: CallRef) =>
  [i.appointmentId, i.videoCallId, i.callId].filter(Boolean).length === 1;
const ONE_CALL = {
  error: 'Name one call: the appointment, the video call or the phone call.',
} as const;
const callOf = (i: CallRef): CallOf => ({
  appointmentId: i.appointmentId ?? null,
  videoCallId: i.videoCallId ?? null,
  callId: i.callId ?? null,
});
/** Where a suggestion's events say it is. */
const entityOf = (of: CallOf) =>
  of.appointmentId
    ? { entityType: 'appointment', entityId: of.appointmentId }
    : of.callId
      ? { entityType: 'call', entityId: of.callId }
      : { entityType: 'video_call', entityId: of.videoCallId! };
/** What a task the AI made says it came from. */
const sourceOf = (of: CallOf): AiTaskSource => (of.callId ? 'phone_call' : 'video_call');

/** A task's title, notes and due date, as the AI suggested them or a person edited them. */
type TaskFields = z.infer<typeof TaskPreview>;

/**
 * Makes a call's task: given to the call's host, about its customer, on the call's record too, so a task from a tour
 * on a private deal is sealed with the deal, as its summary note is. On a private record, only a host who is on it
 * gets it. A private record never goes in the bin, and whoever sees its sealed appointment sees it, so one that
 * doesn't read here was just taken away; made without it, the task would show to everyone, so it isn't made.
 */
async function makeCallTask(
  ctx: Parameters<typeof executeCommandWithin>[0],
  ws: string,
  of: CallOf,
  who: { personId: string | null; leadId: string | null },
  p: TaskFields,
): Promise<string> {
  const [appt] = of.appointmentId
    ? await ctx.tx
        .select({ customRecordId: appointments.customRecordId, sealed: appointments.sealed })
        .from(appointments)
        .where(eq(appointments.id, of.appointmentId))
    : [];
  const record = await recordThatReads(ctx.tx, ws, appt?.customRecordId ?? null);
  if (appt?.sealed && !record)
    throw HfosError.notFound(
      'The record this call was on isn’t there anymore, so its task can’t be made. Refresh and try again.',
    );
  const [host] = of.appointmentId
    ? await ctx.tx
        .select({ userId: appointmentStaff.userId })
        .from(appointmentStaff)
        .where(eq(appointmentStaff.appointmentId, of.appointmentId))
        .orderBy(asc(appointmentStaff.role))
        .limit(1)
    : of.callId
      ? await (async () => {
          const c = await phoneCallOf(ctx.tx, ws, of.callId!);
          return c?.hostUserId ? [{ userId: c.hostUserId }] : [];
        })()
      : await (async () => {
          const c = await videoCallOf(ctx.tx, ws, of.videoCallId!);
          return c?.hostUserId ? [{ userId: c.hostUserId }] : [];
        })();
  const [onRecord] =
    host && record
      ? await rows<{ ok: boolean }>(
          ctx.tx,
          sql`select private.user_sees_record(${host.userId}::uuid, ${record}::uuid) as ok`,
        )
      : [{ ok: true }];
  const made = await executeCommandWithin(ctx, taskCreate, {
    workspaceId: ws,
    title: p.title,
    ...(p.notes ? { notes: p.notes } : {}),
    dueAt: p.dueAt,
    ...(host && onRecord?.ok ? { assigneeUserId: host.userId } : {}),
    ...(who.personId ? { personId: who.personId } : {}),
    ...(who.leadId ? { leadId: who.leadId } : {}),
    ...(record ? { customRecordId: record } : {}),
  });
  return made.output.taskId;
}

/** The customer's name as a sentence says it ("Mike Johnson"), or null. */
async function customerName(tx: Tx, workspaceId: string, personId: string | null) {
  if (!personId) return null;
  const [p] = await tx
    .select({ firstName: people.firstName, lastName: people.lastName })
    .from(people)
    .where(and(eq(people.id, personId), eq(people.workspaceId, workspaceId)));
  return p ? `${p.firstName} ${p.lastName}`.trim() || null : null;
}

/** The customer's open task titles, lower-cased, so the same task isn't made twice. */
async function openTaskTitles(tx: Tx, workspaceId: string, personId: string | null) {
  if (!personId) return new Set<string>();
  const open = await rows<{ title: string }>(
    tx,
    sql`select title from app.tasks
        where workspace_id = ${workspaceId} and person_id = ${personId} and done_at is null
        order by created_at desc limit 50`,
  );
  return new Set(open.map((t) => t.title.trim().toLowerCase()));
}

const RecordInput = CallInput.extend({
  /** An appointment's or video call's transcript; a phone call keeps its words on itself. */
  transcriptId: uuid.optional(),
  review: CallReview,
})
  .refine(oneCall, ONE_CALL)
  .refine((i) => !!i.callId !== !!i.transcriptId, {
    error: 'Name the transcript for an appointment or a video call, and none for a phone call.',
  });
const RecordOutput = z.object({
  noted: z.boolean(),
  suggestions: z.int(),
  /** The tasks it made at once. */
  tasks: z.int().default(0),
});

export const callSuggestionRecord = defineCommand({
  name: 'call_suggestion.record',
  description:
    'Worker: what the AI made of a recorded call. The summary goes on the customer’s timeline and its tasks are added; a follow-up and a record change wait for a person.',
  risk: 1,
  input: RecordInput,
  output: RecordOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['call_suggestion.created'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const of = callOf(input);
    const none = { noted: false, suggestions: 0, tasks: 0 };
    // Locked, and gone or already reviewed (a retried job): nothing twice.
    if (of.callId) {
      const [k] = await ctx.tx
        .select({ summary: calls.summary })
        .from(calls)
        .where(and(eq(calls.id, of.callId), eq(calls.workspaceId, ws)))
        .for('update');
      if (!k || k.summary !== null) return none;
    }
    const [t] = of.callId
      ? [null]
      : await ctx.tx
          .select({ id: appointmentTranscripts.id, summary: appointmentTranscripts.summary })
          .from(appointmentTranscripts)
          .where(
            and(
              eq(appointmentTranscripts.id, input.transcriptId!),
              of.appointmentId
                ? eq(appointmentTranscripts.appointmentId, of.appointmentId)
                : eq(appointmentTranscripts.videoCallId, of.videoCallId!),
              eq(appointmentTranscripts.workspaceId, ws),
            ),
          )
          .for('update');
    if (!of.callId && (!t || t.summary !== null)) return none;
    const review = input.review;
    const who = await customerOf(ctx.tx, ws, of);
    let noted = false;
    let endsAt: Date;
    let title: string;
    // A task on a private deal that no longer reads can't be made (makeCallTask); it waits instead, as before.
    let tasksMayBeMade = true;

    if (of.appointmentId) {
      const [appt] = await ctx.tx
        .select({
          title: appointments.title,
          endsAt: appointments.endsAt,
          customRecordId: appointments.customRecordId,
          sealed: appointments.sealed,
        })
        .from(appointments)
        .where(eq(appointments.id, of.appointmentId));
      if (!appt) return none;
      const record = await recordThatReads(ctx.tx, ws, appt.customRecordId);
      tasksMayBeMade = !(appt.sealed && !record);
      await ctx.tx
        .update(appointmentTranscripts)
        .set({ summary: review.summary })
        .where(eq(appointmentTranscripts.id, t!.id));
      // A record in the Deleted bin (binning leaves its appointments on it) can't take the note, so it goes on the
      // customer alone. A private record never goes in the bin; were one not to read, its summary would show to
      // everyone there, so it stays on the transcript, and the suggestions still wait.
      if ((who.personId || who.leadId) && !(appt.sealed && !record)) {
        await executeCommandWithin(ctx, activityLog, {
          workspaceId: ws,
          kind: 'note',
          body: `Call summary: ${appt.title}\n\n${review.summary}`,
          occurredAt: appt.endsAt.toISOString(),
          ...(who.personId ? { personId: who.personId } : {}),
          ...(who.leadId ? { leadId: who.leadId } : {}),
          // A tour on a private deal: the note is sealed with the deal, so only its people read it.
          ...(record ? { customRecordId: record } : {}),
        });
        noted = true;
      }
      endsAt = appt.endsAt;
      title = appt.title;
    } else {
      const call = of.callId
        ? await phoneCallOf(ctx.tx, ws, of.callId)
        : await videoCallOf(ctx.tx, ws, of.videoCallId!);
      if (!call) return none;
      if (of.callId)
        await ctx.tx.update(calls).set({ summary: review.summary }).where(eq(calls.id, of.callId));
      else
        await ctx.tx
          .update(appointmentTranscripts)
          .set({ summary: review.summary })
          .where(eq(appointmentTranscripts.id, t!.id));
      // The call's own line on the customer's timeline shows its summary, rather than a note beside it. A phone
      // call's words stay under it in the inbox, and in Notes from the call.
      if (call.activityId) {
        const [line] = await ctx.tx
          .update(activities)
          .set({ body: review.summary })
          .where(and(eq(activities.id, call.activityId), eq(activities.workspaceId, ws)))
          .returning({ id: activities.id });
        noted = !!line;
      }
      endsAt = call.endedAt ?? new Date();
      title = of.callId ? 'Phone call' : 'Video call';
    }

    // Owner, 4 Nov: the tasks are made, not suggested. A business that turned it off gets them to approve.
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    const make =
      tasksMayBeMade &&
      automationSettingsOf(w?.settings as Record<string, unknown> | null).switches.aiTasks;
    const customer = make ? await customerName(ctx.tx, ws, who.personId) : null;
    const open = make ? await openTaskTitles(ctx.tx, ws, who.personId) : new Set<string>();

    const suggested: {
      kind: SuggestionKind;
      preview: Record<string, unknown>;
      taskId?: string;
    }[] = [];
    for (const task of review.tasks) {
      const preview: TaskFields = {
        title: task.title,
        notes: task.notes,
        dueAt:
          task.dueInDays === null
            ? null
            : new Date(endsAt.getTime() + task.dueInDays * DAY).toISOString(),
      };
      if (!make) {
        suggested.push({ kind: 'task', preview });
        continue;
      }
      // The AI was shown the open tasks; one it still repeats word for word isn't made twice.
      const key = task.title.trim().toLowerCase();
      if (open.has(key)) continue;
      open.add(key);
      const taskId = await makeCallTask(ctx, ws, of, who, {
        ...preview,
        notes: aiTaskNotes(task.notes, sourceOf(of), customer).slice(0, 1000),
      });
      suggested.push({ kind: 'task', preview, taskId });
    }
    // A follow-up needs someone to send it to.
    if (review.followUp && who.personId)
      suggested.push({ kind: 'follow_up', preview: { ...review.followUp } });
    suggested.push(...(await recordChangeRow(ctx.tx, ws, who.personId, review.recordChanges)));

    for (const r of suggested) {
      const [made] = await ctx.tx
        .insert(callSuggestions)
        .values({
          workspaceId: ws,
          appointmentId: of.appointmentId,
          videoCallId: of.videoCallId,
          callId: of.callId,
          transcriptId: t?.id ?? null,
          kind: r.kind,
          preview: r.preview,
          // A task made at once is written approved, with nobody's name on it: the AI made it.
          ...(r.taskId
            ? {
                status: 'approved',
                decidedAt: new Date(),
                result: { taskId: r.taskId, conversationId: null },
              }
            : {}),
        })
        .returning({ id: callSuggestions.id });
      await ctx.emit({
        type: 'call_suggestion.created',
        ...entityOf(of),
        payload: { suggestionId: made!.id, kind: r.kind, taskId: r.taskId ?? null },
        after: { title, kind: r.kind, ...(r.taskId ? { made: true } : {}) },
      });
    }
    return {
      noted,
      suggestions: suggested.length,
      tasks: suggested.filter((r) => r.taskId).length,
    };
  },
});

/** A follow-up or a record change with nobody to send it to or update, and where to fix that. */
const noCustomer = (of: CallOf, what: string) =>
  HfosError.rule(
    'call_suggestion_no_customer',
    409,
    of.appointmentId
      ? `This appointment has no customer ${what}. Add them to the appointment, then try again.`
      : of.callId
        ? `This call isn’t linked to a customer, so there’s nobody ${what}. Link its conversation to them in the Inbox, then try again.`
        : `This video call has no customer ${what}, so it can’t be done from here. Dismiss it, and do it from the customer’s page.`,
  );

const DecideInput = z.object({
  workspaceId: uuid,
  suggestionId: uuid,
  decision: z.enum(['approve', 'dismiss']),
  /** What the person changed before approving: a task's title, notes or due date, or the message's words. */
  edits: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
      dueAt: isoDateTime.nullable().optional(),
      subject: z.string().trim().min(1).max(200).optional(),
      body: z.string().trim().min(1).max(4000).optional(),
      firstName: z.string().trim().min(1).max(80).optional(),
      lastName: z.string().trim().min(1).max(80).optional(),
      email: z.email().max(254).optional(),
      phone: z.string().trim().min(7).max(40).optional(),
    })
    .optional(),
});
const DecideOutput = z.object({
  suggestionId: uuid,
  status: z.enum(['approved', 'dismissed']),
  taskId: uuid.nullable(),
  conversationId: uuid.nullable(),
});

export const callSuggestionDecide = defineCommand({
  name: 'call_suggestion.decide',
  description:
    'Approve or dismiss something the AI suggested after a call. Approving makes the task, sends the follow-up, or updates the customer’s record, as you.',
  risk: 2,
  input: DecideInput,
  output: DecideOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['call_suggestion.decided'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    // Claimed once: two people pressing at the same time make one task.
    const [s] = await ctx.tx
      .update(callSuggestions)
      .set({
        status: input.decision === 'approve' ? 'approved' : 'dismissed',
        decidedBy: me.userId,
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(callSuggestions.id, input.suggestionId),
          eq(callSuggestions.workspaceId, ws),
          eq(callSuggestions.status, 'pending'),
        ),
      )
      .returning({
        id: callSuggestions.id,
        kind: callSuggestions.kind,
        preview: callSuggestions.preview,
        appointmentId: callSuggestions.appointmentId,
        videoCallId: callSuggestions.videoCallId,
        callId: callSuggestions.callId,
      });
    if (!s) {
      const [seen] = await ctx.tx
        .select({ status: callSuggestions.status })
        .from(callSuggestions)
        .where(
          and(eq(callSuggestions.id, input.suggestionId), eq(callSuggestions.workspaceId, ws)),
        );
      if (!seen)
        throw HfosError.notFound(
          'That suggestion isn’t there anymore. Its appointment or call may have been deleted. Refresh and try again.',
        );
      throw HfosError.rule(
        'call_suggestion_decided',
        409,
        seen.status === 'approved'
          ? 'Someone already approved this suggestion. Refresh to see what it made.'
          : 'Someone already dismissed this suggestion. Refresh to see the rest.',
      );
    }
    let taskId: string | null = null;
    let conversationId: string | null = null;
    let preview: Record<string, unknown> = s.preview as Record<string, unknown>;
    if (input.decision === 'approve') {
      const of: CallOf = {
        appointmentId: s.appointmentId,
        videoCallId: s.videoCallId,
        callId: s.callId,
      };
      const who = await customerOf(ctx.tx, ws, of);
      if (s.kind === 'task') {
        const p = TaskPreview.parse({ ...preview, ...input.edits });
        preview = p;
        taskId = await makeCallTask(ctx, ws, of, who, p);
      } else if (s.kind === 'record_change') {
        const p = RecordChangePreview.parse({ ...preview, ...input.edits });
        preview = p;
        if (!who.personId) throw noCustomer(of, 'to update');
        await executeCommandWithin(ctx, personUpdate, {
          workspaceId: ws,
          personId: who.personId,
          ...(p.firstName ? { firstName: p.firstName } : {}),
          ...(p.lastName ? { lastName: p.lastName } : {}),
          ...(p.email ? { email: p.email } : {}),
          ...(p.phone ? { phone: p.phone } : {}),
        });
      } else {
        const p = FollowUpPreview.parse({ ...preview, ...input.edits });
        preview = p;
        if (!who.personId) throw noCustomer(of, 'to send the follow-up to');
        const sent = await executeCommandWithin(ctx, messageSend, {
          workspaceId: ws,
          personId: who.personId,
          channel: 'email',
          subject: p.subject,
          body: p.body,
        });
        conversationId = (sent.output as { conversationId?: string | null }).conversationId ?? null;
      }
    }
    await ctx.tx
      .update(callSuggestions)
      .set({ preview, result: { taskId, conversationId } })
      .where(eq(callSuggestions.id, s.id));
    await ctx.emit({
      type: 'call_suggestion.decided',
      ...entityOf({
        appointmentId: s.appointmentId,
        videoCallId: s.videoCallId,
        callId: s.callId,
      }),
      payload: { suggestionId: s.id, kind: s.kind, decision: input.decision, taskId },
      after: { kind: s.kind, decision: input.decision },
    });
    return {
      suggestionId: s.id,
      status: input.decision === 'approve' ? ('approved' as const) : ('dismissed' as const),
      taskId,
      conversationId,
    };
  },
});

const ListInput = CallInput.refine(oneCall, ONE_CALL);
const ListOutput = z.object({
  summary: z.string().nullable(),
  /** A phone call's words, which it keeps on itself; null for the others (their transcripts are their own query). */
  transcript: z.string().nullable(),
  items: z.array(
    z.object({
      id: uuid,
      kind: z.enum(['task', 'follow_up', 'record_change']),
      status: z.enum(['pending', 'approved', 'dismissed']),
      preview: z.record(z.string(), z.unknown()),
      /** The task it made, approved or added by the AI on its own. */
      taskId: uuid.nullable(),
      createdAt: isoDateTime,
    }),
  ),
});

export const callSuggestionList = defineQuery({
  name: 'call_suggestion.list',
  description:
    'The AI’s summary of a recorded call (an appointment’s, a HandsFreeOS video call that isn’t for one, or a phone call on the business number), the tasks it added and what it suggests, with where each stands.',
  input: ListInput,
  output: ListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    // A phone call keeps its words and summary on itself, and reads only for whoever sees the call.
    const [t] = input.callId
      ? await ctx.tx
          .select({ summary: calls.summary, transcript: calls.transcript })
          .from(calls)
          .where(and(eq(calls.id, input.callId), eq(calls.workspaceId, input.workspaceId)))
      : await ctx.tx
          .select({ summary: appointmentTranscripts.summary, transcript: sql<null>`null` })
          .from(appointmentTranscripts)
          .where(
            input.appointmentId
              ? eq(appointmentTranscripts.appointmentId, input.appointmentId)
              : eq(appointmentTranscripts.videoCallId, input.videoCallId!),
          )
          .orderBy(asc(appointmentTranscripts.createdAt))
          .limit(1);
    const list = await ctx.tx
      .select()
      .from(callSuggestions)
      .where(
        and(
          input.appointmentId
            ? eq(callSuggestions.appointmentId, input.appointmentId)
            : input.callId
              ? eq(callSuggestions.callId, input.callId)
              : eq(callSuggestions.videoCallId, input.videoCallId!),
          eq(callSuggestions.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(asc(callSuggestions.createdAt));
    return {
      summary: t?.summary ?? null,
      transcript: t?.transcript ?? null,
      items: list.map((s) => {
        const made = (s.result as { taskId?: unknown } | null)?.taskId;
        return {
          id: s.id,
          kind: s.kind as SuggestionKind,
          status: s.status as 'pending' | 'approved' | 'dismissed',
          preview: (s.preview ?? {}) as Record<string, unknown>,
          taskId: typeof made === 'string' ? made : null,
          createdAt: s.createdAt.toISOString(),
        };
      }),
    };
  },
});

export const callSuggestionCommands = [callSuggestionRecord, callSuggestionDecide] as const;
