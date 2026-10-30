/**
 * Chats on an Instagram messages page whose last message is theirs (docs/outreach.md, decision 22; the Instagram and
 * Alignable plan's "The inbox": the extension reads Instagram's messages and notes who wrote last, as LinkedIn's
 * ../linkedin/replies.ts does), for HandsFreeOS to tell the person's phone who wrote back: in the list of chats, a row
 * that links to its chat and whose last line isn't the person's ("You: …"); and the chat open on its own page
 * (/direct/t/<id>/), where the last message is theirs. Only who it's with, by the chat's id and their account: never
 * what they wrote. A chat with more than one other person, or one the page doesn't tie to one account, is left out.
 * HandsFreeOS counts one only when it answers a message of the person's that the extension noted.
 *
 * Instagram's rows are buttons that link to no chat (the owner's Checks of 21 and 28 Oct 2026: none of 15 did), so a
 * row goes by the name it shows, and HandsFreeOS takes it only when one person the person messaged there goes by it.
 * Until 0.116.0 such rows were left out, so the messages page kept open (decision 125) never saw a reply on Instagram:
 * one waited for the once-a-day chats read or for the person to open the chat. A reaction, or Instagram's own line
 * ("Active 2h ago", "Seen"), is never a reply.
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

/** A row's last line that isn't a message of theirs: a reaction, or Instagram saying something. */
const NOT_A_MESSAGE =
  /^(active now|active (\d+\s?\w+|yesterday)( ago)?|seen( by .+)?|seen \d+\s?\w+ ago|sent( \d+\s?\w+ ago)?|delivered|typing…?|.+ is typing…?)$|\b(reacted|liked a message|liked your (message|story|note)|sent you a message request|wants to send you a message)\b/i;

/** Whether a row's last line is a message of theirs: not the person's ("You: …"), and not a reaction or a notice. */
export const theirsLast = (row: { readonly preview: string | null; readonly yours: boolean }) =>
  row.preview !== null && !row.yours && !NOT_A_MESSAGE.test(row.preview.trim());

const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export function readReplies(doc: Document, href: string): ReplySighting[] {
  const page = instagramUrl(href);
  if (!page || partsOf(page)[0] !== 'direct') return [];
  const found: ReplySighting[] = [];
  const open = lastFromThem(chatOn(doc, href, ownOf(doc, href)));
  if (open) found.push(open);
  for (const row of chatRows(doc, href)) {
    if (!theirsLast(row)) continue;
    if (row.thread) {
      found.push({ name: row.name, threadKey: row.thread, profile: null, when: row.when });
      continue;
    }
    // The open chat's own row adds nothing: the chat says who it's with. Any other goes by the name it shows.
    const theOpen =
      open &&
      [open.name, open.profile?.username].some((n) => n && nameKey(n) === nameKey(row.name));
    if (!theOpen) found.push({ name: row.name, threadKey: null, profile: null, when: row.when });
  }
  // Each chat once: the open one says who it's with, and the list when they wrote.
  const byKey = new Map<string, ReplySighting>();
  for (const s of found) {
    const key = s.threadKey ?? `name:${nameKey(s.name)}`;
    const had = byKey.get(key);
    byKey.set(key, had && !s.profile ? had : { ...s, when: had?.when ?? s.when });
  }
  return [...byKey.values()];
}
