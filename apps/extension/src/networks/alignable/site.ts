/**
 * Alignable, still looked at (../looking/site.ts; docs/outreach.md decision 78): made for small businesses, by town:
 * connect, message, recommend, and a forum where owners ask for referrals (the plan's "The networks after LinkedIn").
 * Little about it is published, and its signed-in pages aren't public, so its addresses here are only what its public
 * pages and robots.txt show (a business at alignable.com/<town-st>/<business>/, its dashboard, its connection requests
 * and recommendations), and Check Alignable follows the site's own menus rather than addresses written here. On every
 * page it opens it looks for Connect, Message, Recommend, Like and a box to comment in, pressing none of them, and its
 * steps are built from what that reads.
 *
 * From the owner's Check Alignable (17 Oct 2026): alignable.com/ is its public home page even signed in, its menus'
 * words all its own (none of them known yet), with a button into the signed-in pages at alignable.com/biz, which its
 * robots.txt keeps every search engine out of, with its dashboard, its claims and its onboarding. So Check starts at
 * /biz, and which of its menus' places it opens is decided in the tab, on their real words (`placeOpening`).
 */
import { clean } from '../facebook/dom';
import { boxesSaying, controlsSaying, lookFor, mainOf, namesIn } from '../looking/looks';
import {
  aboutLook,
  idealLook,
  pitchLook,
  putCode,
  readOwnProfile,
  writeAboutUs,
} from './own-profile';
import { writeAlignablePart } from './parts';
import { alignableNoticer } from './actions';
import {
  commentOn,
  connectOnPage,
  joinOnPage,
  likeTheirPost,
  theirPosts,
  writeMessage,
} from './auto';
import { openConversation, scrollAny, showAllConnections } from './browse';
import { postLook, writeAlignablePost } from './compose';
import { JOIN, JOIN_ASKED, JOINED, readAlignable } from './read';
import { readReplies } from './replies';
import { withdrawOnPage } from './withdraw';
import type { LookingSite, PlaceOpening } from '../looking/site';
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

/**
 * Its places by a word of their addresses (the first, or the one after /biz), as far as they're known: the rest are
 * learned from Check.
 */
const PLACES: Readonly<Record<string, string>> = {
  dashboard: 'home',
  home: 'home',
  feed: 'home',
  inbox: 'inbox',
  messages: 'inbox',
  message: 'inbox',
  conversations: 'inbox',
  network: 'network',
  connections: 'network',
  contacts: 'network',
  my_network: 'network',
  'my-network': 'network',
  contact_requests: 'network',
  requests: 'network',
  invitations: 'network',
  suggestions: 'network',
  forum: 'forum',
  questions: 'forum',
  answers: 'forum',
  discussions: 'forum',
  topics: 'forum',
  polls: 'forum',
  posts: 'post',
  notifications: 'notifications',
  activity: 'notifications',
  alerts: 'notifications',
  search: 'search',
  people: 'search',
  members: 'search',
  businesses: 'search',
  directory: 'search',
  communities: 'community',
  community: 'community',
  groups: 'community',
  events: 'events',
  referrals: 'referrals',
  profile: 'own-profile',
  my_profile: 'own-profile',
  me: 'own-profile',
  biz_users: 'account',
  account: 'account',
  settings: 'settings',
  profile_recommendations: 'recommendations',
  recommendations: 'recommendations',
  claims: 'account',
  onboarding: 'account',
  start: 'account',
};

/**
 * A group's own pages under its address, never one of its discussions: /groups/<group>/members, its events; and from
 * 0.95.0 (decision 92) the likeliest of its leaders' and rules' pages, and its Join's and Leave's.
 */
const GROUP_PAGES = new Set([
  'search',
  'events',
  'members',
  'about',
  'new',
  'edit',
  'settings',
  'leaders',
  'admins',
  'rules',
  'join',
  'leave',
]);

