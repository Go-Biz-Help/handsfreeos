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
import { POST_TEXT_MOST, POSTS_SAVE_MOST } from '@hfos/core/addons/outreach/posts';
import { LOOKUP_LINE_MOST } from '@hfos/core/addons/outreach/today';
import type { Answered, Reached, Step, StepGroup } from '../networks/facebook/actions';
import { asked, askedByYou, mutualFriendsIn, type FriendList } from '../networks/facebook/friends';
import { runsGroup } from '../networks/facebook/people';
import type {
  ChatPage,
  GroupLink,
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
  Business,
  ChatsCollectInput,
  FriendNoteInput,
  FriendsSaveInput,
  GroupSaveInput,
  GroupsSaveInput,
  Me,
  PartnerLeadsInput,
  PostsSaveInput,
  ProfileInput,
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
function ref(profile: ProfileRef, platform: Platform = JOBS): ProfileInput['profile'] {
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
  if (!page || !group) return { ok: false, why: 'Couldn’t tell which group this is.' };
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
 * The posts LinkedIn's post search shows, to keep the ones worth a comment (decision 49, LinkedIn's way: its groups
 * are quiet), in no group: each with who wrote it, its own link and what it says. A post by a company's page, or
 * without its author's profile, its link or any words, is left out: nobody to reach, or nothing to comment on.
 */
export function linkedInPostsSave(
  result: LinkedInRead,
  workspaceId: string,
  found: PostsSaveInput['found'] = 'search',
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
