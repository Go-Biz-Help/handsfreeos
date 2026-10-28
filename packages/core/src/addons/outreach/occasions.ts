/**
 * Birthday and new-job notes (docs/outreach.md decision 108, the owner's pick 5a): "Only for people you've chatted with
 * or who fit a playbook. The AI drafts the note and it waits for your OK."
 *
 * Once a day the person's computer reads Facebook's Birthdays page and LinkedIn's Catch up page (`OCCASIONS_ON`) and
 * hands what it found to `outreach.occasions.save`, which keeps those among the people already kept, each person's
 * own. Today then offers **Wish them a happy birthday** on the day and **Congratulate them** on a new job for two weeks
 * (`NEW_JOB_DAYS`), only for someone the person has chatted with or the AI found a fit for a playbook, and never for a
 * client, someone on Don't pitch or Never contact, or someone marked Not a fit (decision 91). The AI drafts a short
 * note with no pitch and no link, and it always waits for the person's OK (./sends.ts `goesAsItIs`). Facebook shows
 * only birthdays: it has no page of new jobs.
 *
 * Browser-safe: the extension builds the input, and the server checks it.
 */
import { z } from 'zod';
import type { Platform } from './networks';
import { PLATFORM_KEYS } from './playbooks';
import { PersonName, ProfileRef } from './saves';

export const OCCASION_KINDS = ['birthday', 'new_job'] as const;
export type OccasionKind = (typeof OCCASION_KINDS)[number];

/** What each network's page shows: Facebook's Birthdays page, and LinkedIn's Catch up. None elsewhere. */
export const OCCASIONS_ON: Readonly<Record<Platform, readonly OccasionKind[]>> = {
  facebook: ['birthday'],
  linkedin: ['birthday', 'new_job'],
  instagram: [],
  alignable: [],
};

/** How long after a new job is seen a note about it is still worth it. A birthday's is on the day alone. */
export const NEW_JOB_DAYS = 14;
/** The most people one page's read hands over. */
export const OCCASIONS_SAVE_MOST = 200;
export const OCCASION_DETAIL_MOST = 300;

export const OccasionsSaveInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS),
  occasions: z
    .array(
      z.object({
        profile: ProfileRef,
        name: PersonName,
        kind: z.enum(OCCASION_KINDS),
        /** For a new job, what the page said of it: "Started a new position as Owner at Reyes Plumbing". */
        detail: z.string().trim().min(1).max(OCCASION_DETAIL_MOST).nullable().default(null),
      }),
    )
    .max(OCCASIONS_SAVE_MOST),
});
export type OccasionsSaveInput = z.input<typeof OccasionsSaveInput>;

export const OccasionsSaveOutput = z.object({
  /** Those kept: someone already kept here, on a kind their network shows. */
  kept: z.number().int().min(0),
  /** Those left: nobody kept here yet, or a kind the network doesn't show. */
  left: z.number().int().min(0),
});
export type OccasionsSaveOutput = z.output<typeof OccasionsSaveOutput>;

/** The words on Today, the alerts and the extension's line, on the web and the phone alike. */
export const OCCASION_WORDS = {
  birthdayWhy: 'It’s their birthday today',
  newJobWhy: (detail: string | null): string => detail ?? 'They started a new job',
  /** Why the note waits for an OK of its own (`needsYou`). */
  needsYou: 'a birthday or new-job note always waits for your OK',
  /** The extension's line, once a page is read. */
  saved: (kept: number): string =>
    kept === 0
      ? 'Nobody you’ve reached has a birthday or a new job today.'
      : `Noted ${kept === 1 ? '1 birthday or new job' : `${kept} birthdays and new jobs`} of people you’ve reached. Today offers a note to those you’ve chatted with or who fit a playbook, and it waits for your OK.`,
} as const;
