/**
 * Social Outreach's playbooks (docs/outreach.md): what a business is after on social media, who it's for, where it
 * looks, the steps it takes, how it sounds, and which of its own tags to use. Nothing about any one business is built
 * in: the owner's own "CRM demos" playbook is the first template, and every business writes its own. Browser-safe:
 * the web's editor, the extension and the server all read it.
 */
import { z } from 'zod';
import { VideoLink, VideoScript } from './video';

/**
 * The social networks it knows (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md). Facebook works; LinkedIn is
 * known so each network's day, limits and warnings can be kept apart, and nothing reads or saves a LinkedIn page yet.
 */
export const PLATFORMS = { facebook: 'Facebook', linkedin: 'LinkedIn' } as const;
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

/**
 * What a conversation does after an answer, besides asking a question further down. The day's list and the AI read
 * it to suggest the next message: a question, the offer, a follow-up later, or nothing more.
 */
export const ANSWER_NEXTS = {
  continue: 'Ask the next question',
  offer: 'Make the offer',
  later: 'Check back later',
  stop: 'Stop here',
} as const;
export type AnswerNext = keyof typeof ANSWER_NEXTS;
export const ANSWER_NEXT_KEYS = Object.keys(ANSWER_NEXTS) as [AnswerNext, ...AnswerNext[]];

/** A question's own name within its playbook, which answers point at: q1, q2… */
const QUESTION_ID = /^q[0-9]{1,3}$/;
const questionId = z.string().regex(QUESTION_ID, 'Pick a question from this playbook.');

/**
 * How fast the steps go (data version 4, docs/outreach.md decision 67): the first message this many days after they
 * accept, then follow-ups until they answer, 5 to 7 of them, each a few quiet days after the last (1 day apart for the
 * first three, then 2, to start), then a check-in once a month.
 */
export const PACE_LIMITS = {
  messageAfterDays: { min: 0, max: 14, start: 1 },
  followUps: { min: 5, max: 7, start: 6 },
  followUpGap: { min: 1, max: 14 },
} as const;
/** The days between follow-ups to start: 1 for the first three, then 2. */
export const followUpGapsFor = (followUps: number): number[] =>
  Array.from({ length: followUps }, (_, i) => (i < 3 ? 1 : 2));
const days = (k: 'messageAfterDays' | 'followUpGap') =>
  z
    .int('Use whole days.')
    .min(PACE_LIMITS[k].min, `Use ${PACE_LIMITS[k].min} days or more.`)
    .max(PACE_LIMITS[k].max, `Use ${PACE_LIMITS[k].max} days or fewer.`);
const followUpCount = z
  .int('Use a whole number.')
  .min(PACE_LIMITS.followUps.min, `Send at least ${PACE_LIMITS.followUps.min} follow-ups.`)
  .max(PACE_LIMITS.followUps.max, `Send at most ${PACE_LIMITS.followUps.max} follow-ups.`);

/** A playbook's pace in full: one saved before data version 4, or left out of a save, has the starting follow-ups. */
export interface Pace {
  readonly messageAfterDays: number;
  readonly followUps: number;
  /** The quiet days before each follow-up: as many as `followUps`. */
  readonly followUpGaps: readonly number[];
}

/**
 * How much a playbook holds: the most characters each part takes, and for a list, the most characters a line takes
 * and how many lines. Saves are held to them, and the builder's boxes stop there.
 */
