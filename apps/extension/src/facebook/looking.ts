/**
 * What the content script reads, as the person goes, in the Facebook tab in front of them (docs/outreach.md, decision
 * 43; src/content.ts, src/hfos/looked.ts): Facebook's warnings on any page, always, since a warning stops the
 * extension for the day whatever else is on; and, while noting is on, a chat they open when **Read chats I open** is
 * on, or a group's feed as they scroll when **Look for posts as I scroll** is on. Only the person's own front tab:
 * never the windows the extension works in.
 */
import type { PageKind } from './types';

/** The person's switches, as the extension keeps them from their settings in HandsFreeOS. */
export interface LookingSwitches {
  readonly noting: boolean;
  readonly readChats: boolean;
  readonly markPosts: boolean;
}

/** What to read of a page: all of it (a chat, a group's posts), or only Facebook's warnings. */
export type Looking = 'page' | 'warnings';

export function lookFor(kind: PageKind, on: LookingSwitches): Looking {
  if (!on.noting) return 'warnings';
  if (kind === 'chat' && on.readChats) return 'page';
  if (kind === 'group' && on.markPosts) return 'page';
  return 'warnings';
}

/** The page is read again no more often than this as it changes. */
export const LOOK_EVERY_MS = 10_000;
