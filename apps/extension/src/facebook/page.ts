/**
 * Reads a whole Facebook page: works out what kind of page it is from its address, runs the readers for that kind,
 * and says what the person should know about the result. Each kind checks itself: when it finds nothing where
 * something should be, the result says so and suggests sending the page outline.
 */
import { readChat, type ChatOptions } from './chat';
import { readChats } from './chats';
import { inTopBar, tabsIn } from './dom';
import { friendListOf, listBeside, readListBeside, withRequests } from './friends';
import { readGroupLinks, readGroupPage } from './groups';
import { readNotices } from './notifications';
import { readPeople, readPeopleAnywhere } from './people';
import { readPosts } from './posts';
import { readProfile } from './profile';
import type { GroupLink, PageKind, ReadResult } from './types';
import { classifyUrl, facebookUrl, pathParts } from './urls';
import { readWarnings } from './warnings';

/** What a kind of page should have, for the note when a reader finds none of it. */
const EXPECTED: Partial<Record<PageKind, string>> = {
  friends: 'people',
  followers: 'people',
  following: 'people',
  'group-members': 'members',
  groups: 'groups',
  chats: 'chats',
  chat: 'messages',
  notifications: 'notifications',
  feed: 'posts',
  group: 'posts',
};

/** Facebook adds to these lists as you scroll, and only what's loaded can be read. */
const SCROLLS: ReadonlySet<PageKind> = new Set([
  'friends',
  'followers',
  'following',
  'group-members',
  'groups',
  'group',
  'feed',
  'chats',
  'notifications',
  'search',
]);

/** The groups a page lists: in the main column, or in the list beside it, whichever has more. */
function readGroupsAnywhere(doc: Document, main: Element, base: string): GroupLink[] {
  const places = [main, ...doc.querySelectorAll('[role="navigation"]')].filter(
    (place) => !inTopBar(place),
  );
  let best: GroupLink[] = [];
  for (const place of places) {
    const groups = readGroupLinks(place, base);
    if (groups.length > best.length) best = groups;
  }
  return best;
}

export function readPage(
  doc: Document,
  href: string,
  now: Date = new Date(),
  options: ChatOptions = {},
): ReadResult {
  const address = classifyUrl(href);
  const main = doc.querySelector('[role="main"]') ?? doc.body;
  const base = href;
  const notes: string[] = [];
  let found: Omit<ReadResult, 'kind' | 'url' | 'readAt' | 'warnings' | 'notes'> = {};

  switch (address.kind) {
    case 'profile': {
      const { profile, posts, pages } = readProfile(main, address, base, doc.title);
      found = { profile, posts, ...(pages.length ? { pages } : {}) };
      if (!profile.name) notes.push('Couldn’t find the name on this profile.');
      break;
    }
    case 'friends': {
      // Your requests and friends are the list beside the page, which shows whoever's picked.
      const list = friendListOf(doc, href);
      const beside = listBeside(href) ? readListBeside(doc, base, list) : null;
      found = {
        people: beside ?? withRequests(readPeopleAnywhere(doc, main, base), doc.body, base, false),
        ...(list ? { friendList: list } : {}),
      };
      break;
    }
    case 'followers':
    case 'following':
      found = { people: readPeopleAnywhere(doc, main, base) };
      break;
    case 'group-members':
      // The lists start below the group's tabs: the row of faces above them is a sample of the same people.
      found = {
        group: readGroupPage(main, address),
        people: readPeople(main, base, { sections: true, after: tabsIn(main) }),
      };
      break;
    case 'group':
      found = { group: readGroupPage(main, address), posts: readPosts(main, base) };
      break;
    case 'groups':
      found = { groups: readGroupsAnywhere(doc, main, base) };
      break;
    case 'search': {
      const url = facebookUrl(href);
      // /search/people, /search/groups and /search/posts show one sort; /search/top and the rest show them all.
      const tab = url ? (pathParts(url)[1]?.toLowerCase() ?? '') : '';
      const all = !['people', 'groups', 'posts'].includes(tab);
      found = {
        people: all || tab === 'people' ? readPeople(main, base) : [],
        groups: all || tab === 'groups' ? readGroupLinks(main, base) : [],
        posts: all || tab === 'posts' ? readPosts(main, base) : [],
      };
      break;
    }
    case 'chats':
      found = { chats: readChats(doc.body, base) };
      break;
    case 'chat':
      found = { chat: readChat(doc, address, base, options), chats: readChats(doc.body, base) };
      break;
    case 'notifications':
      found = { notices: readNotices(main, base) };
      break;
    case 'post':
    case 'feed':
      found = { posts: readPosts(main, base) };
      break;
    case 'other':
      notes.push('The extension doesn’t read this kind of page yet.');
      break;
  }

  const expected = EXPECTED[address.kind];
  const counts: Record<string, number | undefined> = {
    people: found.people?.length,
    members: found.people?.length,
    groups: found.groups?.length,
    chats: found.chats?.length,
    messages: found.chat?.messages.length,
    notifications: found.notices?.length,
    posts: found.posts?.length,
  };
  if (expected && !counts[expected])
    notes.push(
      `Found no ${expected} here. If the page shows some, save the page outline and send it to us so we can fix the reader.`,
    );
  if (SCROLLS.has(address.kind))
    notes.push('Facebook loads more as you scroll. Scroll down to get more.');

  return {
    kind: address.kind,
    url: href,
    readAt: now.toISOString(),
    ...found,
    warnings: readWarnings(doc, href),
    notes,
  };
}
