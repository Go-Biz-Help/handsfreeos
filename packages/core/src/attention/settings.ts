/**
 * The Action Center's settings, `workspaces.settings.attention`: which kinds are on, the thresholds, the typical
 * job value, the automatic switches, the follow-up nudge and the reply-C switch. Browser-safe: Settings validates
 * with the schema the server saves with, and every reader falls back field by field, so old or partial settings
 * (or none) still work.
 */
import { z } from 'zod';
import { isoDateTime } from '../schemas/common';
import { readForgiving } from '../schemas/forgiving';
import type { AttentionKind } from './kinds';
import { DEFAULT_NUDGE_TEMPLATE, nudgePlaceholderProblem } from './nudge';

const MAX_CENTS = 100_000_000_00;
const on = () => z.boolean().default(true);
/** On, and not a switch: the kinds a business must not be able to hide from itself. */
const always = () => z.literal(true).default(true);

const kindSwitches = {
  hot_lead: on(),
  unanswered_lead: on(),
  stale_opportunity: on(),
  missing_next_action: on(),
  unconfirmed_appointment: on(),
  ai_approval: on(),
  customer_waiting: on(),
  overdue_task: on(),
  estimate_waiting: on(),
  invoice_overdue: on(),
  // The wallet's three (M16). `always()` rather than `on()` for the two that mean the business has stopped
  // working: a business that turned off "you cannot send texts any more" and then wondered why nothing sent
  // would have been failed by a setting we offered them.
  wallet_low: on(),
  wallet_empty: always(),
  wallet_card_declined: always(),
  // Its switch is Automations' "Thank-you after the job" (settings.automations.switches.thankYou), which
  // decides whether a thank-you is tried at all; the card is only what happens when one couldn't go.
  job_not_thanked: always(),
  referral_mentioned: on(),
  // Its switch is Automations' "Maintenance due", which decides whether anyone is reminded at all.
  maintenance_due: always(),
  pipeline_mismatch: on(),
  quiet_after_price: on(),
  // Its switch is Automations' "Did the job happen?", which also decides whether whoever was on it is asked.
  job_unconfirmed: always(),
  job_never_completed: on(),
  job_no_address: on(),
  client_quiet: on(),
  promise_due: on(),
  revenue_moved: on(),
  channel_quiet: on(),
  // A broken connection is always shown: payments, bookings or messages are failing until it's fixed.
  connection_error: always(),
  connection_silent: on(),
  ai_unreviewed: on(),
  ai_corrections: on(),
  website_changed: on(),
  faq_suggestions: on(),
  offer_lapsing: on(),
  texting_rejected: always(),
  // An add-on's alerts are switched in its own settings: Home shows what it raises.
  addon_alert: always(),
  // Its switch is the live poll's "What happens to hot ones", which decides whether a card opens at all.
  webinar_hot: always(),
} satisfies Record<AttentionKind, z.ZodType>;

const Hot = z.object({
  /** A lead worth at least this (its own value, never an estimate) is one weak signal. */
  minValueCents: z.int().min(0).max(MAX_CENTS).default(500_000),
  /** A hot lead waiting this long (plain minutes) is urgent. */
  urgentAfterMinutes: z.int().min(1, 'At least 1 minute.').max(240, 'At most 4 hours.').default(10),
});

const Unanswered = z.object({
  /** A new lead nobody has contacted opens after this many minutes of open hours. */
  afterOpenMinutes: z.int().min(1, 'At least 1 minute.').max(480, 'At most 8 hours.').default(15),
});

const staleDays = z.int().min(1, 'At least 1 day.').max(365, 'At most a year.');

const Stale = z.object({
  /** An open lead with no contact for this many days is stale. */
  days: staleDays.default(7),
  /** Stage id → days, for stages that move faster or slower. */
  stageDays: z.record(z.uuid(), staleDays).default(() => ({})),
});

const Appointments = z.object({
  /** An unconfirmed one-on-one appointment opens this many hours before it starts. */
  windowHours: z.int().min(1, 'At least 1 hour.').max(168, 'At most a week.').default(48),
});

/**
 * When money asks for attention. Both are ask-first: these say when the card opens, not when anything is sent.
 * What a business's own reminders say and when they go out lives in the money settings.
 */
