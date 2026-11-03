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
 *
 * Each network has its own lists and its own first day (packages/core/src/addons/outreach/lists.ts, `LIST_SAVES_ON`):
 * LinkedIn's runner (./linkedin.ts) saves the person's connections, then the invitations they've got and the ones
 * they've sent, each to its end, then works out which old invitations to withdraw and checks their connections for
 * good fits once, by the same steps with LinkedIn's jobs (../jobs/linkedin/). Alignable's (./alignable.ts) saves their
 * connections and the connection requests they've got, then checks their connections once, with its asks' jobs
 * (../jobs/alignable/): no reader of the requests they've sent is built, so there's nothing to tidy up first.
 * Instagram's (./instagram.ts) saves their newest followers (the newest 200 the first time, then those new since: the
 * owner, 21 Oct 2026), works out who to unfollow (those who didn't follow back in the business's wait, for the person
 * to tick), then checks their followers once (../jobs/instagram/).
 */
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import { GROUP_CHECKS_DAILY } from '@hfos/core/addons/outreach/group-checks';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
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
import { checkConnections as checkAlignableConnections } from '../jobs/alignable/checks';
import {
  checkRequests as saveAlignableRequests,
  saveConnections as saveAlignableConnections,
} from '../jobs/alignable/people';
import { checkFriends } from '../jobs/checks';
import { checkFollowers } from '../jobs/instagram/checks';
import { saveFollowers } from '../jobs/instagram/people';
import { saveGroups } from '../jobs/groups';
import { checkGroups } from '../jobs/groups-check';
import { valueOf, type Job, type JobEnd } from '../jobs/job';
import { checkConnections } from '../jobs/linkedin/checks';
import { saveConnections, saveInvitations } from '../jobs/linkedin/people';
import { checkRequests, checkSent, FRIENDS_SCROLLS, saveFriends } from '../jobs/people';
import { counted } from '../words';

/** Each network's way of doing each step before its day: its jobs, and its words. */
interface ListsOn {
  readonly save: Readonly<Partial<Record<ListSave, (job: Job) => Promise<JobEnd>>>>;
  readonly doing: Readonly<Partial<Record<ListSave, string>>>;
  readonly names: Readonly<Partial<Record<ListSave, string>>>;
  readonly checks: (job: Job) => Promise<JobEnd>;
  readonly checking: string;
  readonly checkName: string;
  readonly tidying: string;
  readonly tidied: (cancel: number, unfriend: number) => string;
}

const LISTS_ON: Readonly<Record<Platform, ListsOn>> = {
  facebook: {
    save: {
      friends: saveFriends,
      requests: (job) => checkRequests(job, FRIENDS_SCROLLS),
      sent: checkSent,
      groups: (job) => saveGroups(job, null),
    },
    doing: LIST_DOING,
    names: LIST_NAMES,
    checks: (job) => checkFriends(job, CHECKS_PER_DAY),
    checking: 'Checking your friends for good fits…',
    checkName: 'Check my friends',
    tidying: 'Working out who to tidy up from your friends…',
    tidied: (cancel, unfriend) =>
      cancel || unfriend
        ? `Suggested ${counted(cancel, 'old request')} to cancel and ${counted(unfriend, 'friend')} to unfriend. Tick the ones to go under Friends → Tidy up in HandsFreeOS.`
        : 'Nobody to tidy up for now.',
  },
  linkedin: {
    save: {
      friends: saveConnections,
      requests: (job) => saveInvitations(job, 'received'),
      sent: (job) => saveInvitations(job, 'sent'),
    },
    doing: {
      friends: 'Saving your LinkedIn connections first…',
      requests: 'Saving the invitations you’ve got on LinkedIn first…',
      sent: 'Saving the invitations you’ve sent on LinkedIn first…',
    },
    names: {
      friends: 'Your connections',
      requests: 'Invitations you’ve got',
      sent: 'Invitations you’ve sent',
    },
    checks: (job) => checkConnections(job, CHECKS_PER_DAY),
    checking: 'Checking your connections for good fits…',
    checkName: 'Check my connections',
    tidying: 'Working out which old invitations to withdraw…',
    tidied: (cancel) =>
      cancel
        ? `Suggested ${counted(cancel, 'old invitation')} to withdraw. Tick the ones to go under Friends → Tidy up in HandsFreeOS, on LinkedIn.`
        : 'No old invitations to withdraw for now.',
  },
  // Its runner (part 14): its newest followers, then who to unfollow worked out, then one check of the followers, at
  // its own day's count. A follow-back is its accepting, so the followers new since are read each day, and the accounts
  // the person followed are looked at for who follows back (./instagram.ts).
  instagram: {
    save: { friends: (job) => saveFollowers(job) },
    doing: { friends: 'Saving your newest Instagram followers first…' },
    names: { friends: 'Your newest followers' },
    checks: (job) => checkFollowers(job, NETWORKS.instagram.checksPerDay),
    checking: 'Checking your followers for good fits…',
    checkName: 'Check my followers',
    tidying: 'Working out who to unfollow on Instagram…',
    tidied: (cancel) =>
      cancel
        ? `Suggested ${counted(cancel, 'person', 'people')} to unfollow who didn’t follow you back. Tick the ones to go under Friends → Tidy up in HandsFreeOS, on Instagram.`
        : 'Nobody to unfollow for now.',
  },
  // Its runner (part 5): its connections and the requests they've got, then one check of the connections, at its own
  // day's count. No reader of the requests they've sent is built, so it has nothing to tidy up first.
  alignable: {
    save: { friends: saveAlignableConnections, requests: saveAlignableRequests },
    doing: {
      friends: 'Saving your Alignable connections first…',
      requests: 'Saving the connection requests you’ve got on Alignable first…',
    },
    names: { friends: 'Your connections', requests: 'Connection requests you’ve got' },
    checks: (job) => checkAlignableConnections(job, NETWORKS.alignable.checksPerDay),
    checking: 'Checking your connections for good fits…',
    checkName: 'Check my connections',
    tidying: 'Old connection requests on Alignable are yours to withdraw.',
    tidied: () => 'Old connection requests on Alignable are yours to withdraw.',
  },
};

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
  platform: Platform = 'facebook',
): BeforeDay | null {
  const first = !firstSaveDone(lists, platform);
  const due = listsDue(lists, now, timeZone, platform).filter(
    (list) => tried[list] === undefined || (first && lists[atKey(list)] === null),
  );
  if (due[0]) return { do: 'save', list: due[0], first };
  const after = afterFirstSave(lists, platform);
  // The first check of the groups holds the day like the lists do: tried again till it's done.
  return after && (after === 'group_checks' || tried[after] === undefined) ? { do: after } : null;
}

