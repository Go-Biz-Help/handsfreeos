/**
 * Live status and control (docs/outreach.md, decision 41): what the extension is doing right now, told to HandsFreeOS
 * so the app can show it, and the person's day, which the app can start and stop.
 *
 * - **Computers:** each place the extension runs for a person is a computer, with an id it makes once and a plain name
 *   ("Chrome on Windows"). Settings follow the person; only one computer works at a time, the one they used most
 *   recently (the panel opened there, a step of their own, signing in, Start or Stop pressed there). The others stand
 *   by and say why. A fresh install takes the place of their computer by the same plain name rather than making
 *   another (`replacedComputer`), and they can remove the ones they don't use (decision 85).
 * - **The beat:** every minute while Chrome is open, and soon after a change, the extension says it's there, what it
 *   shows (working, waiting, stopped…), its line ("Sending a friend request to Dana Cole…"), the next step's time,
 *   and the steps it took since (`outreach.live.beat`). A beat that changes nothing tells nobody.
 * - **The day:** **Start my day** and **Stop for today** are kept in HandsFreeOS (`outreach.day.start`,
 *   `outreach.day.stop`), pressed in the app, on the phone or in the extension; the extension follows within seconds.
 *   An older press never undoes a newer one, and a Facebook warning stops the day whatever was pressed.
 * - **Offline:** no beat for a few minutes, and the app says the computer is offline and when it was last seen.
 *
 * Owners and admins see each person's status, today's counts and how many wait, never the lines or the feed, which
 * name the people being reached. Browser-safe: the web, the phone, the extension and the worker read it.
 */
import { z } from 'zod';
import { addDays, localDateOf } from '../../calendar/engine/zoned';
import { fmtDateShort, fmtTime } from '../../calendar/when';
import {
  nextInHours,
  SENDING_MODE_KEYS,
  workWindow,
  WorkingHours,
  type SendingMode,
} from './automation';
import { LIST_MARK_KEYS, listsWaitWords, ListsSaved, type ListMark } from './lists';
import { runsOnItsOwn } from './networks';
import { PLATFORM_KEYS, PLATFORMS, type Platform } from './playbooks';
import { WarningState } from './tidy';

/** How often the extension says it's there, and how long without that before the app calls the computer offline. */
export const BEAT_MINUTES = 1;
export const OFFLINE_MINUTES = 3;
/** A change to the line alone tells the app at most this often (HandsFreeOS), and is sent at most this often (the extension). */
export const LINE_TELL_SECONDS = 45;
export const LINE_BEAT_SECONDS = 20;
/**
 * While a step before the first day runs (`doing`), its count goes up on the web and the phone: the line is sent and
 * told at most this often instead.
 */
export const PRE_DAY_LINE_SECONDS = 4;
/** Feed lines one beat carries, lines the extension keeps unsent, lines the Live tab shows, and days kept. */
export const LIVE_STEPS_SENT_MOST = 20;
export const LIVE_STEPS_UNSENT_MOST = 50;
export const LIVE_STEPS_SHOWN_MOST = 200;
export const LIVE_KEEP_DAYS = 7;
/**
 * A computer not seen for this long goes (the worker's `outreach.live_prune`), unless it's the one that works for its
 * person; seen again, it comes back as new.
 */
export const COMPUTER_KEEP_DAYS = 30;
/** A computer's name, as the person may write it, and as the extension may send it (numbered, it stays within this). */
export const COMPUTER_NAME_MOST = 40;
/** The most a line says: the status line and each line of the feed. A longer one is cut short, never refused. */
export const LINE_MOST = 300;
/**
 * How often the Live tab asks again while it's open. A heartbeat that changes nothing tells nobody, so without this the
 * last-seen time it shows would stand still and a computer still beating would look offline. Under OFFLINE_MINUTES,
 * less a beat, so a computer that beats every minute is never shown offline.
 */
export const LIVE_REFETCH_SECONDS = 60;

const MIN = 60_000;

