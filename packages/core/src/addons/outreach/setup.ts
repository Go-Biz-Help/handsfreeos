/**
 * Social Outreach's setup, in HandsFreeOS (docs/outreach.md, decisions 36, 45 and 63; the owner's answers 21a, 22a and
 * 23a): a step at a time, like the main app's onboarding. Pick the playbooks, get ready (./readiness.ts), set the team's
 * rules (owners and admins), pick your networks, choose your own settings, install the extension and sign in, then
 * bring in your groups.
 *
 * - **Each person's own,** and it only moves forward (`laterStep`): `addon_outreach.setup` keeps the furthest step
 *   finished, when they started and finished, and when the extension last said it's signed in for them.
 * - **It remembers where they got to:** leaving and coming back opens on the step after the furthest one finished
 *   (`setupOpenAt`); Settings → Set up again opens it at the first.
 * - **A first-timer** (`firstTime`) is someone who has never saved their own settings and never started the setup:
 *   the bare Social Outreach page sends them here, and the extension opens it once per computer when they sign in.
 *   Saving their own settings is kept for good (`settings_at`): an owner or admin changing them later doesn't make
 *   them a first-timer again.
 *
 * Browser-safe and without server code: the web, the extension and the phone read the steps and the words from here.
 */
import { z } from 'zod';
import { localDateOf } from '../../calendar/engine/zoned';
import { fmtMonthDay, fmtTime, localDayOf } from '../../calendar/when';
import { settingsSummary, type AutomationSettings } from './automation';
import { GROUP_VERDICT_KEYS } from './groups';
import { PLATFORM_KEYS, PLATFORMS, WORKING_PLATFORMS } from './networks';

/**
 * The steps, in order. The team's rules come before the person's own, so a rule never quietly steps theirs back; the
 * networks they work come before what the extension does on each.
 */
