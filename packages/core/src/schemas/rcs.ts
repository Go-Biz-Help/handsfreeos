/**
 * RCS (0103): a business's RCS sender, and the buttons, cards and carousels a text can carry. Browser-safe.
 *
 * The limits are Twilio's, from `messaging/rcs.ts`, so the composer refuses what Twilio would have refused
 * rather than the worker finding out after the person pressed Send.
 */
import { z } from 'zod';
import { carrierWordTitle, isHttpsUrl, RCS_LIMITS } from '../messaging/rcs';
import { uuid } from './common';
import { MediaRefSchema } from './media';
import { phoneRequired } from './telephony';

// ---------- what a text can carry ----------
const buttonTitle = z
  .string()
  .trim()
  .min(1, 'Name the button.')
  .max(RCS_LIMITS.buttonTitle, `Keep a button’s name to ${RCS_LIMITS.buttonTitle} characters.`)
  .refine((t) => !carrierWordTitle(t), {
    error: 'Carriers read that word as STOP, START or HELP. Pick other words for the button.',
  });

const linkUrl = z
  .string()
  .trim()
  .max(1000)
  .refine(isHttpsUrl, { error: 'Use a full web address that starts with https://.' });

/** A button as a person adds it: a reply to tap, a web page to open, or a number to ring. */
export const RichButtonInput = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reply'), title: buttonTitle }),
  z.strictObject({ type: z.literal('link'), title: buttonTitle, url: linkUrl }),
  z.strictObject({ type: z.literal('call'), title: buttonTitle, phone: phoneRequired }),
]);
export type RichButtonInput = z.infer<typeof RichButtonInput>;

/** One card of a carousel: a picture (already uploaded), a few words and one or two buttons. */
export const RichCardInput = z
  .strictObject({
    title: z.string().trim().max(RCS_LIMITS.carouselCardTitle).optional(),
    body: z.string().trim().min(1, 'Write something on the card.').max(RCS_LIMITS.carouselCardText),
    mediaFileId: uuid,
    buttons: z
      .array(RichButtonInput)
      .min(RCS_LIMITS.carouselCardButtons.min, 'Give each card a button.')
      .max(
        RCS_LIMITS.carouselCardButtons.max,
        `A card holds ${RCS_LIMITS.carouselCardButtons.max} buttons at most.`,
      ),
  })
  .refine((c) => (c.title?.length ?? 0) + c.body.length <= RCS_LIMITS.carouselCardText, {
    path: ['body'],
    error: `Keep a card’s title and words to ${RCS_LIMITS.carouselCardText} characters together.`,
  });
export type RichCardInput = z.infer<typeof RichCardInput>;

/** Two reply buttons called the same thing would leave nobody able to tell which one a customer meant. */
function uniqueReplies(buttons: readonly RichButtonInput[]): boolean {
  const names = buttons.filter((b) => b.type === 'reply').map((b) => b.title.trim().toLowerCase());
  return new Set(names).size === names.length;
}
const SAME_NAMES = 'Give each reply button a different name.';

/**
 * What a text carries besides its words, sent RCS first. The message's own words are always there: they sit
 * above the buttons, form a card's body, or go above a carousel — and a phone without RCS gets them with the
 * choices written out.
 */
export const RichInput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('buttons'),
    buttons: z
      .array(RichButtonInput)
      .min(1, 'Add a button.')
      .max(RCS_LIMITS.chips, `A message holds ${RCS_LIMITS.chips} buttons at most.`)
      .refine(uniqueReplies, { error: SAME_NAMES }),
  }),
  z.strictObject({
    kind: z.literal('card'),
    title: z.string().trim().min(1, 'Give the card a title.').max(RCS_LIMITS.cardTitle),
    buttons: z
      .array(RichButtonInput)
      .max(RCS_LIMITS.cardButtons, `A card holds ${RCS_LIMITS.cardButtons} buttons at most.`)
      .refine(uniqueReplies, { error: SAME_NAMES })
      .default([]),
  }),
  z.strictObject({
    kind: z.literal('carousel'),
    cards: z
      .array(RichCardInput)
      .min(
        RCS_LIMITS.carouselCards.min,
        `A carousel needs at least ${RCS_LIMITS.carouselCards.min} cards.`,
      )
      .max(
        RCS_LIMITS.carouselCards.max,
        `A carousel holds ${RCS_LIMITS.carouselCards.max} cards at most.`,
      )
      .refine((cards) => uniqueReplies(cards.flatMap((c) => c.buttons)), {
        error: 'Give each card’s reply button a different name, or give the cards titles.',
      }),
  }),
]);
export type RichInput = z.infer<typeof RichInput>;

// ---------- what a text carried, as the thread shows it ----------
export const textTransport = z.enum(['sms', 'mms', 'rcs']);
export type TextTransportOut = z.infer<typeof textTransport>;

export const RichButtonOut = z.object({
  type: z.enum(['reply', 'link', 'call']),
  title: z.string(),
  id: z.string(),
  url: z.string().optional(),
  phone: z.string().optional(),
});
export const RichCardOut = z.object({
  title: z.string().nullable(),
  body: z.string(),
  media: MediaRefSchema,
  buttons: z.array(RichButtonOut),
});
export const RichTextOut = z.object({
  kind: z.enum(['buttons', 'card', 'carousel']),
  title: z.string().nullable(),
  buttons: z.array(RichButtonOut),
  cards: z.array(RichCardOut),
  /** What a phone without RCS got instead. */
  smsText: z.string(),
});
export type RichTextOut = z.infer<typeof RichTextOut>;
export const ButtonReplyOut = z.object({
  type: z.enum(['reply', 'link', 'call']),
  title: z.string(),
  id: z.string().nullable(),
  messageId: uuid.nullable(),
  via: z.enum(['tap', 'text']),
});
export type ButtonReplyOut = z.infer<typeof ButtonReplyOut>;
