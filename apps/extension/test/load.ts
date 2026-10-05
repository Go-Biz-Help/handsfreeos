import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

/** A hand-written page from test/fixtures, opened at `url`. */
export function load(name: string, url: string): Document {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return new JSDOM(html, { url }).window.document;
}