/** A line cut to `most` characters, ending in "…" when it was longer. */
export function clipLine(line: string, most = LINE_MOST): string {
  return line.length > most ? `${line.slice(0, most - 1).trimEnd()}…` : line;
}
/** A line as it's kept: trimmed and cut short, never refused for its length. */
const keptLine = z
  .string()
  .trim()
  .transform((s) => clipLine(s));

/** What a computer says it's doing (`computers.state`). */
export const REPORTED_STATES = {
  working: 'Working',
  waiting: 'Waiting for the next step',
  idle: 'Nothing to do right now',
  stopped: 'Stopped for today',
  off: 'Not working on its own',
  standby: 'Standing by',
  trouble: 'Paused',
  signed_out: 'Signed out of the extension',
} as const;
export type ReportedState = keyof typeof REPORTED_STATES;
export const REPORTED_STATE_KEYS = Object.keys(REPORTED_STATES) as [
  ReportedState,
  ...ReportedState[],
];

/** What the app shows for a person: the above, plus offline and no computer yet. */
export const SHOWN_STATES = {
  ...REPORTED_STATES,
  offline: 'Offline',
  none: 'No computer yet',
} as const;
export type ShownState = keyof typeof SHOWN_STATES;
export const SHOWN_STATE_KEYS = Object.keys(SHOWN_STATES) as [ShownState, ...ShownState[]];

