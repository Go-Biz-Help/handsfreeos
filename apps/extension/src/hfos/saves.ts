/**
 * What the panel sends HandsFreeOS when the person presses Save, what it asks to learn which people and chats on a
 * page are saved already, and what the background sends for each step the person takes on Facebook and each friend
 * request they answer: the Social Outreach add-on's commands and look-up (packages/core/src/addons/outreach), built
 * from what the page showed and cut to what they take. Plain functions, so the tests check them.
 */
import {
  FRIENDS_SAVE_MOST,
  GROUP_ID,
  GROUP_SLUG,
  INTRO_LINE_MOST,
  INTRO_LINES,
  KEPT_MESSAGES,
  MESSAGE_MOST,
  NAME_MOST,
  PROFILE_ID,
  RECENT_MESSAGES,
  THREAD_KEY,
  USERNAME,
  WHEN_MOST,
} from '@hfos/core/addons/outreach/limits';
import { GROUP_PEOPLE_MOST, GROUPS_SAVE_MOST } from '@hfos/core/addons/outreach/groups';
import { POST_TEXT_MOST, POSTS_SAVE_MOST } from '@hfos/core/addons/outreach/posts';
import type { Answered, Reached, Step, StepGroup } from '../facebook/actions';
import { asked, askedByYou, mutualFriendsIn, type FriendList } from '../facebook/friends';
import { runsGroup } from '../facebook/people';
import type {
  ChatPage,
  GroupLink,
  Person,
  ProfilePage,
  ProfileRef,
  ReadResult,
} from '../facebook/types';
import { facebookUrl, pathParts, profileKey } from '../facebook/urls';
import { parseCount } from '../facebook/vocabulary';
import type {
  Business,
  ChatInput,
  ChatsCollectInput,
  DemoMarkInput,
  FriendNoteInput,
  FriendSetInput,
  FriendsSaveInput,
  GroupSaveInput,
  GroupsSaveInput,
  Me,
  PostsSaveInput,
  ProfileInput,
  TouchInput,
} from './messages';
import { instantOf, resolveWhen } from './when';

type ChatMessage = ChatInput['messages'][number];

/** Kept well under the API's 256 KB a request, which a hundred long messages in some alphabets would pass. */
export const MOST_BYTES = 200 * 1024;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

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

/** A profile as HandsFreeOS takes it: by number, username, or both, and its link. */
function ref(profile: ProfileRef): ProfileInput['profile'] {
  return {
    id: profile.id && PROFILE_ID.test(profile.id) ? profile.id : null,
    username: profile.username && USERNAME.test(profile.username) ? profile.username : null,
    url: profile.url,
  };
}

/** Mutual friends as HandsFreeOS takes them. */
const mutual = (count: number | null) => (count !== null && count <= 100_000 ? count : null);

export type Built<T> =
  { readonly ok: true; readonly input: T } | { readonly ok: false; readonly why: string };

/** The profile on the page, to save. `personId` is a customer the person said it is. */
export function profileSave(
  page: ProfilePage,
  workspaceId: string,
  personId?: string,
): Built<ProfileInput> {
  if (page.friendship === 'self') return { ok: false, why: 'This is your own profile.' };
  const name = page.name ? clip(page.name, NAME_MOST) : '';
  if (!page.profile || !name)
    return {
      ok: false,
      why: 'Couldn’t find this profile’s name and link on the page. Reload it and read it again.',
    };
  return {
    ok: true,
    input: {
      workspaceId,
      platform: 'facebook',
      profile: ref(page.profile),
      name,
      intro: page.intro
        .map((line) => clip(line, INTRO_LINE_MOST))
        .filter(Boolean)
        .slice(0, INTRO_LINES),
      friendship: page.friendship,
      mutualFriends: mutual(page.mutualFriends),
      ...(personId ? { personId } : {}),
    },
  };
}

/**
 * The chat on the page, to save: the latest messages it keeps, with Facebook's times made to last (./when.ts), as
 * many as fit in one request. Who it's with comes from the profile it links to, or `personId`, a customer the person
 * said it is; with neither, HandsFreeOS saves it to whoever it was saved with before, or says it can't tell.
 */
