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
  PICKING,
  PICTURE_WAYS,
  POST_PLACES,
  POSTING,
  POSTING_NETWORKS,
  SHORT_POSTS,
} from './calendar';
import { PICK_WHICH } from './calendar-looks';
import { LINK } from './links';
import { OWN_READS } from './own';
import { POST_LIMITS } from './posts-ai';
import { DESIGN_STYLES } from './design-names';
import {
  AngleShape,
  LearnedPlanShape,
  LinkPlaceShape,
  LinkPlacesShape,
  Network,
  PlanShape,
  TopicShape,
  uuid,
} from './shapes';

export const PostingNetwork = z.enum(POSTING_NETWORKS);
export const ContentFormat = z.enum(CONTENT_FORMATS);
export const PictureWay = z.enum(PICTURE_WAYS);
export const FacebookWhere = z.enum(FACEBOOK_WHERE);
export const PostPlace = z.enum(POST_PLACES);
export { LinkPlaceShape, LinkPlacesShape };

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

/** The words on one of its drawn pictures (design tools, part 6), as the screens show them to change. */
export const PictureWordsShape = z.object({
  layout: z.enum(DESIGN_STYLES),
  kicker: z.string().nullable(),
  heading: z.string(),
  body: z.string().nullable(),
  items: z.array(z.string()),
  mark: z.string().nullable(),
  footer: z.string().nullable(),
});

/** One picture's words as changed by hand: blank parts are left off it. */
const pageText = (most: number, what: string) =>
  z
    .string()
    .trim()
    .max(most, `Keep ${what} under ${most} characters.`)
    .nullable()
    .default(null)
    .transform((t) => t || null);
export const PageWordsInput = z.object({
  kicker: pageText(POST_LIMITS.kicker, 'the small line above the heading'),
  heading: z
    .string()
    .trim()
    .min(1, 'Give each picture a heading.')
    .max(POST_LIMITS.heading, `Keep a heading under ${POST_LIMITS.heading} characters.`),
  body: pageText(POST_LIMITS.body, 'the words under the heading'),
  items: z
    .array(
      z
        .string()
        .trim()
        .max(POST_LIMITS.item, `Keep each item under ${POST_LIMITS.item} characters.`),
    )
    .max(5, 'Keep a picture to 5 items.')
    .default([])
    .transform((items) => items.filter(Boolean)),
  mark: pageText(POST_LIMITS.mark, 'the big number or highlighted words'),
  footer: pageText(POST_LIMITS.footer, 'the line at the bottom'),
});
export type PageWordsInput = z.input<typeof PageWordsInput>;