/** The feed's lines: a step done, one passed over, a once-a-day job, a stop on a warning, and the day pressed. */
export const STEP_KINDS = ['done', 'passed', 'job', 'stopped', 'day'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
/** The extension sends these; HandsFreeOS writes `stopped` (a warning) and `day` itself. */
export const SENT_STEP_KINDS = ['done', 'passed', 'job'] as const;

export const DAY_STATES = ['started', 'stopped'] as const;
export type DayState = (typeof DAY_STATES)[number];
export const DAY_WHY = ['person', 'warning'] as const;
export type DayWhy = (typeof DAY_WHY)[number];
export const DAY_VIA = ['web', 'mobile', 'extension'] as const;
export type DayVia = (typeof DAY_VIA)[number];
const VIA_WORDS: Record<DayVia, string> = {
  web: 'in HandsFreeOS',
  mobile: 'on your phone',
  extension: 'in the extension',
};

const moment = z.iso.datetime();

/** The person's day as HandsFreeOS keeps it. */
export const LiveDay = z.object({
  /** The business's day: "2026-10-10". */
  date: z.string(),
  /** Nothing pressed today, started, or stopped. */
  state: z.enum(['none', ...DAY_STATES]),
  why: z.enum(DAY_WHY).nullable(),
  via: z.enum(DAY_VIA).nullable(),
  at: moment.nullable(),
});
export type LiveDay = z.output<typeof LiveDay>;

/** One of the person's computers, as the app shows it. */
export const ComputerShown = z.object({
  /** The row's id (not the extension's own install id). */
  id: z.uuid(),
  name: z.string(),
  lastSeenAt: moment,
  activeAt: moment.nullable(),
  /** The one that works: the most recently used. */
  working: z.boolean(),
  state: z.enum(REPORTED_STATE_KEYS),
  version: z.string().nullable(),
  /** The networks Chrome lets it on, as it last said; null from a build that doesn't say (./reports.ts). */
  allowed: z.array(z.enum(PLATFORM_KEYS)).nullable().optional(),
});
export type ComputerShown = z.output<typeof ComputerShown>;

/** What a computer shows right now, as it said. */
export const LiveStatus = z.object({
  state: z.enum(REPORTED_STATE_KEYS),
  line: z.string().max(300).nullable(),
  lineAt: moment.nullable(),
  nextAt: moment.nullable(),
  /** The step before the first day it's doing (./lists.ts), whose progress the line is; null while it does other work. */
  doing: z.enum(LIST_MARK_KEYS).nullable().default(null),
});
export type LiveStatus = z.output<typeof LiveStatus>;

export const LiveStep = z.object({
  at: moment,
  kind: z.enum(STEP_KINDS),
  line: z.string(),
});
export type LiveStep = z.output<typeof LiveStep>;

const LIMIT = z.object({ done: z.number().int().min(0), most: z.number().int().min(0) });
/** Today's steps against the daily limits, as Today counts them. */
export const LiveLimits = z.object({
  friend_request: LIMIT,
  first_message: LIMIT,
  follow_up: LIMIT,
  comment: LIMIT,
  like: LIMIT,
});

// ------------------------------------------------------------------------------------------------- operations

export const LiveBeatInput = z.object({
  workspaceId: z.uuid(),
  computer: z.object({
    /** The id the extension made once and keeps: its install id. */
    id: z.uuid(),
    name: z
      .string()
      .trim()
      .min(1)
      .transform((s) => clipLine(s, COMPUTER_NAME_MOST)),
    version: z.string().trim().max(20).nullable().default(null),
    /** The networks Chrome lets it on (decision 74); null from a build that doesn't say. */
    allowed: z.array(z.enum(PLATFORM_KEYS)).max(PLATFORM_KEYS.length).nullable().default(null),
    /**
     * Its id was made since its last answered beat: a fresh install, which takes the place of the person's computer
     * by the same plain name (`replacedComputer`, decision 85). False from a build before 0.88.0.
     */
    fresh: z.boolean().default(false),
  }),
  /** The person used this computer just now: the panel opened, a step of their own, sign-in. */
  active: z.boolean().default(false),
  status: z.object({
    state: z.enum(REPORTED_STATE_KEYS),
    line: keptLine.nullable().default(null),
    lineAt: moment.nullable().default(null),
    nextAt: moment.nullable().default(null),
    /** The step before the first day under way (./lists.ts): the line is its progress. Null for any other work. */
    doing: z.enum(LIST_MARK_KEYS).nullable().default(null),
  }),
  /** Feed lines since the last beat that was answered, oldest first, each with the extension's own id. */
  steps: z
    .array(
      z.object({
        id: z.uuid(),
        at: moment,
        kind: z.enum(SENT_STEP_KINDS),
        line: z
          .string()
          .trim()
          .min(1)
          .transform((s) => clipLine(s)),
      }),
    )
    .max(LIVE_STEPS_SENT_MOST)
    .default([]),
});
export type LiveBeatInput = z.input<typeof LiveBeatInput>;

export const LiveBeatOutput = z.object({
  /** This computer's row id, which the live channel's events name. */
  computerId: z.uuid(),
  /** Its name as kept: the person may have renamed it. */
  name: z.string(),
  /** Whether it's the one that works. */
  working: z.boolean(),
  /** The one that works, when it isn't this one. */
  workingName: z.string().nullable(),
  /** Facebook's day, which every build of the extension follows. */
  day: LiveDay,
  /**
   * Each other network's day (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Each network on its own"): LinkedIn's
   * runner works only while LinkedIn's is started, and a stop there ends only LinkedIn's work. Empty from a HandsFreeOS
   * before networks.
   */
  days: z
    .object({ linkedin: LiveDay, instagram: LiveDay, alignable: LiveDay })
    .partial()
    .default({}),
  /** The ids of the lines sent that are kept now: the extension lets them go. */
  stepsKept: z.array(z.uuid()),
  /** Asks from HandsFreeOS waiting for this computer (./asks.ts): 0 when it isn't the one that works. */
  asks: z.number().int().min(0),
});
export type LiveBeatOutput = z.output<typeof LiveBeatOutput>;

export const DayInput = z.object({
  workspaceId: z.uuid(),
  /** The network whose day it is: each network's day is its own, so stopping one leaves the others going. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  /** The extension's install id, when pressed there: that computer becomes the one that works. */
  installId: z.uuid().optional(),
});
export type DayInput = z.input<typeof DayInput>;
export const DayOutput = LiveDay;

export const ComputerRenameInput = z.object({
  workspaceId: z.uuid(),
  /** The computer's row id. */
  computerId: z.uuid(),
  name: z
    .string()
    .trim()
    .min(1, { error: 'Give the computer a name.' })
    .max(COMPUTER_NAME_MOST, { error: `Keep the name to ${COMPUTER_NAME_MOST} characters.` }),
});
export type ComputerRenameInput = z.input<typeof ComputerRenameInput>;
export const ComputerRenameOutput = z.object({ computerId: z.uuid(), name: z.string() });

/** The most computers one remove takes: every one a person could have kept. */
export const COMPUTERS_REMOVED_MOST = 200;
export const ComputerRemoveInput = z.object({
  workspaceId: z.uuid(),
  /** The computers' row ids: one, or every one standing by. */
  computerIds: z
    .array(z.uuid())
    .min(1, { error: 'Pick a computer to remove.' })
    .max(COMPUTERS_REMOVED_MOST),
});
export type ComputerRemoveInput = z.input<typeof ComputerRemoveInput>;
export const ComputerRemoveOutput = z.object({ removed: z.array(z.uuid()) });

export const LiveInput = z.object({
  workspaceId: z.uuid(),
  /**
   * The network whose day, warning, limits, choice and lists it gives: each network's are its own. The computers, what
   * the working one says and the feed are the person's, the same for every network. Facebook's when left out.
   */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
});
export type LiveInput = z.input<typeof LiveInput>;

export const LiveOutput = z.object({
  /** The business's time zone, for the times shown. */
  timezone: z.string(),
  /** The server's clock, for the app's offline check. */
  now: moment,
  /** What the person lets the extension do on its own. */
  sending: z.enum(SENDING_MODE_KEYS),
  /** Whether the business allows anything but doing everything yourself. */
  canSend: z.boolean(),
  day: LiveDay,
  /** The computer that works, and the person's others, working first, then the latest seen. */
  computer: ComputerShown.nullable(),
  computers: z.array(ComputerShown),
  /** The working computer's status, as it last said. */
  status: LiveStatus.nullable(),
  limits: LiveLimits,
  /** Everything waiting for the person (Waiting for you, ./waiting.ts), counted as that list counts it. */
  waiting: z.number().int().min(0),
  warning: WarningState.nullable(),
  /**
   * When the person's own lists were last saved to their end (./lists.ts): the first time, a day started waits for
   * them. Missing from an API from before them.
   */
  lists: ListsSaved.optional(),
  /**
   * The person's working hours, the same on every network: with nothing pressed, each network's day starts on its own
   * in them (decision 28). Missing from an API from before it gave them.
   */
  hours: WorkingHours.optional(),
  /** Today's steps, the newest first. */
  steps: z.array(LiveStep),
});
export type LiveOutput = z.output<typeof LiveOutput>;

export const LiveTeamInput = z.object({
  workspaceId: z.uuid(),
  /** The network whose days, counts and warnings it gives, as the person's own live view: Facebook's when left out. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
});
export type LiveTeamInput = z.input<typeof LiveTeamInput>;

/** Each person's status for owners and admins (decision 24): never their lines, feed or messages. */
export const LiveTeamOutput = z.object({
  timezone: z.string(),
  now: moment,
  /** The network it's about: on another than Facebook, only the people who have it on. */
  platform: z.enum(PLATFORM_KEYS),
  people: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string(),
      /** What to show for them now; the app works it out again as time passes (`shownState`), for offline. */
      state: z.enum(SHOWN_STATE_KEYS),
      day: LiveDay,
      sending: z.enum(SENDING_MODE_KEYS),
      /** The computer that works for them: its name, what it says it's doing (no line), and when it was last seen. */
      computer: z
        .object({ name: z.string(), state: z.enum(REPORTED_STATE_KEYS), lastSeenAt: moment })
        .nullable(),
      limits: LiveLimits,
      waiting: z.number().int().min(0),
      warned: z.boolean(),
    }),
  ),
});
export type LiveTeamOutput = z.output<typeof LiveTeamOutput>;

