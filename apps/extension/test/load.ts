import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

/** A hand-written page from test/fixtures, opened at `url`. */
export function load(name: string, url: string): Document {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return new JSDOM(html, { url }).window.document;
}

/** Pieces of a line of text get a `span` around them, not a `div`, so no line breaks where the page's doesn't. */
const IN_A_LINE = new Set('A ABBR B EM I IMG LABEL SMALL SPAN STRONG svg'.split(' '));

/**
 * The page with a bare box around every element: Facebook wraps everything in more boxes than a page outline shows,
 * and the readers must read a page the same however many there are.
 */
export function boxEverything(doc: Document): Document {
  for (const element of [...doc.body.querySelectorAll('*')]) {
    if (element.parentElement?.closest('svg')) continue;
    const box = doc.createElement(IN_A_LINE.has(element.tagName) ? 'span' : 'div');
    element.replaceWith(box);
    box.append(element);
  }
  return doc;
}
