/**
 * The extension on its own (docs/outreach.md, decisions 26 to 36): what each person lets it do for them on Facebook
 * without pressing anything, and when. It works only in the build loaded by hand (decision 1), in Chrome on the
 * person's computer, while it's open.
 *
 * - **Sending** (decision 26): off, the person does everything (the default); (a) friend requests, likes and comments
 *   on their own, and each message the AI drafts waits for one tap; (c) the same, with the day's messages drafted
 *   first thing for **Approve all**; or (b) everything on its own, messages too. Messages go through `outreach.sends`
 *   (./sends.ts): the extension drafts each one, it waits for the person's OK or goes as it is, and the extension
 *   sends it in Messenger.
 * - **Replies** (decision 27): (a) every reply waits for the person (the default); (b) simple ones go on their own and
 *   the rest are handed to the person with a push; (c) every reply goes on its own. Even with (c), a reply that needs
 *   the person (a refund, a complaint, a legal threat, cancelling, someone upset or asking for them, an emergency, or
 *   one of the business's own hand-off topics) comes to them with a push, as the AI teammate's do (./sends.ts).
 * - **Training wheels** (proposed with the plan): choosing Sending (b), or Replies (b) or (c), starts them. For the first 7 days, and until the person
 *   has OK'd 25 messages, every message waits for them anyway, and their daily limits are half. More than 3 changed
 *   of the last 10 they OK'd keeps them on. An owner or admin can end them early; a warning from Facebook puts them
 *   back on for 7 days.
 * - **When** (decision 28): in the person's working hours (9 to 5, Monday to Friday, to start), in the business's time
 *   zone, at random times; and when they press **Start my day**.
 * - **Like a post first** (decision 33): someone is sent a friend request only a day or more after one of their posts
 *   was liked; a profile with no post to like goes without.
 * - **Confirm requests that fit** (decision 30): requests they got from people who fit a playbook well are confirmed.
 * - **Once a day** (decision 32): checking friend requests, saving group members, Find posts and Read my chats, at the
 *   start of the working day, while it works on its own; and checking friends and groups (decisions 46 and 48).
 * - **Join groups** (decision 48): when people left to reach in the groups run low, finding groups and asking to join
 *   up to 3 good ones a day, with the AI answering their questions.
 *
 * - **Where they're set** (decisions 37 to 40): in HandsFreeOS, on Social Outreach's Settings tab, on the web and the
 *   phone; never in the extension, which loads them when the person signs in and follows each change within seconds.
 *   They take in the extension's three switches (noting steps, reading chats as they're opened, looking for posts while
 *   scrolling) and how the phone hears what waits. Each person picks their own, inside the business's rules
 *   (`BusinessRules`): the choices it allows, its own daily limits under the starting ones, and the defaults a new
 *   person starts with. Owners and admins can change anyone's; the person sees who did.
 *
 * - **Each network on its own** (Chris, 2026-10-15; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md): the choices
 *   above are Facebook's; each other network has the same choices of its own (`NetworkChoices`, in `networks`), off to
 *   start, inside the same rules and the networks the business allows, with its own daily limits and training wheels.
 *   The working hours, the switches, the pushes, the day's report and the voice stay the person's, for every network.
 *
 * Every step keeps the daily limits, goes at a person's pace, and stops for the day on any warning from its network.
 * Browser-safe: the extension, the web and the API read it.
 */
import { z } from 'zod';
import { localDateOf, localInstant, zonedParts } from '../../calendar/engine/zoned';
import { DAILY_LIMITS, DAILY_STEPS, type DailyStep } from './limits';
import { NETWORKS, PLATFORM_KEYS, PLATFORMS, type Platform } from './networks';
import type { TodayKind } from './today';
import { Voice, VOICE_DEFAULTS } from './voice';