export const PLAYBOOK_LIMITS = {
  name: 80,
  offer: 300,
  link: 500,
  audience: 500,
  area: 200,
  tone: 500,
  disclaimer: 500,
  signs: { line: 160, most: 20 },
  skip: { line: 160, most: 20 },
  groupWords: { line: 80, most: 20 },
  samples: { line: 1000, most: 10 },
  avoid: { line: 80, most: 30 },
  tags: { line: 40, most: 30 },
  /** A question's words, and how many questions. */
  questions: { line: 200, most: 20 },
  /** An answer's words, and how many answers a question. */
  answers: { line: 80, most: 6 },
  /** How the AI opens a chat (decision 23): a style a line, two or three of them. */
  openerStyles: { line: 300, most: 3 },
  /** First messages the business wrote itself, sent as written with their first name filled in. */
  ownOpeners: { line: 600, most: 3 },
  /** Who in the main offer this playbook is for (data version 3): "Roofers with 2 to 3 crews". */
  niche: 160,
  /** That niche's own biggest problem. */
  problem: 500,
  /** Real results for this niche, a line each: the main offer's, or its own. */
  proof: { line: 300, most: 5 },
  /** Something useful to send someone who never answered: what it is, and its link. */
  usefulWhat: 160,
  usefulLink: 500,
  /** The short video's link (data version 4): Loom, YouTube or Google Drive. */
  videoLink: 500,
} as const;

const line = (max: number, empty = 'Leave out empty lines.') =>
  z.string().trim().min(1, empty).max(max, `Keep each one under ${max} characters.`);
const lines = ({ line: max, most }: { readonly line: number; readonly most: number }) =>
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
const link = (max: number) =>
  z
    .url({
      protocol: /^https?$/,
      error: 'Enter the full address, like https://example.com/book.',
    })
    .max(max)
    .nullable();

/** One answer someone might give: "Not really". It may add one of the playbook's tags, and says what's next. */
export const PlaybookAnswer = z.object({
  label: line(PLAYBOOK_LIMITS.answers.line, 'Write the answer, or take it out.'),
  /** One of the playbook's own tags, or null for none. */
  tag: line(PLAYBOOK_LIMITS.tags.line).nullable(),
  /** What happens after it: one of ANSWER_NEXTS, or a question further down. */
  next: z.union([z.enum(ANSWER_NEXT_KEYS), questionId]),
});
export type PlaybookAnswer = z.output<typeof PlaybookAnswer>;

/**
 * A question to work into a chat, with the answers people give to it. One with no answers is answered in the
 * person's own words, and the conversation carries on to the next question.
 */
export const PlaybookQuestion = z.object({
  id: questionId,
  text: line(PLAYBOOK_LIMITS.questions.line, 'Write the question, or take it out.'),
  answers: z
    .array(PlaybookAnswer)
    .max(PLAYBOOK_LIMITS.answers.most, `Up to ${PLAYBOOK_LIMITS.answers.most} answers a question.`),
});
export type PlaybookQuestion = z.output<typeof PlaybookQuestion>;

