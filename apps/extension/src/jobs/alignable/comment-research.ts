/**
 * **Comment research** on Alignable (docs/outreach.md, decision 172: `comment_research`), read by the research's
 * shared day (../comment-research.ts). Alignable has no search, so its two searches are places: the posts in the
 * person's town's group (`town`, as Find posts in your town reads them, ./posts.ts) and in the groups they're in
 * (`groups`, as Posts in your groups does, ./groups.ts). A few screens of each, the posts not read before for this
 * research opened in turn, and the answers each shows read. Never the post writer's own answers, nor the person's.
 *
 * Nothing is pressed but a list's own Show more, and nothing is written. It goes at a person's pace and stops for the
 * day on any Alignable warning.
 */
import { readCommentsFor, type ResearchReader } from '../comment-research';
import { pause, paced, warnedOn, type Job, type JobEnd } from '../job';
import { cardOf, groupsToWorkOn, POST_GROUPS } from './groups';
import { DRAWN_MS, TOWN_SCREENS } from './posts';
import {
  ALIGNABLE,
  ended,
  mine,
  notMine,
  readAlignableIn,
  SCROLL_PACE_MS,
  signedOutEnd,
  type AlignablePage,
  type Mine,
} from './read';

/** Between one group's feed and the next. */
const GROUP_PACE_MS = [15_000, 30_000] as const;
/** Screens of a group's feed. */
const GROUP_SCREENS = 3;

/** A warning on the page, or Alignable asking them to sign in: the end of the day's reading. */
async function stopOn(job: Job, page: AlignablePage): Promise<JobEnd | null> {
  return (await warnedOn(job, page)) ?? (page.signedOut ? signedOutEnd() : null);
}

/**
 * A feed's posts' links by others, a screen at a time, added to `links` till `enough` says so or it ends; or the day's
 * end.
 */
async function feedLinks(
  job: Job,
  screens: number,
  someoneElse: (profile: { readonly url: string } | null | undefined) => boolean,
  links: string[],
  enough: () => boolean,
): Promise<JobEnd | null> {
  for (let screen = 0; ; screen++) {
    const page = await readAlignableIn(job.tab);
    const stop = await stopOn(job, page);
    if (stop) return stop;
    for (const thread of page.found.threads)
      if (thread.url && someoneElse(thread.author?.profile) && !links.includes(thread.url))
        links.push(thread.url);
    if (enough() || screen >= screens - 1 || job.stopped()) return null;
    if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) return null;
    await pause(paced(SCROLL_PACE_MS));
  }
}

/**
 * Alignable's research: the person's own profile read once a batch, for their town, and for their business, which
 * leaves their own posts and answers out.
 */
export function alignableResearch(): ResearchReader {
  let business: string | null = null;
  let known: Mine | null = null;
  return {
    platform: 'alignable',
    where: (place) => (place === 'town' ? 'your town’s posts' : 'your groups’ posts'),
    async links(job, place, most, _progress, fresh) {
      const own = known ?? (await mine(job));
      if (ended(own)) return own;
      known = own;
      business = own.business;
      const someoneElse = notMine(own.business);
      const links: string[] = [];
      const enough = () => links.filter(fresh).length >= most;
      if (place === 'town') {
        if (!own.town) return [];
        await job.tab.open(`${ALIGNABLE}/${own.town}`);
        await pause(DRAWN_MS);
        const stop = await feedLinks(job, TOWN_SCREENS, someoneElse, links, enough);
        return stop ?? links;
      }
      const groups = (await groupsToWorkOn(job, POST_GROUPS + 1))
        .filter((g) => cardOf(g) !== null && cardOf(g)!.id.toLowerCase() !== own.town)
        .slice(0, POST_GROUPS);
      for (const [i, group] of groups.entries()) {
        if (enough() || job.stopped()) break;
        if (i > 0) await pause(paced(GROUP_PACE_MS));
        await job.tab.open(cardOf(group)!.url);
        await pause(DRAWN_MS);
        const stop = await feedLinks(job, GROUP_SCREENS, someoneElse, links, enough);
        if (stop) return stop;
      }
      return links;
    },
    async comments(job, link) {
      await job.tab.open(link);
      await pause(DRAWN_MS);
      const page = await readAlignableIn(job.tab);
      const stop = await stopOn(job, page);
      if (stop) return stop;
      const shown = page.found.threads[0];
      if (!shown) return null;
      // What other businesses answered: never the post's writer, nor the person.
      const writer = shown.author?.profile?.url ?? null;
      const someoneElse = notMine(business);
      return page.found.answers
        .filter(
          (a) => someoneElse(a.author?.profile) && (!writer || a.author?.profile?.url !== writer),
        )
        .map((a) => a.text);
    },
  };
}

/** Reads the next batch of comments for the research this person started on Alignable, if they started one. */
export const readAlignableComments = (job: Job): Promise<JobEnd> =>
  readCommentsFor(job, alignableResearch());
