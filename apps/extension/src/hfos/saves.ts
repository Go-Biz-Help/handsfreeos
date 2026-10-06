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
  THREAD_KEY,
  USERNAME,
  WHEN_MOST,
} from '@hfos/core/addons/outreach/limits';
import type { Answered, Reached, Step, StepGroup } from '../facebook/actions';
import { asked, mutualFriendsIn, type FriendList } from '../facebook/friends';
import type { ChatPage, Person, ProfilePage, ProfileRef, ReadResult } from '../facebook/types';
import { profileKey } from '../facebook/urls';
import type {
  Business,
  ChatInput,
  FriendNoteInput,
  FriendSetInput,
  FriendsSaveInput,
  Me,
  ProfileInput,
  TouchInput,
} from './messages';
import { resolveWhen } from './when';

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
 * Your list on the page: your friends, or the friend requests you've got; on /friends, the requests in its "Friend
 * requests" part. Null on any other page, someone else's friends among them.
 */
export function listOnPage(result: ReadResult): ListOnPage | null {
  const people = result.people ?? [];
  if (result.friendList) return { list: result.friendList, people };
  if (result.kind !== 'friends') return null;
  const requests = people.filter((person) => asked(person, null));
  return requests.length ? { list: 'requests', people: requests } : null;
}

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
          : 'There are no friend requests on the page to save.',
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
