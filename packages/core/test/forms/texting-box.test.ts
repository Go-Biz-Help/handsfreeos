/**
 * A question asking for permission to text, on a form that already shows our box (2026-11-11): Shop Your Solar's
 * contact form had a required Single checkbox holding an older line beside ours, so customers saw two boxes and
 * only ours saved the yes. The editor and the Assistant point such a question out; these say which ones.
 */
import { describe, expect, it } from 'vitest';
import {
  looksLikeTextingBox,
  showsOurTextingBox,
  textingBoxesTwice,
  type QuestionInput,
} from '../../src/forms/index';
import { def, page, qid, shortText } from './fixtures';

const box = (name: string, title: string, extra: Partial<QuestionInput> = {}): QuestionInput =>
  ({
    id: qid(name),
    type: 'yes_no',
    title,
    config: { display: 'checkbox' },
    required: true,
    ...extra,
  }) as QuestionInput;

const SHOP_YOUR_SOLAR =
  'By giving us your cell number you agree to receive texts from Shop Your Solar LLC about your service, ' +
  'including automated texts about your inquiry, appointments, estimates and reviews. Message rates may apply. ' +
  'Reply STOP to opt out.';

describe('a question that asks for permission to text', () => {
  it('finds the one that doubled up, and says it must be checked', () => {
    const form = def({
      pages: [page('about', [shortText('name'), box('consent', SHOP_YOUR_SOLAR)])],
    });
    expect(textingBoxesTwice(form)).toEqual([
      { questionId: qid('consent'), title: SHOP_YOUR_SOLAR, required: true },
    ]);
  });

  it('reads the usual ways of asking, as a box or as Yes and No buttons', () => {
    for (const title of [
      'Text me updates',
      'It’s OK to text me about this',
      'Can we text you?',
      'I agree to receive SMS messages',
      'I consent to text messages from Lone Star HVAC',
    ])
      expect(looksLikeTextingBox({ type: 'yes_no', title, help: '' })).toBe(true);
    expect(
      looksLikeTextingBox({
        type: 'yes_no',
        title: 'Keep me posted',
        help: 'We may text you. Reply STOP any time.',
      }),
    ).toBe(true);
  });

  it('leaves alone questions that only mention texting, or aren’t a yes or no', () => {
    for (const title of [
      'I agree to the terms',
      'Do you have a pool?',
      'Is a text the best way to reach you?',
    ])
      expect(looksLikeTextingBox({ type: 'yes_no', title, help: '' })).toBe(false);
    expect(looksLikeTextingBox({ type: 'short_text', title: 'Text me at', help: '' })).toBe(false);
  });

  it('says nothing on a form that doesn’t show our box: anonymous, or a live poll', () => {
    const pages = [page('about', [box('consent', 'Text me updates')])];
    const anonymous = def({ pages, settings: { identity: 'anonymous' } });
    expect(showsOurTextingBox(anonymous)).toBe(false);
    expect(textingBoxesTwice(anonymous)).toEqual([]);
    const poll = def({ pages, mode: 'poll' });
    expect(textingBoxesTwice(poll)).toEqual([]);
    expect(textingBoxesTwice(def({ pages }))).toHaveLength(1);
  });
});
