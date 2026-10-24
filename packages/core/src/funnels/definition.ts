/**
 * A funnel (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md): the steps a business wants people taken through,
 * which the AI teammate follows. Its stages are a pipeline's stages; each says what it's for, what moves someone
 * on, and what the teammate says there and when. Browser-safe: the steps, the map, the phone, the worker and the
 * AI's draft all read this one definition, and the server saves only what it accepts.
 *
 * - **Who gets in** (`entry`): rules about how someone arrives, plus being added by hand, plus the teammate
 *   suggesting someone (a person says yes first).
 * - **Moves** (`stages[].moves`): when this happens, go to that stage. Something HandsFreeOS sees (`event`),
 *   the teammate judging a reply (`reply`), or time passing with nothing from them (`quiet`).
 * - **Messages** (`stages[].messages`): when (on arriving, a while after, or around their booking), only if they
 *   have or haven't done something by then, what to say (the teammate's brief, or the exact words), how, and how
 *   late it may still go.
 *
 * Forks aren't built: two messages at the same time with opposite "only if"s are drawn as one, and so is a stage's
 * list of moves.
 */
import { z } from 'zod';
import { isClock } from '../calendar/engine/zoned';
import { INTAKE_KINDS } from '../crm/intake-kinds';
import { uuid } from '../schemas/common';

export const FUNNEL_VERSION = 1;

/** The most a business keeps, a funnel holds, and a stage holds. */
export const FUNNEL_LIMITS = {
  funnels: 20,
  stages: 12,
  messages: 8,
  moves: 6,
  entryRules: 6,
} as const;

const shortId = z
  .string()
  .regex(/^[a-z][a-z0-9]{3,15}$/, { error: 'A short id: letters and digits.' });

/** A fresh id for a move, a message or an entry rule ("m3k9x2"). */
export function newFunnelPartId(prefix = 'p'): string {
  let s = prefix;
  for (let i = 0; i < 7; i++)
    s += 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)];
  return s;
}

// ---- What HandsFreeOS sees ----

/**
 * The things a funnel can move someone on when, and check for in a message's "only if". Each is an event core
 * already emits for the person.
 */
export const FUNNEL_EVENTS = {
  'form.submitted': { label: 'they send a form', past: 'sent a form', filter: 'form' },
  'form.stopped': {
    label: 'they stop partway through a form',
    past: 'stopped partway',
    filter: 'form',
  },
  'appointment.booked': { label: 'they book', past: 'booked', filter: 'calendar' },
  'appointment.cancelled': { label: 'they cancel', past: 'cancelled', filter: 'calendar' },
  'attendee.joined': { label: 'they join', past: 'joined', filter: null },
  'attendee.attended': { label: 'it ends and they were there', past: 'attended', filter: null },
  'attendee.no_show': { label: 'it ends without them', past: 'missed it', filter: null },
  'message.received': { label: 'they write back', past: 'written back', filter: null },
} as const satisfies Record<
  string,
  { label: string; past: string; filter: 'form' | 'calendar' | null }
>;
export type FunnelEvent = keyof typeof FUNNEL_EVENTS;
export const FUNNEL_EVENT_KEYS = Object.keys(FUNNEL_EVENTS) as [FunnelEvent, ...FunnelEvent[]];

// ---- Who gets in ----

/**
 * - `new_lead`: any new lead in this funnel's pipeline.
 * - `came_in`: a new lead that came in by one of these ways (Lead intake's: a Facebook lead ad, Indeed, a text…).
 * - `form`: they send this form (a lead in the pipeline is opened for them when they have none).
 * - `booking`: they book on this calendar (likewise).
 */
export const FunnelEntryRule = z.discriminatedUnion('kind', [
  z.object({ id: shortId, kind: z.literal('new_lead') }),
  z.object({
    id: shortId,
    kind: z.literal('came_in'),
    ways: z.array(z.enum(INTAKE_KINDS)).min(1).max(INTAKE_KINDS.length),
  }),
  z.object({ id: shortId, kind: z.literal('form'), formId: uuid }),
  z.object({ id: shortId, kind: z.literal('booking'), calendarId: uuid }),
]);
export type FunnelEntryRule = z.infer<typeof FunnelEntryRule>;

