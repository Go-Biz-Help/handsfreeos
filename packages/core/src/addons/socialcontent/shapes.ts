/**
 * AI Social Media Content Creator's shapes (docs/socialcontent.md): what its operations take and answer, and the
 * limits on what's saved. Browser-safe: the web, the phone, the extension and the worker read them.
 */
import { z } from 'zod';
import { CONTENT_NETWORKS } from './networks';

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
  /** Profiles one search reads, at most. */
  profilesPerFind: 30,
} as const;

export const NICHE_STATES = ['suggested', 'picked', 'skipped'] as const;
export const CREATOR_STATES = ['suggested', 'studying', 'skipped', 'didnt_fit'] as const;
export const POST_KINDS = ['video', 'photo', 'carousel', 'text', 'link', 'other'] as const;
export const WORK_KINDS = ['find', 'profile', 'posts'] as const;
export const WORK_STATES = ['waiting', 'taken', 'done', 'failed', 'stopped'] as const;
export const WORK_ASKED_FOR = ['person', 'weekly', 'monthly', 'added', 'studying'] as const;

export type NicheState = (typeof NICHE_STATES)[number];
export type CreatorState = (typeof CREATOR_STATES)[number];
export type PostKind = (typeof POST_KINDS)[number];
export type WorkKind = (typeof WORK_KINDS)[number];
export type WorkState = (typeof WORK_STATES)[number];
export type WorkAskedFor = (typeof WORK_ASKED_FOR)[number];

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
});
export type Creator = z.infer<typeof Creator>;

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
});
export type Post = z.infer<typeof Post>;

export const Work = z.object({
  id: uuid,
  kind: z.enum(WORK_KINDS),
  network: Network,
  nicheId: uuid.nullable(),
  nicheName: z.string().nullable(),
  creatorId: uuid.nullable(),
  creatorShown: z.string().nullable(),
  state: z.enum(WORK_STATES),
  askedFor: z.enum(WORK_ASKED_FOR),
  failure: z.string().nullable(),
  doneCount: z.number().int().nullable(),
  createdAt: z.string(),
  takenAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type Work = z.infer<typeof Work>;

export const Settings = z.object({
  networks: z.array(Network),
  readerUserId: uuid.nullable(),
  readerName: z.string().nullable(),
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
});

// ------------------------------------------------------------------------------------------------ the extension

export const WorkNextInput = z.object({
  workspaceId: uuid,
  /** The networks this build of the extension reads. */
  reads: z.array(Network).max(CONTENT_NETWORKS.length),
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
    })
    .nullable(),
});

export const WorkFinishInput = z.object({
  workspaceId: uuid,
  workId: uuid,
  /** Why it didn't work, in words the person can read, or null when it did. */
  failure: clipped(LIMITS.failure).nullable().default(null),
});

export const FoundCreator = z.object({
  handle: z.string().trim().min(1).max(LIMITS.handle),
  name: clipped(LIMITS.name).nullable().default(null),
  bio: clipped(LIMITS.bio).nullable().default(null),
  followers: z.number().int().min(0).nullable().default(null),
  lastPostAt: z.iso.datetime().nullable().default(null),
});
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

export const NicheOut = z.object({
  name: z.string().trim().min(1).max(LIMITS.nicheName),
  why: clipped(LIMITS.why).nullable().default(null),
  searches: Searches,
});
export const NichesPutInput = z.object({
  workspaceId: uuid,
  own: NicheOut.nullable(),
  similar: z.array(NicheOut).max(LIMITS.similarAtMost),
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
  askedFor: z.enum(['weekly', 'monthly']),
});
