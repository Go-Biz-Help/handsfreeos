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
    ],
    howTo: [
      `What counts: a post with at least ${STANDOUT.times} times the middle number of the ${STANDOUT.eachSide} posts on each side of it, on views or on likes plus comments. Posts under ${STANDOUT.waitDays} days old wait, since they’re still growing`,
    ],
    notHere: [
      'The AI’s notes on why each standout worked, the Playbook and content ideas come in a later update',
    ],
    path: 'standouts',
  },
  {
    label: P.gear,
    what: 'the networks studied, whose computer reads them, and what the reading computer is doing',
    where: [NAME, P.gear],
    onScreen: [
      `${G.networks}: Instagram for now; Facebook, LinkedIn, TikTok and YouTube say ${G.coming}`,
      `${G.reader}: whose computer reads, ${G.readOnMine} and ${G.getExtension}`,
      `${G.doing}: what’s waiting, and what was asked lately with how it went, each waiting one with ${G.stop}`,
    ],
    howTo: [
      `Have your computer do the reading: ${G.readOnMine} (owners and admins), with the HandsFreeOS Social extension in Chrome, signed in`,
      `Stop something waiting: ${G.stop} on it under ${G.doing}`,
    ],
    canChange: [
      'pick the networks and whose computer reads (owners and admins), and stop waiting work',
    ],
    path: 'settings',
  },
];

/** Words its pages share with core's, said outright so the Assistant doesn't mix them up. */
export const SOCIALCONTENT_LOOK_ALIKES: readonly string[] = [
  'Its Settings page is the add-on’s own (AI Social Media Content Creator → Settings), not the business’s Settings.',
  'Creators here are people outside the business whose posts it studies, never customers or contacts.',
];
