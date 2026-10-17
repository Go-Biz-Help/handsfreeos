/**
 * What the background asks a LinkedIn tab besides reading it, answered in the tab (../../content.ts): only for what
 * the person asked of the extension from HandsFreeOS (src/jobs/linkedin/; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
 * "LinkedIn, part by part", 4). Each step goes only on the page it's for, and says so anywhere else:
 *
 * - Their connections, their invitations, a search's results and messaging's list scrolled for more, and a
 *   conversation opened from that list (./browse.ts).
 * - Their own profile read for the AI's check, and the headline they picked put in (./own-profile.ts).
 * - On Sent invitations, the one to a member they ticked withdrawn (./withdraw.ts).
 * - On Get a copy of your data alone, the steps that ask for their archive and download it (./data.ts).
 * - Their helpful post put up on their own feed, and who engaged with one of theirs read (./compose.ts).
 * - Once the person lets LinkedIn's runner work on its own (src/auto/linkedin.ts), on the pages of people on their
 *   list for today: their posts read and one liked, Connect without a note, the comment the AI drafted, and the
 *   messages they OK'd (./auto.ts).
 *
 * Runs in the tab, on the page in front of it: it uses the tab's own document and address.
 */
import type {
  AutoAnswer,
  AutoAsk,
  BrowseAnswer,
  ConnectAsk,
  BrowseAsk,
  FeedPostAnswer,
  FeedPostAsk,
  FetchAnswer,
  FetchAsk,
  GroupPostAnswer,
  GroupPostAsk,
  OpenMessageAsk,
  OwnProfileAnswer,
  OwnProfileAsk,
  TryAnswer,
  TryAsk,
  PostsAnswer,
  WithdrawAnswer,
  WithdrawAsk,
} from '../../messages';
import {
  connect,
  likeTheirPost,
  openMessage,
  theirPosts,
  writeComment,
  writeMessage,
} from './auto';
import { stepOnPage } from '../facebook/fetch';
import { openChat, scrollChats, scrollList } from './browse';
import { readComments, readReactions, writeFeedPost } from './compose';
import { dataPage } from './data';
import { loadWholeProfile, readOwnProfile, writeHeadline } from './own-profile';
import { classifyUrl } from './urls';
import {
  tryComment,
  tryConnect,
  tryFile,
  tryHeadlineStep,
  tryLike,
  tryMessage,
  tryMessagePage,
  tryPost,
  tryWithdraw,
} from './tries';
import { sentPage, withdraw } from './withdraw';

/** The kinds of ask a LinkedIn tab answers besides reading. */
export const WORK_ASKS: ReadonlySet<string> = new Set([
  'hfos-open-chat',
  'hfos-scroll-chats',
  'hfos-scroll-list',
  'hfos-own-profile',
  'hfos-write-bio',
  'hfos-withdraw',
  'hfos-their-posts',
  'hfos-like-post',
  'hfos-connect',
  'hfos-comment',
  'hfos-message',
  'hfos-open-message',
  'hfos-fetch-step',
  'hfos-fetch-path',
  'hfos-feed-post',
  'hfos-engaged',
  'hfos-try',
]);

type WorkAsk =
  | Extract<BrowseAsk, { type: 'hfos-open-chat' | 'hfos-scroll-chats' | 'hfos-scroll-list' }>
  | OwnProfileAsk
  | TryAsk
  | WithdrawAsk
  | AutoAsk
  | ConnectAsk
  | OpenMessageAsk
  | FetchAsk
  | FeedPostAsk
  | Extract<GroupPostAsk, { type: 'hfos-engaged' }>;

/** Whether the tab shows a profile: the person's own, after linkedin.com/in/me/ took it there. */
const onProfile = (href: string) => {
  const kind = classifyUrl(href).kind;
  return kind === 'profile' || kind === 'own-profile';
};

/** The person's own profile: read it for the AI's check, or put the headline in. */
async function ownProfileStep(ask: OwnProfileAsk): Promise<OwnProfileAnswer> {
  if (!onProfile(location.href)) return { ok: false, error: 'LinkedIn didn’t open your profile.' };
  if (ask.type === 'hfos-own-profile') {
    // LinkedIn draws the parts below the top only as they come into view.
    const load = await loadWholeProfile(document);
    return { ok: true, read: readOwnProfile(document, location.href), load };
  }
  return { ok: true, ...(await writeHeadline(document, location.href, ask.bio)) };
}

/** Check LinkedIn's tries (./tries.ts), each only on the kind of page its step is for. */
async function tryStep(ask: TryAsk): Promise<TryAnswer> {
  const kind = classifyUrl(location.href).kind;
  const onProfile = kind === 'profile' || kind === 'own-profile';
  const wrong = (page: string): TryAnswer => ({
    ok: false,
    error: `LinkedIn didn’t open ${page}.`,
  });
  switch (ask.step) {
    case 'headline':
      return onProfile
        ? { ok: true, tried: await tryHeadlineStep(document) }
        : wrong('your profile');
    case 'post':
      return kind === 'feed' ? { ok: true, tried: await tryPost(document) } : wrong('your feed');
    case 'comment':
      return kind === 'post' ? { ok: true, tried: await tryComment(document) } : wrong('the post');
    case 'connect':
      return onProfile
        ? { ok: true, tried: await tryConnect(document, location.href) }
        : wrong('their profile');
    case 'message':
      if (!ask.profile) return wrong('their profile');
      // The second way: the page their profile's Message links to.
      if (kind === 'messaging' || kind === 'chat')
        return { ok: true, tried: tryMessagePage(document, location.href, ask.profile) };
      return onProfile
        ? { ok: true, tried: await tryMessage(document, location.href, ask.profile) }
        : wrong('their profile');
    case 'like':
      return (onProfile || kind === 'activity') && ask.profile
        ? { ok: true, tried: tryLike(document, location.href, ask.profile) }
        : wrong('their posts');
    case 'withdraw':
      return sentPage(location.href)
        ? { ok: true, tried: tryWithdraw(document, location.href) }
        : wrong('the invitations you’ve sent');
    case 'file':
      return dataPage(location.href)
        ? { ok: true, tried: tryFile(document) }
        : wrong('its Get a copy of your data page');
  }
}

