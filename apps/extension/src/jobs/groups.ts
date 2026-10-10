/**
 * Saving the person's groups (docs/outreach.md, decisions 8 and 43), asked from the Groups tab in HandsFreeOS: the
 * groups they're in, from Facebook's list of them, or the groups a search finds (Find groups). It opens the list, reads
 * it a screen at a time as the person would scroll it, and saves what loaded; the Groups tab then says which fit their
 * playbooks. Nothing is pressed on Facebook: no group is joined.
 */
import { GROUPS_SAVE_MOST } from '@hfos/core/addons/outreach/groups';
import type { GroupLink } from '../facebook/types';
import { groupsSave } from '../hfos/saves';
import { counted } from '../words';
import { pause, paced, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';

/** Facebook's list of the groups the person is in. */
export const YOUR_GROUPS = 'https://www.facebook.com/groups/joins/';
/** Facebook's search for groups. */
export const groupSearch = (words: string) =>
  `https://www.facebook.com/search/groups/?q=${encodeURIComponent(words)}`;
/** Screens of the list it loads, at the people lists' pace. */
export const GROUP_SCROLLS = 8;
const PACE_MS = [4_000, 9_000] as const;

/** Opens the list (the person's groups, or a search's), reads it as it scrolls, and saves the groups on it. */
export async function saveGroups(job: Job, words: string | null): Promise<JobEnd> {
  job.progress(words ? `Searching Facebook for “${words}”…` : 'Opening your groups…');
  await job.tab.open(words ? groupSearch(words) : YOUR_GROUPS);
  const groups = new Map<string, GroupLink>();
  let page = await readIn(job.tab);
  for (let screen = 0; ; screen++) {
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    for (const link of page.groups ?? []) groups.set(link.group.id.toLowerCase(), link);
    job.progress(`Reading the groups… ${counted(groups.size, 'group')} so far.`);
    if (screen >= GROUP_SCROLLS || job.stopped()) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-page' })).ok) break;
    await pause(paced(PACE_MS));
    page = await readIn(job.tab);
  }
  if (!groups.size)
    return {
      line: words
        ? `Facebook found no groups for “${words}”. Try other words.`
        : 'Facebook showed no groups. Check you’ve joined some, then ask again.',
      warned: false,
    };
  const all = [...groups.values()];
  let saved = 0;
  for (let i = 0; i < all.length; i += GROUPS_SAVE_MOST) {
    const built = groupsSave(all.slice(i, i + GROUPS_SAVE_MOST), job.businessId);
    if (!built.ok) continue;
    saved += valueOf(await job.hfos({ type: 'hfos-save-groups', input: built.input })).saved;
  }
  return {
    line: `Saved ${counted(saved, 'group')}. The Groups tab says which fit your playbooks.`,
    warned: false,
  };
}
