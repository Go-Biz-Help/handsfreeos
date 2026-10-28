/**
 * The kit of a network still looked at (../kit.ts; ./site.ts): Instagram's and Alignable's, built from their sites.
 * Their sites are let on from install (decision 85), and their script runs only while both Chrome allows it and HandsFreeOS says the network is on for them (../on.ts). There it reads the
 * network's warnings as the person goes, notes their steps where its site knows them, and answers Check <network>'s
 * asks (a page read and outlined, and a look for a step's button, never pressed) and those its site has: its lists,
 * the person's own profile, its runner's presses (`auto`: Alignable's and Instagram's; from 0.95.0 a comment and a
 * group's Join where the site declares them, decision 92), and, on Instagram, who wrote back in its chats. Where its
 * site has its own Accounts Center (Instagram's, decision 89), its tab may go there too, and answers Put these in's
 * asks for the username and the name there (../accounts-center/work.ts); those pages aren't its own (`owns`), so
 * nothing done there is noted.
 */
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import type {
  AutoAnswer,
  AutoAsk,
  BrowseAnswer,
  BrowseAsk,
  CodeAnswer,
  CodeAsk,
  ConnectAsk,
  JoinAnswer,
  JoinAsk,
  OpenMessageAsk,
  OwnProfileAnswer,
  OwnProfileAsk,
  PostsAnswer,
  TryAnswer,
  TryAsk,
  UnfollowAnswer,
} from '../../messages';
import { centerUrl } from '../accounts-center/pages';
import { CENTER_ASKS, centerWork, type CenterAsk } from '../accounts-center/work';
import { isWholeAddress, type Kit } from '../kit';
import { outlineLooking, readLooking, readWarnings } from './read';
import type { LookingSite } from './site';

/** Answers a look (`hfos-try`), only on the kinds of page its step is for. */
async function look(site: LookingSite, ask: TryAsk): Promise<TryAnswer> {
  const step = site.looks[ask.step];
  if (!step) return { ok: false, error: `The extension doesn’t look for that on ${site.name}.` };
  const url = site.url(location.href);
  const kind = url ? site.kindOf(url) : 'other';
  if (!step.on.includes('*') && !step.on.includes(kind))
    return { ok: false, error: `${site.name} didn’t open the page that step is on.` };
  return { ok: true, tried: await step.look(document, location.href) };
}

/**
 * The person's own profile (decision 80): read it for the AI's check, or put the bio or the About in, where the site
 * has one, and a code it emailed where it asks for one (decision 82).
 */
async function ownProfile(site: LookingSite, ask: OwnProfileAsk): Promise<OwnProfileAnswer> {
  const own = site.ownProfile;
  if (!own)
    return { ok: false, error: `The extension doesn’t read your ${site.name} profile yet.` };
  if (ask.type === 'hfos-own-profile') return { ok: true, read: own.read(document, location.href) };
  if (ask.type === 'hfos-write-about')
    return own.writeAbout
      ? { ok: true, result: await own.writeAbout(document, ask.about) }
      : { ok: false, error: `${site.name} has no About to put in.` };
  if (own.writeBioSteps) {
    const { result, steps } = await own.writeBioSteps(document, ask.bio);
    return { ok: true, result, formSteps: steps };
  }
  if (!own.writeBio)
    return { ok: false, error: `The extension doesn’t put your ${site.name} bio in yet.` };
  return { ok: true, result: await own.writeBio(document, ask.bio) };
}

/** A code the network emailed them, put in where it asks for it (decision 82). */
async function putCode(site: LookingSite, ask: CodeAsk): Promise<CodeAnswer> {
  const put = site.ownProfile?.putCode;
  if (!put) return { ok: false, error: `${site.name} asks for no code here.` };
  return { ok: true, code: await put(document, ask.code) };
}

