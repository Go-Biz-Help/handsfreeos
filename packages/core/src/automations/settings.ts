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
import { readForgiving } from '../schemas/forgiving';

const on = () => z.boolean().default(true);

/**
 * The switches this document owns. Every one defaults to on, because each is something the business already
 * had working before the Automations page existed: turning it into a switch must not turn it off.
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
});
export type AutomationSwitch = keyof z.infer<typeof Switches>;
export const AUTOMATION_SWITCHES = Object.keys(Switches.shape) as readonly AutomationSwitch[];

export const AutomationSettings = z.object({
  switches: Switches.prefault({}),
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

/** Whether one of this document's switches is on. */
export function automationOn(
  settings: Readonly<Record<string, unknown>> | null | undefined,
  key: AutomationSwitch,
): boolean {
  return automationSettingsOf(settings).switches[key];
}
