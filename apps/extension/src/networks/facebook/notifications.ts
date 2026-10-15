/**
 * Your notifications (facebook.com/notifications): who accepted your friend request, who reacted to or commented on
 * your posts, who mentioned you. Each one is a link with a sentence in or beside it; the names in bold before what
 * they did are the people who did it.
 */
import { clean, collectLinked, inTopBar, textLines } from './dom';
import type { Notice } from './types';
import { groupFromUrl, postUrlFrom, profileFromUrl } from './urls';
import { isWhen, UI_WORDS } from './vocabulary';

/** What a notification is about, from the words in it. The first that matches wins. */
const KINDS: readonly (readonly [RegExp, Notice['kind']])[] = [
  [/\baccepted your friend request\b/i, 'friend_accepted'],
  [/\b(sent you a friend request|wants? to be friends|friend requests?)\b/i, 'friend_request'],
  [/\b(mentioned|tagged) you\b/i, 'mention'],
  [/\b(commented on|replied to|responded to)\b/i, 'comment'],
  [/\b(reacted to|likes?|liked|loves?|loved)\b.*\byour\b/i, 'reaction'],
  [/\b(posted in|invited you to join|requested to join|added you to|approved your)\b/i, 'group'],
];

/** The words a notification uses after the names: "Jane Doe and 2 others reacted to…". */
const AFTER_NAMES =
  /\s(accepted|sent|wants?|mentioned|tagged|commented|replied|responded|reacted|likes?|liked|loves?|loved|posted|invited|requested|added|approved|shared|updated|is|was|has|also|went|changed|joined|started)\b/i;

/** "2 others", which isn't anyone's name. */
const OTHERS = /^(\d+\s+)?others?$/i;

/** The lines around a notification that are Facebook's, not the notification's. */
const AROUND = /^(new|earlier|today|see previous notifications|unread|mark as read)$/i;

function kindOf(text: string): Notice['kind'] | null {
  for (const [pattern, kind] of KINDS) if (pattern.test(text)) return kind;
  return AFTER_NAMES.test(text) ? 'other' : null;
}

/** The people a notification names: the bold words before what they did, else the words there. */
function namesIn(card: Element, text: string): string[] {
  const end = AFTER_NAMES.exec(text)?.index ?? text.length;
  const person = (name: string) => name.length > 0 && name.length <= 80 && !OTHERS.test(name);
  const bold = [...card.querySelectorAll('strong, b')]
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

/** The notifications in a part of the page, in page order, each once. */
export function readNotices(root: Element, base: string): Notice[] {
  const linked = collectLinked(root, base, (url) => ({ key: url.href, value: url }), {
    skip: inTopBar,
  });
  const notices: Notice[] = [];
  const seen = new Set<string>();
  for (const { value: link, card } of linked) {
    const lines = textLines(card, 12).filter(
      (line) => !UI_WORDS.has(line.toLowerCase()) && !AROUND.test(line),
    );
    const when = lines.find(isWhen) ?? null;
    const text = lines.filter((line) => !isWhen(line)).join(' ');
    const kind = text.length >= 8 ? kindOf(text) : null;
    if (!kind || seen.has(text)) continue;
    seen.add(text);
    const profile = profileFromUrl(link);
    notices.push({
      kind,
      text,
      names: namesIn(card, text),
      profile,
      url: postUrlFrom(link) ?? profile?.url ?? groupFromUrl(link)?.url ?? null,
      when,
    });
  }
  return notices;
}
