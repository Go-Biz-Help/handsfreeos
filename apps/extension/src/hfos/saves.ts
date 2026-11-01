/**
 * What the background sends HandsFreeOS for each step the person takes on a network and each request they answer,
 * and what the jobs save (friends and requests, groups and their members, posts, chats for the AI): the Social
 * Outreach add-on's commands (packages/core/src/addons/outreach), built from what the page showed and cut to what
 * they take. Each says its network (`platform`), and takes only links and ids of that network's shapes (core's kit,
 * `NETWORKS`): a step from a LinkedIn tab goes as LinkedIn's. The jobs' saves are Facebook's, but for LinkedIn's lists
 * and posts at the end, which its jobs save (src/jobs/linkedin/). Plain functions, so the tests check them.
 */
import {
  FRIENDS_SAVE_MOST,
  GROUP_ID,
  GROUP_SLUG,
  INTRO_LINE_MOST,
  MESSAGE_MOST,
  NAME_MOST,
  RECENT_MESSAGES,
  WHEN_MOST,
} from '@hfos/core/addons/outreach/limits';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import {
  TOUCH_COMMENT_MOST,
  TOUCH_POST_TEXT_MOST,
  TOUCH_WHY_MOST,
} from '@hfos/core/addons/outreach/activity';
import { GROUP_PEOPLE_MOST, GROUPS_SAVE_MOST } from '@hfos/core/addons/outreach/groups';
import {
  PARTNER_LEAD_LINES,
  PARTNER_LEADS_SAVE_MOST,
  PARTNER_SEARCH_WORDS_MOST,
  type PartnerSearchKind,
} from '@hfos/core/addons/outreach/partners';
import {
  FIND_LINE_MOST,
  FIND_LINES,
  FIND_PLACE_MOST,
  FIND_SAID_MOST,
  FIND_WORDS_MOST,
  FINDS_SAVE_MOST,
  type FindSaveHow,
} from '@hfos/core/addons/outreach/finds';
import { FOLLOWERS_SAVE_MOST } from '@hfos/core/addons/outreach/followers';
import { REPLY_TRIES } from '@hfos/core/addons/outreach/active';
import {
  POST_TEXT_MOST,
  POST_WORDS_MOST,
  POSTS_SAVE_MOST,
  postHoursAgo,
} from '@hfos/core/addons/outreach/posts';
import { LOOKUP_LINE_MOST } from '@hfos/core/addons/outreach/today';
import type { Answered, Reached, Step, StepGroup } from '../networks/facebook/actions';
import { asked, askedByYou, mutualFriendsIn, type FriendList } from '../networks/facebook/friends';
import { runsGroup } from '../networks/facebook/people';
import type {
  ChatPage,
  GroupLink,
  Named,
  Person,
  ProfileRef,
  ReadResult,
} from '../networks/facebook/types';
import { facebookUrl, pathParts, profileKey } from '../networks/facebook/urls';
import { parseCount } from '../networks/facebook/vocabulary';
import { facebook } from '../networks/facebook/kit';
import type {
  Person as LinkedInPerson,
  ReadResult as LinkedInRead,
} from '../networks/linkedin/types';
import { profileKey as linkedInKey } from '../networks/linkedin/urls';
import type {
  ActiveReplyInput,
  Business,
  ChatsCollectInput,
  FindsSaveInput,
  FollowersSaveInput,
  FriendNoteInput,
  FriendsSaveInput,
  GroupSaveInput,
  GroupsSaveInput,
  Me,
  PartnerLeadsInput,
  PostsSaveInput,
  TouchInput,
} from './messages';
import { instantOf } from './when';

/** At most `most` characters, ending in "…" when cut, and never cut through an emoji. */
function cut(text: string, most: number): string {
  if (text.length <= most) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(most - 2)) ? most - 2 : most - 1;
  return `${text.slice(0, end)}…`;
}

/** A line of writing on one line. */
const clip = (text: string, most: number) => cut(text.replace(/\s+/g, ' ').trim(), most);

/** A message's words keep their lines: only the ends are trimmed. */
const clipText = (text: string, most: number) => cut(text.trim(), most);

/** The network the jobs work on, and so their saves: Facebook's kit, for now. */
const JOBS: Platform = facebook.platform;

/** A profile as HandsFreeOS takes it: by its id, the name in its address, or both, each in its network's shape. */
function ref(profile: ProfileRef, platform: Platform = JOBS): TouchInput['profile'] {
  const kit = NETWORKS[platform];
  return {
    id: profile.id && kit.profileId.test(profile.id) ? profile.id : null,
    username: profile.username && kit.username.test(profile.username) ? profile.username : null,
    url: profile.url,
  };
}

/** Mutual friends as HandsFreeOS takes them. */
const mutual = (count: number | null) => (count !== null && count <= 100_000 ? count : null);

export type Built<T> =
  { readonly ok: true; readonly input: T } | { readonly ok: false; readonly why: string };

type Collected = ChatsCollectInput['chats'][number];

/**
 * The one-to-one chat on the page, for the AI to read (packages/core/src/addons/outreach/chat-collect.ts): its latest
 * messages that say whose they are, each with the moment it was sent. A message carries the last time shown above it;
 * ones above the first time shown take that one; with no time on the page at all, `listed` (when the list of chats
 * says the last message was) stands for them. Null when it isn't one to read: a group chat, or no messages or time.
 */
