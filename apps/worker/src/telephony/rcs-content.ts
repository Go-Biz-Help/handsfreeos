/**
 * A rich text as a Twilio content template (0103).
 *
 * **One template, both faces.** A template holds several types and Twilio sends the richest one the channel it
 * ends up on can show: the card or carousel over RCS, and — when the customer's phone can't show RCS — the
 * `twilio/media` picture message or the `twilio/text` text instead. So the fallback is not something this worker
 * decides after the fact; it is part of what goes to Twilio, written once by core (`rich.smsText`), which is
 * also what the thread shows a phone without RCS got.
 *
 * **One template per message**, made when it is sent and deleted once it is delivered or has failed. Templates
 * are addressed by reference, not content, so sharing one would mean deciding when two messages are "the same"
 * — and every picture in one is a signed link that stops working in hours. A template per message costs one
 * API call and never shows anybody yesterday's picture.
 *
 * How the three kinds map onto Twilio's types:
 *
 * - buttons → `twilio/card` with a body and actions and nothing else, which RCS shows as the message with
 *   suggestion chips under it (up to eleven); with the message's photo it becomes a card (up to four);
 * - card → `twilio/card` with a title, the photo and up to four actions;
 * - carousel → `twilio/carousel`, a card per picture. RCS drops a carousel's body, so its words live on only
 *   in the text fallback and in the business's own thread.
 */
import type { RichButtonRef, RichText } from '@hfos/db/schema';
import type { ContentTemplate } from './provider';

/** Twilio reads `{{1}}` in a template as a variable to fill in; a business's own words are never one. */
const literal = (text: string): string => text.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');

/** One of our buttons as a Twilio action. A call button carries no id on RCS: its tap comes back by name. */
function action(b: RichButtonRef): Record<string, string> {
  if (b.type === 'link')
    return { type: 'URL', title: literal(b.title), url: b.url ?? '', id: b.id };
  if (b.type === 'call')
    return { type: 'PHONE_NUMBER', title: literal(b.title), phone: b.phone ?? '' };
  return { type: 'QUICK_REPLY', title: literal(b.title), id: b.id };
}

/** The template's name at Twilio: the message it belongs to, so a stray one can be traced. */
export const contentName = (messageId: string): string => `hfos_${messageId.replace(/-/g, '')}`;

export function contentTemplateFor(input: {
  readonly messageId: string;
  /** The message's own words. */
  readonly body: string;
  readonly rich: RichText;
  /** The message's photo (a card, or buttons under a photo), signed for Twilio to fetch. */
  readonly photoUrl: string | null;
  /** A carousel's pictures, signed, in card order. */
  readonly cardUrls: readonly string[];
}): ContentTemplate {
  const text = { 'twilio/text': { body: literal(input.rich.smsText) } };
  if (input.rich.kind === 'carousel')
    return {
      friendlyName: contentName(input.messageId),
      types: {
        'twilio/carousel': {
          body: literal(input.body),
          cards: input.rich.cards.map((c, i) => ({
            ...(c.title ? { title: literal(c.title) } : {}),
            body: literal(c.body),
            media: input.cardUrls[i] ?? '',
            actions: c.buttons.map(action),
          })),
        },
        ...text,
      },
    };
  const actions = input.rich.buttons.map(action);
  return {
    friendlyName: contentName(input.messageId),
    types: {
      'twilio/card': {
        ...(input.rich.kind === 'card' && input.rich.title
          ? { title: literal(input.rich.title) }
          : {}),
        body: literal(input.body),
        ...(input.photoUrl ? { media: [input.photoUrl] } : {}),
        ...(actions.length ? { actions } : {}),
      },
      // A phone without RCS still gets the photo, as a picture message with the choices written under it.
      ...(input.photoUrl
        ? { 'twilio/media': { body: literal(input.rich.smsText), media: [input.photoUrl] } }
        : {}),
      ...text,
    },
  };
}

/** What a template sends a phone without RCS: its text, and its picture when it has one (the fake reads this). */
export function fallbackOf(template: Pick<ContentTemplate, 'types'>): {
  readonly body: string;
  readonly mediaUrls: readonly string[];
} {
  const media = template.types['twilio/media'] as { body?: string; media?: string[] } | undefined;
  const text = template.types['twilio/text'] as { body?: string } | undefined;
  if (media?.media?.length) return { body: media.body ?? '', mediaUrls: media.media };
  return { body: text?.body ?? '', mediaUrls: [] };
}
