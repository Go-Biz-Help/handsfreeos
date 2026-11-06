import { describe, expect, it } from 'vitest';
import { answerBlocks, answerCopyText, answerParts, chatLinkHref, speakable } from '../src/index';

/**
 * An Assistant answer's words as the web and the phone show and copy them (assistant/answer-text.ts): links to
 * press, a link that can't pass for another, and what Copy takes.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('links in an answer', () => {
  it('makes a web address written out one to press', () => {
    expect(
      answerParts('Your link is https://handsfreeos.com/book/handsfreeos/chris-s-calendar.'),
    ).toEqual([
      { text: 'Your link is ' },
      {
        text: 'https://handsfreeos.com/book/handsfreeos/chris-s-calendar',
        href: 'https://handsfreeos.com/book/handsfreeos/chris-s-calendar',
      },
      { text: '.' },
    ]);
  });

  it('makes an address without https:// and an email address ones to press', () => {
    const parts = answerParts('Book at handsfreeos.com/book/acme or email dale@acme.com');
    expect(parts.filter((p) => p.href).map((p) => p.href)).toEqual([
      'https://handsfreeos.com/book/acme',
      'mailto:dale@acme.com',
    ]);
  });

  it('opens a page in the app in place', () => {
    expect(answerParts(`[Open the calendar](/app/w/${WS}/calendar)`)).toEqual([
      { text: 'Open the calendar', href: `/app/w/${WS}/calendar`, inApp: true },
    ]);
  });

  it('names the site after words that don’t say where a link goes', () => {
    expect(answerParts('[Pay your bill](https://pay.example.com/x)')).toEqual([
      { text: 'Pay your bill', href: 'https://pay.example.com/x', site: 'pay.example.com' },
    ]);
    expect(answerParts('[handsfreeos.com/book](https://handsfreeos.com/book)')).toEqual([
      { text: 'handsfreeos.com/book', href: 'https://handsfreeos.com/book' },
    ]);
  });

  it('never makes another kind of link, or one hiding where it goes', () => {
    expect(answerParts('[Click](javascript:alert(1))').some((p) => p.href)).toBe(false);
    expect(answerParts('[Bank](https://bank.com@else.com)')).toEqual([{ text: 'Bank' }]);
    expect(chatLinkHref('mailto:dale@acme.com')).toBe('mailto:dale@acme.com');
    expect(chatLinkHref('data:text/html,hi')).toBeNull();
  });

  it('keeps bold, with a link inside it', () => {
    expect(answerParts('**Due today** at **acme.com**')).toEqual([
      { text: 'Due today', bold: true },
      { text: ' at ' },
      { text: 'acme.com', bold: true, href: 'https://acme.com/' },
    ]);
  });
});

describe('a long answer full of marks', () => {
  it('is read quickly, whatever it holds', () => {
    const odd = [
      `* ${' '.repeat(60_000)}\rx`,
      `0) ${' '.repeat(60_000)}\rx`,
      '['.repeat(60_000),
      `[\\](${'[!](!'.repeat(15_000)}`,
    ];
    const started = performance.now();
    for (const text of odd) answerCopyText(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('what Copy takes', () => {
  it('takes the words without their marks, lists a line each, and each link’s address', () => {
    const text =
      'Here are **two** links:\n- [Pay your bill](https://pay.example.com/x)\n- https://acme.com/quote\n\nAsk me anything.';
    expect(answerBlocks(text).map((b) => b.kind)).toEqual(['p', 'ul', 'p']);
    expect(answerCopyText(text)).toBe(
      'Here are two links:\n\n• Pay your bill (https://pay.example.com/x)\n• https://acme.com/quote\n\nAsk me anything.',
    );
  });
});

describe('a link said out loud', () => {
  it('is left for the screen, and the words around it still read well', () => {
    expect(
      speakable('Your booking link is on your screen: https://handsfreeos.com/book/acme'),
    ).toBe('Your booking link is on your screen:');
    expect(
      speakable('Use the booking page (https://handsfreeos.com/book/acme) to pick a time.'),
    ).toBe('Use the booking page to pick a time.');
  });
});
