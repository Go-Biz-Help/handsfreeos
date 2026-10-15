/**
 * The business's main offer (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, Part 1): a draft edited while the live
 * version keeps running, scored by the AI, then published as a version that never changes. Not the promotions under
 * Knowledge (./offer.ts).
 */
import { z } from 'zod';
import { MainOfferParts, MainOfferScore } from '../main-offer/parts';
import { isoDateTime, uuid } from './common';

/** The draft's revision the person started from: two editors can't undo each other. */
const revision = z.int().min(0);

export const MainOfferSaveDraftInput = z.object({
  workspaceId: uuid,
  revision,
  parts: MainOfferParts,
});
export const MainOfferSaveDraftOutput = z.object({ revision: z.int() });

export const MainOfferDiscardDraftInput = z.object({ workspaceId: uuid });
export const MainOfferDiscardDraftOutput = z.object({ discarded: z.boolean(), revision: z.int() });

/** The worker's alone: the AI's score of the draft it read. */
export const MainOfferScoreSaveInput = z.object({
  workspaceId: uuid,
  revision,
  score: MainOfferScore,
});
export const MainOfferScoreSaveOutput = z.object({
  /** False when the draft moved on (or went) while the AI read it: that score is for nothing now. */
  saved: z.boolean(),
});

export const MainOfferPublishInput = z.object({
  workspaceId: uuid,
  revision,
  /** Why it goes live with a part under the bar (Use it anyway). Ignored when every part clears it. */
  anyway: z
    .string()
    .trim()
    .min(1, 'Say why in a line.')
    .max(300, 'Keep it under 300 characters.')
    .optional(),
});
export const MainOfferPublishOutput = z.object({ version: z.int() });

const Person = z.object({ id: uuid, name: z.string() }).nullable();

export const MainOfferVersionOut = z.object({
  version: z.int(),
  parts: MainOfferParts,
  line: z.string(),
  score: MainOfferScore,
  /** Why it went live under the bar; null when it cleared it. */
  anyway: z.string().nullable(),
  publishedBy: Person,
  publishedAt: isoDateTime,
});
export type MainOfferVersionOut = z.infer<typeof MainOfferVersionOut>;

const Missing = z.object({ path: z.string(), label: z.string() });

export const MainOfferGetInput = z.object({ workspaceId: uuid });
export const MainOfferGetOutput = z.object({
  /** Whether an add-on that uses the main offer is on here. Off, it's kept and hidden, and can't be changed. */
  inUse: z.boolean(),
  /** The add-ons that bring it, by name, for the words when it's off ("Social Outreach"). */
  comesWith: z.array(z.string()),
  /** The score every part needs (7). */
  bar: z.int(),
  /** The draft's revision now: what the next save, discard or publish names. */
  revision: z.int(),
  live: MainOfferVersionOut.nullable(),
  draft: z
    .object({
      parts: MainOfferParts,
      by: Person,
      at: isoDateTime.nullable(),
      /** The AI's score of this draft as it is; null until it's scored, or once it changes after. */
      score: MainOfferScore.nullable(),
      /** What it needs before it can be published, in the builder's order. */
      missing: z.array(Missing),
    })
    .nullable(),
});
export type MainOfferGetOutput = z.infer<typeof MainOfferGetOutput>;

export const MainOfferVersionsInput = z.object({ workspaceId: uuid });
export const MainOfferVersionsOutput = z.object({
  /** The newest first. */
  versions: z.array(
    z.object({
      version: z.int(),
      line: z.string(),
      /** Its lowest part's score, for the list. */
      lowest: z.int(),
      anyway: z.string().nullable(),
      publishedBy: Person,
      publishedAt: isoDateTime,
    }),
  ),
});
