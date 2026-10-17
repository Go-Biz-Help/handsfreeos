/**
 * Alignable, still looked at (../looking/site.ts; docs/outreach.md decision 78): made for small businesses, by town:
 * connect, message, recommend, and a forum where owners ask for referrals (the plan's "The networks after LinkedIn").
 * Little about it is published, and its signed-in pages aren't public, so its addresses here are only what its public
 * pages and robots.txt show (a business at alignable.com/<town-st>/<business>/, its dashboard, its connection requests
 * and recommendations), and Check Alignable follows the site's own menus rather than addresses written here. On every
 * page it opens it looks for Connect, Message, Recommend, Like and a box to comment in, pressing none of them, and its
 * steps are built from what that reads.
 */
import { clean } from '../facebook/dom';
import { boxesSaying, controlsSaying, lookFor, mainOf, namesIn } from '../looking/looks';
import type { LookingSite } from '../looking/site';
import { went } from '../tries';

const HOST = 'www.alignable.com';
const HOSTS = new Set(['www.alignable.com', 'alignable.com']);

const partsOf = (url: URL) => url.pathname.split('/').filter(Boolean);

/** A town in its addresses: "austin-tx". */
const TOWN = /^[a-z0-9]+(-[a-z0-9]+)*-[a-z]{2}$/i;
/** A business's or a person's name in its addresses. */
const SLUG = /^[A-Za-z0-9_-]{1,100}$/;

function alignableUrl(href: string, base?: string): URL | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname.toLowerCase())) return null;
  url.hostname = HOST;
  url.hash = '';
  return url;
}

/** Its places by the first word of their addresses, as far as they're known: the rest are learned from Check. */
const PLACES: Readonly<Record<string, string>> = {
  dashboard: 'home',
  home: 'home',
  feed: 'home',
  inbox: 'inbox',
  messages: 'inbox',
  conversations: 'inbox',
  network: 'network',
  connections: 'network',
  my_network: 'network',
  'my-network': 'network',
  contact_requests: 'network',
  forum: 'forum',
  questions: 'forum',
  discussions: 'forum',
  posts: 'post',
  notifications: 'notifications',
  search: 'search',
  communities: 'community',
  community: 'community',
  groups: 'community',
  events: 'events',
  profile: 'own-profile',
  my_profile: 'own-profile',
  me: 'own-profile',
  biz: 'business',
  biz_users: 'settings',
  settings: 'settings',
  profile_recommendations: 'recommendations',
  recommendations: 'recommendations',
};

function kindOf(url: URL): string {
  const [first = '', second] = partsOf(url);
  if (!first) return 'home';
  const place = PLACES[first.toLowerCase()];
  if (place) return place;
  if (TOWN.test(first)) return second ? 'business' : 'town';
  return 'other';
}

function profileOf(url: URL): { username: string; url: string } | null {
  const [first = '', second = '', third] = partsOf(url);
  // A business in its town, and a person on it: /<town-st>/<business>/ and /<town-st>/<business>/<person>.
  if (!TOWN.test(first) || !SLUG.test(second)) return null;
  const who = third && SLUG.test(third) ? third : null;
  const path = who ? `${first}/${second}/${who}` : `${first}/${second}`;
  return {
    username: `${first}-${second}${who ? `-${who}` : ''}`.slice(0, 100),
    url: `https://${HOST}/${path}`,
  };
}

function postOf(url: URL): string | null {
  const [first = '', second] = partsOf(url).map((p) => p.toLowerCase());
  if (!second || !['forum', 'questions', 'discussions', 'posts'].includes(first)) return null;
  return `https://${HOST}${url.pathname}`;
}

/** Alignable's own words on its pages, as far as they're known: the outline keeps them, and hides the rest. */
const WORDS = new Set(
  [
    'Alignable',
    'Home',
    'Dashboard',
    'My Network',
    'Network',
    'Messages',
    'Inbox',
    'Notifications',
    'Forum',
    'Q&A',
    'Ask',
    'Answer',
    'Answers',
    'Questions',
    'Communities',
    'Community',
    'Groups',
    'Events',
    'Me',
    'Profile',
    'My Profile',
    'My Business',
    'Edit Profile',
    'Edit',
    'Connect',
    'Connected',
    'Connections',
    'Request Sent',
    'Pending',
    'Accept',
    'Ignore',
    'Decline',
    'Message',
    'Send',
    'Send Message',
    'Recommend',
    'Recommended',
    'Recommendations',
    'Like',
    'Liked',
    'Comment',
    'Comments',
    'Share',
    'Post',
    'Reply',
    'Follow',
    'Following',
    'Search',
    'People',
    'Businesses',
    'Suggested Connections',
    'People You May Know',
    'Invite',
    'Invitations',
    'Settings',
    'Log Out',
    'Sign Out',
    'Sign In',
    'View Profile',
    'See All',
    'See More',
    'Load More',
    'Upgrade',
    'Premium',
    'Discussion',
    'Discussions',
    'Trending',
    'Local',
    'Nearby',
    'Members',
    'Join',
    'Joined',
    'Leave',
    'Write a comment...',
    'Write a comment…',
    'Add a comment...',
    'Add a comment…',
    'Start a discussion',
    'Ask a question',
    'Mark all as read',
    'Sent',
    'Received',
    'Close',
    'Cancel',
    'Done',
    'Next',
    'Back',
    'More',
    'Help',
    'Privacy',
    'Terms',
  ].map((w) => w.toLowerCase()),
);