export function chatCollect(
  chat: ChatPage,
  now: Date,
  listed?: string | null,
  platform: Platform = JOBS,
): Collected | null {
  if (!chat.thread || !NETWORKS[platform].threadKey.test(chat.thread.id)) return null;
  const name = chat.name ? clip(chat.name, NAME_MOST) : '';
  if (!name) return null;
  // A group: more than one other person wrote.
  const senders = new Set(
    chat.messages.filter((m) => m.from === 'them' && m.sender).map((m) => m.sender!.toLowerCase()),
  );
  if (senders.size > 1) return null;
  const fallback = listed ? instantOf(listed, now) : null;
  let at: Date | null = null;
  const timed = chat.messages.flatMap((m) => {
    const text = clipText(m.text, MESSAGE_MOST);
    if (m.when) at = instantOf(m.when, now) ?? at;
    return m.from === 'unknown' || !text ? [] : [{ fromMe: m.from === 'me', text, at }];
  });
  const first = timed.find((m) => m.at)?.at ?? fallback;
  if (!first || !timed.length) return null;
  const latest = now.getTime();
  const messages = timed
    .map((m) => ({ ...m, at: new Date(Math.min((m.at ?? first).getTime(), latest)).toISOString() }))
    .slice(-RECENT_MESSAGES);
  return {
    name,
    thread: { id: chat.thread.id, encrypted: chat.thread.encrypted },
    profile: chat.profile ? ref(chat.profile, platform) : null,
    messages,
  };
}

/** An address as HandsFreeOS takes one: on its network's own pages, over https (the kit's `link`), and not too long. */
export const networkAddress = (url: string | null, platform: Platform = JOBS) =>
  url && url.length <= 500 && NETWORKS[platform].link.test(url) ? url : null;

const NOT_WHOSE = 'Couldn’t tell whose profile it was.';
const NOT_WHICH_GROUP = 'Couldn’t tell which group this is.';

/** Who a step or an answer was to, as HandsFreeOS takes them: null when the page didn't give a profile it keeps. */
function whom(
  to: Pick<Reached, 'name' | 'profile'>,
  platform: Platform = JOBS,
): Pick<TouchInput, 'profile' | 'name'> | null {
  const profile = ref(to.profile, platform);
  const name = clip(to.name, NAME_MOST);
  return (profile.id || profile.username) && networkAddress(profile.url, platform) && name
    ? { profile, name }
    : null;
}

/** A group as HandsFreeOS takes it: by its number, or by the name in its link when that's all the link showed. */
function groupRef(group: StepGroup, platform: Platform = JOBS): TouchInput['group'] {
  const id = GROUP_ID.test(group.id) ? group.id : null;
  const slug = !id && GROUP_SLUG.test(group.id) ? group.id : null;
  const url = networkAddress(group.url, platform);
  if ((!id && !slug) || !url) return null;
  const name = group.name ? clip(group.name, NAME_MOST) : '';
  return { id, slug, url, name: name || null };
}

/**
 * A step the person took on a network (Facebook unless said), to note: who it was to, the group they were found in
 * (the page's, or the one the background remembers them by), and the post or chat, cut to what HandsFreeOS takes,
 * each in that network's shapes. Never what the person wrote: only for a like or comment the extension made on its
 * own, what the post said, the AI's comment and why.
 */
export function touchSave(
  step: Step,
  workspaceId: string,
  remembered: StepGroup | null = null,
  platform: Platform = JOBS,
): Built<TouchInput> {
  const who = whom(step.to, platform);
  if (!who) return { ok: false, why: NOT_WHOSE };
  const group = step.group ?? remembered;
  return {
    ok: true,
    input: {
      workspaceId,
      platform,
      kind: step.kind,
      ...who,
      group: group ? groupRef(group, platform) : null,
      postUrl:
        step.kind === 'like' || step.kind === 'comment'
          ? networkAddress(step.postUrl, platform)
          : null,
      threadKey:
        step.kind === 'message' && step.thread && NETWORKS[platform].threadKey.test(step.thread.id)
          ? step.thread.id
          : null,
      replying: step.kind === 'message' ? step.replying : null,
      auto: step.auto === true,
      ...(step.auto === true && (step.kind === 'like' || step.kind === 'comment')
        ? {
            postText: words(step.postText, TOUCH_POST_TEXT_MOST),
            commentText:
              step.kind === 'comment' ? words(step.commentText, TOUCH_COMMENT_MOST) : null,
            why: step.kind === 'like' ? words(step.why, TOUCH_WHY_MOST) : null,
          }
        : {}),
    },
  };
}

/** Writing cut to what HandsFreeOS keeps, on one line; nothing when there's none. */
function words(text: string | null | undefined, most: number): string | null {
  return clip(text ?? '', most) || null;
}

/**
 * The person's answer to a request they got, to note: Confirm or Delete on Facebook, Accept or Ignore on LinkedIn, who
 * asked, and their mutual friends or connections.
 */
export function friendNote(
  answered: Answered,
  workspaceId: string,
  platform: Platform = JOBS,
): Built<FriendNoteInput> {
  const who = whom(answered.to, platform);
  if (!who) return { ok: false, why: NOT_WHOSE };
  return {
    ok: true,
    input: {
      workspaceId,
      platform,
      answer: answered.answer,
      ...who,
      mutualFriends: mutual(answered.mutualFriends),
      auto: answered.auto === true,
    },
  };
}

/** One of your lists on the page, and the people in it as far as it has loaded. */
export interface ListOnPage {
  readonly list: FriendList;
  readonly people: readonly Person[];
}

/**
 * Your list on the page: your friends; the friend requests you've got and haven't answered, on the requests page or
 * in the "Friend requests" part of /friends; or, after View sent requests, the ones you've sent. Null on any other
 * page, someone else's friends among them.
 */
export function listOnPage(result: ReadResult): ListOnPage | null {
  const people = result.people ?? [];
  if (result.friendList === 'friends') return { list: 'friends', people };
  if (result.kind !== 'friends') return null;
  const page = result.friendList ?? null;
  const received = people.filter((person) => asked(person, page));
  if (received.length) return { list: 'requests', people: received };
  const sent = people.filter((person) => askedByYou(person, page));
  return sent.length ? { list: 'sent', people: sent } : null;
}

