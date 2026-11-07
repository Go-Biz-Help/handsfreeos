/**
 * Where Social Outreach's pages are, for the Assistant (its manifest's `ai.places`): each the way there from the side
 * menu, a click at a time, in the screens' own words, then what is on it and how to do what people ask about there. Said
 * only to people in a business it runs in (the worker's per-business context), never in the fixed instructions.
 *
 * Every arrow is a click: the side menu's Social Outreach row, then its page (the manifest's `ui.nav`), then a part on
 * the page's own row (People's views, Find people's parts, the Settings menu). test/addons/outreach-places.test.ts holds
 * them to those words. Browser-safe and pure.
 */
import type { AppPlace } from '../../assistant/places-map';
import { NETWORKS, PLATFORM_KEYS, PLATFORMS } from './networks';
import { OUTREACH_PAGE_ABOUT, OUTREACH_PAGES } from './pages';
import { LEFT_ALONE, PEOPLE_VIEWS } from './people-views';
import { NEXT_NETWORKS, SETTINGS_WORDS } from './settings-parts';
import { OUTREACH_WORDS } from './words';

const NAME = 'Social Outreach';
const P = OUTREACH_PAGES;
const S = SETTINGS_WORDS;
const PARTS = OUTREACH_WORDS.settingsParts;
const about = (line: string) => line.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase());
const views = Object.values(PEOPLE_VIEWS).join(', ');
/** Its Settings open someone else's, for owners and admins, at `?for=` their user id. */
const WHOSE = { for: 'user' } as const;
const PERSON_MENU =
  'press a person’s name for their menu: Add to Contacts, Mark as client, Demo booked, Potential partner, Later, Don’t pitch, Never contact, and open their page or their chat';

