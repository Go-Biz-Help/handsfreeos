/**
 * What a look-up before a draft reads off a page (docs/outreach.md, decision 21), as lines for the AI: what someone's
 * profile or business page says about itself, and its latest posts, cut short. The look-up asked from Today in
 * HandsFreeOS (src/jobs/lookup.ts) and the runner's, before a message it drafts on its own (src/auto/run.ts), both
 * use it.
 */
import { LOOKUP_LINE_MOST } from '@hfos/core/addons/outreach/today';
import type { Named, ReadResult } from './types';

/** What's read from their latest posts, and the business's: a couple each, cut short. */
export const POSTS_READ = 2;
const POST_LINE_MOST = 240;

export const line = (text: string, most = LOOKUP_LINE_MOST) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= most ? one : `${one.slice(0, most - 1)}…`;
};

/** What a profile or page read says, as lines for the AI: what it says about itself, and its latest posts. */
export function linesOf(read: ReadResult, label: string | null, posts: number): string[] {
  const intro = read.profile?.intro ?? [];
  const latest = (read.posts ?? [])
    .filter((post) => post.text.trim())
    .slice(0, posts)
    .map((post) => `${label ?? 'They'} posted: ${line(post.text, POST_LINE_MOST)}`);
  return [...intro.map((l) => line(label ? `${label}: ${l}` : l)), ...latest];
}

/** Words on a profile's line that say the page linked from it is theirs: "Owner at Smith Plumbing". */
const OWNS =
  /\b(owner|co-?owner|founder|co-?founder|ceo|proprietor|self[- ]employed|owns|my (own )?business)\b/i;

/**
 * Whether the page a profile links to is their own business: only when the line naming it says so. "Data Analyst at
 * Consultmyapp", or a Work entry with just the name, is where they work, not theirs.
 */
export function ownsPage(read: ReadResult, page: Named): boolean {
  return (read.profile?.intro ?? []).some((l) => l.includes(page.name) && OWNS.test(l));
}

/** The line that heads what the page says, for the AI: their business, or where they work. */
export function pageHeading(read: ReadResult, page: Named): string {
  return ownsPage(read, page)
    ? `Their business page: ${line(page.name)}`
    : `Where they work, a job and not their own business: ${line(page.name)}`;
}