/** Its pictures' words changed by hand (design tools, part 6): one set for each picture, in order. */
export const ContentRedrawInput = z
  .object({
    postId: uuid,
    pages: z.array(PageWordsInput).min(1).max(CALENDAR.slidesMost),
  })
  .strict();

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
  /** Threads and X (decision 41): the posts under the first in a chain, in order; empty everywhere else. */
  chain: z.array(z.string()),
  slides: z.array(z.object({ heading: z.string(), body: z.string() })),
  script: z.object({ lines: z.array(z.string()), shots: z.array(z.string()) }).nullable(),
  /** What its picture shows, or what to shoot. */
  picture: z.string().nullable(),
  pictureWay: PictureWay,
  pictureState: z.enum(PICTURE_STATES),
  pictureFailure: z.string().nullable(),
  pictures: z.array(ContentPicture),
  /**
   * What the picture check still found wrong with the pictures kept (the owner's pick, 16 Nov), to show beside them;
   * empty when they passed or weren't checked. Default for an older API.
   */
  pictureFlags: z.array(z.string()).default([]),
  /**
   * The words on each of its drawn pictures, to change by hand and draw again at no AI cost (design tools, part 6);
   * null when they can't be: the person's own photo as it is, OpenAI's whole graphic, or a photo made before photos
   * were kept. Default for an older API.
   */
  pictureWords: z.array(PictureWordsShape).nullable().default(null),
  /** The person's own photo its words are designed over, to post it plain again; null otherwise. */
  ownPhotoId: uuid.nullable().default(null),
  facebookWhere: z.array(FacebookWhere),
  state: z.enum(CONTENT_STATES),
  postAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  postedAt: z.string().nullable(),
  postLink: z.string().nullable(),
  /**
   * Each place it went up so far (part 9): its link when the network showed one, and when; and whether its first
   * comment with the business's link went up there (null when it had none to write).
   */
  postedTo: z.array(
    z.object({
      place: PostPlace,
      link: z.string().nullable(),
      at: z.string(),
      comment: z.boolean().nullable().default(null),
    }),
  ),
  /** Its numbers 2 and 7 days after it went up, in each place (part 11), and whether it did well. */
  numbers: OwnNumbersShape,
  doneWell: DoneWellShape.nullable(),
  failure: z.string().nullable(),
  madeBy: z.enum(['ai', 'person']),
  /** Who set its time: AI picks may move one it set to a better hour (decision 27). Defaults, for an older API. */
  placedBy: z.enum(['ai', 'person']).default('ai'),
  /** Its kind in the weekly mix and the line from the lists it's about (decisions 34 to 36). Default for an older API. */
  angle: AngleShape.nullable().default(null),
  topic: TopicShape.nullable().default(null),
  ideaId: uuid.nullable(),
  /** What it still needs before it can be OK'd, in words to show; null when nothing. */
  stillNeeds: z.string().nullable(),
  /**
   * Where its link goes, when its words point people to the business's link (the owner, 24 Nov); null when it
   * carries none. Default for an older API.
   */
  linkPlace: LinkPlaceShape.nullable().default(null),
  /** Hidden from the Calendar, kept under its Hidden filter (the owner, 15 Nov). Default for an older API. */
  hidden: z.boolean().default(false),
  /**
   * Check if it posted (the owner, 15 Nov), for one that didn't post: when the reading computer next looks for it on
   * the network (null when it won't), when it last looked and didn't find it everywhere, and why it couldn't look.
   * Defaults for an older API.
   */
  lookAt: z.string().nullable().default(null),
  lookedAt: z.string().nullable().default(null),
  lookFailure: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Content = z.infer<typeof Content>;