function kindOf(url: URL): string {
  const [first = '', second, third] = partsOf(url).map((p) => p.toLowerCase());
  // Its public home page, signed in or not; its signed-in pages are under /biz.
  if (!first) return 'front';
  if (first === 'biz') {
    if (!second) return 'home';
    // A business by Alignable's id for it (a connection's link, /biz/businesses/<id>), never their own profile's.
    if (second === 'businesses' && third && third !== 'my_profile') return 'business';
    // My Network's Requests, and a chat with one business (the owner's Check, 0.66.0).
    if (second === 'my_network' && third === 'connection_requests') return 'requests';
    if (second === 'conversations' && url.searchParams.has('with_business_id')) return 'chat';
    return PLACES[second] ?? 'app';
  }
  // A group's page (a town's own group is /groups/<town-st>, where its owners post), and one of its discussions: a
  // forum question opens at /groups/<group>/<question> (the owner's Check, 0.66.0).
  if (first === 'groups' && second) {
    if (GROUP_PAGES.has(second)) return PLACES[second] ?? 'community';
    if (!third) return 'community';
    return GROUP_PAGES.has(third) ? (PLACES[third] ?? 'community') : 'discussion';
  }
  const place = PLACES[first];
  if (place) return place;
  if (TOWN.test(first)) return second ? 'business' : 'town';
  return 'other';
}

/** The places worth opening, by their words or their address's: where people, messages and posts are. */
const WORTH =
  /\b(home|feed|dashboard|network|connections?|contacts?|messages?|inbox|conversations?|forum|q\s*&\s*a|questions?|answers?|discussions?|communit(y|ies)|groups?|events?|notifications?|alerts?|profile|recommendations?|referrals?|search|people|members?|businesses|local|nearby|requests?|invitations?|suggest(ed|ions)?|discover|polls?)\b/i;
/** Never opened, whatever the menu calls them: signing out, paying, inviting, deleting, settings. */
const NEVER =
  /\b(log ?out|sign ?out|upgrade|premium|plus|billing|pay(ment)?s?|subscri(be|ption)s?|checkout|buy|delete|deactivate|close (your )?account|cancel (your )?(account|membership|subscription)|invite|settings|preferences|password|unsubscribe)\b/i;
const NEVER_AT =
  /(log_?out|sign_?out|sign_?in|log_?in|destroy|delete|deactivate|billing|upgrade|payment|checkout|subscri|invite|settings|password|unsubscribe|^\/(biz_users|claims|onboarding|start|l|r|forward_referral_card)(\/|$))/i;
/** The company's own pages, never where a step is: about it, its blog, its prices, its help. */
const DULL =
  /\b(about|blog|careers?|jobs|press|news(room)?|privacy|terms|cookies?|legal|accessibility|sitemap|pricing|features|products?|resources|company|help|support|faq|contact us|partners?|advertis(e|ing)|ambassadors?|research|webinars?|podcasts?|guides?|app store|google play|download)\b/i;

/** Whether Check opens a place its menus lead to, by its real words and its address. */
function placeOpening(name: string, url: URL): PlaceOpening {
  const path = url.pathname;
  const pathWords = path.replace(/[/_-]+/g, ' ');
  // Its public home page is never where a step is, and signing out, paying and deleting never are.
  if (path === '/' || NEVER.test(name) || NEVER_AT.test(path)) return 'never';
  if (WORTH.test(name) || WORTH.test(pathWords)) return 'worth';
  if (DULL.test(name) || DULL.test(pathWords)) return 'never';
  return 'maybe';
}

/** A town's own pages under its address, never a business: its forum (the owner's Check, 0.62.0: /<town-st>/forum/…). */
const TOWN_PAGES = new Set(['forum', 'questions', 'events', 'groups']);

/** The town a business's address is in: "austin-tx" in /austin-tx/acme-plumbing. */
export function townOf(href: string): string | null {
  const url = alignableUrl(href);
  const [first = ''] = url ? partsOf(url) : [];
  return TOWN.test(first) ? first.toLowerCase() : null;
}

/**
 * The business an address is, or a person on it: "austin-tx/acme-plumbing" for /austin-tx/acme-plumbing and
 * /austin-tx/acme-plumbing/dana-reyes, whatever their case. Null for any other address. So the person's own business,
 * as their profile opens at it, is told from anyone else's on a list (decision 92: the readers leave them out).
 */
