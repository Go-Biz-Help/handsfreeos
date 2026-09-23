/**
 * Ideas, the roadmap and What's new (0102): what the board sends and gets back, for the people who share and
 * vote and for the team who answer. Browser-safe.
 */
import { z } from 'zod';
import { IDEA_SORTS, IDEA_STATUSES, WHATS_NEW_KINDS } from '../ideas/words';
import { isoDateTime, uuid } from './common';

export const IdeaStatusValue = z.enum(IDEA_STATUSES);
export type IdeaStatusValue = z.infer<typeof IdeaStatusValue>;
export const IdeaSortValue = z.enum(IDEA_SORTS);
export const WhatsNewKindValue = z.enum(WHATS_NEW_KINDS);
export const IdeaUpdateKindValue = z.enum(['status', 'merged', 'merged_in']);

const areaId = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Pick what it is about.');
const title = z
  .string()
  .trim()
  .min(3, 'Give it a title of a few words.')
  .max(140, 'Keep the title under 140 characters.');
const details = z.string().trim().max(5000, 'Keep the details under 5,000 characters.').default('');
const commentBody = z
  .string()
  .trim()
  .min(1, 'Write something first.')
  .max(5000, 'Keep it under 5,000 characters.');
const note = z.string().trim().max(2000, 'Keep the note under 2,000 characters.');
const cursor = z.string().max(40).optional();

/** Somebody named beside an idea, a comment or an update, the way other businesses see them. */
const Person = z.object({
  /** "Dale R.", or the name a member of the team chose. Empty for somebody who has left. */
  name: z.string(),
  /** The one reading it. */
  you: z.boolean(),
});

const IdeaRef = z.object({ id: uuid, number: z.int(), title: z.string() });

// ---------- the board ----------

export const IdeaSummary = z.object({
  id: uuid,
  number: z.int(),
  title: z.string(),
  /** The start of the details, whole words. */
  excerpt: z.string(),
  areaId: z.string(),
  status: IdeaStatusValue,
  voteCount: z.int(),
  commentCount: z.int(),
  author: Person,
  /** Whether the one reading it has voted for it. */
  voted: z.boolean(),
  createdAt: isoDateTime,
  statusChangedAt: isoDateTime.nullable(),
});
export type IdeaSummary = z.infer<typeof IdeaSummary>;

export const IdeaListInput = z.object({
  sort: IdeaSortValue.default('trending'),
  /** `open` is everything still being voted on; `all` includes done and not planned. */
  status: z.union([z.enum(['open', 'all']), IdeaStatusValue]).default('open'),
  areaId: areaId.optional(),
  search: z.string().trim().max(200).optional(),
  /** Only the ideas the reader shared, voted for, or follows. */
  mine: z.enum(['shared', 'voted', 'following']).optional(),
  limit: z.int().min(1).max(50).default(20),
  cursor,
});
export const IdeaListOutput = z.object({
  ideas: z.array(IdeaSummary),
  nextCursor: z.string().nullable(),
});

export const IdeaGetInput = z.object({ ideaId: uuid });

export const IdeaComment = z.object({
  id: uuid,
  body: z.string(),
  author: Person.extend({
    /** Written by somebody on the HandsFreeOS team when they wrote it. */
    team: z.boolean(),
  }),
  /** Taken down. Only the team is ever shown one. */
  hidden: z.boolean(),
  createdAt: isoDateTime,
});

export const IdeaUpdate = z.object({
  id: uuid,
  kind: IdeaUpdateKindValue,
  fromStatus: IdeaStatusValue.nullable(),
  toStatus: IdeaStatusValue.nullable(),
  /** What the team said to the people following it. */
  note: z.string(),
  /** The other idea in a merge. */
  other: IdeaRef.nullable(),
  /** The What's new entry that shipped it. */
  whatsNew: z.object({ id: uuid, title: z.string() }).nullable(),
  by: z.string(),
  createdAt: isoDateTime,
});

