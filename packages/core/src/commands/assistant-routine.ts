/**
 * What a person asks the Assistant to do on its own (20261027036600, assistant/routines.ts): a question on a schedule,
 * or an alert. Theirs alone: RLS shows and lets them change only their own, and anyone else's matches no row.
 *
 * A change says only which routine changed (`assistant_routine.changed`), never the question: the worker arms the
 * question's next run from it. The worker records each answer and each alert with the system's own two commands.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import { assistantRoutines } from '@hfos/db/schema';
import {
  MAX_ROUTINES,
  nextRoutineRun,
  ROUTINE_QUESTION_MAX,
  RoutineCadence,
  RoutineWatch,
  WATCH_PERMISSION,
  defaultOnce,
} from '../assistant/routines';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { isoDateTime, uuid } from '../schemas/common';

const question = z
  .string()
  .trim()
  .min(1, 'Write the question to ask.')
  .max(ROUTINE_QUESTION_MAX, `Keep the question under ${ROUTINE_QUESTION_MAX} characters.`);

/**
 * One shape for both kinds, so the Assistant's tool is made from it as from any screen command (screen-actions.ts):
 * a question takes its question and when it runs, an alert what it watches for. The handler refuses the wrong mix.
 */
export const AssistantRoutineCreateInput = z.object({
  workspaceId: uuid,
  kind: z.enum(['question', 'alert']),
  /** A question: what to ask, in the person's words. */
  question: question.optional(),
  /** A question: when to ask it, in the business's time zone. */
  cadence: RoutineCadence.optional(),
  /** A question: the whole answer by email too. */
  email: z.boolean().optional(),
  /** An alert: what to watch for. */
  watch: RoutineWatch.optional(),
  /** An alert: tell once, then pause. Unsaid: once for someone writing or booking, every time for reviews and payments. */
  once: z.boolean().optional(),
});
export const AssistantRoutineOutput = z.object({
  routineId: uuid,
  /** When a question is asked next; null for an alert, or one that's paused. */
  nextRunAt: isoDateTime.nullable(),
});

export const AssistantRoutineUpdateInput = z.object({
  workspaceId: uuid,
  routineId: uuid,
  paused: z.boolean().optional(),
  question: question.optional(),
  cadence: RoutineCadence.optional(),
  email: z.boolean().optional(),
  watch: RoutineWatch.optional(),
  once: z.boolean().optional(),
});
export const AssistantRoutineDeleteInput = z.object({ workspaceId: uuid, routineId: uuid });
export const AssistantRoutineDeleteOutput = z.object({ routineId: uuid });

export const AssistantRoutineRecordRunInput = z.object({
  workspaceId: uuid,
  routineId: uuid,
  /** The chat the answer went in. */
  threadId: uuid.nullable(),
  ranAt: isoDateTime,
  /** When it runs next, from its cadence; null stops it (its person can no longer be asked for). */
  nextRunAt: isoDateTime.nullable(),
});
export const AssistantRoutineRecordAlertInput = z.object({
  workspaceId: uuid,
  routineId: uuid,
  firedAt: isoDateTime,
  /** It told them (false: it stops without telling, because they can't see what it watches anymore). */
  told: z.boolean().default(true),
  /** It told them once and stops, or they can't see what it watches anymore. */
  stop: z.boolean(),
});
export const AssistantRoutineRecordOutput = z.object({ routineId: uuid, changed: z.boolean() });

const gone = () =>
  HfosError.notFound(
    'That isn’t one of the things you asked the Assistant for anymore. Refresh and try again.',
  );

async function timezoneOf(ctx: CommandContext): Promise<string> {
  const [ws] = await rows<{ timezone: string | null }>(
    ctx.tx,
    sql`select timezone from app.workspaces where id = ${ctx.scope.workspaceId!}`,
  );
  return ws?.timezone || 'UTC';
}

/** An alert only for what this person may see: the customer it watches, and the screens it's about. */
async function checkWatch(ctx: CommandContext, watch: RoutineWatch): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  const permission = WATCH_PERMISSION[watch.on];
  const [held] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.has_permission(${ws}::uuid, ${permission}) as ok`,
  );
  if (!held?.ok)
    throw HfosError.forbidden(
      watch.on === 'payment'
        ? 'Alerts about payments are for people who see the money. Ask an owner of this business to give you Money in Settings → Members.'
        : 'Your role here can’t see what that alert is about. Ask an owner of this business about your role in Settings → Members.',
      'routine_not_allowed',
    );
  if (watch.on === 'reply' || watch.on === 'booking') {
    const [person] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.people where id = ${watch.personId} and workspace_id = ${ws}
          and archived_at is null`,
    );
    if (!person)
      throw HfosError.notFound(
        'That customer isn’t in Contacts anymore, or you can’t see them. Look them up again and try once more.',
      );
  }
}

