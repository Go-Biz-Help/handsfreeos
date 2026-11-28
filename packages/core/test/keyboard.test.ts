import { describe, expect, it } from 'vitest';
import {
  buildKeyboardBusiness,
  buildKeyboardData,
  KEYBOARD_DATA_VERSION,
  KEYBOARD_LIMITS,
  keyboardParts,
  readKeyboardData,
  readKeyboardSeen,
  type KeyboardBusinessInput,
} from '../src/keyboard';

const base: KeyboardBusinessInput = {
  id: 'w1',
  name: 'Lone Star Heating LLC',
  settings: {
    website: 'lonestarhvac.com',
    links: { review: 'https://g.page/r/lone-star/review' },
  },
  site: { slug: 'lone-star', name: 'Lone Star HVAC', enabled: true },
  origin: 'https://handsfreeos.com',
  phoneE164: '+12145550100',
  email: 'hello@lonestarhvac.com',
  calendars: [
    { name: 'Repairs', slug: 'repairs', status: 'active', public: 1, createdAt: '2026-03-01' },
    { name: 'Tune-ups', slug: 'tune-ups', status: 'active', public: 1, createdAt: '2026-01-01' },
    { name: 'Inside only', slug: 'inside', status: 'active', public: 0, createdAt: '2025-01-01' },
    { name: 'Old', slug: 'old', status: 'archived', public: 1, createdAt: '2024-01-01' },
  ],
  forms: [
    { name: 'Quote request', slug: 'quote', mode: 'form' },
    { name: 'How did we do?', slug: 'feedback', mode: 'survey' },
    { name: 'Live poll', slug: 'poll', mode: 'poll' },
  ],
  templates: [
    {
      id: 't1',
      name: 'Book a visit',
      channel: 'sms',
      folder: 'Sales',
      body: 'Hi {{person.first_name | default:"friend"}}, it’s {{business.name}}. Pick a time: {{links.booking}}',
    },
    {
      id: 't2',
      name: 'Estimate follow-up',
      channel: 'email',
      folder: '',
      body: 'Hi {{ person.first_name }}, any questions about {{lead.title}}? Call {{business.phone}}.',
    },
    {
      id: 't3',
      name: 'Old one',
      channel: 'sms',
      folder: null,
      body: 'Bye',
      archivedAt: '2026-05-01',
    },
  ],
  now: '2026-11-27T23:40:00.000Z',
};

