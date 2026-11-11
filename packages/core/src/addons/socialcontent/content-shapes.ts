/**
 * The shapes of the business's own posts and its calendar (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, part 8;
 * docs/socialcontent.md, "Making posts"): what their operations take and answer. Browser-safe: the web, the phone and
 * the worker read them.
 */
import { z } from 'zod';
import {
  CALENDAR,
  CONTENT_FORMATS,
  CONTENT_STATES,
  FACEBOOK_WHERE,
  PICTURE_STATES,
  PICTURE_WAYS,
  POST_PLACES,
  POSTING_NETWORKS,
} from './calendar';
import { OWN_READS } from './own';
import { POST_LIMITS } from './posts-ai';
import { Network, PlanShape, uuid } from './shapes';

export const PostingNetwork = z.enum(POSTING_NETWORKS);
export const ContentFormat = z.enum(CONTENT_FORMATS);
export const PictureWay = z.enum(PICTURE_WAYS);
export const FacebookWhere = z.enum(FACEBOOK_WHERE);
export const PostPlace = z.enum(POST_PLACES);

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const trimmed = (most: number) =>
  z
    .string()
    .transform((s) => s.trim().slice(0, most))
    .pipe(z.string());

export const SlideShape = z.object({
  heading: trimmed(POST_LIMITS.slideHeading),
  body: trimmed(POST_LIMITS.slideBody),
});
export const ScriptShape = z.object({
  lines: z.array(trimmed(POST_LIMITS.scriptLine)).max(POST_LIMITS.scriptLines),
  shots: z.array(trimmed(POST_LIMITS.shot)).max(POST_LIMITS.shots),
});

/** One of its pictures: a core file on the post's record, which the web and the phone sign to show. */
export const ContentPicture = z.object({
  fileId: uuid,
  bucket: z.string(),
  objectPath: z.string(),
  name: z.string(),
  mimeType: z.string().nullable(),
});
export type ContentPicture = z.infer<typeof ContentPicture>;

/** One place's numbers at one read (part 11): what the network showed, or why they couldn't be read. */
const Count = z.number().int().min(0).nullable();
export const OwnNumbersRead = z.union([
  z.object({
    at: z.string(),
    days: z.number().int(),
    views: Count,
    likes: Count,
    comments: Count,
    shares: Count,
  }),
  z.object({ at: z.string(), days: z.number().int(), failure: z.string() }),
]);
export const OwnRead = z.enum(OWN_READS);
/** Its numbers so far, by place: the read at about 2 days (`d2`) and at about 7 (`d7`). */
export const OwnNumbersShape = z.partialRecord(PostPlace, z.partialRecord(OwnRead, OwnNumbersRead));
/** Whether it did well against the business's own other posts in that place, at its 7-day read. */
export const DoneWellShape = z.object({
  place: PostPlace,
  on: z.enum(['views', 'engagement', 'both']),
  times: z.number(),
  at: z.string(),
});