export const IdeaGetOutput = z.object({
  idea: IdeaSummary.extend({
    body: z.string(),
    /** Whether the one reading it is told when it moves. */
    following: z.boolean(),
    /** Its author may still fix their own words: nobody here has answered it yet. */
    canEdit: z.boolean(),
    /** Whether votes are still being taken. */
    votingOpen: z.boolean(),
    /** Where a duplicate went. */
    mergedInto: IdeaRef.nullable(),
    /** Taken down by the team; only its author and the team see it. */
    hidden: z.boolean(),
  }),
  comments: z.array(IdeaComment),
  updates: z.array(IdeaUpdate),
  /** What's new entries that delivered it. */
  shipped: z.array(z.object({ id: uuid, title: z.string(), publishedAt: isoDateTime })),
});

export const IdeaSimilarInput = z.object({
  /** What they have typed so far. */
  text: z.string().trim().max(300),
  excludeIdeaId: uuid.optional(),
});
export const IdeaSimilarOutput = z.object({
  ideas: z.array(
    z.object({
      id: uuid,
      number: z.int(),
      title: z.string(),
      status: IdeaStatusValue,
      voteCount: z.int(),
      voted: z.boolean(),
    }),
  ),
});

export const RoadmapCard = z.object({
  id: uuid,
  number: z.int(),
  title: z.string(),
  areaId: z.string(),
  voteCount: z.int(),
  voted: z.boolean(),
  statusChangedAt: isoDateTime.nullable(),
});
export const RoadmapInput = z.object({});
export const RoadmapOutput = z.object({
  planned: z.array(RoadmapCard),
  inProgress: z.array(RoadmapCard),
  /** Shipped in the last ninety days, newest first. */
  done: z.array(RoadmapCard),
});

export const IdeaAreasInput = z.object({});
export const IdeaAreasOutput = z.object({
  areas: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      sort: z.int(),
      archived: z.boolean(),
      /** Ideas still being voted on. */
      openCount: z.int(),
    }),
  ),
});

// ---------- taking part ----------

export const IdeaShareInput = z.object({
  /** The business they are in when they share it. The team's to know, nobody else's. */
  workspaceId: uuid.optional(),
  title,
  body: details,
  areaId: areaId.default('other'),
});
export const IdeaShareOutput = z.object({ ideaId: uuid, number: z.int() });

export const IdeaEditInput = z.object({
  ideaId: uuid,
  title,
  body: details,
  areaId,
});
export const IdeaWriteOutput = z.object({ ideaId: uuid });

export const IdeaVoteInput = z.object({
  ideaId: uuid,
  /** The business they vote from, as on sharing. */
  workspaceId: uuid.optional(),
});
export const IdeaVoteOutput = z.object({ ideaId: uuid, voted: z.boolean(), voteCount: z.int() });

export const IdeaFollowInput = z.object({ ideaId: uuid, following: z.boolean() });
export const IdeaFollowOutput = z.object({ ideaId: uuid, following: z.boolean() });

export const IdeaCommentInput = z.object({ ideaId: uuid, body: commentBody });
export const IdeaCommentOutput = z.object({ commentId: uuid });

export const IdeaCommentHiddenInput = z.object({ commentId: uuid, hidden: z.boolean() });
export const IdeaCommentHiddenOutput = z.object({ commentId: uuid, hidden: z.boolean() });

// ---------- the team ----------

export const IdeaSetStatusInput = z.object({
  ideaId: uuid,
  status: IdeaStatusValue,
  /** What to tell the people following it. Shown on the idea too. */
  note: note.default(''),
  /** Email everybody following it. On unless the team says otherwise. */
  notify: z.boolean().default(true),
});
export const IdeaSetStatusOutput = z.object({
  ideaId: uuid,
  status: IdeaStatusValue,
  updateId: uuid.nullable(),
});

export const IdeaMergeInput = z.object({
  ideaId: uuid,
  intoIdeaId: uuid,
  note: note.default(''),
  notify: z.boolean().default(true),
});
export const IdeaMergeOutput = z.object({
  ideaId: uuid,
  intoIdeaId: uuid,
  movedVotes: z.int(),
  movedFollowers: z.int(),
});

export const IdeaSetHiddenInput = z.object({ ideaId: uuid, hidden: z.boolean() });
export const IdeaSetHiddenOutput = z.object({ ideaId: uuid, hidden: z.boolean() });

