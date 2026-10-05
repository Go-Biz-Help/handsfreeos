/**
 * The list of chats beside Messenger (facebook.com/messages): who each one is with, the last thing said and when.
 * Each chat is found by its link (/messages/t/… or /messages/e2ee/t/…), wherever on the page the list is.
 */
import { collectLinked, inTopBar, namesOn, textLines } from './dom';
import { bestName } from './people';
import type { ChatSummary } from './types';
import { threadFromUrl } from './urls';
import { isFacebookText, isWhen } from './vocabulary';

export function readChats(root: Element, base: string): ChatSummary[] {
  const linked = collectLinked(
    root,
    base,
    (url) => {
      const thread = threadFromUrl(url);
      return thread ? { key: thread.id, value: thread } : null;
    },
    { skip: inTopBar },
  );
  const chats: ChatSummary[] = [];
  for (const entry of linked) {
    const name = bestName(namesOn(entry.anchors));
    if (!name) continue;
    let preview: string | null = null;
    let when: string | null = null;
    for (const line of textLines(entry.card, 12)) {
      if (line === name) continue;
      // The time is a line of its own ("3h", "· 3h") or at the end of the words: "You: see you then · 3h".
      const parts = line.split(/(?:^|\s+)·\s*/);
      const last = parts[parts.length - 1];
      if (last && isWhen(last)) {
        when ??= last;
        parts.pop();
      }
      const words = parts.join(' · ').trim();
      if (!words || preview !== null || isFacebookText(words)) continue;
      preview = words;
    }
    chats.push({ name, thread: entry.value, preview, when });
  }
  return chats;
}