export const SlotShape = z.object({
  network: PostingNetwork,
  date: LocalDate,
  at: z.string(),
  /** An hour AI picks is trying out, to keep learning (decision 26). Defaults, for an older API. */
  trying: z.boolean().default(false),
});

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
  /**
   * A whole week (from Monday) or month (the 6 weeks it shows) in place of `days`: the one with `from` in it, or with
   * today in it when that's left out, so a screen needn't ask what today is first.
   */
  look: z.enum(['week', 'month']).optional(),
});
export const CalendarGetOutput = z.object({
  timeZone: z.string(),
  today: LocalDate,
  from: LocalDate,
  days: z.number().int(),
  plan: PlanShape,
  /** What AI picks learned about the hours on each network. Defaults, for an older API. */
  learned: LearnedPlanShape.optional(),
  /** The plan's places in these days with no post yet (decisions 21 and 22). */
  open: z.array(SlotShape),
  /** Posts going in these days, soonest first, and drafts with no day yet. */
  posts: z.array(Content),
  undated: z.array(Content),
  /**
   * What went up in the 30 days before these days, newest first, with how each did (part 11), and what didn't go up
   * (the owner, 15 Nov).
   */
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
  /** The business's link from the Playbook page, and where it goes on each network. Defaults, for an older API. */
  link: z.string().nullable().default(null),
  linkPlaces: LinkPlacesShape.optional(),
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
  /** Threads and X (decision 41): the posts under the first, in order; an empty one is left out. */
  chain: z.array(z.string().max(POSTING.textMost.threads)).max(SHORT_POSTS.chainMost).optional(),
  slides: z.array(SlideShape).max(CALENDAR.slidesMost).optional(),
  script: ScriptShape.nullable().optional(),
  picture: z.string().trim().max(POST_LIMITS.picture).nullable().optional(),
  pictureWay: PictureWay.optional(),
  /** Its pictures in the order they go up: files on the post (added with file.begin_upload and file.confirm). */
  fileIds: z.array(uuid).max(CALENDAR.picturesMost).optional(),
  facebookWhere: z.array(FacebookWhere).max(2).optional(),
  /** When it goes; null for no day yet. */
  postAt: z.iso.datetime().nullable().optional(),
  /** Where its link goes (the business's, from the Playbook page); null for no link. */
  linkPlace: LinkPlaceShape.nullable().optional(),
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

/** Takes a post off the calendar for good (its record archived: an add-on's records are never deleted), opening its day. */
export const ContentRemoveInput = z.object({ workspaceId: uuid, postId: uuid });
export const ContentRemoveOutput = z.object({
  postId: uuid,
  /** Its day, in the business's time zone, which is open again for another post; null when it had none. */
  openDay: LocalDate.nullable(),
});

export const ContentPostNowInput = z.object({ workspaceId: uuid, postId: uuid });

/**
 * Redo (the owner, 15 Nov): posts that went up wrong or didn't go up, put up again, spaced out on each network. One
 * that went up goes up again everywhere it went; one that didn't go up is tried again where it hadn't.
 */
export const ContentRedoInput = z.object({
  workspaceId: uuid,
  postIds: z.array(uuid).min(1).max(POSTING.redoMost),
});
export const ContentRedoOutput = z.object({
  redone: z.number().int(),
  /** When the last of them goes. */
  lastAt: z.string().nullable(),
  /** Which weren't redone, and why. */
  notRedone: z.array(z.object({ postId: uuid, title: z.string(), why: z.string() })),
});

// ------------------------------------------------------------------------------------------------ picking many

/** Picking many posts on the Calendar (the owner, 15 Nov): the posts a person picked. */
const Picked = z.array(uuid).min(1).max(PICKING.most);
/** The picked posts a command left alone, and why. */
const LeftOut = z.array(z.object({ postId: uuid, title: z.string(), why: z.string() }));

/**
 * Redo on picked posts waiting to go up (the owner, 15 Nov): the worker's `socialcontent.content.rewrite_many` queues
 * each to be written again by the AI, a little apart, in the background.
 */
export const ContentRewriteManyInput = z.object({ postIds: Picked }).strict();
export const ContentRewriteManyOutput = z.object({ asked: z.number().int(), notAsked: LeftOut });

export const ContentApproveManyInput = z.object({ workspaceId: uuid, postIds: Picked });
export const ContentApproveManyOutput = z.object({
  approved: z.number().int(),
  notApproved: LeftOut,
});
/** Hide takes posts off the Calendar, kept under its Hidden filter; hide: false shows them again. */
export const ContentHideInput = z.object({
  workspaceId: uuid,
  postIds: Picked,
  hide: z.boolean().default(true),
});
export const ContentHideOutput = z.object({ changed: z.number().int(), notChanged: LeftOut });
export const ContentRemoveManyInput = z.object({ workspaceId: uuid, postIds: Picked });
export const ContentRemoveManyOutput = z.object({ removed: z.number().int(), notRemoved: LeftOut });
/** Posts that didn't post marked as posted by hand: the person sees them on the network. One may carry its link. */
export const ContentMarkPostedInput = z.object({
  workspaceId: uuid,
  postIds: Picked,
  link: z.url().max(500).nullable().default(null),
});
export const ContentMarkPostedOutput = z.object({ marked: z.number().int(), notMarked: LeftOut });
/** Check if it posted: the reading computer looks on the network for posts that didn't post. */
export const ContentLookInput = z.object({ workspaceId: uuid, postIds: Picked });
export const ContentLookOutput = z.object({ asked: z.number().int(), notAsked: LeftOut });

/**
 * The Pick menu's "all" picks across any date (or the days given): everything, waiting for an OK, OK'd, past (posted
 * or didn't post), didn't post, or hidden. Only "everything" and "hidden" take in hidden posts.
 */
export const ContentPickInput = z.object({
  workspaceId: uuid,
  which: z.enum(PICK_WHICH),
  /** The first day, in the business's time zone, and how many days; any date when left out. */
  from: LocalDate.optional(),
  days: z.number().int().min(1).max(42).optional(),
});
export const PickedPost = z.object({
  id: uuid,
  title: z.string(),
  network: Network,
  state: z.enum(CONTENT_STATES),
  postAt: z.string().nullable(),
  hidden: z.boolean(),
});
export type PickedPost = z.infer<typeof PickedPost>;
export const ContentPickOutput = z.object({
  posts: z.array(PickedPost),
  /** More matched than were listed. */
  more: z.boolean(),
});

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
  /**
   * Threads and X (decision 41): the posts that go under it, in order, as a chain; with the business's link last when
   * it goes in the first comment (a reply there).
   */
  chain: z.array(z.string()).default([]),
  /**
   * The first comment to write under it once it's up in each place, with the business's link (Facebook, LinkedIn and
   * Instagram; the owner, 24 Nov). Null when there's none. Default for an older API.
   */
  comment: z.string().nullable().default(null),
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
        /** Whether its first comment with the business's link went up there; null when it had none to write. */
        comment: z.boolean().nullable().default(null),
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

export const PostLookNextInput = z.object({
  workspaceId: uuid,
  /** The networks the extension posts on, with no warning today. */
  networks: z.array(PostingNetwork).max(POSTING_NETWORKS.length),
});
/** A post that didn't post, to look for on the network by its first words (Check if it posted). */
export const LookPost = z.object({
  id: uuid,
  network: PostingNetwork,
  /** The words as they went up, hashtags at the end: it's found by its first words. */
  text: z.string(),
  /** The places to look in: where it hadn't gone up. */
  places: z.array(PostPlace),
  facebookPage: z.string().nullable(),
  postAt: z.string().nullable(),
  /**
   * A person pressed Check if it posted (or Check again): its window comes in front for the look right away, as a
   * Check's does (the owner, 18 Nov). A look on its own, 10 minutes after a post that may have gone up, comes in front
   * only while they're away (docs/outreach.md, decision 120).
   */
  asked: z.boolean().default(false),
});
export type LookPost = z.infer<typeof LookPost>;
export const PostLookNextOutput = z.object({ post: LookPost.nullable() });
export const PostLookedInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  /** The places it was found in, each with its link when there was one. */
  found: z
    .array(z.object({ place: PostPlace, link: z.url().max(500).nullable().default(null) }))
    .max(POST_PLACES.length),
  /** Why it couldn't look at all (signed out, a warning); null when it looked. */
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
  chain: z.array(z.string().max(POSTING.textMost.threads)).max(SHORT_POSTS.chainMost).default([]),
  slides: z.array(SlideShape).max(CALENDAR.slidesMost),
  script: ScriptShape.nullable(),
  picture: z.string().max(POST_LIMITS.picture).nullable(),
  pictureWay: PictureWay,
  angle: AngleShape.nullable().default(null),
  topic: TopicShape.nullable().default(null),
  /** Where its link goes, when it points people to the business's link (the owner, 24 Nov). */
  linkPlace: LinkPlaceShape.nullable().default(null),
});

