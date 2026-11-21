/**
 * How hands-off? (docs/outreach.md, decision 170; the owner, 16 Nov 2026, "1a 2a 3a"): one choice at the top of each
 * network's page in Settings, in place of the Sending, Replies and helpful posts lists, and one on Settings → You that
 * sets every network at once. Four levels, safest first:
 *
 * - **I do it myself**: nothing goes on its own; it notes what the person does and keeps their lists.
 * - **I OK each message**: steps go on their own, each message and reply waits for their tap.
 * - **Autopilot** (decision 151): each morning they OK who it reaches, then it does the rest. Each network has its own
 *   (`NetworkChoices.autopilot`, "2a").
 * - **All on its own**: everything goes on its own, with no daily OK.
 *
 * Each level is a set of the choices kept since the start (`LEVEL_PICKS`), so the extension, the Assistant and old
 * screens go on reading those. Choices that match no level read as the person's own mix (`handsOffOf` is null), with
 * their picks under More settings.
 */
import {
  autopilotSaid,
  choicesFor,
  type AutomationSettings,
  type BusinessRules,
  type NetworkChoices,
  type PostingMode,
  type ReplyMode,
  type SendingMode,
} from './automation';
import { HELPFUL_MODES_ON } from './helpful';
import { withNetwork } from './network-words';
import { NETWORKS, PLATFORM_KEYS, PLATFORMS, runsOnItsOwn, type Platform } from './networks';
import { COMMENT_HOLD_WORDS } from './sends';

export const HANDS_OFF_KEYS = ['myself', 'each', 'autopilot', 'own'] as const;
export type HandsOff = (typeof HANDS_OFF_KEYS)[number];

/** What each level sets, but Autopilot, whose picks are `AUTOPILOT_PICKS` over the person's own. */
const LEVEL_PICKS = {
  myself: { sending: 'off', replies: 'draft' },
  each: { sending: 'steps', replies: 'draft' },
  own: { sending: 'everything', replies: 'everything' },
} as const satisfies Record<
  Exclude<HandsOff, 'autopilot'>,
  { sending: SendingMode; replies: ReplyMode }
>;

/**
 * The level a network's choices are at, or null for the person's own mix. Autopilot's on wins, whatever its picks
 * show; "Messages first each morning" (`approve_all`) is still I OK each message, as it only moves messages up.
 */
export function handsOffOf(
  choices: Pick<NetworkChoices, 'sending' | 'replies' | 'autopilot'>,
): HandsOff | null {
  if (choices.autopilot) return 'autopilot';
  if (choices.sending === 'off' && choices.replies === 'draft') return 'myself';
  if (
    (choices.sending === 'steps' || choices.sending === 'approve_all') &&
    choices.replies === 'draft'
  )
    return 'each';
  if (choices.sending === 'everything' && choices.replies === 'everything') return 'own';
  return null;
}

/** Whether the business lets the person pick a level (decision 38): every choice it sets, allowed. */
export function handsOffAllowed(
  level: HandsOff,
  rules: Pick<BusinessRules, 'sendingAllowed' | 'repliesAllowed' | 'autopilotAllowed'>,
): boolean {
  if (level === 'autopilot') return rules.autopilotAllowed;
  const picks = LEVEL_PICKS[level];
  const sending =
    rules.sendingAllowed.includes(picks.sending) ||
    (level === 'each' && rules.sendingAllowed.includes('approve_all'));
  return sending && rules.repliesAllowed.includes(picks.replies);
}

/** A network's choices at a level, from what they are now: what changes, the rest left as it is. */
function levelChange(
  platform: Platform,
  level: Exclude<HandsOff, 'autopilot'>,
  now: NetworkChoices,
  rules: Pick<BusinessRules, 'sendingAllowed' | 'postingAllowed'>,
): Partial<NetworkChoices> {
  const picks = LEVEL_PICKS[level];
  // Messages first each morning stays theirs (it's under More settings), where the business allows only it.
  const sending: SendingMode =
    level === 'each' && (now.sending === 'approve_all' || !rules.sendingAllowed.includes('steps'))
      ? 'approve_all'
      : picks.sending;
  // All on its own posts its helpful posts on its own where the network and the business let it; a step back from it
  // goes back to posting after their OK.
  const ownPosts =
    HELPFUL_MODES_ON[platform].includes('own') && rules.postingAllowed.includes('own');
  const posting: PostingMode | undefined =
    level === 'own' && ownPosts
      ? 'own'
      : level !== 'own' && now.posting === 'own'
        ? 'after_ok'
        : undefined;
  return {
    autopilot: false,
    sending,
    replies: picks.replies,
    ...(posting ? { posting } : {}),
  };
}

