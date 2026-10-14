/**
 * What the AI made of a recorded call (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §9). `call_suggestion.record`
 * (the worker) keeps the summary on the transcript, writes it to the customer's timeline as a note, and stores the
 * suggested tasks, follow-up and record change, which wait. `call_suggestion.decide` is a person's OK or no:
 * approving runs `task.create`, `message.send` or `person.update` as that person, with what they edited, in the
 * same transaction.
 */
import { and, asc, eq } from 'drizzle-orm';
import {
  appointmentAttendees,
  appointments,
  appointmentStaff,
  appointmentTranscripts,
  callSuggestions,
  people,
} from '@hfos/db/schema';
import { z } from 'zod';
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

/** Who the call was with: its first booked customer, else its lead. */
async function customerOf(
  tx: Parameters<typeof executeCommandWithin>[0]['tx'],
  appointmentId: string,
) {
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

type SuggestionKind = 'task' | 'follow_up' | 'record_change';

/** A record change only when the customer is on file and something actually differs from what's there. */
async function recordChangeRow(
  tx: Parameters<typeof executeCommandWithin>[0]['tx'],
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

const RecordInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  transcriptId: uuid,
  review: CallReview,
});
const RecordOutput = z.object({
  noted: z.boolean(),
  suggestions: z.int(),
});

export const callSuggestionRecord = defineCommand({
  name: 'call_suggestion.record',
  description:
    'Worker: what the AI made of a recorded call. The summary goes on the customer’s timeline; tasks and a follow-up wait for a person.',
  risk: 1,
  input: RecordInput,
  output: RecordOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['call_suggestion.created'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [t] = await ctx.tx
      .select({ id: appointmentTranscripts.id, summary: appointmentTranscripts.summary })
      .from(appointmentTranscripts)
      .where(
        and(
          eq(appointmentTranscripts.id, input.transcriptId),
          eq(appointmentTranscripts.appointmentId, input.appointmentId),
          eq(appointmentTranscripts.workspaceId, ws),
        ),
      )
      .for('update');
    // Gone, or already reviewed (a retried job): nothing twice.
    if (!t || t.summary !== null) return { noted: false, suggestions: 0 };
    const [appt] = await ctx.tx
      .select({ title: appointments.title, endsAt: appointments.endsAt })
      .from(appointments)
      .where(eq(appointments.id, input.appointmentId));
    if (!appt) return { noted: false, suggestions: 0 };
    const review = input.review;
    await ctx.tx
      .update(appointmentTranscripts)
      .set({ summary: review.summary })
      .where(eq(appointmentTranscripts.id, t.id));

    const who = await customerOf(ctx.tx, input.appointmentId);
    let noted = false;
    if (who.personId || who.leadId) {
      await executeCommandWithin(ctx, activityLog, {
        workspaceId: ws,
        kind: 'note',
        body: `Call summary: ${appt.title}\n\n${review.summary}`,
        occurredAt: appt.endsAt.toISOString(),
        ...(who.personId ? { personId: who.personId } : {}),
        ...(who.leadId ? { leadId: who.leadId } : {}),
      });
      noted = true;
    }

    const rows: { kind: SuggestionKind; preview: Record<string, unknown> }[] = [
      ...review.tasks.map((task) => ({
        kind: 'task' as const,
        preview: {
          title: task.title,
          notes: task.notes,
          dueAt:
            task.dueInDays === null
              ? null
              : new Date(appt.endsAt.getTime() + task.dueInDays * DAY).toISOString(),
        },
      })),
      // A follow-up needs someone to send it to.
      ...(review.followUp && who.personId
        ? [{ kind: 'follow_up' as const, preview: { ...review.followUp } }]
        : []),
      ...(await recordChangeRow(ctx.tx, ws, who.personId, review.recordChanges)),
    ];
    for (const r of rows) {
      const [made] = await ctx.tx
        .insert(callSuggestions)
        .values({
          workspaceId: ws,
          appointmentId: input.appointmentId,
          transcriptId: t.id,
          kind: r.kind,
          preview: r.preview,
        })
        .returning({ id: callSuggestions.id });
      await ctx.emit({
        type: 'call_suggestion.created',
        entityType: 'appointment',
        entityId: input.appointmentId,
        payload: { suggestionId: made!.id, kind: r.kind },
        after: { title: appt.title, kind: r.kind },
      });
    }
    return { noted, suggestions: rows.length };
  },
});

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
          'That suggestion isn’t there anymore. Its appointment may have been deleted. Refresh and try again.',
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
      const who = await customerOf(ctx.tx, s.appointmentId);
      if (s.kind === 'task') {
        const p = TaskPreview.parse({ ...preview, ...input.edits });
        preview = p;
        // Given to the call's host, about its customer.
        const [host] = await ctx.tx
          .select({ userId: appointmentStaff.userId })
          .from(appointmentStaff)
          .where(eq(appointmentStaff.appointmentId, s.appointmentId))
          .orderBy(asc(appointmentStaff.role))
          .limit(1);
        const made = await executeCommandWithin(ctx, taskCreate, {
          workspaceId: ws,
          title: p.title,
          ...(p.notes ? { notes: p.notes } : {}),
          dueAt: p.dueAt,
          ...(host ? { assigneeUserId: host.userId } : {}),
          ...(who.personId ? { personId: who.personId } : {}),
          ...(who.leadId ? { leadId: who.leadId } : {}),
        });
        taskId = made.output.taskId;
      } else if (s.kind === 'record_change') {
        const p = RecordChangePreview.parse({ ...preview, ...input.edits });
        preview = p;
        if (!who.personId)
          throw HfosError.rule(
            'call_suggestion_no_customer',
            409,
            'This appointment has no customer to update. Add them to the appointment, then try again.',
          );
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
        if (!who.personId)
          throw HfosError.rule(
            'call_suggestion_no_customer',
            409,
            'This appointment has no customer to send the follow-up to. Add them to the appointment, then try again.',
          );
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
      entityType: 'appointment',
      entityId: s.appointmentId,
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

const ListInput = z.object({ workspaceId: uuid, appointmentId: uuid });
const ListOutput = z.object({
  summary: z.string().nullable(),
  items: z.array(
    z.object({
      id: uuid,
      kind: z.enum(['task', 'follow_up', 'record_change']),
      status: z.enum(['pending', 'approved', 'dismissed']),
      preview: z.record(z.string(), z.unknown()),
      createdAt: isoDateTime,
    }),
  ),
});

export const callSuggestionList = defineQuery({
  name: 'call_suggestion.list',
  description:
    'The AI’s summary of an appointment’s recorded call, and its suggestions with where each stands.',
  input: ListInput,
  output: ListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [t] = await ctx.tx
      .select({ summary: appointmentTranscripts.summary })
      .from(appointmentTranscripts)
      .where(eq(appointmentTranscripts.appointmentId, input.appointmentId))
      .orderBy(asc(appointmentTranscripts.createdAt))
      .limit(1);
    const list = await ctx.tx
      .select()
      .from(callSuggestions)
      .where(
        and(
          eq(callSuggestions.appointmentId, input.appointmentId),
          eq(callSuggestions.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(asc(callSuggestions.createdAt));
    return {
      summary: t?.summary ?? null,
      items: list.map((s) => ({
        id: s.id,
        kind: s.kind as SuggestionKind,
        status: s.status as 'pending' | 'approved' | 'dismissed',
        preview: (s.preview ?? {}) as Record<string, unknown>,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  },
});

export const callSuggestionCommands = [callSuggestionRecord, callSuggestionDecide] as const;
