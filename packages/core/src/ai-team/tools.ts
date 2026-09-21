/**
 * The AI teammate's tools: what it can do for the customer in the conversation it's answering, and nothing
 * more. The Assistant's tools reach the whole business as the signed-in person; these never take a person,
 * conversation or workspace id (the worker fills those in from the run). The ids they do take (a calendar,
 * a service, a stage, an appointment, a question) come from the run's context, and the commands check them
 * again: only the teammate's calendars, only this customer's appointments, only open stages.
 *
 * Autonomy:
 * - `auto` runs at once in every mode: look-ups and internal work (answers, stages, notes, tasks).
 * - `draft` reaches the customer, so with training wheels it's held in the reply's one draft until a person
 *   approves (a reply, a booking, a reschedule, a cancellation).
 * - `approval` always waits for a person, even once the teammate is automatic (a discount).
 *
 * `hand_off`, `reply` and `no_reply` end the turn (`TEAMMATE_TURN_ENDERS`).
 */
import { z } from 'zod';
import { isLocalDate } from '../calendar/engine/zoned';
import type { TeammateConfig, TeammateSkill } from './config';

export type TeammateToolAutonomy = 'auto' | 'draft' | 'approval';
/** What turns a tool on: a skill, `core` (every teammate) or `discounts` (discounts "with approval"). */
export type TeammateToolSkill = TeammateSkill | 'core' | 'discounts';

export interface TeammateTool<I extends z.ZodType = z.ZodType> {
  readonly name: string;
  /** What the model reads to decide when to call it. */
  readonly description: string;
  readonly input: I;
  readonly skill: TeammateToolSkill;
  readonly autonomy: TeammateToolAutonomy;
}

const define = <N extends string, I extends z.ZodType>(t: TeammateTool<I> & { readonly name: N }) =>
  t;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();
const uuid = z.uuid();
/** The model writes local times with their offset; commands take UTC, so the tool turns one into the other. */
const when = z.iso
  .datetime({ offset: true })
  .describe('ISO 8601 date and time with the workspace offset, e.g. 2026-09-17T09:00:00-05:00')
  .transform((s) => new Date(s).toISOString());
const dayOrWhen = z.union([
  z
    .string()
    .refine(isLocalDate, { error: 'Use a date like 2026-09-17.' })
    .describe('A local date for the whole day, e.g. 2026-09-17'),
  when,
]);

/** Why the teammate hands a conversation to a person (the model picks one of these). */
export const HAND_OFF_REASONS = [
  'asked_for_person',
  'frustrated',
  'sensitive_topic',
  'emergency',
  'unsure',
  'other',
] as const;
/** Hand-offs the worker makes on its own. */
export const SYSTEM_HAND_OFF_REASONS = [
  'reply_limit',
  'budget',
  'wallet',
  'error',
  'check_failed',
  'draft_expired',
] as const;
export type HandOffReason =
  (typeof HAND_OFF_REASONS)[number] | (typeof SYSTEM_HAND_OFF_REASONS)[number];

export const HAND_OFF_REASON_LABELS: Readonly<Record<HandOffReason, string>> = {
  asked_for_person: 'Asked for a person',
  frustrated: 'Sounds frustrated',
  sensitive_topic: 'A sensitive topic',
  emergency: 'An emergency',
  unsure: 'A question it couldn’t answer',
  other: 'Needs a person',
  reply_limit: 'Reached today’s reply limit',
  budget: 'Reached the AI limit',
  wallet: 'The balance ran out',
  error: 'Something went wrong',
  check_failed: 'Its reply didn’t pass the safety check',
  draft_expired: 'Nobody decided its draft in time',
};