describe('the keyboard’s templates', () => {
  it('fills the business’s details and asks for the first name', () => {
    const b = buildKeyboardBusiness(base);
    const [t1] = b.templates;
    expect(t1?.parts).toEqual([
      { text: 'Hi ' },
      { ask: 'first_name', fallback: 'friend', transform: null },
      {
        text: ', it’s Lone Star HVAC. Pick a time: https://handsfreeos.com/book/lone-star/tune-ups',
      },
    ]);
    expect(t1?.asks).toBe(true);
    expect(t1?.note).toBeNull();
    expect(t1?.preview).toBe(
      'Hi friend, it’s Lone Star HVAC. Pick a time: https://handsfreeos.com/book/lone-star/tune-ups',
    );
    expect(t1?.folder).toBe('Sales');
  });

  it('skips to “there” with no fallback of its own, and names what is left to fill', () => {
    const t2 = buildKeyboardBusiness(base).templates[1];
    expect(t2?.parts[1]).toEqual({ ask: 'first_name', fallback: 'there', transform: null });
    expect(t2?.parts[2]).toEqual({
      text: ', any questions about {{lead.title}}? Call (214) 555-0100.',
    });
    expect(t2?.note).toBe('Fill in {{lead.title}} before you send it.');
    expect(t2?.folder).toBeNull();
    expect(t2?.channel).toBe('email');
  });

  it('leaves archived templates out, and keeps none when they could not be read', () => {
    expect(buildKeyboardBusiness(base).templates.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(buildKeyboardBusiness({ ...base, templates: null }).templates).toEqual([]);
  });

  it('keeps a first name’s upper or lower filter for the keyboard to apply', () => {
    const { parts } = keyboardParts('HEY {{person.first_name | upper}}!', {});
    expect(parts[1]).toEqual({ ask: 'first_name', fallback: 'there', transform: 'upper' });
  });

  it('leaves a placeholder it can’t read as typed', () => {
    const { parts, left } = keyboardParts('Hi {{ person.first-name }} there', {});
    expect(parts).toEqual([{ text: 'Hi {{ person.first-name }} there' }]);
    expect(left).toEqual(['person.first-name']);
  });

  it('keeps a template within the limit', () => {
    const long = 'a'.repeat(KEYBOARD_LIMITS.templateChars + 50);
    const b = buildKeyboardBusiness({
      ...base,
      templates: [{ id: 'x', name: 'Long', channel: 'sms', folder: null, body: long }],
    });
    expect((b.templates[0]?.parts[0] as { text: string }).text).toHaveLength(
      KEYBOARD_LIMITS.templateChars,
    );
  });
});

describe('the keyboard’s links', () => {
  it('offers bookable calendars oldest first, live forms, the review link and the website', () => {
    const links = buildKeyboardBusiness(base).links;
    expect(links.map((l) => [l.kind, l.name, l.detail, l.url])).toEqual([
      ['booking', 'Tune-ups', 'Booking page', 'https://handsfreeos.com/book/lone-star/tune-ups'],
      ['booking', 'Repairs', 'Booking page', 'https://handsfreeos.com/book/lone-star/repairs'],
      ['form', 'How did we do?', 'Survey', 'https://handsfreeos.com/f/lone-star/feedback'],
      ['form', 'Quote request', 'Form', 'https://handsfreeos.com/f/lone-star/quote'],
      [
        'review',
        'Review link',
        'https://g.page/r/lone-star/review',
        'https://g.page/r/lone-star/review',
      ],
      ['website', 'Website', 'lonestarhvac.com', 'lonestarhvac.com'],
    ]);
  });

  it('has no booking pages while the booking site is off, and reads the older review setting', () => {
    const links = buildKeyboardBusiness({
      ...base,
      site: { slug: 'lone-star', name: null, enabled: false },
      settings: { reviewUrl: 'https://g.page/r/old' },
    }).links;
    expect(links.map((l) => l.kind)).toEqual(['form', 'form', 'review']);
    expect(buildKeyboardBusiness({ ...base, site: null }).name).toBe('Lone Star Heating LLC');
  });
});

describe('the keyboard’s whole copy', () => {
  it('puts the open business first, keeps others and drops ones the person left', () => {
    const one = buildKeyboardBusiness(base);
    const two = { ...one, id: 'w2', name: 'Second' };
    const three = { ...one, id: 'w3', name: 'Left' };
    const before = buildKeyboardData(
      buildKeyboardData(null, three, new Set(['w3'])),
      two,
      new Set(['w2', 'w3']),
    );
    const after = buildKeyboardData(before, one, new Set(['w1', 'w2']));
    expect(after.current).toBe('w1');
    expect(after.businesses.map((b) => b.id)).toEqual(['w1', 'w2']);
    expect(after.v).toBe(KEYBOARD_DATA_VERSION);
    expect(after.words.templates).toBe('Templates');
  });

  it('reads back what it wrote, and nothing else', () => {
    const data = buildKeyboardData(null, buildKeyboardBusiness(base), new Set(['w1']));
    expect(readKeyboardData(JSON.stringify(data))).toEqual(data);
    expect(readKeyboardData('{"v":0,"businesses":[]}')).toBeNull();
    expect(readKeyboardData('not json')).toBeNull();
    expect(readKeyboardData(null)).toBeNull();
    expect(readKeyboardSeen('{"at":"2026-11-27T23:00:00Z","fullAccess":true}')).toEqual({
      at: '2026-11-27T23:00:00Z',
      fullAccess: true,
    });
    expect(readKeyboardSeen('{}')).toBeNull();
  });
});