export function businessOf(href: string): string | null {
  const url = alignableUrl(href);
  const [first = '', second = ''] = url ? partsOf(url) : [];
  if (!TOWN.test(first) || !SLUG.test(second) || TOWN_PAGES.has(second.toLowerCase())) return null;
  return `${first}/${second}`.toLowerCase();
}

function profileOf(url: URL): { username: string; url: string } | null {
  const [first = '', second = '', third] = partsOf(url);
  // A business in its town, and a person on it: /<town-st>/<business>/ and /<town-st>/<business>/<person>.
  if (!TOWN.test(first) || !SLUG.test(second) || TOWN_PAGES.has(second.toLowerCase())) return null;
  const who = third && SLUG.test(third) ? third : null;
  const path = who ? `${first}/${second}/${who}` : `${first}/${second}`;
  return {
    username: `${first}-${second}${who ? `-${who}` : ''}`.slice(0, 100),
    url: `https://${HOST}/${path}`,
  };
}

function postOf(url: URL): string | null {
  const parts = partsOf(url).map((p) => p.toLowerCase());
  const [first = '', second, third] = parts;
  // A town's forum question (/<town-st>/forum/<id>/<title>, the owner's Check, 0.62.0), and a group's discussion
  // (/biz/discussions/<id>).
  const question = TOWN.test(first) && second === 'forum' && !!third;
  const discussion = first === 'biz' && second === 'discussions' && !!third;
  // A group's discussion at its own address: where a forum question opens (the owner's Check, 0.66.0).
  const inGroup =
    first === 'groups' &&
    !!second &&
    !!third &&
    !GROUP_PAGES.has(second) &&
    !GROUP_PAGES.has(third) &&
    parts.length === 3;
  const older = !!second && ['forum', 'questions', 'discussions', 'posts'].includes(first);
  if (!question && !discussion && !inGroup && !older) return null;
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
    // Words it may use, kept when its pages say them: its menus' words weren't known when Check first read it.
    'Feed',
    'Home Feed',
    'Activity',
    'My Community',
    'Q&A Forum',
    'Ask a Question',
    'Ask Question',
    'Post a Question',
    'Polls',
    'Poll',
    'Referrals',
    'Refer',
    'Ask for Referrals',
    'Request a Referral',
    'Give a Referral',
    'Recommend Me',
    'Get Recommended',
    'Ask for Recommendations',
    'Request Recommendations',
    'Write a Recommendation',
    'Endorse',
    'Add to Network',
    'Remove Connection',
    'Disconnect',
    'Connection Requests',
    'Pending Requests',
    'Sent Requests',
    'Received Requests',
    'Requests',
    'Invite Connections',
    'Find Connections',
    'Businesses Near You',
    'Local Businesses',
    'Your Town',
    'Town',
    'Find Businesses',
    'Find People',
    'Search Alignable',
    'New Message',
    'Compose',
    'Write a message...',
    'Write a message…',
    'Type a message...',
    'Type a message…',
    'Create a Post',
    'Write a Post',
    'Share an Update',
    'Post an Update',
    'Start a Discussion',
    "What's on your mind?",
    'What’s on your mind?',
    'Unfollow',
    'Unlike',
    'Replies',
    'Report',
    'Delete',
    'Save',
    'Submit',
    'Continue',
    'Skip',
    'Menu',
    'Open menu',
    'Close menu',
    'Previous',
    'Show More',
    'Read More',
    'Learn More',
    'View All',
    'Get Started',
    'Your Business',
    'Business Profile',
    'Edit Business Profile',
    'My Dashboard',
    'Go to Dashboard',
    'Go to My Dashboard',
    'Back to Alignable',
    'Go to Alignable',
    'Visit Alignable',
    'Account',
    'Account Settings',
    'Help Center',
    'Log In',
    'Sign Up',
    'Join Free',
    'Join Now',
    'Alignable Plus',
    'Plus',
    'Go Premium',
    'Pricing',
    'Features',
    'Products',
    'Resources',
    'Company',
    'Why Alignable',
    'How It Works',
    'About',
    'About Us',
    'Blog',
    'Careers',
    'Press',
    'Research',
    'Contact Us',
    'Support',
    'FAQ',
    'Partners',
    'Advertise',
    'Ambassadors',
    'Local Business of the Year',
    'Awards',
    'Leaderboard',
    'Webinars',
    'Privacy Policy',
    'Terms of Service',
    'Terms of Use',
    'Cookie Policy',
    'Accessibility',
    'Sitemap',
    'Community Guidelines',
    'Do Not Sell or Share My Personal Information',
    'Page not found',
    'Not Found',
    'Sorry',
    'Oops',
    // Its own profile's parts, as the owner's own profile showed them (17 Oct 2026, data-testid's): kept when its
    // pages say them, so the next outline shows where each is written.
    'Elevator Pitch',
    'Add Elevator Pitch',
    'Add an Elevator Pitch',
    'Edit Elevator Pitch',
    'Write your Elevator Pitch',
    'Ideal Customer',
    'Ideal Customers',
    'My Ideal Customer',
    'Ideal Partner',
    'Ideal Partners',
    'My Ideal Partner',
    'Ideal Referral Partner',
    'Add a description',
    'Add Description',
    'Edit Description',
    'Description',
    'Edit Tags',
    'Add Tags',
    'Tags',
    'Type',
    'Location',
    'Views',
    'Clicks',
    'Profile Views',
    'Services',
    'Our Services',
    'Specialties',
    'About Me',
    'About the Business',
    'Our Story',
    'Website',
    'Phone',
    'Email',
    'Address',
    'Hours',
    'Business Name',
    'Business Description',
    // Decision 99's editors (from 0.98.0): the Elevator Pitch's words, and a new service.
    'Add a service',
    'Add Service',
    'Add a Service',
    'Add New Service',
    'Service Name',
    'Service Description',
    'Save Changes',
    'Write',
    'Text',
    'Video',
    'Record a video',
    'First Name',
    'Last Name',
    'Title',
    'Job Title',
    'Bio',
    'Photos',
    'Add Photos',
    'Gallery',
    'Logo',
    'Cover Photo',
    'Profile Photo',
    'Save Changes',
    'Preview',
    'View as Others See It',
    'Profile Strength',
    'Complete Your Profile',
    // Its groups' words (0.95.0, decision 92), as far as they can be told till Check reads them: a search for groups,
    // the person's own, a group's own page with its Join, its About and its people, and a post's box to comment in.
    'My Groups',
    'Your Groups',
    'Joined Groups',
    'Groups You’ve Joined',
    "Groups You've Joined",
    'Discover Groups',
    'Find Groups',
    'Search Groups',
    'Suggested Groups',
    'Recommended Groups',
    'Popular Groups',
    'Local Groups',
    'All Groups',
    'Create a Group',
    'Create Group',
    'Group',
    'View Group',
    'Join Group',
    'Join This Group',
    'Request to Join',
    'Ask to Join',
    'Requested',
    'Cancel Request',
    'Leave Group',
    'Member',
    'All Members',
    'Group Members',
    'See All Members',
    'View All Members',
    'Leaders',
    'Leader',
    'Group Leaders',
    'Group Leader',
    'Organizer',
    'Organizers',
    'Admin',
    'Admins',
    'Moderator',
    'Moderators',
    'Host',
    'Hosts',
    'About This Group',
    'About the Group',
    'Group Rules',
    'Rules',
    'Discussions in This Group',
    'Recent Discussions',
    'Write a reply...',
    'Write a reply…',
    'Write an answer...',
    'Write an answer…',
  ].map((w) => w.toLowerCase()),
);