export const SENDING_MODES = {
  off: 'You do everything',
  steps: 'Friend requests, likes and comments on their own; each message waits for one tap',
  approve_all: 'The same, with the day’s messages ready each morning to Approve all',
  everything: 'Everything on its own, messages too',
} as const;
export type SendingMode = keyof typeof SENDING_MODES;
export const SENDING_MODE_KEYS = Object.keys(SENDING_MODES) as [SendingMode, ...SendingMode[]];

/** Replies (decision 27): kept as `draft`, `simple` and `everything`. */
export const REPLY_MODES = {
  draft: 'Every reply waits for you',
  simple: 'Simple replies go on their own; the rest come to you with a push',
  everything: 'Every reply goes on its own, except ones that need you',
} as const;
export type ReplyMode = keyof typeof REPLY_MODES;
export const REPLY_MODE_KEYS = Object.keys(REPLY_MODES) as [ReplyMode, ...ReplyMode[]];

/**
 * How the phone, and the extension's pop-ups, tell of messages and steps waiting for the person (decision 15): a reply
 * handed over always pushes at once.
 */
export const PUSH_MODES = {
  bundled: 'One push for what’s waiting, at most every 2 hours in your working hours',
  each: 'A push for each message or step that waits',
} as const;
export type PushMode = keyof typeof PUSH_MODES;
export const PUSH_MODE_KEYS = Object.keys(PUSH_MODES) as [PushMode, ...PushMode[]];

/**
 * Who puts up a helpful post the AI drafted (decision 50): the person, copying it; the extension, after their OK (the
 * default); or the extension on its own. In this order, safest first: a choice the business stops allowing steps back.
 */
export const POSTING_MODES = {
  copy: 'I copy it and post it myself',
  after_ok: 'The extension posts it after my OK',
  own: 'The extension posts it on its own',
} as const;
export type PostingMode = keyof typeof POSTING_MODES;
export const POSTING_MODE_KEYS = Object.keys(POSTING_MODES) as [PostingMode, ...PostingMode[]];

/** 0 is Sunday. */
export const WEEKDAY_WORDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const WorkingHours = z
  .object({
    /** The hour it starts, and the hour it stops, on the business's clock. */
    start: z.number().int().min(0).max(23),
    end: z.number().int().min(1).max(24),
    /** The days it works, 0 being Sunday; kept each once, in order (`dayList`). */
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, { error: 'Pick at least one day.' })
      .max(7),
  })
  .refine((h) => h.end - h.start >= 1, {
    error: 'Make the working hours at least an hour long, ending after they start.',
    path: ['end'],
  });
export type WorkingHours = z.output<typeof WorkingHours>;

/**
 * Why working hours can't be kept as they are, in the person's words; null when they can. Settings save each change as
 * it's made, so hours caught halfway (a start moved past the end) wait for this to clear rather than being refused.
 */
export function hoursProblem(hours: z.input<typeof WorkingHours>): string | null {
  const out = WorkingHours.safeParse(hours);
  return out.success ? null : (out.error.issues[0]?.message ?? null);
}

/**
 * A network's own choices of what the extension does there on its own (Chris, 2026-10-15: the same choices as
 * Facebook, each network's own). Facebook's are the person's choices in `AutomationSettings`; each other network keeps
 * its own in `networks`, off to start.
 */
export const NetworkChoices = z.object({
  /** The person works this network: while it's off, nothing runs, reads or shows there. */
  on: z.boolean().default(false),
  sending: z.enum(SENDING_MODE_KEYS).default('off'),
  replies: z.enum(REPLY_MODE_KEYS).default('draft'),
  warmUp: z.boolean().default(true),
  confirmRequests: z.boolean().default(true),
  collect: z.boolean().default(true),
  joinGroups: z.boolean().default(true),
  watchPosts: z.boolean().default(true),
  posting: z.enum(POSTING_MODE_KEYS).default('after_ok'),
});
export type NetworkChoices = z.output<typeof NetworkChoices>;
export const NETWORK_CHOICES_DEFAULTS: NetworkChoices = NetworkChoices.parse({});

/** The networks besides Facebook, each with its choices in `networks`. */
export type OtherPlatform = Exclude<Platform, 'facebook'>;
export const OTHER_PLATFORMS = PLATFORM_KEYS.filter((p) => p !== 'facebook') as OtherPlatform[];

