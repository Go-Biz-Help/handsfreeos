/**
 * What the background asks a Facebook tab besides reading it, answered in the tab (../../content.ts): only for what
 * the person asked of the extension from HandsFreeOS, or let it do on its own (README.md, "Rules worth knowing").
 *
 * - On Facebook's own download pages, the buttons that ask for their file and download it, one step at a time
 *   (./fetch.ts); on the profiles of people they ticked, Cancel request or Unfriend (./tidy.ts); on their friend
 *   requests, View sent requests (./friends.ts).
 * - In Messenger, for Read my chats, a chat opened from the list beside it, and that list scrolled for more; a group's
 *   feed, a list of people and a list of groups scrolled for more (./browse.ts).
 * - Working on its own (../../auto/run.ts): Add friend, Confirm and Like on the profiles of people on their list for
 *   today, the comment the AI drafted on a post on their list, and a message they OK'd (./auto.ts).
 * - A good group: Join group, and its questions answered with the AI's answers (./join.ts, decision 48).
 * - A helpful post put up on a group's page, and who engaged with one of theirs (./compose.ts, decision 50).
 * - Their own profile read for the AI's check, and the bio they picked put in (./own-profile.ts, decision 64).
 * - Check Facebook's tries: each step taken up to its last press, never that one, on the page it's for (./tries.ts,
 *   decision 77).
 *
 * Runs in the tab, on the page in front of it: it uses the tab's own document and address.
 */
import type {
  AutoAnswer,
  AutoAsk,
  BrowseAnswer,
  BrowseAsk,
  FetchAnswer,
  FetchAsk,
  GroupPostAnswer,
  GroupPostAsk,
  JoinAnswer,
  JoinAsk,
  OwnProfileAnswer,
  OwnProfileAsk,
  PostsAnswer,
  TryAnswer,
  TryAsk,
} from '../../messages';
import { likeTheirPost, readTheirPosts, writeComment, writeMessage } from './auto';
import { openChat, scrollChats, scrollFeed, scrollList, scrollPage } from './browse';
import { readComments, readReactions, writeGroupPost } from './compose';
import { fetchPage, stepOnPage } from './fetch';
import { requestsPage } from './friends';
import { answerJoin, pressJoin } from './join';
import { readOwnProfile, writeBio } from './own-profile';
import { tidyPage } from './tidy';
import {
  tryBio,
  tryCancel,
  tryComment,
  tryConfirm,
  tryFile,
  tryJoin,
  tryLike,
  tryMessage,
  tryPost,
  tryRequest,
  tryUnfriend,
} from './tries';
import { classifyUrl } from './urls';
import type { StepTry } from '../tries';

/** One of the panel's steps on a download page, looked for until it shows or `waitMs` is up. */
async function fetchStep(ask: FetchAsk): Promise<FetchAnswer> {
  const allowed = ask.tidy
    ? tidyPage(location.href)
    : ask.lists
      ? requestsPage(location.href)
      : fetchPage(location.href);
  if (!allowed)
    return {
      ok: false,
      error: ask.tidy
        ? 'Facebook didn’t open their profile.'
        : ask.lists
          ? 'Facebook didn’t open your friend requests.'
          : 'This isn’t one of Facebook’s download pages.',
    };
  return { ok: true, ...(await stepOnPage(document, ask)) };
}

/** One of the runner's steps (./auto.ts): a like on someone's profile, a comment on a post, or a message. */
async function autoStep(ask: AutoAsk): Promise<AutoAnswer | PostsAnswer> {
  const kind = classifyUrl(location.href).kind;
  if (ask.type === 'hfos-their-posts' || ask.type === 'hfos-like-post') {
    if (kind !== 'profile') return { ok: false, error: 'Facebook didn’t open their profile.' };
    if (ask.type === 'hfos-their-posts')
      return {
        ok: true,
        posts: await readTheirPosts(document, location.href, ask.profile, window, ask.most),
      };
    return { ok: true, ...(await likeTheirPost(document, location.href, ask.profile, ask)) };
  }
  if (ask.type === 'hfos-message') {
    if (kind !== 'chat' && kind !== 'profile')
      return { ok: false, error: 'Facebook didn’t open a chat with them.' };
    return { ok: true, result: await writeMessage(document, ask.text) };
  }
  if (kind !== 'post') return { ok: false, error: 'Facebook didn’t open the post.' };
  return { ok: true, result: await writeComment(document, ask.text) };
}

/** Asking to join the group the tab shows (./join.ts): Join group, then the AI's answers to its questions. */
async function joinStep(ask: JoinAsk): Promise<JoinAnswer> {
  if (classifyUrl(location.href).kind !== 'group')
    return { ok: false, error: 'Facebook didn’t open the group.' };
  if (ask.type === 'hfos-join') return { ok: true, step: await pressJoin(document) };
  return { ok: true, result: await answerJoin(document, ask.answers) };
}

/** A helpful post (./compose.ts): put it up on the group's page, or read who engaged on the person's own. */
async function groupPostStep(ask: GroupPostAsk): Promise<GroupPostAnswer> {
  const kind = classifyUrl(location.href).kind;
  if (ask.type === 'hfos-group-post') {
    if (kind !== 'group') return { ok: false, error: 'Facebook didn’t open the group.' };
    return { ok: true, result: await writeGroupPost(document, ask.text) };
  }
  if (kind !== 'post') return { ok: false, error: 'Facebook didn’t open the post.' };
  return {
    ok: true,
    comments: readComments(document, location.href),
    reactions: await readReactions(document, location.href),
  };
}