export const assistantRoutineCreate = defineCommand({
  name: 'assistant_routine.create',
  description:
    'Ask the Assistant to do something on its own, for you alone: a question it asks on a schedule (its answer to your phone, and email if you say), or an alert when something happens.',
  risk: 1,
  input: AssistantRoutineCreateInput,
  output: AssistantRoutineOutput,
  permission: 'assistant.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['assistant_routine.changed'],
  async handler(ctx, input) {
    const userId = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [count] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.assistant_routines where workspace_id = ${ws} and user_id = ${userId}`,
    );
    if ((count?.n ?? 0) >= MAX_ROUTINES)
      throw HfosError.rule(
        'too_many_routines',
        409,
        `You have ${MAX_ROUTINES} questions and alerts here, the most one person can. Stop one you don’t need under Settings → Notifications, then try again.`,
      );
    let nextRunAt: Date | null = null;
    let values: typeof assistantRoutines.$inferInsert;
    if (input.kind === 'question') {
      if (input.watch || input.once !== undefined)
        throw HfosError.rule(
          'routine_kind_mismatch',
          400,
          'A question asked on a schedule watches for nothing. Give it a question and when to ask it.',
        );
      if (!input.question || !input.cadence)
        throw HfosError.rule(
          'routine_incomplete',
          400,
          input.question
            ? 'Say when to ask it: which days and what time, or which day of the month.'
            : 'Write the question to ask.',
        );
      nextRunAt = new Date(nextRoutineRun(input.cadence, new Date(), await timezoneOf(ctx)));
      values = {
        workspaceId: ws,
        userId,
        kind: 'question',
        question: input.question,
        cadence: input.cadence,
        email: input.email ?? false,
        nextRunAt,
      };
    } else {
      if (input.question || input.cadence || input.email !== undefined)
        throw HfosError.rule(
          'routine_kind_mismatch',
          400,
          'An alert has no question or schedule. Say what it watches for: a customer writing or booking, a review, or a payment.',
        );
      if (!input.watch)
        throw HfosError.rule(
          'routine_incomplete',
          400,
          'Say what the alert watches for: a customer writing or booking, a review, or a payment.',
        );
      await checkWatch(ctx, input.watch);
      values = {
        workspaceId: ws,
        userId,
        kind: 'alert',
        watch: input.watch,
        once: input.once ?? defaultOnce(input.watch),
      };
    }
    const [row] = await ctx.tx
      .insert(assistantRoutines)
      .values(values)
      .returning({ id: assistantRoutines.id });
    await ctx.emit({
      type: 'assistant_routine.changed',
      entityType: 'assistant_routine',
      entityId: row!.id,
      payload: { kind: input.kind },
    });
    return { routineId: row!.id, nextRunAt: nextRunAt?.toISOString() ?? null };
  },
});

export const assistantRoutineUpdate = defineCommand({
  name: 'assistant_routine.update',
  description:
    'Change one of the things you asked the Assistant for: pause or resume it, or change its question, when it runs, the email, or what it watches for.',
  risk: 1,
  input: AssistantRoutineUpdateInput,
  output: AssistantRoutineOutput,
  permission: 'assistant.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['assistant_routine.changed'],
  async handler(ctx, input) {
    const userId = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [r] = await ctx.tx
      .select()
      .from(assistantRoutines)
      .where(
        and(
          eq(assistantRoutines.id, input.routineId),
          eq(assistantRoutines.workspaceId, ws),
          eq(assistantRoutines.userId, userId),
        ),
      );
    if (!r) throw gone();
    const isQuestion = r.kind === 'question';
    if (isQuestion && (input.watch !== undefined || input.once !== undefined))
      throw HfosError.rule(
        'routine_kind_mismatch',
        400,
        'A question asked on a schedule watches for nothing. Change its question or when it runs instead.',
      );
    if (!isQuestion && (input.question || input.cadence || input.email !== undefined))
      throw HfosError.rule(
        'routine_kind_mismatch',
        400,
        'An alert has no question or schedule. Change what it watches for, or whether it tells you once.',
      );
    if (input.watch) await checkWatch(ctx, input.watch);
    const paused = input.paused ?? r.pausedAt !== null;
    const cadence = input.cadence ?? (r.cadence as RoutineCadence | null);
    // A question's next run, again from now, whenever it's resumed or its schedule changes.
    const nextRunAt =
      isQuestion && !paused && cadence
        ? input.cadence || input.paused === false || !r.nextRunAt
          ? new Date(nextRoutineRun(cadence, new Date(), await timezoneOf(ctx)))
          : r.nextRunAt
        : null;
    await ctx.tx
      .update(assistantRoutines)
      .set({
        ...(input.question ? { question: input.question } : {}),
        ...(input.cadence ? { cadence: input.cadence } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.watch ? { watch: input.watch } : {}),
        ...(input.once !== undefined ? { once: input.once } : {}),
        ...(input.paused === true
          ? { pausedAt: dsql`coalesce(${assistantRoutines.pausedAt}, now())` }
          : input.paused === false
            ? { pausedAt: null }
            : {}),
        nextRunAt,
      })
      .where(eq(assistantRoutines.id, r.id));
    await ctx.emit({
      type: 'assistant_routine.changed',
      entityType: 'assistant_routine',
      entityId: r.id,
      payload: { kind: r.kind },
    });
    return { routineId: r.id, nextRunAt: nextRunAt?.toISOString() ?? null };
  },
});

export const assistantRoutineDelete = defineCommand({
  name: 'assistant_routine.delete',
  description:
    'Stop one of the things you asked the Assistant for, for good. The answers it already gave stay in its chat.',
  risk: 1,
  input: AssistantRoutineDeleteInput,
  output: AssistantRoutineDeleteOutput,
  // Stopping your own never needs the Assistant: someone whose role lost it can still remove theirs.
  permission: null,
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['assistant_routine.changed'],
  async handler(ctx, input) {
    const userId = requireHuman(ctx).userId;
    const [row] = await ctx.tx
      .delete(assistantRoutines)
      .where(
        and(
          eq(assistantRoutines.id, input.routineId),
          eq(assistantRoutines.workspaceId, ctx.scope.workspaceId!),
          eq(assistantRoutines.userId, userId),
        ),
      )
      .returning({ id: assistantRoutines.id, kind: assistantRoutines.kind });
    if (!row) throw gone();
    await ctx.emit({
      type: 'assistant_routine.changed',
      entityType: 'assistant_routine',
      entityId: row.id,
      payload: { kind: row.kind, deleted: true },
    });
    return { routineId: row.id };
  },
});

export const assistantRoutineRecordRun = defineCommand({
  name: 'assistant_routine.record_run',
  description:
    'Worker: a question asked on a schedule was answered (or couldn’t be): when, in which chat, and when it runs next.',
  risk: 1,
  input: AssistantRoutineRecordRunInput,
  output: AssistantRoutineRecordOutput,
  permission: null,
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(assistantRoutines)
      .set({
        lastRunAt: new Date(input.ranAt),
        nextRunAt: input.nextRunAt ? new Date(input.nextRunAt) : null,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.nextRunAt
          ? {}
          : { pausedAt: dsql`coalesce(${assistantRoutines.pausedAt}, now())` }),
      })
      .where(
        and(
          eq(assistantRoutines.id, input.routineId),
          eq(assistantRoutines.workspaceId, ctx.scope.workspaceId!),
          eq(assistantRoutines.kind, 'question'),
        ),
      )
      .returning({ id: assistantRoutines.id });
    return { routineId: input.routineId, changed: !!row };
  },
});

export const assistantRoutineRecordAlert = defineCommand({
  name: 'assistant_routine.record_alert',
  description:
    'Worker: an alert told its person, or stopped because it told them once or they can’t see what it watches anymore.',
  risk: 1,
  input: AssistantRoutineRecordAlertInput,
  output: AssistantRoutineRecordOutput,
  permission: null,
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(assistantRoutines)
      .set({
        ...(input.told
          ? {
              firedCount: dsql`${assistantRoutines.firedCount} + 1`,
              lastFiredAt: new Date(input.firedAt),
            }
          : {}),
        ...(input.stop ? { pausedAt: dsql`coalesce(${assistantRoutines.pausedAt}, now())` } : {}),
      })
      .where(
        and(
          eq(assistantRoutines.id, input.routineId),
          eq(assistantRoutines.workspaceId, ctx.scope.workspaceId!),
          eq(assistantRoutines.kind, 'alert'),
        ),
      )
      .returning({ id: assistantRoutines.id });
    return { routineId: input.routineId, changed: !!row };
  },
});
