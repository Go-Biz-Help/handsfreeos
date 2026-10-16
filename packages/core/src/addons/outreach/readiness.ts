/**
 * Get ready for your best results (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, "Getting ready"; docs/outreach.md,
 * decision 63): what has to be in place before Social Outreach reaches anyone for a person. Nothing outreach-like
 * happens until every item is done: Start my day is refused (`outreach_not_ready`), Today's list keeps only replies
 * owed to people who wrote first (answering isn't reaching out), with Get ready in place of the rest, and the extension
 * puts up no helpful post on its own.
 *
 * - **Your main offer** (the business's): a version is live. Publishing already holds it to every part 7 or more, or
 *   an owner's Use it anyway with a reason.
 * - **A playbook with a niche** (the business's): a playbook in use has its niche and the niche's problem, and some
 *   proof when the business has any (none is ever made up).
 * - **Your profile** (each person's): the extension has read it since the main offer went live (./profile-check.ts,
 *   decision 64), and every item on the profile list is right by the AI's check of it or ticked done by hand.
 * - **Your messages** (each person's, decisions 65 to 67): they've seen sample messages for their playbook as the AI
 *   writes them in their voice (the first message, the video, the link, the follow-ups and a check-in) and OK'd how
 *   they read, since the live version.
 * - **Your numbers** (each person's): a monthly goal for calls booked, and the math seen.
 *
 * Worked out each time from what's kept (`outreach.readiness`), never stored as a flag. Browser-safe: the web, the
 * phone and the extension read the items, the words and the math from here.
 */
import { z } from 'zod';
import { SCORED_PART_LABELS, SCORED_PARTS, type MainOfferParts } from '../../main-offer/parts';
import { DAILY_LIMITS } from './limits';
import { MessageSamples } from './conversation';
import { NETWORKS, PLATFORM_KEYS, type Platform } from './networks';
import {
  ALL_PROFILE_ITEMS,
  checkCounts,
  PROFILE_ITEMS_ON,
  ProfileCheck,
  profileCheckWordsOn,
  type AnyProfileItem,
  type ProfileItem,
} from './profile-check';

// ------------------------------------------------------------------------------------------------- the items

export const READY_ITEMS = ['offer', 'playbook', 'profile', 'messages', 'numbers'] as const;
export type ReadyItem = (typeof READY_ITEMS)[number];

/** Whose each item is: the business's, done by an owner or admin, or each person's own. */
export const READY_WHOSE: Record<ReadyItem, 'business' | 'person'> = {
  offer: 'business',
  playbook: 'business',
  profile: 'person',
  messages: 'person',
  numbers: 'person',
};

/**
 * Where an item stands for the person: done; to do; done before the main offer changed, so look again; or the
 * business's, to be done by an owner or admin (the person can't do it).
 */
export const READY_STATES = ['done', 'todo', 'look_again', 'waiting'] as const;
export type ReadyState = (typeof READY_STATES)[number];

// What a profile needs (the workbook's checklist, made for Facebook): the AI checks each, and the person can tick one.
export {
  ALL_PROFILE_ITEMS,
  PROFILE_ITEMS,
  PROFILE_ITEMS_ON,
  type AnyProfileItem,
  type ProfileItem,
} from './profile-check';

/** A profile item ticked: when, and the main offer's version live then (null with none live yet). */
export const ProfileTick = z.object({
  at: z.iso.datetime(),
  version: z.number().int().min(1).nullable(),
});
export type ProfileTick = z.output<typeof ProfileTick>;
export const ProfileTicks = z.partialRecord(z.enum(ALL_PROFILE_ITEMS), ProfileTick);
export type ProfileTicks = z.output<typeof ProfileTicks>;

/**
 * Whether a tick counts for the live version: one made while it was live, or one made before any version was live
 * when this is the first. A tick from an older version means look again.
 */
export function tickCounts(tick: ProfileTick | undefined, live: number | null): boolean {
  if (!tick) return false;
  if (live === null) return true;
  return tick.version === live || (tick.version === null && live === 1);
}

