/**
 * Guided setups: a setting set up one question at a time, on a page of its own (the owner, 22 Nov 2026: the email
 * setup's way "with all the settings", the phone number first). What every one of them shares lives here, once, for
 * the web and the phone: which setups there are and who may run each, the answers saved as they are given
 * (guided_setup.save_draft, so someone who leaves comes back to their choices), and the frame's words. Each setup's
 * own questions sit beside this file (phone.ts). Browser-safe.
 */
import { z } from 'zod';
import { daysBetween, formatLocalDate, localDateOf } from '../calendar/engine/zoned';
import { fmtDateLong, fmtMonthDay } from '../calendar/when';
import type { Permission } from '../permissions';
import { isoDateTime, uuid } from '../schemas/common';

/**
 * The guided setups, and the permission each one's saved answers need: the same one its last screen's command asks
 * for. private.guided_setup_permission (the database's own list, which row-level security reads) mirrors it; a test
 * holds the two together.
 */
export const GUIDED_SETUPS = {
  phone: { permission: 'channels.manage' },
  email: { permission: 'channels.manage' },
} as const satisfies Record<string, { readonly permission: Permission }>;
export type GuidedSetupKey = keyof typeof GUIDED_SETUPS;
export const GUIDED_SETUP_KEYS = Object.keys(GUIDED_SETUPS) as [
  GuidedSetupKey,
  ...GuidedSetupKey[],
];
export const guidedSetupKey = z.enum(GUIDED_SETUP_KEYS);

/**
 * A setup's answers as its screens keep them: single picks and lists of rows alike. Loose on purpose, since a
 * half-typed answer is still worth keeping; the setup's last screen checks the real thing.
 */
const draftAnswers = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 30_000, {
    error: 'These answers are too long to save. Shorten the longest one and try again.',
  });
export const GuidedSetupSaveDraftInput = z.object({
  workspaceId: uuid,
  setup: guidedSetupKey,
  answers: draftAnswers,
});
export const GuidedSetupSaveDraftOutput = z.object({ savedAt: isoDateTime });
export const GuidedSetupClearDraftInput = z.object({ workspaceId: uuid, setup: guidedSetupKey });
export const GuidedSetupClearDraftOutput = z.object({ cleared: z.boolean() });
export const GuidedSetupGetDraftInput = z.object({ workspaceId: uuid, setup: guidedSetupKey });
export const GuidedSetupGetDraftOutput = z.object({
  /** Null when nothing is saved: the setup starts from its first question. */
  answers: z.record(z.string(), z.unknown()).nullable(),
  savedAt: isoDateTime.nullable(),
});

/**
 * "today", "yesterday", "on Friday", "on Nov 3": when the answers were last saved, for "Welcome back". Days are the
 * given zone's, or the reader's own device's when none is given.
 */
export function guidedSetupSavedWhen(savedAt: string, now: Date, timeZone?: string): string {
  const day = (d: Date) =>
    timeZone
      ? localDateOf(d.getTime(), timeZone)
      : formatLocalDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const saved = day(new Date(savedAt));
  const days = daysBetween(saved, day(now));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return days < 7 ? `on ${fmtDateLong(saved).split(',')[0]}` : `on ${fmtMonthDay(saved)}`;
}

/** The frame's words, the same in every guided setup, on the web and the phone. */
export const GUIDED_SETUP_WORDS = {
  saved: 'Saved',
  saving: 'Saving',
  notSaved: 'Not saved yet',
  notSavedHint:
    'We couldn’t save your last answer. Check your connection; we’ll keep trying as you go.',
  finishLater: 'Finish later',
  close: 'Close',
  back: 'Back',
  next: 'Next',
  checkItOver: 'Check it over',
  checkKicker: 'Check it over',
  change: 'Change',
  startOver: 'Start over',
  startOverConfirm:
    'Start over? Your answers so far are cleared. Nothing you already set up changes.',
  question: (n: number, of: number) => `Question ${n} of ${of}`,
  /** "Welcome back, Blake. Your answers from Friday are still here." */
  welcomeBack: (firstName: string | null, when: string) =>
    `Welcome back${firstName ? `, ${firstName}` : ''}. Your answers from ${when.replace(/^on /, '')} are still here.`,
  stoppedAt: (n: number) => `You stopped at question ${n}.`,
  /** Under Check it over's heading, with the setup's own first sentence before it. */
  answersKept: 'Your answers are saved, so you can leave and come back.',
} as const;