/** Its own words in its addresses, as far as they're known: its robots.txt's, and those it may use. */
const PATH_WORDS = new Set([
  ...Object.keys(PLACES),
  'biz',
  'new',
  'edit',
  'sent',
  'received',
  'pending',
  'all',
  'l',
  'r',
  'forward_referral_card',
  'profile_services',
  'social_actions',
  'sign_in',
  'sign_up',
  'sign_out',
  'login',
  'logout',
  'about',
  'blog',
  'pricing',
  'features',
  'plus',
  'premium',
  'upgrade',
  'help',
  'support',
  'privacy',
  'terms',
  'careers',
  'press',
  'research',
  'rpi',
  'lboy',
  'awards',
  'local',
  'town',
  'towns',
  'invite',
  'invites',
  'suggested',
  'view',
  'show',
  'page',
  // What its own profile's links were made of (17 Oct 2026), as far as can be told: the rest are learned.
  'users',
  'owners',
  'members',
  'updates',
  'deals',
  'photos',
  'services',
  'testimonials',
  'tags',
  'preview',
  'dashboard',
  // Where the owner's Check went on 0.62.0, kept so the next Check's outlines say where each link leads: searches,
  // forums, discussions, businesses, recommendations, and the likeliest words for a connection request's link.
  'search',
  'forum',
  'discussions',
  'groups',
  'events',
  'notifications',
  'businesses',
  'my_profile',
  'profile',
  'recommendations',
  'profile_recommendations',
  'referrals',
  'refer',
  'requests',
  'request',
  'connection_requests',
  'connection_request',
  'connections_requests',
  'connect',
  'create',
  'accept',
  'ignore',
  'decline',
  'invitations',
  'invitation',
  'messages',
  // Where the owner's Check went on 0.67.0: a Connect makes the connection at once, and About Us's own Edit; then the
  // likeliest words for a like's and a report's links.
  'make_connection',
  'about_us',
  'about_us_section',
  'likes',
  'like',
  'reactions',
  'reports',
  'report',
  'flags',
  // A group's own pages and the person's own groups (0.95.0, decision 92), as far as they can be told: the next Check
  // says which are real.
  'my_groups',
  'my-groups',
  'mine',
  'joined',
  'join',
  'leave',
  'leaders',
  'admins',
  'moderators',
  'organizers',
  'rules',
  'discover',
  'browse',
  'recommended',
  'popular',
  'nearby',
  'categories',
  'category',
]);

