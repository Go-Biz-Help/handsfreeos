/**
 * Looking someone up before the AI drafts to them (docs/outreach.md, decision 21): the extension opens their profile
 * itself, out of view, reads what it says about them and their latest posts, follows a link from it to the business
 * they own or work at and reads that page too, then closes the tab. What it read goes with the ask for drafts, so
 * they can mention only what's really there. Nothing is pressed or kept on Facebook, and nothing is saved: the lines
 * go to the AI for this draft alone.
 *
 * It stops when Facebook shows a warning (decision 25), and isn't done at all on a day it already has.
 */
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import { line, linesOf, POSTS_READ } from '../facebook/lookup';
import type { ReadResult } from '../facebook/types';
import { WorkTab } from '../tab';
import { noteWarnings, warnedToday } from './warnings';

/** A look-up kept for this long, so Draft again doesn't open their profile again. */
const KEPT_MS = 30 * 60_000;

const kept = new Map<string, { readonly at: number; readonly lines: readonly string[] }>();

async function readIn(tab: WorkTab, url: string): Promise<ReadResult | null> {
  await tab.open(url);
  const answer = await tab.ask({ type: 'hfos-read' });
  return answer.ok ? answer.result : null;
}

/**
 * What their profile and business page say, as lines for the AI's drafts. Empty when it couldn't look, which still
 * lets the drafts be written from what HandsFreeOS knows. Never throws.
 */
export async function lookUp(profileUrl: string | null): Promise<string[]> {
  if (!profileUrl?.startsWith('https://www.facebook.com/')) return [];
  const had = kept.get(profileUrl);
  if (had && Date.now() - had.at < KEPT_MS) return [...had.lines];
  if (await warnedToday()) return [];
  const tab = new WorkTab('quiet');
  const lines: string[] = [];
  try {
    const profile = await readIn(tab, profileUrl);
    if (!profile) return [];
    if (profile.warnings.length) {
      await noteWarnings(profile.warnings, profile.url);
      return [];
    }
    lines.push(...linesOf(profile, null, POSTS_READ));
    const business = profile.pages?.[0];
    if (business?.profile) {
      const page = await readIn(tab, business.profile.url);
      if (page?.warnings.length) await noteWarnings(page.warnings, page.url);
      else if (page)
        lines.push(
          `Their business page: ${line(business.name)}`,
          ...linesOf(page, business.name, 1),
        );
    }
  } catch {
    // The tab was closed, or Facebook went elsewhere: draft from what's known.
  } finally {
    await tab.close();
  }
  const done = [...new Set(lines.filter(Boolean))].slice(0, LOOKUP_LINES);
  kept.set(profileUrl, { at: Date.now(), lines: done });
  return done;
}