export const FunnelEntry = z.object({
  rules: z.array(FunnelEntryRule).max(FUNNEL_LIMITS.entryRules).default([]),
  /** "Add to funnel" on a person or lead. */
  byHand: z.boolean().default(true),
  /** The teammate may suggest someone who fits, for a person on the team to OK. */
  aiSuggests: z.boolean().default(false),
  /** Where someone who gets in by a rule starts: the pipeline's first open stage when null. */
  startStageId: uuid.nullable().default(null),
});
export type FunnelEntry = z.infer<typeof FunnelEntry>;

// ---- Moves ----

export const FUNNEL_QUIET_MIN_MINUTES = 60;
export const FUNNEL_QUIET_MAX_MINUTES = 90 * 24 * 60;

export const FunnelMove = z.discriminatedUnion('kind', [
  z.object({
    id: shortId,
    kind: z.literal('event'),
    event: z.enum(FUNNEL_EVENT_KEYS),
    /** For a form's or a booking's event: only this form, or this calendar. */
    formId: uuid.nullable().default(null),
    calendarId: uuid.nullable().default(null),
    to: uuid,
  }),
  z.object({
    id: shortId,
    kind: z.literal('reply'),
    /** What they say, as the teammate judges it: "they say they're interested". */
    says: z.string().trim().min(3).max(200),
    to: uuid,
  }),
  z.object({
    id: shortId,
    kind: z.literal('quiet'),
    /** Nothing from them for this long after reaching the stage. */
    minutes: z.number().int().min(FUNNEL_QUIET_MIN_MINUTES).max(FUNNEL_QUIET_MAX_MINUTES),
    to: uuid,
  }),
]);
export type FunnelMove = z.infer<typeof FunnelMove>;

// ---- Messages ----

const MAX_OFFSET = 14 * 24 * 60;
const clock = z.string().refine(isClock, { error: 'Use a time like 16:00.' });

/**
 * When a message goes:
 * - `arrive`: this long after they reach the stage (0 is right away);
 * - `booking`: this long before (negative) or after the start of the booking the stage is timed around;
 * - `booking_day`: on the day of the booking, or this many days before, at this time where the business is.
 */
export const FunnelWhen = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('arrive'), minutes: z.number().int().min(0).max(MAX_OFFSET) }),
  z.object({
    kind: z.literal('booking'),
    minutes: z.number().int().min(-MAX_OFFSET).max(MAX_OFFSET),
  }),
  z.object({
    kind: z.literal('booking_day'),
    daysBefore: z.number().int().min(0).max(7),
    at: clock,
  }),
]);
export type FunnelWhen = z.infer<typeof FunnelWhen>;

/** Only if they have (or haven't) done this since reaching the stage. */
export const FunnelOnlyIf = z.object({ has: z.boolean(), event: z.enum(FUNNEL_EVENT_KEYS) });
export type FunnelOnlyIf = z.infer<typeof FunnelOnlyIf>;

export const FUNNEL_WORDING = ['ai', 'exact'] as const;
export type FunnelWording = (typeof FUNNEL_WORDING)[number];

/** What an exact message may fill in. */
export const FUNNEL_FILLS = ['first_name', 'session_time', 'join_link', 'business'] as const;
export type FunnelFill = (typeof FUNNEL_FILLS)[number];

export const FUNNEL_HOW = ['text', 'email', 'best'] as const;
export type FunnelHow = (typeof FUNNEL_HOW)[number];

export const FunnelMessage = z.object({
  id: shortId,
  when: FunnelWhen,
  onlyIf: FunnelOnlyIf.nullable().default(null),
  /** `ai`: `text` is the teammate's brief. `exact`: `text` goes as written, `{first_name}` and the rest filled in. */
  wording: z.enum(FUNNEL_WORDING).default('ai'),
  text: z.string().trim().min(1).max(1000),
  how: z.enum(FUNNEL_HOW).default('best'),
  /** How late it may still go, in minutes after it was due. Null: the stage's default (funnelGoodFor). */
  goodForMinutes: z.number().int().min(5).max(MAX_OFFSET).nullable().default(null),
});
export type FunnelMessage = z.infer<typeof FunnelMessage>;

// ---- Stages ----

export const FunnelStage = z.object({
  stageId: uuid,
  goal: z.string().trim().max(300).default(''),
  /** What the teammate should know at this stage: talking points it reads only here. */
  knows: z.string().trim().max(1000).default(''),
  moves: z.array(FunnelMove).max(FUNNEL_LIMITS.moves).default([]),
  messages: z.array(FunnelMessage).max(FUNNEL_LIMITS.messages).default([]),
  /** After this stage's first messages, the teammate hands the conversation to the team. */
  handOff: z.boolean().default(false),
});
export type FunnelStage = z.infer<typeof FunnelStage>;