const Money = z.object({
  /** An estimate nobody has answered opens this many days after it went out. */
  // Five days, not three: HandsFreeOS sends its own check-in on day three, so the card asks a person only
  // once that has had its chance.
  estimateWaitingDays: z.int().min(1, 'At least 1 day.').max(60, 'At most 60 days.').default(5),
  /** An unpaid invoice opens this many days after its due day: 0 opens it the morning after. */
  invoiceOverdueDays: z.int().min(0).max(60, 'At most 60 days.').default(1),
  /** Nothing smaller than this opens a card, so a $3 balance doesn't take up Home. */
  minBalanceCents: z.int().min(0).max(MAX_CENTS).default(0),
});

const Auto = z
  .object({
    /** Send one confirmation request for an unconfirmed appointment on its own. */
    confirmRequests: z.boolean().default(true),
    /** Send one follow-up nudge for a stale lead or an overdue follow-up on its own. */
    nudges: z.boolean().default(false),
    /** When an owner read the nudge and chose "Looks good, turn on". Nudges stay off until then. */
    nudgeReviewedAt: isoDateTime.nullable().default(null),
  })
  .refine((a) => !a.nudges || a.nudgeReviewedAt !== null, {
    error: 'Read the follow-up message and choose “Looks good, turn on” first.',
    path: ['nudges'],
  });

const Nudge = z.object({
  template: z
    .string()
    .trim()
    .min(1, 'Write the follow-up message.')
    .max(480, 'Keep it under 480 characters.')
    .superRefine((template, ctx) => {
      const problem = nudgePlaceholderProblem(template);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    })
    .default(DEFAULT_NUDGE_TEMPLATE),
  /** No automatic message to the same lead again for this many days. */
  cooldownDays: z.int().min(1, 'At least 1 day.').max(90, 'At most 90 days.').default(14),
});

export const AttentionSettings = z.object({
  kinds: z.object(kindSwitches).prefault({}),
  hot: Hot.prefault({}),
  unanswered: Unanswered.prefault({}),
  stale: Stale.prefault({}),
  appointments: Appointments.prefault({}),
  money: Money.prefault({}),
  /** The value of a lead with none; null works it out (the median won lead over 365 days, else $500). */
  typicalJobValueCents: z.int().min(0).max(MAX_CENTS).nullable().default(null),
  auto: Auto.prefault({}),
  nudge: Nudge.prefault({}),
  /** A customer may reply C (or CONFIRM) to confirm an appointment. */
  replyToConfirm: z.boolean().default(true),
});
export type AttentionSettings = z.infer<typeof AttentionSettings>;
export type AttentionSettingsInput = z.input<typeof AttentionSettings>;

/** Every setting at its default. */
export function defaultAttentionSettings(): AttentionSettings {
  return AttentionSettings.parse({});
}

/** Validates settings being saved, filling defaults. Throws a ZodError with Settings' messages when invalid. */
export function parseAttentionSettings(raw: unknown): AttentionSettings {
  return AttentionSettings.parse(raw ?? {});
}

/**
 * Reads stored settings forgivingly: every field that doesn't pass falls back to its default, and the rest is
 * kept. Never throws. Nudges read as off until the template has been reviewed.
 */
export function readAttentionSettings(raw: unknown): AttentionSettings {
  return readForgiving(AttentionSettings, raw);
}

/** A business's Action Center settings, from its workspace settings (like `openHoursOf`). */
export function attentionSettingsOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): AttentionSettings {
  return readAttentionSettings(settings?.['attention']);
}

/** $500: the typical job value when the business hasn't set one and has won nothing in a year. */
export const DEFAULT_TYPICAL_JOB_VALUE_CENTS = 50_000;

/** The value of a lead with none: the business's own figure, else the median won lead, else $500. */
export function typicalJobValueCents(
  settings: AttentionSettings,
  medianWonCents: number | null,
): number {
  if (settings.typicalJobValueCents !== null) return settings.typicalJobValueCents;
  if (medianWonCents !== null && medianWonCents > 0) return Math.round(medianWonCents);
  return DEFAULT_TYPICAL_JOB_VALUE_CENTS;
}

/** How many days without contact make a lead in this stage stale. */
export function staleDaysFor(settings: AttentionSettings, stageId: string | null): number {
  return (stageId ? settings.stale.stageDays[stageId] : undefined) ?? settings.stale.days;
}

/** Whether nudges go out on their own: switched on, after an owner reviewed the template. */
export function nudgesOn(settings: AttentionSettings): boolean {
  return settings.auto.nudges && settings.auto.nudgeReviewedAt !== null;
}