/** One of the business's own posts: a Social post record, with what the add-on keeps about it. */
export const Content = z.object({
  id: uuid,
  title: z.string(),
  network: Network,
  format: ContentFormat,
  words: z.string(),
  hook: z.string().nullable(),
  hashtags: z.array(z.string()),
  slides: z.array(z.object({ heading: z.string(), body: z.string() })),
  script: z.object({ lines: z.array(z.string()), shots: z.array(z.string()) }).nullable(),
  /** What its picture shows, or what to shoot. */
  picture: z.string().nullable(),
  pictureWay: PictureWay,
  pictureState: z.enum(PICTURE_STATES),
  pictureFailure: z.string().nullable(),
  pictures: z.array(ContentPicture),
  facebookWhere: z.array(FacebookWhere),
  state: z.enum(CONTENT_STATES),
  postAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  postedAt: z.string().nullable(),
  postLink: z.string().nullable(),
  /** Each place it went up so far (part 9): its link when the network showed one, and when. */
  postedTo: z.array(z.object({ place: PostPlace, link: z.string().nullable(), at: z.string() })),
  /** Its numbers 2 and 7 days after it went up, in each place (part 11), and whether it did well. */
  numbers: OwnNumbersShape,
  doneWell: DoneWellShape.nullable(),
  failure: z.string().nullable(),
  madeBy: z.enum(['ai', 'person']),
  ideaId: uuid.nullable(),
  /** What it still needs before it can be OK'd, in words to show; null when nothing. */
  stillNeeds: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Content = z.infer<typeof Content>;

export const SlotShape = z.object({ network: PostingNetwork, date: LocalDate, at: z.string() });

// ------------------------------------------------------------------------------------------------ inputs

export const CalendarGetInput = z.object({
  workspaceId: uuid,
  /** The first day shown, in the business's time zone; today when left out. */
  from: LocalDate.optional(),
  // Today and the two weeks after it.
  days: z
    .number()
    .int()
    .min(1)
    .max(42)
    .default(CALENDAR.days + 1),
});
export const CalendarGetOutput = z.object({
  timeZone: z.string(),
  today: LocalDate,
  from: LocalDate,
  days: z.number().int(),
  plan: PlanShape,
  /** The plan's times in these days with no post on that network that day yet. */
  open: z.array(SlotShape),
  /** Posts going in these days, soonest first, and drafts with no day yet. */
  posts: z.array(Content),
  undated: z.array(Content),
  /** What went up in the 30 days before these days, newest first, with how each did (part 11). */
  recent: z.array(Content),
  /** When it last filled the calendar, and when it fills again on its own (null until it first fills). */
  filledAt: z.string().nullable(),
  nextFillAt: z.string().nullable(),
  /** Whether it fills on its own (the owner's switch, 11 Nov): off, it writes no posts on its own. */
  autoFill: z.boolean(),
  /** Whether the main offer is live: until it is, the AI writes no posts (pick 7b). Defaults, for an older API. */
  offerLive: z.boolean().default(true),
  /** Ideas saved to make, which a fill uses first. */
  ideasSaved: z.number().int(),
  /** Posts OK'd and waiting to go up at their times. */
  ready: z.number().int(),
  /**
   * The computer that puts them up (the reading computer, in Chrome with the extension, part 9): whose it is, whether
   * it's the person's own, when it last checked in and its extension's version. Null when none is picked.
   */
  poster: z
    .object({
      name: z.string().nullable(),
      mine: z.boolean(),
      seenAt: z.string().nullable(),
      version: z.string().nullable(),
    })
    .nullable(),
  /** The networks the extension puts posts up on; the rest wait for a later update. */
  postsOn: z.array(PostingNetwork),
  facebookPage: z.string().nullable(),
  mayManage: z.boolean(),
});
export type CalendarView = z.infer<typeof CalendarGetOutput>;

export const ContentGetInput = z.object({ workspaceId: uuid, postId: uuid });
export const ContentListInput = z.object({
  workspaceId: uuid,
  state: z.enum(CONTENT_STATES).optional(),
  network: Network.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const ContentListOutput = z.object({ posts: z.array(Content) });

export const ContentSaveInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  title: z.string().trim().min(1).max(POST_LIMITS.title).optional(),
  network: PostingNetwork.optional(),
  format: ContentFormat.optional(),
  words: z.string().max(3000).optional(),
  hook: z.string().trim().max(POST_LIMITS.hook).nullable().optional(),
  hashtags: z
    .array(z.string().max(POST_LIMITS.hashtag + 1))
    .max(30)
    .optional(),
  slides: z.array(SlideShape).max(CALENDAR.slidesMost).optional(),
  script: ScriptShape.nullable().optional(),
  picture: z.string().trim().max(POST_LIMITS.picture).nullable().optional(),
  pictureWay: PictureWay.optional(),
  /** Its pictures in the order they go up: files on the post (added with file.begin_upload and file.confirm). */
  fileIds: z.array(uuid).max(CALENDAR.picturesMost).optional(),
  facebookWhere: z.array(FacebookWhere).max(2).optional(),
  /** When it goes; null for no day yet. */
  postAt: z.iso.datetime().nullable().optional(),
});
export const ContentApproveInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  /** false takes the OK back. */
  ok: z.boolean().default(true),
});
export const ContentApproveWeekInput = z.object({
  workspaceId: uuid,
  /** The week's first day; today when left out. */
  from: LocalDate.optional(),
});
export const ContentApproveWeekOutput = z.object({
  approved: z.number().int(),
  notReady: z.array(z.object({ postId: uuid, title: z.string(), needs: z.string() })),
});
export const ContentSkipInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  /** false brings a skipped post back as a draft. */
  skip: z.boolean().default(true),
});

export const ContentPostNowInput = z.object({ workspaceId: uuid, postId: uuid });

// ------------------------------------------------------------------------------------------------ the extension

/** One of a post's files as the extension fetches it to put up: a picture, or the person's video. */
export const PostFile = z.object({
  bucket: z.string(),
  objectPath: z.string(),
  name: z.string(),
  mimeType: z.string().nullable(),
});