/**
 * A level picked on one network: the settings to save, and the networks whose picks were chosen just now as Autopilot
 * went off there (`AutomationSaveInput.picked`), so the person's own from before Autopilot don't come back over them.
 * Every network's Autopilot is said first (`autopilotSaid`), so picking on one leaves the others as they stand.
 */
export function withHandsOff(
  settings: AutomationSettings,
  platform: Platform,
  level: HandsOff,
  rules: Pick<BusinessRules, 'sendingAllowed' | 'postingAllowed'>,
): { settings: AutomationSettings; picked: Platform[] } {
  const said = autopilotSaid(settings);
  if (level === 'autopilot')
    return { settings: withNetwork(said, platform, { autopilot: true }), picked: [] };
  const change = levelChange(platform, level, choicesFor(said, platform), rules);
  return { settings: withNetwork(said, platform, change), picked: [platform] };
}

/**
 * A level picked on Settings → You: every network the extension works on its own at it, those off too, so a network
 * turned on later starts there.
 */
export function withHandsOffEverywhere(
  settings: AutomationSettings,
  level: HandsOff,
  rules: Pick<BusinessRules, 'sendingAllowed' | 'postingAllowed'>,
): { settings: AutomationSettings; picked: Platform[] } {
  let next = autopilotSaid(settings);
  const picked: Platform[] = [];
  for (const p of PLATFORM_KEYS) {
    if (!runsOnItsOwn(p)) continue;
    const one = withHandsOff(next, p, level, rules);
    next = one.settings;
    picked.push(...one.picked);
  }
  return { settings: next, picked };
}

/**
 * The level every network the person works is at, for Settings → You: the one they share, or null when they differ
 * (each says its own on its page) or the person works none the extension runs.
 */
export function handsOffEverywhere(
  settings: AutomationSettings,
  networks: readonly Platform[],
): HandsOff | null {
  const levels = networks
    .filter((p) => runsOnItsOwn(p))
    .map((p) => handsOffOf(choicesFor(settings, p)));
  const first = levels[0];
  return first !== undefined && first !== null && levels.every((l) => l === first) ? first : null;
}

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** What its steps are called on a network: "Friend requests, likes and comments", "Follows, likes and comments". */
const stepsOn = (platform: Platform) =>
  `${cap(NETWORKS[platform].words.friendRequests)}, likes and comments`;

/** Where the network holds comments for an OK whatever the level, the line that says so. */
const holdOn = (platform: Platform): string | null =>
  NETWORKS[platform].commentsWait === 'never' ? null : COMMENT_HOLD_WORDS;

