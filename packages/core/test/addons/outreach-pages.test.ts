/**
 * Social Outreach's pages (docs/outreach.md, decision 127): the side menu's pop-out on the web and the phone's first
 * screen read the same list, in the same order, from core's `pages.ts`.
 */
import { describe, expect, it } from 'vitest';
import { manifestIssues } from '../../src/addons/manifest';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import {
  OUTREACH_PAGE_ABOUT,
  OUTREACH_PAGE_KEYS,
  OUTREACH_PAGE_PATHS,
  OUTREACH_PAGES,
} from '../../src/addons/outreach/pages';

describe('Social Outreach’s pages', () => {
  it('are the side menu’s pages, in order, each with its own address', () => {
    const nav = outreachAddon.ui?.nav ?? [];
    expect(nav.map((n) => n.key)).toEqual([...OUTREACH_PAGE_KEYS]);
    expect(nav.map((n) => n.label)).toEqual(OUTREACH_PAGE_KEYS.map((k) => OUTREACH_PAGES[k]));
    expect(nav.map((n) => n.path)).toEqual(OUTREACH_PAGE_KEYS.map((k) => OUTREACH_PAGE_PATHS[k]));
    expect(new Set(nav.map((n) => n.path)).size).toBe(nav.length);
    // The bare address forwards old links, so it's no page of its own.
    expect(nav.map((n): string => n.path)).not.toContain('');
    expect(manifestIssues(outreachAddon)).toEqual([]);
  });

  it('starts with Needs you, keeps Settings out of Settings search, and says what each is for', () => {
    expect(OUTREACH_PAGE_KEYS[0]).toBe('needs-you');
    expect(OUTREACH_PAGE_KEYS).not.toContain('settings');
    expect(OUTREACH_PAGES.gear).toBe('Settings');
    for (const k of OUTREACH_PAGE_KEYS) {
      expect(OUTREACH_PAGE_ABOUT[k].length).toBeGreaterThan(10);
      expect(OUTREACH_PAGE_ABOUT[k]).not.toMatch(/'/);
    }
  });
});