/** Which networks the person works, and each other network's choices. Facebook's choices are the ones beside it. */
export const NetworksSettings = z.object({
  facebook: z.object({ on: z.boolean().default(true) }).default({ on: true }),
  linkedin: NetworkChoices.default(NETWORK_CHOICES_DEFAULTS),
  instagram: NetworkChoices.default(NETWORK_CHOICES_DEFAULTS),
  alignable: NetworkChoices.default(NETWORK_CHOICES_DEFAULTS),
});
export type NetworksSettings = z.output<typeof NetworksSettings>;
export const NETWORKS_DEFAULTS: NetworksSettings = NetworksSettings.parse({});

export const AutomationSettings = z.object({
  sending: z.enum(SENDING_MODE_KEYS),
  /** Replies (decision 27): every one waits until a person picks otherwise, and from builds before 0.15. */
  replies: z.enum(REPLY_MODE_KEYS).default('draft'),
  warmUp: z.boolean(),
  confirmRequests: z.boolean(),
  /** The once-a-day jobs (decision 32): they fill the list it works from. On when left out, as 0.11 of the extension does. */
  collect: z.boolean().default(true),
  /**
   * When people left to reach in the groups run low, it finds groups and asks to join up to 3 good ones a day (decision
   * 48), with the once-a-day jobs. On when left out.
   */
  joinGroups: z.boolean().default(true),
  /**
   * In the working hours, it looks at the newest posts in the best groups every hour or two, so one asking for what
   * the business offers is answered fast (decision 49). On when left out.
   */
  watchPosts: z.boolean().default(true),
  /** Who puts up a helpful post (decision 50): after their OK when left out. */
  posting: z.enum(POSTING_MODE_KEYS).default('after_ok'),
  hours: WorkingHours,
  /** The extension notes the person's own steps on Facebook (decision 8). */
  noting: z.boolean().default(true),
  /** It sends a chat the person opens in Messenger for the AI to read. */
  readChats: z.boolean().default(true),
  /** It looks for posts worth a comment as the person scrolls a group. */
  markPosts: z.boolean().default(true),
  /** How the phone hears about messages waiting for their OK. */
  pushes: z.enum(PUSH_MODE_KEYS).default('bundled'),
  /** The day's report: a push at the end of their working hours with the day's numbers (./tracking.ts). On to start. */
  dayReport: z.boolean().default(true),
  /** How the AI writes for them (./voice.ts): plain words always, and their own short forms, acronyms and emoji. */
  voice: Voice.default(VOICE_DEFAULTS),
  /** The networks they work, and each other network's choices: Facebook on and the rest off, to start. */
  networks: NetworksSettings.default(NETWORKS_DEFAULTS),
});
export type AutomationSettings = z.output<typeof AutomationSettings>;

/** A person's choices on one network: Facebook's from the settings themselves, any other's from `networks`. */
export function choicesFor(settings: AutomationSettings, platform: Platform): NetworkChoices {
  if (platform !== 'facebook') return settings.networks[platform];
  const { sending, replies, warmUp, confirmRequests, collect, joinGroups, watchPosts, posting } =
    settings;
  return {
    on: settings.networks.facebook.on,
    sending,
    replies,
    warmUp,
    confirmRequests,
    collect,
    joinGroups,
    watchPosts,
    posting,
  };
}

export const AUTOMATION_DEFAULTS: AutomationSettings = {
  sending: 'off',
  replies: 'draft',
  warmUp: true,
  confirmRequests: true,
  collect: true,
  joinGroups: true,
  watchPosts: true,
  posting: 'after_ok',
  hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
  noting: true,
  readChats: true,
  markPosts: true,
  pushes: 'bundled',
  dayReport: true,
  voice: VOICE_DEFAULTS,
  networks: NETWORKS_DEFAULTS,
};