/** The asks about its lists it answers, where its site has them: never Facebook's chats, feed or pages. */
type LookingBrowseAsk = Exclude<
  BrowseAsk,
  { type: 'hfos-scroll-chats' | 'hfos-scroll-feed' | 'hfos-scroll-page' }
>;
const BROWSE_ASKS: ReadonlySet<string> = new Set<LookingBrowseAsk['type']>([
  'hfos-scroll-list',
  'hfos-show-all',
  'hfos-open-chat',
  'hfos-open-likers',
  'hfos-more-comments',
  'hfos-close-dialog',
]);

/**
 * Its lists, for the person's asks: scrolled for more, switched to their tab of them all, or a chat opened; and from
 * 0.95.0 a good post's people (Instagram's, decision 92): its Likes box opened and closed, its comments shown.
 */
async function browse(site: LookingSite, ask: LookingBrowseAsk): Promise<BrowseAnswer> {
  const lists = site.lists;
  if (!lists) return { ok: false };
  if (ask.type === 'hfos-open-chat')
    return {
      ok: lists.openChat ? await lists.openChat(document, location.href, ask.name ?? null) : false,
    };
  const go = {
    'hfos-scroll-list': lists.scroll,
    'hfos-show-all': lists.showAll,
    'hfos-open-likers': lists.openLikers,
    'hfos-more-comments': lists.moreComments,
    'hfos-close-dialog': lists.closeDialog,
  }[ask.type];
  return { ok: go ? await go(document, location.href) : false };
}

/** Unfollows the account whose page the tab shows, where the site does (Instagram's tidying). */
async function unfollowHere(site: LookingSite): Promise<UnfollowAnswer> {
  if (!site.unfollow)
    return { ok: false, error: `The extension doesn’t unfollow on ${site.name}.` };
  return { ok: true, result: await site.unfollow(document) };
}

/**
 * The runner's presses it answers: their posts, a like, Connect (Follow), Message and a message; and from 0.95.0
 * (decision 92) a comment and a group's Join, only for a site that declares them (`auto.comment`, `auto.join`).
 */
export type OnItsOwnAsk = AutoAsk | ConnectAsk | OpenMessageAsk | JoinAsk;
export const ON_ITS_OWN_ASKS: ReadonlySet<string> = new Set<OnItsOwnAsk['type']>([
  'hfos-their-posts',
  'hfos-like-post',
  'hfos-connect',
  'hfos-open-message',
  'hfos-message',
  'hfos-comment',
  'hfos-join',
  'hfos-join-answer',
]);

/**
 * A comment, or a group's Join and its questions, on a site that declares them (decision 92): never anywhere else. A
 * comment says whose post it is and which, and goes only on that post's own page.
 */
async function commentOrJoin(
  site: LookingSite,
  ask: Extract<OnItsOwnAsk, { readonly type: 'hfos-comment' | 'hfos-join' | 'hfos-join-answer' }>,
): Promise<AutoAnswer | JoinAnswer> {
  const auto = site.auto;
  const href = location.href;
  if (ask.type === 'hfos-comment') {
    if (!auto?.comment)
      return { ok: false, error: `The extension doesn’t comment on ${site.name} on its own.` };
    if (!ask.profile || !ask.postUrl)
      return { ok: false, error: `The extension didn’t say whose post it is on ${site.name}.` };
    return {
      ok: true,
      result: await auto.comment(document, href, ask.text, {
        profile: ask.profile,
        postUrl: ask.postUrl,
      }),
    };
  }
  if (!auto?.join)
    return { ok: false, error: `The extension doesn’t join groups on ${site.name}.` };
  if (ask.type === 'hfos-join') return { ok: true, step: await auto.join(document, href) };
  // A site that asks no questions before a join says there were none to answer.
  return {
    ok: true,
    result: auto.answerJoin ? await auto.answerJoin(document, ask.answers) : 'none',
  };
}