/** What the readiness reads, gathered by `outreach.readiness`. */
export interface ReadyFacts {
  /** The main offer's live version, with the one before it to say what changed; null with none live. */
  readonly offer: {
    readonly version: number;
    readonly parts: MainOfferParts;
    readonly before: MainOfferParts | null;
  } | null;
  /** The playbooks in use. */
  readonly playbooks: readonly {
    readonly name: string;
    readonly niche: string | null;
    readonly problem: string | null;
    readonly proof: readonly string[];
    /** Its short video's link (decision 69): Your messages waits on one. */
    readonly videoLink: string | null;
  }[];
  readonly profile: ProfileTicks;
  /** The AI's latest check of the person's profile, read by the extension; null until one is. */
  readonly profileCheck: ProfileCheck | null;
  /** The network whose profile it is: Facebook unless said. Each network's profile is its own (Chris's rule). */
  readonly platform?: Platform;
  /** When the person OK'd how their messages read, and the main offer's version then; null until they did. */
  readonly messages: { readonly at: string; readonly version: number | null } | null;
  /** The person's monthly goal, and when they last saw the math; null until they set it. */
  readonly numbers: { readonly goal: number | null; readonly at: string | null };
  /** Owners and admins do the business's items: the main offer, and the playbooks. */
  readonly canOffer: boolean;
  readonly canPlaybooks: boolean;
}

export interface ReadyItemState {
  readonly item: ReadyItem;
  readonly state: ReadyState;
  readonly whose: 'business' | 'person';
  /** What's left, in a line; null when it's done. */
  readonly left: string | null;
}

export interface Readiness {
  readonly ready: boolean;
  readonly items: readonly ReadyItemState[];
  /** The first item not done, the one to do next; null when ready. */
  readonly next: ReadyItem | null;
  /** The main offer's parts that changed in its live version, by name, when the profile wants a look again. */
  readonly changed: readonly string[];
}

const filled = (v: string | null | undefined) => Boolean(v?.trim());

/** The parts a new version changed, as the score names them, and the line. */
export function changedParts(before: MainOfferParts, now: MainOfferParts): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const parts: string[] = SCORED_PARTS.filter((p) => !same(before[p], now[p])).map(
    (p) => SCORED_PART_LABELS[p],
  );
  if (!same(before.proof, now.proof)) parts.push('Proof');
  if (!same(before.line, now.line) || !same(before.inAFewWords, now.inAFewWords))
    parts.push('The line');
  return parts;
}

