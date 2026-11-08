/**
 * Where AI Social Media Content Creator's pages are, for the Assistant (its manifest's `ai.places`): each the way
 * there from the side menu, in the screens' own words (./words.ts), what's on it and how to do what people ask about
 * there. Its pages pop out of its one row in the side menu. Said only in businesses it runs in. Browser-safe and pure.
 */
import type { AppPlace } from '../../assistant/places-map';
import { DONE_WELL, STANDOUT } from './standouts';
import { SOCIALCONTENT_PAGES as P, SOCIALCONTENT_WORDS as W } from './words';

const NAME = W.title;
const N = W.niches;
const C = W.creators;
const S = W.standouts;
const G = W.settings;
const B = W.playbook;
const I = W.ideas;
const V = W.watch;

export const SOCIALCONTENT_PLACES: readonly AppPlace[] = [
  {
    label: P.creators,
    what: 'the niches searched for creators, and the creators found, studied and skipped',
    where: [NAME, P.creators],
    onScreen: [
      `${N.title}: ${N.own} and ${N.similar}, each with ${N.pick} or ${N.skip}; ${N.suggest} (the AI suggests the business’s niche and 3 to 5 like it); ${N.add}`,
      `${C.find}, and ${C.add} (paste a link to their page)`,
      `${C.tabs.suggested}, ${C.tabs.studying} and ${C.tabs.skipped}: each creator with their network, followers, last post, niche and why they were suggested; ${C.study} or ${C.skip} on suggested ones; on studied ones how many posts were read and stand out, ${C.readAgain}, ${C.seePosts} (their posts with how many times their normal each did) and ${C.stop}`,
    ],
    howTo: [
      `Find creators to learn from: tick niches under ${N.title} (or ${N.suggest} first), then ${C.find}. Creators with ${DONE_WELL.followersAtLeast.toLocaleString('en-US')}+ followers who posted in the last ${DONE_WELL.postedWithinDays} days show under ${C.tabs.suggested}`,
      `Study someone: ${C.study} on them under ${C.tabs.suggested}, or ${C.add} with a link to their page. Their posts are read back 12 months, then once a week`,
      `See why a post is a standout: ${C.seePosts} on a studied creator shows each post’s numbers against the posts around it`,
      `It needs a computer to read the networks: an owner or admin picks it in ${NAME} → ${P.gear} → ${G.reader}`,
    ],
    canChange: [
      'suggest niches, add a niche, tick or skip one, add a creator from a link, study or skip a creator, find creators now and read creators again now',
    ],
    path: 'creators',
  },
  {
    label: P.standouts,
    what: 'the studied creators’ posts that did much better than the posts around them',
    where: [NAME, P.standouts],
    onScreen: [
      `${S.allNetworks} and ${S.allCreators} to narrow it down`,
      `Each standout: the creator, the network, when it was posted, what kind it is, its caption, its numbers and how many times their normal it did (${S.on.views}, ${S.on.engagement} or ${S.on.both}), and ${S.open}`,
      `The AI’s notes on each: ${S.notes.why}, ${S.notes.hook}, ${S.notes.format}, ${S.notes.topic}, ${S.notes.techniques} and ${S.notes.useIt} (how the business could use it)`,
      `On a video the AI watched, ${S.watched.title}: ${S.watched.hook}, ${S.watched.seen}, ${S.watched.heard}, ${S.watched.pacing} and why it worked`,
    ],
    howTo: [
      `What counts: a post with at least ${STANDOUT.times} times the middle number of the ${STANDOUT.eachSide} posts on each side of it, on views or on likes plus comments. Posts under ${STANDOUT.waitDays} days old wait, since they’re still growing`,
      'The AI notes each new standout on its own a minute or two after its creator’s posts are read',
      `Have the AI watch the videos too: ${NAME} → ${P.gear} → ${V.title} (owners and admins). It uses a lot more AI`,
    ],
    path: 'standouts',
  },
  {
    label: P.playbook,
    what: 'what works for the creators studied, written by the AI from its notes on their standouts',
    where: [NAME, P.playbook],
    onScreen: [
      `A short summary, when it was written and from how many standouts, and ${B.write}`,
      `Sections (like hooks, formats, topics, captions and timing), each a numbered list of things to do with why it works and ${B.examples} (the standouts it came from, each opening the post)`,
    ],
    howTo: [
      'It’s written on its own once 3 standouts have notes, and again each time 5 more do',
      `Write it now: ${B.write}`,
    ],
    canChange: ['write the Playbook again now'],
    path: 'playbook',
  },
  {
    label: P.ideas,
    what: 'ideas for the business’s own posts, from the Playbook and its profile',
    where: [NAME, P.ideas],
    onScreen: [
      `${I.get}, and ${I.tabs.new}, ${I.tabs.saved}, ${I.tabs.used} and ${I.tabs.skipped}`,
      `Each idea: its network, format, title, ${I.hook}, ${I.outline}, ${I.why} and the standouts it’s based on; ${I.save}, ${I.use} and ${I.skip} (or ${I.again} on used and skipped ones)`,
    ],
    howTo: [
      'New ideas come on their own each time the Playbook is written, while fewer than 5 new ones wait',
      `More ideas: ${I.get}. It needs a Playbook first`,
    ],
    canChange: ['get ideas, and save, mark used, skip or put back an idea'],
    path: 'ideas',
  },
  {
    label: P.gear,
    what: 'the networks studied, whose computer reads them, watching videos, and what the reading computer is doing',
    where: [NAME, P.gear],
    onScreen: [
      `${G.networks}: Instagram, Facebook and LinkedIn; TikTok and YouTube say ${G.coming}`,
      `${G.reader}: whose computer reads, ${G.readOnMine} and ${G.getExtension}`,
      `${V.title}: ${V.on} (off until turned on, with the notice that it uses a lot more AI) and ${V.tryIt} (up to 5 of the newest standout videos, once)`,
      `${G.doing}: what’s waiting, and what was asked lately with how it went, each waiting one with ${G.stop}`,
    ],
    howTo: [
      `Have your computer do the reading: ${G.readOnMine} (owners and admins), with the HandsFreeOS Social extension in Chrome, signed in`,
      `Stop something waiting: ${G.stop} on it under ${G.doing}`,
      `Test watching before turning it on: ${V.tryIt} (owners and admins)`,
    ],
    canChange: [
      'pick the networks, whose computer reads and whether new standout videos are watched (owners and admins), try watching a few videos, and stop waiting work',
    ],
    path: 'settings',
  },
];

/** Words its pages share with core's, said outright so the Assistant doesn't mix them up. */
export const SOCIALCONTENT_LOOK_ALIKES: readonly string[] = [
  'Its Settings page is the add-on’s own (AI Social Media Content Creator → Settings), not the business’s Settings.',
  'Creators here are people outside the business whose posts it studies, never customers or contacts.',
];