/** One of its runner's presses, on a network whose site has them (Alignable's, Instagram's): none anywhere else. */
async function onItsOwn(
  site: LookingSite,
  ask: OnItsOwnAsk,
): Promise<PostsAnswer | AutoAnswer | BrowseAnswer | JoinAnswer> {
  if (ask.type === 'hfos-comment' || ask.type === 'hfos-join' || ask.type === 'hfos-join-answer')
    return commentOrJoin(site, ask);
  const auto = site.auto;
  if (!auto)
    return { ok: false, error: `The extension doesn’t work on ${site.name} on its own yet.` };
  const href = location.href;
  if (ask.type === 'hfos-their-posts')
    return { ok: true, posts: auto.theirPosts(document, href, ask.profile).slice(0, ask.most) };
  if (ask.type === 'hfos-like-post')
    return { ok: true, ...(await auto.like(document, href, ask.profile, ask)) };
  // Connect and a message say whose they are: nothing is pressed without it.
  if (!ask.profile)
    return { ok: false, error: `The extension didn’t say whose page it is on ${site.name}.` };
  if (ask.type === 'hfos-connect')
    return { ok: true, result: await auto.connect(document, href, ask.profile) };
  // Their account's Message, which opens a chat with them (Instagram's): whether it could.
  if (ask.type === 'hfos-open-message')
    return { ok: auto.openMessage ? auto.openMessage(document, href, ask.profile) : false };
  return { ok: true, result: await auto.message(document, href, ask.text, ask.profile) };
}

const OWN_PROFILE_ASKS = new Set(['hfos-own-profile', 'hfos-write-bio', 'hfos-write-about']);

/** An address on the site's own Accounts Center, made whole: its tab may go there, and nowhere else of Meta's. */
function centerWorkUrl(site: LookingSite, href: string): string | null {
  const at = site.accountsCenter ? centerUrl(href) : null;
  return at && at.network === site.accountsCenter ? at.url.href : null;
}

export function lookingKit(site: LookingSite): Kit {
  return {
    platform: site.platform,
    network: NETWORKS[site.platform],
    hosts: site.hosts,
    registered: true,
    startsOn: false,
    owns: (href) => isWholeAddress(href) && site.url(href) !== null,
    workUrl: (href) => site.url(href)?.toString() ?? centerWorkUrl(site, href),
    kindOf: (href) => {
      const url = site.url(href);
      return url ? site.kindOf(url) : 'other';
    },
    profileKey: (profile) =>
      `${site.platform}:${(profile.username ?? profile.id ?? profile.url).toLowerCase()}`,
    readPage: (doc, href) => readLooking(doc, href, site),
    readWarnings: (doc, href) => readWarnings(doc, href, site),
    // Who wrote back, where its site reads it (Instagram's chats, its part 13).
    readReplies: (doc, href) => site.replies?.(doc, href) ?? [],
    lookFor: () => 'warnings',
    noticer: () => site.noticer?.() ?? { click: () => null, enter: () => null },
    outline: (doc, href, options = {}) => outlineLooking(doc, href, site, options),
    work: (ask) =>
      site.accountsCenter && CENTER_ASKS.has(ask.type)
        ? centerWork(site.accountsCenter, ask as CenterAsk, (doc, href) =>
            readWarnings(doc, href, site),
          )
        : ask.type === 'hfos-try'
          ? look(site, ask as TryAsk)
          : OWN_PROFILE_ASKS.has(ask.type)
            ? ownProfile(site, ask as OwnProfileAsk)
            : ask.type === 'hfos-put-code'
              ? putCode(site, ask as CodeAsk)
              : BROWSE_ASKS.has(ask.type)
                ? browse(site, ask as LookingBrowseAsk)
                : ask.type === 'hfos-unfollow'
                  ? unfollowHere(site)
                  : ON_ITS_OWN_ASKS.has(ask.type)
                    ? onItsOwn(site, ask as OnItsOwnAsk)
                    : null,
  };
}
