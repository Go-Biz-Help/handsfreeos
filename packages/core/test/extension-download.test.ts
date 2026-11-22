/**
 * The browser extension's download, said the same wherever it's offered (docs/outreach.md, decision 189;
 * src/extension-download.ts): the button's name, which both add-ons' words use, and the line beside it, with the
 * version, when that version was made on the reader's own clock, its size and where it works.
 */
import { describe, expect, it } from 'vitest';
import { SETUP_WORDS } from '../src/addons/outreach/setup';
import { SOCIALCONTENT_WORDS } from '../src/addons/socialcontent/words';
import { formatDate } from '../src/crm/format';
import {
  EXTENSION_DOWNLOAD_NAME,
  EXTENSION_DOWNLOAD_PATH,
  EXTENSION_DOWNLOAD_WORDS as W,
  extensionVersionWords,
} from '../src/extension-download';

describe('the extension’s download', () => {
  const MADE = '2026-11-22T07:00:38Z';
  const NOW = new Date('2026-11-22T15:00:00Z');

  it('is one button, named the same in Social Outreach and in Content Creator', () => {
    expect(W.download).toBe('Download HandsFreeOS Social');
    expect(SETUP_WORDS.download).toBe(W.download);
    expect(SOCIALCONTENT_WORDS.settings.getExtension).toBe(W.download);
    // What each add-on says to press is what the button says.
    expect(SOCIALCONTENT_WORDS.activity.readerNever('Dana')).toContain(`(${W.download} is in`);
    expect(SOCIALCONTENT_WORDS.phone.extensionOnComputer).toContain(`press ${W.download}.`);
    expect(EXTENSION_DOWNLOAD_PATH.endsWith(`/${EXTENSION_DOWNLOAD_NAME}`)).toBe(true);
  });

  it('says its version, when it was last updated on the reader’s own clock, its size and where it works', () => {
    const about = W.about('0.151.0', MADE, 547_000, NOW);
    expect(about).toBe(
      `Version 0.151.0 · Updated ${formatDate(MADE, { time: true }, NOW)} · 0.5 MB · for Chrome on a computer`,
    );
    // The day and the time of day, whichever zone this runs in; the year only in another one.
    expect(about).toMatch(/ · Updated Nov 2[12], \d{1,2}:\d\d (AM|PM) · /);
    expect(W.about('0.151.0', MADE, null, new Date('2027-01-05T15:00:00Z'))).toMatch(
      / · Updated Nov 2[12], 2026, \d{1,2}:\d\d (AM|PM) · for Chrome/,
    );
    expect(about.startsWith(extensionVersionWords('0.151.0'))).toBe(true);
  });

  it('leaves out what it isn’t told: the time before the page is in the browser, and the size', () => {
    expect(W.about('0.151.0', null, 547_000, NOW)).toBe(
      'Version 0.151.0 · 0.5 MB · for Chrome on a computer',
    );
    expect(W.about('0.151.0', '', null, NOW)).toBe('Version 0.151.0 · for Chrome on a computer');
    expect(W.about('0.151.0', 'not a date', null, NOW)).toBe(
      'Version 0.151.0 · for Chrome on a computer',
    );
  });
});