/** Where each item stands for the person, and whether they're ready. */
export function readinessOf(f: ReadyFacts): Readiness {
  const live = f.offer?.version ?? null;
  const offerHasProof = (f.offer?.parts.proof ?? []).some(filled);
  const W = READY_WORDS.left;

  const offer: ReadyItemState = f.offer
    ? { item: 'offer', state: 'done', whose: 'business', left: null }
    : f.canOffer
      ? { item: 'offer', state: 'todo', whose: 'business', left: W.offer }
      : { item: 'offer', state: 'waiting', whose: 'business', left: W.offerWaiting };

  const withNiche = f.playbooks.find(
    (p) => filled(p.niche) && filled(p.problem) && (!offerHasProof || p.proof.some(filled)),
  );
  const playbookLeft = (): string => {
    if (!f.playbooks.length) return W.playbookNone;
    const p = f.playbooks.find((x) => filled(x.niche)) ?? f.playbooks[0]!;
    if (!filled(p.niche)) return W.playbookNiche(p.name);
    if (!filled(p.problem)) return W.playbookProblem(p.name);
    return W.playbookProof(p.name);
  };
  const playbook: ReadyItemState = withNiche
    ? { item: 'playbook', state: 'done', whose: 'business', left: null }
    : f.canPlaybooks
      ? { item: 'playbook', state: 'todo', whose: 'business', left: playbookLeft() }
      : { item: 'playbook', state: 'waiting', whose: 'business', left: W.playbookWaiting };

  // Read since the live version, each item right by the AI's check or ticked done; a read or ticks from an older
  // version want a look again.
  // The network's own profile and its own items: LinkedIn's has its headline and About.
  const platform = f.platform ?? 'facebook';
  const profileItems = PROFILE_ITEMS_ON[platform];
  const read = checkCounts(f.profileCheck, live) ? f.profileCheck : null;
  const counted = profileItems.filter(
    (i) => tickCounts(f.profile[i], live) || read?.items[i]?.ok === true,
  );
  const stale =
    (f.profileCheck !== null && !read) ||
    profileItems.some((i) => f.profile[i] && !tickCounts(f.profile[i], live));
  const profile: ReadyItemState =
    read && counted.length === profileItems.length
      ? { item: 'profile', state: 'done', whose: 'person', left: null }
      : stale && !read
        ? { item: 'profile', state: 'look_again', whose: 'person', left: W.profileAgain }
        : !read
          ? {
              item: 'profile',
              state: 'todo',
              whose: 'person',
              left: platform === 'facebook' ? W.profileRead : W.profileReadOn(platform),
            }
          : {
              item: 'profile',
              state: 'todo',
              whose: 'person',
              left: W.profile(profileItems.length - counted.length, platform),
            };

  // OK'd since the live version, with a playbook's short video linked (decision 69, the business's: an owner or admin
  // links it); OK'd before the version changed wants a look again. Samples need the offer and a niche first.
  const video = f.playbooks.some((p) => filled(p.videoLink));
  const okd = f.messages !== null && live !== null && f.messages.version === live;
  const messages: ReadyItemState =
    okd && video
      ? { item: 'messages', state: 'done', whose: 'person', left: null }
      : okd
        ? f.canPlaybooks
          ? { item: 'messages', state: 'todo', whose: 'person', left: W.messagesVideo }
          : { item: 'messages', state: 'waiting', whose: 'business', left: W.messagesVideoWaiting }
        : f.messages && live !== null
          ? { item: 'messages', state: 'look_again', whose: 'person', left: W.messagesAgain }
          : {
              item: 'messages',
              state: 'todo',
              whose: 'person',
              left: f.offer && withNiche ? W.messages : W.messagesFirst,
            };

  const numbers: ReadyItemState =
    f.numbers.goal !== null && f.numbers.at !== null
      ? { item: 'numbers', state: 'done', whose: 'person', left: null }
      : { item: 'numbers', state: 'todo', whose: 'person', left: W.numbers };

  const items = [offer, playbook, profile, messages, numbers];
  const next = items.find((i) => i.state !== 'done')?.item ?? null;
  return {
    ready: next === null,
    items,
    next,
    changed:
      (profile.state === 'look_again' || messages.state === 'look_again') && f.offer?.before
        ? changedParts(f.offer.before, f.offer.parts)
        : [],
  };
}

/** Why Start my day is refused (`outreach_not_ready`): the first item left, and where to finish it. */
export function notReadyWords(r: Readiness & { readonly platform?: Platform }): string {
  const first = r.items.find((i) => i.state !== 'done');
  if (!first) return '';
  if (first.state === 'waiting') return first.left!;
  // Another network's own profile says which: "Your LinkedIn profile isn't ready yet."
  const words =
    first.item === 'profile' && r.platform && r.platform !== 'facebook'
      ? `Your ${NETWORKS[r.platform].name} profile isn’t ready yet.`
      : READY_WORDS.notReady[first.item];
  return `${words} Finish it under Get ready on the Today tab.`;
}

// ------------------------------------------------------------------------------------------------- the shapes