/** A playbook's details, as its editor saves them and the extension and the AI read them. */
export const PlaybookDetails = z
  .object({
    goal: z.enum(PLAYBOOK_GOAL_KEYS, { error: 'Pick what the playbook is after.' }),
    /** What's offered, in the business's words: "A 20-minute demo". */
    offer: words(PLAYBOOK_LIMITS.offer),
    /** Where people book or buy: a booking link. */
    link: link(PLAYBOOK_LIMITS.link),
    /**
     * Who in the business's main offer this playbook is for (data version 3, docs/main-offer.md): one niche inside the
     * offer's who, its own biggest problem, and its own proof. Left out of a save, each keeps what's saved, so a phone
     * built before them can't wipe them; null or empty clears one.
     */
    niche: words(PLAYBOOK_LIMITS.niche).optional(),
    problem: words(PLAYBOOK_LIMITS.problem).optional(),
    proof: lines(PLAYBOOK_LIMITS.proof).refine(distinct, 'Each result once.').optional(),
    /** Something useful to send someone who never answered (a guide, a checklist, a video): what, and its link. */
    usefulWhat: words(PLAYBOOK_LIMITS.usefulWhat).optional(),
    usefulLink: link(PLAYBOOK_LIMITS.usefulLink).optional(),
    /**
     * The playbook's short video (data version 4, decision 66): Send the video carries it to someone who said yes,
     * before the booking link. An https link with a real host, as the extension's is (./video.ts). Left out of a save,
     * it keeps what's saved, like the parts version 3 added.
     */
    videoLink: VideoLink.optional(),
    /**
     * The video's script (data version 5, decision 69): what to say and show, part by part, as the AI wrote it and the
     * business changed it (./video.ts). Left out of a save, it keeps what's saved; null clears it.
     */
    videoScript: VideoScript.nullable().optional(),
    /** Who it's for, in plain words. */
    audience: words(PLAYBOOK_LIMITS.audience),
    /** What says someone fits: "Owner" in their intro, posts about missed calls. */
    signs: lines(PLAYBOOK_LIMITS.signs),
    /** Who to leave alone: competitors, group admins, current customers. */
    skip: lines(PLAYBOOK_LIMITS.skip),
    /** Where they are, when it matters: "Austin and Round Rock". */
    area: words(PLAYBOOK_LIMITS.area),
    platforms: z
      .array(z.enum(PLATFORM_KEYS))
      .min(1, 'Pick at least one place.')
      .refine(distinct, 'Each place once.'),
    /** What to search for when looking for groups: "small business owners". */
    groupWords: lines(PLAYBOOK_LIMITS.groupWords),
    steps: z.array(z.enum(PLAYBOOK_STEP_KEYS)).refine(distinct, 'Each step once.'),
    /**
     * How fast (`PACE_LIMITS`): the first message this many days after they accept, then the follow-ups and the
     * quiet days before each. Left out of a save, the follow-ups keep what's saved (./ops/playbooks.ts), so a phone
     * built before data version 4 can't wipe them; `paceOf` reads it in full.
     */
    pace: z
      .object({
        messageAfterDays: days('messageAfterDays'),
        followUps: followUpCount.optional(),
        followUpGaps: z
          .array(days('followUpGap'))
          .min(PACE_LIMITS.followUps.min)
          .max(PACE_LIMITS.followUps.max)
          .optional(),
        /**
         * Before data version 4, the quiet days before a follow-up. Still taken from phones built before it, so their
         * saves go through, and let go: the follow-ups saved stay as they are.
         */
        followUpAfterDays: z.int().min(1).max(30).optional(),
      })
      .refine(
        (p) =>
          p.followUps === undefined ||
          p.followUpGaps === undefined ||
          p.followUpGaps.length === p.followUps,
        { error: 'Say how many days before each follow-up.', path: ['followUpGaps'] },
      ),
    /** How it sounds: "Friendly, one owner to another. No hard sell." */
    tone: words(PLAYBOOK_LIMITS.tone),
    /** A few of the business's own messages, for the AI to sound like. */
    samples: lines(PLAYBOOK_LIMITS.samples),
    /**
     * How first messages open (decision 23): styles the AI writes in ("Ask one curious question about their
     * business"), and the business's own openers, sent as written. Drafts take turns with them (./openers.ts), so
     * the results card can say which work. A playbook saved before them has none.
     */
    openerStyles: lines(PLAYBOOK_LIMITS.openerStyles)
      .refine(distinct, 'Each style once.')
      .default([]),
    ownOpeners: lines(PLAYBOOK_LIMITS.ownOpeners).refine(distinct, 'Each opener once.').default([]),
    /**
     * The conversation, in the order it's asked: "Do you use a CRM?", with the answers people give and what each
     * one leads to.
     */
    questions: z
      .array(PlaybookQuestion)
      .max(PLAYBOOK_LIMITS.questions.most, `Up to ${PLAYBOOK_LIMITS.questions.most} questions.`),
    /** Words never to use. */
    avoid: lines(PLAYBOOK_LIMITS.avoid),
    /** Anything every message must say, when the business has to. */
    disclaimer: words(PLAYBOOK_LIMITS.disclaimer),
    /** The business's own tags the AI may put on people. Only these, never others. */
    tags: lines(PLAYBOOK_LIMITS.tags).refine(distinct, 'Each tag once.'),
  })
  .superRefine((d, ctx) => {
    const tags = new Set(d.tags.map((t) => t.toLowerCase()));
    // Where each question is asked: the first with its name, so a second one is the one refused.
    const at = new Map<string, number>();
    d.questions.forEach((q, i) => at.set(q.id, at.get(q.id) ?? i));
    d.questions.forEach((q, i) => {
      if (at.get(q.id) !== i)
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'id'],
          message: 'Each question once.',
        });
      if (!distinct(q.answers.map((a) => a.label)))
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'answers'],
          message: 'Each answer once.',
        });
      q.answers.forEach((a, j) => {
        if (a.tag !== null && !tags.has(a.tag.toLowerCase()))
          ctx.addIssue({
            code: 'custom',
            path: ['questions', i, 'answers', j, 'tag'],
            message: `“${a.tag}” isn’t one of this playbook’s tags. Add it under Tags, or pick another.`,
          });
        if (a.next in ANSWER_NEXTS) return;
        const to = at.get(a.next);
        if (to === undefined)
          ctx.addIssue({
            code: 'custom',
            path: ['questions', i, 'answers', j, 'next'],
            message: 'That question isn’t in this playbook anymore. Pick what happens next again.',
          });
        else if (to <= i)
          ctx.addIssue({
            code: 'custom',
            path: ['questions', i, 'answers', j, 'next'],
            message: 'An answer can only lead to a question further down.',
          });
      });
    });
  });