export const ContentPutInput = z.object({
  workspaceId: uuid,
  /** A post written again; left out, a new one. */
  postId: uuid.optional(),
  network: PostingNetwork,
  ideaId: uuid.nullable().default(null),
  postAt: z.iso.datetime().nullable().default(null),
  /** Who picked its time: the AI, into the plan's place (AI picks may move it later), or the person who asked. */
  placedBy: z.enum(['ai', 'person']).default('ai'),
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

// ------------------------------------------------------------------------------------------------ your link

/** The business's link for its posts, and where it goes on each network (docs/socialcontent.md, "Your link"). */
export const LinkSaveInput = z.object({
  workspaceId: uuid,
  /** The link; null or empty takes it off. Without http(s):// it's taken as https://. Left out, it stays. */
  link: z.string().trim().max(LINK.most).nullable().optional(),
  /** Where it goes, for each network given: in the post, link in bio, or the first comment. */
  places: z.partialRecord(PostingNetwork, LinkPlaceShape).optional(),
});
export const LinkOut = z.object({
  link: z.string().nullable(),
  places: LinkPlacesShape,
  /** Posts not up yet whose words pointed to a link and now carry it (only when a link was just added). */
  carried: z.number().int().default(0),
});
export type LinkOut = z.infer<typeof LinkOut>;