/** The daily limits a business can set on Facebook, each at most the starting one (./limits.ts). */
export const BusinessLimits = z
  .object({
    friend_request: z.number().int().min(0).max(DAILY_LIMITS.friend_request),
    first_message: z.number().int().min(0).max(DAILY_LIMITS.first_message),
    follow_up: z.number().int().min(0).max(DAILY_LIMITS.follow_up),
    comment: z.number().int().min(0).max(DAILY_LIMITS.comment),
    like: z.number().int().min(0).max(DAILY_LIMITS.like),
  })
  .partial();
export type BusinessLimits = z.output<typeof BusinessLimits>;

/** The daily limits a business can set on another network, each at most that network's starting one (./networks.ts). */
const limitsOn = (platform: Platform) =>
  z
    .object(
      Object.fromEntries(
        DAILY_STEPS.map((step) => [
          step,
          z.number().int().min(0).max(NETWORKS[platform].dailyLimits[step]),
        ]),
      ) as Record<DailyStep, z.ZodNumber>,
    )
    .partial();
export const NetworkLimits = z
  .object({
    linkedin: limitsOn('linkedin'),
    instagram: limitsOn('instagram'),
    alignable: limitsOn('alignable'),
  })
  .partial();
export type NetworkLimits = z.output<typeof NetworkLimits>;

/**
 * What owners and admins set for everyone (decision 38): the Sending and Replies choices people may pick (doing
 * everything themselves, and every reply waiting, are always allowed), daily limits under the starting ones, and the
 * choices a new person starts with. Kept with the business's Social Outreach settings.
 */
export const BusinessRules = z.object({
  sendingAllowed: z
    .array(z.enum(SENDING_MODE_KEYS))
    .default([...SENDING_MODE_KEYS])
    .transform((modes) => SENDING_MODE_KEYS.filter((m) => m === 'off' || modes.includes(m))),
  repliesAllowed: z
    .array(z.enum(REPLY_MODE_KEYS))
    .default([...REPLY_MODE_KEYS])
    .transform((modes) => REPLY_MODE_KEYS.filter((m) => m === 'draft' || modes.includes(m))),
  /** Copying it themselves is always allowed. */
  postingAllowed: z
    .array(z.enum(POSTING_MODE_KEYS))
    .default([...POSTING_MODE_KEYS])
    .transform((modes) => POSTING_MODE_KEYS.filter((m) => m === 'copy' || modes.includes(m))),
  dailyLimits: BusinessLimits.default({}),
  /** The networks people may turn on: every one to start. Facebook is always allowed. */
  networksAllowed: z
    .array(z.enum(PLATFORM_KEYS))
    .default([...PLATFORM_KEYS])
    .transform((nets) => PLATFORM_KEYS.filter((p) => p === 'facebook' || nets.includes(p))),
  /** Each other network's daily limits under its starting ones; Facebook's are `dailyLimits`. */
  networkLimits: NetworkLimits.default({}),
  defaults: AutomationSettings.default(AUTOMATION_DEFAULTS),
});
export type BusinessRules = z.output<typeof BusinessRules>;
export const NO_RULES: BusinessRules = BusinessRules.parse({});

/** The business's own daily limits on a network: Facebook's `dailyLimits`, or the network's in `networkLimits`. */
export const businessLimitsOn = (
  rules: Pick<BusinessRules, 'dailyLimits' | 'networkLimits'>,
  platform: Platform,
): Partial<Readonly<Record<DailyStep, number>>> =>
  platform === 'facebook' ? rules.dailyLimits : (rules.networkLimits[platform] ?? {});

/** The nearest choice the business allows, at or before this one: a choice it stopped allowing steps back. */
function allowedOf<T extends string>(order: readonly T[], allowed: readonly T[], want: T): T {
  for (let i = order.indexOf(want); i > 0; i--) if (allowed.includes(order[i]!)) return order[i]!;
  return order[0]!;
}

