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
 * - On a good post its search found (decision 92), who commented and who reacted, from the box its reactions count
 *   opens, which it closes again (./compose.ts).
 * - On the post search, each post's own link from its menu's Copy link to post, caught before it reaches the person's
 *   clipboard (decision 123, ./post-links.ts).
 * - Once the person lets LinkedIn's runner work on its own (src/auto/linkedin.ts), on the pages of people on their
 *   list for today: their posts read and one liked (on their activity, or the post a search found on its own page),
 *   Connect without a note, the comment the AI drafted, and the messages they OK'd (./auto.ts).
 *
 * Runs in the tab, on the page in front of it: it uses the tab's own document and address.
 */
import type {
  AutoAnswer,
  AutoAsk,
  BrowseAnswer,
  CommentLikeAnswer,
  CommentLikeAsk,
  TheirCommentAnswer,
  TheirCommentAsk,
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
  PostLinksAnswer,
  PostLinksAsk,
  PostPeopleAnswer,
  PostPeopleAsk,
  WriteNameAsk,
  TryAnswer,
  TryAsk,
  PostsAnswer,
  WithdrawAnswer,
  WithdrawAsk,
  WritePartAnswer,
  WritePartAsk,
} from '../../messages';
import { writeLinkedInPart } from './parts';
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
import {
  likeTheirComment,
  postPeopleOn,
  theirComment,
  readComments,
  readReactions,
  writeFeedPost,
} from './compose';
import { dataPage } from './data';
import { postLinksOn } from './post-links';
import {
  loadWholeProfile,
  readOwnProfile,
  writeAbout,
  writeHeadline,
  writeName,
} from './own-profile';
import { classifyUrl } from './urls';
import {
  tryComment,
  tryConnect,
  tryFile,
  tryAboutStep,
  tryHeadlineStep,
  tryLike,
  tryMessage,
  tryMessagePage,
  tryPost,
  tryReactors,
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
  'hfos-write-about',
  'hfos-write-name',
  'hfos-write-part',
  'hfos-withdraw',
  'hfos-their-posts',
  'hfos-like-post',
  'hfos-their-comment',
  'hfos-like-comment',
  'hfos-connect',
  'hfos-comment',
  'hfos-message',
  'hfos-open-message',
  'hfos-fetch-step',
  'hfos-fetch-path',
  'hfos-feed-post',
  'hfos-engaged',
  'hfos-post-people',
  'hfos-post-links',
  'hfos-try',
]);

type WorkAsk =
  | Extract<BrowseAsk, { type: 'hfos-open-chat' | 'hfos-scroll-chats' | 'hfos-scroll-list' }>
  | OwnProfileAsk
  | WriteNameAsk
  | WritePartAsk
  | TryAsk
  | WithdrawAsk
  | AutoAsk
  | ConnectAsk
  | OpenMessageAsk
  | FetchAsk
  | FeedPostAsk
  | Extract<GroupPostAsk, { type: 'hfos-engaged' }>
  | PostPeopleAsk
  | PostLinksAsk
  | TheirCommentAsk
  | CommentLikeAsk;

/** Whether the tab shows a profile: the person's own, after linkedin.com/in/me/ took it there. */
const onProfile = (href: string) => {
  const kind = classifyUrl(href).kind;
  return kind === 'profile' || kind === 'own-profile';
};

/**
 * One of decision 99's parts (./parts.ts), only on the person's own pages: their profile, its posts and Add position,
 * and Public profile & URL.
 */
async function writePartStep(ask: WritePartAsk): Promise<WritePartAnswer> {
  const path = new URL(location.href).pathname;
  if (
    !onProfile(location.href) &&
    !/^\/(in\/[^/]+\/(edit|recent-activity|overlay)\/|public-profile\/settings)/i.test(path)
  )
    return { ok: false, error: 'LinkedIn didn’t open your profile.' };
  return { ok: true, ...(await writeLinkedInPart(document, location.href, ask.part)) };
}