export const TEAMMATE_TOOLS = [
  // ---------- knowledge ----------
  define({
    name: 'search_knowledge',
    description:
      'Search the business’s published knowledge (FAQs, facts, articles and documents) for what to tell the customer: services, prices, policies, hours. Answer only from what it returns. Run it again with other words if nothing fits; if still nothing answers the question, follow your “when unsure” rule.',
    input: z.strictObject({ query: text(300) }),
    skill: 'answer',
    autonomy: 'auto',
  }),

  // ---------- the phone ----------
  define({
    name: 'read_call_transcript',
    description:
      'What was said on one call in this conversation, in full. The history shows a voicemail’s words and the start of a longer call’s; use this when it says there is more, or to re-read one. Only calls in this conversation, by the callId the history gives.',
    input: z.strictObject({ callId: uuid.describe('A callId from the history') }),
    skill: 'core',
    autonomy: 'auto',
  }),

  // ---------- calendar ----------
  define({
    name: 'find_times',
    description:
      'Open times on one of your calendars (ids in the context), optionally for a service and a length. Give a local date for a whole day, or times with the offset; `to` defaults to the end of `from`’s day. Offer the customer two or three of the times it returns; book only a time it returned.',
    input: z.strictObject({
      calendarId: uuid.describe('One of your calendars'),
      from: dayOrWhen,
      to: dayOrWhen.optional(),
      serviceId: uuid.optional(),
      durationMinutes: z.int().min(5).max(720).optional().describe('Length in minutes'),
    }),
    skill: 'book',
    autonomy: 'auto',
  }),
  define({
    name: 'my_appointments',
    description:
      'The customer’s upcoming appointments with the business, with ids, to reschedule or cancel one they ask about.',
    input: z.strictObject({}),
    skill: 'book',
    autonomy: 'auto',
  }),
  define({
    name: 'book',
    description:
      'Book the customer at a time find_times offered in this conversation. They get the usual confirmation. Only say they’re booked after this succeeds.',
    input: z.strictObject({
      calendarId: uuid.describe('One of your calendars'),
      startsAt: when,
      serviceId: uuid.optional(),
      notes: optionalText(1000).describe('What the visit is for, in the customer’s words'),
    }),
    skill: 'book',
    autonomy: 'draft',
  }),
  define({
    name: 'reschedule',
    description:
      'Move one of the customer’s upcoming appointments (from my_appointments) to a time find_times offered.',
    input: z.strictObject({ appointmentId: uuid, startsAt: when }),
    skill: 'book',
    autonomy: 'draft',
  }),
  define({
    name: 'cancel',
    description:
      'Cancel one of the customer’s upcoming appointments (from my_appointments) when they ask you to.',
    input: z.strictObject({ appointmentId: uuid, reason: optionalText(300) }),
    skill: 'book',
    autonomy: 'draft',
  }),

  // ---------- qualifying ----------
  define({
    name: 'record_answers',
    description:
      'Save the customer’s answers to the qualifying questions (ids in the context), in their words, as soon as they give them. The lead page shows them, and the business hears when the lead qualifies.',
    input: z.strictObject({
      answers: z
        .array(
          z.strictObject({
            questionId: z.string().trim().min(1).max(40),
            answer: text(500),
          }),
        )
        .min(1)
        .max(10),
    }),
    skill: 'qualify',
    autonomy: 'auto',
  }),
  define({
    name: 'ask_form',
    description:
      'Start one of the business’s forms in this conversation (the ones in your context). It comes back with the first question to ask; ask it in your own words, one at a time.',
    input: z.strictObject({ formId: uuid }),
    skill: 'qualify',
    autonomy: 'auto',
  }),
  define({
    name: 'answer_form',
    description:
      'Save what the customer just told you for one question of the form you are asking, and get the next one. When there are no questions left it is sent, and what the form does (the customer’s details, a lead, the follow-ups) happens then.',
    input: z.strictObject({
      formId: uuid,
      questionId: z.string().trim().min(1).max(40),
      /** Their answer in their own words; a choice may be named rather than given by id. */
      answer: text(500),
    }),
    skill: 'qualify',
    autonomy: 'auto',
  }),
  define({
    name: 'move_stage',
    description:
      'Move the customer’s lead to another open stage of its pipeline (ids in the context), for example the one your settings name for qualified leads.',
    input: z.strictObject({ stageId: uuid, reason: optionalText(300) }),
    skill: 'qualify',
    autonomy: 'auto',
  }),

  // ---------- the customer's record ----------
  define({
    name: 'update_customer',
    description:
      'Fill in the customer’s name, email, phone or address when they tell you. Only blank fields are filled; anything already on file stays as it is.',
    input: z
      .strictObject({
        firstName: optionalText(80),
        lastName: optionalText(80),
        email: z.email().max(254).optional(),
        phone: z.string().trim().min(7).max(40).optional(),
        address: z
          .strictObject({
            line1: optionalText(200),
            line2: optionalText(200),
            city: optionalText(100),
            state: optionalText(50),
            postalCode: optionalText(20),
          })
          .optional(),
      })
      .refine((v) => Object.values(v).some((x) => x !== undefined), {
        error: 'Give at least one detail.',
      }),
    skill: 'core',
    autonomy: 'auto',
  }),
  define({
    name: 'add_note',
    description:
      'Add a note to the customer’s timeline: something the team should know that the conversation doesn’t make obvious.',
    input: z.strictObject({ body: text(2000) }),
    skill: 'core',
    autonomy: 'auto',
  }),
  define({
    name: 'create_task',
    description:
      'Leave the team a task about this customer (it goes to the lead’s assignee, then the customer’s owner), such as a callback you promised.',
    input: z.strictObject({ title: text(200), notes: optionalText(1000), dueAt: when.optional() }),
    skill: 'core',
    autonomy: 'auto',
  }),

  // ---------- discounts ----------
  define({
    name: 'offer_discount',
    description:
      'Propose a discount, at most the percent your settings allow, with what you’d tell the customer. A person decides before the customer hears anything; never mention a discount any other way. Refunds always go to a person: hand off instead.',
    input: z.strictObject({
      percent: z.int().min(1).max(50),
      reason: text(300).describe('Why, for the person deciding'),
      message: text(1000).describe('What the customer would be told'),
    }),
    skill: 'discounts',
    autonomy: 'approval',
  }),

  // ---------- ending the turn ----------
  define({
    name: 'hand_off',
    description:
      'Hand the conversation to a person and stop replying: when they ask for a person, sound frustrated, raise a legal threat, a complaint, a refund or cancelling service, or you can’t help. The note tells the team what’s going on; the customer gets the business’s hand-off message.',
    input: z.strictObject({ reason: z.enum(HAND_OFF_REASONS), note: text(1000) }),
    skill: 'core',
    autonomy: 'auto',
  }),
  define({
    name: 'reply',
    description:
      'Send your reply to the customer and end your turn. Keep to the channel’s length, and sign it the way your settings say.',
    input: z.strictObject({ message: text(4000) }),
    skill: 'core',
    autonomy: 'draft',
  }),
  define({
    name: 'no_reply',
    description:
      'End your turn without replying, when nothing needs an answer: a thank-you, an automatic message, or a conversation that’s finished.',
    input: z.strictObject({ reason: text(300) }),
    skill: 'core',
    autonomy: 'auto',
  }),
] as const;