/** A network's choices as they stand inside the business's rules: off when the business doesn't allow the network. */
function choicesWithin(
  choices: NetworkChoices,
  rules: BusinessRules,
  platform: Platform,
): NetworkChoices {
  return {
    ...choices,
    on: choices.on && rules.networksAllowed.includes(platform),
    sending: allowedOf(SENDING_MODE_KEYS, rules.sendingAllowed, choices.sending),
    replies: allowedOf(REPLY_MODE_KEYS, rules.repliesAllowed, choices.replies),
    posting: allowedOf(POSTING_MODE_KEYS, rules.postingAllowed, choices.posting),
  };
}

/** A person's choices as they stand inside the business's rules, on every network. */
export function withinRules(
  settings: AutomationSettings,
  rules: BusinessRules,
): AutomationSettings {
  return {
    ...settings,
    sending: allowedOf(SENDING_MODE_KEYS, rules.sendingAllowed, settings.sending),
    replies: allowedOf(REPLY_MODE_KEYS, rules.repliesAllowed, settings.replies),
    posting: allowedOf(POSTING_MODE_KEYS, rules.postingAllowed, settings.posting),
    networks: {
      facebook: settings.networks.facebook,
      linkedin: choicesWithin(settings.networks.linkedin, rules, 'linkedin'),
      instagram: choicesWithin(settings.networks.instagram, rules, 'instagram'),
      alignable: choicesWithin(settings.networks.alignable, rules, 'alignable'),
    },
  };
}

/** The choices of these the business doesn't allow, quoted; empty when it allows them all. */
const notAllowedOf = (c: NetworkChoices, rules: BusinessRules): string[] =>
  [
    rules.sendingAllowed.includes(c.sending) ? null : `“${SENDING_MODES[c.sending]}”`,
    rules.repliesAllowed.includes(c.replies) ? null : `“${REPLY_MODES[c.replies]}”`,
    rules.postingAllowed.includes(c.posting) ? null : `“${POSTING_MODES[c.posting]}”`,
  ].filter((w): w is string => w !== null);

/** What the business doesn't allow of these choices, in words to refuse them with; null when it's all allowed. */
export function notAllowedWords(settings: AutomationSettings, rules: BusinessRules): string | null {
  const fix =
    'Pick another, or ask an owner of this business to allow it under Social Outreach → Settings → General.';
  const offNetworks = OTHER_PLATFORMS.filter(
    (p) => settings.networks[p].on && !rules.networksAllowed.includes(p),
  );
  if (offNetworks.length) {
    const names = offNetworks.map((p) => PLATFORMS[p]).join(' or ');
    return `Your business doesn’t use ${names} for outreach. Turn it off, or ask an owner of this business to allow it under Social Outreach → Settings → ${names}.`;
  }
  const facebook = notAllowedOf(choicesFor(settings, 'facebook'), rules);
  if (facebook.length) return `Your business doesn’t allow ${facebook.join(' or ')}. ${fix}`;
  for (const p of OTHER_PLATFORMS) {
    const off = notAllowedOf(settings.networks[p], rules);
    if (off.length)
      return `Your business doesn’t allow ${off.join(' or ')} on ${PLATFORMS[p]}. ${fix}`;
  }
  return null;
}

/** The choices that say what the extension does on its own on a network: a network's, or Facebook's settings. */
type DoesChoices = Pick<NetworkChoices, 'sending' | 'confirmRequests' | 'warmUp'> & {
  readonly on?: boolean;
};

/**
 * The kinds on the list for today the extension does on its own for someone, in the order it does them: requests
 * to confirm first, then likes, friend requests and comments. Messages go their own way (`MESSAGE_KINDS`). None on a
 * network the person doesn't work.
 */
export function autoKinds(settings: DoesChoices): TodayKind[] {
  if (settings.sending === 'off' || settings.on === false) return [];
  return [
    ...(settings.confirmRequests ? (['confirm'] as const) : []),
    ...(settings.warmUp ? (['warm_up'] as const) : []),
    'friend_request',
    'comment',
  ];
}

/**
 * The kinds on the list that are messages: the extension drafts each, and sends it once it's OK'd (./sends.ts). A
 * partner's (decision 81) always wait for an OK of their own.
 */
