/**
 * Buttons, a card or a carousel as a composer builds them (RCS, 0103), the same on the web and the phone: what
 * message.send takes from a draft, the first thing wrong with it, and the plain text a phone without RCS gets.
 */
import { describe, expect, it } from 'vitest';
import {
  checkRich,
  emptyRichDraft,
  newDraftButton,
  newDraftCard,
  RCS_LIMITS,
  richButtonLimit,
  richInputOf,
  type DraftButton,
  type RichButtonType,
  type RichDraft,
} from '../src/index';

let n = 0;
const key = () => `k${++n}`;
const button = (type: RichButtonType, title: string, target = ''): DraftButton => ({
  ...newDraftButton(key, type),
  title,
  target,
});
const PICTURE_A = '6f1f0c7e-6b1e-4c1a-9e53-1a9f2d2c3b4a';
const PICTURE_B = '0b2c3d4e-5f60-4172-8394-a5b6c7d8e9f0';
const draft = (over: Partial<RichDraft>): RichDraft => ({ ...emptyRichDraft(key), ...over });
const carousel = (): RichDraft =>
  draft({
    kind: 'carousel',
    cards: [
      {
        ...newDraftCard(key),
        title: 'Tune-up',
        body: '$89 this week',
        fileId: PICTURE_A,
        buttons: [button('reply', 'Book the tune-up')],
      },
      {
        ...newDraftCard(key),
        body: 'Duct cleaning, $149',
        fileId: PICTURE_B,
        buttons: [button('reply', 'Book the cleaning')],
      },
    ],
  });

describe('a rich draft', () => {
  it('starts as one empty button, with two empty cards ready should it become a carousel', () => {
    const d = emptyRichDraft(key);
    expect(d).toMatchObject({ kind: 'buttons', title: '' });
    expect(d.buttons).toHaveLength(1);
    expect(d.cards).toHaveLength(2);
    const keys = [...d.buttons, ...d.cards, ...d.cards.flatMap((c) => c.buttons)].map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('becomes what message.send takes, leaving out the buttons nobody typed in', () => {
    const checked = richInputOf(
      draft({
        buttons: [
          button('reply', 'Confirm'),
          button('link', 'Book online', 'https://lonestarhvac.com/book'),
          button('call', 'Call us', '(713) 555-0142'),
          button('reply', ''),
        ],
      }),
    );
    expect(checked).toMatchObject({
      ok: true,
      value: {
        kind: 'buttons',
        buttons: [
          { type: 'reply', title: 'Confirm' },
          { type: 'link', title: 'Book online', url: 'https://lonestarhvac.com/book' },
          { type: 'call', title: 'Call us' },
        ],
      },
    });
    expect(richInputOf(carousel())).toMatchObject({
      ok: true,
      value: {
        kind: 'carousel',
        cards: [
          { title: 'Tune-up', body: '$89 this week', mediaFileId: PICTURE_A },
          { body: 'Duct cleaning, $149', mediaFileId: PICTURE_B },
        ],
      },
    });
  });

  it('says the first thing wrong in core’s words, naming the card it is on', () => {
    expect(richInputOf(draft({ kind: 'card', buttons: [button('reply', 'Yes')] }))).toEqual({
      ok: false,
      error: 'Give the card a title.',
    });
    const [first, second] = carousel().cards;
    expect(
      richInputOf(draft({ kind: 'carousel', cards: [first!, { ...second!, fileId: null }] })),
    ).toEqual({ ok: false, error: 'Card 2: Add a picture.' });
    expect(
      richInputOf(draft({ buttons: [button('reply', 'Yes'), button('reply', 'yes')] })),
    ).toMatchObject({ ok: false });
  });

  it('holds the photo rules message.send holds', () => {
    const five = draft({ buttons: [1, 2, 3, 4, 5].map((i) => button('reply', `Choice ${i}`)) });
    expect(checkRich(five, 'Pick one', 0).ok).toBe(true);
    expect(checkRich(five, 'Pick one', 1)).toEqual({
      ok: false,
      error: `With a photo, a message holds ${RCS_LIMITS.cardButtons} buttons at most.`,
    });
    expect(checkRich(five, 'Pick one', 2)).toEqual({
      ok: false,
      error: 'A message with buttons carries one photo.',
    });
    expect(checkRich(carousel(), 'Two offers this week', 1)).toEqual({
      ok: false,
      error: 'A carousel carries its pictures on its cards. Take the attached photo off.',
    });
    expect(richButtonLimit({ kind: 'buttons' }, 0)).toBe(RCS_LIMITS.chips);
    expect(richButtonLimit({ kind: 'buttons' }, 1)).toBe(RCS_LIMITS.cardButtons);
    expect(richButtonLimit({ kind: 'card' }, 0)).toBe(RCS_LIMITS.cardButtons);
  });

  it('shows the plain text a phone without RCS gets, as the server will write it', () => {
    const d = draft({ buttons: [button('reply', 'Confirm'), button('reply', 'Reschedule')] });
    expect(checkRich(d, 'Your visit is tomorrow at 2 PM.', 0)).toEqual({
      ok: true,
      value: {
        kind: 'buttons',
        buttons: [
          { type: 'reply', title: 'Confirm' },
          { type: 'reply', title: 'Reschedule' },
        ],
      },
      plain: 'Your visit is tomorrow at 2 PM.\n\nReply 1 for Confirm or 2 for Reschedule.',
    });
    // Nothing written yet: nothing to show.
    expect(checkRich(d, '   ', 0)).toMatchObject({ ok: true, plain: null });
    expect(checkRich(d, 'x'.repeat(RCS_LIMITS.smsText), 0)).toMatchObject({ ok: false });
  });
});
