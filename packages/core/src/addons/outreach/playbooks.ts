/**
 * Social Outreach's playbooks (docs/outreach.md): what a business is after on social media, who it's for, where it
 * looks, the steps it takes, how it sounds, and which of its own tags to use. Nothing about any one business is built
 * in: the owner's own "CRM demos" playbook is the first template, ready-made ones for real estate agents, home services
 * and coaches follow (decision 117), and every business makes one its own. Browser-safe: the web's editor, the
 * extension and the server all read it.
 */
import { z } from 'zod';
import { PLATFORM_KEYS, PLATFORMS, type Platform, WORKING_PLATFORMS } from './networks';
import { VideoLink, VideoScript } from './video';

/** The social networks it knows, each with its kit in ./networks.ts. */
export { PLATFORM_KEYS, PLATFORMS, type Platform };

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

/**
 * The goal that makes a playbook a partner playbook (decision 81, ./partners.ts): its audience, niche, area, signs and
 * skip words say whose audience it wants, the business's customers, and it looks for people who have them. Every step
 * for customers leaves it out.
 */
export const PARTNER_GOAL = 'partner' satisfies PlaybookGoal;
export const forPartners = (details: Pick<PlaybookDetails, 'goal'>): boolean =>
  details.goal === PARTNER_GOAL;

/**
 * The words the AI writes for each network a customers' playbook runs on (data version 8, docs/outreach.md decision
 * 92), and the part each goes in: the hashtags Instagram looks at, the phrases LinkedIn's post search goes with, and
 * the kinds of business Alignable's search looks for. Never on a partner playbook.
 */
export const FIND_WORDS_PARTS = {
  instagram: 'hashtags',
  linkedin: 'postSearches',
  alignable: 'businessKinds',
} as const satisfies Partial<Record<Platform, string>>;
export type WordsPlatform = keyof typeof FIND_WORDS_PARTS;
export type FindWordsPart = (typeof FIND_WORDS_PARTS)[WordsPlatform];
export const WORDS_PLATFORM_KEYS = Object.keys(FIND_WORDS_PARTS) as [
  WordsPlatform,
  ...WordsPlatform[],
];
/** How many of each network's words a day's look takes, in turn (decision 92): 5 hashtags, 5 phrases, 3 kinds. */
export const FIND_WORDS_PER_DAY: Readonly<Record<WordsPlatform, number>> = {
  instagram: 5,
  linkedin: 5,
  alignable: 3,
};

/** The kinds of partner a partner playbook looks for: all three unless it says (./partners.ts). */
export const PARTNER_KINDS = {
  group_admin: 'Group admin',
  creator: 'Creator',
  business: 'Business',
} as const;
export type PartnerKind = keyof typeof PARTNER_KINDS;
export const PARTNER_KIND_KEYS = Object.keys(PARTNER_KINDS) as [PartnerKind, ...PartnerKind[]];