export function chatSave(
  chat: ChatPage,
  workspaceId: string,
  now: Date,
  personId?: string,
): Built<ChatInput> & { readonly left?: number } {
  if (!chat.thread || !THREAD_KEY.test(chat.thread.id))
    return {
      ok: false,
      why: 'Couldn’t find this chat’s own link. Open it from your chats and try again.',
    };
  const name = chat.name ? clip(chat.name, NAME_MOST) : '';
  if (!name)
    return { ok: false, why: 'Couldn’t find who this chat is with. Reload it and read it again.' };
  const messages: ChatMessage[] = chat.messages.flatMap((m) => {
    const text = clipText(m.text, MESSAGE_MOST);
    if (!text) return [];
    const sender = m.sender ? clip(m.sender, NAME_MOST) : '';
    return [
      {
        from: m.from,
        sender: sender || null,
        text,
        when: m.when ? clip(resolveWhen(m.when, now), WHEN_MOST) || null : null,
      },
    ];
  });
  if (!messages.length) return { ok: false, why: 'There are no messages on the page to save yet.' };
  const input: ChatInput = {
    workspaceId,
    platform: 'facebook',
    thread: { id: chat.thread.id, encrypted: chat.thread.encrypted, url: chat.thread.url },
    name,
    profile: chat.profile ? ref(chat.profile) : null,
    messages: [],
    ...(personId ? { personId } : {}),
  };
  // The newest first, while they fit.
  let room = MOST_BYTES - bytes(input);
  const kept: ChatMessage[] = [];
  for (const message of messages.slice(-KEPT_MESSAGES).reverse()) {
    room -= bytes(message) + 1;
    if (room < 0) break;
    kept.unshift(message);
  }
  return { ok: true, input: { ...input, messages: kept }, left: messages.length - kept.length };
}

type Collected = ChatsCollectInput['chats'][number];

/**
 * The one-to-one chat on the page, for the AI to read (packages/core/src/addons/outreach/chat-collect.ts): its latest
 * messages that say whose they are, each with the moment it was sent. A message carries the last time shown above it;
 * ones above the first time shown take that one; with no time on the page at all, `listed` (when the list of chats
 * says the last message was) stands for them. Null when it isn't one to read: a group chat, or no messages or time.
 */
export function chatCollect(chat: ChatPage, now: Date, listed?: string | null): Collected | null {
  if (!chat.thread || !THREAD_KEY.test(chat.thread.id)) return null;
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
    profile: chat.profile ? ref(chat.profile) : null,
    messages,
  };
}

/** A Facebook address as HandsFreeOS takes one: on www.facebook.com, over https, and not too long. */
const facebookAddress = (url: string | null) =>
  url && url.length <= 500 && url.startsWith('https://www.facebook.com/') ? url : null;

const NOT_WHOSE = 'Couldn’t tell whose profile it was.';

/** Who a step or an answer was to, as HandsFreeOS takes them: null when the page didn't give a profile it keeps. */
function whom(to: Pick<Reached, 'name' | 'profile'>): Pick<TouchInput, 'profile' | 'name'> | null {
  const profile = ref(to.profile);
  const name = clip(to.name, NAME_MOST);
  return (profile.id || profile.username) && facebookAddress(profile.url) && name
    ? { profile, name }
    : null;
}

/** A group as HandsFreeOS takes it: by its number, or by the name in its link when that's all the link showed. */
function groupRef(group: StepGroup): TouchInput['group'] {
  const id = GROUP_ID.test(group.id) ? group.id : null;
  const slug = !id && GROUP_SLUG.test(group.id) ? group.id : null;
  const url = facebookAddress(group.url);
  if ((!id && !slug) || !url) return null;
  const name = group.name ? clip(group.name, NAME_MOST) : '';
  return { id, slug, url, name: name || null };
}

/**
 * A step the person took on Facebook, to note: who it was to, the group they were found in (the page's, or the one
 * the background remembers them by), and the post or chat, cut to what HandsFreeOS takes. Never what was written.
 */
export function touchSave(
  step: Step,
  workspaceId: string,
  remembered: StepGroup | null = null,
): Built<TouchInput> {
  const who = whom(step.to);
  if (!who) return { ok: false, why: NOT_WHOSE };
  const group = step.group ?? remembered;
  return {
    ok: true,
    input: {
      workspaceId,
      platform: 'facebook',
      kind: step.kind,
      ...who,
      group: group ? groupRef(group) : null,
      postUrl:
        step.kind === 'like' || step.kind === 'comment' ? facebookAddress(step.postUrl) : null,
      threadKey:
        step.kind === 'message' && step.thread && THREAD_KEY.test(step.thread.id)
          ? step.thread.id
          : null,
      replying: step.kind === 'message' ? step.replying : null,
    },
  };
}