/** What one of your lists is called, for "Saved 12 friend requests". */
const LIST_ITEM: Readonly<Record<FriendList, string>> = {
  friends: 'friend',
  requests: 'friend request',
  sent: 'sent request',
};
export const listItem = (list: FriendList) => LIST_ITEM[list];

/**
 * The people in one of your lists, to save, each once: in parts of FRIENDS_SAVE_MOST, which the panel sends one
 * after another. Someone without a profile link the page showed is left out.
 */
export function friendsSave(
  people: readonly Person[],
  list: FriendList,
  workspaceId: string,
): Built<FriendsSaveInput[]> {
  const seen = new Set<string>();
  const kept: FriendsSaveInput['people'] = [];
  for (const person of people) {
    if (!person.profile || seen.has(profileKey(person.profile))) continue;
    const who = whom({ name: person.name, profile: person.profile });
    if (!who) continue;
    seen.add(profileKey(person.profile));
    kept.push({ ...who, mutualFriends: mutual(mutualFriendsIn(person.details)) });
  }
  if (!kept.length)
    return {
      ok: false,
      why:
        list === 'friends'
          ? 'There are no friends on the page to save. Scroll down so Facebook shows them, then try again.'
          : `There are no ${listItem(list)}s on the page to save.`,
    };
  const parts: FriendsSaveInput[] = [];
  for (let at = 0; at < kept.length; at += FRIENDS_SAVE_MOST)
    parts.push({
      workspaceId,
      platform: JOBS,
      list,
      people: kept.slice(at, at + FRIENDS_SAVE_MOST),
    });
  return { ok: true, input: parts };
}

/**
 * The person's own followers on Facebook (decision 113), in parts to save, each follower once. The last part notes the
 * week's read done when it is (`done`): with nobody read, it's a part of none.
 */
export function followersSave(
  people: readonly Person[],
  workspaceId: string,
  done: boolean,
): FollowersSaveInput[] {
  const seen = new Set<string>();
  const kept: NonNullable<FollowersSaveInput['people']> = [];
  for (const person of people) {
    if (!person.profile || seen.has(profileKey(person.profile))) continue;
    const who = whom({ name: person.name, profile: person.profile });
    if (!who) continue;
    seen.add(profileKey(person.profile));
    kept.push(who);
  }
  const parts: FollowersSaveInput[] = [];
  for (let at = 0; at < kept.length || !parts.length; at += FOLLOWERS_SAVE_MOST) {
    const people = kept.slice(at, at + FOLLOWERS_SAVE_MOST);
    parts.push({
      workspaceId,
      platform: 'facebook',
      people,
      done: done && at + FOLLOWERS_SAVE_MOST >= kept.length,
    });
  }
  return parts;
}

/** A post in one of the person's groups that asks something (decision 114), with the group it's in. */
export interface AskedInGroup {
  readonly group: StepGroup;
  readonly url: string | null;
  readonly author: Named | null;
  readonly when: string | null;
  readonly text: string;
  readonly comments: number | null;
  readonly reactions: number | null;
}

/**
 * The posts asking something in the person's groups, to offer HandsFreeOS for the day's reply (decision 114), each once
 * and the first `REPLY_TRIES`: with nobody named, no link or no group it keeps, a post is left out.
 */
export function activeReplySave(
  asked: readonly AskedInGroup[],
  workspaceId: string,
): Built<ActiveReplyInput> {
  const seen = new Set<string>();
  const posts = asked.flatMap((p) => {
    const url = networkAddress(p.url);
    const who = p.author?.profile ? whom({ name: p.author.name, profile: p.author.profile }) : null;
    const group = groupRef(p.group);
    const text = clipText(p.text, POST_TEXT_MOST);
    if (!url || !who || !group || !text || seen.has(url)) return [];
    seen.add(url);
    return [
      {
        url,
        author: who.profile,
        name: who.name,
        when: p.when ? clip(p.when, WHEN_MOST) : null,
        text,
        comments: p.comments,
        reactions: p.reactions,
        group,
      },
    ];
  });
  if (!posts.length) return { ok: false, why: 'None of the questions there named who asked.' };
  return {
    ok: true,
    input: { workspaceId, platform: 'facebook', posts: posts.slice(0, REPLY_TRIES) },
  };
}

/** A name as HandsFreeOS matches it to customers': its spaces as one, in any case. */
export const nameKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

/** The workspaces from `account.me` the extension can save to: Social Outreach on, and the person may use it. */
export function outreachBusinesses(workspaces: Me['workspaces']): Business[] {
  return workspaces
    .filter((w) => w.addons.includes('outreach') && w.permissions.includes('outreach.use'))
    .map((w) => ({ id: w.id, name: w.name }));
}

// ------------------------------------------------------------------------------------------------- groups

/** The most lines under a person's name a group save keeps, and the longest a part of the list's name is. */
const GROUP_LINES = 4;
const PART_MOST = 100;
const DETAIL_MOST = 300;

/** What the line under a group's name says: "Public group · 12K members", "Private · 840 members". */
export function groupDetailFacts(detail: string | null): {
  readonly privacy: 'public' | 'private' | null;
  readonly members: number | null;
} {
  const privacy = detail ? /\b(public|private)\b/i.exec(detail)?.[1]?.toLowerCase() : undefined;
  const count = detail ? /([\d.,]+\s*[km]?)\s+members\b/i.exec(detail)?.[1] : undefined;
  return {
    privacy: privacy === 'public' || privacy === 'private' ? privacy : null,
    members: count ? parseCount(count) : null,
  };
}

/** Facebook's pages of the groups the person is in: /groups/joins and /groups/your_groups. */
const OWN_GROUPS_PAGES = new Set(['joins', 'your_groups']);

