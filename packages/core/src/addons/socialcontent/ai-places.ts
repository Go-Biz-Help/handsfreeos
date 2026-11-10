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
const K = W.calendar;
const O = W.post;

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
      `Each idea: its network, format, title, ${I.hook}, ${I.outline}, ${I.why} and the standouts it’s based on; ${I.write} (the AI writes the post and opens it on the ${P.calendar}), ${I.save}, ${I.use} and ${I.skip} (or ${I.again} on used and skipped ones)`,
    ],
    howTo: [
      'New ideas come on their own each time the Playbook is written, while fewer than 5 new ones wait',
      `More ideas: ${I.get}. It needs a Playbook first`,
      `Turn an idea into a post: ${I.write}. It goes on the next open day in the plan for its network, waiting for an OK`,
    ],
    canChange: [
      'get ideas, write the post from an idea, and save, mark used, skip or put back an idea',
    ],
    path: 'ideas',
  },
  {
    label: P.calendar,
    what: 'the business’s own posts for today and the next two weeks, written by the AI, each waiting for an OK',
    where: [NAME, P.calendar],
    onScreen: [
      `${K.fill}, ${K.approveWeek} (when posts wait for an OK) and ${K.write}`,
      `When it was last filled and when it fills again, ${K.plan} (how many posts a week on each network and at what time), how many are OK’d and going up, whose computer puts them up and when it last checked in`,
      `Each day: its posts (network, time, format, ${O.states.draft}, ${O.states.ready}, ${O.states.skipped} and the rest, the picture, title and first line, and what one still needs before it can go) and each ${K.open} with ${K.writeFor}; posts with ${K.undated} below`,
      `Opening a post: ${O.title}, ${O.network}, ${O.format}, ${O.when} and ${O.time}, ${O.facebookWhere} on Facebook, ${O.hook}, ${O.words}, ${O.hashtags}, ${O.slides} on a carousel and ${O.script} on a video`,
      `Its ${O.picture}: ${O.ways.design} (words on a picture in the business’s colour), ${O.ways.photo} (9¢ each) or ${O.ways.own}; ${O.makeAgain} with ${O.makeAsk}, ${O.switchTo(O.ways.design)} or ${O.switchTo(O.ways.photo)}, ${O.upload} and ${O.remove}`,
      `On a video: ${O.video}, with ${O.addVideo} or ${O.otherVideo} (up to 25 MB) and ${O.remove}`,
      `${O.save}, ${O.approve} or ${O.takeBack}, ${O.postNow}, ${O.skip} or ${O.restore}, and ${O.rewrite} with ${O.rewriteAsk}`,
      `Once it went up: ${O.seeIt.profile}, ${O.seeIt.page}, ${O.seeIt.feed('LinkedIn')} or ${O.seeIt.feed('Instagram')}; when it ${O.didntPost.toLowerCase()}, why, and ${O.postNow} to try again (places it already went up in are left out); ${O.copy} on networks posted by hand for now`,
    ],
    howTo: [
      `Fill two weeks of posts: ${K.fill}. The AI writes one for each open day in the plan from saved ideas, new ideas and the Playbook, and tops up once a week on its own after the first time`,
      `OK posts: ${O.approve} on one, or ${K.approveWeek} for every post waiting in the next 7 days that’s ready. Changing an OK’d post takes the OK back`,
      `Change how often and when: ${NAME} → ${P.gear} → ${G.posting} (owners and admins)`,
      `Facebook posts go to the person’s profile, their Page or both; posting to the Page needs its link in ${NAME} → ${P.gear} → ${G.posting}`,
      'OK’d posts on Facebook (profile, Page or both), LinkedIn and Instagram go up at their times from the reading computer, in Chrome with the HandsFreeOS Social extension, while Chrome is open there (a Page’s post goes through Meta Business Suite, so the person’s profile isn’t switched). Up to a day late if that computer was off; after that they’re marked as didn’t post',
      `Put one up now: ${O.postNow}. It counts as the OK`,
      `A video post goes up with the person’s own video: record it from the script, then ${O.addVideo} on the post (up to 25 MB). It can’t be OK’d until it has one`,
    ],
    canChange: [
      'fill the calendar, write a post (for an open day, a network or from an idea), change a post’s words, day, time and picture, make its picture again or switch its kind, OK it or the whole week, take the OK back, put it up now, skip it or bring it back, and write it again',
    ],
    path: 'calendar',
  },
  {
    label: P.gear,
    what: 'the networks studied, whose computer reads them, watching videos, the posting plan, and what the reading computer is doing',
    where: [NAME, P.gear],
    onScreen: [
      `${G.networks}: Instagram, Facebook and LinkedIn; TikTok and YouTube say ${G.coming}`,
      `${G.reader}: whose computer reads, ${G.readOnMine} and ${G.getExtension}`,
      `${V.title}: ${V.on} (off until turned on, with the notice that it uses a lot more AI) and ${V.tryIt} (up to 5 of the newest standout videos, once)`,
      `${G.posting}: posts a week and the time for Instagram, Facebook and LinkedIn, ${G.facebookPage} and ${G.facebookWhere} (profile, Page or both)`,
      `${G.doing}: what’s waiting, and what was asked lately with how it went, each waiting one with ${G.stop}`,
    ],
    howTo: [
      `Have your computer do the reading: ${G.readOnMine} (owners and admins), with the HandsFreeOS Social extension in Chrome, signed in`,
      `Stop something waiting: ${G.stop} on it under ${G.doing}`,
      `Test watching before turning it on: ${V.tryIt} (owners and admins)`,
    ],
    canChange: [
      'pick the networks, whose computer reads, whether new standout videos are watched, and the posting plan, Facebook Page and where Facebook posts go (owners and admins), try watching a few videos, and stop waiting work',
    ],
    path: 'settings',
  },
];

/** Words its pages share with core's, said outright so the Assistant doesn't mix them up. */
export const SOCIALCONTENT_LOOK_ALIKES: readonly string[] = [
  'Its Settings page is the add-on’s own (AI Social Media Content Creator → Settings), not the business’s Settings.',
  'Creators here are people outside the business whose posts it studies, never customers or contacts.',
  'Its Calendar is the business’s own social posts (AI Social Media Content Creator → Calendar), not the appointments Calendar.',
];