/** The person's answer to a friend request they got, to note: Confirm or Delete, who asked, and their mutual friends. */
export function friendNote(answered: Answered, workspaceId: string): Built<FriendNoteInput> {
  const who = whom(answered.to);
  if (!who) return { ok: false, why: NOT_WHOSE };
  return {
    ok: true,
    input: {
      workspaceId,
      platform: 'facebook',
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
      platform: 'facebook',
      list,
      people: kept.slice(at, at + FRIENDS_SAVE_MOST),
    });
  return { ok: true, input: parts };
}

/**
 * Keep or Don't pitch for someone: by the profile HandsFreeOS keeps (`profileId`, from the look-up), or by their
 * profile on the page and their name when it keeps none yet.
 */
export function friendSet(
  to: { readonly profile: ProfileRef; readonly name: string },
  workspaceId: string,
  change: Pick<FriendSetInput, 'keep' | 'dontPitch'>,
  profileId?: string,
): Built<FriendSetInput> {
  const base = { workspaceId, platform: 'facebook' as const, ...change };
  if (profileId) return { ok: true, input: { ...base, profileId } };
  const who = whom(to);
  return who ? { ok: true, input: { ...base, ...who } } : { ok: false, why: NOT_WHOSE };
}

/** Marking that someone booked a demo some other way than the demo link, or taking it back (decision 24). */
export function demoMark(
  to: { readonly profile: ProfileRef; readonly name: string },
  workspaceId: string,
  booked: boolean,
): Built<DemoMarkInput> {
  const who = whom(to);
  return who
    ? { ok: true, input: { workspaceId, platform: 'facebook', ...who, booked } }
    : { ok: false, why: NOT_WHOSE };
}

/** A name as HandsFreeOS matches it to customers': its spaces as one, in any case. */
export const nameKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

/** The people, chats and name a page is about: what to ask HandsFreeOS about. */
export interface OnPage {
  readonly profiles: readonly ProfileRef[];
  readonly threads: readonly string[];
  /** The one person the page is about, when it's a profile or a chat: their name, to find who else has it. */
  readonly name: string | null;
}

export function onPage(result: ReadResult): OnPage {
  const profiles = new Map<string, ProfileRef>();
  const add = (profile: ProfileRef | null | undefined) => {
    if (profile && !profiles.has(profileKey(profile))) profiles.set(profileKey(profile), profile);
  };
  add(result.profile?.friendship === 'self' ? null : result.profile?.profile);
  add(result.chat?.profile);
  for (const person of result.people ?? []) add(person.profile);
  for (const post of result.posts ?? []) add(post.author?.profile);
  const threads = new Set<string>();
  if (result.chat?.thread && THREAD_KEY.test(result.chat.thread.id))
    threads.add(result.chat.thread.id);
  for (const chat of result.chats ?? [])
    if (THREAD_KEY.test(chat.thread.id)) threads.add(chat.thread.id);
  const name =
    result.profile && result.profile.friendship !== 'self'
      ? result.profile.name
      : (result.chat?.name ?? null);
  return {
    profiles: [...profiles.values()],
    threads: [...threads],
    name: name ? clip(name, NAME_MOST) || null : null,
  };
}

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

/** The groups a page lists (yours, or search results), to save with how much the page said about each. */
export function groupsSave(
  groups: readonly GroupLink[],
  workspaceId: string,
): Built<GroupsSaveInput> {
  const kept = groups.flatMap((link) => {
    const group = groupRef({ ...link.group, name: link.name });
    if (!group) return [];
    const detail = link.detail ? clip(link.detail, DETAIL_MOST) : null;
    return [{ group, detail, ...groupDetailFacts(link.detail) }];
  });
  if (!kept.length) return { ok: false, why: 'There are no groups on the page to save.' };
  return {
    ok: true,
    input: { workspaceId, platform: 'facebook', groups: kept.slice(0, GROUPS_SAVE_MOST) },
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
    platform: 'facebook' as const,
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
    const url = facebookAddress(post.url);
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
      platform: 'facebook',
      group,
      posts: posts.slice(0, POSTS_SAVE_MOST),
      found,
    },
  };
}
