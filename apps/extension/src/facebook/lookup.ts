/**
 * What a look-up before a draft reads off a page (docs/outreach.md, decision 21), as lines for the AI: what someone's
 * profile or business page says about itself, and its latest posts, cut short. The panel's look-up
 * (src/panel/lookup.ts) and the runner's, before a message it drafts on its own (src/auto/run.ts), both use it.
 */
import { LOOKUP_LINE_MOST } from '@hfos/core/addons/outreach/today';
import type { ReadResult } from './types';

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