export const HANDS_OFF_WORDS = {
  title: 'How hands-off?',
  everywhereTitle: 'How hands-off, on every network',
  everywhereAbout:
    'Sets every network at once. Each network’s page in Settings can then pick its own.',
  levels: {
    myself: 'I do it myself',
    each: 'I OK each message',
    autopilot: 'Autopilot',
    own: 'All on its own',
  } satisfies Record<HandsOff, string>,
  /** Under each level as it's picked, in the network's words. */
  about(level: HandsOff, platform: Platform): string {
    const messages = NETWORKS[platform].messages;
    const hold = holdOn(platform);
    const words = {
      myself: 'You do every step. It notes them and keeps your lists.',
      each: messages
        ? `${stepsOn(platform)} go on their own. Each message and reply waits for your tap under Needs you.`
        : `${stepsOn(platform)} go on their own. Each reply waits for your tap under Needs you.`,
      autopilot:
        'Each morning you OK who it reaches for the first time. Then it does the rest on its own, inside your daily limits. A reply that needs you still waits, and your phone hears it.',
      own: 'Everything goes on its own, with no daily OK. A reply that needs you still waits, and your phone hears it.',
    } satisfies Record<HandsOff, string>;
    return level !== 'myself' && hold ? `${words[level]} ${hold}` : words[level];
  },
  /** The short line under each button. */
  short: {
    myself: 'You do every step',
    each: 'Steps go on their own',
    autopilot: 'You OK who, each morning',
    own: 'No daily OK',
  } satisfies Record<HandsOff, string>,
  mix: 'Your own mix',
  mixAbout:
    'You picked these yourself under More settings. Pick one of the four to set them all again.',
  notAllowed: (level: HandsOff, canManage: boolean) =>
    canManage
      ? `Your business doesn’t allow ${HANDS_OFF_WORDS.levels[level]} yet. Allow it under Social Outreach → Settings → Team.`
      : `Your business doesn’t allow ${HANDS_OFF_WORDS.levels[level]}. Ask an owner of this business to allow it under Social Outreach → Settings → Team.`,
  /** On Settings → You, while the networks differ. */
  differs: 'Your networks differ. Each network’s page in Settings says its own.',
  /** On a network's page, under Autopilot, while the person is on training wheels there. */
  wheels:
    'Training wheels still hold the first messages for your OK. Autopilot takes over once they’re done.',
  /** No runner on the network yet: nothing goes on its own there. */
  noRunner: (platform: Platform) =>
    `The extension doesn’t work ${PLATFORMS[platform]} on its own yet, so you do each step there.`,
} as const;

/** A line's first sentence: the one-line helper under a switch on a network's page, from its longer words. */
export function firstSentence(words: string): string {
  const end = words.search(/[.!?](\s|$)/);
  return end === -1 ? words : words.slice(0, end + 1);
}

/**
 * A network's page in Settings (decision 170): the status card, How hands-off?, What it does as short switches, the
 * daily limits and the profile as rows, and the rest folded under More settings.
 */
export const NETWORK_PAGE_WORDS = {
  whatItDoes: 'What it does',
  whileYouUse: (name: string) => `While you use ${name}`,
  limits: 'Daily limits',
  limitsLine: (parts: readonly string[]) =>
    parts.length
      ? `Up to ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`} a day.`
      : '',
  showLimits: 'Show every limit',
  hideLimits: 'Hide',
  fullSpeed: 'Go full speed',
  more: 'More settings',
  moreAbout: (name: string, helpful: boolean) =>
    helpful
      ? `Replies, helpful posts, account age, Check ${name} and setting it up again.`
      : `Replies, account age, Check ${name} and setting it up again.`,
  repliesAbout: 'Set by How hands-off? Change it here for your own mix.',
  messagesFirst: 'Messages first each morning',
  messagesFirstAbout: 'The day’s messages are ready first thing, to Approve all in one press.',
  /** The switch for tidying on its own, and Facebook's unfriending under More settings. */
  unfriend: 'Unfriend who isn’t a fit',
  unfriendAbout: 'Only friends the AI found aren’t a fit and you never chatted with, a few a day.',
  /** The switch for the requests the person gets, above how it answers them under More settings. */
  answerRequests: (requests: string) => `Answer the ${requests} you get`,
  answerRequestsAbout:
    'The AI reads each profile first. How it answers them is under More settings.',
  howItAnswers: (requests: string) => `How it answers the ${requests} you get`,
  joinGroups: 'Join more groups when mine run low',
  joinGroupsAbout: 'Up to 3 good ones a day. Off: only the groups you’re in.',
  setUpAgain: (name: string) => `Set up ${name} again`,
  setUpAgainAbout: 'Its short setup, from Chrome’s Allow to your first day there.',
  /** Under Autopilot: what it picks, and where the rest is. */
  piloted: 'Autopilot picks this while it’s on.',
  wholeAutopilot:
    'Autopilot is on for all your networks. Pick another here to set this one on its own.',
} as const;