export const ReadinessInput = z.object({
  workspaceId: z.uuid(),
  /** The network whose profile counts: each network's is its own. Facebook unless said. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
});
export type ReadinessInput = z.input<typeof ReadinessInput>;

export const ReadinessOutput = z.object({
  /** The network it's for: its profile, its items and its words. Facebook when left out. */
  platform: z.enum(PLATFORM_KEYS).optional(),
  ready: z.boolean(),
  items: z.array(
    z.object({
      item: z.enum(READY_ITEMS),
      state: z.enum(READY_STATES),
      whose: z.enum(['business', 'person']),
      left: z.string().nullable(),
    }),
  ),
  next: z.enum(READY_ITEMS).nullable(),
  changed: z.array(z.string()),
  /** The main offer's live version, to show beside the profile and to tick against; null with none live. */
  offer: z.object({ version: z.number().int().min(1), line: z.string() }).nullable(),
  /** The profile items ticked, as kept: `tickCounts` says which count for the live version. */
  profile: ProfileTicks,
  /** The AI's latest check of the profile, read by the extension: `checkCounts` says whether it's for the live version. */
  profileCheck: ProfileCheck.nullable(),
  /** Your messages: when they OK'd how they read and the version then, and the samples the AI wrote for them. */
  messages: z.object({
    at: z.iso.datetime().nullable(),
    version: z.number().int().min(1).nullable(),
    samples: MessageSamples.nullable(),
  }),
  numbers: z.object({
    goal: z.number().int().nullable(),
    at: z.iso.datetime().nullable(),
    /** The days they work, from their settings' working hours. */
    days: z.array(z.number().int().min(0).max(6)),
    /** First messages a day the business's daily limit allows. */
    canSend: z.number().int().min(0),
  }),
});
export type ReadinessOutput = z.output<typeof ReadinessOutput>;

export const ProfileCheckSaveInput = z.object({
  workspaceId: z.uuid(),
  /** Whose profile: the person whose extension read it. */
  userId: z.uuid(),
  /** The network the profile is on. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  check: ProfileCheck,
});
export type ProfileCheckSaveInput = z.input<typeof ProfileCheckSaveInput>;

export const ProfileTickInput = z
  .object({
    workspaceId: z.uuid(),
    /** The network whose profile it is: Facebook unless said. */
    platform: z.enum(PLATFORM_KEYS).default('facebook'),
    item: z.enum(ALL_PROFILE_ITEMS),
    /** Ticked as done, or taken back. */
    done: z.boolean(),
  })
  .refine((i) => PROFILE_ITEMS_ON[i.platform].includes(i.item), {
    error: 'That isn’t on this network’s profile list.',
  });
export type ProfileTickInput = z.input<typeof ProfileTickInput>;

// ------------------------------------------------------------------------------------------------- your numbers

/** The video's rates, until the person has numbers of their own: 4 to 8% of first messages get a yes, 1 in 3 books. */
export const STARTING_RATES = { yes: { low: 0.04, high: 0.08 }, books: 1 / 3 } as const;
export type NumbersRates = {
  readonly yes: { readonly low: number; readonly high: number };
  readonly books: number;
};

/** The goal's limits: calls booked a month. */
export const CALLS_GOAL = { min: 1, max: 100 } as const;

export const NumbersInput = z.object({
  workspaceId: z.uuid(),
  /** Calls booked a month. */
  goal: z
    .number()
    .int({ error: 'Use a whole number of calls.' })
    .min(CALLS_GOAL.min, { error: 'Aim for at least one call a month.' })
    .max(CALLS_GOAL.max, { error: `Aim for ${CALLS_GOAL.max} calls a month at most.` }),
  /** The days they work, 0 being Sunday: kept in their settings' working hours. */
  days: z.array(z.number().int().min(0).max(6)).min(1, { error: 'Pick at least one day.' }).max(7),
});
export type NumbersInput = z.input<typeof NumbersInput>;

/** Weeks in a month, on average. */
const WEEKS_A_MONTH = 52 / 12;

