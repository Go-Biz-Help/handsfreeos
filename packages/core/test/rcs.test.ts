/**
 * RCS (0103): the rules a rich text keeps. Its plain face (what a phone without RCS gets), the numbering a
 * customer texts back against, the ids a tap comes back with, and what the composer and the command refuse.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRichText,
  buttonForTap,
  buttonIdsFor,
  buttonReplyLine,
  carrierWordTitle,
  choiceForText,
  deliveryStateOf,
  deliveryWords,
  isHttpsUrl,
  phoneOfAddress,
  RichInput,
  rcsSenderIdInput,
  replyChoices,
  richSmsText,
  transportWord,
} from '../src/index';

const MESSAGE = '9b1f04c2-7d3e-4a55-9a0b-1c2d3e4f5a6b';
const picture = (name: string) => ({
  bucket: 'attachments',
  objectPath: `ws/people/p/${name}`,
  contentType: 'image/jpeg',
  sizeBytes: 1000,
  name,
});

describe('the plain face of a rich text', () => {
  it('lists two or three reply choices in a sentence, with links and numbers written out', () => {
    const rich = buildRichText(MESSAGE, 'Your visit is tomorrow at 2 PM.', {
      kind: 'buttons',
      buttons: [
        { type: 'reply', title: 'Confirm' },
        { type: 'reply', title: 'Reschedule' },
        { type: 'link', title: 'Directions', url: 'https://maps.example.com/lonestar' },
        { type: 'call', title: 'Call us', phone: '+17135550142' },
      ],
    });
    expect(rich.smsText).toBe(
      [
        'Your visit is tomorrow at 2 PM.',
        '',
        'Directions: https://maps.example.com/lonestar',
        'Call us: (713) 555-0142',
        '',
        'Reply 1 for Confirm or 2 for Reschedule.',
      ].join('\n'),
    );
  });

  it('turns four or more choices into a numbered list', () => {
    const text = richSmsText('Which day works?', {
      kind: 'buttons',
      title: null,
      cards: [],
      buttons: ['Mon', 'Tue', 'Wed', 'Thu'].map((d, i) => ({
        type: 'reply' as const,
        title: d,
        id: `x.r${i + 1}`,
      })),
    });
    expect(text).toBe('Which day works?\n\nReply with a number:\n1. Mon\n2. Tue\n3. Wed\n4. Thu');
  });

  it('puts a card’s title above its words', () => {
    const rich = buildRichText(MESSAGE, 'Duct cleaning for the whole house.', {
      kind: 'card',
      title: 'Spring special: $149',
      buttons: [{ type: 'reply', title: 'Book it' }],
    });
    expect(rich.smsText).toBe(
      'Spring special: $149\nDuct cleaning for the whole house.\n\nReply 1 for Book it.',
    );
    expect(rich.title).toBe('Spring special: $149');
  });

  it('writes a carousel’s cards one to a line, numbering every reply card by card', () => {
    const rich = buildRichText(MESSAGE, 'Pick a plan:', {
      kind: 'carousel',
      cards: [
        {
          title: 'Basic',
          body: 'One visit a year',
          media: picture('a.jpg'),
          buttons: [{ type: 'reply', title: 'Choose' }],
        },
        {
          title: 'Plus',
          body: 'Two visits a year',
          media: picture('b.jpg'),
          buttons: [
            { type: 'reply', title: 'Choose Plus' },
            { type: 'link', title: 'Details', url: 'https://lonestar.example.com/plus' },
          ],
        },
      ],
    });
    expect(rich.smsText).toBe(
      [
        'Pick a plan:',
        '',
        '1) Basic - One visit a year',
        '2) Plus - Two visits a year',
        'Details: https://lonestar.example.com/plus',
        '',
        'Reply 1 for Basic: Choose or 2 for Plus: Choose Plus.',
      ].join('\n'),
    );
    expect(rich.cards.map((c) => c.buttons.map((b) => b.id))).toEqual([
      ['9b1f04c2.1r1'],
      ['9b1f04c2.2r1', '9b1f04c2.2l1'],
    ]);
  });

  it('keeps to the cheaper encoding: curly quotes and long dashes go plain', () => {
    expect(
      richSmsText('We’re on the way — see you soon', {
        kind: 'buttons',
        title: null,
        cards: [],
        buttons: [{ type: 'reply', title: 'OK', id: 'x.r1' }],
      }),
    ).toBe("We're on the way - see you soon\n\nReply 1 for OK.");
  });
});

describe('buttons', () => {
  it('get ids from their message, different for every button in it', () => {
    const ids = buttonIdsFor(MESSAGE, [
      { type: 'reply', title: 'A' },
      { type: 'reply', title: 'B' },
      { type: 'link', title: 'C', url: 'https://x.example.com' },
      { type: 'call', title: 'D', phone: '+17135550142' },
    ]).map((b) => b.id);
    expect(ids).toEqual(['9b1f04c2.r1', '9b1f04c2.r2', '9b1f04c2.l1', '9b1f04c2.c1']);
  });

  it('are found from a tap by their id, or by their name when a tap brings no id', () => {
    const rich = buildRichText(MESSAGE, 'Tomorrow at 2?', {
      kind: 'buttons',
      buttons: [
        { type: 'reply', title: 'Confirm' },
        { type: 'call', title: 'Call us', phone: '+17135550142' },
      ],
    });
    expect(buttonForTap(rich, '9b1f04c2.r1', 'Confirm')?.title).toBe('Confirm');
    expect(buttonForTap(rich, null, 'Call us')?.type).toBe('call');
    expect(buttonForTap(rich, 'something-else', 'Nope')).toBeNull();
  });

  it('are matched from a texted-back number or name, and only when that is the whole reply', () => {
    const rich = buildRichText(MESSAGE, 'Tomorrow at 2?', {
      kind: 'buttons',
      buttons: [
        { type: 'reply', title: 'Confirm' },
        { type: 'reply', title: 'Reschedule' },
      ],
    });
    expect(choiceForText(rich, '2')?.button.title).toBe('Reschedule');
    expect(choiceForText(rich, ' #1. ')?.button.title).toBe('Confirm');
    expect(choiceForText(rich, 'reschedule!')?.button.title).toBe('Reschedule');
    expect(choiceForText(rich, '3')).toBeNull();
    expect(choiceForText(rich, '2 people are coming')).toBeNull();
    expect(replyChoices(rich).map((c) => c.number)).toEqual([1, 2]);
  });

  it('never carry a word carriers act on by themselves, except YES', () => {
    expect(carrierWordTitle('Cancel')).toBe(true);
    expect(carrierWordTitle('STOP!')).toBe(true);
    expect(carrierWordTitle('Help')).toBe(true);
    expect(carrierWordTitle('Yes')).toBe(false);
    expect(carrierWordTitle('Cancel visit')).toBe(false);
  });

  it('say in the thread how the customer chose', () => {
    expect(buttonReplyLine({ type: 'reply', title: 'Confirm', via: 'tap' })).toBe(
      'Tapped “Confirm”',
    );
    expect(buttonReplyLine({ type: 'reply', title: 'Confirm', via: 'text' }, '1')).toBe(
      'Texted 1 for “Confirm”',
    );
    expect(buttonReplyLine({ type: 'link', title: 'Book online', via: 'tap' })).toBe(
      'Opened “Book online”',
    );
  });
});

describe('what the composer and the command refuse', () => {
  it('takes a button’s name up to Twilio’s 20 characters, and no carrier word', () => {
    const ok = RichInput.safeParse({ kind: 'buttons', buttons: [{ type: 'reply', title: 'Yes' }] });
    expect(ok.success).toBe(true);
    const long = RichInput.safeParse({
      kind: 'buttons',
      buttons: [{ type: 'reply', title: 'This name is far too long' }],
    });
    expect(long.success).toBe(false);
    const stop = RichInput.safeParse({
      kind: 'buttons',
      buttons: [{ type: 'reply', title: 'Cancel' }],
    });
    expect(stop.success).toBe(false);
  });

  it('opens only https links, and refuses two reply buttons with one name', () => {
    expect(isHttpsUrl('https://lonestar.example.com/book')).toBe(true);
    expect(isHttpsUrl('http://lonestar.example.com')).toBe(false);
    expect(isHttpsUrl('lonestar.example.com')).toBe(false);
    const twice = RichInput.safeParse({
      kind: 'buttons',
      buttons: [
        { type: 'reply', title: 'Yes' },
        { type: 'reply', title: 'yes' },
      ],
    });
    expect(twice.success).toBe(false);
  });

  it('holds a carousel to two to ten cards, each with a picture and a button', () => {
    const card = (n: number) => ({
      body: `Card ${n}`,
      mediaFileId: '00000000-0000-4000-8000-00000000000' + n,
      buttons: [{ type: 'reply', title: `Pick ${n}` }],
    });
    expect(RichInput.safeParse({ kind: 'carousel', cards: [card(1)] }).success).toBe(false);
    expect(RichInput.safeParse({ kind: 'carousel', cards: [card(1), card(2)] }).success).toBe(true);
    expect(
      RichInput.safeParse({ kind: 'carousel', cards: [card(1), { ...card(2), buttons: [] }] })
        .success,
    ).toBe(false);
  });

  it('reads a sender id with or without the rcs: in front', () => {
    expect(rcsSenderIdInput.parse('rcs:lonestar_hvac_agent')).toBe('lonestar_hvac_agent');
    expect(rcsSenderIdInput.parse('  lonestar_hvac_agent ')).toBe('lonestar_hvac_agent');
    expect(rcsSenderIdInput.safeParse('not an id').success).toBe(false);
  });
});

describe('how a text went', () => {
  it('names the way under the message, and says Read once RCS says so', () => {
    expect(transportWord('rcs')).toBe('RCS');
    expect(transportWord('mms')).toBe('MMS');
    expect(transportWord(null)).toBeNull();
    expect(deliveryWords(deliveryStateOf('read'))).toBe('Read');
  });

  it('reads a customer’s number out of an RCS address', () => {
    expect(phoneOfAddress('rcs:+17135550142')).toBe('+17135550142');
    expect(phoneOfAddress('+17135550142')).toBe('+17135550142');
    expect(phoneOfAddress('rcs:lonestar_agent')).toBeNull();
  });
});