export const PostNextInput = z.object({
  workspaceId: uuid,
  /** The networks this build of the extension posts on, with no warning today. */
  networks: z.array(PostingNetwork).max(POSTING_NETWORKS.length),
  version: z.string().max(20).optional(),
});
export const DuePost = z.object({
  id: uuid,
  title: z.string(),
  network: PostingNetwork,
  format: ContentFormat,
  /** The words as they go up, hashtags at the end. */
  text: z.string(),
  files: z.array(PostFile),
  /** Where it still goes up, in order: places it went up already are left out. */
  places: z.array(PostPlace),
  /** The business's Facebook Page's link, for a post to the Page. */
  facebookPage: z.string().nullable(),
  postAt: z.string().nullable(),
});
export type DuePost = z.infer<typeof DuePost>;
export const PostNextOutput = z.object({ post: DuePost.nullable() });

export const PostWentInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  /** How each place it tried went. */
  went: z
    .array(
      z.object({
        place: PostPlace,
        posted: z.boolean(),
        link: z.url().max(500).nullable().default(null),
        failure: z.string().max(300).nullable().default(null),
      }),
    )
    .max(POST_PLACES.length),
  /**
   * Nothing was pressed (a warning on the network, signed out, Chrome closing): it goes back to waiting and goes up
   * on a later turn, while its time is still recent.
   */
  again: z.boolean().default(false),
  /** Why, when nothing was tried or it stopped before a place. */
  failure: z.string().max(300).nullable().default(null),
});

export const OwnNextInput = z.object({
  workspaceId: uuid,
  /** The networks the extension reads its own posts' numbers on, with no warning today. */
  networks: z.array(PostingNetwork).max(POSTING_NETWORKS.length),
});
export const OwnCheck = z.object({
  id: uuid,
  network: PostingNetwork,
  /** The read: at about 2 days, or at about 7. */
  read: OwnRead,
  /** The places to read, each by its link. */
  places: z.array(z.object({ place: PostPlace, link: z.string() })),
  /** Its words as they went up, to know it among the person's own posts. */
  text: z.string(),
});
export type OwnCheck = z.infer<typeof OwnCheck>;
export const OwnNextOutput = z.object({ check: OwnCheck.nullable() });

const CountIn = z.number().int().min(0).max(2_000_000_000).nullable().default(null);
export const OwnReadInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  read: OwnRead,
  /** What each place showed; a failure when it couldn't be read. */
  reads: z
    .array(
      z.object({
        place: PostPlace,
        views: CountIn,
        likes: CountIn,
        comments: CountIn,
        shares: CountIn,
        failure: z.string().max(300).nullable().default(null),
      }),
    )
    .max(POST_PLACES.length),
});

// ------------------------------------------------------------------------------------------------ the worker

export const WrittenPostShape = z.object({
  title: z.string().trim().min(1).max(POST_LIMITS.title),
  format: ContentFormat,
  hook: z.string().max(POST_LIMITS.hook).nullable(),
  words: z.string().max(3000),
  hashtags: z.array(z.string().max(POST_LIMITS.hashtag)).max(30),
  slides: z.array(SlideShape).max(CALENDAR.slidesMost),
  script: ScriptShape.nullable(),
  picture: z.string().max(POST_LIMITS.picture).nullable(),
  pictureWay: PictureWay,
});

export const ContentPutInput = z.object({
  workspaceId: uuid,
  /** A post written again; left out, a new one. */
  postId: uuid.optional(),
  network: PostingNetwork,
  ideaId: uuid.nullable().default(null),
  postAt: z.iso.datetime().nullable().default(null),
  post: WrittenPostShape,
  /** Who asked for it: kept as who made it. Null when the calendar filled on its own. */
  askedBy: uuid.nullable().default(null),
});
export const ContentPutOutput = z.object({ postId: uuid, created: z.boolean() });

export const ContentPicturedInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  state: z.enum(['waiting', 'making', 'made', 'failed']),
  /** How it's made now, when that changed (Make a photo instead). */
  way: z.enum(['design', 'photo']).optional(),
  /** The pictures it made, in order: they replace the AI's earlier ones. */
  fileIds: z.array(uuid).max(CALENDAR.picturesMost).optional(),
  design: z.record(z.string(), z.unknown()).nullable().optional(),
  failure: z.string().max(300).nullable().optional(),
});

export const CalendarFilledInput = z.object({
  workspaceId: uuid,
  written: z.number().int().min(0),
});
