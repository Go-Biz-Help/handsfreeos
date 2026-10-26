/**
 * Social Outreach's setup, in HandsFreeOS (docs/outreach.md, decisions 36, 45, 57 and 83): a page of its own, like the
 * main app's onboarding, that takes a person from nothing to their first day. It's drawn on the canvas "Social Outreach
 * setup".
 *
 * - **A main setup, once:** their business (the main offer, a playbook, a short video if they want one, and the team's
 *   rules: owners and admins), their computer (the extension), and them (their messages, the networks they use, then
 *   their goal, which counts each of those networks: decision 88). A member's main setup is their own four; the
 *   business's part shows beside it, done or waiting on an owner.
 * - **Then a short setup for each network they turn on,** Facebook first: allow it in Chrome and a playbook for it
 *   (every network but Facebook), their profile there, what it does there, then their first day there.
 * - **Each step is worked out from facts** (`setupStepStates`, `networkStepStates`), never kept as a flag: Get ready's
 *   items (./readiness.ts), the extension signing in, their own saved settings, the team's rules saved, the computer
 *   Chrome allows on a network, and a day started there. Skipping a step leaves it to do, and the setup opens at the
 *   first one left (`setupNext`). The old furthest step finished (`reached`) is still read and kept, and decides nothing.
 * - **A first-timer** (`firstTime`) has never saved their own settings and never started the setup: the bare Social
 *   Outreach page sends them here, and the extension opens it once per computer when they sign in. Saving their own
 *   settings is kept for good (`settings_at`).
 *
 * Browser-safe and without server code: the web, the extension and the phone read the steps and the words from here.
 */
import { z } from 'zod';
import { localDateOf } from '../../calendar/engine/zoned';
import { fmtMonthDay, fmtTime, localDayOf } from '../../calendar/when';
import { SENDING_MODE_KEYS, type SendingMode } from './automation';
import { GROUP_VERDICT_KEYS } from './groups';
import { PLATFORM_KEYS, PLATFORMS, type Platform } from './networks';
import type { ReadyItem, ReadyState } from './readiness';

// ------------------------------------------------------------------------------------------------- the steps

/** The main setup's three parts, in order. */
export const SETUP_PARTS = ['business', 'computer', 'you'] as const;
export type SetupPart = (typeof SETUP_PARTS)[number];

/**
 * The main setup's steps, in the order they depend on each other: the offer before the playbook (its builder reads
 * it), the video after the playbook (its script is the offer and the niche), the team's rules before anyone's own
 * choices, the extension before anything it reads, the messages before the networks they go out on, and the networks
 * before the goal, whose safe pace is every one of them added up (decision 88).
 */