export const IdeaTriageInput = z.object({
  /** `board` is everything people can see; `hidden` what the team took down; `merged` the duplicates. */
  show: z.enum(['board', 'hidden', 'merged']).default('board'),
  status: z.union([z.literal('all'), IdeaStatusValue]).default('under_review'),
  sort: IdeaSortValue.default('top'),
  areaId: areaId.optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.int().min(1).max(100).default(30),
  cursor,
});
const TeamPerson = z.object({ userId: uuid, name: z.string(), email: z.string() });
const TeamBusiness = z.object({ id: uuid, name: z.string() });
export const IdeaTriageOutput = z.object({
  ideas: z.array(
    IdeaSummary.omit({ voted: true }).extend({
      author: TeamPerson.nullable(),
      business: TeamBusiness.nullable(),
      /** How many different businesses voted for it: what "a lot of people want this" really means. */
      businessCount: z.int(),
      hidden: z.boolean(),
      mergedInto: IdeaRef.nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
  counts: z.object({
    under_review: z.int(),
    planned: z.int(),
    in_progress: z.int(),
    done: z.int(),
    not_planned: z.int(),
    hidden: z.int(),
  }),
});

export const IdeaTeamViewInput = z.object({ ideaId: uuid });
export const IdeaTeamViewOutput = z.object({
  author: TeamPerson.nullable(),
  business: TeamBusiness.nullable(),
  businessCount: z.int(),
  voters: z.array(
    z.object({
      userId: uuid,
      name: z.string(),
      email: z.string(),
      business: TeamBusiness.nullable(),
      votedAt: isoDateTime,
    }),
  ),
  /** How many people would be emailed if it moved now. */
  followerCount: z.int(),
});

export const IdeaAreaSaveInput = z.object({
  /** New when it does not exist yet. */
  id: areaId,
  name: z.string().trim().min(1, 'Name it.').max(60),
  description: z.string().trim().max(300).default(''),
  sort: z.int().min(0).max(100000).default(500),
  archived: z.boolean().default(false),
});
export const IdeaAreaSaveOutput = z.object({ id: z.string(), created: z.boolean() });

// ---------- What's new ----------

export const WhatsNewEntry = z.object({
  id: uuid,
  title: z.string(),
  body: z.string(),
  kind: WhatsNewKindValue,
  areaId: z.string().nullable(),
  /** Null while it is a draft (only the team sees those). */
  publishedAt: isoDateTime.nullable(),
  /** The ideas it delivers: "asked for in …". */
  ideas: z.array(
    IdeaRef.extend({
      voteCount: z.int(),
      status: IdeaStatusValue,
    }),
  ),
  /** Published since the reader last looked. */
  unseen: z.boolean(),
  updatedAt: isoDateTime,
});

export const WhatsNewListInput = z.object({
  /** Drafts as well, for the team. */
  includeDrafts: z.boolean().default(false),
  limit: z.int().min(1).max(50).default(20),
  cursor,
});
export const WhatsNewListOutput = z.object({
  entries: z.array(WhatsNewEntry),
  nextCursor: z.string().nullable(),
});

export const WhatsNewUnseenInput = z.object({});
export const WhatsNewUnseenOutput = z.object({
  /** Published since the reader last opened What's new (all of them, for someone who never has). */
  unseen: z.int(),
});

export const WhatsNewSeenInput = z.object({});
export const WhatsNewSeenOutput = z.object({ seenAt: isoDateTime });

export const WhatsNewSaveInput = z.object({
  /** Left out for a new draft. */
  id: uuid.optional(),
  title: z
    .string()
    .trim()
    .min(3, 'Give it a title of a few words.')
    .max(140, 'Keep the title under 140 characters.'),
  body: z.string().trim().max(20000, 'Keep it under 20,000 characters.').default(''),
  kind: WhatsNewKindValue.default('new'),
  areaId: areaId.nullable().default(null),
  /** The ideas it delivers. */
  ideaIds: z.array(uuid).max(20).default([]),
});
export const WhatsNewSaveOutput = z.object({ id: uuid, created: z.boolean() });

export const WhatsNewPublishInput = z.object({
  id: uuid,
  /** Mark the ideas it delivers Done, and email the people following them. */
  markIdeasDone: z.boolean().default(true),
});
export const WhatsNewPublishOutput = z.object({
  id: uuid,
  publishedAt: isoDateTime,
  /** The ideas this moved to Done. */
  ideasDone: z.int(),
});

export const WhatsNewRefInput = z.object({ id: uuid });
export const WhatsNewRefOutput = z.object({ id: uuid });
