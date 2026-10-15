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
} from '../../messages';
import { likeTheirPost, readTheirPosts, writeComment, writeMessage } from './auto';
import { openChat, scrollChats, scrollFeed, scrollList, scrollPage } from './browse';
import { readComments, readReactions, writeGroupPost } from './compose';
import { doPath, doStep, fetchPage, type StepResult } from './fetch';
import { requestsPage } from './friends';
import { answerJoin, pressJoin } from './join';
import { readOwnProfile, writeBio } from './own-profile';
import { tidyPage } from './tidy';
import { classifyUrl } from './urls';

/** How often a step that isn't on the page yet is looked for again, while Facebook draws the next screen. */
const LOOK_AGAIN_MS = 300;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

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
  const until = Date.now() + ask.waitMs;
  for (;;) {
    let result: StepResult;
    let at: number | undefined;
    if (ask.type === 'hfos-fetch-step') result = doStep(document, ask.step);
    else {
      const went = doPath(document, ask.steps, ask.from);
      result = 'at' in went ? 'done' : went.result;
      at = 'at' in went ? went.at : undefined;
    }
    if (result === 'done' || result === 'already' || result === 'stop' || Date.now() >= until)
      return { ok: true, result, at };
    await pause(LOOK_AGAIN_MS);
  }
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
  return { ok: true, result: await writeBio(document, ask.bio) };
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
]);

type WorkAsk = FetchAsk | BrowseAsk | AutoAsk | JoinAsk | GroupPostAsk | OwnProfileAsk;

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
  }
}
