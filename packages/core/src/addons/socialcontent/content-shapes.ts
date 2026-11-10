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
  POSTING_NETWORKS,
} from './calendar';
import { POST_LIMITS } from './posts-ai';
import { Network, PlanShape, uuid } from './shapes';

export const PostingNetwork = z.enum(POSTING_NETWORKS);
export const ContentFormat = z.enum(CONTENT_FORMATS);
export const PictureWay = z.enum(PICTURE_WAYS);
export const FacebookWhere = z.enum(FACEBOOK_WHERE);

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
  /** When it last filled the calendar, and when it fills again on its own (null until it first fills). */
  filledAt: z.string().nullable(),
  nextFillAt: z.string().nullable(),
  /** Ideas saved to make, which a fill uses first. */
  ideasSaved: z.number().int(),
  /** Posts OK'd and waiting to go: posting itself comes with the next updates. */
  ready: z.number().int(),
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
