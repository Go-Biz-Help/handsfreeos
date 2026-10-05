/**
 * Social Outreach's playbooks (docs/outreach.md): what a business is after on social media, who it's for, where it
 * looks, the steps it takes, how it sounds, and which of its own tags to use. Nothing about any one business is built
 * in: the owner's own "CRM demos" playbook is the first template, and every business writes its own. Browser-safe:
 * the web's editor, the extension and the server all read it.
 */
import { z } from 'zod';

/** The social networks it works on. Facebook first; LinkedIn and Instagram later. */
export const PLATFORMS = { facebook: 'Facebook' } as const;
export type Platform = keyof typeof PLATFORMS;
export const PLATFORM_KEYS = Object.keys(PLATFORMS) as [Platform, ...Platform[]];

/** What a playbook is after. */
export const PLAYBOOK_GOALS = {
  demo: 'Book a demo',
  consult: 'Book a consultation',
  estimate: 'Book an estimate',
  appointment: 'Book an appointment',
  call: 'Book a call',
  sale: 'Make a sale',
  recruit: 'Find people to hire',
  partner: 'Find partners',
  community: 'Grow a community',
} as const;
export type PlaybookGoal = keyof typeof PLAYBOOK_GOALS;
export const PLAYBOOK_GOAL_KEYS = Object.keys(PLAYBOOK_GOALS) as [PlaybookGoal, ...PlaybookGoal[]];

/** The steps a playbook takes with people, in the order it takes them. */
export const PLAYBOOK_STEPS = {
  connect: { label: 'Send friend requests', hint: 'To people who fit, found in your groups.' },
  engage: { label: 'Warm up', hint: 'Like and comment on their posts before writing to them.' },
  message: {
    label: 'Open a chat',
    hint: 'A first message once they accept, about something real from their posts.',
  },
  follow_up: { label: 'Follow up', hint: 'When a chat goes quiet.' },
  answer: {
    label: 'Answer requests',
    hint: 'Reply to “can anyone recommend…” posts in your groups.',
  },
  post: { label: 'Post in groups', hint: 'A question, a tip or a poll. Nothing salesy.' },
} as const;
export type PlaybookStep = keyof typeof PLAYBOOK_STEPS;
export const PLAYBOOK_STEP_KEYS = Object.keys(PLAYBOOK_STEPS) as [PlaybookStep, ...PlaybookStep[]];

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Leave out empty lines.')
    .max(max, `Keep each one under ${max} characters.`);
const lines = (max: number, most: number) =>
  z.array(line(max)).max(most, `Up to ${most} of these.`);
/** Words, or null for none: an empty answer is sent as null. */
const words = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Leave it empty instead.')
    .max(max, `Keep it under ${max} characters.`)
    .nullable();
const distinct = <T extends string>(list: readonly T[]) =>
  new Set(list.map((v) => v.toLowerCase())).size === list.length;

/** A playbook's details, as its editor saves them and the extension and the AI read them. */
export const PlaybookDetails = z.object({
  goal: z.enum(PLAYBOOK_GOAL_KEYS, { error: 'Pick what the playbook is after.' }),
  /** What's offered, in the business's words: "A 20-minute demo". */
  offer: words(300),
  /** Where people book or buy: a booking link. */
  link: z
    .url({ protocol: /^https?$/, error: 'Enter the full address, like https://example.com/book.' })
    .max(500)
    .nullable(),
  /** Who it's for, in plain words. */
  audience: words(500),
  /** What says someone fits: "Owner" in their intro, posts about missed calls. */
  signs: lines(160, 20),
  /** Who to leave alone: competitors, group admins, current customers. */
  skip: lines(160, 20),
  /** Where they are, when it matters: "Austin and Round Rock". */
  area: words(200),
  platforms: z
    .array(z.enum(PLATFORM_KEYS))
    .min(1, 'Pick at least one place.')
    .refine(distinct, 'Each place once.'),
  /** What to search for when looking for groups: "small business owners". */
  groupWords: lines(80, 20),
  steps: z.array(z.enum(PLAYBOOK_STEP_KEYS)).refine(distinct, 'Each step once.'),
  /** How it sounds: "Friendly, one owner to another. No hard sell." */
  tone: words(500),
  /** A few of the business's own messages, for the AI to sound like. */
  samples: lines(1000, 10),
  /** Questions to work into a chat: "Do you use a CRM?" */
  questions: lines(200, 10),
  /** Words never to use. */
  avoid: lines(80, 30),
  /** Anything every message must say, when the business has to. */
  disclaimer: words(500),
  /** The business's own tags the AI may put on people. Only these, never others. */
  tags: lines(40, 30).refine(distinct, 'Each tag once.'),
});
export type PlaybookDetails = z.output<typeof PlaybookDetails>;

/** A playbook with nothing filled in but Facebook. */
export const blankPlaybook = (): PlaybookDetails => ({
  goal: 'demo',
  offer: null,
  link: null,
  audience: null,
  signs: [],
  skip: [],
  area: null,
  platforms: ['facebook'],
  groupWords: [],
  steps: ['connect', 'engage', 'message', 'follow_up'],
  tone: null,
  samples: [],
  questions: [],
  avoid: [],
  disclaimer: null,
  tags: [],
});

export interface PlaybookTemplate {
  readonly name: string;
  /** One line, for the list of templates. */
  readonly summary: string;
  readonly details: PlaybookDetails;
}

const TEMPLATES = {
  crm_demos: {
    name: 'CRM demos',
    summary: 'Find small business owners, ask about the CRM they use, and offer a demo.',
    details: {
      ...blankPlaybook(),
      goal: 'demo',
      offer: 'A demo',
      audience: 'Owners of small businesses that have customers to follow up with.',
      signs: [
        '“Owner”, “Founder” or “CEO” in their intro',
        'Runs a business Page',
        'Posts about leads, missed calls, follow-ups or scheduling',
      ],
      skip: [
        'Competitors',
        'People selling CRMs',
        'Group admins and moderators',
        'Current customers',
      ],
      groupWords: ['small business owners', 'business owners'],
      steps: ['connect', 'engage', 'message', 'follow_up'],
      tone: 'Friendly and curious, one owner to another. Short messages, no hard sell.',
      questions: ['Do you use a CRM?', 'Which one?', 'Is it doing what you need?'],
      tags: [
        'Business owner',
        'Uses a CRM',
        'Happy with CRM',
        'Unhappy with CRM',
        'Wants a demo',
        'Not a fit',
        'Friend or family',
      ],
    },
  },
} satisfies Record<string, PlaybookTemplate>;
export type PlaybookTemplateKey = keyof typeof TEMPLATES;

/** Where a new playbook can start. The owner's own is first; templates for other kinds of business follow. */
export const PLAYBOOK_TEMPLATES: Readonly<Record<PlaybookTemplateKey, PlaybookTemplate>> =
  TEMPLATES;
export const PLAYBOOK_TEMPLATE_KEYS = Object.keys(PLAYBOOK_TEMPLATES) as [
  PlaybookTemplateKey,
  ...PlaybookTemplateKey[],
];
