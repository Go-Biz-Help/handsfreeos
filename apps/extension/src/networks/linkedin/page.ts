/**
 * Reads a whole LinkedIn page, as ../facebook/page.ts reads Facebook's: works out what kind of page it is from its
 * address, runs the readers for that kind, and says what the person should know about the result. Each kind checks
 * itself: when it finds nothing where something should be, the result says so and suggests sending the page
 * outline, unless the page says there's nothing ("No results found") or shows one of LinkedIn's warnings.
 */
import type { ChatOptions } from '../facebook/chat';
import { sameName } from '../facebook/people';
import { readCatchUp } from './catch-up';
import { readChat } from './chat';
import { readChats } from './chats';
import { readCompany } from './company';
import { inTopBar, mainOf, shownText, yourName } from './dom';
import { readInvitations } from './invitations';
import { readNotices } from './notifications';
import { readPeople } from './people';
import { postBoxes, readPosts } from './posts';
import { readProfile } from './profile';
import type { PageKind, Post, ReadResult } from './types';
import { classifyUrl } from './urls';
import { readWarnings } from './warnings';

/** What a kind of page should have, for the note when a reader finds none of it. */
const EXPECTED: Partial<Record<PageKind, string>> = {
  connections: 'people',
  'search-people': 'people',
  invitations: 'invitations',
  'search-posts': 'posts',
  feed: 'posts',
  post: 'posts',
  messaging: 'chats',
  chat: 'messages',
  notifications: 'notifications',
};

/** LinkedIn adds to these lists as you scroll, and only what's loaded can be read. */
const SCROLLS: ReadonlySet<PageKind> = new Set([
  'connections',
  'invitations',
  'search-posts',
  'feed',
  'activity',
  'group',
  'messaging',
  'notifications',
]);

/** People search shows its results a page at a time. */
const PAGED: ReadonlySet<PageKind> = new Set(['search-people']);

/** What LinkedIn says when a search or a list has nothing in it. */
const NOTHING =
  /^(no results found|no (pending |sent )?invitations|you don['’]t have any (connections|invitations|messages|notifications)( yet)?)\b/i;

/** Whether the page itself says there's nothing to show: a heading of LinkedIn's. */
function saysNothing(root: Element): boolean {
  return [...root.querySelectorAll('h1, h2, h3, [role="heading"]')].some(
    (heading) => !inTopBar(heading) && NOTHING.test(shownText(heading)),
  );
}

/**
 * A search's posts but the person's own, by the name on the top bar's Me (decision 92): theirs aren't to comment on,
 * nor them someone to find. With no name shown, every post stays.
 */
function notYours(posts: readonly Post[], doc: Document): Post[] {
  const you = yourName(doc);
  return posts.filter((post) => !you || !post.author || !sameName(post.author.name, you));
}

export function readPage(
  doc: Document,
  href: string,
  now: Date = new Date(),
  options: ChatOptions = {},
): ReadResult {
  const address = classifyUrl(href);
  const main = mainOf(doc);
  const base = href;
  const notes: string[] = [];
  let found: Omit<ReadResult, 'platform' | 'kind' | 'url' | 'readAt' | 'warnings' | 'notes'> = {};

  switch (address.kind) {
    case 'profile':
    case 'own-profile': {
      const profile = readProfile(main, address, base, doc.title);
      found = { profile };
      if (!profile.name) notes.push('Couldn’t find the name on this profile.');
      break;
    }
    case 'connections':
      // Everyone on your connections is one: the address says so, whatever their row's buttons do.
      found = {
        people: readPeople(main, base).map((person) => ({
          ...person,
          degree: '1st' as const,
          connection: 'connected' as const,
        })),
      };
      break;
    case 'search-people':
      found = { people: readPeople(main, base) };
      break;
    case 'search': {
      // All results: people, and posts, whose authors aren't people found.
      const boxes = postBoxes(main);
      found = {
        people: readPeople(main, base, { skip: (a) => boxes.some((box) => box.contains(a)) }),
        posts: notYours(readPosts(main, base), doc),
      };
      break;
    }
    case 'invitations':
      found = { invitations: readInvitations(main, base) };
      break;
    case 'post': {
      // On its own page, the post is the one the address names, if nothing in it says otherwise.
      const [first, ...rest] = readPosts(main, base);
      found = { posts: first ? [{ ...first, url: first.url ?? address.post }, ...rest] : [] };
      break;
    }
    case 'search-posts':
      found = { posts: notYours(readPosts(main, base), doc) };
      break;
    case 'feed':
    case 'activity':
      found = { posts: readPosts(main, base) };
      break;
    case 'group': {
      const heading = [...main.querySelectorAll('h1')].find((h) => !inTopBar(h));
      found = {
        group: { name: (heading && shownText(heading)) || null, group: address.group },
        posts: readPosts(main, base),
      };
      break;
    }
    case 'messaging':
      found = { chats: readChats(main, base) };
      break;
    case 'chat':
      found = { chat: readChat(doc, address, base, options), chats: readChats(main, base) };
      break;
    case 'notifications':
      found = { notices: readNotices(main, base) };
      break;
    case 'catch-up':
      found = { catchUp: readCatchUp(main, base) };
      break;
    case 'company': {
      const company = readCompany(main, base);
      found = { company };
      if (!company.name) notes.push('Couldn’t find the company’s name on this page.');
      break;
    }
    case 'other':
      notes.push('The extension doesn’t read this kind of page yet.');
      break;
  }

  const warnings = readWarnings(doc, href);
  const expected = EXPECTED[address.kind];
  const counts: Record<string, number | undefined> = {
    people: found.people?.length,
    invitations: found.invitations?.length,
    posts: found.posts?.length,
    chats: found.chats?.length,
    messages: found.chat?.messages.length,
    notifications: found.notices?.length,
  };
  // A warning is what the person needs to know: what's missing or more to come is beside the point.
  if (warnings.length === 0) {
    if (expected && !counts[expected] && !saysNothing(main))
      notes.push(
        `Found no ${expected} here. If the page shows some, save the page outline and send it to us so we can fix the reader.`,
      );
    if (SCROLLS.has(address.kind))
      notes.push('LinkedIn loads more as you scroll. Scroll down to get more.');
    if (PAGED.has(address.kind))
      notes.push('LinkedIn shows 10 people a page. Go to the next page to get more.');
  }

  return {
    platform: 'linkedin',
    kind: address.kind,
    url: href,
    readAt: now.toISOString(),
    ...found,
    warnings,
    notes,
  };
}
