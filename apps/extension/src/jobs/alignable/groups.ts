/**
 * Alignable's groups (docs/outreach.md decision 92, its 10a; the plan's decision 19), once a day while the extension
 * works on its own there, with Facebook's group pipeline made network-aware: the same saves, AI group check, joins and
 * "only while my groups run low", each asked of HandsFreeOS as Alignable's (`platform: 'alignable'`).
 *
 * - **Your groups** (`my_groups`, first, decision 48): the person's own groups page read and each group saved as one
 *   they're in, before any search or join. Their town's group is one of them.
 * - **Check groups** (`group_checks`): the groups HandsFreeOS lists (theirs first), up to 4 a day, each opened for its
 *   About and its latest posts, sent for the AI's check. When none wait, it first searches Alignable's groups with
 *   today's group words, the person's town's name added unless that word's playbook works online, and saves them.
 * - **Join groups** (`join`): up to 3 good groups a day (fewer after a warning: HandsFreeOS says), only while the
 *   person lets it and the people left to reach in their groups run low, each with the group's own Join on its page.
 *   Alignable asks no questions before a join, so it never waits on the AI's answers. With none good to join, it
 *   searches, checks the best few and asks again, as Facebook's does.
 * - **Group members** (`members`): up to 3 groups they're in a day, the fewest people saved first, their town's
 *   included: each group's members page, its leaders first, saved to the group (leaders as running it: never reached,
 *   they stay partner leads), and everyone else sent as found, with the group, for the AI's found check.
 * - **Posts in your groups** (`group_posts`): the feeds of up to 5 groups they're in other than their town's (whose
 *   posts are Find posts in your town's, ./posts.ts), a few screens each, each post saved with its group for the AI's
 *   post check.
 *
 * Its addresses (their groups page, the search for groups) and every group page's reader are drawn from guessed markup
 * till the owner's next Check Alignable: a page that shows nothing says so with its outline, and the day goes on. Every
 * page opens at a person's pace, nothing is pressed but a list's own Show more and a group's own Join, and it stops on
 * any Alignable warning.
 */
import {
  GROUP_CHECKS_DAILY,
  GROUP_POST_MOST,
  GROUP_POSTS_READ,
  type JoinAnswered,
} from '@hfos/core/addons/outreach/group-checks';
import { groupsToWork as pickGroups } from '@hfos/core/addons/outreach/results';
import type { JoinsNext } from '../../hfos/messages';
import {
  alignableGroupSave,
  alignableGroupsSave,
  alignablePostsSave,
  findsSave,
  type AlignableGroupCard,
} from '../../hfos/saves';
import type { JoinStep } from '../../networks/facebook/join';
import { line } from '../../networks/facebook/lookup';
import { groupOf, type GroupCard, type Member } from '../../networks/alignable/read';
import { townOf } from '../../networks/alignable/site';
import { counted } from '../../words';
import { FOUND_CHECKED, JOIN_PACE_MS } from '../join';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import type { WorkGroup } from '../posts';
import { SEARCH_SCREENS } from './partner-search';
import { DRAWN_MS } from './posts';
import {
  ended,
  gather,
  GROUP_SEARCHES,
  MY_GROUPS,
  myTown,
  PAGE_PACE_MS,
  readAlignableIn,
  signedOutEnd,
  townPlace,
  townWords,
  type AlignablePage,
} from './read';

