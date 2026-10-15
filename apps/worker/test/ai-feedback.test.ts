/**
 * Coaching the AI teammate (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md), on the real database, with the scripted
 * AI:
 * - a thumbs down on a reply it sent on its own, saying why, comes back as a rule to save; saving it puts it on the
 *   Instructions list, and its next reply reads it;
 * - one that only says what it should have said gets one question back; "Every customer" makes the rule, and "Just
 *   this one" teaches nothing;
 * - a thumbs up is kept and read into nothing; changing feedback drops the rule it suggested before;
 * - Review lists what it sent on its own that nobody has rated.
 */
import {
  aiTeammateAnswerFeedback,
  aiTeammateGiveFeedback,
  aiTeammateReview,
  teammateLessonApply,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  aiReplies,
  briefOf,
  drain,
  newCustomer,
  query,
  replyNow,
  requestAbout,
  run,
  runsOf,
  teammateWorld,
  textIn,
  type TeammateWorld,
} from './ai-team-world';
import { itemOf } from './attention-world';

let t: TeammateWorld;

beforeAll(async () => {
  t = await teammateWorld('feedback', { status: 'automatic' });
});
afterAll(async () => {
  await t?.app.close();
  await closeTestDbs();
});

/** A customer asks, and the teammate answers on its own: its run and the message it sent. */
async function answered(name: string, ask: string): Promise<{ runId: string; messageId: string }> {
  const c = await newCustomer(t, name);
  const { conversationId } = await textIn(t, c.phone, ask);
  await replyNow(t, conversationId);
  const [reply] = await aiReplies(conversationId);
  const [r] = await runsOf(conversationId);
  expect(reply?.approved_by).toBeNull();
  return { runId: r!.id, messageId: reply!.id };
}

const give = async (runId: string, input: Record<string, unknown>) => {
  const out = await run(t, aiTeammateGiveFeedback, { workspaceId: t.workspaceId, runId, ...input });
  await drain(t);
  return out.feedback;
};

const feedbackRow = async (id: string) =>
  (
    await rows<{
      learn: string;
      learn_why: string | null;
      question: string | null;
      choices: string[];
      lesson_id: string | null;
    }>(
      admin(),
      sql`select learn, learn_why, question, choices, lesson_id from app.teammate_feedback where id = ${id}`,
    )
  )[0]!;

const lessonOf = async (id: string) =>
  (
    await rows<{ line: string; status: string; feedback_ids: string[] }>(
      admin(),
      sql`select line, status, feedback_ids from app.teammate_lessons where id = ${id}`,
    )
  )[0]!;

const instructions = async () =>
  (
    await rows<{ body: string; source: string }>(
      admin(),
      sql`select body, source from app.teammate_instructions where teammate_id = ${t.teammateId}
          order by created_at`,
    )
  ).map((i) => i.body);

