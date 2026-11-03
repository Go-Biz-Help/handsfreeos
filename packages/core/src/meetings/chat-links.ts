/**
 * Links in what someone typed (docs/video-calls.md, "Chat"): the call's chat on the web and the phone shows each
 * link and email address as one to press, from this one copy.
 *
 * - **What counts:** a web address with `https://` or `http://`, one starting `www.`, a bare one on a common ending
 *   (`acme.com/quote`), and an email address (opened as `mailto:`). Nothing else becomes a link: never another
 *   scheme (`javascript:`, `data:`), and never an address with a name and password before its host
 *   (`https://bank.com@else.com`), which is a trick to hide where it goes.
 * - **Punctuation around it stays text:** a full stop or comma after a link, quotes and brackets around it (a
 *   closing bracket the link didn't open).
 * - **What shows is what they typed;** only the link it opens gets `https://` added.
 */

/** A run of the text: plain, or a link to open. */
export interface ChatTextPart {
  readonly text: string;
  /** Where it goes: an http(s) page or a `mailto:`. Absent for plain text. */
  readonly href?: string;
}

/** Endings a bare address (no `https://`, no `www.`) needs to be taken as a link, so "e.g." and "node.js" aren't. */
const BARE_ENDINGS =
  'com|net|org|io|co|us|biz|info|app|dev|ai|me|ly|site|online|link|xyz|ca|uk|au|nz|ie|de|fr|es|mx|in|tv|store|shop|page|pro|gov|edu|church|school|health|realty|homes|services|solutions|agency|studio|tech|cloud|digital|email|live|news|blog';

const EMAIL = /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const WITH_SCHEME = /^https?:\/\/[^\s<>"]+$/i;
const WWW = /^www\.(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s<>"]*)?$/i;
const BARE = new RegExp(
  `^(?:[a-z0-9-]+\\.)+(?:${BARE_ENDINGS})(?::\\d{1,5})?(?:[/?#][^\\s<>"]*)?$`,
  'i',
);

const OPENERS = /^[([{<"'“‘«]+/;
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '”', '’', '»', '>', '…']);
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const count = (s: string, c: string) => s.split(c).length - 1;

/** The page a typed address opens, or null when it isn't a safe http(s) one. */
function pageOf(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (!url.hostname.includes('.')) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Where a word, stripped of the punctuation around it, goes; null when it's no link. */
function hrefOf(core: string): string | null {
  if (EMAIL.test(core)) return `mailto:${core}`;
  if (WITH_SCHEME.test(core)) return pageOf(core);
  if (WWW.test(core) || BARE.test(core)) return pageOf(`https://${core}`);
  return null;
}

/** The link in one word (no spaces), with the punctuation around it apart; null when there's none. */
function linkIn(word: string): { before: string; link: ChatTextPart; after: string } | null {
  const before = OPENERS.exec(word)?.[0] ?? '';
  let core = word.slice(before.length);
  let after = '';
  for (;;) {
    const last = core.slice(-1);
    if (!last) break;
    const opener = PAIRS[last];
    const unopened = opener !== undefined && count(core, opener) < count(core, last);
    if (!TRAILING.has(last) && !unopened) break;
    after = last + after;
    core = core.slice(0, -1);
  }
  const href = core ? hrefOf(core) : null;
  return href ? { before, link: { text: core, href }, after } : null;
}

/** Longer than this, the rest of a message is left as text (the chat sends 1,000 at most). */
const LINKED_MAX = 4_000;

/** What someone typed, as plain text and links, in order; joined, the parts' text is the whole of it. */
export function chatLinkParts(text: string): ChatTextPart[] {
  const parts: ChatTextPart[] = [];
  let plain = '';
  const head = text.slice(0, LINKED_MAX);
  for (const piece of head.split(/(\s+)/)) {
    const found = piece && !/^\s/.test(piece) ? linkIn(piece) : null;
    if (!found) {
      plain += piece;
      continue;
    }
    plain += found.before;
    if (plain) parts.push({ text: plain });
    parts.push(found.link);
    plain = found.after;
  }
  plain += text.slice(LINKED_MAX);
  if (plain) parts.push({ text: plain });
  return parts;
}