export const SETUP_STEPS = [
  'offer',
  'playbook',
  'video',
  'rules',
  'extension',
  'messages',
  'networks',
  'numbers',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export const SETUP_PART_OF: Record<SetupStep, SetupPart> = {
  offer: 'business',
  playbook: 'business',
  video: 'business',
  rules: 'business',
  extension: 'computer',
  messages: 'you',
  networks: 'you',
  numbers: 'you',
};

/** A step that never holds anyone up: done once there's a video, or the business says it doesn't use one. */
export const OPTIONAL_STEPS: ReadonlySet<SetupStep> = new Set(['video']);

/** The business's own steps: an owner's or admin's (`outreach.manage`). */
const BUSINESS_STEPS: ReadonlySet<SetupStep> = new Set(['offer', 'playbook', 'video', 'rules']);

/** The person's main steps, in order: the business's part only for owners and admins. */
export function setupSteps(canManage: boolean): SetupStep[] {
  return SETUP_STEPS.filter((s) => canManage || !BUSINESS_STEPS.has(s));
}

/** A network's short setup, in order. */
export const NETWORK_STEPS = ['allow', 'playbook', 'profile', 'choices', 'start'] as const;
export type NetworkStep = (typeof NETWORK_STEPS)[number];

/**
 * A network's steps: Facebook needs no Allow (the extension is let on it as it's put in), and its playbook is the main
 * setup's; every other network allows the extension in Chrome and needs a playbook that runs there.
 */
export function networkSteps(platform: Platform): NetworkStep[] {
  return platform === 'facebook'
    ? ['profile', 'choices', 'start']
    : ['allow', 'playbook', 'profile', 'choices', 'start'];
}

/**
 * The furthest step the old setup kept (`addon_outreach.setup.reached`): still read and still accepted from an open
 * tab of the old setup, and it decides nothing now that each step is worked out from facts.
 */
export const SETUP_REACHED = [
  'playbooks',
  'ready',
  'rules',
  'networks',
  'settings',
  'extension',
  'groups',
] as const;
export type SetupReached = (typeof SETUP_REACHED)[number];

// ------------------------------------------------------------------------------------------------- where each stands

/** Where a step stands: done, to do, to look at again (the main offer changed), or waiting on an owner. */
export const STEP_STATES = ['done', 'todo', 'again', 'waiting'] as const;
export type StepState = (typeof STEP_STATES)[number];

const FROM_READY: Record<ReadyState, StepState> = {
  done: 'done',
  todo: 'todo',
  look_again: 'again',
  waiting: 'waiting',
};

/** A Get ready item as the setup reads it: where it stands, and what's left of it. */
interface ReadyFact {
  readonly item: ReadyItem;
  readonly state: ReadyState;
  readonly left: string | null;
}

/** What the setup is worked out from (`outreach.setup` gathers them). */
export interface SetupFacts {
  readonly canManage: boolean;
  readonly extensionAt: string | null;
  /** They've saved their own settings, ever. */
  readonly settingsSaved: boolean;
  /** The business's rules were kept in the setup, or changed from the starting ones. */
  readonly rulesSaved: boolean;
  /** A playbook in use has its short video linked. */
  readonly video: boolean;
  /** The business said it doesn't use a short video. */
  readonly noVideo: boolean;
  /** Get ready's items on Facebook: the offer, a playbook with its niche, the messages and the goal. */
  readonly ready: readonly ReadyFact[];
  /** Each network the person works, in order (Facebook first): its own facts. */
  readonly networks: readonly NetworkFacts[];
}

export interface NetworkFacts {
  readonly platform: Platform;
  /** Chrome lets the computer that works on it (Facebook always). */
  readonly allowed: boolean;
  /** Get ready's items there: a playbook that runs there, and the profile there. */
  readonly ready: readonly ReadyFact[];
  /** What the extension sends there on its own. */
  readonly sending: SendingMode;
  /** A day there has started, ever. */
  readonly started: boolean;
}

const fact = (ready: readonly ReadyFact[], item: ReadyItem): ReadyFact | undefined =>
  ready.find((r) => r.item === item);

export const StepStateOf = <T extends readonly [string, ...string[]]>(steps: T) =>
  z.object({
    step: z.enum(steps),
    state: z.enum(STEP_STATES),
    /** What's left of it, in the person's words; null when it's done. */
    left: z.string().nullable(),
    /** A step that holds nobody up. */
    optional: z.boolean(),
  });
const MainStepState = StepStateOf(SETUP_STEPS);
const NetworkStepState = StepStateOf(NETWORK_STEPS);
export type MainStepState = z.output<typeof MainStepState>;
export type NetworkStepState = z.output<typeof NetworkStepState>;

/** The person's main steps, each where it stands. */
export function setupStepStates(f: SetupFacts): MainStepState[] {
  const W = SETUP_WORDS.left;
  const offer = fact(f.ready, 'offer');
  const playbook = fact(f.ready, 'playbook');
  const messages = fact(f.ready, 'messages');
  const numbers = fact(f.ready, 'numbers');
  // A playbook with its niche on any network the person works counts: the business may not work Facebook.
  const playbookDone =
    playbook?.state === 'done' ||
    f.networks.some((n) => fact(n.ready, 'playbook')?.state === 'done');
  const businessDone = offer?.state === 'done' && playbookDone;
  const fromReady = (
    r: ReadyFact | undefined,
    fallback: string,
  ): Pick<MainStepState, 'state' | 'left'> =>
    r
      ? { state: FROM_READY[r.state], left: r.state === 'done' ? null : r.left }
      : { state: 'todo', left: fallback };
  const of = (step: SetupStep): Pick<MainStepState, 'state' | 'left'> => {
    switch (step) {
      case 'offer':
        return fromReady(offer, W.offer);
      case 'playbook':
        return playbookDone ? { state: 'done', left: null } : fromReady(playbook, W.playbook);
      case 'video':
        return f.video || f.noVideo
          ? { state: 'done', left: null }
          : { state: 'todo', left: W.video };
      case 'rules':
        return f.rulesSaved ? { state: 'done', left: null } : { state: 'todo', left: W.rules };
      case 'extension':
        return f.extensionAt ? { state: 'done', left: null } : { state: 'todo', left: W.extension };
      case 'messages': {
        // Samples are written from the offer and a niche: a member waits on the business for those.
        if (
          messages?.state !== 'done' &&
          messages?.state !== 'look_again' &&
          !businessDone &&
          !f.canManage
        )
          return { state: 'waiting', left: W.messagesWaiting };
        return fromReady(messages, W.messages);
      }
      case 'numbers':
        return fromReady(numbers, W.numbers);
      case 'networks':
        return f.settingsSaved
          ? { state: 'done', left: null }
          : { state: 'todo', left: W.networks };
    }
  };
  return setupSteps(f.canManage).map((step) => ({
    step,
    ...of(step),
    optional: OPTIONAL_STEPS.has(step),
  }));
}

/** The business's part as a member sees it beside their own: the offer and a playbook, done or waiting on an owner. */
export function businessStates(f: SetupFacts): { item: 'offer' | 'playbook'; state: StepState }[] {
  if (f.canManage) return [];
  return (['offer', 'playbook'] as const).map((item) => {
    const r = fact(f.ready, item);
    const done =
      r?.state === 'done' ||
      (item === 'playbook' && f.networks.some((n) => fact(n.ready, 'playbook')?.state === 'done'));
    return { item, state: done ? 'done' : 'waiting' };
  });
}

/** A network's steps, each where it stands. */
export function networkStepStates(f: SetupFacts, n: NetworkFacts): NetworkStepState[] {
  const W = SETUP_WORDS.left;
  const name = PLATFORMS[n.platform];
  const of = (step: NetworkStep): Pick<NetworkStepState, 'state' | 'left'> => {
    switch (step) {
      case 'allow':
        if (n.allowed && f.extensionAt) return { state: 'done', left: null };
        return { state: 'todo', left: f.extensionAt ? W.allow(name) : W.extensionFirst };
      case 'playbook':
      case 'profile': {
        const r = fact(n.ready, step);
        if (!r) return { state: 'todo', left: null };
        return { state: FROM_READY[r.state], left: r.state === 'done' ? null : r.left };
      }
      case 'choices':
        return f.settingsSaved && n.sending !== 'off'
          ? { state: 'done', left: null }
          : { state: 'todo', left: W.choices(name) };
      case 'start':
        return n.started ? { state: 'done', left: null } : { state: 'todo', left: W.start(name) };
    }
  };
  return networkSteps(n.platform).map((step) => ({ step, ...of(step), optional: false }));
}

// ------------------------------------------------------------------------------------------------- the stops

/** A place in the setup: a main step, or one network's step. */
export type SetupStop =
  | { readonly net: null; readonly step: SetupStep }
  | { readonly net: Platform; readonly step: NetworkStep };

export const SetupStopShape = z.union([
  z.object({ net: z.null(), step: z.enum(SETUP_STEPS) }),
  z.object({ net: z.enum(PLATFORM_KEYS), step: z.enum(NETWORK_STEPS) }),
]);

/** Where the setup opens: the welcome before any step, a step, or the end. */
export type SetupScreen = 'welcome' | 'done' | SetupStop;

/** What the setup is laid out from: the person's main steps and each network's, each where it stands. */
export interface SetupLaidOut {
  readonly states: readonly MainStepState[];
  readonly networks: readonly {
    readonly platform: Platform;
    readonly steps: readonly NetworkStepState[];
  }[];
}

/** Every stop, in order: the main steps, then each network's. */
export function setupStops(
  got: SetupLaidOut,
): (SetupStop & { state: StepState; optional: boolean })[] {
  return [
    ...got.states.map(
      (s) => ({ net: null, step: s.step, state: s.state, optional: s.optional }) as const,
    ),
    ...got.networks.flatMap((n) =>
      n.steps.map(
        (s) => ({ net: n.platform, step: s.step, state: s.state, optional: s.optional }) as const,
      ),
    ),
  ];
}

export const sameStop = (a: SetupStop, b: SetupStop) => a.net === b.net && a.step === b.step;

/**
 * The first step left to do, for the reminder and where the setup opens: to do or to look at again, never one waiting
 * on an owner, and never the optional video; null once everything is done.
 */
export function setupNext(got: SetupLaidOut): SetupStop | null {
  const left = setupStops(got).find(
    (s) => !s.optional && (s.state === 'todo' || s.state === 'again'),
  );
  return left ? stopOf(left) : null;
}

const stopOf = (s: SetupStop): SetupStop =>
  s.net === null ? { net: null, step: s.step } : { net: s.net, step: s.step };

/** The step after one, once it's done or skipped: the next not done, or the end. */
export function stopAfter(at: SetupStop, got: SetupLaidOut): SetupScreen {
  const all = setupStops(got);
  const i = all.findIndex((s) => sameStop(s, at));
  const next = all.slice(i + 1).find((s) => s.state !== 'done');
  return next ? stopOf(next) : 'done';
}

/** The step Back goes to: the one before, or the welcome from the first. */
export function stopBefore(at: SetupStop | 'done', got: SetupLaidOut): SetupScreen {
  const all = setupStops(got);
  if (at === 'done') return all.at(-1) ? stopOf(all.at(-1)!) : 'welcome';
  const i = all.findIndex((s) => sameStop(s, at));
  return i > 0 ? stopOf(all[i - 1]!) : 'welcome';
}

/** A step from the address (`?step=`, with `?net=` for a network's), the old setup's names read as what they became. */
export function readSetupStop(
  step: string | null | undefined,
  net: string | null | undefined,
): SetupScreen | null {
  if (step === 'welcome' || step === 'done') return step;
  const platform = PLATFORM_KEYS.find((p) => p === net);
  if (platform) {
    const s = NETWORK_STEPS.find((x) => x === step);
    return s ? { net: platform, step: s } : null;
  }
  const s = SETUP_STEPS.find((x) => x === step);
  if (s) return { net: null, step: s };
  // The old setup's steps (decision 83): what each became.
  const old: Partial<Record<string, SetupStop>> = {
    playbooks: { net: null, step: 'playbook' },
    ready: { net: null, step: 'messages' },
    settings: { net: null, step: 'networks' },
    groups: { net: 'facebook', step: 'start' },
  };
  return old[step ?? ''] ?? null;
}

/**
 * Where the setup opens. The welcome when it's asked for, and when they haven't started yet and nothing is asked for.
 * Set up again (`again`) opens at the step asked for, or the first. Otherwise any of their steps asked for (the rail's
 * rows are links), else the first step left, else the end.
 */
export function setupOpenAt(
  got: SetupLaidOut & { readonly startedAt: string | null; readonly finishedAt: string | null },
  asked: SetupScreen | null,
  again: boolean,
): SetupScreen {
  const all = setupStops(got);
  const theirs = (s: SetupScreen | null): s is SetupStop =>
    s !== null && s !== 'welcome' && s !== 'done' && all.some((x) => sameStop(x, s));
  const first: SetupScreen = all[0] ? stopOf(all[0]) : 'done';
  if (asked === 'welcome') return 'welcome';
  if (again) return theirs(asked) ? asked : first;
  if (asked === null && !got.startedAt && !got.finishedAt) return 'welcome';
  if (theirs(asked)) return asked;
  const next = setupNext(got);
  if (asked === 'done' || !next) return 'done';
  return next;
}

/** How many of the main steps are done, or of one network's. */
export function doneOf(steps: readonly { state: StepState }[]): { done: number; of: number } {
  return { done: steps.filter((s) => s.state === 'done').length, of: steps.length };
}

/**
 * Before a network's first day: the first thing still in the way, with its words, or null when nothing is. The
 * business's part a member waits on, the main setup's steps, then the network's own (not its Start, nor the optional
 * video). Start my day's own refusals still come from the server: this only says so before the press.
 */
export function startBlocker(
  got: SetupLaidOut & {
    readonly business: readonly { item: 'offer' | 'playbook'; state: StepState }[];
  },
  platform: Platform,
): { stop: SetupStop | null; state: StepState; left: string } | null {
  const waiting = got.business.find((b) => b.state !== 'done');
  if (waiting)
    return {
      stop: null,
      state: 'waiting',
      left:
        waiting.item === 'offer' ? SETUP_WORDS.left.offerWaiting : SETUP_WORDS.left.playbookWaiting,
    };
  const main = got.states.find((s) => !s.optional && s.state !== 'done');
  if (main)
    return { stop: { net: null, step: main.step }, state: main.state, left: main.left ?? '' };
  const net = got.networks.find((n) => n.platform === platform);
  const own = net?.steps.find((s) => s.step !== 'start' && s.state !== 'done');
  if (own)
    return { stop: { net: platform, step: own.step }, state: own.state, left: own.left ?? '' };
  return null;
}

/** Where a refusal of Start my day is fixed (clients branch on its rule, never on its words). */
export function startFix(rule: string, platform: Platform): SetupStop | null {
  if (rule === 'outreach_sending_off') return { net: platform, step: 'choices' };
  if (rule === 'outreach_network_off') return { net: null, step: 'networks' };
  return null;
}

/** Never saved their own settings and never started the setup (an extension signing in doesn't count as starting). */
export interface SetupKept {
  readonly startedAt: unknown;
  readonly finishedAt: unknown;
  readonly bannerHiddenAt: unknown;
}
export const isFirstTime = (kept: SetupKept | null, settingsSaved: boolean): boolean =>
  !settingsSaved && !kept?.startedAt && !kept?.finishedAt;

/**
 * Whether Social Outreach's tabs show the next step: something is left, it isn't hidden, and they started the setup or
 * never saved their own settings. Someone who has used it for weeks and saved theirs long ago isn't reminded.
 */
export const showsSetupBanner = (
  kept: SetupKept | null,
  settingsSaved: boolean,
  anythingLeft: boolean,
): boolean => anythingLeft && !kept?.bannerHiddenAt && (Boolean(kept?.startedAt) || !settingsSaved);

// ------------------------------------------------------------------------------------------------- addresses

/** Social Outreach's tabs, as their addresses name them (`?view=`); the activity is the bare page. */
export type OutreachTab =
  | 'today'
  | 'live'
  | 'pipeline'
  | 'friends'
  | 'chats'
  | 'groups'
  | 'results'
  | 'playbooks'
  | 'settings'
  // The old tabs' names (decision 59): Activity is Results now, and Waiting for you is on Today.
  | 'activity'
  | 'waiting';

/**
 * A view's address, for the extension's links and anything else that opens one: `?view=`, the old tabs' names as
 * the views they became (decision 59). `more` adds the view's own choices.
 */
export function outreachPath(
  workspaceId: string,
  view: OutreachTab,
  more: Readonly<Record<string, string>> = {},
): string {
  const shown = view === 'activity' ? 'results' : view === 'waiting' ? 'today' : view;
  const params = new URLSearchParams({ view: shown, ...more });
  const qs = params.toString();
  return `/app/w/${workspaceId}/a/outreach${qs ? `?${qs}` : ''}`;
}

/**
 * The setup's address: a step (`?step=`, with `?net=` for a network's), Set up again (`?again=1`), or opened by the
 * extension (`?from=extension`).
 */
export function outreachSetupPath(
  workspaceId: string,
  to: {
    readonly step?: SetupScreen;
    readonly again?: boolean;
    readonly from?: 'extension';
  } = {},
): string {
  const params = new URLSearchParams();
  const step = to.step;
  if (step === 'welcome' || step === 'done') params.set('step', step);
  else if (step) {
    if (step.net) params.set('net', step.net);
    params.set('step', step.step);
  }
  if (to.again) params.set('again', '1');
  if (to.from) params.set('from', to.from);
  const qs = params.toString();
  return `/app/w/${workspaceId}/a/outreach/setup${qs ? `?${qs}` : ''}`;
}

/** A stop's key: for React, the page's test ids and its address. */
export const stopKey = (s: SetupScreen): string =>
  s === 'welcome' || s === 'done' ? s : s.net ? `${s.net}-${s.step}` : s.step;

// ------------------------------------------------------------------------------------------------- the shapes

export const SetupInput = z.object({ workspaceId: z.uuid() });
export type SetupInput = z.input<typeof SetupInput>;

/** How many of the person's groups the setup lists. */
export const SETUP_GROUPS_SHOWN = 5;

export const SetupOutput = z.object({
  /** This person's main steps, in order. */
  steps: z.array(z.enum(SETUP_STEPS)),
  /** Each main step where it stands, in order. */
  states: z.array(MainStepState),
  /** The business's part as a member sees it beside their own; empty for owners and admins, whose steps they are. */
  business: z.array(z.object({ item: z.enum(['offer', 'playbook']), state: z.enum(STEP_STATES) })),
  /** Each network the person works, Facebook first, with its own steps where they stand. */
  networks: z.array(
    z.object({ platform: z.enum(PLATFORM_KEYS), steps: z.array(NetworkStepState) }),
  ),
  /** The first step left (`setupNext`); null once everything is done. */
  next: SetupStopShape.nullable(),
  /** The old setup's furthest step finished: read, and deciding nothing. */
  reached: z.enum(SETUP_REACHED).nullable(),
  /** When they first moved on from the welcome or left it for later; null when they never have. */
  startedAt: z.iso.datetime().nullable(),
  /** When a first day started from the setup; the phone points to the computer until then. */
  finishedAt: z.iso.datetime().nullable(),
  /** The last time the extension said it's signed in for them here; null when it never has. */
  extensionAt: z.iso.datetime().nullable(),
  /** The computer that works, by its name; null with none. */
  computer: z.string().nullable(),
  /** Whether they've ever saved their own settings (an owner or admin saving them for them doesn't count or undo it). */
  settingsSaved: z.boolean(),
  /** Never saved their own settings and never started the setup: Social Outreach sends them to the setup. */
  firstTime: z.boolean(),
  /** Whether Social Outreach's tabs show the next step (`showsSetupBanner`). */
  banner: z.boolean(),
  /** Owners and admins: they do the business's part. */
  canManage: z.boolean(),
  /** Whether the business lets anyone pick more than doing everything themselves. */
  sendingAllowedMore: z.boolean(),
  /** The business's playbooks in use, oldest first. */
  playbooks: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      template: z.string().nullable(),
      /** It has its niche and the niche's problem. */
      niche: z.boolean(),
      /** Its short video is linked. */
      video: z.boolean(),
      /** The networks it runs on. */
      networks: z.array(z.enum(PLATFORM_KEYS)),
    }),
  ),
  /** The business doesn't use a short video. */
  noVideo: z.boolean(),
  /**
   * Groups this person is in, saved from their Facebook, and the business's groups in all; with the ones they're in
   * that the extension saw last (up to `SETUP_GROUPS_SHOWN`), each scored against the playbooks.
   */
  groups: z.object({
    mine: z.number().int().min(0),
    business: z.number().int().min(0),
    latest: z.array(
      z.object({
        groupId: z.uuid(),
        name: z.string().nullable(),
        verdict: z.enum(GROUP_VERDICT_KEYS),
      }),
    ),
  }),
  /** Where to download the extension (the business's `extensionLink`); null until an owner or admin gives it. */
  extensionLink: z.string().nullable(),
});
export type SetupOutput = z.output<typeof SetupOutput>;

