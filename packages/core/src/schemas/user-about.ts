import { z } from 'zod';
import { ABOUT_YOU_MOST, ABOUT_YOU_WORDS } from '../account/about-you';
import { isoDateTime } from './common';

/**
 * About you (decision 165 in docs/outreach.md): what a person says of themselves, in their own words, for the AI that
 * writes as them. Theirs alone.
 */
export const UserAboutGetInput = z.object({});
export const UserAboutGetOutput = z.object({
  /** Their own words; empty with nothing said. */
  about: z.string(),
  updatedAt: isoDateTime.nullable(),
});

export const UserAboutSetInput = z.object({
  /** Their own words. Empty clears it. */
  about: z.string().trim().max(ABOUT_YOU_MOST, ABOUT_YOU_WORDS.tooLong),
});
export const UserAboutSetOutput = z.object({
  /** Whether anything is kept now. */
  filled: z.boolean(),
  changed: z.boolean(),
});
