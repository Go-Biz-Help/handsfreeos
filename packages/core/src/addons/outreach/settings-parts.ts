/**
 * Social Outreach's Settings, a page for each part (Chris, 16 Oct 2026; the design is the "Social Outreach settings by
 * platform" canvas): **General**, what's the person's on every network; then **each network**, what the extension does
 * there and, for owners and admins, the team's say on it; then **Your computer** and **Start fresh**. Playbooks sit in
 * the same menu, on their own view. Every change saves as it's made: no Save button.
 *
 * The web and the phone open a part from its key (`?part=` on the web), and build the menu from these words. Browser-safe.
 */
import { PLATFORM_KEYS, type Platform } from './networks';

/** The parts, in the menu's order. */
export const SETTINGS_PART_KEYS = ['general', ...PLATFORM_KEYS, 'computer', 'fresh'] as const;
export type SettingsPart = (typeof SETTINGS_PART_KEYS)[number];

/**
 * The part an address names: General when it names none, or one the add-on doesn't know. The parts before this one
 * were My settings and Business settings, both on General now (their team's say is on each network's page too).
 */
export function settingsPartOf(raw: string | null | undefined): SettingsPart {
  if (raw === 'mine' || raw === 'business') return 'general';
  return (SETTINGS_PART_KEYS as readonly string[]).includes(raw ?? '')
    ? (raw as SettingsPart)
    : 'general';
}

/** Whether a part is a network's page. */
export const isNetworkPart = (part: SettingsPart): part is Platform =>
  (PLATFORM_KEYS as readonly string[]).includes(part);

/**
 * The networks still to come, in the plan's order (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md): shown in the
 * menu as coming, never opened. Each moves to `PLATFORMS` with its kit.
 */
export const NEXT_NETWORKS = ['Instagram', 'Alignable', 'Threads', 'X', 'TikTok'] as const;

/** The Settings pages' own words, on the web and the phone. */
export const SETTINGS_WORDS = {
  /** The menu's headings. */
  menu: { settings: 'Settings', networks: 'Networks', more: 'More' },
  general: 'General',
  generalAbout: 'Yours, on every network. What it does on each network is on that network’s page.',
  /** Under a network's name, at the top of its page. */
  networkAbout: (name: string) => `What the extension does for you on ${name}.`,
  /** Beside a network's switch at the top of its page. */
  onForYou: 'On for you',
  on: 'On',
  off: 'Off',
  /** Beside a network still to come. */
  soon: 'Soon',
  /** How the pages save: as each change is made. */
  autosaves: 'Changes save as you make them.',
  saving: 'Saving…',
  saved: 'Saved. The extension follows it in a few seconds.',
  /** The part for owners and admins: on General for every network, on a network's page for that one. */
  team: 'For your team',
  teamOn: (name: string) => `For your team on ${name}`,
  teamWho: 'Owners and admins',
  teamAbout:
    'For everyone in the business, on every network. Each network’s daily limits are on its own page.',
  /** A network's switch for the whole business: Facebook's is always on. */
  teamMay: (name: string) => `Your team may use ${name}`,
  teamMayAbout: (name: string) =>
    `Turned off, nobody in the business can work ${name}, and anyone who does has it turned off.`,
  /** The person's own limits on a network, as they stand. */
  yourLimits: (name: string) => `Your daily limits on ${name}`,
  /** A network Chrome has to let the extension on, the first time. */
  allowInChrome: (name: string) =>
    `The first time, open the extension’s panel on a ${name} page and press Allow on ${name}, then Allow in Chrome’s box.`,
} as const;