/** Whether the page is Facebook's list of the groups the person is in, where every group listed is one of theirs. */
export function isOwnGroupsPage(href: string): boolean {
  const url = facebookUrl(href);
  const parts = url ? pathParts(url).map((part) => part.toLowerCase()) : [];
  return parts.length === 2 && parts[0] === 'groups' && OWN_GROUPS_PAGES.has(parts[1]!);
}

/**
 * The groups a page lists (yours, or search results), to save with how much the page said about each. On the
 * person's own list (`href`, `isOwnGroupsPage`) each is saved as one they're in, so HandsFreeOS counts it as theirs;
 * anywhere else, whether they're in it is left unsaid.
 */
export function groupsSave(
  groups: readonly GroupLink[],
  workspaceId: string,
  href = '',
): Built<GroupsSaveInput> {
  const own = isOwnGroupsPage(href);
  const kept = groups.flatMap((link) => {
    const group = groupRef({ ...link.group, name: link.name });
    if (!group) return [];
    const detail = link.detail ? clip(link.detail, DETAIL_MOST) : null;
    return [{ group, detail, ...groupDetailFacts(link.detail), ...(own ? { joined: true } : {}) }];
  });
  if (!kept.length) return { ok: false, why: 'There are no groups on the page to save.' };
  return {
    ok: true,
    input: { workspaceId, platform: JOBS, groups: kept.slice(0, GROUPS_SAVE_MOST) },
  };
}

/** Whether the page is a group's full list of admins and moderators: /groups/<g>/members/admins. */
export function isAdminsPage(href: string): boolean {
  const url = facebookUrl(href);
  const parts = url ? pathParts(url).map((part) => part.toLowerCase()) : [];
  return parts[0] === 'groups' && parts[2] === 'members' && parts[3] === 'admins';
}

/**
 * The group on the page and the people its list shows, to save, in as many parts as it takes. Everyone on its
 * admins page runs it, and so does anyone the page labels Admin or Moderator: they're kept so, and never suggested.
 * Only the last part says the admins page was read, so a save that stops halfway doesn't count it.
 */
export function groupSave(result: ReadResult, workspaceId: string): Built<GroupSaveInput[]> {
  const page = result.group;
  const group = page?.group ? groupRef({ ...page.group, name: page.name }) : null;
  if (!page || !group) return { ok: false, why: NOT_WHICH_GROUP };
  const adminsPage = isAdminsPage(result.url);
  const seen = new Set<string>();
  const people = (result.people ?? []).flatMap((person: Person) => {
    if (!person.profile) return [];
    const who = whom({ name: person.name, profile: person.profile });
    const key = profileKey(person.profile);
    if (!who || seen.has(key)) return [];
    seen.add(key);
    return [
      {
        ...who,
        lines: person.details.slice(0, GROUP_LINES).map((line) => clip(line, INTRO_LINE_MOST)),
        part: person.section ? clip(person.section, PART_MOST) : null,
        runsGroup: adminsPage || runsGroup(person),
      },
    ];
  });
  const facts = {
    workspaceId,
    platform: JOBS,
    group,
    privacy: page.privacy,
    members: page.members,
    joined: page.joined,
  };
  if (!people.length) return { ok: true, input: [{ ...facts, people: [], adminsPage: false }] };
  const parts: GroupSaveInput[] = [];
  for (let at = 0; at < people.length; at += GROUP_PEOPLE_MOST)
    parts.push({ ...facts, people: people.slice(at, at + GROUP_PEOPLE_MOST), adminsPage: false });
  parts[parts.length - 1] = { ...parts[parts.length - 1]!, adminsPage };
  return { ok: true, input: parts };
}

// ------------------------------------------------------------------------------------------------- group posts

/**
 * The posts a group's feed shows, to keep the ones worth a comment (decision 18): each with who wrote it, its own
 * link and what it says, the latest first as the page shows them. A post without its author's profile, its link or
 * any words is left out: there's nothing to comment on, or nobody to note it to.
 */
export function postsSave(
  result: ReadResult,
  workspaceId: string,
  found: PostsSaveInput['found'] = 'scroll',
): Built<PostsSaveInput> {
  const page = result.group;
  const group = page?.group ? groupRef({ ...page.group, name: page.name }) : null;
  if (result.kind !== 'group' || !page || !group)
    return { ok: false, why: 'Open one of your groups to find posts in it.' };
  const seen = new Set<string>();
  const posts = (result.posts ?? []).flatMap((post) => {
    const url = networkAddress(post.url);
    const who = post.author?.profile
      ? whom({ name: post.author.name, profile: post.author.profile })
      : null;
    const text = clipText(post.text, POST_TEXT_MOST);
    if (!url || !who || !text || seen.has(url)) return [];
    seen.add(url);
    return [
      {
        url,
        author: who.profile,
        name: who.name,
        when: post.when ? clip(post.when, WHEN_MOST) : null,
        text,
        comments: post.comments,
        reactions: post.reactions,
      },
    ];
  });
  if (!posts.length) return { ok: false, why: 'There are no posts on the page to look at yet.' };
  return {
    ok: true,
    input: {
      workspaceId,
      platform: JOBS,
      group,
      posts: posts.slice(0, POSTS_SAVE_MOST),
      found,
    },
  };
}

/** The oldest post Facebook's post search shows that's kept: past a week, it's late to comment on. */
const SEARCH_POST_HOURS_MOST = 7 * 24;

/** Whether Facebook printed a post's time as past a week ago ("3w"), or as a date with its year. */
function pastAWeek(when: string | null): boolean {
  if (!when) return false;
  const hours = postHoursAgo(when);
  return hours === null ? /\b(?:19|20)\d\d\b/.test(when) : hours > SEARCH_POST_HOURS_MOST;
}

/**
 * The posts Facebook's post search shows for one of the playbooks' phrases (decision 141, from 0.121.0), to keep the
 * ones worth a comment, in no group: each with who wrote it, its own link and what it says, and the phrase it searched
 * with (`words`), so a post found with a playbook's own is worth the AI's check whatever its words say. One without
 * its author's profile, its link or any words is left out, and so is one from past a week ago.
 */
