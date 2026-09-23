/**
 * Automations' own settings, `workspaces.settings.automations`: the switches for automations that had no single
 * switch before (the day-before and day-of reminders, waitlist offers, the morning email), and later each new
 * automation's timing. Browser-safe, read forgivingly like the Action Center's: a bad or missing field falls back
 * to its default, so a business that never opened the page gets every default.
 *
 * Automations that already had a switch keep it where it was (the Action Center's kinds, the AI teammate's
 * skills): the catalog points at it, so nothing reads a second copy.
 */
import { z } from 'zod';
import { nudgePlaceholderProblem } from '../attention/nudge';
import { isoDateTime } from '../schemas/common';
import { DEFAULT_INTAKE_MESSAGE, intakeMessageProblem } from './intake';
import {
  DEFAULT_MAINTENANCE_PLAN_TEMPLATE,
  DEFAULT_MAINTENANCE_TEMPLATE,
  maintenanceTemplateProblem,
} from './maintenance';
import { readForgiving } from '../schemas/forgiving';

const on = () => z.boolean().default(true);

/**
 * The switches this document owns. Most default to on, because each is something the business already
 * had working before the Automations page existed: turning it into a switch must not turn it off. Re-engaging
 * dead leads is new and texts people who haven't heard from the business in months, so it starts off.
 */
const Switches = z.object({
  /** The day-before reminder (calendar reminders of kind `day_before`). */
  dayBefore: on(),
  /** Reminders on the day (calendar reminders of kind `before`). */
  dayOf: on(),
  /** Offering a freed time to the next person on a waitlist. */
  waitlist: on(),
  /** The 7 AM email. Each person can still turn off their own copy in Notifications. */
  morningBrief: on(),
  /** The end-of-day email to owners and admins: what's still open, and the day in numbers. */
  eveningBrief: on(),
  /** One text, in the business's own words, to open leads nobody has been in touch with for months. */
  reengage: z.boolean().default(false),
  /** The intake form's link, right after a customer's first booking (once a form is chosen). */
  intake: on(),
  /** A short thank-you two hours after a job is marked done (the AI teammate's, else a card on Home). */
  thankYou: on(),
  /** A text when a customer's recurring service comes round again (once a service or plan says how often). */
  maintenance: on(),
});
export type AutomationSwitch = keyof z.infer<typeof Switches>;
export const AUTOMATION_SWITCHES = Object.keys(Switches.shape) as readonly AutomationSwitch[];

/** Straight apostrophes: a curly one sends a text in the slower encoding. */
export const DEFAULT_REENGAGE_TEMPLATE =
  "Hi {firstName}, it's {senderName} at {businessName}. It's been a while since we talked about {leadTitle}. Is that still something we can help with?";

const Reengage = z.object({
  template: z
    .string()
    .trim()
    .min(1, 'Write the message.')
    .max(480, 'Keep it under 480 characters.')
    .superRefine((template, ctx) => {
      const problem = nudgePlaceholderProblem(template);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    })
    .default(DEFAULT_REENGAGE_TEMPLATE),
  /** When an owner read the message and chose "Looks good, turn on". It can't go on until then. */
  reviewedAt: isoDateTime.nullable().default(null),
  /** An open lead nobody has been in touch with for this long has gone cold. */
  afterDays: z.int().min(30, 'At least 30 days.').max(730, 'At most two years.').default(90),
  /** At most this many a day, so a big old list doesn't all go at once. */
  maxPerDay: z.int().min(1).max(200, 'At most 200 a day.').default(20),
  /** Never to the same lead again within this long. */
  cooldownDays: z.int().min(30, 'At least 30 days.').max(730, 'At most two years.').default(180),
});

const Intake = z.object({
  /** The form a first-time customer gets. Nothing goes until one is chosen ("Pick a form to start"). */
  formId: z.uuid().nullable().default(null),
  message: z
    .string()
    .trim()
    .min(1, 'Write the message.')
    .max(480, 'Keep it under 480 characters.')
    .superRefine((message, ctx) => {
      const problem = intakeMessageProblem(message);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    })
    .default(DEFAULT_INTAKE_MESSAGE),
});

const maintenanceWording = (fallback: string, plan: boolean) =>
  z
    .string()
    .trim()
    .min(1, 'Write the message.')
    .max(480, 'Keep it under 480 characters.')
    .superRefine((template, ctx) => {
      const problem = maintenanceTemplateProblem(template, { plan });
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    })
    .default(fallback);

const Maintenance = z.object({
  /** The first text goes this many days before the visit is due. */
  leadDays: z.int().min(0).max(60, 'At most 60 days.').default(14),
  /** The second, this many days after the first; a card on Home the same again after that. */
  secondAfterDays: z.int().min(1, 'At least 1 day.').max(30, 'At most 30 days.').default(7),
  /** At most this many first reminders a day, so customers already overdue don't all get one at once. */
  maxPerDay: z.int().min(1).max(200, 'At most 200 a day.').default(20),
  template: maintenanceWording(DEFAULT_MAINTENANCE_TEMPLATE, false),
  /** For a customer on a maintenance plan that covers the service. */
  planTemplate: maintenanceWording(DEFAULT_MAINTENANCE_PLAN_TEMPLATE, true),
});

const Briefings = z.object({
  /** When the evening email goes, where the business is (24-hour HH:MM). */
  eveningAt: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Pick a time.')
    .refine((t) => t >= '12:00' && t <= '22:00', 'Pick a time between noon and 10 PM.')
    .default('18:00'),
});

export const AutomationSettings = z
  .object({
    switches: Switches.prefault({}),
    reengage: Reengage.prefault({}),
    intake: Intake.prefault({}),
    maintenance: Maintenance.prefault({}),
    briefings: Briefings.prefault({}),
  })
  .refine((s) => !s.switches.reengage || s.reengage.reviewedAt !== null, {
    error: 'Read the message and choose “Looks good, turn on” first.',
    path: ['switches', 'reengage'],
  });
export type AutomationSettings = z.infer<typeof AutomationSettings>;
export type AutomationSettingsInput = z.input<typeof AutomationSettings>;

/** Every setting at its default. */
export function defaultAutomationSettings(): AutomationSettings {
  return AutomationSettings.parse({});
}

/** Validates settings being saved, filling defaults. Throws a ZodError when invalid. */
export function parseAutomationSettings(raw: unknown): AutomationSettings {
  return AutomationSettings.parse(raw ?? {});
}

/** Reads stored settings forgivingly: every field that doesn't pass falls back to its default. Never throws. */
export function readAutomationSettings(raw: unknown): AutomationSettings {
  return readForgiving(AutomationSettings, raw);
}

/** A business's automation settings, from its workspace settings (like `attentionSettingsOf`). */
export function automationSettingsOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): AutomationSettings {
  return readAutomationSettings(settings?.['automations']);
}

/** Whether re-engaging dead leads may run: switched on, after an owner reviewed the message. */
export function reengageOn(settings: AutomationSettings): boolean {
  return settings.switches.reengage && settings.reengage.reviewedAt !== null;
}

/** Whether one of this document's switches is on. */
export function automationOn(
  settings: Readonly<Record<string, unknown>> | null | undefined,
  key: AutomationSwitch,
): boolean {
  return automationSettingsOf(settings).switches[key];
}

/** The form "Intake questions" sends, when it is on and one is chosen; else null. */
export function intakeFormOf(settings: AutomationSettings): string | null {
  return settings.switches.intake ? settings.intake.formId : null;
}
