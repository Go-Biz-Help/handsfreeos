/**
 * The status card at the top of each network's page in Settings, and its line on Today's network cards (docs/outreach.md,
 * decision 170): what the extension is really doing on that network, in one of a few states, so nobody has to read the
 * settings to find out whether it's working.
 *
 * - **Running**: its day is going there, and nothing waits on the person.
 * - **Waiting on you**: something only the person can do holds it or waits for them: their computer is offline or
 *   has no extension, Chrome hasn't let it on the network, or messages or Autopilot's people wait for their OK. The
 *   rest keeps running.
 * - **Stuck**: the same step failed 3 times in a row, and nothing else went on that network for an hour (`stuckOn`).
 * - **Stopped for today**: a warning there, or Stop for today pressed.
 * - **Resting**: outside the working hours; **Yours**: I do it myself, or the extension doesn't work it on its own.
 *
 * Browser-safe: the web and the phone both read it, so they always say the same.
 */
import { DAILY_STEPS, type DailyStep } from './limits';
import { nextInHours, workHours, workWindow } from './automation';
import type { HandsOff } from './hands-off';
import {
  clockWords,
  dayGoing,
  isOffline,
  offlineWords,
  startWords,
  type LiveOutput,
  type LiveStep,
} from './live';
import { dailyWordsOn } from './network-words';
import { NETWORKS, PLATFORM_KEYS, PLATFORMS, runsOnItsOwn, type Platform } from './networks';

export const NETWORK_STATES = [
  'running',
  'waiting',
  'stuck',
  'stopped',
  'resting',
  'yours',
] as const;
export type NetworkState = (typeof NETWORK_STATES)[number];

/** How many of the same failure in a row, with nothing else on the network for `STUCK_QUIET_MINUTES`, is stuck. */
export const STUCK_FAILURES = 3;
export const STUCK_QUIET_MINUTES = 60;

/** What the card or a line shows the person to do, when there's something. */
export type NetworkAct = 'review' | 'people' | 'computer' | 'today' | null;

export interface NetworkStatus {
  readonly state: NetworkState;
  /** The card's heading: "Facebook is running", "3 messages wait for your OK". */
  readonly title: string;
  /** The chip beside it: "Running till 5:00 PM", "Waiting on you", "Stuck since 9:12 AM". */
  readonly chip: string;
  /** What's going on, and whether the person needs to do anything. */
  readonly line: string;
  readonly act: NetworkAct;
}

/** The network a feed line is about: another network's lines start with its name, Facebook's with none. */
export function networkOfLine(line: string): Platform {
  return (
    PLATFORM_KEYS.find((p) => p !== 'facebook' && line.startsWith(`${PLATFORMS[p]}: `)) ??
    'facebook'
  );
}

/** A feed line without the network's name in front. */
const bare = (line: string, platform: Platform) =>
  platform !== 'facebook' && line.startsWith(`${PLATFORMS[platform]}: `)
    ? line.slice(PLATFORMS[platform].length + 2)
    : line;

/**
 * Whether a network is stuck now (`STUCK_FAILURES`, `STUCK_QUIET_MINUTES`; the owner's default, 16 Nov 2026): its
 * newest feed lines the same failure that many times in a row, and nothing else there for the quiet time. Since the
 * first of those failures, with its words; null when it isn't. `steps` come newest first, as the feed gives them.
 */
export function stuckOn(
  steps: readonly LiveStep[],
  platform: Platform,
  now: number,
): { since: string; line: string } | null {
  const mine = steps.filter(
    (s) => s.kind !== 'day' && s.kind !== 'stopped' && networkOfLine(s.line) === platform,
  );
  const newest = mine[0];
  if (newest?.kind !== 'failed') return null;
  let run = 0;
  while (mine[run]?.kind === 'failed' && mine[run]!.line === newest.line) run += 1;
  if (run < STUCK_FAILURES) return null;
  // Anything else there lately, or the failures all within the quiet time: not stuck yet.
  const other = mine.slice(run).find((s) => s.kind !== 'failed');
  const quiet = STUCK_QUIET_MINUTES * 60_000;
  if (other && now - new Date(other.at).getTime() < quiet) return null;
  const first = mine[run - 1]!;
  if (now - new Date(first.at).getTime() < quiet) return null;
  return { since: first.at, line: bare(newest.line, platform) };
}

/** "3 friend requests", "1 like": a daily step's count, in the network's words. */
function countWords(platform: Platform, step: DailyStep, n: number): string {
  const many = dailyWordsOn(platform)[step].many;
  if (n !== 1) return `${n} ${many}`;
  const one =
    step === 'friend_request' ? NETWORKS[platform].words.friendRequest : many.replace(/s$/, '');
  return `${n} ${one}`;
}

/** Today's steps on a network so far, in a line: "Today so far: 3 friend requests and 12 likes." */
export function soFarWords(platform: Platform, limits: LiveOutput['limits']): string {
  const parts = DAILY_STEPS.filter((s) => limits[s].done > 0).map((s) =>
    countWords(platform, s, limits[s].done),
  );
  if (!parts.length) return 'Nothing yet today.';
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `Today so far: ${list}.`;
}

export const NETWORK_STATUS_WORDS = {
  waitingChip: 'Waiting on you',
  stoppedChip: 'Stopped for today',
  review: 'Review',
  people: 'OK the people',
  computer: 'Your computer',
  today: 'Open Today',
  rest: 'The rest keeps running.',
  /** The card's link to Today, for that network. */
  seeWhat: 'See what happened',
} as const;

/** The live view a network's status reads: `outreach.live` for that network. */
export type StatusLive = Pick<
  LiveOutput,
  'timezone' | 'day' | 'computer' | 'limits' | 'warning' | 'hours' | 'sending' | 'steps'
