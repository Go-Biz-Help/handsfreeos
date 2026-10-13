/**
 * Before the person's day, their own lists (docs/outreach.md, "Lists first";
 * packages/core/src/addons/outreach/lists.ts). The owner's decision (settled): **first day only**. The first time,
 * Start my day waits until their friends list, the friend requests they've got, the ones they've sent and their groups
 * are each saved to their end, and their groups checked (decision 48); nothing else runs till then, and a step that
 * went wrong is tried again in a few minutes. After that, the requests are saved again each morning before the day,
 * and the friends list and the groups once a week, and a refresh that goes wrong doesn't hold the day up. Right after
 * the groups are checked, the Tidy up suggestions are worked out (decisions 10, 12 and 17), then the friends are
 * checked for good fits once (decision 46); after that the group checks and friend checks run daily with their caps
 * (./daily.ts). The step under way is kept in the state (`beforeNow`) for the panel's live checklist.
 *
 * The runner that works on its own (./run.ts) asks `beforeDay` what's next and does it with `doBeforeDay`.
 */
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import { GROUP_CHECKS_DAILY } from '@hfos/core/addons/outreach/group-checks';
import {
  afterFirstSave,
  atKey,
  firstSaveDone,
  LIST_DOING,
  LIST_NAMES,
  listsDue,
  type ListMark,
  type ListSave,
  type ListsSaved,
} from '@hfos/core/addons/outreach/lists';
import { checkFriends } from '../jobs/checks';
import { saveGroups } from '../jobs/groups';
import { checkGroups } from '../jobs/groups-check';
import { valueOf, type Job, type JobEnd } from '../jobs/job';
import { checkRequests, checkSent, FRIENDS_SCROLLS, saveFriends } from '../jobs/people';
import { counted } from '../words';

/** What to do before the day: save a list, check the groups, work out Tidy up, or check friends once. */
export type BeforeDay =
  | { readonly do: 'save'; readonly list: ListSave; readonly first: boolean }
  | { readonly do: 'group_checks' }
  | { readonly do: 'tidy' }
  | { readonly do: 'checks' };

/** What it tried before the day today, by list: a refresh that went wrong isn't tried again till tomorrow. */
export type TriedBefore = Readonly<Partial<Record<ListMark, string>>>;

/**
 * What to do next before the day, or null when the day can go: a list due (any never saved, the requests each
 * morning, the friends list weekly), then, once the first full save is done, the tidy-up and the first check. A
 * refresh tried today already waits for tomorrow; one never saved is tried again till it's saved.
 */
export function beforeDay(
  lists: ListsSaved,
  tried: TriedBefore,
  now: number,
  timeZone: string,
): BeforeDay | null {
  const first = !firstSaveDone(lists);
  const due = listsDue(lists, now, timeZone).filter(
    (list) => tried[list] === undefined || (first && lists[atKey(list)] === null),
  );
  if (due[0]) return { do: 'save', list: due[0], first };
  const after = afterFirstSave(lists);
  // The first check of the groups holds the day like the lists do: tried again till it's done.
  return after && (after === 'group_checks' || tried[after] === undefined) ? { do: after } : null;
}

/** What it says while it does each. */
export function beforeDayDoing(step: BeforeDay): string {
  if (step.do === 'save')
    return step.first
      ? LIST_DOING[step.list]
      : LIST_DOING[step.list].replace(' first…', ' before your day…');
  return step.do === 'group_checks'
    ? 'Checking your groups first…'
    : step.do === 'tidy'
      ? 'Working out who to tidy up from your friends…'
      : 'Checking your friends for good fits…';
}

/** How it went, for the panel and the feed: "Your friends list: Saved 412 friends." */
export function beforeDayLine(step: BeforeDay, end: JobEnd): string {
  const name =
    step.do === 'save'
      ? LIST_NAMES[step.list]
      : step.do === 'group_checks'
        ? 'Check my groups'
        : step.do === 'tidy'
          ? 'Tidy up'
          : 'Check my friends';
  return `${name}: ${end.line}`;
}

/**
 * Does it: saves the list to its end and, once it got there, notes it in HandsFreeOS; or works out the Tidy up
 * suggestions, or checks friends for good fits, and notes that. A list that stopped short isn't noted: it's saved
 * again.
 */
export async function doBeforeDay(step: BeforeDay, job: Job): Promise<JobEnd> {
  const mark = async (list: ListMark) =>
    valueOf(await job.hfos({ type: 'hfos-lists-saved', workspaceId: job.businessId, list }));
  if (step.do === 'save') {
    const end =
      step.list === 'friends'
        ? await saveFriends(job)
        : step.list === 'requests'
          ? await checkRequests(job, FRIENDS_SCROLLS)
          : step.list === 'sent'
            ? await checkSent(job)
            : await saveGroups(job, null);
    // Read to its end, or as far as it reads (a very long list): noted. One the person stopped part way is saved again.
    if (!end.warned && !end.failed && (end.whole || !job.stopped())) await mark(step.list);
    return end;
  }
  if (step.do === 'group_checks') {
    const end = await checkGroups(job, GROUP_CHECKS_DAILY);
    if (!end.warned && !end.failed && !job.stopped()) await mark('group_checks');
    return end;
  }
  if (step.do === 'tidy') {
    const tidy = valueOf(await job.hfos({ type: 'hfos-tidy', workspaceId: job.businessId }));
    await mark('tidy');
    const cancel = tidy.totals.cancel_request;
    const unfriend = tidy.totals.unfriend;
    return {
      line:
        cancel || unfriend
          ? `Suggested ${counted(cancel, 'old request')} to cancel and ${counted(unfriend, 'friend')} to unfriend. Tick the ones to go under Friends → Tidy up in HandsFreeOS.`
          : 'Nobody to tidy up for now.',
      warned: false,
    };
  }
  const end = await checkFriends(job, CHECKS_PER_DAY);
  if (!end.warned && !end.failed) await mark('checks');
  return end;
}

/** What's noted when the step is done: for the live checklist, the step under way. */
export const markOf = (step: BeforeDay): ListMark => (step.do === 'save' ? step.list : step.do);
