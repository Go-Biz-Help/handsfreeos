/**
 * AI Social Media Content Creator's shapes (docs/socialcontent.md): what its operations take and answer, and the
 * limits on what's saved. Browser-safe: the web, the phone, the extension and the worker read them.
 */
import { z } from 'zod';
import { CALENDAR, FACEBOOK_WHERE, PLAN_MODES, POSTING_NETWORKS } from './calendar';
import { TIMES_FROM } from './schedule';
import { PICKING, RecentPost, SetupFacts, SetupMarks } from './picking';
import { CONTENT_NETWORKS } from './networks';
import { ANGLES } from './variety';
import { OFFER_LIST_LIMITS, OFFER_LISTS } from '../../main-offer/lists';

export const uuid = z.uuid();
export const Network = z.enum(CONTENT_NETWORKS);

export const LIMITS = {
  nicheName: 80,
  why: 300,
  /** Words to search one network for one niche. */
  searchesPerNetwork: 8,
  search: 60,
  handle: 200,
  name: 200,
  link: 500,
  bio: 1000,
  postKey: 200,
  caption: 3000,
  failure: 300,
  /** Posts in one save. */
  postsPerSave: 100,
  /** Creators in one search's save. */
  foundPerSave: 50,
  /** Similar niches the AI suggests at once. */
  similarAtMost: 5,
  /** Niches a business keeps. */
  niches: 30,
  /** Handles a search is told it already knows. */
  knownAtMost: 1000,
  /** The Playbook's sections, and the ideas the AI suggests at once. */
  playbookSections: 8,
  ideasAtOnce: 12,
  /** What watching sends: frames, each one's size, and its sound (base64 characters). */
  framesMost: 12,
  frameBytes: 200_000,
  soundBytes: 4_000_000,
  /** Videos tried at once with Try it on a few videos. */
  tryVideos: 5,
  /** Profiles one search reads, at most. */
  profilesPerFind: 30,
} as const;

export const NICHE_STATES = ['suggested', 'picked', 'skipped'] as const;
export const CREATOR_STATES = ['suggested', 'studying', 'skipped', 'didnt_fit'] as const;
export const POST_KINDS = ['video', 'photo', 'carousel', 'text', 'link', 'other'] as const;
export const WORK_KINDS = ['find', 'profile', 'posts', 'watch'] as const;
export const WORK_STATES = ['waiting', 'taken', 'done', 'failed', 'stopped'] as const;
export const WORK_ASKED_FOR = [
  'person',
  'weekly',
  'monthly',
  'added',
  'studying',
  'standout',
  'trying',
] as const;
export const IDEA_STATES = ['new', 'saved', 'used', 'skipped'] as const;

export type NicheState = (typeof NICHE_STATES)[number];
export type CreatorState = (typeof CREATOR_STATES)[number];
export type PostKind = (typeof POST_KINDS)[number];
export type WorkKind = (typeof WORK_KINDS)[number];
export type WorkState = (typeof WORK_STATES)[number];
export type WorkAskedFor = (typeof WORK_ASKED_FOR)[number];
export type IdeaState = (typeof IDEA_STATES)[number];

const clipped = (most: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+\n/g, '\n').trim().slice(0, most))
    .pipe(z.string());

/** The words to search each network for a niche, by network. */
export const Searches = z
  .partialRecord(
    Network,
    z.array(z.string().trim().min(1).max(LIMITS.search)).max(LIMITS.searchesPerNetwork),
  )
  .default({});
export type Searches = z.infer<typeof Searches>;

export const Niche = z.object({
  id: uuid,
  name: z.string(),
  own: z.boolean(),
  state: z.enum(NICHE_STATES),
  why: z.string().nullable(),
  searches: Searches,
  addedBy: z.enum(['ai', 'person']),
  createdAt: z.string(),
});
export type Niche = z.infer<typeof Niche>;

