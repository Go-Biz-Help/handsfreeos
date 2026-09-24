/**
 * Buttons, a card or a carousel to go with a text (RCS, 0103), as a composer builds them: the draft, what
 * message.send takes from it, the first thing wrong with it, and the plain text a phone without RCS gets. The same
 * on the web and the phone, which each draw their own editor around it. Browser-safe.
 *
 * **Nobody picks RCS or SMS.** What is built here goes as RCS to a phone that can show it, and as the same words
 * with the choices written out to one that can't — so an editor always shows that plain face too, worked out by
 * core exactly as the server will write it.
 */
import {
  RCS_LIMITS,
  richSmsText,
  type RichButtonDraft,
  type RichButtonType,
} from '../messaging/rcs';
import { RichInput, type RichInput as RichInputValue } from '../schemas/rcs';

export interface DraftButton {
  readonly key: string;
  readonly type: RichButtonType;
  readonly title: string;
  /** A link's address, or the number a call button rings. */
  readonly target: string;
}

export interface DraftCard {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /** The card's picture, once it is a file of the customer's (or on its way to being one, on the phone). */
  readonly fileId: string | null;
  /** What shows while editing: a link to the picture on the web, its file on the phone. */
  readonly preview: string | null;
  readonly buttons: readonly DraftButton[];
}

export interface RichDraft {
  readonly kind: RichInputValue['kind'];
  /** A card's title. */
  readonly title: string;
  /** Buttons under the words, or on the card. */
  readonly buttons: readonly DraftButton[];
  readonly cards: readonly DraftCard[];
}

/** A fresh button. `newKey` makes the keys an editor tells its rows apart by (the web and the phone each have one). */
export const newDraftButton = (
  newKey: () => string,
  type: RichButtonType = 'reply',
): DraftButton => ({
  key: newKey(),
  type,
  title: '',
  target: '',
});

export const newDraftCard = (newKey: () => string): DraftCard => ({
  key: newKey(),
  title: '',
  body: '',
  fileId: null,
  preview: null,
  buttons: [newDraftButton(newKey)],
});

export const emptyRichDraft = (newKey: () => string): RichDraft => ({
  kind: 'buttons',
  title: '',
  buttons: [newDraftButton(newKey)],
  cards: [newDraftCard(newKey), newDraftCard(newKey)],
});

/** Buttons with anything typed in them, as message.send takes them. */
function buttonsOf(list: readonly DraftButton[]): unknown[] {
  return list
    .filter((b) => b.title.trim() || b.target.trim())
    .map((b) =>
      b.type === 'reply'
        ? { type: 'reply', title: b.title }
        : b.type === 'link'
          ? { type: 'link', title: b.title, url: b.target }
          : { type: 'call', title: b.title, phone: b.target },
    );
}

/** The draft as message.send takes it, or the first thing wrong with it in the words core uses. */
export function richInputOf(
  draft: RichDraft,
): { ok: true; value: RichInputValue } | { ok: false; error: string } {
  const raw =
    draft.kind === 'buttons'
      ? { kind: 'buttons', buttons: buttonsOf(draft.buttons) }
      : draft.kind === 'card'
        ? { kind: 'card', title: draft.title, buttons: buttonsOf(draft.buttons) }
        : {
            kind: 'carousel',
            cards: draft.cards.map((c) => ({
              ...(c.title.trim() ? { title: c.title } : {}),
              body: c.body,
              mediaFileId: c.fileId ?? '',
              buttons: buttonsOf(c.buttons),
            })),
          };
  const parsed = RichInput.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path[0] === 'cards' ? `Card ${Number(issue.path[1] ?? 0) + 1}: ` : '';
  return {
    ok: false,
    error:
      issue?.path.includes('mediaFileId') === true
        ? `${where}Add a picture.`
        : `${where}${issue?.message ?? 'Check the buttons.'}`,
  };
}

const NO_MEDIA = { bucket: '', objectPath: '', contentType: '', sizeBytes: 0, name: '' };

export type RichCheck =
  { ok: true; value: RichInputValue; plain: string | null } | { ok: false; error: string };

