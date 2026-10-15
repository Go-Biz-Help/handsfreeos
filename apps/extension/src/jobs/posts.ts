/**
 * **Find posts** (docs/outreach.md, decision 18): it goes through the groups the person is in that are marked Work
 * these (or Maybe, when none are), scrolling each one's feed slowly, a screen at a time (src/networks/facebook/browse.ts), and
 * sends the posts that say a playbook's signs or ask for help to HandsFreeOS, where the AI checks each one. The good
 * ones go on Today's list with comment drafts. Nothing is pressed or written on Facebook.
 *
 * **The look at the newest posts** (decision 49): every hour or two in the working hours, the runner (../auto/run.ts)
 * opens the same groups sorted by new posts and reads the top of each, so a post asking for what the business offers
 * reaches the person within the hour; the AI calls it strong, their phone hears at once, and it tops Today.
 */
import { WATCH_SCREENS } from '@hfos/core/addons/outreach/posts';
import { groupsToWork as pickGroups } from '@hfos/core/addons/outreach/results';
import type { ReadResult } from '../networks/facebook/types';
import type { GroupsList } from '../hfos/messages';
import { counted } from '../words';
import { pause, paced, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';

/** The most groups one Find posts goes through, and screens it scrolls in each. */
export const RUN_GROUPS = 5;
export const FEED_SCROLLS = 8;
/** Between screens, and between groups: a steady pace like a person reading. */
const PACE_MS = [6_000, 12_000] as const;
const GROUP_PACE_MS = [15_000, 30_000] as const;

export type WorkGroup = GroupsList['groups'][number];

/**
 * The groups the person is in, marked Work these, else Maybe, as HandsFreeOS has them: most of them the ones whose
 * people wrote back and booked demos, and the rest others, so a new group gets its chance
 * (@hfos/core/addons/outreach/results); or why there are none, in words for the person.
 */
export async function groupsToWork(job: Job, most: number): Promise<WorkGroup[] | string> {
  const [work, maybe] = await Promise.all(
    (['work', 'maybe'] as const).map(
      async (view) =>
        valueOf(
          await job.hfos({ type: 'hfos-groups', input: { workspaceId: job.businessId, view } }),
        ).groups,
    ),
  );
  const these = pickGroups(work!, maybe!, most);
  return these.length
    ? these
    : 'You’re not in any of the groups marked Work these or Maybe yet. Join one on Facebook, then ask for Save your groups on the Groups tab in HandsFreeOS.';
}

/**
 * Goes through the groups' feeds, sending each screen's posts with `send`, which says how many went to the AI to
 * check.
 */
export async function findPosts(
  job: Job,
  groups: readonly Pick<WorkGroup, 'name' | 'url'>[],
  send: (page: ReadResult) => Promise<number>,
): Promise<JobEnd> {
  let checking = 0;
  let looked = 0;
  for (const [g, group] of groups.entries()) {
    if (job.stopped()) break;
    const name = group.name ?? 'your group';
    job.progress(`Opening ${name}… ${counted(checking, 'post')} sent to check so far.`);
    await job.tab.open(group.url);
    for (let screen = 0; screen < FEED_SCROLLS && !job.stopped(); screen++) {
      const page = await readIn(job.tab);
      const warned = await warnedOn(job, page);
      if (warned) return warned;
      checking += await send(page);
      job.progress(`Reading ${name}… ${counted(checking, 'post')} sent to check so far.`);
      const moved = await job.tab.ask({ type: 'hfos-scroll-feed' });
      if (!moved.ok) break;
      await pause(paced(PACE_MS));
    }
    looked++;
    if (!job.stopped() && g < groups.length - 1) await pause(paced(GROUP_PACE_MS));
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Looked through ${counted(looked, 'group')}: ${counted(checking, 'post')} sent for the AI to check. The good ones go on your list for today.`,
    warned: false,
  };
}

/** A group's feed with the newest posts first, as Facebook's own New posts sort opens it. */
export function newestUrl(url: string): string {
  const address = new URL(url);
  address.searchParams.set('sorting_setting', 'CHRONOLOGICAL');
  return address.toString();
}

/**
 * Looks at the newest posts at the top of each group, a screen or two, and sends them with `send` (found as
 * `watch`): quick, so it fits between the day's steps.
 */
export async function watchPosts(
  job: Job,
  groups: readonly Pick<WorkGroup, 'name' | 'url'>[],
  send: (page: ReadResult) => Promise<number>,
): Promise<JobEnd> {
  let checking = 0;
  let looked = 0;
  for (const [g, group] of groups.entries()) {
    if (job.stopped()) break;
    job.progress(`Looking at the newest posts in ${group.name ?? 'your group'}…`);
    await job.tab.open(newestUrl(group.url));
    for (let screen = 0; screen < WATCH_SCREENS && !job.stopped(); screen++) {
      const page = await readIn(job.tab);
      const warned = await warnedOn(job, page);
      if (warned) return warned;
      checking += await send(page);
      if (screen === WATCH_SCREENS - 1) break;
      const moved = await job.tab.ask({ type: 'hfos-scroll-feed' });
      if (!moved.ok) break;
      await pause(paced(PACE_MS));
    }
    looked++;
    if (!job.stopped() && g < groups.length - 1) await pause(paced(GROUP_PACE_MS));
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Looked at the newest posts in ${counted(looked, 'group')}: ${counted(checking, 'post')} sent for the AI to check. One asking for what you offer goes to your phone.`,
    warned: false,
  };
}
