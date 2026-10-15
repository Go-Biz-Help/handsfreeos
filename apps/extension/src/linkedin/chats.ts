/**
 * The list of conversations in LinkedIn messaging (/messaging/): who each one is with, the last thing said and when.
 * Each conversation is found by its link (/messaging/thread/<id>/), wherever on the page the list is; the names in it
 * are the people in the conversation, in words ("Dana Reyes", "Dana Reyes, Sam Lee").
 */
import { collectLinked, inTopBar, namesOn, shownLines, shownText } from './dom';
import { bestName } from './people';
import type { ChatSummary } from './types';
import { threadFromUrl } from './urls';
import { isLinkedInText, isWhen, UI_WORDS } from './vocabulary';

/** What LinkedIn says about a conversation that isn't the last thing in it: "1 new notification", "Sponsored". */
const ABOUT_IT =
  /^(\d+ new (notifications?|messages?)|sponsored|inmail|active now|status is \w+)$/i;

export function readChats(root: Element, base: string): ChatSummary[] {
  const linked = collectLinked(
    root,
    base,
    (url) => {
      const thread = threadFromUrl(url);
      return thread ? { key: thread.id, value: thread } : null;
    },
    inTopBar,
  );
  const chats: ChatSummary[] = [];
  for (const entry of linked) {
    const lines = shownLines(entry.card, { max: 12 });
    // Its name is its heading, else the first line, else the picture's label.
    const heading = entry.card.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
    const name = bestName([
      ...(heading ? [shownText(heading)] : []),
      ...lines.slice(0, 1),
      ...namesOn(entry.anchors),
    ]);
    if (!name) continue;
    let preview: string | null = null;
    let when: string | null = null;
    for (const line of lines) {
      if (line === name || ABOUT_IT.test(line) || UI_WORDS.has(line.toLowerCase())) continue;
      // The time is a line of its own ("Oct 3", "2:15 PM") or at the end of the words: "You: see you then · Oct 3".
      const parts = line.split(/(?:^|\s+)·\s*/);
      const last = parts[parts.length - 1];
      if (last && isWhen(last)) {
        when ??= last;
        parts.pop();
      }
      const words = parts.join(' · ').trim();
      if (!words || preview !== null || isLinkedInText(words)) continue;
      preview = words;
    }
    chats.push({ name, thread: entry.value, preview, when });
  }
  return chats;
}