export const MESSAGE_KINDS = [
  'opener',
  'reconnect',
  'pitch',
  'video',
  'follow_up',
  'check_in',
  'reply',
  'partner_ask',
  'partner_follow_up',
  'partner_details',
  'partner_reply',
] as const satisfies readonly TodayKind[];
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** The messages the extension drafts for the person: none while it's off, or on a network they don't work. */
export const messageKinds = (settings: Pick<DoesChoices, 'sending' | 'on'>): MessageKind[] =>
  settings.sending === 'off' || settings.on === false ? [] : [...MESSAGE_KINDS];

/** What choosing Sending (b), or Replies (b) or (c), means, said where it's chosen. */
export const WHEELS_START_WORDS =
  'Choosing this starts training wheels: for your first 7 days, and until you’ve OK’d 25 messages, each message waits for your OK and your daily limits are half.';

/** Training wheels: how long, how many OK'd, and how many changed of the last ones keep them on. */
export const WHEELS = { days: 7, ok: 25, last: 10, edits: 3 } as const;

/** Where a person's training wheels stand, as kept. */
export interface WheelsKept {
  readonly from: Date | string | null;
  readonly ok: number;
  readonly edits: readonly boolean[];
  readonly doneAt: Date | string | null;
}

/** Whether they've done enough to come off: 7 days, 25 OK'd, and few enough changed of the last 10. */
export function wheelsEarned(kept: WheelsKept, now: number): boolean {
  if (kept.from === null) return false;
  const days = (now - new Date(kept.from).getTime()) / 86_400_000;
  return (
    days >= WHEELS.days &&
    kept.ok >= WHEELS.ok &&
    kept.edits.slice(-WHEELS.last).filter(Boolean).length <= WHEELS.edits
  );
}

/** Whether training wheels are on: started, not ended, and not earned yet. */
export const wheelsOn = (kept: WheelsKept, now: number) =>
  kept.from !== null && kept.doneAt === null && !wheelsEarned(kept, now);

/**
 * The choices training wheels are for: messages on their own (Sending (b)), or replies on their own (Replies (b) or
 * (c)) while the extension writes messages at all. They start when one is chosen.
 */
export const wheelsMatter = (settings: Pick<AutomationSettings, 'sending' | 'replies'>) =>
  settings.sending === 'everything' || (settings.sending !== 'off' && settings.replies !== 'draft');

/** Training wheels as kept before anyone chose (b): not started. */
export const NO_WHEELS: WheelsKept = { from: null, ok: 0, edits: [], doneAt: null };

export const WheelsState = z.object({
  /** Every message waits for the person, and their daily limits are half: only while messages or replies go on their own. */
  on: z.boolean(),
  /** Since when; null when they never started. */
  from: z.iso.datetime().nullable(),
  /** Messages OK'd so far, of the 25. */
  ok: z.number().int().min(0),
  /** Days left of the 7: 0 once they're past. */
  daysLeft: z.number().int().min(0),
  /** Of the last 10 OK'd, how many were changed first. */
  edits: z.number().int().min(0),
});
export type WheelsState = z.output<typeof WheelsState>;

export function wheelsState(kept: WheelsKept, now: number, matter = true): WheelsState {
  const from = kept.from === null ? null : new Date(kept.from);
  return {
    on: matter && wheelsOn(kept, now),
    from: from?.toISOString() ?? null,
    ok: kept.ok,
    daysLeft: from
      ? Math.max(0, Math.ceil(WHEELS.days - (now - from.getTime()) / 86_400_000))
      : WHEELS.days,
    edits: kept.edits.slice(-WHEELS.last).filter(Boolean).length,
  };
}