export const Creator = z.object({
  id: uuid,
  network: Network,
  handle: z.string(),
  /** "@name", as it's shown. */
  shown: z.string(),
  name: z.string().nullable(),
  link: z.string(),
  bio: z.string().nullable(),
  followers: z.number().int().nullable(),
  lastPostAt: z.string().nullable(),
  nicheId: uuid.nullable(),
  nicheName: z.string().nullable(),
  state: z.enum(CREATOR_STATES),
  foundBy: z.enum(['search', 'person']),
  why: z.string().nullable(),
  profileReadAt: z.string().nullable(),
  postsReadAt: z.string().nullable(),
  postsCount: z.number().int(),
  standoutsCount: z.number().int(),
  /** Whether work to read them is waiting or under way. */
  reading: z.boolean(),
  createdAt: z.string(),
  /** Who ticked or skipped them: the AI or a person (decisions 30 and 31). Defaults, for an older API. */
  pickedBy: z.enum(['ai', 'person']).nullable().default(null),
  /** How close the AI found them to what the business does, 0 to 10, and why. */
  match: z.number().int().nullable().default(null),
  matchWhy: z.string().nullable().default(null),
  /** Likes and comments for their followers, the middle of their latest posts' (0.031 is 3.1%). */
  engagement: z.number().nullable().default(null),
});
export type Creator = z.infer<typeof Creator>;

/** The AI's notes on a standout (./notes-ai.ts): why it worked, and what the business can take from it. */
export const PostNotes = z.object({
  why: z.string(),
  hook: z.string().nullable(),
  format: z.string().nullable(),
  topic: z.string().nullable(),
  techniques: z.array(z.string()),
  /** How the business could use it, in a line. */
  useIt: z.string().nullable(),
});
export type PostNotes = z.infer<typeof PostNotes>;

/** What the AI saw and heard watching a standout video (decision 9). */
export const PostWatched = z.object({
  /** What happens in its first seconds. */
  hook: z.string().nullable(),
  /** What's on screen: who, where, words on screen, cuts. */
  seen: z.string(),
  /** What's said, and the sound. Null when there's nothing to hear. */
  heard: z.string().nullable(),
  pacing: z.string().nullable(),
  why: z.string(),
  techniques: z.array(z.string()),
});
export type PostWatched = z.infer<typeof PostWatched>;

export const Post = z.object({
  id: uuid,
  creatorId: uuid,
  creatorName: z.string().nullable(),
  creatorShown: z.string(),
  network: Network,
  postKey: z.string(),
  link: z.string(),
  postedAt: z.string(),
  kind: z.enum(POST_KINDS),
  caption: z.string().nullable(),
  views: z.number().int().nullable(),
  likes: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  shares: z.number().int().nullable(),
  seconds: z.number().int().nullable(),
  pinned: z.boolean(),
  viewsTimes: z.number().nullable(),
  engagementTimes: z.number().nullable(),
  standout: z.boolean(),
  standoutOn: z.enum(['views', 'engagement', 'both']).nullable(),
  waiting: z.enum(['too_new', 'too_few']).nullable(),
  notes: PostNotes.nullable(),
  watched: PostWatched.nullable(),
  /** Whether watching it is waiting or under way. */
  watching: z.boolean(),
});
export type Post = z.infer<typeof Post>;

/** One thing to do, in a Playbook section: what, why it works, and the standouts it came from. */
export const PlaybookItem = z.object({
  do: z.string(),
  why: z.string(),
  examples: z.array(uuid),
});
export const PlaybookSection = z.object({ title: z.string(), items: z.array(PlaybookItem) });
export type PlaybookSection = z.infer<typeof PlaybookSection>;

export const Playbook = z.object({
  summary: z.string().nullable(),
  sections: z.array(PlaybookSection),
  /** How many noted standouts it was written from, and how many there are now. */
  standouts: z.number().int(),
  noted: z.number().int(),
  writtenAt: z.string().nullable(),
});
export type Playbook = z.infer<typeof Playbook>;