export function facebookSearchPostsSave(
  result: ReadResult,
  workspaceId: string,
  words: string,
): Built<PostsSaveInput> {
  if (result.kind !== 'search')
    return { ok: false, why: 'Open Facebook’s post search to find posts with it.' };
  const seen = new Set<string>();
  const posts = (result.posts ?? []).flatMap((post) => {
    const url = networkAddress(post.url);
    const who = post.author?.profile
      ? whom({ name: post.author.name, profile: post.author.profile })
      : null;
    const text = clipText(post.text, POST_TEXT_MOST);
    if (!url || !who || !text || seen.has(url) || pastAWeek(post.when)) return [];
    seen.add(url);
    return [
      {
        url,
        author: who.profile,
        name: who.name,
        when: post.when ? clip(post.when, WHEN_MOST) : null,
        text,
        comments: post.comments,
        reactions: post.reactions,
      },
    ];
  });
  if (!posts.length) return { ok: false, why: 'There are no posts on the page to look at yet.' };
  return {
    ok: true,
    input: {
      workspaceId,
      platform: JOBS,
      group: null,
      posts: posts.slice(0, POSTS_SAVE_MOST),
      found: 'search',
      words: foundWith(words),
    },
  };
}

// ------------------------------------------------------------------------------------------------- LinkedIn's

const LINKEDIN: Platform = 'linkedin';

/** What each of the person's LinkedIn lists is called, for "Saved 12 invitations". */
const LINKEDIN_ITEM: Readonly<Record<FriendList, string>> = {
  friends: 'connection',
  requests: 'invitation',
  sent: 'sent invitation',
};
export const linkedInItem = (list: FriendList) => LINKEDIN_ITEM[list];

/** Someone on one of the person's LinkedIn lists: as a page shows them, or as their file has them, since when. */
export type LinkedInListed = Pick<LinkedInPerson, 'name' | 'profile' | 'mutualConnections'> & {
  readonly since?: string | null;
};

/**
 * One of the person's LinkedIn lists, to save as LinkedIn's: their connections as their friends list, the invitations
 * they've got as requests, and the ones they've sent as sent. Each member once, with their mutual connections, and
 * since when when their file says, in parts of FRIENDS_SAVE_MOST. Someone without a profile link is left out.
 */
export function linkedInListSave(
  people: readonly LinkedInListed[],
  list: FriendList,
  workspaceId: string,
): Built<FriendsSaveInput[]> {
  const seen = new Set<string>();
  const kept: FriendsSaveInput['people'] = [];
  for (const person of people) {
    const key = linkedInKey(person.profile);
    if (seen.has(key)) continue;
    const who = whom({ name: person.name, profile: person.profile }, LINKEDIN);
    if (!who) continue;
    seen.add(key);
    kept.push({
      ...who,
      mutualFriends: mutual(person.mutualConnections),
      ...(person.since ? { since: person.since } : {}),
    });
  }
  if (!kept.length)
    return {
      ok: false,
      why:
        list === 'friends'
          ? 'There are no connections on the page to save. Scroll down so LinkedIn shows them, then try again.'
          : `There are no ${linkedInItem(list)}s on the page to save.`,
    };
  const parts: FriendsSaveInput[] = [];
  for (let at = 0; at < kept.length; at += FRIENDS_SAVE_MOST)
    parts.push({
      workspaceId,
      platform: LINKEDIN,
      list,
      people: kept.slice(at, at + FRIENDS_SAVE_MOST),
    });
  return { ok: true, input: parts };
}

/**
 * The hashtag (without its #) or phrase a look or a search found posts with (decision 92), as a save keeps it on each
 * new post: none when it went with none.
 */