>;

/**
 * A network's status now (decision 170), from its live view and what waits on the person there: `waiting` counts
 * Needs you's items on that network, `people` Autopilot's people still waiting for the OK there. `level` is How
 * hands-off? there; `chromeBlocked` says the working computer told us Chrome hasn't let it on the network.
 */
export function networkStatus(input: {
  readonly platform: Platform;
  readonly live: StatusLive;
  readonly level: HandsOff | null;
  readonly waiting: number;
  readonly people: number;
  readonly chromeBlocked?: boolean;
  readonly now: number;
}): NetworkStatus {
  const { platform, live, level, now } = input;
  const name = PLATFORMS[platform];
  const W = NETWORK_STATUS_WORDS;
  const tz = live.timezone || 'UTC';
  const soFar = soFarWords(platform, live.limits);
  const next = live.hours ? nextInHours(workHours(live.hours), tz, now) : null;
  const backWords = next !== null ? `Back ${startWords(next, tz, now)}` : 'Back tomorrow';
  if (!runsOnItsOwn(platform))
    return {
      state: 'yours',
      title: `You do each step on ${name}`,
      chip: 'You do each step',
      line: `The extension doesn’t work ${name} on its own yet. It notes what you do there and keeps your lists.`,
      act: null,
    };
  if (live.warning?.today || live.day.why === 'warning')
    return {
      state: 'stopped',
      title: `Stopped on ${name} for today`,
      chip: W.stoppedChip,
      line: `${name} showed a warning, so it stopped to keep your account safe. Your other networks go on. ${backWords}.`,
      act: null,
    };
  if (live.day.state === 'stopped')
    return {
      state: 'stopped',
      title: `Stopped on ${name} for today`,
      chip: W.stoppedChip,
      line: `Stop for today was pressed${live.day.at ? ` at ${clockWords(live.day.at, tz)}` : ''}. Start it again on Today, or it’s ${backWords.toLowerCase()}.`,
      act: 'today',
    };
  const c = live.computer;
  if (!c)
    return {
      state: 'waiting',
      title: `${name} waits for your computer`,
      chip: W.waitingChip,
      line: 'Add the extension to Chrome on your computer. Settings → Your computer has the download.',
      act: 'computer',
    };
  if (c.state === 'signed_out')
    return {
      state: 'waiting',
      title: `${name} waits for you to sign in`,
      chip: W.waitingChip,
      line: `The extension on ${c.name} is signed out. Open it in Chrome and sign in.`,
      act: 'computer',
    };
  if (input.chromeBlocked)
    return {
      state: 'waiting',
      title: `${name} waits for Chrome`,
      chip: W.waitingChip,
      line: `Chrome hasn’t let the extension on ${name} yet. On ${c.name}, click the extension’s icon, then Allow on ${name}.`,
      act: 'computer',
    };
  if (level === 'myself' || live.sending === 'off')
    return {
      state: 'yours',
      title: `You do every step on ${name}`,
      chip: 'I do it myself',
      line: `It notes what you do and keeps your lists. ${soFar}`,
      act: null,
    };
  const going = dayGoing({ ...live, now, platform });
  if (!going) {
    if (next !== null && next > now)
      return {
        state: 'resting',
        title: `${name} starts ${startWords(next, tz, now)}`,
        chip: 'Outside your hours',
        line: `It works in your working hours. ${soFar}`,
        act: null,
      };
    return {
      state: 'resting',
      title: `${name} waits for Start my day`,
      chip: 'Not started',
      line: 'Press Start my day on Today to start it.',
      act: 'today',
    };
  }
  if (isOffline(c.lastSeenAt, now))
    return {
      state: 'waiting',
      title: 'Your computer is offline',
      chip: W.waitingChip,
      line: offlineWords(c.lastSeenAt, tz, now),
      act: 'computer',
    };
  const stuck = stuckOn(live.steps, platform, now);
  if (stuck)
    return {
      state: 'stuck',
      title: `${name} is stuck on one step`,
      chip: `Stuck since ${clockWords(stuck.since, tz)}`,
      line: `${stuck.line.replace(/\s*$/, '')} It keeps trying on its own.`,
      act: null,
    };
  if (input.people > 0)
    return {
      state: 'waiting',
      title: `${input.people} ${input.people === 1 ? 'person waits' : 'people wait'} for your OK`,
      chip: W.waitingChip,
      line: `Autopilot reaches them on ${name} once you OK them. ${W.rest}`,
      act: 'people',
    };
  if (input.waiting > 0)
    return {
      state: 'waiting',
      title: `${input.waiting} ${input.waiting === 1 ? 'thing waits' : 'things wait'} for you on ${name}`,
      chip: W.waitingChip,
      line: `They’re under Needs you. ${W.rest}`,
      act: 'review',
    };
  const window = live.hours ? workWindow(workHours(live.hours), tz, now) : null;
  return {
    state: 'running',
    title: level === 'autopilot' ? `Autopilot is running ${name}` : `${name} is running`,
    chip: window ? `Running till ${clockWords(window.to, tz)}` : 'Running',
    line: level === 'each' ? `${soFar} Messages wait for your tap.` : soFar,
    act: null,
  };
}

/** A state's place, for the card's colour: good, waiting on the person, needs a look, or plain. */
export function networkTone(state: NetworkState): 'good' | 'waiting' | 'warn' | 'plain' {
  if (state === 'running') return 'good';
  if (state === 'waiting') return 'waiting';
  if (state === 'stuck' || state === 'stopped') return 'warn';
  return 'plain';
}