describe('feedback on a reply it sent on its own', () => {
  it('becomes a rule to save, which goes on its instructions and into its next reply', async () => {
    const { runId, messageId } = await answered('Fern', 'Can you come out Sunday?');
    const given = await give(runId, {
      messageId,
      rating: 'bad',
      note: 'We don’t work Sundays, offer Monday instead',
    });
    expect(given).toMatchObject({ learn: 'reading', mine: true, messageId });
    const f = await feedbackRow(given.id);
    expect(f.learn).toBe('suggested');
    const lesson = await lessonOf(f.lesson_id!);
    expect(lesson).toMatchObject({
      line: 'We don’t work Sundays, offer Monday instead.',
      status: 'open',
      feedback_ids: [given.id],
    });
    // Home offers it too, until it's saved.
    expect((await itemOf(t, f.lesson_id!, 'ai_corrections')).state).toBe('open');

    await run(t, teammateLessonApply, { workspaceId: t.workspaceId, lessonId: f.lesson_id! });
    await drain(t);
    expect(await instructions()).toEqual(['We don’t work Sundays, offer Monday instead.']);
    expect((await itemOf(t, f.lesson_id!, 'ai_corrections')).state).toBe('resolved');

    await answered('Gus', 'What about this weekend?');
    const brief = briefOf(requestAbout(t, 'What about this weekend?')!);
    expect(brief).toContain('<instructions>');
    expect(brief).toContain('We don’t work Sundays, offer Monday instead.');
  });

  it('asks one question when it only says what it should have said', async () => {
    const { runId } = await answered('Hal', 'Do you do dryer vents?');
    const given = await give(runId, {
      rating: 'bad',
      betterReply: 'Yes! Dryer vent cleaning is $89 and takes about an hour.',
    });
    const asked = await feedbackRow(given.id);
    expect(asked).toMatchObject({
      learn: 'asking',
      question: 'Should it say this to every customer, or just this one?',
      choices: ['Every customer', 'Just this one'],
      lesson_id: null,
    });
    const out = await run(t, aiTeammateAnswerFeedback, {
      workspaceId: t.workspaceId,
      feedbackId: given.id,
      answer: 'Every customer',
    });
    expect(out.feedback.learn).toBe('reading');
    await drain(t);
    const f = await feedbackRow(given.id);
    expect(f.learn).toBe('suggested');
    expect((await lessonOf(f.lesson_id!)).line).toBe(
      'Yes! Dryer vent cleaning is $89 and takes about an hour.',
    );
    // Asked once: it can't be answered again.
    await expect(
      run(t, aiTeammateAnswerFeedback, {
        workspaceId: t.workspaceId,
        feedbackId: given.id,
        answer: 'Just this one',
      }),
    ).rejects.toMatchObject({ rule: 'not_asking' });
  });

  it('learns nothing from "Just this one", and says why', async () => {
    const { runId } = await answered('Ida', 'Can Tom come instead of Sam?');
    const given = await give(runId, {
      rating: 'bad',
      betterReply: 'Sure, Tom can come on Tuesday.',
    });
    await run(t, aiTeammateAnswerFeedback, {
      workspaceId: t.workspaceId,
      feedbackId: given.id,
      answer: 'Just this one',
    });
    await drain(t);
    expect(await feedbackRow(given.id)).toMatchObject({
      learn: 'nothing',
      learn_why: 'It only fits that one customer.',
      lesson_id: null,
    });
  });

  it('keeps a thumbs up, and changing feedback drops the rule it suggested before', async () => {
    const { runId } = await answered('Jo', 'Do you take cards?');
    const bad = await give(runId, { rating: 'bad', note: 'Say we take cards, cash and checks' });
    const before = (await feedbackRow(bad.id)).lesson_id!;
    expect((await lessonOf(before)).status).toBe('open');
    const good = await give(runId, { rating: 'good' });
    // One per person per reply: the same feedback, now a thumbs up.
    expect(good.id).toBe(bad.id);
    expect(await feedbackRow(good.id)).toMatchObject({ learn: 'none', lesson_id: null });
    expect((await lessonOf(before)).status).toBe('dismissed');
  });
});

describe('Review', () => {
  it('lists what it sent on its own that nobody rated, newest first', async () => {
    const { runId } = await answered('Kit', 'Are you open late Friday?');
    const unrated = await query(t, aiTeammateReview, { workspaceId: t.workspaceId });
    expect(unrated.items[0]).toMatchObject({
      runId,
      why: 'answer',
      asked: 'Are you open late Friday?',
      feedback: [],
    });
    expect(unrated.items.every((i) => i.feedback.length === 0)).toBe(true);
    expect(unrated.canSaveRules).toBe(true);
    await give(runId, { rating: 'good' });
    const after = await query(t, aiTeammateReview, { workspaceId: t.workspaceId });
    expect(after.items.map((i) => i.runId)).not.toContain(runId);
    expect(after.unrated).toBe(unrated.unrated - 1);
    const all = await query(t, aiTeammateReview, { workspaceId: t.workspaceId, show: 'all' });
    expect(all.items.find((i) => i.runId === runId)?.feedback[0]).toMatchObject({
      rating: 'good',
      mine: true,
    });
  });
});
