/**
 * Stages, and the moment to pitch (docs/outreach.md, decision 47): where each person the person reached stands, worked
 * out each time from what HandsFreeOS knows, never kept as a column of its own:
 *
 * - **Booked**: a demo through their link, or marked booked (./demos.ts).
 * - **Not a fit**: marked so by the person, or the AI's read of their chat said no (`not_interested`). "Not
 *   interested" ends outreach for good (the plan): nothing on Today reaches them again but a reply they're owed, until
 *   the person puts them back in play.
 * - **Pitched**: a pitch message went, a pitch draft was copied, or the person marked it.
 * - **Ready to pitch**: the AI's read of their chat says the playbook's questions are answered well enough to offer
 *   (`ready`), or the person marked it. Today offers **Pitch**, with drafts that carry the person's demo link.
 * - **Talking**: they've written to the person.
 * - **Friends**: they're the person's friend on Facebook.
 * - **Warming up**: the person liked or commented on something of theirs, or sent them a friend request.
 * - **Found**: anyone else the person reached, or the AI found a fit among their friends (./checks.ts).
 *
 * Each person's own, like their chats. Browser-safe: the web, the phone and the worker read these words and shapes.
 */
import { z } from 'zod';
import { CHECK_VERDICT_KEYS } from './checks';
import { PLATFORM_KEYS } from './networks';

export const STAGES = {
  found: 'Found',
  warming: 'Warming up',
  friends: 'Friends',
  talking: 'Talking',
  ready: 'Ready to pitch',
  pitched: 'Pitched',
  booked: 'Booked',
  lost: 'Not a fit',
} as const;
export type Stage = keyof typeof STAGES;
export const STAGE_KEYS = Object.keys(STAGES) as [Stage, ...Stage[]];

/** What the pipeline lists: everyone still in play, in the order worth the person's time, or one stage. */
export const STAGE_VIEWS = { all: 'All in play', ...STAGES } as const;
export type StageView = keyof typeof STAGE_VIEWS;
export const STAGE_VIEW_KEYS = Object.keys(STAGE_VIEWS) as [StageView, ...StageView[]];

/** The order "All in play" lists them in: who to act on first. Not a fit is left out. */
export const STAGE_ORDER: readonly Stage[] = [
  'ready',
  'talking',
  'pitched',
  'friends',
  'warming',
  'found',
  'booked',
];

/** The AI's read of whether it's time to offer: from a chat (./chat-read.ts). */
export const PITCH_READS = ['ready', 'not_yet', 'not_interested'] as const;
export type PitchRead = (typeof PITCH_READS)[number];

/** What the person can say about someone: ready to pitch, pitched, not a fit, or back in play (clears them). */
export const STAGE_MARKS = {
  ready: 'Ready to pitch',
  pitched: 'Pitched',
  lost: 'Not a fit',
  open: 'Back in play',
} as const;
export type StageMark = keyof typeof STAGE_MARKS;
export const STAGE_MARK_KEYS = Object.keys(STAGE_MARKS) as [StageMark, ...StageMark[]];

/** How long a why may be: the AI's, or the person's own words for not a fit. */
export const STAGE_WHY_MOST = 160;

/** What the marks a person can press are, for someone at a stage: never the one they're at. */
export function marksFor(stage: Stage): StageMark[] {
  switch (stage) {
    case 'ready':
      return ['pitched', 'lost'];
    case 'pitched':
      return ['lost', 'open'];
    case 'lost':
      return ['open'];
    case 'booked':
      return [];
    default:
      return ['ready', 'pitched', 'lost'];
  }
}

export const StageMarkInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  mark: z.enum(STAGE_MARK_KEYS),
  /** For not a fit: why, in the person's words. */
  why: z.string().trim().min(1).max(STAGE_WHY_MOST).nullable().default(null),
});
export type StageMarkInput = z.input<typeof StageMarkInput>;
export const StageMarkOutput = z.object({ profileId: z.uuid(), stage: z.enum(STAGE_KEYS) });
export type StageMarkOutput = z.output<typeof StageMarkOutput>;

export const STAGES_PAGE = 50;

export const StagesInput = z.object({
  workspaceId: z.uuid(),
  view: z.enum(STAGE_VIEW_KEYS).default('all'),
  /** Part of a name. */
  search: z.string().trim().max(100).optional(),
  page: z.number().int().min(1).max(100_000).default(1),
  /** Only the people on one network, counts too; every network's when left out. */
  platform: z.enum(PLATFORM_KEYS).optional(),
});
export type StagesInput = z.input<typeof StagesInput>;

const n = z.number().int().min(0);

export const StagesOutput = z.object({
  counts: z.object({
    all: n,
    found: n,
    warming: n,
    friends: n,
    talking: n,
    ready: n,
    pitched: n,
    booked: n,
    lost: n,
  }),
  people: z.array(
    z.object({
      profileId: z.uuid(),
      /** The customer they are in Contacts, when they're there. */
      personId: z.uuid().nullable(),
      name: z.string(),
      url: z.string(),
      /** The network their profile is on: each row shows it by name. */
      platform: z.enum(PLATFORM_KEYS).default('facebook'),
      stage: z.enum(STAGE_KEYS),
      /** Why they're at it: "Asked how to book", "They wrote 2 days ago", "Found in Austin Small Business Owners". */
      why: z.array(z.string()),
      /** The AI's next step for them, from their chat or its check of them. */
      nextStep: z.string().nullable(),
      /** The latest either way: a step, a message or a reply seen. */
      lastAt: z.iso.datetime().nullable(),
      /** Their chat, to open in Messenger. */
      threadKey: z.string().nullable(),
      /** Marked by the person, rather than worked out. */
      marked: z.boolean(),
      /** The person marked them as having booked a demo. */
      demoBooked: z.boolean(),
      /** What the AI made of them when checked (decision 46), for Research on the row (decision 46a). */
      check: z
        .object({
          verdict: z.enum(CHECK_VERDICT_KEYS),
          playbookName: z.string().nullable(),
          why: z.array(z.string()),
        })
        .nullable(),
    }),
  ),
  page: n.min(1),
  pages: n.min(1),
  total: n,
});
export type StagesOutput = z.output<typeof StagesOutput>;

/** What a mark says once it's saved. */
export function markedWords(name: string, mark: StageMark): string {
  switch (mark) {
    case 'ready':
      return `${name} is ready to pitch. Today has them, with drafts.`;
    case 'pitched':
      return `${name} is marked pitched.`;
    case 'lost':
      return `${name} is marked not a fit. Nothing on Today reaches them again but a reply.`;
    case 'open':
      return `${name} is back in play.`;
  }
}

/** The pipeline's words, the same on the web and the phone. */
export const STAGE_WORDS = {
  title: 'Pipeline',
  about:
    'Everyone you’ve reached, by where they stand. Worked out from what HandsFreeOS knows; mark someone ready to pitch, pitched or not a fit when you know better.',
  empty: {
    title: 'Nobody here yet',
    body: 'People you reach on Facebook, and the good fits found among your friends, show here by where they stand.',
  },
  lostNote: 'Not a fit ends outreach to them: nothing on Today reaches them again but a reply.',
  aiSaid: 'The AI read it so',
} as const;
