/**
 * Checking groups for the business's people (docs/outreach.md, decision 48), asked from the Groups tab in HandsFreeOS
 * (**Check my groups**) and done once a day while the extension works on its own (src/auto/daily.ts). HandsFreeOS says
 * which groups (the person's own first, then groups found that fit by name); for each, the extension reads the first
 * screen of its posts, then its About tab (what it's for, and its rules), and sends those for the AI. Nothing is
 * pressed on Facebook. It goes at a person's pace and stops for the day on any Facebook warning.
 */
import { GROUP_POST_MOST, GROUP_POSTS_READ } from '@hfos/core/addons/outreach/group-checks';
import { line } from '../facebook/lookup';
import { counted } from '../words';
import { paced, pause, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';

/** Between groups, a person's pace. */
const PACE_MS = [8_000, 16_000] as const;

/** A group's About tab, from its link: https://www.facebook.com/groups/<group>/about/. */
export const aboutUrl = (url: string) => `${url.replace(/\/+$/, '')}/about/`;

/** Checks the next groups HandsFreeOS lists, up to `most`. */
export async function checkGroups(job: Job, most: number): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which groups to check…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-groups-to-check',
      input: { workspaceId: job.businessId, most },
    }),
  );
  if (!next.groups.length)
    return {
      line: next.saved
        ? 'Every group you have is checked lately. Find more on the Groups tab, and there’s more to check.'
        : 'No groups are saved yet. Press Save my groups on the Groups tab first, then Check my groups.',
      warned: false,
    };
  let sent = 0;
  for (const [i, group] of next.groups.entries()) {
    if (job.stopped()) break;
    const name = group.name ?? 'a group';
    job.progress(`${i + 1} of ${next.groups.length}: reading ${name}…`);
    await job.tab.open(group.url);
    const feed = await readIn(job.tab);
    const warned = await warnedOn(job, feed);
    if (warned) return { ...warned, line: `${warned.line} Checked ${counted(sent, 'group')}.` };
    const posts = (feed.posts ?? [])
      .map((p) => p.text.trim())
      .filter(Boolean)
      .slice(0, GROUP_POSTS_READ)
      .map((text) => line(text, GROUP_POST_MOST));
    if (job.stopped()) break;
    await job.tab.open(aboutUrl(group.url));
    const about = await readIn(job.tab);
    const warnedThere = await warnedOn(job, about);
    if (warnedThere)
      return { ...warnedThere, line: `${warnedThere.line} Checked ${counted(sent, 'group')}.` };
    valueOf(
      await job.hfos({
        type: 'hfos-group-look',
        input: {
          workspaceId: job.businessId,
          groupId: group.groupId,
          about: [...(about.about?.about ?? [])],
          rules: [...(about.about?.rules ?? [])],
          posts,
          joined: about.group?.joined ?? feed.group?.joined ?? null,
        },
      }),
    );
    sent++;
    if (i < next.groups.length - 1 && !job.stopped()) await pause(paced(PACE_MS));
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Checked ${counted(sent, 'group')}. The Groups tab says which have your people once the AI has read them.`,
    warned: false,
  };
}
