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
 * - `approval` always waits for an owner or admin, even once the teammate is automatic (a discount, and M18's
 *   bills, quotes, answers to quotes and plans).
 *
 * `hand_off`, `reply` and `no_reply` end the turn (`TEAMMATE_TURN_ENDERS`).
 */
import { z } from 'zod';
import { isLocalDate } from '../calendar/engine/zoned';
import { REPEAT_EVERY } from '../schemas/ai-team';
import type { TeammateConfig, TeammateSkill } from './config';

export type TeammateToolAutonomy = 'auto' | 'draft' | 'approval';
/**
 * What turns a tool on: a skill, `core` (every teammate), `discounts` (discounts "with approval"), or one of
 * M18's switches: `deals`, and the money ones (`bills`, `newBills`, `quotes` for sending the team's quotes,
 * `buildQuotes` for putting one together, `plans`).
 */
export type TeammateToolSkill =
  | TeammateSkill
  | 'core'
  | 'discounts'
  | 'deals'
  | 'bills'
  | 'newBills'
  | 'quotes'
  | 'buildQuotes'
  | 'plans';

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
const catalogueItem = z.strictObject({
  productId: uuid.describe('A product id from the price list in the context'),
  quantity: z.number().gt(0).max(10_000),
});
const zip = z
  .string()
  .trim()
  .regex(/^[0-9]{5}(?:-?[0-9]{4})?$/, 'A 5-digit ZIP code, like 78701.');
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
      postalCode: zip
        .optional()
        .describe('The customer’s ZIP code, needed on a calendar that goes by ZIP code'),
    }),
    skill: 'book',
    autonomy: 'auto',
  }),
  define({
    name: 'check_service_area',
    description:
      'Whether the business serves a ZIP code, and which of your calendars do. Ask for their ZIP and check it before offering times for a visit at their place.',
    input: z.strictObject({ postalCode: zip }),
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
    name: 'book_repeating',
    description:
      'Book repeat visits, every week or every month on the same weekday (like the 2nd Tuesday), on a calendar the context says takes repeats. The first visit is a time find_times offered; later ones that don’t fit are skipped, and the team sees which. Only when they ask for regular visits.',
    input: z.strictObject({
      calendarId: uuid.describe('One of your calendars that takes repeats'),
      startsAt: when.describe('The first visit: a time find_times offered'),
      every: z.enum(REPEAT_EVERY),
      interval: z
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe('Every this many weeks or months; 1 when left out'),
      times: z.int().min(2).max(52).describe('How many visits, the first included'),
      serviceId: uuid.optional(),
      notes: optionalText(1000).describe('What the visits are for, in the customer’s words'),
    }),
    skill: 'book',
    autonomy: 'draft',
  }),
  define({
    name: 'join_waitlist',
    description:
      'Put the customer on a calendar’s waitlist when nothing open suits them, on a calendar the context says keeps one: for the days and times they want (from and to), or for a full session. They hear when a spot opens. Never promise them a spot.',
    input: z
      .strictObject({
        calendarId: uuid.describe('One of your calendars that keeps a waitlist'),
        from: dayOrWhen.optional().describe('The start of the times they want'),
        to: dayOrWhen.optional().describe('The end of the times they want'),
        appointmentId: uuid.optional().describe('A full session they want a seat in'),
      })
      .refine((v) => !!v.appointmentId || !!v.from, {
        error: 'Give the times they want, or the session.',
      }),
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

  // ---------- deals (M18) ----------
  define({
    name: 'open_deal',
    description:
      'Open a lead (a deal) for the customer when they have none and want work done, titled with what they want, like “AC replacement”. It starts in the pipeline’s first open stage.',
    input: z.strictObject({ title: text(200) }),
    skill: 'deals',
    autonomy: 'auto',
  }),
  define({
    name: 'set_deal_value',
    description:
      'Set what the customer’s lead is worth, in dollars, from a price they agreed to or a quote they accepted. Never guess a value.',
    input: z.strictObject({
      dollars: z.number().min(0).max(10_000_000).describe('What the deal is worth, in dollars'),
    }),
    skill: 'deals',
    autonomy: 'auto',
  }),
  define({
    name: 'close_deal',
    description:
      'Mark the customer’s lead won when they commit (they book the work, accept a quote or pay), or lost when they clearly say they don’t want it, with the reason in their words. Never mark it lost just because they went quiet.',
    input: z.strictObject({
      outcome: z.enum(['won', 'lost']),
      reason: optionalText(300).describe(
        'Why it was lost, in the customer’s words; needed for lost',
      ),
    }),
    skill: 'deals',
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

  // ---------- money (M18): look-ups at once; anything asking for money waits for an owner or admin ----------
  define({
    name: 'my_bills',
    description:
      'The customer’s bills with the business, newest first: what each was for, its total, what’s still owed, whether it’s paid or overdue, and when it’s due. Use the invoiceId to resend one’s pay link.',
    input: z.strictObject({}),
    skill: 'bills',
    autonomy: 'auto',
  }),
  define({
    name: 'send_payment_link',
    description:
      'Ask an owner or admin to send the customer the link to pay one of their bills (an invoiceId from my_bills), with a short message to go with it. Don’t write the link yourself: it’s added for you. Tell the customer only that you’ve asked the team to send it.',
    input: z.strictObject({
      invoiceId: uuid.describe('A bill from my_bills'),
      message: text(600).describe('What goes with the link, for the customer'),
    }),
    skill: 'bills',
    autonomy: 'approval',
  }),
  define({
    name: 'propose_bill',
    description:
      'Ask an owner or admin to bill the customer for things on the price list (product ids and quantities from the context), with a short message. The price list sets the prices. Tell the customer only that the team is getting their bill ready.',
    input: z.strictObject({
      title: optionalText(200).describe('What the bill is for'),
      items: z.array(catalogueItem).min(1).max(20),
      message: text(600).describe('What goes with the bill, for the customer'),
    }),
    skill: 'newBills',
    autonomy: 'approval',
  }),
  define({
    name: 'my_quotes',
    description:
      'The customer’s quotes (estimates), newest first: what each is for, its total, and whether it’s waiting on them, accepted, declined or expired. Use the estimateId to resend one or record their answer.',
    input: z.strictObject({}),
    skill: 'quotes',
    autonomy: 'auto',
  }),
  define({
    name: 'send_quote',
    description:
      'Ask an owner or admin to send the customer one of their quotes (an estimateId from my_quotes), with a short message. Don’t write the link yourself: it’s added for you.',
    input: z.strictObject({
      estimateId: uuid.describe('A quote from my_quotes'),
      message: text(600).describe('What goes with the quote, for the customer'),
    }),
    skill: 'quotes',
    autonomy: 'approval',
  }),
  define({
    name: 'propose_quote',
    description:
      'Ask an owner or admin to send the customer a quote for things on the price list (product ids and quantities from the context), with a short message. The price list sets the prices. Tell the customer only that the team is getting it ready.',
    input: z.strictObject({
      title: optionalText(200).describe('What the quote is for'),
      items: z.array(catalogueItem).min(1).max(20),
      message: text(600).describe('What goes with the quote, for the customer'),
    }),
    skill: 'buildQuotes',
    autonomy: 'approval',
  }),
  define({
    name: 'record_quote_answer',
    description:
      'When the customer clearly says yes or no to one of their quotes (from my_quotes), ask an owner or admin to record it, with the name they gave and their reason for a no. Thank them, and say the team will confirm.',
    input: z.strictObject({
      estimateId: uuid.describe('A quote from my_quotes'),
      accepted: z.boolean(),
      name: text(120).describe('Who said it, as they gave their name'),
      reason: optionalText(500).describe('Why not, for a no'),
      message: text(600).describe('What you’d tell the customer once it’s recorded'),
    }),
    skill: 'quotes',
    autonomy: 'approval',
  }),
  define({
    name: 'offer_plan',
    description:
      'When the customer wants one of the business’s maintenance plans (ids in the context), ask an owner or admin to sign them up, with a short message. They then get a link to add a card. Tell them only that the team is setting it up.',
    input: z.strictObject({
      planId: uuid.describe('One of the plans in the context'),
      message: text(600).describe('What goes with the sign-up, for the customer'),
    }),
    skill: 'plans',
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
  // M18: a chat visitor can't open or close a deal for the customer they typed the number of.
  'open_deal',
  'set_deal_value',
  'close_deal',
  // M18: nor, until a chat can prove who it is, anything to do with their money.
  'my_bills',
  'send_payment_link',
  'propose_bill',
  'my_quotes',
  'send_quote',
  'propose_quote',
  'record_quote_answer',
  'offer_plan',
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
    deals: config.deals.enabled,
    bills: config.money.bills,
    newBills: config.money.newBills,
    quotes: config.money.quotes !== 'off',
    buildQuotes: config.money.quotes === 'build',
    plans: config.money.plans,
  };
  return TEAMMATE_TOOLS.filter((t) => {
    if (!on[t.skill]) return false;
    if (t.name === 'reschedule' && !config.book.reschedule) return false;
    if (t.name === 'cancel' && !config.book.cancel) return false;
    if (t.name === 'join_waitlist' && !config.book.waitlist) return false;
    if (t.name === 'book_repeating' && !config.book.repeats) return false;
    if (t.name === 'check_service_area' && !config.book.serviceArea) return false;
    return !(opts.unverifiedChat && UNVERIFIED_CHAT_HIDDEN.has(t.name));
  }) as TeammateTool[];
}
