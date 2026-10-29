/**
 * Someone with more than one business or line of work (docs/outreach.md, decision 119; the owner, 29 Oct 2026: an
 * Instagram draft named only their solar, though their page was a photographer's too): the check's line about them
 * names each, and a draft on every network mentions each naturally, never as if one were all they do.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECK_SCHEMA,
  checkSystem,
  FOUND_CHECK_SYSTEM,
  foundCheckSystem,
} from '../../src/addons/outreach/checks';
import { PLATFORMS, type Platform } from '../../src/addons/outreach/networks';
import { todayDraftSystem } from '../../src/addons/outreach/today';

const EVERY = Object.keys(PLATFORMS) as Platform[];

describe('more than one business', () => {
  it.each(EVERY)('has the check on %s name each business or line of work they show', (platform) => {
    for (const system of [checkSystem(platform), foundCheckSystem(platform)])
      expect(system).toMatch(
        /more than one business or line of work[^\n]*name each[^\n]*never only the first/,
      );
    const { about } = CHECK_SCHEMA.properties as { about: { description: string } };
    expect(about.description).toMatch(/naming each business or line of work/);
  });

  it.each(EVERY)(
    'has a draft on %s mention each, never writing as if one were all they do',
    (platform) => {
      expect(todayDraftSystem(platform)).toMatch(
        /more than one business[^\n]*never write as if one were all they do: mention each/,
      );
    },
  );

  it('keeps the found check’s rule in its own words', () => {
    expect(FOUND_CHECK_SYSTEM).toMatch(/name each \("Sells solar, and photographs weddings"\)/);
  });
});