// ------------------------------------------------------------------------------------------------- rules

/** Whether a computer last seen then is offline now. */
export const isOffline = (lastSeenAt: string | Date | number, now: number): boolean =>
  now - new Date(lastSeenAt).getTime() > OFFLINE_MINUTES * MIN;

/**
 * What the live checklist before the first day shows under way (./lists.ts, `preDaySteps`), on the web and the phone:
 * the step the working computer says it's doing, with its line as that step's count, while it works and is online.
 * Nothing while it does other work, so another job's line never shows under a step.
 */
export function preDayNow(
  live: { readonly computer: ComputerShown | null; readonly status: LiveStatus | null },
  now: number,
): { doing: ListMark | null; line: string | null } {
  const c = live.computer;
  const working = c !== null && c.state === 'working' && !isOffline(c.lastSeenAt, now);
  const doing = working ? (live.status?.doing ?? null) : null;
  return { doing, line: doing ? (live.status?.line ?? null) : null };
}

/** What the app shows for a person: no computer, signed out, offline, stopped today, not on its own, or as it said. */
export function shownState(input: {
  readonly computer: { readonly state: ReportedState; readonly lastSeenAt: string } | null;
  readonly day: Pick<LiveDay, 'state'>;
  readonly sending: SendingMode;
  readonly now: number;
}): ShownState {
  const { computer } = input;
  if (!computer) return 'none';
  if (computer.state === 'signed_out') return 'signed_out';
  if (isOffline(computer.lastSeenAt, input.now)) return 'offline';
  if (input.day.state === 'stopped') return 'stopped';
  if (input.sending === 'off') return 'off';
  return computer.state;
}

