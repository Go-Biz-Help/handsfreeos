/**
 * What a reading tab's page holds whether or not it's drawn (./page.ts `held`; docs/socialcontent.md, "Finding
 * creators"), for Instagram's search page behind another window, where Chrome draws nothing: the accounts in the data
 * the page came with (its own scripts' JSON, never the person's own account), the posts it links, and the answers it
 * loaded from its own site, as the page asked for them. On someone's profile page, `profileHeldOn`: their profile and
 * posts in the data the page came with, and what its description says, for when Instagram's answer says they aren't
 * there.
 */
import { ownOf } from '../networks/instagram/read';
import {
  accountsFrom,
  pageProfileFrom,
  type InstagramFoundAccount,
  type InstagramPageProfile,
} from './instagram';

/** What `held` finds: accounts in the page's own data, the posts it links (their codes), and the answers it loaded. */
export interface ResearchHeld {
  readonly accounts: readonly InstagramFoundAccount[];
  readonly posts: readonly string[];
  readonly loaded: readonly string[];
}

/**
 * How much `held` gives back, at most, and the biggest script of the page's data it reads; `profilePosts`, how many of
 * a profile's grid links `profileHeld` gives back.
 */
export const HELD_MOST = {
  accounts: 60,
  posts: 24,
  profilePosts: 90,
  loaded: 40,
  scriptChars: 3_000_000,
} as const;

/** A post's code in a link to it: /p/<code>/, /reel/<code>/, or either under someone's name. */
const POST_LINK = /^\/(?:[\w.]+\/)?(?:p|reel)\/([\w-]+)\/?/;

/** The codes of the posts a page links to, in the page's order, each once, at most `most`. */
function postLinks(doc: Document, href: string, most: number = HELD_MOST.posts): string[] {
  const origin = new URL(href).origin;
  const posts = new Set<string>();
  for (const a of doc.querySelectorAll('a[href]')) {
    let url: URL;
    try {
      url = new URL(a.getAttribute('href')!, href);
    } catch {
      continue;
    }
    const code = url.origin === origin ? POST_LINK.exec(url.pathname)?.[1] : undefined;
    if (code) posts.add(code);
    if (posts.size >= most) break;
  }
  return [...posts];
}

/** What the page holds whether or not it's drawn (`held`). */
export function heldOn(
  doc: Document,
  href: string,
  entries: readonly { name: string }[],
): ResearchHeld {
  const origin = new URL(href).origin;
  const own = ownOf(doc, href)?.toLowerCase() ?? null;
  const accounts = new Map<string, InstagramFoundAccount>();
  for (const script of doc.querySelectorAll('script[type="application/json"]')) {
    const text = script.textContent ?? '';
    if (text.length > HELD_MOST.scriptChars || !text.includes('"username"')) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    for (const account of accountsFrom(json, true))
      if (account.username !== own && !accounts.has(account.username))
        accounts.set(account.username, account);
    if (accounts.size >= HELD_MOST.accounts) break;
  }
  const posts = postLinks(doc, href);
  const loaded = new Set<string>();
  for (const { name } of entries) {
    let url: URL;
    try {
      url = new URL(name);
    } catch {
      continue;
    }
    if (url.origin === origin && /^\/(api|graphql)\b/.test(url.pathname))
      loaded.add(`${url.pathname}${url.search}`);
  }
  return {
    accounts: [...accounts.values()].slice(0, HELD_MOST.accounts),
    posts,
    loaded: [...loaded].slice(-HELD_MOST.loaded),
  };
}

/** The page's own data that mentions some words: its scripts' JSON, each read once, the biggest let go. */
function pageData(doc: Document, mentions: string): unknown[] {
  const out: unknown[] = [];
  const needle = mentions.toLowerCase();
  for (const script of doc.querySelectorAll('script[type="application/json"]')) {
    const text = script.textContent ?? '';
    if (text.length > HELD_MOST.scriptChars || !text.toLowerCase().includes(needle)) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // Not data after all.
    }
  }
  return out;
}

/**
 * Someone's profile and posts as their profile page holds them (`profileHeld`): its data and description, the posts
 * its grid links to, whose codes say when they posted, and their account's number from the page's name for itself.
 */
export function profileHeldOn(doc: Document, username: string): InstagramPageProfile {
  const description =
    doc.querySelector('meta[name="description"]')?.getAttribute('content') ??
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
    null;
  return pageProfileFrom(
    pageData(doc, `"${username}"`),
    username,
    description,
    postLinks(doc, doc.URL, HELD_MOST.profilePosts),
    profilePageId(doc),
  );
}

/** A profile page's own name for itself ("profilePage_<their account's number>"), whose number asks for their posts. */
const PROFILE_PAGE_ID = /"profilePage_(\d{1,25})"/;

/** Their account's number, from the name the profile page gives itself in its own scripts; null when it gives none. */
function profilePageId(doc: Document): string | null {
  for (const script of doc.querySelectorAll('script')) {
    const text = script.textContent ?? '';
    if (text.length > HELD_MOST.scriptChars) continue;
    const id = PROFILE_PAGE_ID.exec(text)?.[1];
    if (id) return id;
  }
  return null;
}
