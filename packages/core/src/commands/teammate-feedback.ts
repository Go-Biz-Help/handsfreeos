/**
 * Feedback on the AI teammate's replies (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md): a person's thumbs up or
 * down on a reply it wrote, in a test or for real, with what it should have said and why, and their answer when the
 * worker asks what they meant.
 *
 * A thumbs down with words starts the worker's read (`ai_teammate.feedback_given`, `…feedback_answered`): it
 * suggests one rule for a person to OK (teammate_lesson.apply), asks one question, or finds nothing to learn.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { teammateFeedback } from '@hfos/db/schema';
import { loadFeedback } from '../ai-team/feedback';
import { requireTeammate } from '../ai-team/load';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import {
  AiTeammateAnswerFeedbackInput,
  AiTeammateFeedbackOutput,
  AiTeammateGiveFeedbackInput,
  FEEDBACK_REPLY_MAX,
} from '../schemas/teammate-feedback';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const clip = (s: string | null | undefined, max: number): string | null => {
  const t = s?.trim();
  return t ? t.slice(0, max) : null;
};

async function feedbackOut(ctx: CommandContext, id: string, me: string) {
  const [out] = await loadFeedback(ctx.tx, ctx.scope.workspaceId!, me, { ids: [id] });
  if (!out) throw new Error('Feedback just saved is not readable.');
  return { feedback: out };
}

interface RunRow extends Record<string, unknown> {
  id: string;
  teammate_id: string;
  is_test: boolean;
  reply_text: string | null;
  asked: string | null;
}

export const aiTeammateGiveFeedback = defineCommand({
  name: 'ai_teammate.give_feedback',
  description:
    'Give a thumbs up or down on a reply the AI teammate wrote, in a test or for real, with what it should have said and why. A thumbs down with words is read into one rule for a person to OK, or one question back. One per person per reply; giving it again replaces it.',
  risk: 1,
  input: AiTeammateGiveFeedbackInput,
  output: AiTeammateFeedbackOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['ai_teammate.feedback_given'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    let runId = input.runId ?? null;
    if (!runId) {
      const [m] = await rows<{ run_id: string | null }>(
        ctx.tx,
        sql`select ai_run_id as run_id from app.messages
            where id = ${input.messageId!} and workspace_id = ${ws}`,
      );
      if (!m)
        throw HfosError.notFound(
          'That message isn’t there anymore. Refresh to see the conversation as it is now.',
        );
      if (!m.run_id)
        throw HfosError.rule(
          'no_reply',
          409,
          'The AI teammate didn’t write this message, so there’s nothing to give it feedback on.',
        );
      runId = m.run_id;
    }
    // What the customer said, as the run answered it: their messages, oldest first.
    const [run] = await rows<RunRow>(
      ctx.tx,
      sql`select r.id, r.teammate_id, r.is_test, r.reply_text,
            (select string_agg(nullif(btrim(m.body_text), ''), E'\n' order by m.occurred_at, m.created_at)
              from app.messages m where m.id = any(r.message_ids)) as asked
          from app.ai_teammate_runs r
          where r.id = ${runId} and r.workspace_id = ${ws}`,
    );
    if (!run)
      throw HfosError.notFound(
        'That reply isn’t there anymore. Refresh to see the conversation as it is now.',
      );
    if (run.is_test && !scopeCan(ctx.scope, 'ai_team.manage'))
      throw HfosError.forbidden(
        'Only people who manage the AI teammate can give feedback on its tests. Ask an owner or admin.',
        'not_a_manager',
      );
    let messageId: string | null = null;
    let sent: string | null = null;
    if (!run.is_test) {
      const [m] = await rows<{ id: string; body: string | null }>(
        ctx.tx,
        sql`select m.id, m.body_text as body from app.messages m
            where m.workspace_id = ${ws} and m.ai_run_id = ${run.id}
              ${input.messageId ? sql`and m.id = ${input.messageId}` : sql``}
            order by m.created_at limit 1`,
      );
      if (input.messageId && !m)
        throw HfosError.notFound(
          'That message isn’t there anymore. Refresh to see the conversation as it is now.',
        );
      messageId = m?.id ?? null;
      sent = m?.body ?? null;
    }
    const reply = clip(run.reply_text ?? sent, 4000);
    if (!reply)
      throw HfosError.rule(
        'no_reply',
        409,
        'The AI didn’t write a reply here, so there’s nothing to give feedback on.',
      );
    const teammate = await requireTeammate(ctx.tx, ws, run.teammate_id);
    const read = input.rating === 'bad' && !!(input.betterReply || input.note);
    const values = {
      rating: input.rating,
      betterReply: input.betterReply,
      note: input.note,
      learn: read ? 'reading' : 'none',
      learnWhy: null,
      question: null,
      choices: [],
      answer: null,
      lessonId: null,
    };
    const [before] = await ctx.tx
      .select()
      .from(teammateFeedback)
      .where(and(eq(teammateFeedback.runId, run.id), eq(teammateFeedback.createdBy, me)))
      .for('update');
    let id: string;
    if (before) {
      await ctx.tx.update(teammateFeedback).set(values).where(eq(teammateFeedback.id, before.id));
      id = before.id;
    } else {
      const [made] = await ctx.tx
        .insert(teammateFeedback)
        .values({
          workspaceId: ws,
          teammateId: run.teammate_id,
          runId: run.id,
          messageId,
          isTest: run.is_test,
          asked: clip(run.is_test ? input.asked : run.asked, FEEDBACK_REPLY_MAX),
          reply,
          createdBy: me,
          ...values,
        })
        .returning({ id: teammateFeedback.id });
      id = made!.id;
    }
    await ctx.emit({
      type: 'ai_teammate.feedback_given',
      entityType: 'teammate_feedback',
      entityId: id,
      payload: {
        feedbackId: id,
        teammateId: run.teammate_id,
        runId: run.id,
        messageId,
        isTest: run.is_test,
        rating: input.rating,
        read,
        // A rule it suggested from what they said before, which this replaces.
        previousLessonId: before?.learn === 'suggested' ? before.lessonId : null,
      },
      ...(before ? { before: { rating: ratingWords(before.rating) } } : {}),
      after: {
        teammate: teammate.name,
        rating: ratingWords(input.rating),
        ...(run.is_test ? { test: true } : {}),
        ...(input.note ? { why: input.note } : {}),
      },
    });
    return feedbackOut(ctx, id, me);
  },
});

const ratingWords = (r: string) => (r === 'good' ? 'Thumbs up' : 'Thumbs down');

export const aiTeammateAnswerFeedback = defineCommand({
  name: 'ai_teammate.answer_feedback',
  description:
    'Answer the question the AI asked about your feedback on one of its replies. It reads the feedback again with your answer and suggests one rule, or says there’s nothing to learn.',
  risk: 1,
  input: AiTeammateAnswerFeedbackInput,
  output: AiTeammateFeedbackOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['ai_teammate.feedback_answered'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [f] = await ctx.tx
      .select()
      .from(teammateFeedback)
      .where(and(eq(teammateFeedback.id, input.feedbackId), eq(teammateFeedback.workspaceId, ws)))
      .for('update');
    if (!f)
      throw HfosError.notFound(
        'That feedback isn’t there anymore. Refresh to see the reply as it is now.',
      );
    if (f.createdBy !== me)
      throw HfosError.forbidden(
        'Only the person who gave this feedback can answer its question.',
        'not_your_feedback',
      );
    if (f.learn !== 'asking' || !f.question)
      throw HfosError.conflict(
        'That question was already answered, so there’s nothing more to say. Refresh to see what came of it.',
        'not_asking',
      );
    await ctx.tx
      .update(teammateFeedback)
      .set({ answer: input.answer, learn: 'reading' })
      .where(eq(teammateFeedback.id, f.id));
    await ctx.emit({
      type: 'ai_teammate.feedback_answered',
      entityType: 'teammate_feedback',
      entityId: f.id,
      payload: { feedbackId: f.id, teammateId: f.teammateId, runId: f.runId },
      after: { question: f.question, answer: input.answer },
    });
    return feedbackOut(ctx, f.id, me);
  },
});