export const SETUP_STEPS = [
  'playbooks',
  'ready',
  'rules',
  'networks',
  'settings',
  'extension',
  'groups',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
/** A screen of the setup: the welcome before the steps, one of the steps, or the end. */
export type SetupScreen = 'welcome' | SetupStep | 'done';
const SETUP_SCREENS: readonly SetupScreen[] = ['welcome', ...SETUP_STEPS, 'done'];

const order = (s: SetupStep) => SETUP_STEPS.indexOf(s);

/** The steps for this person, in order: the team's rules only for owners and admins (`outreach.manage`). */
export function setupSteps(canManage: boolean): SetupStep[] {
  return SETUP_STEPS.filter((s) => canManage || s !== 'rules');
}

/** The later of two steps: a step finished again never moves `reached` back. */
export function laterStep(a: SetupStep | null, b: SetupStep | null): SetupStep | null {
  if (!a) return b;
  if (!b) return a;
  return order(b) > order(a) ? b : a;
}

/** How many of the person's steps are done: those at or before `reached`. */
export function stepsDone(reached: SetupStep | null, steps: readonly SetupStep[]): number {
  if (!reached) return 0;
  return steps.filter((s) => order(s) <= order(reached)).length;
}

/** A screen from the address (`?step=`), or null. */
export function readSetupStep(v: string | null | undefined): SetupScreen | null {
  return SETUP_SCREENS.find((s) => s === v) ?? null;
}

/** The screen after a step: the next of theirs, or the end after the last. */
export function nextScreen(step: SetupStep, steps: readonly SetupStep[]): SetupScreen {
  return steps.find((s) => order(s) > order(step)) ?? 'done';
}

/** The step before a screen, or null on the first and the welcome. */
export function previousStep(screen: SetupScreen, steps: readonly SetupStep[]): SetupStep | null {
  if (screen === 'welcome') return null;
  if (screen === 'done') return steps[steps.length - 1] ?? null;
  return [...steps].reverse().find((s) => order(s) < order(screen)) ?? null;
}

/** The screen Back goes to: the step before, or the welcome from the first step; null on the welcome. */
export function previousScreen(
  screen: SetupScreen,
  steps: readonly SetupStep[],
): SetupScreen | null {
  if (screen === 'welcome') return null;
  return previousStep(screen, steps) ?? 'welcome';
}

/**
 * Where the setup opens. The welcome when it's asked for, and when they've finished no step yet and none is asked
 * for. Set up again (`again`) opens at the asked step or the first. Otherwise a step asked for opens when it's one of
 * theirs and not past the one they'd come back to (any once they've finished; the end only once they have); else the
 * end once finished; else the step after the furthest finished (the last, when that was the last); else the first.
 */
export function setupOpenAt(
  got: {
    readonly reached: SetupStep | null;
    readonly finishedAt: string | null;
    readonly steps: readonly SetupStep[];
  },
  asked: string | null | undefined,
  again: boolean,
): SetupScreen {
  const first = got.steps[0] ?? 'playbooks';
  const want = readSetupStep(asked);
  if (want === 'welcome' || (want === null && !again && !got.reached && !got.finishedAt))
    return 'welcome';
  const theirs = want !== null && (want === 'done' || got.steps.includes(want as SetupStep));
  if (again) return theirs && want !== 'done' ? want : first;
  const comeBack: SetupScreen = got.reached ? nextScreen(got.reached, got.steps) : first;
  const at = (s: SetupScreen) =>
    s === 'done' ? SETUP_STEPS.length : s === 'welcome' ? -1 : order(s);
  if (theirs) {
    if (got.finishedAt) return want;
    if (want !== 'done' && at(want) <= at(comeBack)) return want;
  }
  if (got.finishedAt) return 'done';
  return comeBack === 'done' ? (got.steps[got.steps.length - 1] ?? first) : comeBack;
}

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

/** The setup's address: a step (`?step=`), Set up again (`?again=1`), or opened by the extension (`?from=extension`). */
export function outreachSetupPath(
  workspaceId: string,
  to: { readonly step?: SetupScreen; readonly again?: boolean; readonly from?: 'extension' } = {},
): string {
  const params = new URLSearchParams();
  if (to.step) params.set('step', to.step);
  if (to.again) params.set('again', '1');
  if (to.from) params.set('from', to.from);
  const qs = params.toString();
  return `/app/w/${workspaceId}/a/outreach/setup${qs ? `?${qs}` : ''}`;
}

// ------------------------------------------------------------------------------------------------- the shapes

export const SetupInput = z.object({ workspaceId: z.uuid() });
export type SetupInput = z.input<typeof SetupInput>;

/** How many of the person's groups the groups step lists. */
export const SETUP_GROUPS_SHOWN = 5;

export const SetupOutput = z.object({
  /** This person's steps, in order. */
  steps: z.array(z.enum(SETUP_STEPS)),
  /** The furthest step finished; null until one is. */
  reached: z.enum(SETUP_STEPS).nullable(),
  /** When they first moved on from a step or left it for later; null when they never have. */
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** The last time the extension said it's signed in for them here; null when it never has. */
  extensionAt: z.iso.datetime().nullable(),
  /** Whether they've ever saved their own settings (an owner or admin saving them for them doesn't count or undo it). */
  settingsSaved: z.boolean(),
  /** Never saved their own settings and never started the setup: Social Outreach sends them to the setup. */
  firstTime: z.boolean(),
  /** Whether Social Outreach's tabs show "Finish setting up" (`showsSetupBanner`). */
  banner: z.boolean(),
  /** Owners and admins: they write the playbooks and set the team's rules. */
  canManage: z.boolean(),
  /** The business's playbooks in use, oldest first. */
  playbooks: z.array(z.object({ name: z.string(), template: z.string().nullable() })),
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
    /** A step finished: moves `reached` forward, never back. */
    reached: z.enum(SETUP_STEPS).optional(),
    /** The last step finished: the setup is done. */
    finished: z.literal(true).optional(),
    /** Sent by the extension: it's signed in here. Says nothing about the setup being started. */
    extension: z.literal(true).optional(),
    /** Left for later: they won't be sent to the setup again. */
    started: z.literal(true).optional(),
    /** Hide the "Finish setting up" line on Social Outreach's tabs. */
    hideBanner: z.literal(true).optional(),
  })
  .refine((i) => i.reached || i.finished || i.extension || i.started || i.hideBanner, {
    error:
      'Say which step was finished, that the setup is done, that it was left for later, or that the extension signed in.',
  });
export type SetupSaveInput = z.input<typeof SetupSaveInput>;
export const SetupSaveOutput = SetupOutput;

/** What's kept for a person, as the rules below read it. */
export interface SetupKept {
  readonly reached: SetupStep | null;
  readonly startedAt: unknown;
  readonly finishedAt: unknown;
  readonly bannerHiddenAt: unknown;
}

/** Never saved their own settings and never started the setup (an extension signing in doesn't count as starting). */
export const isFirstTime = (kept: SetupKept | null, settingsSaved: boolean): boolean =>
  !settingsSaved && !kept?.reached && !kept?.startedAt && !kept?.finishedAt;

/**
 * Whether Social Outreach's tabs remind them to finish: not finished, not hidden, and either started or never saved
 * their own settings. Someone who has used it for weeks and saved theirs long ago isn't reminded.
 */
export const showsSetupBanner = (kept: SetupKept | null, settingsSaved: boolean): boolean =>
  !kept?.finishedAt && !kept?.bannerHiddenAt && (Boolean(kept?.startedAt) || !settingsSaved);

// ------------------------------------------------------------------------------------------------- the words

/** "at 2:14 PM" today, else "on Oct 9". */
export function whenWords(at: string, now = Date.now(), timeZone?: string): string {
  const zone = timeZone || 'UTC';
  const day = localDayOf(at, zone);
  if (day === localDateOf(now, zone)) return `at ${fmtTime(at, zone)}`;
  return `on ${fmtMonthDay(day)}`;
}

/** "Facebook, LinkedIn or Alignable". */
const orWords = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;

/** The setup's words: one copy for the web, the phone and the extension. Plain words, curly apostrophes. */
export const SETUP_WORDS = {
  title: 'Set up Social Outreach',
  /** Beside the brand at the top of the setup's page, as the main app's onboarding has it. */
  settingUp: (business: string) => `Setting up Social Outreach for ${business}`,
  counter: (n: number, of: number, name: string) => `${n} of ${of} · ${name}`,
  /** The screen before the steps, for someone who hasn't finished one yet. */
  welcome: {
    title: 'Let’s set up Social Outreach',
    hint: 'Find customers on Facebook the way you would yourself: in the groups you’re in, with friend requests, likes, comments and messages that sound like you. The extension does the clicking in Chrome, and you stay in charge.',
    steps: 'What you’ll do',
    time: 'About 10 minutes. What you pick is kept as you go, so you can stop any time and carry on later.',
    start: 'Let’s start',
  },
  /** Each step in a line, on the welcome. */
  stepAbout: {
    playbooks: 'Who you’re looking for, how you sound, and what you offer',
    ready: 'Your main offer, a niche, your profile and your goal, for your best results',
    rules: 'What your team may do on its own, and how much a day',
    networks: `Where you reach people: ${orWords(WORKING_PLATFORMS.map((p) => PLATFORMS[p]))}`,
    settings: 'What the extension does for you, how the AI writes, and when',
    extension: 'Put the extension in Chrome and sign in',
    groups: 'Bring in the Facebook groups you’re in',
  } satisfies Record<SetupStep, string>,
  /** On the step they come back to, when they'd finished some before. */
  resumed: 'Welcome back. Carry on where you left off.',
  startOver: 'Start over',
  steps: {
    playbooks: {
      name: 'Playbooks',
      title: 'Pick your playbooks',
      hint: 'A playbook says who you’re looking for on Facebook, how you sound and what you offer. Start from one of ours and make it yours, or write your own. Change them any time on the Playbooks tab.',
      hintMember:
        'Your business’s playbooks say who you’re looking for, how you sound and what you offer. An owner or admin writes them.',
    },
    ready: {
      name: 'Get ready',
      title: 'Get ready for your best results',
      hint: 'Four things to do before the extension reaches anyone for you. People who do them get more replies and more calls booked. Do them now, or carry on: each waits on Today until it’s done.',
    },
    rules: {
      name: 'Your team’s rules',
      title: 'Set your team’s rules',
      hint: 'What everyone may pick, their daily limits, and where a new person starts. Only owners and admins see this step.',
    },
    networks: {
      name: 'Your networks',
      title: 'Pick your networks',
      hint: 'Where you reach people. Facebook is on to start; turn on any other your business allows. Each network has its own day, limits and choices, and a warning on one never stops another. Change them later on the Settings tab.',
    },
    settings: {
      name: 'Your settings',
      title: 'What the extension does for you',
      hint: 'Pick what it may do on its own, and when. Your business’s defaults are picked to start. Change any of it later on the Settings tab.',
      /** For someone who has saved theirs before: what's picked is theirs. */
      hintSaved:
        'Pick what it may do on its own, and when. These are your settings now. Change any of it later on the Settings tab.',
    },
    extension: {
      name: 'The extension',
      title: 'Install the extension and sign in',
      hint: 'It works in Chrome on a computer, beside you on Facebook. It’s a test build you load by hand, not one from the Chrome Web Store.',
    },
    groups: {
      name: 'Your groups',
      title: 'Bring in your groups',
      hint: 'The extension reads the Facebook groups you’re in, and each is scored against your playbooks: Work these, Maybe or Skip.',
    },
  } satisfies Record<
    SetupStep,
    { name: string; title: string; hint: string; hintMember?: string; hintSaved?: string }
  >,
  /** Above the settings when an owner or admin last chose them for the person. */
  pickedForYou: (name: string) => `${name} picked these for you. Keep them or change them.`,
  playbooksInUse: 'Your playbooks',
  playbooksNone:
    'Your business has no playbook yet. Ask an owner or admin to write one; you can carry on meanwhile.',
  playbooksNoneManage: 'No playbook yet. Start from one below, or write your own.',
  templates: 'Start from one of ours',
  templateAbout:
    'It opens in the playbook builder with our words filled in, for you to change to your own offer and link.',
  /**
   * Load unpacked needs the folder that holds manifest.json, so the zip has the build at its top. Chrome knows an
   * extension loaded this way by its folder, so the folder is one to keep: moving it signs the person out.
   */
  install: [
    'Download the extension and unzip it. Move the folder somewhere you’ll keep it, like Documents, and don’t delete it.',
    'In Chrome, go to chrome://extensions and turn on Developer mode, at the top right.',
    'Press Load unpacked and pick the folder that has manifest.json in it.',
    'Pin it: press the puzzle piece beside the address bar, then the pin beside HandsFreeOS Social.',
  ] as const,
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
  signInStep: (email: string, business: string) =>
    `Open facebook.com, press the extension’s button, and sign in with ${email}. Pick ${business} if it asks.`,
  update:
    'For a newer version, download it again and unzip it, put the new files in place of the old ones in the same folder, and press the reload arrow on its card in chrome://extensions.',
  waiting: 'Waiting for the extension to sign in. This page updates by itself.',
  signedIn: (when: string) => `The extension signed in. It last checked in ${when}.`,
  notChrome: 'The extension works in Chrome on a computer. Open this page there to install it.',
  fromExtension: 'The extension is signed in. Finish setting up here: it takes a few minutes.',
  groupsHow:
    'Press Save my groups, and your computer opens your groups on Facebook in a window of its own and saves them here.',
  groupsNone: 'No groups yet: they show here as soon as the extension saves them.',
  groupsSome: (n: number) => `${n} of your ${n === 1 ? 'group is' : 'groups are'} in.`,
  done: {
    title: 'You’re set up',
    hint: 'The extension follows your settings from HandsFreeOS. Change any of it on the Settings tab.',
  },
  phone: 'Get the phone app to hear when someone writes back.',
  /** On the phone's Social Outreach screen until the person has finished the setup (`finishedAt`), hidden line or not. */
  onPhone:
    'Set up Social Outreach on a computer: the extension needs Chrome. Open HandsFreeOS on the web, then Social Outreach.',
  banner: (done: number, of: number) => `Finish setting up Social Outreach: ${done} of ${of} done.`,
  next: 'Next',
  back: 'Back',
  skip: 'Skip for now',
  finish: 'Finish',
  later: 'Finish later',
  carryOn: 'Carry on',
  hide: 'Hide',
  again: 'Set up again',
  againAbout:
    'Go through the setup again: playbooks, getting ready, your networks, your settings, the extension and your groups.',
  againAboutManage:
    'Go through the setup again: playbooks, getting ready, your team’s rules, your networks, your settings, the extension and your groups.',
  /** Under the Get ready step's items. */
  readyStill:
    'Reading your friends and groups goes on while you get ready, so your first day starts with a full list.',
  useTemplate: 'Use this one',
  writeOwn: 'Write your own',
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
  keepRules: 'Keep these and carry on',
  saveRules: 'Save and carry on',
  allGroups: 'See them all on the Groups tab',
  goToday: 'Go to Today',
  getPhone: 'Get the phone app',
  changeLater: 'Change any of it on the Settings tab',
} as const;

/** Where Chrome lists the extensions loaded; a page can't link to it, so it's copied. */
export const CHROME_EXTENSIONS_URL = 'chrome://extensions';

/**
 * The summary beside each step: one plain line per part. The extension's line says when it last checked in, in the
 * business's time zone (`timeZone`), so the server and the browser write the same.
 */
export function setupSummary(
  got: Pick<SetupOutput, 'playbooks' | 'extensionAt' | 'groups'>,
  settings: AutomationSettings | null,
  timeZone?: string,
  now = Date.now(),
): string[] {
  const networks = settings ? PLATFORM_KEYS.filter((p) => settings.networks[p].on) : [];
  return [
    got.playbooks.length
      ? `Playbooks: ${got.playbooks.map((p) => p.name).join(', ')}`
      : 'Playbooks: none yet',
    networks.length
      ? `Networks: ${networks.map((p) => PLATFORMS[p]).join(', ')}`
      : `Networks: ${PLATFORMS.facebook}`,
    settings ? settingsSummary(settings)[0]! : 'Your settings: your business’s defaults',
    got.extensionAt
      ? `Extension: last checked in ${whenWords(got.extensionAt, now, timeZone)}`
      : 'Extension: not signed in yet',
    got.groups.mine ? `Groups: ${got.groups.mine} of yours saved` : 'Groups: none yet',
  ];
}