export const FUNNEL_APPROVALS = ['teammate', 'ask', 'send'] as const;
export type FunnelApproval = (typeof FUNNEL_APPROVALS)[number];

export const FunnelDefinition = z
  .object({
    v: z.literal(FUNNEL_VERSION).default(FUNNEL_VERSION),
    entry: FunnelEntry.prefault({}),
    stages: z.array(FunnelStage).max(FUNNEL_LIMITS.stages).default([]),
    /** Who writes a new message by default. Each message can still be set the other way. */
    wording: z.enum(FUNNEL_WORDING).default('ai'),
    /**
     * Before a message goes out: like the teammate (drafts while it's in training wheels), always ask first, or
     * send on their own.
     */
    approval: z.enum(FUNNEL_APPROVALS).default('teammate'),
    /** The words the business described it with, kept for the AI's next look. */
    description: z.string().trim().max(4000).default(''),
  })
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.stages.forEach((s, i) => {
      if (seen.has(s.stageId))
        ctx.addIssue({
          code: 'custom',
          path: ['stages', i, 'stageId'],
          message: 'That stage is in the funnel twice.',
        });
      seen.add(s.stageId);
    });
    const parts = new Set<string>();
    const part = (id: string, path: (string | number)[]) => {
      if (parts.has(id)) ctx.addIssue({ code: 'custom', path, message: 'Two parts share an id.' });
      parts.add(id);
    };
    d.entry.rules.forEach((r, i) => part(r.id, ['entry', 'rules', i, 'id']));
    d.stages.forEach((s, i) => {
      s.moves.forEach((m, j) => {
        part(m.id, ['stages', i, 'moves', j, 'id']);
        if (m.to === s.stageId)
          ctx.addIssue({
            code: 'custom',
            path: ['stages', i, 'moves', j, 'to'],
            message: 'A move goes to another stage.',
          });
      });
      s.messages.forEach((m, j) => part(m.id, ['stages', i, 'messages', j, 'id']));
    });
  });
export type FunnelDefinition = z.infer<typeof FunnelDefinition>;
export type FunnelDefinitionInput = z.input<typeof FunnelDefinition>;

/** An empty definition with a stage for each of these pipeline stages, in order. */
export function emptyFunnel(stageIds: readonly string[]): FunnelDefinition {
  return FunnelDefinition.parse({ stages: stageIds.map((stageId) => ({ stageId })) });
}

export const FUNNEL_STATUSES = ['draft', 'on', 'paused', 'archived'] as const;
export type FunnelStatus = (typeof FUNNEL_STATUSES)[number];

/** Where a person is with a funnel. */
export const FUNNEL_PERSON_STATUSES = [
  'active',
  'paused',
  'left',
  'suggested',
  'declined',
] as const;
export type FunnelPersonStatus = (typeof FUNNEL_PERSON_STATUSES)[number];

/** Why a person's funnel paused: someone on the team took the conversation, it was handed to them, or by hand. */
export const FUNNEL_PAUSE_REASONS = ['taken_over', 'handed_off', 'by_hand'] as const;
export type FunnelPauseReason = (typeof FUNNEL_PAUSE_REASONS)[number];

/**
 * Why a person left: a won or lost stage, taken out, moved to a stage the funnel doesn't use, another funnel, STOP,
 * the funnel archived, or their lead gone.
 */
export const FUNNEL_LEFT_REASONS = [
  'won',
  'lost',
  'removed',
  'outside',
  'other_funnel',
  'opted_out',
  'funnel_archived',
  'lead_gone',
] as const;
export type FunnelLeftReason = (typeof FUNNEL_LEFT_REASONS)[number];

/** How a person got in. */
export const FUNNEL_ADDED_BY = ['rule', 'hand', 'ai', 'turn_on'] as const;
export type FunnelAddedBy = (typeof FUNNEL_ADDED_BY)[number];

/**
 * How late a message may still go when it doesn't say: half an hour for one tied to a session's start, two hours
 * for one on the booking day at a set time, and a day for one counted from arriving.
 */
export function funnelGoodFor(m: FunnelMessage): number {
  if (m.goodForMinutes !== null) return m.goodForMinutes;
  if (m.when.kind === 'booking') return 30;
  if (m.when.kind === 'booking_day') return 120;
  return 24 * 60;
}

/** Whether a message is timed around a booking (and so needs one). */
export const timedByBooking = (m: FunnelMessage): boolean => m.when.kind !== 'arrive';
