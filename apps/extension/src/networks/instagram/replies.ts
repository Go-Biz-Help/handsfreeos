/**
 * Chats on an Instagram messages page whose last message is theirs (docs/outreach.md, decision 22; the Instagram and
 * Alignable plan's "The inbox": the extension reads Instagram's messages and notes who wrote last, as LinkedIn's
 * ../linkedin/replies.ts does), for HandsFreeOS to tell the person's phone who wrote back: in the list of chats, a row
 * that links to its chat and whose last line isn't the person's ("You: …"); and the chat open on its own page
 * (/direct/t/<id>/), where the last message is theirs. Only who it's with, by the chat's id and their account: never
 * what they wrote. A chat with more than one other person, or one the page doesn't tie to one account, is left out.
 * HandsFreeOS counts one only when it answers a message of the person's that the extension noted.
 */
import type { ReplySighting } from '../facebook/replies';
import { chatOn, chatRows, ownOf, type ChatOpen } from './read';
import { instagramUrl, partsOf } from './urls';

/**
 * The chat open on its page, when its last message is theirs (written, or a post they shared) and it's with one
 * account.
 */
export function lastFromThem(chat: ChatOpen | null): ReplySighting | null {
  if (!chat?.with || !chat.thread || chat.last !== 'them') return null;
  return {
    name: chat.name ?? chat.with.username,
    threadKey: chat.thread,
    profile: { id: null, username: chat.with.username, url: chat.with.url },
    when: null,
  };
}

export function readReplies(doc: Document, href: string): ReplySighting[] {
  const page = instagramUrl(href);
  if (!page || partsOf(page)[0] !== 'direct') return [];
  const found: ReplySighting[] = [];
  for (const row of chatRows(doc, href))
    if (row.thread && row.preview && !row.yours)
      found.push({ name: row.name, threadKey: row.thread, profile: null, when: row.when });
  const open = lastFromThem(chatOn(doc, href, ownOf(doc, href)));
  if (open) found.push(open);
  // Each chat once: the open one says who it's with, and the list when they wrote.
  const byKey = new Map<string, ReplySighting>();
  for (const s of found) {
    const had = byKey.get(s.threadKey!);
    byKey.set(s.threadKey!, had && !s.profile ? had : { ...s, when: had?.when ?? s.when });
  }
  return [...byKey.values()];
}
