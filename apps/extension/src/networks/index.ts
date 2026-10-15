/**
 * The networks the extension works on, a kit each (./kit.ts; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "How
 * it fits: one add-on, a kit per network"): Facebook (./facebook/), and LinkedIn (./linkedin/), whose readers and the
 * person's own steps are built. A tab's kit is found by its address, so the content script reads and notes by its
 * own network's rules, and the background takes a tab's notes only from a network it knows, as that network's.
 */
import { PLATFORM_KEYS, type Platform } from '@hfos/core/addons/outreach/networks';
import { facebook } from './facebook/kit';
import type { Kit } from './kit';
import { linkedin } from './linkedin/kit';

export type * from './kit';
export { isLinkedInRead } from './kit';

export const KITS: Readonly<Record<Platform, Kit>> = { facebook, linkedin };
/** The kits in the order the add-on names its networks. */
export const KIT_LIST: readonly Kit[] = PLATFORM_KEYS.map((platform) => KITS[platform]);
export { facebook, linkedin };

export const kitFor = (platform: Platform): Kit => KITS[platform];

/** The kit whose pages an address is: the network a tab's steps, replies and warnings are on. Null for any other. */
export const kitOf = (href: string): Kit | null => KIT_LIST.find((kit) => kit.owns(href)) ?? null;

/**
 * The kit a tab's script works for: its network's pages, or a page that network's work goes to (Facebook's Accounts
 * Center, for the person's download file). Null anywhere else.
 */
export const kitHere = (href: string): Kit | null =>
  kitOf(href) ?? KIT_LIST.find((kit) => kit.workUrl(href) !== null) ?? null;
