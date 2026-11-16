/**
 * Settings → You, Team and Your computer, as decision 170's second part lays them out (docs/outreach.md): each setting
 * a row that says how it stands, with Change for the ones that need more room; one Networks list on Team in place of a
 * card for each network; and what was asked of the computer with the same ones folded into a count. What the web and
 * the phone both show is worked out here. Browser-safe.
 */
import {
  businessLimitsOn,
  choicesFor,
  hourWords,
  WEEKDAY_WORDS,
  worksEveryDay,
  type AutomationSettings,
  type BusinessRules,
  type WorkingHours,
} from './automation';
import { OPEN_ASK_STATES, type AskShown } from './asks';
import {
  handsOffAllowed,
  handsOffOf,
  HANDS_OFF_KEYS,
  HANDS_OFF_WORDS,
  type HandsOff,
} from './hands-off';
import { DAILY_STEPS } from './limits';
import { seenWords } from './live';
import { dailyWordsOn } from './network-words';
import { networkLimitsNow, PLATFORMS, runsOnItsOwn, type Platform } from './networks';

/** "Facebook, LinkedIn and Threads". */
const listed = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Networks the person works that share a level, in the order they're listed, for the lines under How hands-off. */
export interface HandsOffGroup {
  /** Null: their own mix there. */
  readonly level: HandsOff | null;
  readonly networks: readonly Platform[];
}

/**
 * Each level the person's networks are at, with the networks at it (Settings → You): one group when every network
 * shares a level, more when they differ. Networks the extension doesn't run on its own are left out.
 */
export function handsOffGroups(
  settings: AutomationSettings,
  networks: readonly Platform[],
): HandsOffGroup[] {
  const groups: { level: HandsOff | null; networks: Platform[] }[] = [];
  for (const platform of networks.filter((p) => runsOnItsOwn(p))) {
    const level = handsOffOf(choicesFor(settings, platform));
    const group = groups.find((g) => g.level === level);
    if (group) group.networks.push(platform);
    else groups.push({ level, networks: [platform] });
  }
  return groups;
}

/** The levels the business lets its people pick, in the buttons' order: I do it myself always. */
export const levelsAllowed = (
  rules: Pick<BusinessRules, 'sendingAllowed' | 'repliesAllowed' | 'autopilotAllowed'>,
): HandsOff[] => HANDS_OFF_KEYS.filter((level) => handsOffAllowed(level, rules));

/** Working hours in a few words: "Mon–Fri, 9 AM–5 PM". */
export function hoursLine(hours: Pick<WorkingHours, 'start' | 'end' | 'days'>): string {
  const days = [...hours.days].sort((a, b) => a - b);
  const run = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  const dayWords =
    days.length === 7
      ? 'Every day'
      : !days.length
        ? 'No days'
        : run
          ? `${WEEKDAY_WORDS[days[0]!]}–${WEEKDAY_WORDS[days[days.length - 1]!]}`
          : days.map((d) => WEEKDAY_WORDS[d]).join(', ');
  return `${dayWords}, ${hourWords(hours.start)}–${hourWords(hours.end)}`;
}

/**
 * The business's most a day for each person on a network, in one line for Team's Networks list: "20 friend
 * requests, 15 first messages, 70 likes, 30 comments". A step it keeps at none is left out.
 */
export function teamLimitsLine(
  platform: Platform,
  rules: Pick<BusinessRules, 'dailyLimits' | 'networkLimits'>,
): string {
  const now = networkLimitsNow(platform, false, businessLimitsOn(rules, platform));
  const words = dailyWordsOn(platform);
  return DAILY_STEPS.filter((step) => now[step] > 0)
    .map((step) => `${now[step].toLocaleString('en-US')} ${words[step].many}`)
    .join(', ');
}

/** An ask, with the same ones after it folded under it (Settings → Your computer). */
export interface AskFolded {
  readonly ask: AskShown;
  /** The same ones, newest first, folded under it. */
  readonly same: readonly AskShown[];
}

/** What makes two asks the same, once both have ended: the network, the kind, what about, how it ended and its line. */
const sameKey = (a: AskShown): string | null =>
  (OPEN_ASK_STATES as readonly string[]).includes(a.state)
    ? null
    : JSON.stringify([a.platform, a.kind, a.target, a.state, (a.line ?? '').trim()]);

/**
 * What was asked of the computer, newest first, with the ones that ended the same way folded under the newest of
 * them: four "Couldn’t open your followers list on Threads." read as one line, and "The same, 3 more times since 9:12
 * AM" under it. One still going is never folded, so its Stop and Carry on stay to hand.
 */
export function foldAsks(asks: readonly AskShown[]): AskFolded[] {
  const out: { ask: AskShown; same: AskShown[] }[] = [];
  const byKey = new Map<string, { ask: AskShown; same: AskShown[] }>();
  for (const ask of asks) {
    const key = sameKey(ask);
    const first = key === null ? undefined : byKey.get(key);
    if (first) {
      first.same.push(ask);
      continue;
    }
    const entry = { ask, same: [] as AskShown[] };
    out.push(entry);
    if (key !== null) byKey.set(key, entry);
  }
  return out;
}