/** A shown state's place, for a coloured chip: good, waiting, needs a look, or plain. */
export function stateTone(state: ShownState): 'good' | 'waiting' | 'warn' | 'plain' {
  if (state === 'working') return 'good';
  if (state === 'waiting' || state === 'idle') return 'waiting';
  if (state === 'offline' || state === 'trouble') return 'warn';
  return 'plain';
}

/** "2:14 PM" on the business's clock. */
export function clockWords(at: string | Date | number, timeZone: string): string {
  return fmtTime(new Date(at).getTime(), timeZone || 'UTC');
}

/** When something was or will be: "2:14 PM" today, "yesterday at 2:14 PM", "tomorrow at 9:12 AM", else "Mon, Oct 5 at 2:14 PM". */
export function seenWords(at: string | Date | number, timeZone: string, now: number): string {
  const ms = new Date(at).getTime();
  const day = localDateOf(ms, timeZone || 'UTC');
  const today = localDateOf(now, timeZone || 'UTC');
  const clock = clockWords(ms, timeZone);
  if (day === today) return clock;
  if (day === addDays(today, -1)) return `yesterday at ${clock}`;
  if (day === addDays(today, 1)) return `tomorrow at ${clock}`;
  return `${fmtDateShort(day)} at ${clock}`;
}

/** The owner's words for a computer that's offline (decision 41). */
export const offlineWords = (lastSeenAt: string | Date, timeZone: string, now: number): string =>
  `Your computer is offline: nothing runs until Chrome is open. Last seen ${seenWords(lastSeenAt, timeZone, now)}.`;

/** What a computer that stands by says, in the extension. */
export const standDownWords = (workingName: string | null): string =>
  `${workingName ?? 'Another computer'} is working for you now, so this one stands by. Open the panel here to work from this computer instead.`;

/**
 * Where a network's day stands (Facebook's when left out), under Start my day and Stop for today: empty when nothing
 * was pressed today. With the person's lists there, a day started the first time says it waits for them to be saved.
 */
export function dayWords(
  day: LiveDay,
  timeZone: string,
  lists?: ListsSaved | null,
  platform: Platform = 'facebook',
): string {
  if (day.state === 'none') return '';
  if (day.why === 'warning') return `Stopped for today: ${PLATFORMS[platform]} showed a warning.`;
  const at = day.at ? ` at ${clockWords(day.at, timeZone)}` : '';
  const via = day.via ? ` ${VIA_WORDS[day.via]}` : '';
  if (day.state !== 'started') return `Stopped for today${at}${via}.`;
  // The first time, the day waits for the person's lists to be saved (./lists.ts): it says why.
  const waiting = listsWaitWords(lists, true, platform);
  return waiting ? `Started${at}${via}. ${waiting}` : `Started${at}${via}.`;
}