export type TeammateToolName = (typeof TEAMMATE_TOOLS)[number]['name'];
export const TEAMMATE_TOOL_NAMES = TEAMMATE_TOOLS.map((t) => t.name) as readonly TeammateToolName[];

export const teammateToolByName: ReadonlyMap<string, TeammateTool> = new Map(
  TEAMMATE_TOOLS.map((t) => [t.name, t as TeammateTool]),
);

/** The tools that end the model's turn. */
export const TEAMMATE_TURN_ENDERS: ReadonlySet<TeammateToolName> = new Set([
  'hand_off',
  'reply',
  'no_reply',
]);

/**
 * Hidden from a website chat visitor who matched an existing customer without proving who they are:
 * anyone can type someone else's phone number, so the teammate never reads that customer's bookings back or
 * their calls, never changes a booking (changes go through manage links sent to the contact on file) and
 * never edits them.
 */
export const UNVERIFIED_CHAT_HIDDEN: ReadonlySet<TeammateToolName> = new Set([
  'my_appointments',
  'read_call_transcript',
  'reschedule',
  'cancel',
  'update_customer',
]);

export interface TeammateToolOptions {
  /** The conversation is a website chat whose visitor isn't verified as the matched customer. */
  readonly unverifiedChat?: boolean;
}

/** The tools a teammate's settings turn on, in registry order. */
export function teammateTools(
  config: TeammateConfig,
  opts: TeammateToolOptions = {},
): TeammateTool[] {
  const on: Readonly<Record<TeammateToolSkill, boolean>> = {
    core: true,
    respond: config.respond.enabled,
    answer: config.answer.enabled,
    qualify: config.qualify.enabled,
    book: config.book.enabled,
    followUp: config.followUp.enabled,
    discounts: config.money.discounts === 'with_approval',
  };
  return TEAMMATE_TOOLS.filter((t) => {
    if (!on[t.skill]) return false;
    if (t.name === 'reschedule' && !config.book.reschedule) return false;
    if (t.name === 'cancel' && !config.book.cancel) return false;
    return !(opts.unverifiedChat && UNVERIFIED_CHAT_HIDDEN.has(t.name));
  }) as TeammateTool[];
}