/** Its own words in its addresses, as far as they're known. */
const PATH_WORDS = new Set([
  ...Object.keys(PLACES),
  'new',
  'edit',
  'sent',
  'received',
  'pending',
  'all',
]);

/** Alignable's warnings: what any site says when it holds an account back, till Check reads its own. */
const WARNINGS: readonly RegExp[] = [
  /\byour account (has been|was|is) (temporarily )?(locked|restricted|suspended|disabled|limited)\b/i,
  /\b(too many (requests|invitations|connection requests)|slow down)\b/i,
  /\b(reached|exceeded) (the|your) (daily |weekly )?limit\b/i,
  /\b(verify|confirm) (you['’]re|you are) (a )?human\b/i,
  /\bunusual activity\b/i,
];

const CONNECT = /^(connect|add connection|connect with)\b/i;
const CONNECTED = /^(connected|request sent|pending|invitation sent)$/i;
const MESSAGE = /^(message|send message|send a message|new message)$/i;
const RECOMMEND = /^recommend\b/i;
const RECOMMENDED = /^recommended$/i;
const LIKE = /^(like|liked|unlike)$/i;
const COMMENT_BOX = /\b(comment|reply|answer)\b/i;
const COMMENT = /^(comment|reply|answer)$/i;

export const ALIGNABLE: LookingSite = {
  platform: 'alignable',
  name: 'Alignable',
  hosts: ['https://www.alignable.com/*'],
  host: HOST,
  url: alignableUrl,
  kindOf,
  profileOf,
  postOf,
  pathWords: PATH_WORDS,
  words: WORDS,
  warnings: WARNINGS,
  // The menu's link to the person's own profile, by its words.
  ownLink: (doc, href) => {
    for (const anchor of doc.querySelectorAll(
      'nav a[href], header a[href], [role="navigation"] a[href]',
    )) {
      const words = clean(anchor.textContent) || clean(anchor.getAttribute('aria-label'));
      if (!/^(my profile|profile|me|view profile)$/i.test(words)) continue;
      const url = alignableUrl(anchor.getAttribute('href') ?? '', href);
      if (url) return url.toString();
    }
    return null;
  },
  // Each looked for on any of its pages, while they're still learned: the job tries the likeliest first.
  looks: {
    connect: {
      on: ['*'],
      look: (doc) =>
        lookFor(
          'connect',
          mainOf(doc),
          ALIGNABLE,
          { words: CONNECT, name: 'Connect' },
          {
            words: CONNECTED,
            why: 'you’re connected already, or asked to be',
          },
        ),
    },
    message: {
      on: ['*'],
      look: (doc) =>
        lookFor('message', mainOf(doc), ALIGNABLE, { words: MESSAGE, name: 'Message' }),
    },
    recommend: {
      on: ['*'],
      look: (doc) =>
        lookFor(
          'recommend',
          mainOf(doc),
          ALIGNABLE,
          { words: RECOMMEND, name: 'Recommend' },
          {
            words: RECOMMENDED,
            why: 'you’ve recommended them already',
          },
        ),
    },
    like: {
      on: ['*'],
      look: (doc) => lookFor('like', mainOf(doc), ALIGNABLE, { words: LIKE, name: 'Like' }),
    },
    // A box to comment in, or the Comment that opens one: nothing is written.
    comment: {
      on: ['*'],
      look: (doc) => {
        const main = mainOf(doc);
        const boxes = boxesSaying(main, COMMENT_BOX);
        const opens = controlsSaying(main, COMMENT, true);
        return went(
          'comment',
          { boxes: boxes.length, comment: opens.length },
          boxes.length || opens.length ? [] : ['no box to comment in, and no Comment, on the page'],
          boxes.length || opens.length ? [] : namesIn(main, ALIGNABLE),
        );
      },
    },
  },
};