/** A page showing none of their groups is followed once to its own place for them, by its words. */
const MY_GROUPS_WORDS = /^(my groups|your groups|joined groups|groups you[’']ve joined)$/i;
/** Screens of each list it reads: their groups, a group's members, and a group's feed. */
const MY_GROUPS_SCREENS = 5;
const MEMBER_SCREENS = 5;
const FEED_SCREENS = 3;
/** Groups whose members it reads in a day, and whose feeds. */
export const MEMBER_GROUPS = 3;
export const POST_GROUPS = 5;
/** While Alignable draws what a Join opened. */
const SETTLE_MS = 2_000;

const groupKey = (g: GroupCard) => g.url.toLowerCase();
const memberKey = (m: Member) =>
  (m.profile.username ?? m.profile.id ?? m.profile.url).toLowerCase();
const stopped = (job: Job): JobEnd | null =>
  job.stopped() ? { line: 'Stopped.', warned: false } : null;

/** A group HandsFreeOS keeps, as the saves take it: its name in its address, its page, and its name. */
function cardOf(group: Pick<WorkGroup, 'url' | 'name' | 'members'>): AlignableGroupCard | null {
  let url: URL;
  try {
    url = new URL(group.url);
  } catch {
    return null;
  }
  const at = groupOf(url);
  return at
    ? { id: at.id, url: at.url, name: group.name, members: group.members, joined: true }
    : null;
}

// ------------------------------------------------------------------------------------------------ your groups

/** The groups a page lists that the person is in: every card but one showing its own Join, or asked and waiting. */
const theirGroups = (page: AlignablePage) => page.found.groups.filter((g) => g.joined !== false);

/** Reads the person's own groups: their page for them, as far as it shows, at their addresses in turn. */
async function openMyGroups(job: Job): Promise<GroupCard[] | JobEnd> {
  const read = async (url: string) => {
    await job.tab.open(url);
    await pause(DRAWN_MS);
    return gather(
      job,
      MY_GROUPS_SCREENS - 1,
      theirGroups,
      groupKey,
      (n) => `Reading your groups on Alignable… ${counted(n, 'group')} so far.`,
    );
  };
  for (const [i, url] of MY_GROUPS.entries()) {
    if (i > 0) await pause(paced(PAGE_PACE_MS));
    const got = await read(url);
    if (ended(got)) return got;
    if (got.items.length) return got.items;
    const own = [...got.page.links, ...got.page.places].find((l) => MY_GROUPS_WORDS.test(l.name));
    if (!own) continue;
    await pause(paced(PAGE_PACE_MS));
    const there = await read(own.url);
    if (ended(there)) return there;
    if (there.items.length) return there.items;
  }
  return [];
}

/** **Your groups:** the person's own groups, each saved as one they're in, before any search or join. */
export async function readMyGroups(job: Job): Promise<JobEnd> {
  job.progress('Opening your groups on Alignable…');
  const groups = await openMyGroups(job);
  if (ended(groups)) return groups;
  if (!groups.length) {
    await job.report?.({ note: 'Alignable didn’t show any groups of yours.', outline: true });
    return {
      line: 'Alignable didn’t show any groups of yours. Check you’re signed in to Alignable in this browser; groups found for your niche come next.',
      warned: false,
    };
  }
  const built = alignableGroupsSave(groups, job.businessId, true);
  if (!built.ok) return { line: built.why, warned: false };
  const saved = valueOf(await job.hfos({ type: 'hfos-save-groups', input: built.input })).saved;
  return { line: `Saved ${counted(saved, 'group')} of yours on Alignable.`, warned: false };
}

// ------------------------------------------------------------------------------------------------ finding groups

/**
 * Searches Alignable's groups with a playbook's group words, in the person's town unless its playbook works online,
 * and saves what it shows: how many were saved. With no town known, the words go alone and the AI's check says
 * whether each is in their area.
 */
export async function findGroups(
  job: Job,
  words: string,
  anywhere: boolean,
): Promise<number | JobEnd> {
  let town: string | null = null;
  if (!anywhere) {
    const mine = await myTown(job);
    if (mine !== null && typeof mine === 'object') return mine;
    town = mine;
  }
  const search = town ? `${words} ${townWords(town)}` : words;
  for (const [i, url] of GROUP_SEARCHES.entries()) {
    if (stopped(job)) return stopped(job)!;
    await pause(paced(PAGE_PACE_MS));
    job.progress(`Searching Alignable’s groups for “${search}”…`);
    await job.tab.open(url(search));
    const got = await gather(
      job,
      SEARCH_SCREENS - 1,
      (page) => page.found.groups,
      groupKey,
      (n) => `Searching Alignable’s groups for “${search}”… ${counted(n, 'group')} so far.`,
    );
    if (ended(got)) return got;
    if (!got.items.length) {
      if (i === GROUP_SEARCHES.length - 1)
        await job.report?.({ note: 'Alignable’s search for groups showed none.', outline: true });
      continue;
    }
    const built = alignableGroupsSave(got.items, job.businessId);
    if (!built.ok) return 0;
    return valueOf(await job.hfos({ type: 'hfos-save-groups', input: built.input })).saved;
  }
  return 0;
}

// ------------------------------------------------------------------------------------------------ checking groups

/**
 * **Check groups:** the next groups HandsFreeOS lists on Alignable (theirs first), up to `most`, each opened for its
 * About and latest posts, sent for the AI's check. With `search`, when none wait, it first finds groups with today's
 * group words and saves them.
 */
export async function checkGroupsOn(
  job: Job,
  most: number = GROUP_CHECKS_DAILY,
  search = true,
): Promise<JobEnd> {
  const next = async () =>
    valueOf(
      await job.hfos({
        type: 'hfos-groups-to-check',
        input: { workspaceId: job.businessId, platform: 'alignable', most },
      }),
    );
  job.progress('Asking HandsFreeOS which Alignable groups to check…');
  let got = await next();
  let found = 0;
  if (!got.groups.length && search) {
    const joins = await joinsNext(job);
    if (joins.words) {
      const saved = await findGroups(job, joins.words, joins.anywhere);
      if (typeof saved === 'object') return saved;
      found = saved;
      got = await next();
    }
  }
  if (!got.groups.length)
    return {
      line: got.saved
        ? 'Every Alignable group you have is checked lately. More are found when your playbooks have group words.'
        : 'No Alignable groups are saved yet, and none were found for your playbooks’ group words.',
      warned: false,
    };
  let sent = 0;
  for (const [i, group] of got.groups.entries()) {
    if (job.stopped()) break;
    if (i > 0) await pause(paced(PAGE_PACE_MS));
    job.progress(
      `${i} of ${counted(got.groups.length, 'group')} checked. Reading ${group.name ?? 'a group'}…`,
    );
    await job.tab.open(group.url);
    await pause(DRAWN_MS);
    const feed = await readAlignableIn(job.tab);
    const warned = await warnedOn(job, feed);
    if (warned) return { ...warned, line: `${warned.line} Checked ${counted(sent, 'group')}.` };
    if (feed.signedOut) return signedOutEnd();
    const posts = feed.found.threads
      .map((t) => t.text.trim())
      .filter(Boolean)
      .slice(0, GROUP_POSTS_READ)
      .map((text) => line(text, GROUP_POST_MOST));
    let about = feed.found.group?.about ?? [];
    let joined = feed.found.group?.joined ?? group.joined;
    // Its About, on a page of its own when its page didn't show it.
    if (!about.length && !job.stopped()) {
      await pause(paced(PAGE_PACE_MS));
      await job.tab.open(`${group.url.replace(/\/+$/, '')}/about`);
      const page = await readAlignableIn(job.tab);
      const warnedThere = await warnedOn(job, page);
      if (warnedThere)
        return { ...warnedThere, line: `${warnedThere.line} Checked ${counted(sent, 'group')}.` };
      about = page.found.group?.about ?? [];
      joined = page.found.group?.joined ?? joined;
    }
    if (!about.length && !posts.length)
      await job.report?.({
        note: 'Alignable’s group page showed no About and no posts.',
        outline: true,
      });
    valueOf(
      await job.hfos({
        type: 'hfos-group-look',
        input: {
          workspaceId: job.businessId,
          groupId: group.groupId,
          about: [...about],
          posts,
          joined,
        },
      }),
    );
    sent++;
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}${found ? `Found ${counted(found, 'group')} on Alignable for your niche and area. ` : ''}Checked ${counted(sent, 'group')}. The good ones are joined as your groups run low on people to reach.`,
    warned: false,
  };
}

// ------------------------------------------------------------------------------------------------ joining

async function joinsNext(job: Job): Promise<JoinsNext> {
  return valueOf(
    await job.hfos({
      type: 'hfos-joins-next',
      input: { workspaceId: job.businessId, platform: 'alignable' },
    }),
  );
}

/** How one join went: joined, asked and waiting for the group's leaders, or not, and why. */
interface Went {
  readonly state: 'asked' | 'pending' | 'joined' | 'failed';
  readonly why: string | null;
  readonly answers?: readonly JoinAnswered[];
}

/** Where the person stands with the group its page shows now: in it, asked, or neither yet. */
const stateOn = (page: AlignablePage): Went['state'] =>
  page.found.group?.joined === true ? 'joined' : page.found.group?.asked ? 'pending' : 'asked';

/** Joins one group with its own Join on its page, and how its page says it went. */
async function joinOne(
  job: Job,
  group: { readonly url: string; readonly name: string | null },
): Promise<Went | JobEnd> {
  await job.tab.open(group.url);
  const page = await readAlignableIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd();
  const shown = page.found.group;
  if (!shown) return { state: 'failed', why: 'Alignable didn’t show the group’s page.' };
  if (shown.joined === true) return { state: 'joined', why: null };
  if (shown.asked) return { state: 'pending', why: null };
  const pressed = await job.tab.ask({ type: 'hfos-join' });
  if (!pressed.ok) return { state: 'failed', why: pressed.error };
  const step = (pressed as { step: JoinStep }).step;
  switch (step.result) {
    case 'none':
      return { state: 'failed', why: 'Alignable didn’t show Join on the group’s page.' };
    case 'choices':
      return {
        state: 'failed',
        why: 'Alignable asked something before joining. Join it yourself on Alignable.',
      };
    case 'already':
      return { state: step.joined ? 'joined' : 'pending', why: null };
    case 'questions': {
      // Alignable asks none, so its tab answers that there were none to answer: nothing waits on the AI.
      const answered = await job.tab.ask({ type: 'hfos-join-answer', answers: [] });
      if (!answered.ok) return { state: 'failed', why: answered.error };
      if ((answered as { result: string }).result === 'not_sent')
        return { state: 'failed', why: 'Alignable didn’t take the join. Join it yourself.' };
      break;
    }
    case 'asked':
      break;
  }
  // A Join may open another page: the group's own page again says how it went.
  await pause(SETTLE_MS);
  await job.tab.open(group.url);
  const after = await readAlignableIn(job.tab);
  const warnedAfter = await warnedOn(job, after);
  if (warnedAfter) return warnedAfter;
  return { state: stateOn(after), why: null };
}

/**
 * **Join groups:** up to today's room of good Alignable groups, only while the person lets it and the people left to
 * reach in their groups run low. With none good to join, it finds groups with today's group words, checks the best few,
 * and asks again.
 */
export async function joinGroupsOn(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which Alignable groups to join…');
  let got = await joinsNext(job);
  if (!got.onItsOwn)
    return {
      line: 'Joining groups on its own is off in your Alignable settings.',
      warned: false,
    };
  if (!got.prospects.low)
    return {
      line: `Your Alignable groups have ${counted(got.prospects.left, 'person', 'people')} left to reach: no need to join more yet.`,
      warned: false,
    };
  if (got.today >= got.perDay)
    return {
      line: `That’s today’s ${got.perDay.toLocaleString()} groups joined on Alignable. It carries on tomorrow.`,
      warned: false,
    };
  if (!got.groups.length && got.words) {
    const found = await findGroups(job, got.words, got.anywhere);
    if (typeof found === 'object') return found;
    if (stopped(job)) return stopped(job)!;
    const checked = await checkGroupsOn(job, FOUND_CHECKED, false);
    if (checked.warned) return checked;
    got = await joinsNext(job);
  }
  if (!got.groups.length)
    return {
      line: 'No good Alignable groups to join yet: the AI checks the groups found for your niche and area first.',
      warned: false,
    };
  const done: Record<Went['state'], number> = { asked: 0, pending: 0, joined: 0, failed: 0 };
  const why: string[] = [];
  for (const [i, group] of got.groups.entries()) {
    if (job.stopped()) break;
    if (i > 0) await pause(paced(JOIN_PACE_MS));
    job.progress(
      `${i + 1} of ${got.groups.length}: joining ${group.name ?? 'a group'} on Alignable…`,
    );
    let went: Went | JobEnd;
    try {
      went = await joinOne(job, group);
    } catch (error) {
      went = { state: 'failed', why: error instanceof Error ? error.message : String(error) };
    }
    if ('line' in went) return went;
    valueOf(
      await job.hfos({
        type: 'hfos-join-note',
        input: {
          workspaceId: job.businessId,
          groupId: group.groupId,
          state: went.state,
          answers: [...(went.answers ?? [])],
          why: went.state === 'failed' ? (went.why ?? 'Alignable didn’t take it.') : null,
        },
      }),
    );
    if (went.state === 'failed' && went.why) why.push(`${group.name ?? 'A group'}: ${went.why}`);
    done[went.state]++;
  }
  const parts = [
    done.joined ? `Joined ${counted(done.joined, 'group')} on Alignable.` : null,
    done.pending || done.asked
      ? `Asked to join ${counted(done.pending + done.asked, 'group')}: ${done.pending + done.asked === 1 ? 'its' : 'their'} leaders say yes or no.`
      : null,
    done.failed ? `Couldn’t join ${counted(done.failed, 'group')}. ${why.join(' ')}` : null,
  ].filter(Boolean);
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}${parts.join(' ') || 'Nothing joined.'}`,
    warned: false,
    failed: done.joined + done.pending + done.asked === 0,
  };
}

// ------------------------------------------------------------------------------------------------ members and posts

/** The Alignable groups the person is in, marked Work these, else Maybe, as HandsFreeOS picks them. */
async function groupsToWorkOn(job: Job, most: number): Promise<WorkGroup[]> {
  const [work, maybe] = await Promise.all(
    (['work', 'maybe'] as const).map(
      async (view) =>
        valueOf(
          await job.hfos({
            type: 'hfos-groups',
            input: { workspaceId: job.businessId, platform: 'alignable', view },
          }),
        ).groups,
    ),
  );
  return pickGroups(work!, maybe!, most);
}

const NO_GROUPS = {
  line: 'You’re not in any Alignable group marked Work these or Maybe yet: your groups are read first, then checked.',
  warned: false,
} as const;

/** Where a member's business is, as a place: its town. */
const placeOf = (m: Member) => {
  const town = townOf(m.profile.url);
  return town ? townPlace(town) : null;
};

/**
 * **Group members:** up to 3 Alignable groups the person is in, the fewest people saved first, their town's included.
 * Each group's members page is read a few screens: its leaders first, saved to the group as running it (never
 * reached: they stay partner leads), then everyone else, saved to the group and sent as found, with the group, for the
 * AI's found check. HandsFreeOS reaches a group's members only once its leaders were read, or a week after joining.
 */
export async function readMembers(job: Job): Promise<JobEnd> {
  const groups = (await groupsToWorkOn(job, POST_GROUPS))
    .sort((a, b) => a.people - b.people)
    .slice(0, MEMBER_GROUPS);
  if (!groups.length) return NO_GROUPS;
  let saved = 0;
  let added = 0;
  let looked = 0;
  for (const [g, group] of groups.entries()) {
    if (job.stopped()) break;
    const card = cardOf(group);
    if (!card) continue;
    if (g > 0) await pause(paced(PAGE_PACE_MS));
    const name = group.name ?? 'your group';
    job.progress(`Opening ${name}’s members…`);
    await job.tab.open(`${card.url}/members`);
    await pause(DRAWN_MS);
    const got = await gather(
      job,
      MEMBER_SCREENS - 1,
      (page) => page.found.members,
      memberKey,
      (n) =>
        `Reading ${name}’s members, leaders first… ${counted(n, 'business', 'businesses')} so far.`,
    );
    if (ended(got)) return got;
    looked++;
    const shown = got.page.found.group;
    const leaders = got.items.filter((m) => m.leader);
    const others = got.items.filter((m) => !m.leader);
    if (!got.items.length) {
      await job.report?.({ note: 'Alignable showed no members of a group.', outline: true });
      continue;
    }
    const facts = {
      ...card,
      name: card.name ?? shown?.name ?? null,
      members: shown?.members ?? card.members,
    };
    const built = alignableGroupSave(
      facts,
      [...leaders, ...others].map((m) => ({
        name: m.name,
        profile: m.profile,
        lines: [m.business, ...m.lines].filter((l): l is string => !!l),
        leader: m.leader,
      })),
      job.businessId,
      // Its leaders are read once they were, or the page showed none: then its members may be reached.
      leaders.length > 0 || shown?.leaders !== true,
    );
    if (built.ok)
      for (const input of built.input)
        saved += valueOf(await job.hfos({ type: 'hfos-save-group', input })).people;
    if (!others.length) continue;
    const found = findsSave(
      others.map((m) => ({
        name: m.name,
        profile: m.profile,
        lines: [m.business, ...m.lines].filter((l): l is string => !!l),
        place: placeOf(m),
      })),
      'member',
      'alignable',
      job.businessId,
      { group: facts },
    );
    if (found.ok)
      for (const input of found.input)
        added += valueOf(await job.hfos({ type: 'hfos-finds-save', input })).added;
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Saved ${counted(saved, 'business', 'businesses')} from ${counted(looked, 'Alignable group')}, ${added.toLocaleString()} new to check. Group leaders are kept as partner leads, never reached.`,
    warned: false,
  };
}

/**
 * **Posts in your groups:** the feeds of up to 5 Alignable groups the person is in, other than their town's (whose
 * posts Find posts in your town reads), a few screens each, each post saved with its group for the AI's post check.
 */
export async function readGroupPosts(job: Job): Promise<JobEnd> {
  const town = await myTown(job);
  if (town !== null && typeof town === 'object') return town;
  const groups = (await groupsToWorkOn(job, POST_GROUPS + 1))
    .filter((g) => cardOf(g) !== null && cardOf(g)!.id.toLowerCase() !== town)
    .slice(0, POST_GROUPS);
  if (!groups.length) return NO_GROUPS;
  let checking = 0;
  let read = 0;
  let looked = 0;
  for (const group of groups) {
    if (job.stopped()) break;
    const card = cardOf(group)!;
    await pause(paced(PAGE_PACE_MS));
    const name = group.name ?? 'your group';
    job.progress(`Opening ${name}… ${counted(checking, 'post')} sent to check so far.`);
    await job.tab.open(card.url);
    await pause(DRAWN_MS);
    const got = await gather(
      job,
      FEED_SCREENS - 1,
      (page) => page.found.threads,
      (t) => t.url ?? t.text,
      (n) => `Reading ${name}’s posts… ${counted(n, 'post')} so far.`,
    );
    if (ended(got)) return got;
    looked++;
    read += got.items.length;
    if (!got.items.length) {
      await job.report?.({ note: 'Alignable showed no posts in a group.', outline: true });
      continue;
    }
    const built = alignablePostsSave(got.items, job.businessId, card);
    if (!built.ok) continue;
    checking += valueOf(await job.hfos({ type: 'hfos-save-posts', input: built.input })).checking;
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Read ${counted(read, 'post')} in ${counted(looked, 'Alignable group')}: ${counted(checking, 'post')} sent for the AI to check. The good ones go on your list for today.`,
    warned: false,
  };
}