/** Settings → You, Team and Your computer: their words (decision 170, part 2). */
export const SETTINGS_PAGE_WORDS = {
  change: 'Change',
  done: 'Done',
  open: 'Open',
  hide: 'Hide',
  show: 'Show',
  // You
  /** Under How hands-off, on every network: each level and the networks at it. */
  groupLine: (group: HandsOffGroup) =>
    group.level === null ? HANDS_OFF_WORDS.mix : HANDS_OFF_WORDS.levels[group.level],
  groupNetworks: (group: HandsOffGroup) => group.networks.map((p) => PLATFORMS[p]).join(', '),
  hours: 'Working hours',
  hoursAbout: (hours: WorkingHours) =>
    worksEveryDay(hours)
      ? `${hoursLine(hours)}. Likes and requests go every day; new messages only on these days.`
      : `${hoursLine(hours)}. Nothing goes on other days.`,
  alerts: 'Alerts',
  alertsAbout: 'A reply handed to you always comes at once.',
  waiting: 'What waits for you',
  waitingAbout: 'Messages and steps to OK.',
  dayReportAbout: 'A push with the day’s numbers when your hours end.',
  acceptedAbout: 'Your friend request, invitation or follow, accepted.',
  pushModes: {
    bundled: 'One push every 2 hours',
    each: 'A push for each one',
  } as const,
  profiles: 'Your profiles',
  profilesAbout: 'Every network side by side, as a stranger sees them.',
  setUp: 'Set up',
  setUpAbout: 'Run it again any time, or open where it stands.',
  // Team
  peopleNetworks: (networks: readonly Platform[]) =>
    networks.length ? networks.map((p) => PLATFORMS[p]).join(', ') : 'No networks on yet',
  wheelsChip: 'Training wheels',
  wheelsLine: (network: string, ok: number, of: number, daysLeft: number) =>
    `${network} · ${ok.toLocaleString('en-US')} of ${of} OK’d · ${
      daysLeft ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} to go` : 'days done'
    }`,
  networks: 'Networks',
  networksAbout: 'Whether your team may use each one, and its most a day for each person.',
  limits: 'Limits',
  alwaysOn: 'Always on',
  offForTeam: 'Off for your team',
  stillLooked: 'Still being looked at: nothing to limit yet',
  picks: 'What people may pick',
  mayGo: 'How hands-off they may go',
  mayGoLine: (levels: readonly HandsOff[]) =>
    levels.length === HANDS_OFF_KEYS.length
      ? 'Any of the four.'
      : `${listed(levels.map((l) => HANDS_OFF_WORDS.levels[l]))}.`,
  starts: 'Where a new person starts',
  startsLine: (defaults: AutomationSettings) => {
    const level = handsOffOf(choicesFor(defaults, 'facebook'));
    return `${level === null ? HANDS_OFF_WORDS.mix : HANDS_OFF_WORDS.levels[level]}, ${hoursLine(defaults.hours)}.`;
  },
  wholeBusiness: 'For the whole business',
  countries: 'Countries to reach',
  countriesAbout: 'Who it can reach, by where they live.',
  contacts: 'Who from chats goes in Contacts',
  contactsAbout: 'From chats the AI reads.',
  contactsShort: {
    everyone: 'Everyone',
    tagged: 'Tagged or a prospect',
    prospects: 'Only prospects',
  } as const,
  warmUp: 'Warm up for, then unfollow or withdraw',
  warmUpAbout: 'For requests and follows nobody answered.',
  morning: 'Morning push',
  morningAbout: 'How many are on each person’s list today.',
  weekly: 'Weekly report by email',
  weeklyAbout: 'Each person’s week, on Monday morning.',
  extension: 'Where your team gets the extension',
  extensionOurs: 'HandsFreeOS’s own download.',
  extensionTheirs: 'Your own copy, from your link.',
  more: 'More settings',
  moreAbout: 'People found by topic checked a day.',
  // Your computer
  working: (name: string) => `${name} is working`,
  offline: (name: string) => `${name} is offline`,
  signedOut: (name: string) => `${name} is signed out`,
  noComputer: 'No computer yet',
  chips: { online: 'Online', offline: 'Offline', signedOut: 'Signed out' } as const,
  computerLine: (version: string | null, seen: string) =>
    version ? `Extension ${version}. Seen ${seen}.` : `Seen ${seen}.`,
  standingBy: (n: number) => `${n} more ${n === 1 ? 'computer' : 'computers'}, standing by`,
  rename: 'Rename',
  download: 'Download the extension',
  runTitle: 'Run a job now',
  runAbout: 'Most of these run on their own each day.',
  jobs: (n: number) => `${n} ${n === 1 ? 'job' : 'jobs'}`,
  asked: 'Asked lately',
  /** Under an ask that ended the same way more than once. */
  same: (more: number, since: string) =>
    `The same, ${more} more ${more === 1 ? 'time' : 'times'} since ${since}`,
} as const;

/** When the oldest of the same asks was asked, in the words under the folded line. */
export const sameSince = (same: readonly AskShown[], timeZone: string, now: number): string =>
  seenWords(same[same.length - 1]!.askedAt, timeZone, now);
