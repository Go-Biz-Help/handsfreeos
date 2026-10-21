/**
 * The kit of a network still looked at (../kit.ts; ./site.ts): Instagram's and Alignable's, built from their sites.
 * Their sites are asked for when the person turns the network on (an optional host permission), and their script runs
 * only while both Chrome allows it and HandsFreeOS says the network is on for them (../on.ts). There it reads the
 * network's warnings as the person goes, notes their steps where its site knows them, and answers Check <network>'s
 * asks (a page read and outlined, and a look for a step's button, never pressed) and those its site has: its lists,
 * the person's own profile, its runner's presses (`auto`: Alignable's and Instagram's), and, on Instagram, who wrote
 * back in its chats.
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
  OpenMessageAsk,
  OwnProfileAnswer,
  OwnProfileAsk,
  PostsAnswer,
  TryAnswer,
  TryAsk,
  UnfollowAnswer,
} from '../../messages';
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

/** Its lists, for the person's asks: scrolled for more, switched to their tab of them all, or a chat opened. */
async function browse(
  site: LookingSite,
  ask: Extract<BrowseAsk, { type: 'hfos-scroll-list' | 'hfos-show-all' | 'hfos-open-chat' }>,
): Promise<BrowseAnswer> {
  const lists = site.lists;
  if (!lists) return { ok: false };
  if (ask.type === 'hfos-open-chat')
    return {
      ok: lists.openChat ? await lists.openChat(document, location.href, ask.name ?? null) : false,
    };
  const go = ask.type === 'hfos-scroll-list' ? lists.scroll : lists.showAll;
  return { ok: go ? await go(document, location.href) : false };
}

/** Unfollows the account whose page the tab shows, where the site does (Instagram's tidying). */
async function unfollowHere(site: LookingSite): Promise<UnfollowAnswer> {
  if (!site.unfollow)
    return { ok: false, error: `The extension doesn’t unfollow on ${site.name}.` };
  return { ok: true, result: await site.unfollow(document) };
}

/** The runner's presses it answers: their posts, a like, Connect (Follow), Message and a message. Never a comment. */
type OnItsOwnAsk =
  Exclude<AutoAsk, { readonly type: 'hfos-comment' }> | ConnectAsk | OpenMessageAsk;
const ON_ITS_OWN_ASKS = new Set([
  'hfos-their-posts',
  'hfos-like-post',
  'hfos-connect',
  'hfos-open-message',
  'hfos-message',
]);

/** One of its runner's presses, on a network whose site has them (Alignable's, Instagram's): none anywhere else. */
async function onItsOwn(
  site: LookingSite,
  ask: OnItsOwnAsk,
): Promise<PostsAnswer | AutoAnswer | BrowseAnswer> {
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

export function lookingKit(site: LookingSite): Kit {
  return {
    platform: site.platform,
    network: NETWORKS[site.platform],
    hosts: site.hosts,
    optional: true,
    startsOn: false,
    owns: (href) => isWholeAddress(href) && site.url(href) !== null,
    workUrl: (href) => site.url(href)?.toString() ?? null,
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
      ask.type === 'hfos-try'
        ? look(site, ask as TryAsk)
        : OWN_PROFILE_ASKS.has(ask.type)
          ? ownProfile(site, ask as OwnProfileAsk)
          : ask.type === 'hfos-put-code'
            ? putCode(site, ask as CodeAsk)
            : ask.type === 'hfos-scroll-list' ||
                ask.type === 'hfos-show-all' ||
                ask.type === 'hfos-open-chat'
              ? browse(site, ask as Parameters<typeof browse>[1])
              : ask.type === 'hfos-unfollow'
                ? unfollowHere(site)
                : ON_ITS_OWN_ASKS.has(ask.type)
                  ? onItsOwn(site, ask as OnItsOwnAsk)
                  : null,
  };
}
