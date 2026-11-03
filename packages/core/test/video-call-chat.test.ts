/**
 * A call's chat (docs/video-calls.md, "The chat"): its links, pressable on the web and the phone from core's
 * `chatLinkParts`, and what's typed in it, kept in the transcript beside what's said (`videoCallTranscript`).
 *
 * What's worth holding:
 *   - web addresses with or without `https://`, `www.` ones, and email addresses become links;
 *   - what shows is what was typed, and the punctuation around a link stays text;
 *   - only http(s) pages and `mailto:` are ever opened, never another scheme or an address hiding its host;
 *   - ordinary words with dots in them ("e.g.", "node.js") stay text, and joined, the parts are the whole message;
 *   - in the transcript, a typed line reads "Name (in the chat): …", on its own, never run into what they said.
 */
import { describe, expect, it } from 'vitest';
import { chatLinkParts } from '../src/meetings/chat-links';
import { VIDEO_CALL_TYPED_MARK, videoCallTranscript } from '../src/meetings/video-calls';

const links = (text: string) =>
  chatLinkParts(text)
    .filter((p) => p.href)
    .map((p) => [p.text, p.href]);

describe('chatLinkParts', () => {
  it('makes web addresses and email addresses into links', () => {
    expect(links('Here it is: https://acme.com/quote?id=7 and www.acme.com too')).toEqual([
      ['https://acme.com/quote?id=7', 'https://acme.com/quote?id=7'],
      ['www.acme.com', 'https://www.acme.com/'],
    ]);
    expect(links('Book at acme.co/book or email dana@acme.co')).toEqual([
      ['acme.co/book', 'https://acme.co/book'],
      ['dana@acme.co', 'mailto:dana@acme.co'],
    ]);
  });

  it('leaves the punctuation around a link as text', () => {
    const parts = chatLinkParts('See (https://acme.com/a_(b)), then “www.acme.com”.');
    expect(parts).toEqual([
      { text: 'See (' },
      { text: 'https://acme.com/a_(b)', href: 'https://acme.com/a_(b)' },
      { text: '), then “' },
      { text: 'www.acme.com', href: 'https://www.acme.com/' },
      { text: '”.' },
    ]);
  });

  it('never opens anything but a web page or an email', () => {
    expect(links('javascript:alert(1) data:text/html,hi ftp://acme.com')).toEqual([]);
    expect(links('https://bank.com@evil.com/login')).toEqual([]);
    expect(links('http://localhost:3000 https://')).toEqual([]);
  });

  it('keeps ordinary words with dots in them as text', () => {
    expect(links('e.g. node.js, v1.2.3, Mr.Smith and the readme.md file')).toEqual([]);
  });

  it('gives back the whole message, spaces and lines included', () => {
    const text = 'Hi!\n\nMy site is  acme.com.\nThanks';
    expect(
      chatLinkParts(text)
        .map((p) => p.text)
        .join(''),
    ).toBe(text);
    expect(chatLinkParts('')).toEqual([]);
    expect(chatLinkParts('no links here')).toEqual([{ text: 'no links here' }]);
  });
});

describe('the transcript, with the chat in it', () => {
  it('keeps each typed line on its own, marked, between what was said', () => {
    expect(VIDEO_CALL_TYPED_MARK).toBe('(in the chat)');
    expect(
      videoCallTranscript([
        { name: 'Dana', body: 'What’s the best email for the quote?' },
        { name: 'Ana', body: 'I’ll type it.' },
        { name: 'Ana', body: 'ana@example.com', typed: true },
        { name: 'Ana', body: 'and my cell 512 555 0100', typed: true },
        { name: 'Ana', body: 'There you go.' },
        { name: 'Ana', body: 'Thanks!' },
      ]),
    ).toBe(
      [
        'Dana: What’s the best email for the quote?',
        'Ana: I’ll type it.',
        'Ana (in the chat): ana@example.com',
        'Ana (in the chat): and my cell 512 555 0100',
        'Ana: There you go. Thanks!',
      ].join('\n'),
    );
  });
});