/**
 * The draft with the text it goes with: ready to send (and what a phone without RCS gets), or the first thing
 * wrong. The photo rules are message.send's own — a carousel's pictures ride on its cards, and buttons go with
 * one photo — checked here so the person hears about them before pressing Send.
 */
export function checkRich(draft: RichDraft, body: string, photos: number): RichCheck {
  const checked = richInputOf(draft);
  if (!checked.ok) return checked;
  const value = checked.value;
  if (value.kind === 'carousel' && photos > 0)
    return {
      ok: false,
      error: 'A carousel carries its pictures on its cards. Take the attached photo off.',
    };
  if (value.kind !== 'carousel' && photos > 1)
    return { ok: false, error: 'A message with buttons carries one photo.' };
  if (value.kind !== 'carousel' && photos === 1 && value.buttons.length > RCS_LIMITS.cardButtons)
    return {
      ok: false,
      error: `With a photo, a message holds ${RCS_LIMITS.cardButtons} buttons at most.`,
    };
  const plain = body.trim() ? plainFaceOf(body.trim(), value) : null;
  if (plain && plain.length > RCS_LIMITS.smsText)
    return {
      ok: false,
      error:
        'With the choices written out for phones without RCS, this is over 1,600 characters. Shorten the words or take a button off.',
    };
  return { ok: true, value, plain };
}

/** What a phone without RCS gets, before anything is sent: core's own words, as the server will write them. */
export function plainFaceOf(body: string, value: RichInputValue): string {
  const ids = (list: readonly RichButtonDraft[]) =>
    list.map((b, i) => ({ ...b, id: `preview.${i}` }));
  if (value.kind === 'carousel')
    return richSmsText(body, {
      kind: 'carousel',
      title: null,
      buttons: [],
      cards: value.cards.map((c) => ({
        title: c.title ?? null,
        body: c.body,
        media: NO_MEDIA,
        buttons: ids(c.buttons),
      })),
    });
  return richSmsText(body, {
    kind: value.kind,
    title: value.kind === 'card' ? value.title : null,
    buttons: ids(value.buttons),
    cards: [],
  });
}

/** How many buttons the editor offers: a card, or a message with a photo, holds fewer than buttons alone. */
export function richButtonLimit(draft: Pick<RichDraft, 'kind'>, photos: number): number {
  return draft.kind === 'card' || photos > 0 ? RCS_LIMITS.cardButtons : RCS_LIMITS.chips;
}

/** The editor's words, the same on the web and the phone. */
export const RICH_WORDS = {
  whatGoes: 'What goes with the text',
  kind: { buttons: 'Buttons', card: 'Card', carousel: 'Carousel' },
  takeOff: 'Take the buttons off',
  buttonKind: { reply: 'Reply', link: 'Link', call: 'Call' },
  buttonTitle: { reply: 'Confirm', link: 'Book online', call: 'Call us' },
  buttonTarget: { link: 'https://…', call: '(713) 555-0142' },
  addButton: 'Add a button',
  cardTitle: 'Card title',
  cardTitlePlaceholder: 'Spring tune-up: $89',
  cardNote: 'The text below becomes the card’s words; a photo you attach goes on top.',
  cardTitleOptional: 'Title (optional)',
  cardWords: 'A few words',
  addPicture: 'Add a picture',
  addingPicture: 'Adding…',
  addCard: 'Add a card',
  removeCard: 'Remove card',
  carouselNeedsCustomer: 'Link this conversation to a customer to add pictures.',
  rcsOn:
    'Goes as RCS where the customer’s phone can show it. Other phones get it as a text with the choices listed:',
  rcsOff: 'RCS isn’t on for this business, so this goes as a text with the choices listed.',
  /** When the editor can't know whether RCS is on (a phone with no signal): true either way. */
  rcsMaybe:
    'Goes as RCS where it’s on and the customer’s phone can show it. Other phones get it as a text with the choices listed:',
  setUpRcs: 'Set up RCS',
  writeToSee: 'Write the message to see it.',
} as const;