const foundWith = (words: string | null | undefined): string | null =>
  clip((words ?? '').replace(/^#+/, ''), POST_WORDS_MOST) || null;

/**
 * The posts LinkedIn's post search shows, to keep the ones worth a comment (decision 49, LinkedIn's way: its groups
 * are quiet), in no group: each with who wrote it, its own link and what it says. A post by a company's page, or
 * without its author's profile, its link or any words, is left out: nobody to reach, or nothing to comment on. From
 * 0.95.0 each save carries the phrase it searched with (`words`, decision 92), so a post found with a playbook's own
 * is worth the AI's check whatever its words say.
 */
export function linkedInPostsSave(
  result: LinkedInRead,
  workspaceId: string,
  found: PostsSaveInput['found'] = 'search',
  words: string | null = null,
): Built<PostsSaveInput> {
  const seen = new Set<string>();
  const posts = (result.posts ?? []).flatMap((post) => {
    if (post.company || !post.author?.profile) return [];
    const url = networkAddress(post.url, LINKEDIN);
    const who = whom({ name: post.author.name, profile: post.author.profile }, LINKEDIN);
    const text = clipText(post.text, POST_TEXT_MOST);
    if (!url || !who || !text || seen.has(url)) return [];
    seen.add(url);
    return [
      {
        url,
        author: who.profile,
        name: who.name,
        when: post.when ? clip(post.when, WHEN_MOST) : null,
        text,
        comments: post.comments,
        reactions: post.reactions,
      },
    ];
  });
  if (!posts.length) return { ok: false, why: 'There are no posts on the page to look at yet.' };
  return {
    ok: true,
    input: {
      workspaceId,
      platform: LINKEDIN,
      group: null,
      posts: posts.slice(0, POSTS_SAVE_MOST),
      found,
      words: foundWith(words),
    },
  };
}

/** Someone a partner search showed (../jobs/partner-search.ts): their profile, the lines under their name, followers. */
export interface Found {
  readonly name: string;
  readonly profile: ProfileRef;
  readonly lines: readonly string[];
  readonly followers: number | null;
}

/**
 * Who a partner search found, as HandsFreeOS keeps them to read for the AI's partner check (stage 4 of the partners
 * plan): each once, with the lines their result showed, at most a save's worth. Anyone whose profile or name the page
 * didn't show is left out. Sent even when it found nobody: the search still counts as done.
 */
export function partnerLeadsSave(
  found: readonly Found[],
  platform: Platform,
  kind: PartnerSearchKind,
  words: string,
  workspaceId: string,
): PartnerLeadsInput {
  const seen = new Set<string>();
  const people = found.flatMap((f) => {
    const who = whom({ name: f.name, profile: f.profile }, platform);
    if (!who) return [];
    const key = who.profile.id ?? who.profile.username ?? who.profile.url;
    if (seen.has(key)) return [];
    seen.add(key);
    const lines = [...new Set(f.lines.map((l) => clip(l, LOOKUP_LINE_MOST)).filter(Boolean))];
    return [
      {
        ...who,
        lines: lines.slice(0, PARTNER_LEAD_LINES),
        followers: f.followers !== null && f.followers <= 1_000_000_000 ? f.followers : null,
      },
    ];
  });
  return {
    workspaceId,
    platform,
    kind,
    words: clip(words, PARTNER_SEARCH_WORDS_MOST),
    people: people.slice(0, PARTNER_LEADS_SAVE_MOST),
  };
}

// ------------------------------------------------------------------------------------------------- Alignable's

const ALIGNABLE: Platform = 'alignable';

/** What each of the person's Alignable lists is called, for "Saved 12 connection requests". */
const ALIGNABLE_ITEM: Readonly<Record<FriendList, string>> = {
  friends: 'connection',
  requests: 'connection request',
  sent: 'sent connection request',
};
export const alignableItem = (list: FriendList) => ALIGNABLE_ITEM[list];

/** Someone on one of the person's Alignable lists: a business's owner, by their business's page. */
export interface AlignableListed {
  readonly name: string;
  readonly profile: ProfileRef;
}

/**
 * One of the person's Alignable lists, to save as Alignable's (partners stage 6c, part 4): their connections as their
 * friends list and the requests they've got as requests. Each business once, by Alignable's id for it or its
 * address in its town, in parts of FRIENDS_SAVE_MOST. A row without a business's page is left out.
 */
export function alignableListSave(
  people: readonly AlignableListed[],
  list: FriendList,
  workspaceId: string,
): Built<FriendsSaveInput[]> {
  const seen = new Set<string>();
  const kept: FriendsSaveInput['people'] = [];
  for (const person of people) {
    const key = (person.profile.id ?? person.profile.username ?? person.profile.url).toLowerCase();
    if (seen.has(key)) continue;
    const who = whom({ name: person.name, profile: person.profile }, ALIGNABLE);
    if (!who) continue;
    seen.add(key);
    kept.push({ ...who, mutualFriends: null });
  }
  if (!kept.length)
    return {
      ok: false,
      why:
        list === 'friends'
          ? 'There are no connections on the page to save. Open My Network on Alignable, then try again.'
          : `There are no ${alignableItem(list)}s on the page to save.`,
    };
  const parts: FriendsSaveInput[] = [];
  for (let at = 0; at < kept.length; at += FRIENDS_SAVE_MOST)
    parts.push({
      workspaceId,
      platform: ALIGNABLE,
      list,
      people: kept.slice(at, at + FRIENDS_SAVE_MOST),
    });
  return { ok: true, input: parts };
}

/**
 * The posts on an Alignable page (its town's group, a forum question, or from 0.95.0 a group the person joined), to
 * keep the ones worth an answer or a comment (partners stage 6c, decision 92): each with who wrote it, its own
 * discussion's link and what it says. The town's posts and the forum's go in no group, as a network's search finds
 * are; a joined group's feed goes with its group (`group`), so its writers are found in it. A post with no page of its
 * own, or nobody named, is left out, and so is the whole save when the group isn't one it can keep.
 */
export function alignablePostsSave(
  threads: readonly {
    readonly author: { readonly name: string; readonly profile: ProfileRef | null } | null;
    readonly url: string | null;
    readonly when: string | null;
    readonly text: string;
    readonly likes: number | null;
  }[],
  workspaceId: string,
  group: AlignableGroupLink | null = null,
): Built<PostsSaveInput> {
  const inGroup = group ? groupRef(group, ALIGNABLE) : null;
  if (group && !inGroup) return { ok: false, why: NOT_WHICH_GROUP };
  const seen = new Set<string>();
  const posts = threads.flatMap((thread) => {
    if (!thread.author?.profile) return [];
    const url = networkAddress(thread.url, ALIGNABLE);
    const who = whom({ name: thread.author.name, profile: thread.author.profile }, ALIGNABLE);
    const text = clipText(thread.text, POST_TEXT_MOST);
    if (!url || !who || !text || seen.has(url)) return [];
    seen.add(url);
    return [
      {
        url,
        author: who.profile,
        name: who.name,
        when: thread.when ? clip(thread.when, WHEN_MOST) : null,
        text,
        comments: null,
        reactions: thread.likes,
      },
    ];
  });
  if (!posts.length) return { ok: false, why: 'There are no posts on the page to look at yet.' };
  return {
    ok: true,
    input: {
      workspaceId,
      platform: ALIGNABLE,
      group: inGroup,
      posts: posts.slice(0, POSTS_SAVE_MOST),
      found: 'find',
    },
  };
}

/** A group on Alignable as a link to it showed it: its number or the name in its address, its address, and its name. */
export interface AlignableGroupLink {
  readonly id: string;
  readonly url: string;
  readonly name: string | null;
}

/**
 * A group as an Alignable page listed it (decision 92: a search for groups, the person's own groups): its link, and
 * what the page said of it.
 */
export interface AlignableGroupCard extends AlignableGroupLink {
  /** How many members it says it has. */
  readonly members: number | null;
  /** Whether the person is in it, as the page showed (Joined, or its own Join): null when it didn't say. */
  readonly joined: boolean | null;
  /** The line under its name: what it's about, or where. */
  readonly detail?: string | null;
}

/**
 * The groups an Alignable page lists, to save as Alignable's (decision 92), each once with how much the page said.
 * On the person's own groups page (`own`) each is saved as one they're in, before any search or join (decision 48), so
 * HandsFreeOS counts it as theirs; anywhere else, only what its card showed. Alignable doesn't say public or private.
 */
export function alignableGroupsSave(
  groups: readonly AlignableGroupCard[],
  workspaceId: string,
  own = false,
): Built<GroupsSaveInput> {
  const seen = new Set<string>();
  const kept = groups.flatMap((card) => {
    const group = groupRef(card, ALIGNABLE);
    if (!group || seen.has(group.url)) return [];
    seen.add(group.url);
    const detail = card.detail ? clip(card.detail, DETAIL_MOST) || null : null;
    const joined = own ? true : card.joined;
    return [
      {
        group,
        detail,
        privacy: null,
        members: card.members !== null && card.members <= 100_000_000 ? card.members : null,
        ...(joined === null ? {} : { joined }),
      },
    ];
  });
  if (!kept.length) return { ok: false, why: 'There are no groups on the page to save.' };
  return {
    ok: true,
    input: { workspaceId, platform: ALIGNABLE, groups: kept.slice(0, GROUPS_SAVE_MOST) },
  };
}

/** Someone a group's members page shows: their business, the lines under their name, and whether they lead it. */
export interface AlignableMember {
  readonly name: string;
  readonly profile: ProfileRef;
  readonly lines: readonly string[];
  /** One of its leaders (an organizer, an admin, a moderator): kept so, and never reached (decision 92). */
  readonly leader: boolean;
}

/**
 * A group on Alignable and the members its page shows, to save as Alignable's (decision 92), in as many parts as it
 * takes. Its leaders are kept as running it, never suggested; they stay partner leads. `leadersRead` once the page's
 * leaders were all read, or the page showed no leaders at all: said only on the last part, as Facebook's admins page
 * is, so a save that stops halfway doesn't open the gate to its members.
 */
export function alignableGroupSave(
  group: AlignableGroupCard,
  people: readonly AlignableMember[],
  workspaceId: string,
  leadersRead = false,
): Built<GroupSaveInput[]> {
  const ref = groupRef(group, ALIGNABLE);
  if (!ref) return { ok: false, why: NOT_WHICH_GROUP };
  const seen = new Set<string>();
  const kept = people.flatMap((person) => {
    const who = whom({ name: person.name, profile: person.profile }, ALIGNABLE);
    const key = who
      ? (who.profile.id ?? who.profile.username ?? who.profile.url).toLowerCase()
      : '';
    if (!who || seen.has(key)) return [];
    seen.add(key);
    return [
      {
        ...who,
        lines: person.lines
          .map((line) => clip(line, INTRO_LINE_MOST))
          .filter(Boolean)
          .slice(0, GROUP_LINES),
        part: null,
        runsGroup: person.leader,
      },
    ];
  });
  const facts = {
    workspaceId,
    platform: ALIGNABLE,
    group: ref,
    privacy: null,
    members: group.members !== null && group.members <= 100_000_000 ? group.members : null,
    joined: group.joined,
  };
  if (!kept.length) return { ok: true, input: [{ ...facts, people: [], adminsPage: leadersRead }] };
  const parts: GroupSaveInput[] = [];
  for (let at = 0; at < kept.length; at += GROUP_PEOPLE_MOST)
    parts.push({ ...facts, people: kept.slice(at, at + GROUP_PEOPLE_MOST), adminsPage: false });
  parts[parts.length - 1] = { ...parts[parts.length - 1]!, adminsPage: leadersRead };
  return { ok: true, input: parts };
}

// ------------------------------------------------------------------------------------------------- Instagram's

const INSTAGRAM: Platform = 'instagram';

/** Someone on the person's Instagram followers list: by their account's name and its address. */
export interface InstagramListed {
  readonly username: string;
  readonly url: string;
  readonly name: string | null;
}

/**
 * The person's Instagram followers, to save as Instagram's friends list (the Instagram and Alignable plan's part 12): on
 * Instagram the "friends" are the person's followers, so someone they followed who's among them has followed back,
 * which counts as accepting. Each account once, by its name in its address, in parts of FRIENDS_SAVE_MOST. Someone
 * with no name of their own is saved by their username, as Instagram shows them. A look at the account of someone they
 * followed (../jobs/instagram/follow-backs.ts) saves them as a list of one: among their followers when it says they
 * follow the person back, else among the follows they've sent (`sent`), still waiting.
 */
export function instagramListSave(
  people: readonly InstagramListed[],
  workspaceId: string,
  list: 'friends' | 'sent' = 'friends',
): Built<FriendsSaveInput[]> {
  const seen = new Set<string>();
  const kept: FriendsSaveInput['people'] = [];
  for (const person of people) {
    const key = person.username.toLowerCase();
    if (seen.has(key)) continue;
    const who = whom(
      {
        name: person.name?.trim() || person.username,
        profile: { id: null, username: person.username, url: person.url },
      },
      INSTAGRAM,
    );
    if (!who) continue;
    seen.add(key);
    kept.push({ ...who, mutualFriends: null });
  }
  if (!kept.length)
    return {
      ok: false,
      why: 'There are no followers on the page to save. Open your followers on Instagram, then try again.',
    };
  const parts: FriendsSaveInput[] = [];
  for (let at = 0; at < kept.length; at += FRIENDS_SAVE_MOST)
    parts.push({
      workspaceId,
      platform: INSTAGRAM,
      list,
      people: kept.slice(at, at + FRIENDS_SAVE_MOST),
    });
  return { ok: true, input: parts };
}

/** A post on Instagram as its own page shows it: who posted it, its caption and its likes. */
export interface InstagramPostRead {
  readonly url: string;
  readonly author: { readonly username: string; readonly url: string } | null;
  readonly caption: string | null;
  readonly likes: number | null;
}

/**
 * The posts a look at Instagram's hashtags and places opened (part 15), to keep the ones worth a comment: each with who
 * posted it, by their account's name, and its caption, in no group, as a network's search finds are. A post with
 * nobody named, or no caption to read, is left out. From 0.95.0 each hashtag's posts go as a save of their own with the
 * hashtag (`words`, without its #, decision 92), so a post under a playbook's own is worth the AI's check whatever its
 * caption says; a place's go with none. From 0.102.0 an account like the business's posts go as found by it
 * (`account`, decision 110), with its username and its @ (`@austinchamber`), so their people are read whatever the AI
 * says of the post.
 */
export function instagramPostsSave(
  posts: readonly InstagramPostRead[],
  workspaceId: string,
  words: string | null = null,
  found: 'search' | 'account' = 'search',
): Built<PostsSaveInput> {
  const seen = new Set<string>();
  const kept = posts.flatMap((post) => {
    if (!post.author) return [];
    const url = networkAddress(post.url, INSTAGRAM);
    const who = whom(
      {
        name: post.author.username,
        profile: { id: null, username: post.author.username, url: post.author.url },
      },
      INSTAGRAM,
    );
    const text = post.caption ? clipText(post.caption, POST_TEXT_MOST) : '';
    if (!url || !who || !text || seen.has(url)) return [];
    seen.add(url);
    return [
      {
        url,
        author: who.profile,
        name: who.name,
        when: null,
        text,
        comments: null,
        reactions: post.likes,
      },
    ];
  });
  if (!kept.length) return { ok: false, why: 'There are no posts with words to look at yet.' };
  return {
    ok: true,
    input: {
      workspaceId,
      platform: INSTAGRAM,
      group: null,
      posts: kept.slice(0, POSTS_SAVE_MOST),
      found,
      words: foundWith(words),
    },
  };
}

// ------------------------------------------------------------------------------------------------- found by topic

/**
 * Someone a page showed, found by topic (decision 92): who liked or commented on a good post, a search's result, a
 * group's member. Their profile, the lines under their name (a headline, a bio, a kind of business), what a commenter
 * said, and where a search's result or a member says they are.
 */
export interface FoundPerson {
  readonly name: string;
  readonly profile: ProfileRef;
  readonly lines?: readonly string[];
  readonly said?: string | null;
  readonly place?: string | null;
}

/** What the people found were found by: the good post they're the people of, or the group, or the search. */
export interface FoundOn {
  /** The good post whose likers or commenters they are (`outreach.posts.people_next`'s `postId`). */
  readonly postId?: string | null;
  /** The group whose members they are. */
  readonly group?: AlignableGroupLink | null;
  /** The kind of business a search went with (`outreach.finds.searches`), or the event's name. */
  readonly words?: string | null;
  /** The town a search looked in (none when it looked anywhere), or the event is in. */
  readonly place?: string | null;
}

/**
 * The people found by topic on a page (decision 92: a good post's likers or commenters, a search's businesses, a
 * group's members), as HandsFreeOS keeps them for the AI's found check (`outreach.finds.save`): each once, cut to what
 * it takes, in parts of FINDS_SAVE_MOST. What a commenter said goes only with commenters. Someone whose profile or name
 * the page didn't show is left out. A post's people go even when there are none (one save with nobody in it), so the
 * post counts as read; the post or the group it needs missing, nothing goes.
 */
export function findsSave(
  found: readonly FoundPerson[],
  how: FindSaveHow,
  platform: Platform,
  workspaceId: string,
  on: FoundOn = {},
): Built<FindsSaveInput[]> {
  const onPost = how === 'liked' || how === 'commented';
  if (onPost && !on.postId)
    return { ok: false, why: 'Couldn’t tell which post they’re the people of.' };
  const group = on.group ? groupRef(on.group, platform) : null;
  if (how === 'member' && !group) return { ok: false, why: NOT_WHICH_GROUP };
  if (how === 'event' && !words(on.words, FIND_WORDS_MOST))
    return { ok: false, why: 'Couldn’t tell which event they’re hosting or going to.' };
  const seen = new Set<string>();
  const people = found.flatMap((person) => {
    const who = whom({ name: person.name, profile: person.profile }, platform);
    if (!who) return [];
    const key = (who.profile.id ?? who.profile.username ?? who.profile.url).toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const lines = [
      ...new Set((person.lines ?? []).map((line) => clip(line, FIND_LINE_MOST)).filter(Boolean)),
    ];
    return [
      {
        ...who,
        lines: lines.slice(0, FIND_LINES),
        said: how === 'commented' ? words(person.said, FIND_SAID_MOST) : null,
        place: words(person.place, FIND_PLACE_MOST),
      },
    ];
  });
  const facts = {
    workspaceId,
    platform,
    how,
    postId: onPost ? on.postId! : null,
    group,
    // A post's people take their words from the post itself (its hashtag or phrase).
    words: onPost ? null : words(on.words, FIND_WORDS_MOST),
    place: how === 'searched' || how === 'event' ? words(on.place, FIND_PLACE_MOST) : null,
  };
  if (!people.length) return { ok: true, input: [{ ...facts, people: [] }] };
  const parts: FindsSaveInput[] = [];
  for (let at = 0; at < people.length; at += FINDS_SAVE_MOST)
    parts.push({ ...facts, people: people.slice(at, at + FINDS_SAVE_MOST) });
  return { ok: true, input: parts };
}