/** The person's own profile (./own-profile.ts): read it for the AI's check, or put a bio in. */
async function ownProfileStep(ask: OwnProfileAsk): Promise<OwnProfileAnswer> {
  const address = classifyUrl(location.href);
  if (address.kind !== 'profile') return { ok: false, error: 'Facebook didn’t open your profile.' };
  if (ask.type === 'hfos-own-profile')
    return { ok: true, read: readOwnProfile(document, location.href, address) };
  if (ask.type === 'hfos-write-about')
    return { ok: false, error: 'Facebook has no About to put in.' };
  return { ok: true, result: await writeBio(document, ask.bio) };
}

/** Check Facebook's tries (./tries.ts), each only on the kind of page its step is for. */
async function tryStep(ask: TryAsk): Promise<TryAnswer> {
  const kind = classifyUrl(location.href).kind;
  const wrong = (page: string): TryAnswer => ({
    ok: false,
    error: `Facebook didn’t open ${page}.`,
  });
  const tried = (step: StepTry | Promise<StepTry>) =>
    Promise.resolve(step).then((t): TryAnswer => ({ ok: true, tried: t }));
  switch (ask.step) {
    case 'bio':
      return kind === 'profile' ? tried(tryBio(document)) : wrong('your profile');
    case 'confirm':
      return requestsPage(location.href)
        ? tried(tryConfirm(document, location.href))
        : wrong('your friend requests');
    case 'post':
      return kind === 'group' ? tried(tryPost(document)) : wrong('the group');
    case 'comment':
      return kind === 'post' ? tried(tryComment(document)) : wrong('the post');
    case 'request':
      return kind === 'profile'
        ? tried(tryRequest(document, location.href))
        : wrong('their profile');
    case 'join':
      return kind === 'group' ? tried(tryJoin(document)) : wrong('the group');
    case 'like':
      return kind === 'profile' && ask.profile
        ? tried(tryLike(document, location.href, ask.profile, window))
        : wrong('their profile');
    case 'unfriend':
      return kind === 'profile'
        ? tried(tryUnfriend(document, location.href))
        : wrong('their profile');
    case 'message':
      return kind === 'profile'
        ? tried(tryMessage(document, location.href))
        : wrong('their profile');
    case 'cancel':
      return kind === 'profile'
        ? tried(tryCancel(document, location.href))
        : wrong('their profile');
    case 'file':
      return fetchPage(location.href)
        ? tried(tryFile(document))
        : wrong('its Download your information page');
    default:
      // A step of another network's Check: said, never left unanswered.
      return { ok: false, error: 'The extension doesn’t try that on Facebook.' };
  }
}

/** Opening a chat from Messenger's list, or scrolling a list for more (./browse.ts): whether it could. */
function browseStep(ask: BrowseAsk): BrowseAnswer {
  const ok =
    ask.type === 'hfos-open-chat'
      ? openChat(document, location.href, ask.threadId)
      : ask.type === 'hfos-scroll-chats'
        ? scrollChats(document, location.href)
        : ask.type === 'hfos-scroll-list'
          ? scrollList(document, location.href)
          : ask.type === 'hfos-scroll-page'
            ? scrollPage(document, location.href)
            : scrollFeed(location.href);
  return { ok };
}

/** The kinds of ask a Facebook tab answers besides reading: the runner's and the asks' steps. */
export const WORK_ASKS: ReadonlySet<string> = new Set([
  'hfos-fetch-step',
  'hfos-fetch-path',
  'hfos-open-chat',
  'hfos-scroll-chats',
  'hfos-scroll-feed',
  'hfos-scroll-list',
  'hfos-scroll-page',
  'hfos-their-posts',
  'hfos-like-post',
  'hfos-comment',
  'hfos-message',
  'hfos-join',
  'hfos-join-answer',
  'hfos-group-post',
  'hfos-engaged',
  'hfos-own-profile',
  'hfos-write-bio',
  'hfos-try',
]);

type WorkAsk = FetchAsk | BrowseAsk | AutoAsk | JoinAsk | GroupPostAsk | OwnProfileAsk | TryAsk;

/** Does one of the background's asks in this tab, and answers how it went; null for one that isn't Facebook's work. */
export function work(ask: { readonly type: string }): Promise<unknown> | null {
  if (!WORK_ASKS.has(ask.type)) return null;
  const known = ask as WorkAsk;
  switch (known.type) {
    case 'hfos-join':
    case 'hfos-join-answer':
      return joinStep(known);
    case 'hfos-own-profile':
    case 'hfos-write-bio':
    case 'hfos-write-about':
      return ownProfileStep(known);
    case 'hfos-group-post':
    case 'hfos-engaged':
      return groupPostStep(known);
    case 'hfos-their-posts':
    case 'hfos-like-post':
    case 'hfos-comment':
    case 'hfos-message':
      return autoStep(known);
    case 'hfos-open-chat':
    case 'hfos-scroll-chats':
    case 'hfos-scroll-feed':
    case 'hfos-scroll-list':
    case 'hfos-scroll-page':
      return Promise.resolve(browseStep(known));
    case 'hfos-fetch-step':
    case 'hfos-fetch-path':
      return fetchStep(known);
    case 'hfos-try':
      return tryStep(known);
  }
}
