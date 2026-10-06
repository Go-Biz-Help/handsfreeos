/**
 * What the side panel asks a Facebook tab, and what the tab answers; and what a tab tells the background as the person
 * works there. Every end is the extension's own: Facebook's scripts never see these messages.
 */
import type { Answered, Seen, Step } from './facebook/actions';
import type { ReadResult } from './facebook/types';

export type Ask = { readonly type: 'hfos-read' } | { readonly type: 'hfos-outline' };

export type Answer =
  | { readonly ok: true; readonly result: ReadResult; readonly outline?: string }
  | { readonly ok: false; readonly error: string };

/** The line the panel opens to a tab to hear when its page changes, while it reads as the page changes. */
export const WATCH = 'hfos-watch';

/** What the tab says on that line: the page changed (more posts as you scroll, a new message), so read it again. */
export type Note = { readonly type: 'hfos-changed' };

/**
 * What a Facebook tab tells the background as the person works there (src/facebook/actions.ts): a step they took, or
 * their answer to a friend request, and when; or someone they opened from a group. Never what a comment or a message
 * said.
 */
export type TabNote =
  | { readonly type: 'hfos-noted'; readonly step: Step; readonly at: string }
  | { readonly type: 'hfos-answered'; readonly answered: Answered; readonly at: string }
  | { readonly type: 'hfos-seen'; readonly seen: Seen };

export const TAB_NOTES: ReadonlySet<string> = new Set<TabNote['type']>([
  'hfos-noted',
  'hfos-answered',
  'hfos-seen',
]);

/** Where the switch that turns noting on and off is kept, for the tabs to read: `false` is off, anything else on. */
export const NOTING_KEY = 'hfos.noting';