/** Withdrawing an invitation, on Sent invitations alone. */
async function withdrawStep(ask: WithdrawAsk): Promise<WithdrawAnswer> {
  if (!sentPage(location.href))
    return { ok: false, error: 'LinkedIn didn’t open the invitations you’ve sent.' };
  return { ok: true, result: await withdraw(document, location.href, ask.profile) };
}

/** One of the file's steps (./data.ts), on Get a copy of your data alone, looked for till it shows. */
async function fetchStep(ask: FetchAsk): Promise<FetchAnswer> {
  if (!dataPage(location.href))
    return { ok: false, error: 'LinkedIn didn’t open its Get a copy of your data page.' };
  return { ok: true, ...(await stepOnPage(document, ask)) };
}

/** The helpful post (./compose.ts): put up on the feed, or who engaged read on the post's own page. */
async function postStep(
  ask: FeedPostAsk | Extract<GroupPostAsk, { type: 'hfos-engaged' }>,
): Promise<FeedPostAnswer | GroupPostAnswer> {
  const kind = classifyUrl(location.href).kind;
  if (ask.type === 'hfos-feed-post') {
    if (kind !== 'feed') return { ok: false, error: 'LinkedIn didn’t open your feed.' };
    return { ok: true, ...(await writeFeedPost(document, location.href, ask.text)) };
  }
  if (kind !== 'post') return { ok: false, error: 'LinkedIn didn’t open the post.' };
  return {
    ok: true,
    comments: readComments(document, location.href),
    reactions: await readReactions(document, location.href),
  };
}

/** The runner's steps (./auto.ts), each only on its own kind of page. */
async function autoStep(
  ask: AutoAsk | ConnectAsk | OpenMessageAsk,
): Promise<AutoAnswer | PostsAnswer | BrowseAnswer> {
  const kind = classifyUrl(location.href).kind;
  const onTheirs = kind === 'profile' || kind === 'activity';
  switch (ask.type) {
    case 'hfos-their-posts':
      if (!onTheirs) return { ok: false, error: 'LinkedIn didn’t open their posts.' };
      return {
        ok: true,
        posts: theirPosts(document, location.href, ask.profile)
          .map((f) => f.post)
          .slice(0, ask.most),
      };
    case 'hfos-like-post':
      if (!onTheirs) return { ok: false, error: 'LinkedIn didn’t open their posts.' };
      return { ok: true, ...(await likeTheirPost(document, location.href, ask.profile, ask)) };
    case 'hfos-connect':
      if (kind !== 'profile') return { ok: false, error: 'LinkedIn didn’t open their profile.' };
      return { ok: true, result: await connect(document, location.href) };
    case 'hfos-open-message':
      return { ok: kind === 'profile' && openMessage(document) };
    case 'hfos-comment':
      if (kind !== 'post') return { ok: false, error: 'LinkedIn didn’t open the post.' };
      return { ok: true, result: await writeComment(document, ask.text) };
    case 'hfos-message':
      // On their conversation's page, a new one Message opened for them, or their profile with its window over it.
      if ((kind !== 'chat' && kind !== 'messaging' && kind !== 'profile') || !ask.profile)
        return { ok: false, error: 'LinkedIn didn’t open a conversation with them.' };
      return {
        ok: true,
        result: await writeMessage(document, location.href, ask.text, ask.profile),
      };
  }
}

/** Does one of the background's asks in this tab, and answers how it went; null for one that isn't LinkedIn's work. */
export function work(ask: { readonly type: string }): Promise<unknown> | null {
  if (!WORK_ASKS.has(ask.type)) return null;
  const known = ask as WorkAsk;
  switch (known.type) {
    case 'hfos-open-chat':
      return Promise.resolve<BrowseAnswer>({
        ok: openChat(document, location.href, known.threadId),
      });
    case 'hfos-scroll-chats':
      return Promise.resolve<BrowseAnswer>({ ok: scrollChats(document, location.href) });
    case 'hfos-scroll-list':
      return Promise.resolve<BrowseAnswer>({ ok: scrollList(document, location.href) });
    case 'hfos-own-profile':
    case 'hfos-write-bio':
      return ownProfileStep(known);
    case 'hfos-withdraw':
      return withdrawStep(known);
    case 'hfos-their-posts':
    case 'hfos-like-post':
    case 'hfos-connect':
    case 'hfos-comment':
    case 'hfos-message':
    case 'hfos-open-message':
      return autoStep(known);
    case 'hfos-fetch-step':
    case 'hfos-fetch-path':
      return fetchStep(known);
    case 'hfos-feed-post':
    case 'hfos-engaged':
      return postStep(known);
    case 'hfos-try':
      return tryStep(known);
  }
}