export const SetupSaveInput = z
  .object({
    workspaceId: z.uuid(),
    /** The old setup's furthest step finished, from a tab of it still open: kept, and deciding nothing. */
    reached: z.enum(SETUP_REACHED).optional(),
    /** A first day started from the setup: it's done. */
    finished: z.literal(true).optional(),
    /** Sent by the extension: it's signed in here. Says nothing about the setup being started. */
    extension: z.literal(true).optional(),
    /** They moved on from the welcome, or left it for later: they won't be sent to the setup again. */
    started: z.literal(true).optional(),
    /** Hide the next step's line on Social Outreach's tabs. */
    hideBanner: z.literal(true).optional(),
  })
  .refine((i) => i.reached || i.finished || i.extension || i.started || i.hideBanner, {
    error:
      'Say that the setup was started or is done, that its line is hidden, or that the extension signed in.',
  });
export type SetupSaveInput = z.input<typeof SetupSaveInput>;
export const SetupSaveOutput = SetupOutput;

// ------------------------------------------------------------------------------------------------- the words

/** "at 2:14 PM" today, else "on Oct 9". */
export function whenWords(at: string, now = Date.now(), timeZone?: string): string {
  const zone = timeZone || 'UTC';
  const day = localDayOf(at, zone);
  if (day === localDateOf(now, zone)) return `at ${fmtTime(at, zone)}`;
  return `on ${fmtMonthDay(day)}`;
}

