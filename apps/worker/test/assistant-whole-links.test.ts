import { describe, expect, it } from 'vitest';
import { onPublicOrigin, wholeLinksIn, withWholeLinks } from '../src/assistant/full-links';

/**
 * Whole links for the Assistant (assistant/full-links.ts): the setup keeps public pages as paths, and the model is
 * handed them written out on the business's address so it never has to guess the start of one.
 */

const ORIGIN = 'https://app.handsfreeos.com';

describe('a public page’s path', () => {
  it('is written out whole, alone or in words, and the sentence’s end is left after it', () => {
    expect(wholeLinksIn('/book/handsfreeos/chris-s-calendar', ORIGIN)).toBe(
      `${ORIGIN}/book/handsfreeos/chris-s-calendar`,
    );
    expect(wholeLinksIn('Your page is at /book/acme. Share it!', ORIGIN)).toBe(
      `Your page is at ${ORIGIN}/book/acme. Share it!`,
    );
    expect(wholeLinksIn('[Book a visit](/book/acme/tune-up)', ORIGIN)).toBe(
      `[Book a visit](${ORIGIN}/book/acme/tune-up)`,
    );
    expect(wholeLinksIn('the form (/f/acme/quote?x=1)', ORIGIN)).toBe(
      `the form (${ORIGIN}/f/acme/quote?x=1)`,
    );
  });

  it('leaves the app’s own pages, whole links and other paths alone', () => {
    expect(wholeLinksIn('/app/w/123/calendar', ORIGIN)).toBeNull();
    expect(wholeLinksIn('https://acme.com/book/acme', ORIGIN)).toBeNull();
    expect(wholeLinksIn('see /settings/calendars or 3/4 of them', ORIGIN)).toBeNull();
  });

  it('is read quickly, however long the text', () => {
    const started = performance.now();
    wholeLinksIn(`/book/${'.'.repeat(60_000)}x`, ORIGIN);
    wholeLinksIn(` /${'a/'.repeat(30_000)}`, ORIGIN);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('what a tool found', () => {
  it('has every public path in it made whole, on the business’s own domain when it has one', async () => {
    const found = {
      calendars: [
        {
          name: 'Chris',
          bookingPath: '/book/handsfreeos/chris',
          permanentPath: '/book/c/abc',
          href: '/app/w/1/x',
        },
      ],
      count: 1,
    };
    expect(await withWholeLinks(found, async () => 'https://book.acme.com/')).toEqual({
      calendars: [
        {
          name: 'Chris',
          bookingPath: 'https://book.acme.com/book/handsfreeos/chris',
          permanentPath: 'https://book.acme.com/book/c/abc',
          href: '/app/w/1/x',
        },
      ],
      count: 1,
    });
  });

  it('looks the address up only when there is a path to write out, and keeps it as it was without one', async () => {
    let asked = 0;
    const origin = async () => {
      asked++;
      return '';
    };
    const plain = { name: 'Chris', href: '/app/w/1/x' };
    expect(await withWholeLinks(plain, origin)).toBe(plain);
    expect(asked).toBe(0);
    const path = { bookingPath: '/book/acme' };
    expect(await withWholeLinks(path, origin)).toBe(path);
    expect(asked).toBe(1);
  });
});

describe('a link the model gives an add-on', () => {
  const LISTING = '/a/acme/realestate/12-elm-st';

  it('is put on the business’s own address when the model guessed one of ours in front of the path', async () => {
    const args = {
      dealId: 'd1',
      pageUrl: `https://handsfreeos.com${LISTING}`,
      details: { link: `${ORIGIN}/book/acme/tune-up?ref=x`, offer: 'A tune-up' },
    };
    expect(await onPublicOrigin(args, async () => 'https://go.acme.com/', ORIGIN)).toEqual({
      dealId: 'd1',
      pageUrl: `https://go.acme.com${LISTING}`,
      details: { link: 'https://go.acme.com/book/acme/tune-up?ref=x', offer: 'A tune-up' },
    });
  });

  it('leaves another site’s link, the app’s own pages and words alone, and looks nothing up for them', async () => {
    let asked = 0;
    const origin = async () => {
      asked++;
      return 'https://go.acme.com';
    };
    const args = {
      website: 'https://acme.com/book/now',
      videoLink: 'https://www.loom.com/share/abc',
      back: `${ORIGIN}/app/w/1/settings`,
      note: `Book at https://handsfreeos.com/book/acme today`,
    };
    expect(await onPublicOrigin(args, origin, ORIGIN)).toBe(args);
    expect(asked).toBe(0);
  });

  it('is left as it was when it is already on the address the pages are on', async () => {
    const args = { pageUrl: `${ORIGIN}${LISTING}` };
    expect(await onPublicOrigin(args, async () => ORIGIN, ORIGIN)).toEqual(args);
  });
});
