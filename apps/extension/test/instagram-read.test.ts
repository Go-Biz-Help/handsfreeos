/**
 * Instagram's own readers (src/networks/instagram/read.ts; the Instagram and Alignable plan's part 9): what Check
 * Instagram follows from page to page, the places, hashtags and chats a page links to, each once and made whole.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { readInstagram } from '../src/networks/instagram/read';

const IG = 'https://www.instagram.com';
const page = (body: string, url = `${IG}/p/E2bCd45EfGh/`) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url }).window.document;

describe('Instagram’s links to places, hashtags and chats', () => {
  it('finds each once, made whole, and nothing that only looks like one', () => {
    const doc = page(`<main>
      <a href="/explore/locations/212988663/austin-texas/">Austin, Texas</a>
      <a href="https://www.instagram.com/explore/locations/212988663/austin-texas/?hl=en">Austin again</a>
      <a href="/explore/tags/smallbusiness/">#smallbusiness</a>
      <a href="/direct/t/340282366841710300">dana.reyes</a>
      <a href="/explore/">Explore</a><a href="https://example.com/explore/tags/x/">elsewhere</a></main>`);
    expect(readInstagram(doc, doc.location.href)).toMatchObject({
      locations: [`${IG}/explore/locations/212988663/austin-texas/`],
      tags: [`${IG}/explore/tags/smallbusiness/`],
      threads: [`${IG}/direct/t/340282366841710300/`],
    });
  });
});
