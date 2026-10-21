/**
 * The conversation open on Alignable's Messages when its last message is theirs (docs/outreach.md, decision 22; the
 * Instagram and Alignable plan's "The inbox"), for HandsFreeOS to tell the person's phone who wrote back, as
 * Instagram's ../instagram/replies.ts does: by the business it's with, Alignable's id for it (the conversation's own
 * key, /biz/conversations?with_business_id=<id>), never what they wrote. Messages' side shows no whose-the-last-line, so
 * only the conversation open is read. HandsFreeOS counts one only when it answers a message of the person's that the
 * extension noted.
 */
import type { ReplySighting } from '../facebook/replies';
import { chatOpen, urlOf, type ChatOpen } from './read';

/** The conversation open, when its last message is theirs and its header names their business by its id. */
export function lastFromThem(chat: ChatOpen | null): ReplySighting | null {
  const id = chat?.profile?.id;
  if (!chat?.profile || !id || chat.last !== 'them' || !chat.name) return null;
  return { name: chat.name, threadKey: id, profile: chat.profile, when: null };
}

export function readReplies(doc: Document, href: string): ReplySighting[] {
  const page = urlOf(href, href);
  if (!page || !/^\/biz\/conversations\/?$/i.test(page.pathname)) return [];
  const open = lastFromThem(chatOpen(doc, href));
  return open ? [open] : [];
}