/** The kind of a post or idea in the weekly mix (decision 36). */
export const AngleShape = z.enum(ANGLES);
/** A line from the main offer's lists for content that a post or idea is about (decision 34). */
export const TopicShape = z.object({
  list: z.enum(OFFER_LISTS),
  line: z.string().trim().min(1).max(OFFER_LIST_LIMITS.line),
});
/** Where an idea found by looking things up online came from: the page, and its site or publisher's name. */
export const SourceShape = z.object({
  url: z.url().max(2000),
  name: z.string().trim().min(1).max(120),
});

export const Idea = z.object({
  id: uuid,
  title: z.string(),
  hook: z.string().nullable(),
  format: z.string().nullable(),
  network: Network.nullable(),
  outline: z.string().nullable(),
  why: z.string().nullable(),
  basedOn: z.array(uuid),
  /** Its kind and topic (decisions 34 to 36), and where it came from when it was found online. Default for an older API. */
  angle: AngleShape.nullable().default(null),
  topic: TopicShape.nullable().default(null),
  source: SourceShape.nullable().default(null),
  state: z.enum(IDEA_STATES),
  createdAt: z.string(),
});
export type Idea = z.infer<typeof Idea>;

/**
 * What the reading computer is doing, as it does it (docs/socialcontent.md, "What it's doing"): the extension's own
 * account (what it's at now, the searches done, the accounts it looked at, profiles and posts it read), and
 * HandsFreeOS's counts of who a search suggested and who didn't fit. Every part is optional: a read says only what it
 * has.
 */
export const WorkProgress = z.object({
  /** What it's at now, in a few words: "Searching Instagram for #crmsoftware". */
  now: z.string().trim().max(160).optional(),
  /** The searches done so far, and how many there are. */
  searched: z.array(z.string().trim().max(LIMITS.search)).max(LIMITS.searchesPerNetwork).optional(),
  searches: z.number().int().min(0).max(100).optional(),
  /** Accounts the searches showed, profiles read, posts read. */
  accounts: z.number().int().min(0).max(100_000).optional(),
  profiles: z.number().int().min(0).max(100_000).optional(),
  posts: z.number().int().min(0).max(1_000_000).optional(),
  /** Profiles Instagram wouldn't open (it said they weren't there, and their page held nothing to read). */
  notOpened: z.number().int().min(0).max(100_000).optional(),
  /** HandsFreeOS's own: who a search suggested, and who didn't fit. */
  suggested: z.number().int().min(0).max(100_000).optional(),
  didntFit: z.number().int().min(0).max(100_000).optional(),
});
export type WorkProgress = z.infer<typeof WorkProgress>;
/** What the extension may say of its progress: all but HandsFreeOS's own counts. */
export const WorkProgressSaid = WorkProgress.omit({ suggested: true, didntFit: true });
export type WorkProgressSaid = z.infer<typeof WorkProgressSaid>;