/** When something starts, after "Starts on its own": "at 10:00 AM" today, "tomorrow at 10:00 AM", else "on Mon, Nov 2 at 10:00 AM". */
export function startWords(at: number, timeZone: string, now: number): string {
  const when = seenWords(at, timeZone, now);
  if (localDateOf(at, timeZone || 'UTC') === localDateOf(now, timeZone || 'UTC'))
    return `at ${when}`;
  return when.startsWith('tomorrow') ? when : `on ${when}`;
}

/**
 * When a network's day goes on its own, with nothing pressed there today (decision 28; the owner, 28 Oct 2026: "we
 * shouldn't have to start the day for each platform manually, they should just start at the time selected in our
 * settings"): before the person's working hours, "Starts on its own at 10:00 AM"; in them, "Going on its own until
 * 5:00 PM". Empty once a press says the day (`dayWords`), when Sending is off there or the extension doesn't work it
 * on its own, and from an API from before it gave the hours.
 */
export function ownDayWords(input: {
  readonly day: LiveDay;
  readonly sending: SendingMode;
  readonly hours?: WorkingHours | undefined;
  readonly timezone: string;
  readonly now: number;
  readonly platform?: Platform;
}): string {
  const { day, hours, timezone, now } = input;
  if (day.state !== 'none' || input.sending === 'off' || !hours) return '';
  if (!runsOnItsOwn(input.platform ?? 'facebook')) return '';
  const next = nextInHours(hours, timezone || 'UTC', now);
  if (next === null) return '';
  if (next > now) return `Starts on its own ${startWords(next, timezone, now)}.`;
  const window = workWindow(hours, timezone || 'UTC', now);
  return window ? `Going on its own until ${clockWords(window.to, timezone)}.` : '';
}

/** A network's day in a line on Today: what was pressed there today, or when it goes on its own. */
export const todayWords = (
  live: Pick<LiveOutput, 'day' | 'timezone' | 'lists' | 'sending' | 'hours'>,
  platform: Platform,
  now: number,
): string =>
  dayWords(live.day, live.timezone, live.lists, platform) ||
  ownDayWords({ ...live, now, platform });

/** The feed's line for a day pressed, which HandsFreeOS writes. */
export const dayLine = (state: DayState, via: DayVia): string =>
  `You pressed ${state === 'started' ? 'Start my day' : 'Stop for today'} ${VIA_WORDS[via]}.`;

/**
 * The feed's line for a warning, which HandsFreeOS writes: the network's words cut short so the whole stays a line.
 * It names the network, since the others go on.
 */
export function warningLine(words: string, platform: Platform = 'facebook'): string {
  const network = PLATFORMS[platform];
  const before = `${network} showed a warning (“`;
  const after = `”). The extension stopped on ${network} for today, and your ${network} limits are halved for a week.`;
  return `${before}${clipLine(words.trim(), LINE_MOST - before.length - after.length)}${after}`;
}

/** The push a warning sends to the person's phone (decision 41), naming the network that stopped. */
export const warningPushWords = (
  platform: Platform = 'facebook',
): { title: string; body: string } => ({
  title: `${PLATFORMS[platform]} showed a warning.`,
  body: `The extension stopped on ${PLATFORMS[platform]} for today.`,
});

/**
 * Why Start my day can't start on a network the person doesn't work: where to turn it on, its page in Settings. When
 * the business doesn't use it (`networksAllowed`), only an owner or admin can allow it there: one who can is told to,
 * anyone else who to ask.
 */
export const networkOffWords = (platform: Platform, allowed = true, canManage = false): string => {
  const name = PLATFORMS[platform];
  if (allowed)
    return `${name} is off for you, so there’s no day to start there. Turn it on under Social Outreach → Settings → ${name}.`;
  return canManage
    ? `Your business doesn’t use ${name} for outreach yet, so there’s no day to start there. Allow it for your team under Social Outreach → Settings → ${name}, then turn it on for you there.`
    : `Your business doesn’t use ${name} for outreach, so there’s no day to start there. Ask an owner of this business to allow it under Social Outreach → Settings → ${name}.`;
};