export interface NumbersMath {
  /** Working days a month, from the days a week. */
  readonly daysAMonth: number;
  readonly callsADay: number;
  /** Yeses a day: people who say they're interested. */
  readonly yesesADay: number;
  /** First messages a day it takes: at the best rate, and at the worst. */
  readonly messagesADay: { readonly low: number; readonly high: number };
  /** First messages Facebook's safe pace allows a day (the business's limit). */
  readonly canSend: number;
  /** Calls a month that pace brings, at the worst rate and the best. */
  readonly pace: { readonly low: number; readonly high: number };
  /** Within the pace at any rate, only at the better rates, or past it at every rate. */
  readonly fits: 'yes' | 'maybe' | 'no';
}

/**
 * What a monthly goal takes each day, worked as the video works it: calls a month ÷ working days = calls a day; ÷ the
 * booking rate = yeses a day; ÷ the yes rate = first messages a day. A friend request is never a message. Then the
 * honest part: what one Facebook account's safe pace (`DAILY_LIMITS.first_message`, or the business's lower one)
 * brings in a month.
 */
export function numbersMath(input: {
  readonly goal: number;
  readonly daysAWeek: number;
  readonly canSend?: number;
  readonly rates?: NumbersRates;
}): NumbersMath {
  const rates = input.rates ?? STARTING_RATES;
  const canSend = input.canSend ?? DAILY_LIMITS.first_message;
  const daysAMonth = Math.max(1, Math.round(input.daysAWeek * WEEKS_A_MONTH));
  const callsADay = input.goal / daysAMonth;
  const yesesADay = callsADay / rates.books;
  const messagesADay = {
    low: Math.ceil(yesesADay / rates.yes.high),
    high: Math.ceil(yesesADay / rates.yes.low),
  };
  const monthly = canSend * daysAMonth * rates.books;
  const pace = {
    low: Math.floor(monthly * rates.yes.low),
    high: Math.floor(monthly * rates.yes.high),
  };
  const fits = messagesADay.high <= canSend ? 'yes' : messagesADay.low <= canSend ? 'maybe' : 'no';
  return { daysAMonth, callsADay, yesesADay, messagesADay, canSend, pace, fits };
}