/** Its pages, in the side menu's order, and the pages inside them. Paths are under the add-on's own (`/a/outreach`). */
export const OUTREACH_PLACES: readonly AppPlace[] = [
  {
    label: P.setup,
    what: about(OUTREACH_PAGE_ABOUT.setup),
    where: [NAME, P.setup],
    onScreen: [
      'Your business, Your computer and You, each with its steps and how many are done; then a short setup for each network',
      'The extension’s step: Download it, then unzip it, Developer mode (chrome://extensions), Load unpacked, Pin it and sign in, with Stuck? under them',
    ],
    howTo: [
      'Carry on with the setup: the next step left on Set up',
      'Get the extension: Set up, the extension’s step, Download it (or Settings → Your computer)',
    ],
    path: 'set-up',
  },
  {
    label: P['needs-you'],
    what: about(OUTREACH_PAGE_ABOUT['needs-you']),
    where: [NAME, P['needs-you']],
    onScreen: [
      'Replies handed over to you, each with OK, Change and Skip',
      'Messages to OK, with Approve all, and each message’s OK, Change and Skip',
      'Steps it needs you for: each with its link, I did it or Let it go, and Retry; Retry all',
      'Friend requests to decide: Confirm, Delete or Leave',
    ],
    howTo: [
      'OK every message at once: Needs you, Approve all',
      'Try the steps it couldn’t do again: Needs you, Retry all (or Retry on one)',
    ],
    canChange: [
      'OK, change or skip a message or reply, approve them all, retry or clear a step, and confirm, delete or leave a friend request',
    ],
    path: 'needs-you',
  },
  {
    label: P.today,
    what: about(OUTREACH_PAGE_ABOUT.today),
    where: [NAME, P.today],
    onScreen: [
      'The network picker at the top (the networks the person works)',
      'What the computer is doing now, with Start my day or Stop for today',
      'Today’s list: each row’s name (its person menu), open their page, the post or their chat, and Copy for a draft',
      'Why no new friend requests are on it, the day’s goal and the daily limits; Done today',
    ],
    howTo: [
      'Start or stop the extension’s day: Today, Start my day or Stop for today',
      `Do more for someone on the list: ${PERSON_MENU}`,
    ],
    canChange: [
      'start or stop the day, note a draft sent, mark where someone stands, book their time, and put someone on Later',
    ],
    path: 'today',
  },
  {
    label: P.people,
    what: about(OUTREACH_PAGE_ABOUT.people),
    where: [NAME, P.people],
    onScreen: [
      `A row of views: ${views}; under Left alone, ${Object.values(LEFT_ALONE).join(', ')}`,
      'Every network or one, a search by name, and Run now for the jobs the computer can run on the list',
    ],
    howTo: [
      'See partners: Social Outreach → People → Partners',
      'See friends, the requests got or sent: Social Outreach → People → Friends, Requests or Sent',
      'Take someone off Don’t pitch or Never contact: Social Outreach → People → Left alone, then their list',
      `Do more for someone: ${PERSON_MENU}`,
    ],
    path: 'people',
  },
  {
    label: PEOPLE_VIEWS.friends,
    what: 'the person’s own friends on a network as the extension saved them, with Good fits, Requests, Sent and the lists Left alone keeps',
    where: [NAME, P.people, PEOPLE_VIEWS.friends],
    onScreen: [
      'Yours, and the business’s Don’t pitch and Never contact; each friend’s fit and what the AI made of them',
      'Tidy up: tick people to cancel or unfriend',
    ],
    howTo: ['Cancel every request waiting: People → Sent, Cancel all'],
    path: 'people/friends',
  },
  {
    label: PEOPLE_VIEWS.chats,
    what: 'the person’s own chats, brought in from their download files or read as they opened them',
    where: [NAME, P.people, PEOPLE_VIEWS.chats],
    onScreen: [
      'Likely prospects, Tagged, All read and Not read yet, the tags, and each chat’s summary, next step and Open in Messenger (or the network’s own messaging)',
      'Save to their card, Add to Contacts and Don’t pitch on a chat’s row',
    ],
    howTo: [],
    path: 'people/chats',
  },
  {
    label: PEOPLE_VIEWS.partners,
    what: 'the people the person asks to partner: group admins, creators and businesses with the same customers, by stage',
    where: [NAME, P.people, PEOPLE_VIEWS.partners],
    onScreen: ['Each partner’s stage, why, and what to do next'],
    howTo: [],
    path: 'people/partners',
  },
  {
    label: LEFT_ALONE.country,
    what: 'people the business’s country setting skips',
    where: [NAME, P.people, PEOPLE_VIEWS.left_alone],
    then: `press ${LEFT_ALONE.country}`,
    onScreen: ['Each person skipped, with Unskip'],
    howTo: [],
    path: 'people/skipped',
  },
  {
    label: P.find,
    what: about(OUTREACH_PAGE_ABOUT.find),
    where: [NAME, P.find],
    onScreen: [
      `${OUTREACH_WORDS.findParts.ways} and ${OUTREACH_WORDS.findParts.groups}`,
      'Every way: a card for each way it finds people (groups, good posts, searches, accounts like yours, events, followers, partners), with this week’s numbers; and bringing in the person’s Facebook file',
    ],
    howTo: ['See the groups: Social Outreach → Find people → Groups'],
    path: 'find',
  },
  {
    label: OUTREACH_WORDS.findParts.groups,
    what: 'the groups the person works, scored against the playbooks, and the business’s',
    where: [NAME, P.find, OUTREACH_WORDS.findParts.groups],
    onScreen: [
      'The groups that bring results, how groups are scored, and Save my groups or Check my groups',
      'Press a group for its own page: its people who fit, its admins, and who works it',
    ],
    howTo: ['Open a group’s page: Social Outreach → Find people → Groups, then press the group'],
    path: 'find/groups',
  },
  {
    label: P.results,
    what: about(OUTREACH_PAGE_ABOUT.results),
    where: [NAME, P.results],
    onScreen: ['Friends made, chats and calls booked, by network, and which openers work'],
    howTo: [],
    path: 'results',
  },
  {
    label: P.playbooks,
    what: about(OUTREACH_PAGE_ABOUT.playbooks),
    where: [NAME, P.playbooks],
    onScreen: [
      'In use and Archived; press a playbook to open it',
      `${OUTREACH_WORDS.newPlaybook}: ${OUTREACH_WORDS.blank}, or start from a ready-made one (CRM demos, real estate, home services, coaching)`,
    ],
    howTo: [
      'Write a new playbook: Social Outreach → Playbooks, New playbook',
      'Put one away: open it, then Archive (Bring back undoes it)',
    ],
    canChange: [
      'write a playbook or change any part of one, start one from a ready-made one, and archive or bring one back',
    ],
    path: 'playbooks',
  },
  {
    label: 'A playbook',
    what: 'one playbook, part by part, as owners and admins write it',
    where: [NAME, P.playbooks],
    then: 'press the playbook',
    onScreen: [
      Object.values(OUTREACH_WORDS.playbookSections).join(', '),
      'Where they book or buy, with Your booking pages to pick one of the business’s own',
    ],
    howTo: [],
    path: 'playbooks/[playbookId]',
  },
  {
    label: P.gear,
    what: about(OUTREACH_PAGE_ABOUT.gear),
    where: [NAME, P.gear],
    onScreen: [
      `A menu: ${S.menu.you} (${S.generalRow}); ${S.menu.networks} (${PLATFORM_KEYS.map((p) => PLATFORMS[p]).join(', ')}, each On or Off, and ${NEXT_NETWORKS.join(', ')} marked ${S.soon}); ${S.menu.computer} (${PARTS.computer}); ${S.menu.owners} (${PARTS.videos}, ${PARTS.team} and ${PARTS.fresh}, for owners and admins)`,
      `${S.general}: how the AI writes for them, their working hours and alerts, on every network. ${S.autosaves}`,
    ],
    howTo: [
      'Change what the extension does on a network: Social Outreach → Settings, then the network’s name under Networks',
      'Change what the team may pick, the daily limits for everyone or Autopilot allowed: Social Outreach → Settings → Team',
    ],
    canChange: [
      'change any of these for the person, and for an owner or admin anyone’s, the team’s rules and the video library',
    ],
    notHere: [
      'Start fresh, which deletes the add-on’s data: the owner types the name on Start fresh themselves',
    ],
    path: 'settings',
    queryIds: WHOSE,
  },
  ...PLATFORM_KEYS.map((p): AppPlace => ({
    label: `${PLATFORMS[p]} in Social Outreach`,
    what: about(S.networkAbout(PLATFORMS[p])),
    where: [NAME, P.gear, PLATFORMS[p]],
    onScreen: [
      `${S.onForYou}; Autopilot; what goes on its own (sending, replies, posting) and along the way; ${NETWORKS[p].words.friendRequests} answered; ${S.yourLimits(PLATFORMS[p])}`,
    ],
    howTo: [],
    path: `settings/${p}`,
    queryIds: WHOSE,
  })),
  {
    label: PARTS.computer,
    what: about(S.computerAbout),
    where: [NAME, P.gear, PARTS.computer],
    onScreen: [
      'The computers signed in, with when each was last seen',
      'Download the extension, with How to install it folded under it',
      'Every job the computer can be asked to run now',
    ],
    howTo: ['Get the extension again or a newer one: Social Outreach → Settings → Your computer'],
    path: 'settings/computer',
    queryIds: WHOSE,
  },
  {
    label: PARTS.videos,
    what: 'the business’s video library: what the AI may send in follow-ups, after a missed demo and in replies (until it’s first saved, the playbooks’ short videos, with a note saying so)',
    where: [NAME, P.gear, PARTS.videos],
    onScreen: [
      'Each video’s name, link and what it shows and when it helps; Add a video, change or remove one',
    ],
    howTo: [],
    path: 'settings/videos',
    queryIds: WHOSE,
  },
  {
    label: PARTS.team,
    what: about(S.teamPageAbout),
    where: [NAME, P.gear, PARTS.team],
    onScreen: [
      `${S.people}: each teammate’s ${S.theirSettings} and their training wheels`,
      `${S.team}: who goes in Contacts, cancelling old requests, people found a day, the morning push, the weekly report, countries, what the team may pick, where a new person starts, Autopilot allowed and the extension’s link`,
      `${S.networksTitle}: ${S.networksAbout.replace(/\.$/, '')}`,
    ],
    howTo: [
      'See or change a teammate’s choices: Social Outreach → Settings → Team, then Their settings beside them',
    ],
    path: 'settings/team',
    queryIds: WHOSE,
  },
];

/**
 * The same word somewhere else in HandsFreeOS, said while Social Outreach runs, so "team" or "people" goes to the
 * right page.
 */
export const OUTREACH_LOOK_ALIKES: readonly string[] = [
  'Team: Social Outreach → Settings → Team is what the business allows its people in Social Outreach; teammates themselves are Members, and who may use Social Outreach at all is Settings → Permissions (an owner sets it).',
  'People: Social Outreach → People is everyone reached on the social networks; customers are Contacts, and Add to Contacts in a person’s menu puts one there.',
  'On the phone, Social Outreach is its own row at the top of More.',
];
