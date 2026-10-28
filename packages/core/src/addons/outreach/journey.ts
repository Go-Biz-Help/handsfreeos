/**
 * How someone the business reached came along (docs/outreach.md decision 103, the owner's picks 20 and 21): on their
 * customer's page, Social Outreach's panel shows where they stand, why, the AI's next step, the groups they were
 * found in, their chat's summary and every step either way (`Journey`, on `outreach.person`); and each group has a
 * page of who was found there and how each turned out (`outreach.group.people`). Where someone stands is the
 * person's own, as the pipeline's is (./stages.ts); so are the steps, but an owner's or admin's are everyone's, a
 * teammate's named, as Results' are.
 * Browser-safe: the web and the phone read these shapes and words.
 */
import { z } from 'zod';
import { TOUCH_KIND_KEYS, TOUCH_STEPS, type TouchKind } from './limits';
import { inNetworkWords, PLATFORM_KEYS, type Platform } from './networks';
import { STAGE_KEYS, STAGES, type Stage } from './stages';

/** The most steps a customer's panel lists, the latest first. */
export const JOURNEY_STEPS_MOST = 50;

/** A step either way: one the extension noted (`TOUCH_KINDS`), their writing back, or a demo booked. */
export const JOURNEY_KINDS = [...TOUCH_KIND_KEYS, 'reply', 'demo'] as const;
export type JourneyKind = TouchKind | 'reply' | 'demo';

const moment = z.iso.datetime();

export const JourneyStep = z.object({
  kind: z.enum(JOURNEY_KINDS),
  /** A message's place: a chat started, or a follow-up. */
  step: z.enum(TOUCH_STEPS).nullable(),
  at: moment,
  /** Taken by the extension on its own, not pressed by the person. */
  auto: z.boolean(),
  /** The teammate whose step it was; null for the person's own. */
  by: z.string().nullable(),
  /** The group they were found in, when the step said. */
  group: z.object({ name: z.string().nullable(), url: z.string() }).nullable(),
  postUrl: z.string().nullable(),
});
export type JourneyStep = z.output<typeof JourneyStep>;

export const JourneyGroup = z.object({
  groupId: z.uuid(),
  name: z.string().nullable(),
  url: z.string(),
});

/** One profile's way so far, as the person sees it. */
export const Journey = z.object({
  /** Where they stand for the person (./stages.ts); null while the person hasn't reached them. */
  stage: z.enum(STAGE_KEYS).nullable(),
  why: z.array(z.string()),
  nextStep: z.string().nullable(),
  /** The groups they were found in, the latest seen first. */
  groups: z.array(JourneyGroup),
  /** The person's chat with them, as the AI read it. */
  chat: z
    .object({
      summary: z.string().nullable(),
      nextStep: z.string().nullable(),
      lastAt: moment,
      lastFromMe: z.boolean(),
    })
    .nullable(),
  steps: z.array(JourneyStep),
  /** Steps left out past `JOURNEY_STEPS_MOST`. */
  moreSteps: z.number().int().min(0),
});
export type Journey = z.output<typeof Journey>;

/** A profile with nothing kept on its way yet. */
export const NO_JOURNEY: Journey = {
  stage: null,
  why: [],
  nextStep: null,
  groups: [],
  chat: null,
  steps: [],
  moreSteps: 0,
};

/** What a step says, in its network's words: "Sent a friend request", "Followed up", "They wrote back". */
export function journeyStepWords(step: JourneyStep, platform: Platform): string {
  const what = (() => {
    switch (step.kind) {
      case 'friend_request':
        // A follow network's request is the follow.
        return platform === 'instagram'
          ? 'Followed them'
          : inNetworkWords('Sent a friend request', platform);
      case 'like':
        return 'Liked a post of theirs';
      case 'comment':
        return 'Commented on a post of theirs';
      case 'message':
        return step.step === 'first_message'
          ? 'Started a chat'
          : step.step === 'follow_up'
            ? 'Followed up'
            : 'Sent a message';
      case 'recommend':
        return 'Recommended them';
      case 'reply':
        return 'They wrote back';
      case 'demo':
        return 'Booked a demo';
    }
  })();
  if (step.kind === 'reply') return what;
  if (step.by) return `${what} (${step.by})`;
  return step.auto ? `${what} (on its own)` : what;
}

// ------------------------------------------------------------------------------------------------- a group's page

/** How many of a group's people its page shows at once. */
export const GROUP_PEOPLE_PAGE = 50;

/** What a group's page lists: everyone found there, one outcome, or those the person hasn't reached yet. */
export const GROUP_PEOPLE_VIEWS = {
  all: 'Everyone',
  not_reached: 'Not reached yet',
  ...STAGES,
} as const;
export type GroupPeopleView = keyof typeof GROUP_PEOPLE_VIEWS;
export const GROUP_PEOPLE_VIEW_KEYS = Object.keys(GROUP_PEOPLE_VIEWS) as [
  GroupPeopleView,
  ...GroupPeopleView[],
];

/** The order a group's page lists them in: how far each came, the furthest first; then who's still to reach. */
export const GROUP_OUTCOME_ORDER: readonly Stage[] = [
  'client',
  'booked',
  'pitched',
  'ready',
  'talking',
  'friends',
  'warming',
  'found',
  'lost',
];

export const GroupPeopleInput = z.object({
  workspaceId: z.uuid(),
  groupId: z.uuid(),
  view: z.enum(GROUP_PEOPLE_VIEW_KEYS).default('all'),
  page: z.number().int().min(1).max(100_000).default(1),
});
export type GroupPeopleInput = z.input<typeof GroupPeopleInput>;

const n = z.number().int().min(0);

export const GroupPeopleOutput = z.object({
  group: z.object({
    groupId: z.uuid(),
    platform: z.enum(PLATFORM_KEYS),
    name: z.string().nullable(),
    url: z.string(),
    members: z.number().int().nullable(),
    /** Whether the person is in it, as the extension last saw. */
    joined: z.boolean().nullable(),
  }),
  counts: z.object({
    all: n,
    not_reached: n,
    found: n,
    warming: n,
    friends: n,
    talking: n,
    ready: n,
    pitched: n,
    booked: n,
    client: n,
    lost: n,
  }),
  people: z.array(
    z.object({
      profileId: z.uuid(),
      /** The customer they are in Contacts, when they're there. */
      personId: z.uuid().nullable(),
      name: z.string(),
      url: z.string(),
      /** An admin or moderator there. */
      runsGroup: z.boolean(),
      /** The part of the group's page they were found on, as it named it ("Members near you"). */
      part: z.string().nullable(),
      /** Where they stand for the person; null while the person hasn't reached them. */
      stage: z.enum(STAGE_KEYS).nullable(),
      why: z.array(z.string()),
      nextStep: z.string().nullable(),
      /** The latest either way; null while nothing's happened. */
      lastAt: moment.nullable(),
    }),
  ),
  page: z.number().int(),
  pages: z.number().int(),
  total: n,
});
export type GroupPeopleOutput = z.output<typeof GroupPeopleOutput>;

/** What a row says of someone the person hasn't reached yet, and whether they run the group. */
export const notReachedWhy = (runsGroup: boolean): string[] =>
  runsGroup ? ['Runs the group', 'Not reached yet'] : ['Not reached yet'];