/** The person's own profile: read it for the AI's check, or put the headline in. */
async function ownProfileStep(ask: OwnProfileAsk | WriteNameAsk): Promise<OwnProfileAnswer> {
  if (!onProfile(location.href)) return { ok: false, error: 'LinkedIn didn’t open your profile.' };
  if (ask.type === 'hfos-own-profile') {
    // LinkedIn draws the parts below the top only as they come into view.
    const load = await loadWholeProfile(document);
    return { ok: true, read: readOwnProfile(document, location.href), load };
  }
  if (ask.type === 'hfos-write-about') {
    const { result, steps } = await writeAbout(document, location.href, ask.about);
    return { ok: true, result, aboutSteps: steps };
  }
  // Its name, in the intro's First name and Last name (decision 84).
  if (ask.type === 'hfos-write-name')
    return { ok: true, result: await writeName(document, ask.name) };
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
    case 'about':
      return onProfile ? { ok: true, tried: await tryAboutStep(document) } : wrong('your profile');
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
      // On their activity, or on the post a search found, on its own page (decision 92).
      return (onProfile || kind === 'activity' || kind === 'post') && ask.profile
        ? { ok: true, tried: tryLike(document, location.href, ask.profile) }
        : wrong('their posts');
    case 'reactors':
      return kind === 'post'
        ? { ok: true, tried: await tryReactors(document, location.href) }
        : wrong('the post');
    case 'withdraw':
      return sentPage(location.href)
        ? { ok: true, tried: tryWithdraw(document, location.href) }
        : wrong('the invitations you’ve sent');
    case 'file':
      return dataPage(location.href)
        ? { ok: true, tried: tryFile(document) }
        : wrong('its Get a copy of your data page');
    default:
      // A step of another network's Check: said, never left unanswered.
      return { ok: false, error: 'The extension doesn’t try that on LinkedIn.' };
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

/**
 * The helpful post (./compose.ts): put up on the feed, or who engaged read on the post's own page; and a good post's
 * people, on its own.
 */
async function postStep(
  ask: FeedPostAsk | Extract<GroupPostAsk, { type: 'hfos-engaged' }> | PostPeopleAsk,
): Promise<FeedPostAnswer | GroupPostAnswer | PostPeopleAnswer> {
  const kind = classifyUrl(location.href).kind;
  if (ask.type === 'hfos-feed-post') {
    if (kind !== 'feed') return { ok: false, error: 'LinkedIn didn’t open your feed.' };
    return { ok: true, ...(await writeFeedPost(document, location.href, ask.text)) };
  }
  if (kind !== 'post') return { ok: false, error: 'LinkedIn didn’t open the post.' };
  if (ask.type === 'hfos-post-people')
    return { ok: true, ...(await postPeopleOn(document, location.href, ask.writer)) };
  return {
    ok: true,
    comments: readComments(document, location.href),
    reactions: await readReactions(document, location.href),
  };
}

/** Each post's own link on the post search, from its menu (decision 123, ./post-links.ts): only on the search. */
async function linksStep(ask: PostLinksAsk): Promise<PostLinksAnswer> {
  if (classifyUrl(location.href).kind !== 'search-posts')
    return { ok: false, error: 'LinkedIn didn’t open the post search.' };
  return postLinksOn(document, location.href, ask.most, ask.skip);
}

/** Their comment on a good post (decision 116), read then liked, only on the post's own page (./compose.ts). */
async function commentStep(
  ask: TheirCommentAsk | CommentLikeAsk,
): Promise<TheirCommentAnswer | CommentLikeAnswer> {
  if (classifyUrl(location.href).kind !== 'post')
    return { ok: false, error: 'LinkedIn didn’t open the post.' };
  if (ask.type === 'hfos-their-comment')
    return { ok: true, comment: theirComment(document, location.href, ask.profile, ask.postUrl) };
  return {
    ok: true,
    ...(await likeTheirComment(document, location.href, ask.profile, ask.postUrl)),
  };
}

/** The runner's steps (./auto.ts), each only on its own kind of page. */
async function autoStep(
  ask: AutoAsk | ConnectAsk | OpenMessageAsk,
): Promise<AutoAnswer | PostsAnswer | BrowseAnswer> {
  const kind = classifyUrl(location.href).kind;
  // Their profile, their activity, or (decision 92) the post of theirs a search found, liked on its own page.
  const onTheirs = kind === 'profile' || kind === 'activity' || kind === 'post';
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
    case 'hfos-write-about':
    case 'hfos-write-name':
      return ownProfileStep(known);
    case 'hfos-write-part':
      return writePartStep(known);
    case 'hfos-withdraw':
      return withdrawStep(known);
    case 'hfos-their-posts':
    case 'hfos-like-post':
    case 'hfos-connect':
    case 'hfos-comment':
    case 'hfos-message':
    case 'hfos-open-message':
      return autoStep(known);
    case 'hfos-their-comment':
    case 'hfos-like-comment':
      return commentStep(known);
    case 'hfos-fetch-step':
    case 'hfos-fetch-path':
      return fetchStep(known);
    case 'hfos-feed-post':
    case 'hfos-engaged':
    case 'hfos-post-people':
      return postStep(known);
    case 'hfos-post-links':
      return linksStep(known);
    case 'hfos-try':
      return tryStep(known);
  }
}
