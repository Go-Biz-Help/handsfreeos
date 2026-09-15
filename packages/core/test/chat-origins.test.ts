/**
 * M7 step 4, pure: the sites a website chat widget shows on (normalised from what people type, with www
 * twins, refusals in plain words, and the limit of 10), and the text colour that reads on its accent.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_TEXT_ON_DARK,
  CHAT_TEXT_ON_LIGHT,
  chatWidgetName,
  contrastRatio,
  MAX_CHAT_ORIGINS,
  normalizeChatOrigin,
  normalizeChatOrigins,
  readableTextOn,
} from '../src/chat/index';

describe('one typed site', () => {
  it('becomes an exact origin with its www (or bare) twin', () => {
    const cases: [string, string, string | null][] = [
      ['acme.com', 'https://acme.com', 'https://www.acme.com'],
      ['  ACME.Com  ', 'https://acme.com', 'https://www.acme.com'],
      ['https://www.acme.com/contact?x=1#top', 'https://www.acme.com', 'https://acme.com'],
      ['http://acme.com/', 'https://acme.com', 'https://www.acme.com'],
      ['acme.com.', 'https://acme.com', 'https://www.acme.com'],
      ['https://user:secret@acme.com', 'https://acme.com', 'https://www.acme.com'],
      ['shop.acme.com', 'https://shop.acme.com', null],
      ['acme.co.uk', 'https://acme.co.uk', 'https://www.acme.co.uk'],
      ['www.acme.co.uk', 'https://www.acme.co.uk', 'https://acme.co.uk'],
      ['https://acme.com:8443/book', 'https://acme.com:8443', 'https://www.acme.com:8443'],
      ['https://acme.com:443', 'https://acme.com', 'https://www.acme.com'],
      ['café.com', 'https://xn--caf-dma.com', 'https://www.xn--caf-dma.com'],
      // Your own computer stays on http, for trying the widget out.
      ['localhost:4191', 'http://localhost:4191', null],
      ['http://localhost:4191/test.html', 'http://localhost:4191', null],
      ['http://127.0.0.1:4192', 'http://127.0.0.1:4192', null],
    ];
    for (const [typed, origin, twin] of cases)
      expect({ typed, result: normalizeChatOrigin(typed) }).toEqual({
        typed,
        result: { ok: true, origin, twin },
      });
  });

  it('refuses number addresses, one-word hosts, wildcards and odd characters, in plain words', () => {
    const cases: [string, RegExp][] = [
      ['', /Type the website/],
      ['192.168.1.20', /not a number address/],
      ['https://10.0.0.5:8080', /not a number address/],
      ['http://[::1]:4191', /not a number address.*http:\/\/localhost/],
      ['https://localhost:3000', /use http:\/\/localhost:3000/],
      ['https://127.0.0.1', /use http:\/\/127\.0\.0\.1/],
      ['intranet', /“intranet” isn’t a full web address/],
      ['*.acme.com', /Wildcards/],
      ['acme_corp.com', /letters, numbers, dots and dashes/],
      ['-acme.com', /letters, numbers, dots and dashes/],
      ['ftp://acme.com', /https:\/\/acme\.com/],
      ['not a web address', /doesn’t look like a web address/],
    ];
    for (const [typed, words] of cases) {
      const r = normalizeChatOrigin(typed);
      expect({ typed, ok: r.ok }).toEqual({ typed, ok: false });
      if (!r.ok) expect(r.message).toMatch(words);
    }
  });
});

describe('the list of sites', () => {
  it('adds each twin once, skips blanks, and names the entry each refusal is about', () => {
    expect(
      normalizeChatOrigins([
        'acme.com',
        'www.acme.com',
        '',
        'https://ACME.com/about',
        'shop.acme.com',
      ]),
    ).toEqual({
      origins: ['https://acme.com', 'https://www.acme.com', 'https://shop.acme.com'],
      issues: [],
    });
    expect(normalizeChatOrigins(['acme.com', 'intranet', '10.0.0.1'])).toEqual({
      origins: ['https://acme.com', 'https://www.acme.com'],
      issues: [
        { index: 1, message: expect.stringMatching(/isn’t a full web address/) },
        { index: 2, message: expect.stringMatching(/not a number address/) },
      ],
    });
    expect(normalizeChatOrigins(['', '   '])).toEqual({
      origins: [],
      issues: [{ index: null, message: 'Add the website the chat goes on, like acme.com.' }],
    });
  });

  it('allows 10 sites once the twins are in, and explains when there are more', () => {
    const five = ['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'];
    expect(normalizeChatOrigins(five)).toMatchObject({ issues: [] });
    expect(normalizeChatOrigins(five).origins).toHaveLength(MAX_CHAT_ORIGINS);
    const six = normalizeChatOrigins([...five, 'a6.com']);
    expect(six.issues).toEqual([
      {
        index: null,
        message:
          'A chat can show on up to 10 sites, counting the www versions added for you. This list makes 12.',
      },
    ]);
  });

  it('names a widget by its first site', () => {
    expect(chatWidgetName(['https://www.acme.com:8443', 'https://acme.com'])).toBe(
      'www.acme.com:8443',
    );
    expect(chatWidgetName([])).toBe('Website chat');
  });
});

describe('the text on a widget’s accent', () => {
  it('is white or near-black, whichever reads better', () => {
    expect(readableTextOn('#2d69d8')).toBe(CHAT_TEXT_ON_DARK);
    expect(contrastRatio('#2d69d8', CHAT_TEXT_ON_DARK)).toBeGreaterThan(4.5);
    expect(readableTextOn('#0F766E')).toBe(CHAT_TEXT_ON_DARK);
    expect(readableTextOn('#000000')).toBe(CHAT_TEXT_ON_DARK);
    expect(readableTextOn('#ffffff')).toBe(CHAT_TEXT_ON_LIGHT);
    expect(readableTextOn('#ffd23f')).toBe(CHAT_TEXT_ON_LIGHT);
    expect(readableTextOn('#fff')).toBe(CHAT_TEXT_ON_LIGHT);
    expect(readableTextOn('blue')).toBe(CHAT_TEXT_ON_DARK);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
});
