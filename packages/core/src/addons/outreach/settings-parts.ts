/**
 * Social Outreach's Settings, a page for each part (Chris, 16 Oct 2026; the design is the "Social Outreach settings by
 * platform" canvas; regrouped by decision 129): **You**, what's the person's on every network (its key is still
 * `general`, as old links name it); then **each network**, what the extension does there for the person; **Your
 * computer**, with every job it can be asked to run now; and for owners and admins **Team**, everything about their
 * people and what the business allows, each network's say in one place; and for an owner **Start fresh**. Every change
 * saves as it's made: no Save button.
 *
 * The web and the phone open a part from its key (`?part=` on the web), and build the menu from these words. Browser-safe.
 */
import { businessLimitsOn, WHEELS, type BusinessRules } from './automation';
import { HELPFUL_PER_DAY } from './helpful';
import { DAILY_STEPS, limitNow } from './limits';
import { dailyWordsOn, helpfulOn, tidyWordsOn } from './network-words';
import { networkLimitsNow, NETWORKS, PLATFORM_KEYS, type Platform } from './networks';

/** The parts, in the menu's order. */
export const SETTINGS_PART_KEYS = [
  'general',
  ...PLATFORM_KEYS,
  'computer',
  'team',
  'fresh',
] as const;
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
export const NEXT_NETWORKS = ['Threads', 'X', 'TikTok'] as const;

/** The Settings pages' own words, on the web and the phone. */
export const SETTINGS_WORDS = {
  /** The menu's headings (decision 129). */
  menu: { you: 'You', networks: 'Networks', computer: 'This computer', owners: 'Owners' },
  /** The person's own part: its key is `general`. */
  general: 'You',
  generalAbout:
    'How it writes for you, your working hours and your alerts, on every network. What it does on each network is on that network’s page.',
  /** Under You in the menu. */
  generalRow: 'How it writes, hours and alerts',
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
  /** Team's page, for owners and admins (decision 129). */
  teamTitle: 'Team',
  teamPageAbout:
    'Your people and their training wheels, what they may pick, each network’s say, and the business’s settings. Only owners and admins see this.',
  people: 'Your people',
  peopleAbout: 'Open anyone’s settings to see or change them. Each change says who made it.',
  theirSettings: 'Their settings',
  notSaved: 'Hasn’t saved their own yet',
  /** Who's on training wheels, on each network, among Your people (it was a card on Today). */
  wheelsAbout: `Their messages wait for their OK and their daily limits are half, for ${WHEELS.days} days and ${WHEELS.ok} messages OK’d. End them early for someone you trust.`,
  wheelsOn: (network: string) => `Training wheels on ${network}`,
  wheelsLine: (ok: number, daysLeft: number) =>
    `${ok.toLocaleString('en-US')} of ${WHEELS.ok} OK’d · ${
      daysLeft ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} to go` : 'days done'
    }`,
  you: '(you)',
  networksTitle: 'Each network, for everyone',
  networksAbout:
    'Whether your team may use each network, and how many of each step a person may take there a day.',
  /** On a network's page, for an owner or admin: the team's say on it is on Team now. */
  teamMoved: (name: string) => `Your team’s say on ${name} is on Team.`,
  /** On You, for an owner or admin. */
  teamMovedAll:
    'What your team may pick, where a new person starts, the extension’s link and each network’s limits are on Team.',
  openTeam: 'Open Team',
  /** Someone else's settings, shown to an owner or admin. */
  whose: (name: string) => `You’re looking at ${name}’s settings.`,
  backToYours: 'Back to yours',
  /** The business's part on Team: on every network. */
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
  /** A network the extension is let on from install, as every one is from 0.88.0 (decision 85). */
  builtIn: (name: string) =>
    `The extension works on ${name} as soon as it’s installed: there’s nothing to allow in Chrome.`,
  /** Your computer's page. */
  computerAbout:
    'The computers you’re signed in on, the extension to download, and every job your computer can be asked to run now.',
  /** Under a network's daily friend requests, when it also caps them in any 7 days (LinkedIn's 80). */
  weekly: (n: number) => `At most ${n.toLocaleString('en-US')} in any 7 days`,
  /** The kit's other limits a day, beside the daily steps. */
  profilesRead: 'Profiles read',
  helpfulPost: 'Helpful post',
  forumAnswers: 'Forum answers',
  forumAnswersNote: 'Out of the day’s comments, for posts asking for what you offer.',
  /** The person's own profile on a network, read by their computer and checked by the AI (decision 80). */
  yourProfile: (name: string) => `Your ${name} profile`,
  profileRight: (n: number, of: number) => `${n} of ${of} ${n === 1 ? 'looks' : 'look'} right.`,
  // The phone's
  /** The phone's menu: the networks still to come, on one muted line under the others. */
  comingLine: (names: readonly string[]) =>
    `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '')} are coming`,
} as const;

/** One of a network's limits a day, as its page shows it. */
export interface LimitShown {
  readonly key: string;
  readonly label: string;
  /** How many a day, as it stands for the person. */
  readonly most: number;
  /** A line under it: the network's cap in any 7 days. */
  readonly note: string | null;
}

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/**
 * A person's limits a day on a network, as its page shows them, read only: each step at the business's own limit
 * there, at most the network's starting one, halved while that network's training wheels are on (`slower`), with the
 * network's cap in any 7 days under its requests; then the kit's others: profiles read for good fits, the helpful
 * post and tidying up (halved too, as `automationOf`'s `slower` halves tidying). Owners and admins set the steps on
 * the same page.
 */
export function limitsShownOn(
  platform: Platform,
  rules: Pick<BusinessRules, 'dailyLimits' | 'networkLimits'>,
  slower: boolean,
): LimitShown[] {
  const kit = NETWORKS[platform];
  const now = networkLimitsNow(platform, slower, businessLimitsOn(rules, platform));
  const words = dailyWordsOn(platform);
  const tidy = tidyWordsOn(platform);
  return [
    ...DAILY_STEPS.map((step) => ({
      key: step,
      label: words[step].label,
      most: now[step],
      note:
        step === 'friend_request' && kit.weeklyRequests !== null
          ? SETTINGS_WORDS.weekly(kit.weeklyRequests)
          : null,
    })),
    { key: 'checks', label: SETTINGS_WORDS.profilesRead, most: kit.checksPerDay, note: null },
    ...(kit.forumAnswersPerDay !== null
      ? [
          {
            key: 'forum',
            label: SETTINGS_WORDS.forumAnswers,
            most: Math.min(kit.forumAnswersPerDay, now.comment),
            note: SETTINGS_WORDS.forumAnswersNote,
          },
        ]
      : []),
    ...(helpfulOn(platform)
      ? [{ key: 'helpful', label: SETTINGS_WORDS.helpfulPost, most: HELPFUL_PER_DAY, note: null }]
      : []),
    ...tidy.kinds.map((kind) => ({
      key: tidy.step[kind],
      label: cap(
        kind === 'cancel' ? tidy.cancel.done : `${kit.words.friends} ${tidy.unfriend.done}`,
      ),
      most: limitNow(kit.tidyLimits[tidy.step[kind]], slower),
      note: null,
    })),
  ];
}