/**
 * Its own words in an address's query: what kind of search, and from where (the owner's Check, 0.62.0); and from
 * 0.95.0 (decision 92) the likeliest keys a search's place and kind go in, so the next Check says which a search for
 * businesses in a town, or for groups, uses. Never where someone is to the street: no keys for an address or a spot on
 * a map.
 */
const QUERY_KEPT = new Set([
  'doc_type',
  'source',
  'request_source',
  'from',
  'size',
  'location',
  'loc',
  'near',
  'city',
  'town',
  'state',
  'region',
  'zip',
  'zip_code',
  'zipcode',
  'postal_code',
  'radius',
  'distance',
  'within',
  'kind',
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
/** What shows in place of Connect once they're asked or connected: from 0.94.0 a connection's Remove Connection too. */
const CONNECTED = /^(connected|request sent|pending|invitation sent|remove connection)$/i;
const MESSAGE = /^(message|send message|send a message|new message)$/i;
const RECOMMEND = /^recommend\b/i;
const RECOMMENDED = /^recommended$/i;
const LIKE = /^(like|liked|unlike)$/i;
const COMMENT_BOX = /\b(comment|reply|answer)\b/i;
const COMMENT = /^(comment|reply|answer)$/i;
/** What a group's own page shows in place of Join once the person's in it, or asked. */
const IN_GROUP = new RegExp(`${JOINED.source}|${JOIN_ASKED.source}`, 'i');

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
  // What a Connect link leads to, after /biz/connection_requests/: a word of Alignable's, never a name (the owner's
  // Check, 0.66.0, hid it), kept so the next Check says whether opening it sends the request.
  pathWordAt: (parts, at) =>
    (at > 0 &&
      /^connection_requests$/i.test(parts[at - 1] ?? '') &&
      /^[a-z_]{1,24}$/.test(parts[at]!)) ||
    // A word of its own with a _ in it, right after /biz: a like's link and a report's were hidden (0.67.0). A
    // business's address is /<town-st>/<business>, and its name never sits there.
    (at === 1 && /^biz$/i.test(parts[0] ?? '') && /^[a-z]+(_[a-z]+)+$/.test(parts[at]!)),
  queryKept: QUERY_KEPT,
  // Its own readers (partners stage 6c): businesses, posts, a forum question's answers and chats, counted in each of
  // Check's notes so the next Check shows what they find on the real pages.
  readFound: readAlignable,
  // Its lists, for the person's asks (part 4): My Network switched to all their connections, and each list scrolled;
  // from 0.84.0 Messages' conversations down its side scrolled too, and one opened by its row's name for Read my chats.
  lists: {
    scroll: (doc) => scrollAny(doc),
    showAll: (doc) => showAllConnections(doc),
    openChat: (doc, _href, name) => openConversation(doc, name),
  },
  // Who wrote back in the conversation open (0.84.0), as the person goes and as Read my chats goes.
  replies: readReplies,
  // The person's own steps, noted as they take them (part 2): Connect, Like, a forum answer's Send, and a message.
  noticer: alignableNoticer,
  // What its runner presses on its own (part 5), each only on its own page: a like on a post of theirs, their own
  // Connect, and a message in their conversation (./auto.ts). From 0.95.0 (decision 92) a comment on a good post, in
  // its own reply form at the top, and a group's own Join, on its page. Alignable asks no questions before a join, as
  // far as its pages showed, so the join's questions are answered with none: the runner never waits on them. Never a
  // recommendation.
  auto: {
    theirPosts: (doc, href, profile) => theirPosts(doc, href, profile).map((f) => f.post),
    like: likeTheirPost,
    connect: connectOnPage,
    message: writeMessage,
    comment: commentOn,
    join: joinOnPage,
    answerJoin: () => Promise.resolve('none'),
    // The week's helpful post, once OK'd (0.101.0, decision 109), on their signed-in home page.
    post: writeAlignablePost,
  },
  // A request the person sent withdrawn, on that business's own page (0.97.0, decisions 12 and 98).
  withdraw: withdrawOnPage,
  words: WORDS,
  warnings: WARNINGS,
  placeOpening,
  // Its own profile's forms, as the owner's own profile linked them (17 and 18 Oct 2026): /biz/<what>/<id>/edit, and
  // About Us's own page at /biz/profile/<part>.
  editLink: (url) =>
    /^\/biz\/[^/]+\/[^/]+\/edit\/?$/i.test(url.pathname) ||
    /^\/biz\/profile\/[^/]+\/?$/i.test(url.pathname),
  // Read for the AI's check (decision 80), and About Us put in past the code Alignable emails (decision 82).
  ownProfile: {
    read: readOwnProfile,
    writeAbout: writeAboutUs,
    putCode,
    writePart: writeAlignablePart,
  },
  // The menu's link to the person's own profile, by its words.
  ownLink: (doc, href) => {
    for (const anchor of doc.querySelectorAll(
      'nav a[href], header a[href], [role="navigation"] a[href]',
    )) {
      const words = clean(anchor.textContent) || clean(anchor.getAttribute('aria-label'));
      if (
        !/^(my profile|profile|me|view profile|view my profile|my business|your business|business profile)$/i.test(
          words,
        )
      )
        continue;
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
    // A group's own Join (0.95.0, decision 92), on its page: looked at, never pressed.
    join: {
      on: ['community'],
      look: (doc) =>
        lookFor(
          'join',
          mainOf(doc),
          ALIGNABLE,
          { words: JOIN, name: 'Join' },
          { words: IN_GROUP, why: 'you’re in this group already, or asked to join' },
        ),
    },
    // Their own profile's editors (decision 80): opened and closed with nothing written or saved, and About Us's page
    // looked at for its box and Save.
    pitch: { on: ['*'], look: (doc) => pitchLook(doc, ALIGNABLE) },
    ideal: { on: ['*'], look: (doc) => idealLook(doc, ALIGNABLE) },
    about: { on: ['*'], look: (doc) => aboutLook(doc, ALIGNABLE) },
    // The box to start a post, or what opens one (0.101.0, decision 109): looked for, never written in.
    post: { on: ['home'], look: (doc) => postLook(doc, ALIGNABLE) },
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