export const Work = z.object({
  id: uuid,
  kind: z.enum(WORK_KINDS),
  network: Network,
  nicheId: uuid.nullable(),
  nicheName: z.string().nullable(),
  creatorId: uuid.nullable(),
  creatorShown: z.string().nullable(),
  /** For watching: the post. */
  postId: uuid.nullable(),
  state: z.enum(WORK_STATES),
  askedFor: z.enum(WORK_ASKED_FOR),
  failure: z.string().nullable(),
  doneCount: z.number().int().nullable(),
  /** What it did, or is doing: null before it started, or from before this was kept. */
  progress: WorkProgress.nullable(),
  createdAt: z.string(),
  takenAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type Work = z.infer<typeof Work>;

/** How many posts a week on one network, and when ('HH:MM' in the business's time zone): the calendar's plan. */
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** One network's plan (decisions 21, 22 and 24): AI picks (`ai`) or I pick (`mine`). */
export const NetworkPlanShape = z.object({
  mode: z.enum(PLAN_MODES),
  /** AI picks: posts a week. */
  perWeek: z.number().int().min(0).max(CALENDAR.perWeekMost),
  /** AI picks: the most in one day; null spreads them out. */
  perDay: z.number().int().min(1).max(CALENDAR.perDayMost).nullable(),
  /** AI picks: the hours it posts between, HH:MM in the business's time zone. */
  from: Clock,
  to: Clock,
  /** AI picks: the time it starts near while it has learned nothing. */
  time: Clock,
  /** I pick: each weekday's times, Sunday first. */
  week: z.array(z.array(Clock).max(CALENDAR.perDayMost)).length(7),
});
export const PlanShape = z.object({
  instagram: NetworkPlanShape,
  facebook: NetworkPlanShape,
  linkedin: NetworkPlanShape,
  threads: NetworkPlanShape,
  x: NetworkPlanShape,
});
/** A change to the plan: for each network given, only the parts that change. */
export const PlanSaveShape = z.partialRecord(z.enum(POSTING_NETWORKS), NetworkPlanShape.partial());

/** What AI picks learned on one network (decisions 23 and 25): its best hours so far, and from what. */
export const LearnedShape = z.object({
  best: z.array(z.string()),
  from: z.enum(TIMES_FROM),
  own: z.number().int(),
  creators: z.number().int(),
});
export const LearnedPlanShape = z.object({
  instagram: LearnedShape,
  facebook: LearnedShape,
  linkedin: LearnedShape,
  threads: LearnedShape,
  x: LearnedShape,
});

export const Settings = z.object({
  networks: z.array(Network),
  readerUserId: uuid.nullable(),
  readerName: z.string().nullable(),
  /** Watching standout videos (decision 9): off until an owner or admin turns it on. */
  watchVideos: z.boolean(),
  /** When the reading computer last asked for work, and its extension's version: null when it never has. */
  readerSeenAt: z.string().nullable(),
  readerVersion: z.string().nullable(),
  /** The calendar's plan for the business's own posts (decision 18). */
  plan: PlanShape,
  /** The business's Facebook Page, and where its Facebook posts go (decision 17). */
  facebookPage: z.string().nullable(),
  facebookWhere: z.array(z.enum(FACEBOOK_WHERE)),
  /** Whether the AI fills the calendar on its own (on until someone turns it off; the owner, 11 Nov). */
  autoFill: z.boolean(),
  /** Whether it picks niches and creators on its own (decisions 29 and 30). Defaults, for an older API. */
  autoPick: z.boolean().default(true),
});
export type Settings = z.infer<typeof Settings>;

// ------------------------------------------------------------------------------------------------ inputs

export const InWorkspace = z.object({ workspaceId: uuid });

export const OverviewOutput = z.object({
  settings: Settings,
  /** Whether the person asking is the reading computer's. */
  readerIsMe: z.boolean(),
  mayManage: z.boolean(),
  counts: z.object({
    suggested: z.number().int(),
    studying: z.number().int(),
    skipped: z.number().int(),
    standouts: z.number().int(),
    waiting: z.number().int(),
  }),
  work: z.array(Work),
  /** What AI picks learned about the hours on each network. Defaults, for an older API. */
  learned: LearnedPlanShape.optional(),
  /** How setting up on its own stands (decisions 28 to 32), for `setupSteps`. None from an older API. */
  setup: SetupFacts.optional(),
});
export type Overview = z.infer<typeof OverviewOutput>;

export const NicheListOutput = z.object({ niches: z.array(Niche) });

export const NicheAddInput = z.object({
  workspaceId: uuid,
  name: z.string().trim().min(1).max(LIMITS.nicheName),
});
export const NicheDecideInput = z.object({
  workspaceId: uuid,
  nicheId: uuid,
  state: z.enum(['picked', 'skipped']),
});

export const CreatorListInput = z.object({
  workspaceId: uuid,
  state: z.enum(CREATOR_STATES).optional(),
  network: Network.optional(),
});
export const CreatorListOutput = z.object({ creators: z.array(Creator) });

export const CreatorAddInput = z.object({
  workspaceId: uuid,
  link: z.string().trim().min(1).max(LIMITS.link),
  /** For a bare "@name". */
  network: Network.optional(),
});
export const CreatorDecideInput = z.object({
  workspaceId: uuid,
  creatorId: uuid,
  study: z.boolean(),
});

export const PostListInput = z.object({
  workspaceId: uuid,
  creatorId: uuid.optional(),
  standoutsOnly: z.boolean().default(false),
  network: Network.optional(),
  /** Older than this post's moment, for the next page. */
  before: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const PostListOutput = z.object({ posts: z.array(Post), more: z.boolean() });

export const FindNowInput = z.object({ workspaceId: uuid, network: Network.optional() });
export const FindNowOutput = z.object({
  asked: z.number().int(),
  networks: z.array(Network),
  niches: z.number().int(),
});
export const ReadNowInput = z.object({ workspaceId: uuid, creatorId: uuid.optional() });
export const ReadNowOutput = z.object({ asked: z.number().int() });

export const WorkStopInput = z.object({ workspaceId: uuid, workId: uuid });

export const SettingsSaveInput = z.object({
  workspaceId: uuid,
  networks: z.array(Network).min(1).max(CONTENT_NETWORKS.length).optional(),
  /** Whose computer reads; null for none. */
  readerUserId: uuid.nullable().optional(),
  watchVideos: z.boolean().optional(),
  /** The calendar's plan: for each network given, the parts that change (AI picks or I pick, and each one's own). */
  plan: PlanSaveShape.optional(),
  /** The business's Facebook Page's link; null for none. */
  facebookPage: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .nullable()
    .optional(),
  /** Where its Facebook posts go: the person's profile, the Page, or both. */
  facebookWhere: z.array(z.enum(FACEBOOK_WHERE)).min(1).max(2).optional(),
  /**
   * Whether the AI fills the calendar on its own. Off stops it, a fill under way too; on fills the open days right
   * away, then tops up once a week.
   */
  autoFill: z.boolean().optional(),
  /**
   * Whether it picks niches and creators on its own: the business's own niche and the 2 closest, and the best 10
   * creators on each network, swapped once a month. Off, a person ticks them.
   */
  autoPick: z.boolean().optional(),
});

/** A standout a Playbook item or an idea came from, to open. */
export const StandoutRef = z.object({
  id: uuid,
  link: z.string(),
  network: Network,
  kind: z.enum(POST_KINDS),
  creatorShown: z.string(),
});
export type StandoutRef = z.infer<typeof StandoutRef>;
export const PlaybookGetOutput = z.object({ playbook: Playbook, examples: z.array(StandoutRef) });
export const IdeaListInput = z.object({
  workspaceId: uuid,
  state: z.enum(IDEA_STATES).optional(),
});
export const IdeaListOutput = z.object({
  ideas: z.array(Idea),
  examples: z.array(StandoutRef),
  /** Whether the main offer is live: until it is, the AI writes no ideas (pick 7b). Defaults, for an older API. */
  offerLive: z.boolean().default(true),
});
export const IdeaDecideInput = z.object({
  workspaceId: uuid,
  ideaId: uuid,
  state: z.enum(IDEA_STATES),
});
export const WatchTryInput = z.object({ workspaceId: uuid });
export const WatchTryOutput = z.object({ asked: z.number().int() });

// ------------------------------------------------------------------------------------------------ the extension

export const WorkNextInput = z.object({
  workspaceId: uuid,
  /** The networks this build of the extension reads. */
  reads: z.array(Network).max(CONTENT_NETWORKS.length),
  /**
   * Of those, where searches for new creators still have room today: the rest of the day's reading is kept for
   * creators someone ticked or added. Builds before 0.129.0 leave it out: searches on every network it reads.
   */
  searchOn: z.array(Network).max(CONTENT_NETWORKS.length).optional(),
  /** The extension's version, shown with when it last asked. */
  version: z
    .string()
    .trim()
    .max(20)
    .regex(/^[\w.-]*$/)
    .optional(),
});
export const WorkNextOutput = z.object({
  work: z
    .object({
      id: uuid,
      kind: z.enum(WORK_KINDS),
      network: Network,
      niche: z.object({ id: uuid, name: z.string(), searches: z.array(z.string()) }).nullable(),
      creator: z
        .object({ id: uuid, handle: z.string(), link: z.string(), name: z.string().nullable() })
        .nullable(),
      /** For posts: read back to here. */
      since: z.string().nullable(),
      /** For a search: the creators already known on this network, by their name there, to pass over. */
      known: z.array(z.string()),
      /** For a search: how many profiles to read at most. */
      most: z.number().int(),
      /** For watching: the post. */
      post: z
        .object({
          id: uuid,
          postKey: z.string(),
          link: z.string(),
          seconds: z.number().int().nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

export const WorkFinishInput = z.object({
  workspaceId: uuid,
  workId: uuid,
  /** Why it didn't work, in words the person can read, or null when it did. */
  failure: clipped(LIMITS.failure).nullable().default(null),
});

export const WorkProgressInput = z.object({
  workspaceId: uuid,
  workId: uuid,
  progress: WorkProgressSaid,
});

export const FoundCreator = z.object({
  handle: z.string().trim().min(1).max(LIMITS.handle),
  name: clipped(LIMITS.name).nullable().default(null),
  bio: clipped(LIMITS.bio).nullable().default(null),
  followers: z.number().int().min(0).nullable().default(null),
  lastPostAt: z.iso.datetime().nullable().default(null),
  /** Their latest posts as their profile shows them (extension 0.136.0 on), for how they do for their followers. */
  recent: z.array(RecentPost).max(PICKING.recentAtMost).nullable().default(null),
});
export type FoundCreator = z.input<typeof FoundCreator>;
export const CreatorsFoundInput = z.object({
  workspaceId: uuid,
  workId: uuid,
  found: z.array(FoundCreator).max(LIMITS.foundPerSave),
});
export const CreatorsFoundOutput = z.object({
  suggested: z.number().int(),
  didntFit: z.number().int(),
});

export const CreatorReadInput = z.object({
  workspaceId: uuid,
  creatorId: uuid,
  name: clipped(LIMITS.name).nullable().default(null),
  bio: clipped(LIMITS.bio).nullable().default(null),
  followers: z.number().int().min(0).nullable().default(null),
  lastPostAt: z.iso.datetime().nullable().default(null),
  /** Their latest posts as their profile shows them (extension 0.136.0 on). */
  recent: z.array(RecentPost).max(PICKING.recentAtMost).nullable().default(null),
});

export const PostIn = z.object({
  postKey: z.string().trim().min(1).max(LIMITS.postKey),
  link: z.url({ protocol: /^https$/ }).max(LIMITS.link),
  postedAt: z.iso.datetime(),
  kind: z.enum(POST_KINDS).default('other'),
  caption: clipped(LIMITS.caption).nullable().default(null),
  views: z.number().int().min(0).nullable().default(null),
  likes: z.number().int().min(0).nullable().default(null),
  comments: z.number().int().min(0).nullable().default(null),
  shares: z.number().int().min(0).nullable().default(null),
  seconds: z.number().int().min(0).max(86_400).nullable().default(null),
  pinned: z.boolean().default(false),
});
export type PostIn = z.infer<typeof PostIn>;
export const PostsSaveInput = z.object({
  workspaceId: uuid,
  creatorId: uuid,
  posts: z.array(PostIn).max(LIMITS.postsPerSave),
});
export const PostsSaveOutput = z.object({
  saved: z.number().int(),
  standouts: z.number().int(),
  /** Posts that became standouts with this save. */
  newStandouts: z.array(uuid),
});

// ------------------------------------------------------------------------------------------------ the worker

export const PostNoteInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  notes: PostNotes,
});
export const PostWatchedInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  watched: PostWatched,
});
export const PlaybookPutInput = z.object({
  workspaceId: uuid,
  summary: z.string().max(2000).nullable(),
  sections: z.array(PlaybookSection).max(LIMITS.playbookSections),
  standouts: z.number().int().min(0),
});
export const IdeaIn = Idea.pick({
  title: true,
  hook: true,
  format: true,
  network: true,
  outline: true,
  why: true,
  basedOn: true,
  angle: true,
  topic: true,
  source: true,
});
export type IdeaIn = z.infer<typeof IdeaIn>;
export const IdeasPutInput = z.object({
  workspaceId: uuid,
  ideas: z.array(IdeaIn).max(LIMITS.ideasAtOnce),
});
export const IdeasPutOutput = z.object({ added: z.number().int() });

/** What the extension sends from watching a standout video: a few frames, and what it heard. */
export const WatchFrame = z.object({
  /** Seconds into the video. */
  at: z.number().min(0).max(86_400),
  /** A JPEG, as base64. */
  jpeg: z.string().max(LIMITS.frameBytes),
});
export const PostWatchInput = z.object({
  workId: uuid,
  postId: uuid,
  seconds: z.number().min(0).max(86_400).nullable(),
  frames: z.array(WatchFrame).min(1).max(LIMITS.framesMost),
  /** Its sound as a WAV, base64; null when it has none or it couldn't be read. */
  sound: z.string().max(LIMITS.soundBytes).nullable(),
});

export const NicheOut = z.object({
  name: z.string().trim().min(1).max(LIMITS.nicheName),
  why: clipped(LIMITS.why).nullable().default(null),
  searches: Searches,
});
export const NichesPutInput = z.object({
  workspaceId: uuid,
  own: NicheOut.nullable(),
  /** Closest to the business's own first. */
  similar: z.array(NicheOut).max(LIMITS.similarAtMost),
  /** Setting up on its own: the closest this many new ones are ticked too (decision 29). */
  pickClosest: z.number().int().min(0).max(LIMITS.similarAtMost).default(0),
});
export const NichesPutOutput = z.object({ added: z.number().int() });
export const NicheSearchesPutInput = z.object({
  workspaceId: uuid,
  nicheId: uuid,
  searches: Searches,
});
export const WorkQueueInput = z.object({
  workspaceId: uuid,
  kind: z.enum(['find', 'posts']),
  /** `person`: setting up on its own, searched before the weekly and monthly reads. */
  askedFor: z.enum(['weekly', 'monthly', 'person']),
});

/** What the AI said about how close creators are to what the business does (decision 30). */
export const CreatorsMatchedInput = z.object({
  workspaceId: uuid,
  matches: z
    .array(
      z.object({
        creatorId: uuid,
        match: z.number().int().min(0).max(10),
        why: z.string().max(LIMITS.why).nullable(),
      }),
    )
    .max(PICKING.matchRunMost),
});

/**
 * Setting up on its own and the monthly swap (decisions 30 and 31): the creators the AI picks to study, the ones it
 * swaps out with why, and the profiles it reads first.
 */
export const CreatorsPickInput = z.object({
  workspaceId: uuid,
  pick: z.array(uuid).max(50).default([]),
  swap: z
    .array(z.object({ creatorId: uuid, why: z.string().min(1).max(LIMITS.why) }))
    .max(50)
    .default([]),
  read: z.array(uuid).max(60).default([]),
});
export const CreatorsPickOutput = z.object({
  picked: z.number().int(),
  swapped: z.number().int(),
  asked: z.number().int(),
});

/** The steps of setting up it took just now; one taken before keeps its first time. */
export const SetupMarkInput = z.object({
  workspaceId: uuid,
  marks: SetupMarks,
});