/** The steps a playbook takes with people, in the order it takes them. */
export const PLAYBOOK_STEPS = {
  connect: {
    label: 'Send friend requests',
    hint: 'To people who fit, found in your groups or by a search.',
  },
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
  /** Hashtags Instagram looks at for this playbook (data version 8), each without its #: "austinroofing". */
  hashtags: { line: 40, most: 30 },
  /** Words LinkedIn's post search goes with: "missed calls". */
  postSearches: { line: 60, most: 12 },
  /** Kinds of business Alignable's search looks for: "Roofing Contractor". */
  businessKinds: { line: 80, most: 12 },
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
    /**
     * The kinds of partner a partner playbook looks for (data version 6, decision 81): group admins, creators, and
     * businesses with the same customers. Left out of a save, it keeps what's saved, like the parts version 3 added.
     */
    partnerKinds: z
      .array(z.enum(PARTNER_KIND_KEYS))
      .min(1, 'Pick at least one kind of partner.')
      .refine(distinct, 'Each kind once.')
      .optional(),
    /**
     * That it runs on its own networks only (data version 7, the Instagram and Alignable plan's "a playbook's networks
     * count"). One saved before ran on every network that worked then, so the upgrade puts Facebook and LinkedIn on a
     * customers' playbook, as it ran. Left out of a save, it keeps what's saved.
     */
    onItsNetworks: z.literal(true).optional(),
    /**
     * Each network's own words (data version 8, decision 92), written by the AI once from the niche, who it's for and
     * their problem, and the person's to change: the hashtags Instagram looks at (each without its #, as
     * `hashtagOf` makes them on a save), the phrases LinkedIn's post search goes with, and the kinds of business
     * Alignable's search looks for. Only a customers' playbook's are read. Left out of a save, each keeps what's
     * saved; an empty list, once the AI wrote it, means that network looks at nothing for the playbook.
     */
    hashtags: lines(PLAYBOOK_LIMITS.hashtags).refine(distinct, 'Each hashtag once.').optional(),
    postSearches: lines(PLAYBOOK_LIMITS.postSearches)
      .refine(distinct, 'Each search once.')
      .optional(),
    businessKinds: lines(PLAYBOOK_LIMITS.businessKinds)
      .refine(distinct, 'Each kind of business once.')
      .optional(),
    /**
     * That the business works with this playbook's clients online (decision 92): Alignable then searches anywhere,
     * not only the person's own town. Null till the AI or the person says; null reads as local.
     */
    worksOnline: z.boolean().nullable().optional(),
    /**
     * The networks whose words the AI has written (decision 92), so it writes each list once and never over the
     * person's. The server's alone: a save always keeps what's saved (./ops/playbooks.ts).
     */
    wordsWritten: z
      .array(z.enum(WORDS_PLATFORM_KEYS))
      .refine(distinct, 'Each network once.')
      .optional(),
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
     * How first messages open (decision 23): styles the AI words its one short question in ("Say it could make them
     * more money while saving them time", decision 137), and the business's own openers, sent as written. Drafts take
     * turns with them (./openers.ts), so the results card can say which work. A playbook saved before them has none.
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
  partnerKinds: [...PARTNER_KIND_KEYS],
  onItsNetworks: true,
  hashtags: [],
  postSearches: [],
  businessKinds: [],
  worksOnline: null,
  wordsWritten: [],
  audience: null,
  signs: [],
  skip: [],
  area: null,
  // Every network that works, as every playbook ran before data version 7; the person unticks any.
  platforms: [...WORKING_PLATFORMS],
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
        'Say it could make them more money while saving them time.',
        'Say it could stop leads slipping through the cracks.',
        'Say it could give them their evenings back.',
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
  /**
   * Ready-made playbooks (docs/outreach.md, decision 117), for the kinds of business that use the add-on most: each
   * with its questions, openers and the words its networks look with, written for anywhere, so the person adds their
   * area, offer and link. Their words are the person's from the start, so the AI never writes over them.
   */
  real_estate: {
    name: 'Home buyers and sellers',
    summary:
      'For real estate agents. Find people getting ready to buy or sell, ask about their plans, and offer a consultation.',
    details: {
      ...blankPlaybook(),
      goal: 'consult',
      offer: 'A free 20-minute consultation about buying or selling',
      niche: 'People getting ready to buy or sell a home in your area',
      problem:
        'Buying or selling feels risky and confusing, and they don’t know who to trust or where to start.',
      audience: 'People in your area thinking about buying or selling a home in the next year.',
      signs: [
        'Posts about moving, house hunting or selling their home',
        'Asks a group to recommend a realtor, lender, inspector or mover',
        'Mentions a new job in the area or a move coming up',
      ],
      skip: [
        'Other real estate agents and brokers',
        'People who say they already have an agent',
        'Group admins and moderators',
        'Current clients',
      ],
      platforms: ['facebook', 'instagram', 'linkedin'],
      worksOnline: false,
      groupWords: ['community', 'neighbors', 'new to town', 'relocating'],
      steps: ['connect', 'engage', 'message', 'follow_up', 'answer'],
      tone: 'Warm and helpful, like a neighbor who knows the market. Short messages, no pressure.',
      openerStyles: [
        'Say it could help them get the most for their home, with less stress.',
        'Say it could help them find the right home without the guesswork.',
        'Say it could show them what their home is worth today.',
      ],
      questions: [
        {
          id: 'q1',
          text: 'Are you thinking about buying, selling, or both?',
          answers: [
            { label: 'Buying', tag: 'Buyer', next: 'continue' },
            { label: 'Selling', tag: 'Seller', next: 'q4' },
            { label: 'Both', tag: 'Buying and selling', next: 'continue' },
            { label: 'Just looking for now', tag: 'Just looking', next: 'later' },
          ],
        },
        {
          id: 'q2',
          text: 'Have you talked with a lender yet?',
          answers: [
            { label: 'Yes, I’m pre-approved', tag: 'Pre-approved', next: 'continue' },
            { label: 'Not yet', tag: null, next: 'continue' },
          ],
        },
        {
          id: 'q3',
          text: 'When would you like to move?',
          answers: [
            { label: 'In the next 3 months', tag: 'Moving soon', next: 'q5' },
            { label: 'Later this year', tag: null, next: 'q5' },
            { label: 'Not sure yet', tag: null, next: 'later' },
          ],
        },
        {
          id: 'q4',
          text: 'Would you like to know what your home might sell for?',
          answers: [
            { label: 'Yes, please', tag: 'Wants a home value', next: 'continue' },
            { label: 'Not yet', tag: null, next: 'later' },
          ],
        },
        {
          id: 'q5',
          text: 'Are you working with an agent yet?',
          answers: [
            { label: 'Not yet', tag: null, next: 'offer' },
            { label: 'Yes', tag: 'Has an agent', next: 'stop' },
          ],
        },
      ],
      // Fair housing: never words about who a home or a neighborhood suits, and no promises about a sale.
      avoid: [
        'Family-friendly',
        'Perfect for families',
        'Safe neighborhood',
        'Exclusive neighborhood',
        'Great for young couples',
        'Ideal for singles',
        'Guaranteed sale',
        'Guaranteed price',
      ],
      hashtags: [
        'househunting',
        'firsttimehomebuyer',
        'homebuying',
        'newhome',
        'movingsoon',
        'dreamhome',
        'homesweethome',
        'homeownership',
        'sellingmyhome',
        'relocating',
        'movingday',
        'newhomeowner',
        'firsthome',
        'housegoals',
        'homegoals',
      ],
      postSearches: [
        'relocating to',
        'moving to',
        'buying our first home',
        'house hunting',
        'selling our home',
        'first time homebuyer',
        'new job in',
        'looking for a realtor',
      ],
      tags: [
        'Buyer',
        'Seller',
        'Buying and selling',
        'Just looking',
        'Pre-approved',
        'Moving soon',
        'Wants a home value',
        'Has an agent',
        'Wants a consultation',
        'Not a fit',
        'Friend or family',
      ],
    },
  },
  home_services: {
    name: 'Home service estimates',
    summary:
      'For home service businesses. Find homeowners with a repair or project coming up, ask about it, and offer a free estimate.',
    details: {
      ...blankPlaybook(),
      goal: 'estimate',
      offer: 'A free estimate',
      niche: 'Homeowners in your area with a repair or project coming up',
      problem:
        'They put off repairs because they don’t know who to trust, what it should cost, or when someone can come.',
      audience:
        'Homeowners and property managers in your service area who need work done on a home.',
      signs: [
        'Asks a group to recommend a plumber, roofer, electrician, cleaner or handyman',
        'Posts about a leak, a breakdown, storm damage or a project they’re planning',
        'Just bought a home, or is getting one ready to sell',
        'Manages rental homes',
      ],
      skip: [
        'Competitors and other contractors',
        'Group admins and moderators',
        'Current customers',
        'People outside your service area',
      ],
      platforms: ['facebook', 'instagram', 'alignable'],
      worksOnline: false,
      groupWords: ['community', 'neighbors', 'homeowners', 'recommendations'],
      steps: ['connect', 'engage', 'message', 'follow_up', 'answer'],
      tone: 'Friendly and straight to the point, like a local pro the neighbors trust. Short messages, no pressure.',
      openerStyles: [
        'Say it could save them money on their home.',
        'Say it could get their project done without the hassle.',
        'Say it could take that repair off their list for good.',
      ],
      questions: [
        {
          id: 'q1',
          text: 'Do you have any repairs or projects coming up at home?',
          answers: [
            { label: 'Yes, soon', tag: 'Has a project', next: 'continue' },
            { label: 'Maybe later this year', tag: 'Project later', next: 'later' },
            { label: 'No, all good', tag: null, next: 'q4' },
            { label: 'I rent', tag: 'Not a fit', next: 'stop' },
          ],
        },
        { id: 'q2', text: 'What kind of work is it?', answers: [] },
        {
          id: 'q3',
          text: 'When would you like it done?',
          answers: [
            { label: 'As soon as possible', tag: 'Needs it soon', next: 'offer' },
            { label: 'In the next few months', tag: null, next: 'offer' },
            { label: 'Just getting prices', tag: null, next: 'offer' },
          ],
        },
        {
          id: 'q4',
          text: 'Do you have someone you call when something breaks?',
          answers: [
            { label: 'Yes', tag: 'Has a pro', next: 'later' },
            { label: 'Not really', tag: null, next: 'offer' },
          ],
        },
      ],
      avoid: ['Cheapest', 'Lowest price guaranteed', 'Act now', 'Limited time'],
      hashtags: [
        'homeimprovement',
        'homerenovation',
        'homerepair',
        'homemaintenance',
        'homeproject',
        'newhomeowner',
        'homeowner',
        'firsthome',
        'fixerupper',
        'kitchenremodel',
        'bathroomremodel',
        'curbappeal',
        'diyhome',
        'renovationlife',
        'beforeandafter',
      ],
      businessKinds: [
        'Property Management',
        'Real Estate Agent',
        'Real Estate Brokerage',
        'Vacation Rental',
        'Home Builder',
        'Interior Designer',
        'Home Staging',
      ],
      tags: [
        'Homeowner',
        'Has a project',
        'Project later',
        'Needs it soon',
        'Has a pro',
        'Wants an estimate',
        'Not a fit',
        'Friend or family',
      ],
    },
  },
  coaching: {
    name: 'Coaching calls',
    summary:
      'For coaches. Find people who want a change you help with, ask about it, and offer a free discovery call.',
    details: {
      ...blankPlaybook(),
      goal: 'call',
      offer: 'A free 30-minute discovery call',
      niche: 'People who want a change in their work or life and feel stuck on their own',
      problem:
        'They know what they want to change but keep putting it off, with no plan and nobody keeping them on track.',
      audience:
        'People who want help reaching a goal in their work, business or life, and are open to talking with a coach.',
      signs: [
        'Posts about feeling stuck, burned out or ready for a change',
        'Shares a goal they’re working toward',
        'Asks a group for advice, a mentor or a coach',
        'Starting or growing their own business',
      ],
      skip: [
        'Other coaches and consultants',
        'People going through a crisis or asking for medical help',
        'Group admins and moderators',
        'Current clients',
      ],
      platforms: ['facebook', 'instagram', 'linkedin'],
      worksOnline: true,
      groupWords: ['personal growth', 'entrepreneurs', 'career change', 'self improvement'],
      steps: ['connect', 'engage', 'message', 'follow_up'],
      tone: 'Encouraging and curious, never pushy. Short messages that ask more than they tell.',
      openerStyles: [
        'Say it could help them reach their goal this year.',
        'Say it could help them get unstuck.',
        'Say it could give them more time for what matters to them.',
      ],
      questions: [
        {
          id: 'q1',
          text: 'What would you most like to change in the next few months?',
          answers: [],
        },
        { id: 'q2', text: 'What have you tried so far?', answers: [] },
        {
          id: 'q3',
          text: 'What’s getting in the way?',
          answers: [
            { label: 'Time', tag: null, next: 'continue' },
            { label: 'Not sure where to start', tag: null, next: 'continue' },
            { label: 'Staying on track', tag: null, next: 'continue' },
            { label: 'Nothing, I’ve got it', tag: 'Doing fine', next: 'later' },
          ],
        },
        {
          id: 'q4',
          text: 'Would it help to talk it through with someone?',
          answers: [
            { label: 'Yes', tag: 'Wants a call', next: 'offer' },
            { label: 'Maybe later', tag: null, next: 'later' },
            { label: 'No thanks', tag: 'Not a fit', next: 'stop' },
          ],
        },
      ],
      avoid: ['Guaranteed results', 'Cure', 'Diagnose', 'Therapy', 'Get rich quick'],
      hashtags: [
        'personalgrowth',
        'personaldevelopment',
        'growthmindset',
        'mindset',
        'goalsetting',
        'careerchange',
        'careergoals',
        'selfimprovement',
        'entrepreneurlife',
        'smallbusinessowner',
        'worklifebalance',
        'burnout',
        'newchapter',
        'lifegoals',
        'motivation',
      ],
      postSearches: [
        'feeling stuck',
        'career change',
        'burnout',
        'next chapter',
        'work life balance',
        'growing my business',
        'need accountability',
        'new goals',
      ],
      tags: ['Wants a change', 'Doing fine', 'Wants a call', 'Not a fit', 'Friend or family'],
    },
  },
} satisfies Record<string, PlaybookTemplate>;
export type PlaybookTemplateKey = keyof typeof TEMPLATES;

/**
 * Where a new playbook can start, in this order: the owner's own, then real estate agents, home services and coaches.
 */
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
export const PLAYBOOK_V6_KEYS = ['partnerKinds'] as const;
export const PLAYBOOK_V7_KEYS = ['onItsNetworks'] as const;
export const PLAYBOOK_V8_KEYS = [
  'hashtags',
  'postSearches',
  'businessKinds',
  'worksOnline',
  'wordsWritten',
] as const;
/** What a save that leaves a part out keeps. */
export const PLAYBOOK_KEPT_KEYS = [
  ...PLAYBOOK_V3_KEYS,
  ...PLAYBOOK_V4_KEYS,
  ...PLAYBOOK_V5_KEYS,
  ...PLAYBOOK_V6_KEYS,
  ...PLAYBOOK_V7_KEYS,
  ...PLAYBOOK_V8_KEYS,
] as const;

/** The networks every customers' playbook ran on before data version 7: those that worked then. */
const RAN_ON_BEFORE_7: readonly Platform[] = ['facebook', 'linkedin'];

/** Whether a playbook runs on a network: one of its own (data version 7). */
export const runsOn = (details: Pick<PlaybookDetails, 'platforms'>, platform: Platform): boolean =>
  details.platforms.includes(platform);

/**
 * Whether a playbook has a network's own words (data version 8): a customers' playbook that runs there. The builder
 * shows the list only then, and only then does the AI write it or a search read it.
 */
export const hasWordsOn = (
  details: Pick<PlaybookDetails, 'goal' | 'platforms'>,
  platform: WordsPlatform,
): boolean => !forPartners(details) && runsOn(details, platform);

/**
 * A playbook's own words of one part on a network (data version 8, decision 92), for the look or search that reads
 * them: its list when it has one; none when the AI wrote it and the person emptied it, so that network looks at
 * nothing for the playbook; or null while the AI hasn't written for that network (or the part isn't that network's),
 * when the made-up words from its signs and words for groups stand in.
 */
export function ownWordsOn(
  details: Partial<Pick<PlaybookDetails, FindWordsPart | 'wordsWritten'>>,
  platform: Platform,
  part: FindWordsPart,
): readonly string[] | null {
  if (!(platform in FIND_WORDS_PARTS) || FIND_WORDS_PARTS[platform as WordsPlatform] !== part)
    return null;
  const list = details[part] ?? [];
  if (list.length) return list;
  return details.wordsWritten?.includes(platform as WordsPlatform) ? [] : null;
}

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
 * video script; before 6, no kinds of partner (every kind); before 7, a customers' playbook ran on every network that
 * worked (Facebook and LinkedIn), so those are put on it; before 8, no words of each network's own, nothing said of
 * working online, and none written by the AI. Anything else passes through for the schema to judge.
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
  const platforms = Array.isArray(d['platforms']) ? (d['platforms'] as unknown[]) : null;
  const before7 = d['onItsNetworks'] === undefined && d['goal'] !== PARTNER_GOAL && !!platforms;
  return {
    ...Object.fromEntries(PLAYBOOK_KEPT_KEYS.map((k) => [k, blank[k]])),
    ...d,
    ...(before7
      ? {
          platforms: PLATFORM_KEYS.filter(
            (p) => platforms.includes(p) || RAN_ON_BEFORE_7.includes(p),
          ),
          onItsNetworks: true,
        }
      : {}),
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
    'Say it could make them more money while saving them time.',
    'Say it could bring them more customers without more work.',
    'Say it could give them their evenings and weekends back.',
    'Say it could save them money.',
    'Say it could take something off their plate.',
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
