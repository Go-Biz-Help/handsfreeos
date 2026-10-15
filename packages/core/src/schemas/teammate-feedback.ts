/**
 * Coaching the AI teammate (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md): feedback on a reply it wrote, the
 * question the worker may ask about it, the Instructions list, and Review. Browser-safe.
 */
import { z } from 'zod';
import { ListInput } from './crm';
import { uuid } from './common';
import { LessonConflictSchema } from './teammate-lesson';

/** How long each part may be (app.teammate_feedback, app.teammate_instructions). */
export const FEEDBACK_REPLY_MAX = 2000;
export const FEEDBACK_NOTE_MAX = 500;
export const FEEDBACK_ANSWER_MAX = 300;
export const INSTRUCTION_MAX = 300;
/** The most instructions a teammate keeps. */
export const INSTRUCTIONS_MAX = 50;

export const FEEDBACK_RATINGS = ['good', 'bad'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

/**
 * Where the worker's read of a thumbs down stands. `none`: nothing to read (a thumbs up, or nothing said).
 * `asking`: a question waits for the person. `suggested`: a rule waits for an OK. `nothing`: nothing new to learn.
 * `failed`: the read didn't work, and giving the feedback again tries again.
 */
export const FEEDBACK_LEARN = [
  'none',
  'reading',
  'asking',
  'suggested',
  'nothing',
  'failed',
] as const;
export type FeedbackLearn = (typeof FEEDBACK_LEARN)[number];

/** Optional words: empty is none. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters.`)
    .nullable()
    .optional()
    .transform((v) => v || null);

export const AiTeammateGiveFeedbackInput = z
  .object({
    workspaceId: uuid,
    /** The run that wrote the reply (a test's `started` event, a row in Activity or Review). */
    runId: uuid.optional(),
    /** The message it sent: enough on its own (the inbox and the phone know the message, not its run). */
    messageId: uuid.optional(),
    rating: z.enum(FEEDBACK_RATINGS),
    /** What it should have said. */
    betterReply: text(FEEDBACK_REPLY_MAX),
    /** Why. */
    note: text(FEEDBACK_NOTE_MAX),
    /** A test only: what the customer said, as the console shows it. A real reply's is read from the messages. */
    asked: text(FEEDBACK_REPLY_MAX),
  })
  .refine((v) => !!(v.runId || v.messageId), {
    path: ['runId'],
    message: 'Say which reply this is about.',
  });

export const AiTeammateAnswerFeedbackInput = z.object({
  workspaceId: uuid,
  feedbackId: uuid,
  answer: z
    .string()
    .trim()
    .min(1, 'Pick an answer or write one.')
    .max(FEEDBACK_ANSWER_MAX, `Keep it under ${FEEDBACK_ANSWER_MAX} characters.`),
});

/** A suggested rule, as the feedback shows it. */
export const FeedbackLessonOut = z.object({
  id: uuid,
  line: z.string(),
  why: z.string().nullable(),
  status: z.enum(['open', 'applied', 'dismissed']),
  conflict: LessonConflictSchema.nullable(),
});

export const TeammateFeedbackOut = z.object({
  id: uuid,
  runId: uuid,
  messageId: uuid.nullable(),
  isTest: z.boolean(),
  rating: z.enum(FEEDBACK_RATINGS),
  betterReply: z.string().nullable(),
  note: z.string().nullable(),
  learn: z.enum(FEEDBACK_LEARN),
  /** Why there's nothing to learn ("It already has a rule for this."). */
  learnWhy: z.string().nullable(),
  question: z.string().nullable(),
  choices: z.array(z.string()),
  answer: z.string().nullable(),
  lesson: FeedbackLessonOut.nullable(),
  /** The person's own (only theirs can be changed). */
  mine: z.boolean(),
  by: z.object({ id: uuid, name: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TeammateFeedbackOut = z.infer<typeof TeammateFeedbackOut>;

export const AiTeammateFeedbackOutput = z.object({ feedback: TeammateFeedbackOut });

export const AiTeammateFeedbackListInput = z
  .object({
    workspaceId: uuid,
    /** The replies on the screen, by run: a test's or Activity's. */
    runIds: z.array(uuid).max(100).default([]),
    /** …or by the messages it sent: a conversation's. */
    messageIds: z.array(uuid).max(100).default([]),
  })
  .refine((v) => v.runIds.length + v.messageIds.length > 0, {
    path: ['runIds'],
    message: 'Say which replies.',
  });
export const AiTeammateFeedbackListOutput = z.object({
  feedback: z.array(TeammateFeedbackOut),
  /** Each of `messageIds` the AI wrote, with the run that wrote it, so feedback finds its message. */
  messageRuns: z.array(z.object({ messageId: uuid, runId: uuid })),
  /** Whether this person may save a suggested rule (ai_team.manage). */
  canSaveRules: z.boolean(),
});

// ---- Review ----

export const REVIEW_SHOWS = ['unrated', 'all'] as const;
export type ReviewShow = (typeof REVIEW_SHOWS)[number];

export const AiTeammateReviewInput = ListInput.extend({
  workspaceId: uuid,
  /** `unrated`: nobody has given feedback on it yet. */
  show: z.enum(REVIEW_SHOWS).default('unrated'),
});

export const ReviewItemOut = z.object({
  runId: uuid,
  messageId: uuid.nullable(),
  conversationId: uuid.nullable(),
  channel: z.string().nullable(),
  person: z.object({ id: uuid, fullName: z.string() }).nullable(),
  /** Why it wrote: an answer to the customer, a first message, a follow-up or a thank-you. */
  why: z.enum(['answer', 'first_message', 'follow_up', 'other']),
  /** What the customer said, when it answered them. */
  asked: z.string().nullable(),
  reply: z.string(),
  sentAt: z.string(),
  feedback: z.array(TeammateFeedbackOut),
});
export type ReviewItemOut = z.infer<typeof ReviewItemOut>;

export const AiTeammateReviewOutput = z.object({
  items: z.array(ReviewItemOut),
  /** How many it sent on its own in the last 30 days that nobody has rated. */
  unrated: z.int(),
  nextCursor: z.string().nullable(),
  canSaveRules: z.boolean(),
});

// ---- Instructions ----

const instructionBody = z
  .string()
  .trim()
  .min(1, 'Write the instruction.')
  .max(INSTRUCTION_MAX, `Keep it under ${INSTRUCTION_MAX} characters.`);

export const TeammateInstructionOut = z.object({
  id: uuid,
  body: z.string(),
  source: z.enum(['person', 'lesson']),
  by: z.object({ id: uuid, name: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TeammateInstructionOut = z.infer<typeof TeammateInstructionOut>;

export const TeammateInstructionListInput = z.object({ workspaceId: uuid });
export const TeammateInstructionListOutput = z.object({
  teammateId: uuid.nullable(),
  name: z.string().nullable(),
  instructions: z.array(TeammateInstructionOut),
  max: z.int(),
  canManage: z.boolean(),
});

export const TeammateInstructionCreateInput = z.object({
  workspaceId: uuid,
  body: instructionBody,
});
export const TeammateInstructionUpdateInput = z.object({
  workspaceId: uuid,
  instructionId: uuid,
  body: instructionBody,
});
export const TeammateInstructionDeleteInput = z.object({ workspaceId: uuid, instructionId: uuid });
export const TeammateInstructionOutput = z.object({ instruction: TeammateInstructionOut });
export const TeammateInstructionDeleteOutput = z.object({ instructionId: uuid });