/**
 * Whether what's due before the day holds the whole day: the first full save of the person's lists, and the first
 * check of their groups, as the list can't be worked out without them. Anything else before the day takes turns with
 * the list (decision 123).
 */
export const holdsTheDay = (step: BeforeDay | null): boolean =>
  step !== null && ((step.do === 'save' && step.first) || step.do === 'group_checks');

/** What it says while it does each, on its network (Facebook's unless said). */
export function beforeDayDoing(step: BeforeDay, platform: Platform = 'facebook'): string {
  const on = LISTS_ON[platform];
  if (step.do === 'save') {
    const doing = on.doing[step.list] ?? LIST_DOING[step.list];
    return step.first ? doing : doing.replace(' first…', ' before your day…');
  }
  return step.do === 'group_checks'
    ? 'Checking your groups first…'
    : step.do === 'tidy'
      ? on.tidying
      : on.checking;
}

/** How it went, for the panel and the feed: "Your friends list: Saved 412 friends." */
export function beforeDayLine(
  step: BeforeDay,
  end: JobEnd,
  platform: Platform = 'facebook',
): string {
  const on = LISTS_ON[platform];
  const name =
    step.do === 'save'
      ? (on.names[step.list] ?? LIST_NAMES[step.list])
      : step.do === 'group_checks'
        ? 'Check my groups'
        : step.do === 'tidy'
          ? 'Tidy up'
          : on.checkName;
  return `${name}: ${end.line}`;
}

/**
 * Does it: saves the list to its end and, once it got there, notes it in HandsFreeOS; or works out the Tidy up
 * suggestions, or checks friends for good fits, and notes that. A list that stopped short isn't noted: it's saved
 * again.
 */
export async function doBeforeDay(
  step: BeforeDay,
  job: Job,
  platform: Platform = 'facebook',
): Promise<JobEnd> {
  const on = LISTS_ON[platform];
  const mark = async (list: ListMark) =>
    valueOf(
      await job.hfos({ type: 'hfos-lists-saved', workspaceId: job.businessId, list, platform }),
    );
  if (step.do === 'save') {
    const save = on.save[step.list];
    if (!save) return { line: 'Nothing to save on this network.', warned: false, failed: true };
    const end = await save(job);
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
    const tidy = valueOf(
      await job.hfos({ type: 'hfos-tidy', workspaceId: job.businessId, platform }),
    );
    await mark('tidy');
    return {
      line: on.tidied(tidy.totals.cancel_request, tidy.totals.unfriend),
      warned: false,
    };
  }
  const end = await on.checks(job);
  if (!end.warned && !end.failed) await mark('checks');
  return end;
}

/** What's noted when the step is done: for the live checklist, the step under way. */
export const markOf = (step: BeforeDay): ListMark => (step.do === 'save' ? step.list : step.do);