export type PlaybookDetails = z.output<typeof PlaybookDetails>;

/** A playbook with nothing filled in but Facebook. */
export const blankPlaybook = (): PlaybookDetails => ({
  goal: 'demo',
  offer: null,
  link: null,
  niche: null,
  problem: null,
  proof: [],
  usefulWhat: null,
  usefulLink: null,
  videoLink: null,
  videoScript: null,
  audience: null,
  signs: [],
  skip: [],
  area: null,
  platforms: ['facebook'],
  groupWords: [],
  steps: ['connect', 'engage', 'message', 'follow_up'],
  pace: {
    messageAfterDays: PACE_LIMITS.messageAfterDays.start,
    followUps: PACE_LIMITS.followUps.start,
    followUpGaps: followUpGapsFor(PACE_LIMITS.followUps.start),
  },
  tone: null,
  samples: [],
  openerStyles: [],
  ownOpeners: [],
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
      niche: 'Owners of home service businesses with 2 to 10 people',
      problem:
        'Leads slip through the cracks because follow-ups live in their head, a notebook or a spreadsheet.',
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
      openerStyles: [
        'Ask one curious question about their business, from something real on their profile or posts.',
        'Mention the group you’re both in, then ask how business is going.',
        'Say one thing you genuinely liked about their page or a post, then ask a light question.',
      ],
      questions: [
        {
          id: 'q1',
          text: 'Do you use a CRM?',
          answers: [
            { label: 'Yes', tag: 'Uses a CRM', next: 'continue' },
            { label: 'No', tag: null, next: 'q4' },
            { label: 'What’s a CRM?', tag: null, next: 'q4' },
            { label: 'I don’t run a business', tag: 'Not a fit', next: 'stop' },
          ],
        },
        { id: 'q2', text: 'Which one?', answers: [] },
        {
          id: 'q3',
          text: 'Is it doing what you need?',
          answers: [
            { label: 'Yes, it’s fine', tag: 'Happy with CRM', next: 'later' },
            { label: 'Not really', tag: 'Unhappy with CRM', next: 'offer' },
            { label: 'It’s too much work', tag: 'Unhappy with CRM', next: 'offer' },
          ],
        },
        {
          id: 'q4',
          text: 'How do you keep track of follow-ups now?',
          answers: [
            { label: 'A spreadsheet or notes', tag: null, next: 'offer' },
            { label: 'I don’t, really', tag: null, next: 'offer' },
            { label: 'Someone on my team does it', tag: null, next: 'later' },
          ],
        },
      ],
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

/** The parts data version 3 added: a save that leaves one out keeps what's saved (./ops/playbooks.ts). */
export const PLAYBOOK_V3_KEYS = ['niche', 'problem', 'proof', 'usefulWhat', 'usefulLink'] as const;
/** The parts data versions 4 and 5 added, kept the same way. */
export const PLAYBOOK_V4_KEYS = ['videoLink'] as const;
export const PLAYBOOK_V5_KEYS = ['videoScript'] as const;
/** What a save that leaves a part out keeps. */
export const PLAYBOOK_KEPT_KEYS = [
  ...PLAYBOOK_V3_KEYS,
  ...PLAYBOOK_V4_KEYS,
  ...PLAYBOOK_V5_KEYS,
] as const;

/** The days before follow-ups when they were one number (before data version 4) and the business changed it. */
const OLD_FOLLOW_UP_START = 3;

/** A pace in full, as saved in any version: one with no follow-ups yet gets the starting ones. */
export function paceOf(pace: unknown): Pace {
  const p = (typeof pace === 'object' && pace !== null ? pace : {}) as Record<string, unknown>;
  const after = typeof p['messageAfterDays'] === 'number' ? p['messageAfterDays'] : null;
  const count =
    typeof p['followUps'] === 'number'
      ? Math.min(PACE_LIMITS.followUps.max, Math.max(PACE_LIMITS.followUps.min, p['followUps']))
      : PACE_LIMITS.followUps.start;
  const gaps = Array.isArray(p['followUpGaps'])
    ? (p['followUpGaps'] as unknown[]).filter((g): g is number => typeof g === 'number')
    : null;
  // Before data version 4, one number: the quiet days before each follow-up. A business that changed it keeps that
  // spacing; one left at the start gets the new one.
  const old = typeof p['followUpAfterDays'] === 'number' ? p['followUpAfterDays'] : null;
  const spaced =
    gaps && gaps.length === count
      ? gaps
      : old !== null && old !== OLD_FOLLOW_UP_START
        ? Array.from({ length: count }, () => Math.min(PACE_LIMITS.followUpGap.max, old))
        : followUpGapsFor(count);
  return {
    messageAfterDays: after ?? PACE_LIMITS.messageAfterDays.start,
    followUps: count,
    followUpGaps: spaced,
  };
}

/**
 * A playbook's details as an earlier version saved them, in today's shape. Before data version 2 its questions were
 * lines of words with no answers, and it had no pace; before 3, no niche, problem, proof or something useful to send;
 * before 4, its follow-ups were one number of quiet days (`paceOf` moves it) and it had no video link; before 5, no
 * video script. Anything else passes through for the schema to judge.
 */
export function upgradePlaybookDetails(stored: unknown): unknown {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return stored;
  const d = stored as Record<string, unknown>;
  const old = Array.isArray(d['questions']) && d['questions'].some((q) => typeof q === 'string');
  const beforeKeys = PLAYBOOK_KEPT_KEYS.some((k) => d[k] === undefined);
  const pace = d['pace'] as Record<string, unknown> | undefined;
  const before4 = pace === undefined || pace['followUps'] === undefined;
  if (!old && !before4 && !beforeKeys) return stored;
  const blank = blankPlaybook();
  return {
    ...Object.fromEntries(PLAYBOOK_KEPT_KEYS.map((k) => [k, blank[k]])),
    ...d,
    questions: old
      ? (d['questions'] as unknown[]).map((q, i) =>
          typeof q === 'string' ? { id: `q${i + 1}`, text: q, answers: [] } : q,
        )
      : d['questions'],
    pace: pace === undefined ? blank.pace : paceOf(pace),
  };
}

/** A name for a new question: one more than the highest so far. */
export function nextQuestionId(questions: readonly Pick<PlaybookQuestion, 'id'>[]): string {
  const most = Math.max(0, ...questions.map((q) => Number(q.id.slice(1)) || 0));
  return `q${most + 1}`;
}

/**
 * The questions named q1, q2… in the order they're asked, with every answer still leading where it did. Saving
 * does this, so names stay short however often questions come and go.
 */
export function renumberQuestions(questions: readonly PlaybookQuestion[]): PlaybookQuestion[] {
  const name = new Map(questions.map((q, i) => [q.id, `q${i + 1}`]));
  return questions.map((q, i) => ({
    ...q,
    id: `q${i + 1}`,
    answers: q.answers.map((a) => ({ ...a, next: name.get(a.next) ?? a.next })),
  }));
}

/** What an answer leads to, in words: "Make the offer", or "Ask “Which one?”". */
export function answerNextLabel(
  next: string,
  questions: readonly Pick<PlaybookQuestion, 'id' | 'text'>[],
): string {
  if (next in ANSWER_NEXTS) return ANSWER_NEXTS[next as AnswerNext];
  const q = questions.find((x) => x.id === next);
  return q ? `Ask “${q.text}”` : 'A question that isn’t here anymore';
}

/** Words the playbook builder offers to tap, so nobody starts from an empty box. */
export const PLAYBOOK_SUGGESTIONS = {
  offers: {
    demo: ['A 20-minute demo', 'A free demo'],
    consult: ['A free 15-minute consultation', 'A free consultation'],
    estimate: ['A free estimate', 'A free quote'],
    appointment: ['An appointment', 'A first visit'],
    call: ['A quick call', 'A 15-minute call'],
    sale: ['A special offer', 'A free trial'],
    recruit: ['A quick chat about the job'],
    partner: ['A call about working together'],
    community: ['An invite to join'],
  } satisfies Record<PlaybookGoal, readonly string[]>,
  signs: [
    '“Owner”, “Founder” or “CEO” in their intro',
    'Runs a business Page',
    'Posts about their business',
    'Lives or works in your area',
    'Asked for a recommendation',
    'Likes or comments on your posts',
  ],
  skip: [
    'Friends and family',
    'Current customers',
    'Competitors',
    'Group admins and moderators',
    'People selling the same thing',
    'Anyone who said no',
  ],
  tone: [
    'Friendly',
    'Curious',
    'Warm',
    'Direct',
    'Professional',
    'Casual',
    'Short messages',
    'No hard sell',
  ],
  avoid: ['Act now', 'Limited time', 'Guaranteed', 'Buy now', 'Click here'],
  openerStyles: [
    'Ask one curious question about their business, from something real on their profile or posts.',
    'Mention the group you’re both in, then ask how business is going.',
    'Say one thing you genuinely liked about their page or a post, then ask a light question.',
    'Congratulate them on something they posted lately, then ask about it.',
    'Ask for their advice on something they clearly know about.',
  ],
  tags: ['Prospect', 'Interested', 'Not interested', 'Not a fit', 'Friend or family', 'Customer'],
  answers: ['Yes', 'No', 'Not sure', 'Not really', 'Not now'],
} as const;

// ---- The operations' shapes (./ops/playbooks.ts), here so the phone can name them ----

/** A playbook as the operations give it. */
export const Playbook = z.object({
  id: z.uuid(),
  name: z.string(),
  template: z.string().nullable(),
  details: PlaybookDetails,
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Playbook = z.output<typeof Playbook>;

export const PlaybookListInput = z.object({ workspaceId: z.uuid() });
export const PlaybookListOutput = z.object({ playbooks: z.array(Playbook) });
export type PlaybookListOutput = z.output<typeof PlaybookListOutput>;

const playbookName = z
  .string()
  .trim()
  .min(1, 'Give the playbook a name.')
  .max(PLAYBOOK_LIMITS.name, `Keep the name under ${PLAYBOOK_LIMITS.name} characters.`);

export const PlaybookSaveInput = z.object({
  workspaceId: z.uuid(),
  /** The playbook to change. Left out: a new one. */
  playbookId: z.uuid().optional(),
  name: playbookName,
  /** For a new one, the template it started from. */
  template: z.enum(PLAYBOOK_TEMPLATE_KEYS).nullable().optional(),
  details: PlaybookDetails,
});
export type PlaybookSaveInput = z.input<typeof PlaybookSaveInput>;

export const PlaybookArchiveInput = z.object({
  workspaceId: z.uuid(),
  playbookId: z.uuid(),
  archived: z.boolean(),
});
export type PlaybookArchiveInput = z.input<typeof PlaybookArchiveInput>;