/** Where training wheels stand, in words for the person. */
export function wheelsWords(state: WheelsState): string {
  const left = [
    state.ok < WHEELS.ok ? `${WHEELS.ok - state.ok} more messages to OK` : null,
    state.daysLeft ? `${state.daysLeft} ${state.daysLeft === 1 ? 'day' : 'days'} to go` : null,
    state.edits > WHEELS.edits
      ? `fewer changes: you changed ${state.edits} of the last ${WHEELS.last}`
      : null,
  ].filter(Boolean);
  return `Training wheels: every message waits for your OK, and your daily limits are half${left.length ? `. Still: ${left.join(', ')}` : ''}.`;
}

export const AutomationInput = z.object({
  workspaceId: z.uuid(),
  /** Someone else's, for an owner or admin; the person's own when left out. */
  userId: z.uuid().optional(),
});
export type AutomationInput = z.input<typeof AutomationInput>;

export const AutomationOutput = z.object({
  settings: AutomationSettings,
  /** The business's time zone, which the working hours are on. */
  timezone: z.string(),
  /**
   * When Social Outreach was last installed here: starting it fresh moves it, and the extension then forgets what it
   * kept on the computer from before (chats read, steps not yet sent, the setup opened).
   */
  startedAt: z.iso.datetime().nullable().default(null),
  /** Whether the person has saved their own yet: until then, these are the defaults. */
  saved: z.boolean(),
  /** Their training wheels on Facebook. */
  wheels: WheelsState,
  /** Their training wheels on each other network: each network's own, as its choices are. */
  networkWheels: z.object({
    linkedin: WheelsState,
    instagram: WheelsState,
    alignable: WheelsState,
  }),
  /** Whose they are. */
  userId: z.uuid(),
  name: z.string(),
  /** An owner or admin who changed them last, when it wasn't the person. */
  changedBy: z.string().nullable(),
  /** What the business allows (decision 38). */
  rules: z.object({
    sendingAllowed: z.array(z.enum(SENDING_MODE_KEYS)),
    repliesAllowed: z.array(z.enum(REPLY_MODE_KEYS)),
    postingAllowed: z.array(z.enum(POSTING_MODE_KEYS)),
    dailyLimits: BusinessLimits,
    networksAllowed: z.array(z.enum(PLATFORM_KEYS)),
    networkLimits: NetworkLimits,
  }),
});
export type AutomationOutput = z.output<typeof AutomationOutput>;

export const AutomationSaveInput = z.object({
  workspaceId: z.uuid(),
  /** Someone else's, for an owner or admin; the person's own when left out. */
  userId: z.uuid().optional(),
  /** The voice, the day's report and the networks left out (a screen from before them) keep the ones kept. */
  settings: AutomationSettings.extend({
    voice: Voice.optional(),
    dayReport: z.boolean().optional(),
    networks: NetworksSettings.optional(),
  }),
});
export type AutomationSaveInput = z.input<typeof AutomationSaveInput>;

export const AutomationSaveOutput = AutomationOutput;

/** An owner or admin ends someone's training wheels early, on one network (Facebook's when left out). */
export const WheelsEndInput = z.object({
  workspaceId: z.uuid(),
  userId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
});
export type WheelsEndInput = z.input<typeof WheelsEndInput>;
export const WheelsEndOutput = z.object({ userId: z.uuid(), ended: z.boolean() });

export const WheelsListInput = z.object({ workspaceId: z.uuid() });
export type WheelsListInput = z.input<typeof WheelsListInput>;
/** Everyone in the business on training wheels now, on each network, for owners and admins. */
export const WheelsListOutput = z.object({
  people: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string(),
      /** The network they're on training wheels on: one row for each. */
      platform: z.enum(PLATFORM_KEYS).default('facebook'),
      wheels: WheelsState,
    }),
  ),
});
export type WheelsListOutput = z.output<typeof WheelsListOutput>;

/** Everyone who can use Social Outreach here, with their choices, for owners and admins (decision 39). */
export const AutomationPeopleInput = z.object({ workspaceId: z.uuid() });
export type AutomationPeopleInput = z.input<typeof AutomationPeopleInput>;
export const AutomationPeopleOutput = z.object({
  people: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string(),
      /** Whether they've saved their own; until then the business's defaults stand. */
      saved: z.boolean(),
      sending: z.enum(SENDING_MODE_KEYS),
      replies: z.enum(REPLY_MODE_KEYS),
      wheels: z.boolean(),
    }),
  ),
});
export type AutomationPeopleOutput = z.output<typeof AutomationPeopleOutput>;