/** One decimal, without a trailing .0: 0.4, 1.1, 2. */
const short = (n: number) => String(Math.round(n * 10) / 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The math as lines, shown as it's worked. */
export function numbersLines(goal: number, m: NumbersMath): string[] {
  return [
    `${plural(goal, 'call')} a month ÷ ${plural(m.daysAMonth, 'working day')} = ${short(m.callsADay)} calls a day`,
    `${short(m.callsADay)} calls a day ÷ 1 in 3 who say yes book = ${short(m.yesesADay)} yeses a day`,
    `${short(m.yesesADay)} yeses a day ÷ 4 to 8% of first messages = ${m.messagesADay.low} to ${m.messagesADay.high} first messages a day`,
  ];
}

/** What the math says about the goal against Facebook's safe pace, and what helps when it's past it. */
export function numbersVerdict(m: NumbersMath): string {
  const pace = `Facebook’s safe pace is ${m.canSend} first messages a day, about ${m.pace.low} to ${m.pace.high} calls a month.`;
  if (m.fits === 'yes') return `${pace} Your goal fits.`;
  if (m.fits === 'maybe')
    return `${pace} Your goal fits only if your messages do well. ${READY_WORDS.numbersHelps}`;
  return `${pace} Your goal is more than one Facebook account can reach. ${READY_WORDS.numbersHelps}`;
}

// ------------------------------------------------------------------------------------------------- the words

/** Get ready's words: one copy for the web, the phone and the extension. Plain words, curly apostrophes. */
export const READY_WORDS = {
  title: 'Get ready for your best results',
  hint: 'Five things to do before the extension reaches anyone for you. People who do them get more replies and more calls booked.',
  /** On Today, in place of the day's list. */
  card: 'Get ready',
  cardHint: (left: number) =>
    `${plural(left, 'thing')} to do before the extension reaches anyone for you.`,
  ready: 'You’re ready. Start your day when you like.',
  /** Beside Start my day while it's held. */
  stripNotReady: 'Get ready first: the extension reaches nobody until the things below are done.',
  /**
   * Another network's row in the strip while its own profile isn't ready, the one shown being ready: everything else
   * is the same on every network.
   */
  stripNotReadyOn: (name: string) =>
    `Your ${name} profile isn’t ready yet. Show ${name}’s list to finish it under Get ready.`,
  /** Over the replies owed while getting ready. */
  repliesStill: 'People who wrote to you are still answered while you get ready.',
  progress: (done: number, of: number) => `${done} of ${of} done`,
  items: {
    offer: {
      label: 'Your main offer',
      why: 'One clear offer is what people say yes to.',
      go: 'Build your main offer',
    },
    playbook: {
      label: 'A playbook with a niche',
      why: 'Talking to one kind of person makes every message fit them.',
      go: 'Pick your niche',
    },
    profile: {
      label: 'Your profile',
      why: 'People look at your profile before they answer. It shouldn’t put them off.',
      go: 'Check your profile',
    },
    messages: {
      label: 'Your messages',
      why: 'See what goes out in your name before anything does, and that it sounds like you.',
      go: 'See your messages',
      /** OK'd, and the playbook's short video isn't linked yet: an owner or admin adds it. */
      goVideo: 'Add the video',
    },
    numbers: {
      label: 'Your numbers',
      why: 'A goal for the month says how many people to reach each day.',
      go: 'Set your goal',
    },
  } satisfies Record<ReadyItem, { label: string; why: string; go: string; goVideo?: string }>,
  states: {
    done: 'Done',
    todo: 'To do',
    look_again: 'Look again',
    waiting: 'Waiting on your business',
  } satisfies Record<ReadyState, string>,
  left: {
    offer: 'Build your main offer and put it live in Settings → Main offer.',
    offerWaiting:
      'Waiting on your business’s main offer. Ask an owner of this business to finish it under Settings → Main offer.',
    playbookNone: 'Write a playbook and pick its niche on the Playbooks tab.',
    playbookNiche: (name: string) => `Pick a niche for ${name} on the Playbooks tab.`,
    playbookProblem: (name: string) => `Write the niche’s biggest problem in ${name}.`,
    playbookProof: (name: string) =>
      `Add proof to ${name}: a real result from your main offer, or one of its own.`,
    playbookWaiting:
      'Waiting on a playbook with a niche. Ask an owner or admin of this business to pick one on the Playbooks tab.',
    profile: (n: number, platform: Platform = 'facebook') =>
      `${plural(n, 'thing')} left to change on your ${NETWORKS[platform].name} profile.`,
    profileReadOn: (platform: Platform) =>
      `Have the extension read your ${NETWORKS[platform].name} profile. The AI says what to change, and writes your headline and About.`,
    profileRead:
      'Have the extension read your Facebook profile. The AI says what to change, and writes your bio.',
    profileAgain: 'Your main offer changed. Look at your profile again so it still fits.',
    messages: 'See sample messages for your playbook, and OK how they read.',
    messagesFirst:
      'Once your main offer is live and a playbook has its niche, see sample messages for it here.',
    messagesAgain: 'Your main offer changed. Look at your messages again so they still fit.',
    messagesVideo:
      'Link your playbook’s short video: the AI writes its script under Playbooks → Short video.',
    messagesVideoWaiting:
      'Waiting on the playbook’s short video. Ask an owner or admin of this business to link it under Playbooks → Short video.',
    numbers: 'Set a goal for calls booked a month, and see what it takes each day.',
  },
  /** Why Start my day is refused, by the first item left. */
  notReady: {
    offer: 'Your business’s main offer isn’t live yet.',
    playbook: 'No playbook has a niche yet.',
    profile: 'Your profile isn’t ready yet.',
    messages: 'You haven’t OK’d how your messages read yet.',
    numbers: 'Your numbers aren’t set yet.',
  } satisfies Record<ReadyItem, string>,
  /** Your messages' sheet (Get ready, decisions 65 to 67). */
  messages: {
    title: 'Your messages',
    hint: 'What goes out in your name, written by the AI for someone in your playbook’s niche, in your voice. Nobody real: the names are made up. Change how they sound in My settings, or the playbook’s tone, then write them again.',
    write: 'Write samples',
    again: 'Write them again',
    first: 'First message, once they accept',
    video: 'If they say yes: the video',
    link: 'If they want a call: the link',
    noVideo:
      'Your playbook has no short video linked yet. Until it does, a yes gets your booking link next.',
    followUps: (n: number) => `If they go quiet: ${plural(n, 'follow-up')}`,
    checkIn: 'Then once a month: a check-in',
    ok: 'They read right',
    okd: 'OK’d. Your messages read this way.',
    /** Before any are written. */
    none: 'Write samples to see what goes out in your name, before anything does.',
    writing: 'Writing your samples. This takes a few seconds.',
    /** Under the title: the playbook and the main offer's version they're written for. */
    about: (playbook: string, version: number | null) =>
      version ? `${playbook} · written for your main offer, version ${version}` : playbook,
    /** Each follow-up's quiet days. */
    later: (days: number) => `${plural(days, 'day')} later`,
    changeHowMany: 'Change how many',
    /** Written for an earlier version of the main offer. */
    older:
      'These were written for an earlier version of your main offer. Write them again to OK them.',
    /** On the phone, which can't ask the AI for them. */
    onComputer:
      'Write your samples on your computer, under Get ready in HandsFreeOS. Then OK them there or here.',
  },
  changed: (parts: readonly string[]) => `What changed: ${parts.join(', ')}.`,
  profile: {
    title: 'Check your Facebook profile',
    hint: 'People look at it before they answer. It doesn’t have to sell; it just shouldn’t put anyone off. Your computer reads it, the AI says what to change, and you tick each one once it’s right.',
    items: {
      picture: {
        label: 'A clear photo of your face',
        tip: 'Not a logo. People say yes to a person.',
      },
      cover: {
        label: 'A cover that says the result you get people',
        tip: 'One line on an image, like “More booked jobs for roofers”. Not a sales pitch.',
      },
      bio: {
        label: 'A bio that says what you do and for whom',
        tip: 'Facebook’s short bio, up to 101 characters, from your main offer.',
      },
      work: {
        label: 'A work line that names your business',
        tip: 'Under Edit details, add where you work and link your business’s page.',
      },
      featured: {
        label: 'Featured: a result, a review and your booking link',
        tip: 'Pin a post that shows a result, a review, and where to book.',
      },
      posts: {
        label: 'Posts that show who you are, and some proof',
        tip: 'Not only selling: your day, your work, a customer’s win.',
      },
    } satisfies Record<ProfileItem, { label: string; tip: string }>,
    tick: 'It’s done',
    untick: 'Not yet',
    ticked: (n: number, of: number) => `${n} of ${of} ticked`,
    /** Another network's profile: its title, hint and items, LinkedIn's headline and About among them. */
    on: {
      linkedin: {
        title: 'Check your LinkedIn profile',
        hint: 'People look at it before they accept or answer. It doesn’t have to sell; it just shouldn’t put anyone off. Your computer reads it, the AI says what to change, and you tick each one once it’s right.',
        items: {
          picture: {
            label: 'A clear photo of your face',
            tip: 'Not a logo. People say yes to a person.',
          },
          cover: {
            label: 'A banner that says the result you get people',
            tip: 'One line on an image, like “More booked jobs for roofers”. Not a sales pitch.',
          },
          bio: {
            label: 'A headline that says who you help and the result',
            tip: 'LinkedIn’s headline, up to 220 characters, from your main offer. Not only your job title.',
          },
          about: {
            label: 'An About that says who you help and how to book',
            tip: 'Its first lines show before See more: who you help, the result, and how to book a call.',
          },
          work: {
            label: 'Experience that names your business',
            tip: 'Your current position, at your business, with its page linked.',
          },
          featured: {
            label: 'Featured: a result, a review and your booking link',
            tip: 'Feature a post that shows a result, a review, and where to book.',
          },
          posts: {
            label: 'Activity that shows who you are, and some proof',
            tip: 'Not only selling: your work, what you’ve learned, a customer’s win.',
          },
        } satisfies Record<AnyProfileItem, { label: string; tip: string }>,
        about: 'An About to start from',
        aboutHint: 'Paste it under About on your profile, and change anything that isn’t you.',
        aboutCopied: 'Copied. Paste it under About on your LinkedIn profile.',
      },
    } satisfies Partial<Record<Platform, unknown>>,
    offer: 'Your main offer',
    done: 'Done',
  },
  numbers: {
    title: 'Your numbers',
    hint: 'Set how many calls you want booked a month and the days you work. You’ll see what it takes each day.',
    goal: 'Calls booked a month',
    days: 'The days you work',
    sunday: 'Sundays rarely work for outreach. It’s your call.',
    save: 'Save my goal',
    saved: 'Your goal is saved.',
    takes: 'What it takes each day',
    messagesADay: 'first messages a day',
    yesesADay: 'yeses a day',
    fewer: 'Fewer calls',
    more: 'More calls',
    rates:
      'Until you have numbers of your own, this uses what’s typical: 4 to 8% of first messages get a yes, and 1 in 3 yeses book a call.',
    notMessages: 'A friend request is never a message: only first messages count here.',
  },
  numbersHelps:
    'What helps: more friends to message (Reconnect on Today), helpful posts in your groups that bring people to you, and working Saturdays.',
  waitingBusiness: 'You can do your own items meanwhile: your profile and your numbers.',
  /** In the extension's panel. */
  panelGo: 'Get ready in HandsFreeOS',
  panelStill:
    'Still going while you get ready: saving your friends and groups, and replies to people who wrote to you.',
} as const;

/** Your messages: the person OKs how the samples read, against the main offer live now. */
export const MessagesOkInput = z.object({ workspaceId: z.uuid() });
export type MessagesOkInput = z.input<typeof MessagesOkInput>;

/** The samples the AI wrote for a person's Your messages: the worker's alone, after the AI answers. */
export const MessageSamplesSaveInput = z.object({
  workspaceId: z.uuid(),
  /** Whose: the person who asked for them. */
  userId: z.uuid(),
  samples: MessageSamples,
});
export type MessageSamplesSaveInput = z.input<typeof MessageSamplesSaveInput>;

/** One item on a network's profile list, in its words. */
export interface ProfileRowWords {
  readonly item: AnyProfileItem;
  readonly label: string;
  readonly tip: string;
}

/**
 * Get ready's profile part on a network, in its words, for the web and the phone: its title and hint, its items in its
 * order (LinkedIn's About among them), the check's words (LinkedIn's headlines and banner), and the About to start
 * from where the network has one. Facebook's are as they always were.
 */
export function profileWordsOn(platform: Platform = 'facebook') {
  const P = READY_WORDS.profile;
  const on = platform === 'facebook' ? null : P.on[platform];
  const words: Readonly<Partial<Record<AnyProfileItem, { label: string; tip: string }>>> =
    on?.items ?? P.items;
  return {
    ...profileCheckWordsOn(platform),
    title: on?.title ?? P.title,
    hint: on?.hint ?? P.hint,
    items: PROFILE_ITEMS_ON[platform].map((item): ProfileRowWords => ({
      item,
      label: words[item]!.label,
      tip: words[item]!.tip,
    })),
    tick: P.tick,
    untick: P.untick,
    ticked: P.ticked,
    offer: P.offer,
    done: P.done,
    /** The About to start from: null on a network with none. */
    about: on?.about ?? null,
    aboutHint: on?.aboutHint ?? null,
    aboutCopied: on?.aboutCopied ?? null,
  };
}
export type ProfileWords = ReturnType<typeof profileWordsOn>;
