/**
 * The business's main offer (docs/main-offer.md), by asking: change any box of it, score it, have the AI write a
 * try, take a try's parts in, set the owner's direction and the names the business goes by, throw the draft away,
 * and put it live. The same commands Settings → Main offer runs, as the person, so only someone with
 * `main_offer.manage` is offered them and each still refuses while no add-on that uses the offer is on.
 *
 * What changes the offer waits for the person's OK, going live most of all. A score and a try only read the draft and
 * keep what the AI said beside it, as the builder's buttons do.
 */
import { z } from 'zod';
import { MAIN_OFFER_LIMITS, MainOfferNotes, SCORED_PARTS } from '../main-offer/parts';
import { OFFER_STEP_WORDS, OFFER_STEPS } from '../main-offer/words';
import { uuid } from '../schemas/common';
import { define, text, type AssistantTool } from './tool-kit';

/**
 * Every box of the offer the builder shows, by its path, with the step it's on and what it asks. The method's steps
 * and the results are lists, which the tool takes whole.
 */
const BOXES = OFFER_STEPS.flatMap((step) =>
  OFFER_STEP_WORDS[step].boxes.map((b) => ({
    path: b.path,
    label: `${OFFER_STEP_WORDS[step].name}: ${b.label}`,
  })),
);

/** The boxes' paths, for the tool's input. */
export const MAIN_OFFER_BOX_PATHS = BOXES.map((b) => b.path) as [string, ...string[]];

/** "Guarantee: What do you promise if it doesn’t work?": a box as the builder asks it. */
export function mainOfferBoxLabel(path: string): string {
  if (path === 'method.steps') return `${OFFER_STEP_WORDS.method.name}: the steps`;
  if (path === 'proof') return `${OFFER_STEP_WORDS.proof.name}: real results`;
  return BOXES.find((b) => b.path === path)?.label ?? path;
}

const L = MAIN_OFFER_LIMITS;

/** Why it goes live with a part under the bar: the person's own reason, as Use it anyway takes it. */
const anyway = text(300).describe(
  'Only when the person said to put it live even with a part under 7: their reason, in a line, in their words',
);

export const mainOfferTools: readonly AssistantTool[] = [
  define({
    name: 'edit_main_offer',
    description:
      'Change the business’s main offer (Settings → Main offer): any of its boxes, the method’s steps or the real results. It starts from the draft, or from the live version when there is none, saves the change to the draft and has the AI score it. With goLive, it then puts it live as the next version when every part scores 7 or more. Read the offer first with get_settings (area main_offer) and pass only what changes. Write in the business’s own words, plainly; results only as the person gave them to you, never made up. Social Outreach’s messages carry the outcome in a few words, never the guarantee or the price.',
    input: z.object({
      boxes: z
        .array(
          z.object({
            path: z.enum(MAIN_OFFER_BOX_PATHS),
            words: z
              .string()
              .trim()
              .max(L.line)
              .describe('What the box says now, whole; empty clears it'),
          }),
        )
        .max(BOXES.length)
        .optional()
        .describe(
          'Each box that changes. line is the whole offer in one line; inAFewWords.outcome and inAFewWords.guarantee are a few words each',
        ),
      steps: z
        .array(text(L.step))
        .max(L.steps)
        .optional()
        .describe('The method’s steps, the whole list in order: 3 to 5 to go live'),
      proof: z
        .array(text(L.proofLine))
        .max(L.proof)
        .optional()
        .describe('The real results, the whole list, a line each: only ones the person gave you'),
      goLive: z
        .boolean()
        .default(false)
        .describe('Put it live once it is scored, when the person asked for that'),
      anyway: anyway.optional(),
    }),
    autonomy: 'confirm',
    permission: 'main_offer.manage',
  }),
  define({
    name: 'main_offer_go_live',
    description:
      'Put the main offer’s draft live as the next version, as it stands. It is scored first when it hasn’t been since its last change, and goes live only when every part scores 7 or more, or with anyway when the person said to go live regardless. People already reached keep hearing the version they were first pitched with.',
    input: z.object({ anyway: anyway.optional() }),
    autonomy: 'confirm',
    permission: 'main_offer.manage',
  }),
  define({
    name: 'manage_main_offer',
    description:
      'The rest of Settings → Main offer: throw the draft away (the live version stays), set the owner’s direction for the whole offer that every score and try follows, set the names the business goes by on people’s profiles, or take parts from one of the AI’s tries into the draft (its id from try_main_offer).',
    input: z.object({
      action: z.enum(['discard_draft', 'set_direction', 'set_names', 'take_from_try']),
      direction: z
        .string()
        .trim()
        .max(L.direction)
        .optional()
        .describe('set_direction: the owner’s own words for the whole offer; empty clears it'),
      names: z
        .array(text(L.name))
        .max(L.names)
        .optional()
        .describe(
          'set_names: the company and the brand it sells, the whole list; none means the business’s name here',
        ),
      tryId: uuid.optional().describe('take_from_try: which try'),
      take: z
        .array(z.enum(SCORED_PARTS))
        .min(1)
        .max(SCORED_PARTS.length)
        .optional()
        .describe('take_from_try: the parts to take; the rest of the draft stays'),
    }),
    autonomy: 'confirm',
    permission: 'main_offer.manage',
  }),
  define({
    name: 'score_main_offer',
    description:
      'Have the AI score the main offer’s draft as it is kept: each part from 1 to 10 with why, what’s holding it back and the fix. Keeps the score with the draft, as Score my offer does. Changes nothing in the offer.',
    input: z.object({}),
    autonomy: 'auto',
    permission: 'main_offer.manage',
  }),
  define({
    name: 'try_main_offer',
    description:
      'Have the AI write a whole new try of the main offer from the draft, the owner’s direction, a note on any part and the parts to keep as they are, with its own score. The try sits beside the draft and changes nothing; take its parts in with manage_main_offer (take_from_try) once the person picks them.',
    input: z.object({
      notes: MainOfferNotes.describe('A note to the AI on any part: what the person wants of it'),
      keep: z
        .array(z.enum(SCORED_PARTS))
        .max(SCORED_PARTS.length - 1)
        .default([])
        .describe('Parts the try leaves exactly as the draft has them'),
    }),
    autonomy: 'auto',
    permission: 'main_offer.manage',
  }),
];