/** A profile with no post to like (decision 33): its friend request goes without the warm-up. */
export const WarmUpMissedInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
});
export type WarmUpMissedInput = z.input<typeof WarmUpMissedInput>;
export const WarmUpMissedOutput = z.object({ profileId: z.uuid() });

/**
 * The warm-up's timing: a friend request goes at least this long after the like, so a day or two later (decision 33),
 * and a like older than the window doesn't count.
 */
export const WARM_UP_WAIT_HOURS = 20;
export const WARM_UP_WINDOW_DAYS = 14;

/** The days each once, Sunday first. */
export const dayList = (days: readonly number[]) => [...new Set(days)].sort((a, b) => a - b);

const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/** Today's working window in the business's time zone, as instants: null on a day off. */
export function workWindow(
  hours: WorkingHours,
  timeZone: string,
  now: number,
): { readonly from: number; readonly to: number } | null {
  const { weekday } = zonedParts(now, timeZone);
  if (!hours.days.includes(weekday)) return null;
  const date = localDateOf(now, timeZone);
  return {
    from: localInstant(date, clock(hours.start), timeZone),
    to: localInstant(date, clock(hours.end), timeZone),
  };
}

/** The business's day at a moment: "2026-10-09". */
export function businessDay(now: number, timeZone: string): string {
  return localDateOf(now, timeZone);
}

/** Whether it's working hours now. */
export function inWorkingHours(hours: WorkingHours, timeZone: string, now: number): boolean {
  const w = workWindow(hours, timeZone, now);
  return w !== null && now >= w.from && now < w.to;
}

/** An hour on the clock: "9 AM", "noon", "midnight". */
export function hourWords(hour: number): string {
  if (hour === 0 || hour === 24) return 'midnight';
  if (hour === 12) return 'noon';
  return `${hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** "9 AM to 5 PM, Mon to Fri". */
export function hoursWords(hours: WorkingHours): string {
  const at = hourWords;
  const days = hours.days;
  const run = days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  const dayWords =
    days.length === 7
      ? 'every day'
      : run && days.length > 2
        ? `${WEEKDAY_WORDS[days[0]!]} to ${WEEKDAY_WORDS[days[days.length - 1]!]}`
        : days.map((d) => WEEKDAY_WORDS[d]).join(', ');
  return `${at(hours.start)} to ${at(hours.end)}, ${dayWords}`;
}

/** The short words for each choice, for a one-line summary (decision 39: the extension shows it, read-only). */
const SENDING_SHORT: Record<SendingMode, string> = {
  off: 'Off: you do everything',
  steps: 'Requests, likes and comments on their own; each message waits for you',
  approve_all: 'Requests, likes and comments on their own; messages ready to Approve all',
  everything: 'Everything on its own',
};
const REPLIES_SHORT: Record<ReplyMode, string> = {
  draft: 'every one waits for you',
  simple: 'simple ones on their own',
  everything: 'on their own, except ones that need you',
};

/** "On its own: … · Replies: … · 9 AM to 5 PM, Mon to Fri", one line per part. */
export function settingsSummary(settings: AutomationSettings): string[] {
  const lines = [`On its own: ${SENDING_SHORT[settings.sending]}`];
  if (settings.sending !== 'off') {
    lines.push(`Replies: ${REPLIES_SHORT[settings.replies]}`);
    lines.push(`When: ${hoursWords(settings.hours)}`);
  }
  const off = [
    !settings.noting && 'noting your steps',
    !settings.readChats && 'reading chats you open',
    !settings.markPosts && 'looking for posts as you scroll',
  ].filter((word): word is string => Boolean(word));
  if (off.length) lines.push(`Off: ${off.join(', ')}`);
  return lines;
}
