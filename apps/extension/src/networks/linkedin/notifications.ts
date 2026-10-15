/**
 * Your notifications (/notifications/): who accepted your invitation, who reacted to, commented on or mentioned you
 * in a post, who viewed your profile. LinkedIn draws each one as an article with a sentence in it; where it doesn't,
 * each is found by its link, as Facebook's are (../facebook/notifications.ts). The names in bold before what they did
 * are the people who did it, and the first member it links to is who.
 */
import { clean, outermost } from '../facebook/dom';
import { collectLinked, CONTROLS, inTopBar, shownLines } from './dom';
import type { Notice } from './types';
import { groupFromUrl, linkedinUrl, postUrlFrom, profileFromUrl } from './urls';
import { AFTER_NAMES, isWhen, NOTICE_KINDS, UI_WORDS } from './vocabulary';

/** "3 others", "12 people", "Your profile": never anyone's name. */
const NOT_A_NAME = /^((\d[\d,]*\s+)?(others?|people|members?)|your\b.*)$/i;
/** The lines around a notification that are LinkedIn's, not the notification's. */
const AROUND =
  /^(new|earlier|today|this week|unread|mark as read|view all|show more|see all\b.*)$/i;

function kindOf(text: string): Notice['kind'] | null {
  for (const [pattern, kind] of NOTICE_KINDS) if (pattern.test(text)) return kind;
  return AFTER_NAMES.test(text) ? 'other' : null;
}

/** The people a notification names: the bold words before what they did, else the words there. */
function namesIn(box: Element, text: string): string[] {
  const end = AFTER_NAMES.exec(text)?.index ?? text.length;
  const person = (name: string) => name.length > 0 && name.length <= 80 && !NOT_A_NAME.test(name);
  const bold = [...box.querySelectorAll('strong, b')]
    .map((element) => clean(element.textContent))
    .filter((name) => {
      const at = name ? text.indexOf(name) : -1;
      return person(name) && at >= 0 && at < end;
    });
  if (bold.length > 0) return [...new Set(bold)];
  return text
    .slice(0, end)
    .split(/,\s*|\s+and\s+/)
    .map((name) => name.trim())
    .filter(person);
}

/** The boxes that are notifications: LinkedIn's articles, else the box around each link. */
function noticeBoxes(root: Element, base: string): Element[] {
  const articles = outermost(root, 'article, [role="article"]').filter(
    (article) => article !== root && !inTopBar(article),
  );
  if (articles.length > 0) return articles;
  return collectLinked(root, base, (url) => ({ key: url.href, value: url }), inTopBar).map(
    (entry) => entry.card,
  );
}

/** The notifications in a part of the page, in page order, each once. */
export function readNotices(root: Element, base: string): Notice[] {
  const notices: Notice[] = [];
  const seen = new Set<string>();
  for (const box of noticeBoxes(root, base)) {
    const lines = shownLines(box, { max: 12, exclude: CONTROLS }).filter(
      (line) => !UI_WORDS.has(line.toLowerCase()) && !AROUND.test(line),
    );
    const when = lines.find(isWhen) ?? null;
    const text = lines.filter((line) => !isWhen(line)).join(' ');
    const kind = text.length >= 8 ? kindOf(text) : null;
    if (!kind || seen.has(text)) continue;
    seen.add(text);
    // Who: the first member it links to. What it opens: a post, else a profile, else a group.
    const links = [...box.querySelectorAll('a[href]')].flatMap((anchor) => {
      const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
      return url ? [url] : [];
    });
    const profile = links.map(profileFromUrl).find(Boolean) ?? null;
    const url =
      links.map(postUrlFrom).find(Boolean) ??
      profile?.url ??
      links.map(groupFromUrl).find(Boolean)?.url ??
      null;
    notices.push({ kind, text, names: namesIn(box, text), profile, url, when });
  }
  return notices;
}
