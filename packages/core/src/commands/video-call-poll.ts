/**
 * Live polls in a HandsFreeOS video call (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 2; meetings/polls.ts).
 *
 * - **A call picks its poll** (`video_call.set_poll`): a form made as a Live poll. A session's call starts with its
 *   calendar's.
 * - **The team asks a question** (`video_call.poll_open`, Ask now in the panel), or skips it for now
 *   (`video_call.poll_skip`). One question is up at a time: asking another closes the one that's up. The AI asks too
 *   once it hears the presenter (part 3), as the system.
 * - **It closes** when its time is up (the worker's job), once nearly everyone watching answered (the answer that
 *   gets it there closes it), or when the team closes it (`video_call.poll_close`). The worker tells the room, from
 *   the events.
 * - **Answers** (`video_call.poll_answer`, the worker's, from a customer's page on their own link) are one form
 *   response per person on their contact, filled in as the questions come: one answer per question, the first one
 *   standing. When the call ends (`video_call.polls_finish`) each sheet is sent, so `form.submitted` starts the
 *   workflows on "Somebody answers a form" as for any form.
 * - **The team's panel** reads `video_call.polls`: every question, how it stands, the answers coming in and the
 *   totals.
 */
import { and, eq, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { formResponses, forms, formVersions, videoCallPolls, videoCalls } from '@hfos/db/schema';
import { z } from 'zod';
import { HfosError } from '../errors';
import {
  allQuestions,
  findQuestion,
  liveOf,
  type FormDefinition,
  type Question,
} from '../forms/definition';
import { QuestionId } from '../forms/ids';
import { loadForm, parseStoredForm } from '../forms/load';
import { CHOICE_TYPES, answerIsEmpty, type AnswerValue } from '../forms/questions';
import { answerProblem } from '../forms/render';
import { writeFormAnswers } from '../forms/submit';
import { requireHuman } from '../kernel/actor';
import { defineCommand, defineQuery } from '../kernel/define';
import type { CommandContext, QueryContext } from '../kernel/types';
import {
  POLL_GRACE_MS,
  POLL_OPENERS,
  POLL_PRESSED_SHOWN,
  POLL_TEXTS_SHOWN,
  POLL_WORDS,
  PollOnScreen,
  PollTotals,
  closesEarly,
  pollOnScreen,
  pollTotals,
  type PollCounts,
} from '../meetings/polls';
import { isoDateTime, uuid } from '../schemas/common';
import { lockVideoCall } from './video-call';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type Tx = QueryContext['tx'];
type CallRow = typeof videoCalls.$inferSelect;
type PollRow = typeof videoCallPolls.$inferSelect;
type FormRow = typeof forms.$inferSelect;

/** Why a question closed: its time was up, nearly everyone answered, the team closed it or asked another, or the call ended. */
export const POLL_CLOSED_WHY = ['time', 'nearly_all', 'team', 'replaced', 'ended'] as const;
export type PollClosedWhy = (typeof POLL_CLOSED_WHY)[number];

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const pollGone = () =>
  HfosError.notFound('That live poll isn’t in Forms anymore. Pick another one for this call.');

/** A form the call may use as its poll: one of the business's, made as a Live poll, not archived. */
async function pollForm(tx: Tx, ws: string, formId: string): Promise<FormRow> {
  const [form] = await tx
    .select()
    .from(forms)
    .where(and(eq(forms.id, formId), eq(forms.workspaceId, ws), isNull(forms.archivedAt)));
  if (!form) throw pollGone();
  if (form.mode !== 'poll')
    throw HfosError.rule(
      'not_a_poll',
      409,
      `“${form.name}” isn’t a live poll. Pick one made as a Live poll in Forms.`,
    );
  return form;
}

/** The poll as published: its questions are asked from the version people answer. */
async function publishedPoll(
  tx: Tx,
  ws: string,
  formId: string,
): Promise<{ form: FormRow; versionId: string; definition: FormDefinition }> {
  const form = await pollForm(tx, ws, formId);
  if (form.status === 'closed')
    throw HfosError.rule(
      'poll_closed',
      409,
      `“${form.name}” is closed in Forms. Open it again there, and its questions can pop up.`,
    );
  if (form.status !== 'live' || !form.activeVersionId)
    throw HfosError.rule('poll_unpublished', 409, POLL_WORDS.unpublished(form.name));
  const [version] = await tx
    .select()
    .from(formVersions)
    .where(eq(formVersions.id, form.activeVersionId));
  if (!version) throw HfosError.rule('poll_unpublished', 409, POLL_WORDS.unpublished(form.name));
  return { form, versionId: version.id, definition: parseStoredForm(version.definition) };
}

/** The question a poll row asked, from the version it was asked from. */
async function questionOf(tx: Tx, poll: PollRow): Promise<Question | null> {
  const [version] = await tx
    .select({ definition: formVersions.definition })
    .from(formVersions)
    .where(eq(formVersions.id, poll.versionId));
  if (!version) return null;
  return findQuestion(parseStoredForm(version.definition), poll.questionId)?.question ?? null;
}

async function openPollIn(tx: Tx, callId: string, lock = false): Promise<PollRow | null> {
  const q = tx
    .select()
    .from(videoCallPolls)
    .where(and(eq(videoCallPolls.videoCallId, callId), eq(videoCallPolls.state, 'open')));
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

/** How many are watching: everyone in the call now who isn't on the team. */
async function watchingIn(tx: Tx, callId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from app.video_call_people
        where video_call_id = ${callId} and kind <> 'team'
          and last_joined_at is not null and (left_at is null or left_at < last_joined_at)`,
  );
  return row?.n ?? 0;
}

/** Closes a question that's up, and tells the worker (which tells the room). */
async function closePoll(
  ctx: CommandContext,
  call: CallRow,
  poll: PollRow,
  why: PollClosedWhy,
): Promise<void> {
  const [closed] = await ctx.tx
    .update(videoCallPolls)
    .set({ state: 'closed', closedAt: new Date() })
    .where(and(eq(videoCallPolls.id, poll.id), eq(videoCallPolls.state, 'open')))
    .returning();
  if (!closed) return;
  await ctx.emit({
    type: 'video_call.poll_closed',
    entityType: 'video_call',
    entityId: call.id,
    payload: {
      appointmentId: call.appointmentId,
      pollId: poll.id,
      formId: poll.formId,
      questionId: poll.questionId,
      answers: closed.answers,
      why,
    },
    after: { answers: closed.answers },
    broadcast: false,
  });
}

/**
 * Everyone's answers to a poll in a call, counted per question in the database: what the team's panel and the totals
 * the room sees are made from.
 */
export async function pollCounts(
  tx: Tx,
  callId: string,
  formId: string,
): Promise<Map<string, PollCounts>> {
  const byQuestion = new Map<
    string,
    { answered: number; byChoice: Record<string, number>; byNumber: Record<string, number> }
  >();
  const of = (q: string) => {
    let c = byQuestion.get(q);
    if (!c) byQuestion.set(q, (c = { answered: 0, byChoice: {}, byNumber: {} }));
    return c;
  };
  const answered = await rows<{ question_id: string; n: number }>(
    tx,
    sql`select fa.question_id, count(*)::int as n
        from app.form_answers fa join app.form_responses r on r.id = fa.response_id
        where r.video_call_id = ${callId} and r.form_id = ${formId}
        group by fa.question_id`,
  );
  for (const r of answered) of(r.question_id).answered = r.n;
  const choices = await rows<{ question_id: string; id: string; n: number }>(
    tx,
    sql`select fa.question_id, c.id, count(*)::int as n
        from app.form_answers fa join app.form_responses r on r.id = fa.response_id,
          unnest(fa.choice_ids) as c(id)
        where r.video_call_id = ${callId} and r.form_id = ${formId}
        group by fa.question_id, c.id`,
  );
  for (const r of choices) of(r.question_id).byChoice[r.id] = r.n;
  const numbers = await rows<{ question_id: string; v: string; n: number }>(
    tx,
    sql`select fa.question_id, trim_scale(fa.number_value)::text as v, count(*)::int as n
        from app.form_answers fa join app.form_responses r on r.id = fa.response_id
        where r.video_call_id = ${callId} and r.form_id = ${formId} and fa.number_value is not null
        group by fa.question_id, fa.number_value`,
  );
  for (const r of numbers) of(r.question_id).byNumber[r.v] = r.n;
  return byQuestion as Map<string, PollCounts>;
}

const NO_COUNTS: PollCounts = { answered: 0, byChoice: {}, byNumber: {} };

// ---------- picking the poll ----------

export const videoCallSetPoll = defineCommand({
  name: 'video_call.set_poll',
  description:
    'Pick the live poll whose questions pop up in a HandsFreeOS video call, or take it off. Live polls are made in Forms.',
  risk: 1,
  input: z.object({ workspaceId: uuid, callId: uuid, formId: uuid.nullable() }),
  output: z.object({ changed: z.boolean(), pollFormId: uuid.nullable() }),
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['video_call.poll_set'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const call = await lockVideoCall(ctx, input.callId);
    if (call.pollFormId === input.formId) return { changed: false, pollFormId: call.pollFormId };
    if (await openPollIn(ctx.tx, call.id))
      throw HfosError.rule(
        'poll_question_open',
        409,
        'A question is up right now. Close it first, then pick another poll.',
      );
    const form = input.formId ? await pollForm(ctx.tx, ctx.scope.workspaceId!, input.formId) : null;
    await ctx.tx
      .update(videoCalls)
      .set({ pollFormId: input.formId })
      .where(eq(videoCalls.id, call.id));
    await ctx.emit({
      type: 'video_call.poll_set',
      entityType: 'video_call',
      entityId: call.id,
      payload: { appointmentId: call.appointmentId, formId: input.formId },
      after: { poll: form?.name ?? null },
      broadcast: false,
    });
    return { changed: true, pollFormId: input.formId };
  },
});

// ---------- asking, skipping and closing ----------

export const videoCallPollOpen = defineCommand({
  name: 'video_call.poll_open',
  description:
    'Pop a question or button from the call’s live poll up on everyone’s screen in a HandsFreeOS video call. Any question that’s up closes.',
  risk: 1,
  input: z.object({ workspaceId: uuid, callId: uuid, questionId: QuestionId }),
  output: z.object({ changed: z.boolean(), pollId: uuid, closesAt: isoDateTime }),
  permission: 'appointments.write',
  // The AI hearing the presenter asks too (part 3), as the system.
  actors: ['human', 'system'],
  scope: inWorkspace,
  emits: ['video_call.poll_opened', 'video_call.poll_closed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const call = await lockVideoCall(ctx, input.callId);
    if (call.state === 'ended')
      throw HfosError.rule(
        'video_call_over',
        409,
        'This call has ended, so its questions can’t pop up anymore.',
      );
    if (!call.pollFormId)
      throw HfosError.rule(
        'no_poll',
        409,
        'This call has no live poll yet. Pick one in the Live poll panel first.',
      );
    const { form, versionId, definition } = await publishedPoll(ctx.tx, ws, call.pollFormId);
    const question = findQuestion(definition, input.questionId)?.question;
    if (!question)
      throw HfosError.notFound(
        `That question isn’t in the published “${form.name}”. Publish it again in Forms, then ask it.`,
      );
    const [existing] = await ctx.tx
      .select()
      .from(videoCallPolls)
      .where(
        and(
          eq(videoCallPolls.videoCallId, call.id),
          eq(videoCallPolls.formId, form.id),
          eq(videoCallPolls.questionId, question.id),
        ),
      )
      .for('update');
    if (existing?.state === 'open')
      return { changed: false, pollId: existing.id, closesAt: existing.closesAt!.toISOString() };
    if (existing?.state === 'closed')
      throw HfosError.rule(
        'poll_already_asked',
        409,
        `“${question.title}” was already asked in this call. Its answers are in the panel.`,
      );
    const up = await openPollIn(ctx.tx, call.id, true);
    if (up) await closePoll(ctx, call, up, 'replaced');

    const now = new Date();
    const closesAt = new Date(now.getTime() + liveOf(question).seconds * 1000);
    const opener =
      ctx.actor.type === 'human'
        ? { openedBy: 'team' as const, openedByUserId: ctx.actor.userId }
        : { openedBy: 'ai' as const, openedByUserId: null };
    const values = {
      state: 'open',
      versionId,
      openedAt: now,
      closesAt,
      closedAt: null,
      ...opener,
    };
    const [row] = existing
      ? await ctx.tx
          .update(videoCallPolls)
          .set(values)
          .where(eq(videoCallPolls.id, existing.id))
          .returning()
      : await ctx.tx
          .insert(videoCallPolls)
          .values({
            ...values,
            workspaceId: ws,
            videoCallId: call.id,
            formId: form.id,
            questionId: question.id,
          })
          .returning();
    await ctx.emit({
      type: 'video_call.poll_opened',
      entityType: 'video_call',
      entityId: call.id,
      payload: {
        appointmentId: call.appointmentId,
        pollId: row!.id,
        formId: form.id,
        versionId,
        questionId: question.id,
        closesAt: closesAt.toISOString(),
        openedBy: opener.openedBy,
      },
      after: { question: question.title },
      broadcast: false,
    });
    return { changed: true, pollId: row!.id, closesAt: closesAt.toISOString() };
  },
});

export const videoCallPollSkip = defineCommand({
  name: 'video_call.poll_skip',
  description:
    'Skip a question in the call’s live poll for now, so the next one is up next. It can still be asked later.',
  risk: 0,
  input: z.object({ workspaceId: uuid, callId: uuid, questionId: QuestionId }),
  output: z.object({ changed: z.boolean() }),
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['video_call.poll_skipped'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const call = await lockVideoCall(ctx, input.callId);
    if (!call.pollFormId)
      throw HfosError.rule('no_poll', 409, 'This call has no live poll to skip a question of.');
    const { form, versionId, definition } = await publishedPoll(
      ctx.tx,
      ctx.scope.workspaceId!,
      call.pollFormId,
    );
    const question = findQuestion(definition, input.questionId)?.question;
    if (!question) throw HfosError.notFound(`That question isn’t in the published “${form.name}”.`);
    const [made] = await ctx.tx
      .insert(videoCallPolls)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        videoCallId: call.id,
        formId: form.id,
        versionId,
        questionId: question.id,
        state: 'skipped',
        openedBy: 'team',
        openedByUserId: ctx.actor.type === 'human' ? ctx.actor.userId : null,
      })
      .onConflictDoNothing()
      .returning({ id: videoCallPolls.id });
    if (!made) return { changed: false };
    await ctx.emit({
      type: 'video_call.poll_skipped',
      entityType: 'video_call',
      entityId: call.id,
      payload: { appointmentId: call.appointmentId, pollId: made.id, questionId: question.id },
      after: { question: question.title },
      broadcast: false,
    });
    return { changed: true };
  },
});

export const videoCallPollClose = defineCommand({
  name: 'video_call.poll_close',
  description: 'Close the question that’s up in a HandsFreeOS video call’s live poll.',
  risk: 0,
  input: z.object({ workspaceId: uuid, callId: uuid, pollId: uuid }),
  output: z.object({ changed: z.boolean() }),
  permission: 'appointments.write',
  // The worker closes it when its time is up.
  actors: ['human', 'system'],
  scope: inWorkspace,
  emits: ['video_call.poll_closed'],
  async handler(ctx, input) {
    const call = await lockVideoCall(ctx, input.callId);
    const [poll] = await ctx.tx
      .select()
      .from(videoCallPolls)
      .where(and(eq(videoCallPolls.id, input.pollId), eq(videoCallPolls.videoCallId, call.id)))
      .for('update');
    if (!poll || poll.state !== 'open') return { changed: false };
    const timeUp = ctx.actor.type !== 'human';
    // A job that runs a moment early, or for a question asked again since, leaves it be.
    if (timeUp && poll.closesAt && poll.closesAt.getTime() > Date.now() + 1_000)
      return { changed: false };
    await closePoll(ctx, call, poll, timeUp ? 'time' : 'team');
    return { changed: true };
  },
});

// ---------- answering ----------

/**
 * Someone in the call answers the question that's up, from their page on their own link (the worker's). Their answers
 * are one response on their contact, made with the first.
 */
export const videoCallPollAnswer = defineCommand({
  name: 'video_call.poll_answer',
  description:
    'Worker: someone in a HandsFreeOS video call answered the live poll’s question that’s up, or pressed its button.',
  risk: 0,
  input: z
    .object({
      workspaceId: uuid,
      pollId: uuid,
      /** A customer on a booking's Join link. */
      attendeeId: uuid.optional(),
      /** A customer on the link the team sent for a call that isn't for an appointment: the customer. */
      personId: uuid.optional(),
      value: z.unknown(),
    })
    .refine((i) => !!i.attendeeId !== !!i.personId, {
      error: 'Say who answered: their seat or the customer, not both.',
    }),
  output: z.object({
    status: z.enum(['saved', 'already', 'closed']),
    /** This answer was the one that got nearly everyone. */
    closed: z.boolean(),
  }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['video_call.poll_closed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [poll] = await ctx.tx
      .select()
      .from(videoCallPolls)
      .where(and(eq(videoCallPolls.id, input.pollId), eq(videoCallPolls.workspaceId, ws)))
      .for('update');
    if (!poll) throw HfosError.notFound('That question isn’t up anymore.');
    if (
      poll.state !== 'open' ||
      !poll.closesAt ||
      poll.closesAt.getTime() + POLL_GRACE_MS < Date.now()
    )
      return { status: 'closed' as const, closed: false };
    const [call] = await ctx.tx
      .select()
      .from(videoCalls)
      .where(eq(videoCalls.id, poll.videoCallId));
    if (!call) throw HfosError.notFound('That call isn’t there anymore.');

    // Whose answer it is: the seat must be on this call's appointment, the customer the one the call is with.
    let personId: string | null = null;
    if (input.attendeeId && call.appointmentId) {
      const [seat] = await rows<{ person_id: string }>(
        ctx.tx,
        sql`select person_id from app.appointment_attendees
            where id = ${input.attendeeId} and appointment_id = ${call.appointmentId}
              and status in ('booked', 'attended')`,
      );
      personId = seat?.person_id ?? null;
    } else if (input.personId && call.personId === input.personId) personId = input.personId;
    if (!personId)
      throw HfosError.rule(
        'poll_not_yours',
        403,
        'Only people in this call on their own link can answer its questions.',
      );

    const question = await questionOf(ctx.tx, poll);
    if (!question)
      throw HfosError.internal('This question changed while it was up. Try again in a moment.');
    const value = (
      question.type === 'yes_no' && (input.value === 'yes' || input.value === 'no')
        ? input.value === 'yes'
        : input.value
    ) as AnswerValue;
    const problem = answerIsEmpty(value)
      ? question.type === 'button'
        ? 'Press the button.'
        : 'Answer this one first.'
      : answerProblem(question, value);
    if (problem)
      throw new HfosError(
        'validation',
        400,
        problem,
        { problems: [{ questionId: question.id, message: problem }] },
        'poll_answer_invalid',
      );

    // Their sheet: one per person per poll in the call, made with their first answer.
    await ctx.tx
      .insert(formResponses)
      .values({
        workspaceId: ws,
        formId: poll.formId,
        versionId: poll.versionId,
        status: 'in_progress',
        source: 'video_call',
        personId,
        videoCallId: call.id,
        lastActiveAt: new Date(),
      })
      .onConflictDoNothing();
    const [sheet] = await rows<{ id: string; answered: boolean }>(
      ctx.tx,
      sql`select r.id, exists (select 1 from app.form_answers fa
                               where fa.response_id = r.id and fa.question_id = ${question.id}) as answered
          from app.form_responses r
          where r.video_call_id = ${call.id} and r.form_id = ${poll.formId} and r.person_id = ${personId}
          for update of r`,
    );
    if (!sheet) throw HfosError.internal('We couldn’t save that answer. Try again in a moment.');
    if (sheet.answered) return { status: 'already' as const, closed: false };

    const labels = CHOICE_TYPES.has(question.type)
      ? (Array.isArray(value) ? value.map(String) : [String(value)]).map(
          (id) =>
            (question.config as { choices: { id: string; label: string }[] }).choices.find(
              (c) => c.id === id,
            )?.label ?? id,
        )
      : [];
    await writeFormAnswers(ctx.tx, { workspaceId: ws, responseId: sheet.id, formId: poll.formId }, [
      { questionId: question.id, title: question.title, type: question.type, value, labels },
    ]);
    await ctx.tx
      .update(formResponses)
      .set({
        answers: dsql`${formResponses.answers} || jsonb_build_object(${question.id}::text, ${JSON.stringify(value)}::jsonb)`,
        lastActiveAt: new Date(),
      })
      .where(eq(formResponses.id, sheet.id));
    const [counted] = await ctx.tx
      .update(videoCallPolls)
      .set({ answers: dsql`${videoCallPolls.answers} + 1` })
      .where(eq(videoCallPolls.id, poll.id))
      .returning();

    // Nearly everyone watching has answered: no need to wait out the clock.
    if (counted && closesEarly(counted.answers, await watchingIn(ctx.tx, call.id))) {
      await closePoll(ctx, call, counted, 'nearly_all');
      return { status: 'saved' as const, closed: true };
    }
    return { status: 'saved' as const, closed: false };
  },
});

/**
 * The call is over (the worker's, when LiveKit closes the room or the team ends it): the question that's up closes,
 * and each person's sheet is sent, so `form.submitted` goes out for it as for any form.
 */
export const videoCallPollsFinish = defineCommand({
  name: 'video_call.polls_finish',
  description:
    'Worker: a HandsFreeOS video call is over, so its live poll closes and each person’s answers are sent as their form response.',
  risk: 0,
  input: z.object({ workspaceId: uuid, callId: uuid }),
  output: z.object({ sent: z.int().min(0) }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['video_call.poll_closed', 'form.submitted'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const call = await lockVideoCall(ctx, input.callId);
    const up = await openPollIn(ctx.tx, call.id, true);
    if (up) await closePoll(ctx, call, up, 'ended');
    const sheets = await ctx.tx
      .update(formResponses)
      .set({ status: 'completed', completedAt: new Date() })
      .where(
        and(
          eq(formResponses.workspaceId, ws),
          eq(formResponses.videoCallId, call.id),
          eq(formResponses.status, 'in_progress'),
        ),
      )
      .returning();
    const names = new Map<string, string>();
    for (const sheet of sheets) {
      if (!names.has(sheet.formId)) {
        const [f] = await ctx.tx
          .select({ name: forms.name })
          .from(forms)
          .where(eq(forms.id, sheet.formId));
        names.set(sheet.formId, f?.name ?? 'Live poll');
        await ctx.tx.execute(
          sql`insert into app.form_days (workspace_id, form_id, day, completions)
              values (${ws}, ${sheet.formId}, current_date,
                      ${sheets.filter((s) => s.formId === sheet.formId).length})
              on conflict (form_id, day) do update
                set completions = app.form_days.completions + excluded.completions`,
        );
      }
      await ctx.emit({
        type: 'form.submitted',
        entityType: 'form',
        entityId: sheet.formId,
        payload: {
          responseId: sheet.id,
          formId: sheet.formId,
          versionId: sheet.versionId,
          personId: sheet.personId,
          leadId: null,
          resultId: null,
          mode: 'poll',
          score: null,
          scorePercent: null,
          passed: null,
          dueCents: 0,
          invoiceId: null,
          videoCallId: call.id,
        },
        after: {
          form: names.get(sheet.formId)!,
          answers: Object.keys((sheet.answers ?? {}) as object).length,
        },
      });
    }
    return { sent: sheets.length };
  },
});

// ---------- reading ----------

const PollQuestionOut = z.object({
  questionId: z.string(),
  type: z.string(),
  title: z.string(),
  seconds: z.int(),
  showResults: z.boolean(),
  /** A button's words and what it does. */
  button: z.object({ label: z.string(), action: z.enum(['link', 'book', 'talk']) }).nullable(),
  /** Not asked yet, up now, asked, or skipped for now. */
  state: z.enum(['waiting', 'open', 'closed', 'skipped']),
  pollId: uuid.nullable(),
  openedBy: z.enum(POLL_OPENERS).nullable(),
  openedAt: isoDateTime.nullable(),
  closesAt: isoDateTime.nullable(),
  totals: PollTotals,
  /** A short answer: what people typed, newest first. */
  texts: z.array(z.object({ name: z.string(), text: z.string() })),
  /** A button: who pressed it, newest first. */
  pressed: z.array(z.object({ personId: uuid, name: z.string() })),
});

const PollsOut = z.object({
  /** The call's poll; null when it has none. */
  form: z
    .object({
      id: uuid,
      name: z.string(),
      /** Published and taking answers, so its questions can be asked. */
      ready: z.boolean(),
    })
    .nullable(),
  /** Everyone in the call now who isn't on the team. */
  watching: z.int(),
  questions: z.array(PollQuestionOut),
});

/** A call's live poll for the team's panel: every question, how it stands, and the answers so far. */
export const videoCallPollsGet = defineQuery({
  name: 'video_call.polls',
  description:
    'A HandsFreeOS video call’s live poll: each question and button, whether it’s been asked, and the answers and totals so far.',
  input: z.object({ workspaceId: uuid, callId: uuid }),
  output: PollsOut,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [call] = await ctx.tx
      .select()
      .from(videoCalls)
      .where(and(eq(videoCalls.id, input.callId), eq(videoCalls.workspaceId, ws)));
    if (!call)
      throw HfosError.notFound(
        'That video call isn’t there anymore, or isn’t one you can see. Open it again from the appointment.',
      );
    const watching = await watchingIn(ctx.tx, call.id);
    if (!call.pollFormId) return { form: null, watching, questions: [] };
    const [form] = await ctx.tx
      .select()
      .from(forms)
      .where(and(eq(forms.id, call.pollFormId), eq(forms.workspaceId, ws)));
    if (!form) return { form: null, watching, questions: [] };
    const published = await publishedPoll(ctx.tx, ws, form.id).catch(() => null);
    // Not published yet: the draft's questions, to look at; nothing can be asked until it is.
    const definition = published?.definition ?? (await loadForm(ctx.tx, ws, form.id)).definition;
    const asked = await ctx.tx
      .select()
      .from(videoCallPolls)
      .where(and(eq(videoCallPolls.videoCallId, call.id), eq(videoCallPolls.formId, form.id)));
    const byQuestion = new Map(asked.map((p) => [p.questionId, p]));
    const counts = await pollCounts(ctx.tx, call.id, form.id);
    const said = await rows<{
      question_id: string;
      person_id: string | null;
      first_name: string | null;
      last_name: string | null;
      text_value: string | null;
      question_type: string;
    }>(
      ctx.tx,
      sql`select * from (
            select fa.question_id, r.person_id, p.first_name, p.last_name, fa.text_value, fa.question_type,
              row_number() over (partition by fa.question_id order by fa.answered_at desc) as n
            from app.form_answers fa
              join app.form_responses r on r.id = fa.response_id
              left join app.people p on p.id = r.person_id
            where r.video_call_id = ${call.id} and r.form_id = ${form.id}
              and fa.question_type in ('short_text', 'button')
          ) x
          where (question_type = 'short_text' and n <= ${POLL_TEXTS_SHOWN})
             or (question_type = 'button' and n <= ${POLL_PRESSED_SHOWN})`,
    );
    const nameOf = (r: { first_name: string | null; last_name: string | null }) =>
      [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Someone';
    return {
      form: { id: form.id, name: form.name, ready: !!published },
      watching,
      questions: allQuestions(definition).map((question) => {
        const p = byQuestion.get(question.id);
        const live = liveOf(question);
        const button =
          question.type === 'button'
            ? (question.config as { label: string; action: 'link' | 'book' | 'talk' })
            : null;
        const mine = said.filter((s) => s.question_id === question.id);
        return {
          questionId: question.id,
          type: question.type,
          title: question.title,
          seconds: live.seconds,
          showResults: live.showResults,
          button: button ? { label: button.label, action: button.action } : null,
          state: (p?.state ?? 'waiting') as 'waiting' | 'open' | 'closed' | 'skipped',
          pollId: p?.id ?? null,
          openedBy: (p?.openedAt ? p.openedBy : null) as 'team' | 'ai' | null,
          openedAt: iso(p?.openedAt ?? null),
          closesAt: p?.state === 'open' ? iso(p.closesAt) : null,
          totals: pollTotals(question, counts.get(question.id) ?? NO_COUNTS),
          texts:
            question.type === 'short_text'
              ? mine.map((s) => ({ name: nameOf(s), text: s.text_value ?? '' }))
              : [],
          pressed:
            question.type === 'button'
              ? mine
                  .filter((s) => s.person_id)
                  .map((s) => ({ personId: s.person_id!, name: nameOf(s) }))
              : [],
        };
      }),
    };
  },
});

/**
 * What a customer's page in the call shows of the live poll (the worker's, when the page comes in or comes back): the
 * question that's up, if any, and whether they already answered it.
 */
export const videoCallPollNow = defineQuery({
  name: 'video_call.poll_now',
  description:
    'Worker: the live poll question that’s up in a HandsFreeOS video call, for a customer’s page, and whether they answered it.',
  input: z.object({
    workspaceId: uuid,
    callId: uuid,
    /** The customer, when the page knows who they are. */
    personId: uuid.nullable(),
  }),
  output: z.object({
    poll: PollOnScreen.nullable(),
    answered: z.boolean(),
    /** For a book button: the booking page's path on the business's site. */
    bookPath: z.string().nullable(),
    business: z.string(),
  }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [biz] = await rows<{ name: string }>(
      ctx.tx,
      sql`select coalesce(bs.name, w.name) as name from app.workspaces w
          left join app.booking_sites bs on bs.workspace_id = w.id where w.id = ${ws}`,
    );
    const business = biz?.name ?? 'the business';
    const poll = await openPollIn(ctx.tx, input.callId);
    if (!poll || !poll.closesAt || poll.closesAt.getTime() <= Date.now())
      return { poll: null, answered: false, bookPath: null, business };
    const question = await questionOf(ctx.tx, poll);
    if (!question) return { poll: null, answered: false, bookPath: null, business };
    const bookPath = await bookPathOf(ctx.tx, ws, question);
    const [mine] = input.personId
      ? await rows<{ id: string }>(
          ctx.tx,
          sql`select fa.response_id as id from app.form_answers fa
              join app.form_responses r on r.id = fa.response_id
              where r.video_call_id = ${input.callId} and r.form_id = ${poll.formId}
                and r.person_id = ${input.personId} and fa.question_id = ${poll.questionId}`,
        )
      : [];
    return {
      poll: pollOnScreen(question, {
        pollId: poll.id,
        closesAt: poll.closesAt.toISOString(),
        buttonUrl: bookPath,
      }),
      answered: !!mine,
      bookPath,
      business,
    };
  },
});

/** Where a book button goes: the calendar's booking page, on the business's booking site. Null when there isn't one. */
export async function bookPathOf(tx: Tx, ws: string, question: Question): Promise<string | null> {
  if (question.type !== 'button') return null;
  const { action, calendarId } = question.config as { action: string; calendarId: string };
  if (action !== 'book' || !calendarId) return null;
  const [row] = await rows<{ site: string; calendar: string }>(
    tx,
    sql`select bs.slug as site, c.slug as calendar
        from app.calendars c join app.booking_sites bs on bs.workspace_id = c.workspace_id
        where c.id = ${calendarId} and c.workspace_id = ${ws} and bs.enabled and c.status = 'active'`,
  );
  return row ? `/book/${row.site}/${row.calendar}` : null;
}

/** The question a poll row asked, for the worker telling the room. */
export async function videoCallPollQuestion(
  tx: Tx,
  pollId: string,
): Promise<{ poll: PollRow; question: Question } | null> {
  const [poll] = await tx.select().from(videoCallPolls).where(eq(videoCallPolls.id, pollId));
  if (!poll) return null;
  const question = await questionOf(tx, poll);
  return question ? { poll, question } : null;
}

export const videoCallPollCommands = [
  videoCallSetPoll,
  videoCallPollOpen,
  videoCallPollSkip,
  videoCallPollClose,
  videoCallPollAnswer,
  videoCallPollsFinish,
] as const;

export const videoCallPollQueries = [videoCallPollsGet, videoCallPollNow] as const;
