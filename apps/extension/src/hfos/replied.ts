/**
 * Who hears that someone wrote back (decisions 125 and 150): the background, which has that network's runner draft
 * the reply next. Each reply HandsFreeOS keeps as new says so, whether a tab's sighting found it (./replies.ts) or a
 * chat read did (`outreach.chats.collect`, ./session.ts).
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';

let heard: (platform: Platform, profileIds: readonly string[]) => void = () => undefined;

/** Says who hears of the replies HandsFreeOS keeps as new: one listener, the background's. */
export function onReplied(listener: (platform: Platform, profileIds: readonly string[]) => void) {
  heard = listener;
}

/** Tells the listener who wrote back on a network, when anyone did. */
export function heardReplies(platform: Platform, profileIds: readonly string[]): void {
  if (profileIds.length) heard(platform, profileIds);
}