/** "Facebook, LinkedIn and Instagram". */
export const andWords = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** Where each network's pages are, as Chrome's box names them when the extension asks to work there. */
const SITES: Record<Platform, string> = {
  facebook: 'facebook.com',
  linkedin: 'linkedin.com',
  instagram: 'instagram.com',
  alignable: 'alignable.com',
};

/** "1 step", "3 steps". */
const stepsWords = (n: number) => (n === 1 ? '1 step' : `${n} steps`);

/** The setup's words: one copy for the web, the phone and the extension. Plain words, curly apostrophes. */
export const SETUP_WORDS = {
  title: 'Set up Social Outreach',
  /** Beside the brand at the top of the setup's page, as the main app's onboarding has it. */
  settingUp: (business: string) => `Setting up Social Outreach for ${business}`,
  settingUpOn: (network: string, business: string) => `Setting up ${network} for ${business}`,
  /** Above each step's title: "Your business · 4 of 4", "LinkedIn · 1 of 5". */
  counter: (where: string, n: number, of: number) => `${where} · ${n} of ${of}`,
  steps: stepsWords,
  welcome: {
    eyebrow: 'Set up Social Outreach',
    title: 'Let’s get Social Outreach working',
    hint: 'Three parts, then a short setup for each network you use. When you’re done, it knows who to look for and what to say.',
    memberTitle: (name: string) => `Welcome, ${name}. Here’s your part.`,
    memberHint: 'Four steps, then a short setup for each network you use.',
    owners: 'owners and admins',
    then: 'Then: a short setup for each network',
    thenAbout:
      'Facebook first, then any other you turn on. About 5 minutes each, and it ends with your first day there.',
    eachNetwork: 'Each network',
    eachNetworkAbout: 'Your profile there, what it does there, then your first day.',
    eachNetworkTime: 'About 5 minutes each',
    time: 'About 15 minutes. Stop any time; it keeps your place.',
    timeMember: 'About 10 minutes, then 5 for each network. Stop any time; it keeps your place.',
    start: 'Let’s start',
  },
  parts: {
    business: {
      name: 'Your business',
      about:
        'Your main offer, a playbook and your team’s rules. A short video too, if you want one.',
    },
    computer: { name: 'Your computer', about: 'Put the extension in Chrome and sign in.' },
    you: { name: 'You', about: 'OK your messages, pick the networks you use, set your goal.' },
  } satisfies Record<SetupPart, { name: string; about: string }>,
  /** The rail's group of networks, and what it says over the business's part for a member. */
  networksHead: 'Then, each network',
  ownersDo: 'An owner does these.',
  mainDone: 'Main setup',
  mainAllDone: 'Done',
  optional: 'Optional',
  working: 'Working',
  progress: (done: number, of: number) => `${done} of ${of} done`,
  progressOn: (network: string, done: number, of: number) => `${network} · ${done} of ${of} done`,
  main: {
    offer: {
      name: 'Main offer',
      title: 'Your main offer',
      hint: 'What you sell, in one clear offer. Every message starts from it.',
    },
    playbook: {
      name: 'Playbook',
      title: 'Pick a playbook',
      hint: 'Who you’re looking for, how you sound and what you offer. Start from ours or write your own.',
    },
    video: {
      name: 'Short video',
      title: 'A short video',
      hint: 'Optional. A 2 to 4 minute video your messages can link to. The AI writes the script; you record it.',
    },
    rules: {
      name: 'Team rules',
      title: 'Your team’s rules',
      hint: 'What your team may do on its own. Most businesses keep these.',
    },
    extension: {
      name: 'The extension',
      title: 'Put the extension in Chrome',
      hint: 'Five quick steps on this computer. This page ticks itself when it’s done.',
    },
    messages: {
      name: 'Your messages',
      title: 'Your messages',
      hint: 'What goes out in your name, on every network. OK them before anything is sent.',
    },
    networks: {
      name: 'Your networks',
      title: 'The networks you use',
      hint: 'Facebook is on to start. Your goal counts every one you turn on, and each gets a short setup of its own.',
    },
    numbers: {
      name: 'Your goal',
      title: 'Your goal',
      hint: 'How many calls you want booked a month. It sets how many people to reach each day on your networks.',
    },
  } satisfies Record<SetupStep, { name: string; title: string; hint: string }>,
  network: {
    allow: {
      name: 'Allow it in Chrome',
      title: (n: string) => `Allow it on ${n}`,
      hint: 'Chrome asks once for each network. It takes a few seconds.',
    },
    playbook: {
      name: 'A playbook for it',
      title: (n: string) => `A playbook for ${n}`,
      hint: (n: string) => `Pick a playbook to run on ${n}, or write one for it.`,
    },
    profile: {
      name: 'Your profile',
      title: (n: string) => `Your ${n} profile`,
      hint: 'People look at it before they answer. Your computer reads it, and the AI says what to change.',
    },
    choices: {
      name: 'What it does there',
      title: (n: string) => `What it does on ${n}`,
      hint: 'Pick how much it does on its own here. You can change it any time.',
    },
    start: {
      name: 'Start your day',
      title: (n: string) => `Start your first day on ${n}`,
      hint: 'Here’s what happens once you start.',
    },
  } satisfies Record<
    NetworkStep,
    { name: string; title: (n: string) => string; hint: string | ((n: string) => string) }
  >,
  /** What's left of a step, for the reminder and the Start screen. */
  left: {
    offer: 'Write your main offer and put it live.',
    offerWaiting:
      'Waiting on your business’s main offer. Ask an owner of this business to finish it under Settings → Main offer.',
    playbook: 'Pick a playbook and its niche.',
    playbookWaiting:
      'Waiting on your business’s playbook. Ask an owner of this business to write one on the Playbooks tab.',
    video: 'Optional: link a short video, or say you don’t use one.',
    rules: 'Keep your team’s rules, or change them.',
    extension: 'Put the extension in Chrome and sign in.',
    extensionFirst: 'Put the extension in Chrome first, under Your computer.',
    messages: 'See your messages and OK how they sound.',
    messagesWaiting:
      'Your messages are written from your business’s main offer and playbook, so they wait on those.',
    numbers: 'Set a goal for calls booked a month.',
    networks: 'Pick the networks you use.',
    allow: (n: string) => `Allow the extension on ${n} in Chrome.`,
    choices: (n: string) => `Pick what it does on its own on ${n}.`,
    start: (n: string) => `Start your first day on ${n}.`,
  },
  /** The extension's install, a step at a time (decision 71). Load unpacked needs the folder that holds manifest.json. */
  install: [
    {
      title: 'Download it and unzip it',
      text: 'Keep the folder in Documents. Chrome needs it to stay there.',
    },
    {
      title: 'Turn on Developer mode',
      text: 'Paste this in Chrome’s address bar. The switch is at the top right.',
    },
    {
      title: 'Press Load unpacked',
      text: 'Pick the hfos-social folder, the one with manifest.json in it.',
    },
    { title: 'Pin it', text: 'Press the puzzle piece by the address bar, then the pin.' },
  ] as const,
  signIn: {
    title: 'Sign in',
    text: (email: string) =>
      `Press the extension and sign in as ${email}. A number shows here: pick the same one.`,
  },
  otherNetworksLater:
    'It works on Facebook straight away. Each other network gets a quick Allow later, in its own setup.',
  stuck: {
    title: 'Stuck?',
    items: [
      {
        q: 'Chrome says “Manifest file is missing”',
        a: 'You picked the folder around it. Pick the one with manifest.json inside.',
      },
      {
        q: 'It’s gone after Chrome restarts',
        a: 'Chrome turned it off. Turn it back on in chrome://extensions.',
      },
      { q: 'It signed you out', a: 'The folder moved. Load it again from where it is now.' },
      {
        q: 'A newer version came out',
        a: 'Download it, unzip it over the same folder, then press the reload arrow on its card.',
      },
    ],
  },
  /** Beside the download: which version, how big, and where it works. */
  downloadAbout: (version: string, bytes: number | null) =>
    [
      `Version ${version}`,
      bytes ? `${Math.max(0.1, Math.round(bytes / 104_857.6) / 10)} MB` : null,
      'for Chrome on a computer',
    ]
      .filter(Boolean)
      .join(' · '),
  /** Chrome's own note about extensions loaded by hand, which it shows now and then. */
  devModeNote:
    'Chrome may ask you to turn off extensions in developer mode now and then. Keep them on, or the extension stops working.',
  /** Folded on the Settings tab, under the download. */
  howToInstall: 'How to install it',
  update:
    'For a newer version, download it again and unzip it, put the new files in place of the old ones in the same folder, and press the reload arrow on its card in chrome://extensions.',
  waiting: 'Waiting for the extension to sign in. This page updates by itself.',
  signedIn: (when: string) => `The extension is signed in. It checked in ${when}.`,
  /** A network's Allow, a step at a time: the panel's button, Chrome's box, then a reload. */
  allow: (network: Platform) => {
    const n = PLATFORMS[network];
    return [
      { title: 'Open the extension', text: `Press its pinned button, then Allow on ${n}.` },
      {
        title: 'Press Allow in Chrome’s box',
        text: `It asks to let the extension read and change ${SITES[network]}, so it can work there beside you.`,
      },
      {
        title: `Reload ${n}`,
        text: `If a ${n} tab was already open, reload it. Stay signed in to ${n} in this Chrome.`,
      },
    ] as const;
  },
  allowButton: (n: string) => `Allow on ${n}`,
  site: (network: Platform) => SITES[network],
  allowWaiting: 'Waiting for Chrome to allow it. This page updates by itself.',
  allowed: (n: string, computer: string | null) =>
    computer ? `Allowed on ${n}, on ${computer}.` : `Allowed on ${n}.`,
  notChrome: 'This step needs Chrome on a computer. Open this page there to carry on.',
  pageLink: 'This page’s link',
  copyLink: 'Copy link',
  keptPlace: 'Your place is kept, so it opens right here.',
  /** The networks step: each network, and what comes next. */
  networkAbout: {
    facebook: 'The groups you’re in, your friends, and messages',
    linkedin: 'Connections and messages',
    instagram: 'Follows and messages',
    alignable: 'Local business owners near you',
  } satisfies Record<Platform, string>,
  /** Under the switches: what comes next, the goal first while it's left (it counts each network, decision 88). */
  networksNext: (names: readonly string[], goalFirst = false) =>
    `Next: ${goalFirst ? 'your goal, then ' : ''}set up ${andWords(names)}. About 5 minutes each. Turn on more any time on the Settings tab.`,
  networksNone: 'Turn on at least one network to carry on.',
  networksNotAllowed: (names: readonly string[]) =>
    `Your business doesn’t use ${andWords(names)}. An owner can change that in Team rules.`,
  saveAndSetUp: (n: string) => `Save and set up ${n}`,
  /** What it does there: Sending as cards, nothing picked to start (decision 26 stays). */
  pickOne: 'Pick one',
  mostPeople: 'Most people start here',
  pickToCarryOn: 'Pick one to carry on',
  saveAndCarryOn: 'Save and carry on',
  moreChoices: (n: string) => `More choices on ${n}`,
  sendingCards: {
    steps: {
      title: 'Friend requests, likes and comments on their own',
      about: 'Each message waits for one tap from you.',
    },
    approve_all: {
      title: 'The same, with messages ready each morning',
      about: 'Approve the day’s messages in one press.',
    },
    everything: {
      title: 'Everything on its own, messages too',
      about: 'It still stops for anything that needs you.',
    },
  } satisfies Record<Exclude<SendingMode, 'off'>, { title: string; about: string }>,
  sendingOnlyOff:
    'Your business doesn’t let anyone send on their own yet. Ask an owner to allow it in Team rules.',
  /** The team's rules: kept in one press. */
  keepRules: 'Keep these',
  saveRules: 'Save and carry on',
  changeRules: 'Change them',
  rulesChoices: 'Choices',
  rulesChoicesAbout:
    'Everyone may pick any choice, from doing it all themselves to everything on its own.',
  /** Each network the business uses has its own limits, in its own words. */
  rulesLimits: (network: string) => `On ${network}, a day`,
  rulesNetworks: 'Networks',
  rulesNetworksAbout: (names: readonly string[]) =>
    `Everyone may turn on ${andWords(names)}. Each has its own safe limits.`,
  rulesNew: 'New people',
  rulesNewAbout: 'They start doing everything themselves, until they pick.',
  rulesWarning: 'A warning from a network stops its day and halves its limits for a week.',
  /** The video: optional (decision 83). */
  videoWrite: 'Write the script',
  videoOpen: 'Open the script',
  noVideo: 'We don’t use one',
  videoLinked: 'Your video is linked.',
  videoNone: 'You don’t use one. Add one any time on the Playbooks tab.',
  /** The offer and the playbook, built on their own pages: they come back here. */
  offerWrite: 'Write your main offer',
  offerOpen: 'Open your main offer',
  offerLive: (version: number) => `Version ${version} is live.`,
  playbooksInUse: 'Your playbooks',
  templates: 'Start from one of ours',
  templateAbout: 'It opens with our words filled in, for you to make into your own offer and link.',
  useTemplate: 'Use this one',
  writeOwn: 'Write your own',
  playbookOn: (n: string) => `Use on ${n}`,
  playbookRunsOn: (n: string) => `Runs on ${n}`,
  playbookNiche: 'Pick its niche',
  /** Your messages: in their voice. */
  voice: 'Your voice:',
  changeVoice: 'Change it',
  /** The Start screen. */
  start: {
    blocked: 'One thing left before it reaches anyone for you here.',
    doItNow: 'Do it now',
    happens: 'What happens next',
    steps: [
      {
        title: 'It reads your friends, requests and groups first',
        text: 'So your first list is full. You’ll see it tick off on Today.',
      },
      {
        title: 'Then it works your list, inside your limits',
        text: 'What you picked goes on its own.',
      },
      { title: 'Messages wait for your OK', text: 'On Today, and on your phone.' },
    ],
    go: (n: string) => `Start my first day on ${n}`,
    then: (n: string) => `Then ${n}`,
    thenAbout: (steps: number) =>
      `You turned it on too. Its setup is ${steps} short steps, right after this.`,
  },
  done: {
    title: 'You’re set up',
    hint: 'Your first day has started. The extension reads your lists first, then works your list.',
  },
  phone: 'Get the phone app to hear when someone writes back.',
  getPhone: 'Get the phone app',
  goToday: 'Go to Today',
  changeLater: 'Change any of it on the Settings tab',
  /** On the phone's Social Outreach screen until a first day starts from the setup (`finishedAt`). */
  onPhone:
    'Set up Social Outreach on a computer: the extension needs Chrome. Open HandsFreeOS on the web, then Social Outreach.',
  /** The line on Social Outreach's tabs. */
  bannerNext: (what: string, done: number, of: number) => `Next: ${what} · ${done} of ${of} done.`,
  bannerSetUp: (n: string) => `set up ${n}`,
  bannerWorking: (names: readonly string[]) =>
    names.length ? `${andWords(names)} ${names.length === 1 ? 'is' : 'are'} working.` : '',
  /** On the step they come back to, when they'd started before. */
  resumed: 'Welcome back. Carry on where you left off.',
  startOver: 'Start over',
  fromExtension: 'The extension is signed in. Finish setting up here: it takes a few minutes.',
  next: 'Next',
  back: 'Back',
  skip: 'Skip for now',
  later: 'Finish later',
  carryOn: 'Carry on',
  hide: 'Hide',
  again: 'Set up again',
  /** On a network's Settings page once it's on: its own short setup. */
  setUpNetwork: (n: string) => `Set up ${n}`,
  setUpNetworkAbout: (network: Platform) =>
    network === 'facebook'
      ? 'A short setup of its own: your profile there, what it does there and your first day.'
      : 'A short setup of its own: Chrome’s Allow, your profile there, what it does there and your first day.',
  againAbout:
    'Go through the setup again: your computer, your messages, your networks and your goal.',
  againAboutManage:
    'Go through the setup again: your business, your computer, your messages, your networks and your goal.',
  download: 'Download HandsFreeOS Social',
  /** Where the team gets the extension (`extensionLink`): Settings' For your team and the install step, on the web and the phone. */
  link: {
    title: 'Where your team gets the extension',
    about:
      'HandsFreeOS hands out the extension itself. Paste a link only if your team keeps its own copy of the zip: everyone’s setup then downloads yours.',
    label: 'Link to the zip',
    saved: 'Saved. Everyone’s setup shows the link.',
    removed: 'The link is taken off.',
  },
  copy: 'Copy',
  copied: 'Copied. Paste it in Chrome’s address bar.',
} as const;