/** Why a network still looked at (decision 78) has no day to start: only its Check runs there, for now. */
export const networkLookingWords = (platform: Platform): string => {
  const name = PLATFORMS[platform];
  return `There’s no day to start on ${name} yet: the extension only reads it for now. Press Check ${name} under Social Outreach → Settings → ${name}, and its steps get built from what it reads.`;
};

/** Why Start my day stays refused after a warning: on the network that showed it, until tomorrow. */
export const warnedTodayWords = (platform: Platform = 'facebook'): string => {
  const network = PLATFORMS[platform];
  return `${network} showed you a warning today, so the extension stays stopped on ${network} until tomorrow. Your ${network} limits are halved for a week.`;
};

/**
 * Why Start my day can't start while the extension does nothing on its own on a network: who can change that, and
 * where (the network's page in Settings, or General's For your team). When the business allows only Off, an owner or
 * admin (`canManage`) is told to allow it, anyone else who to ask.
 */
export function sendingOffWords(
  businessAllowsMore: boolean,
  platform: Platform = 'facebook',
  canManage = false,
): string {
  const name = PLATFORMS[platform];
  // A network the extension doesn't work yet (one before its runner): nothing to pick, and nobody to ask.
  if (!runsOnItsOwn(platform))
    return `Your computer doesn’t work on ${name} on its own yet, so there’s no day to start there. Today’s list on ${name} is yours to do, and it notes each step you take.`;
  if (businessAllowsMore)
    return `The extension doesn’t work on its own for you yet, so there’s no day to start. Pick what it does on its own under Social Outreach → Settings → ${name}.`;
  return canManage
    ? `Your business doesn’t let anyone’s extension work on its own yet, so there’s no day to start. Allow it for your team under Social Outreach → Settings → General, then pick what it does under Social Outreach → Settings → ${name}.`
    : 'The extension doesn’t work on its own for you yet, so there’s no day to start. Ask an owner of this business to allow the extension to work on its own under Social Outreach → Settings → General.';
}

/** A computer's plain name, from Chrome's word for its system. */
export function computerName(os: string | null | undefined): string {
  switch (os) {
    case 'win':
      return 'Chrome on Windows';
    case 'mac':
      return 'Chrome on Mac';
    case 'cros':
      return 'Chrome on a Chromebook';
    case 'linux':
    case 'openbsd':
      return 'Chrome on Linux';
    default:
      return 'Chrome';
  }
}

/**
 * The computer a fresh install takes the place of (decision 85): the person's most recently seen one still called by
 * this plain name, numbered or not ("Chrome on Mac", "Chrome on Mac 30"). Chrome empties the extension's storage when
 * it's removed, so put in again on the same computer it makes a new id, and once made a new computer each time. One
 * the person renamed is theirs to remove. Null when there's none.
 */
export function replacedComputer<T extends { readonly name: string; readonly lastSeenAt: Date }>(
  mine: readonly T[],
  name: string,
): T | null {
  const plain = name.toLowerCase();
  const named = mine.filter((c) => c.name.toLowerCase().replace(/ \d+$/, '') === plain);
  return named.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0] ?? null;
}

/** The person's words when a remove takes the computer that works. */
export const removeWorkingWords = (name: string) =>
  `${name} is the computer working for you, so it stays. Open the extension’s panel on the computer you use now, then remove this one.`;

/**
 * A new computer's name, numbered when the person has one by that name already: "Chrome on Windows 2". It stays
 * within `most` characters, the name cut short to leave room for the number.
 */
export function numberedName(
  name: string,
  taken: readonly string[],
  most = COMPUTER_NAME_MOST,
): string {
  const have = new Set(taken.map((t) => t.toLowerCase()));
  const base = name.slice(0, most);
  if (!have.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const next = `${name.slice(0, most - suffix.length).trimEnd()}${suffix}`;
    if (!have.has(next.toLowerCase())) return next;
  }
}