/** Where Chrome lists the extensions loaded; a page can't link to it, so it's copied. */
export const CHROME_EXTENSIONS_URL = 'chrome://extensions';

/** A step's name, for the rail and the reminder. */
export const stopName = (s: SetupStop): string =>
  s.net === null ? SETUP_WORDS.main[s.step].name : SETUP_WORDS.network[s.step].name;

/** What the reminder says is next: a main step by its name, or a network to set up. */
export function bannerWords(got: SetupLaidOut, next: SetupStop): string {
  if (next.net === null) {
    const { done, of } = doneOf(got.states);
    return SETUP_WORDS.bannerNext(SETUP_WORDS.main[next.step].name, done, of);
  }
  const net = got.networks.find((n) => n.platform === next.net);
  const { done, of } = doneOf(net?.steps ?? []);
  return SETUP_WORDS.bannerNext(SETUP_WORDS.bannerSetUp(PLATFORMS[next.net]), done, of);
}

/** The networks whose first day has started: "Facebook is working." */
export const networksWorking = (got: SetupLaidOut): Platform[] =>
  got.networks
    .filter((n) => n.steps.find((s) => s.step === 'start')?.state === 'done')
    .map((n) => n.platform);

/** The sending choices a person can pick in the setup: all but doing everything themselves. */
export const SETUP_SENDING = SENDING_MODE_KEYS.filter((m) => m !== 'off') as Exclude<
  SendingMode,
  'off'
>[];
