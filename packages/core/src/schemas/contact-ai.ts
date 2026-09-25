import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { TagRef } from './crm';

/**
 * The AI's upkeep of customers' tags and details (0107): a pass over the whole list an owner or admin starts and
 * can stop, and the log of every look the AI took. The rules for what it may change are in core's contact-ai.
 */
export const CONTACT_AI_SWEEP_STATUSES = ['running', 'done', 'cancelled', 'failed'] as const;
export type ContactAiSweepStatus = (typeof CONTACT_AI_SWEEP_STATUSES)[number];

export const ContactAiSweepStartInput = z.object({
  workspaceId: uuid,
  /** What to look for, in the person's words ("anyone who asked about solar is Solar interest"). */
  instructions: z.string().trim().max(2000).default(''),
  /** The tags it may put on or take off; empty is every tag the business has. */
  tagIds: z.array(uuid).max(50).default([]),
  /** Only the customers with this tag; left out, everybody. */
  onlyTagId: uuid.nullable().default(null),
  /** Also fill in and correct names, emails, numbers and addresses from what customers said. */
  fixDetails: z.boolean().default(false),
});
export const ContactAiSweepStartOutput = z.object({ sweepId: uuid, total: z.number().int() });

export const ContactAiSweepCancelInput = z.object({ workspaceId: uuid, sweepId: uuid });
export const ContactAiSweepCancelOutput = z.object({ sweepId: uuid, reviewed: z.number().int() });

export const ContactAiSweepOut = z.object({
  id: uuid,
  status: z.enum(CONTACT_AI_SWEEP_STATUSES),
  instructions: z.string(),
  /** The tags it may use; empty is every tag. */
  tags: z.array(TagRef),
  onlyTag: TagRef.nullable(),
  fixDetails: z.boolean(),
  total: z.number().int(),
  reviewed: z.number().int(),
  changed: z.number().int(),
  tagsAdded: z.number().int(),
  tagsRemoved: z.number().int(),
  detailsChanged: z.number().int(),
  note: z.string().nullable(),
  requestedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  createdAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
});
export type ContactAiSweepOut = z.infer<typeof ContactAiSweepOut>;

export const ContactAiStatusInput = z.object({ workspaceId: uuid });
export const ContactAiStatusOutput = z.object({
  /** The pass going now, if any. */
  running: ContactAiSweepOut.nullable(),
  /** The last few, newest first (the running one too). */
  recent: z.array(ContactAiSweepOut),
  /** Settings → Automations: "Tag customers for you" and "Keep contact details up to date". */
  switches: z.object({ tags: z.boolean(), details: z.boolean() }),
  /** The looks it took in the last 7 days, and how many changed something. */
  lastWeek: z.object({ reviewed: z.number().int(), changed: z.number().int() }),
});

export const ContactAiReviewsInput = z.object({
  workspaceId: uuid,
  personId: uuid.optional(),
  sweepId: uuid.optional(),
  /** Only the looks that changed something. */
  changedOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(20),
  /** Looks older than this (the last one's createdAt). */
  before: isoDateTime.optional(),
});
export const ContactAiReviewOut = z.object({
  id: uuid,
  person: z.object({ id: uuid, fullName: z.string() }),
  trigger: z.enum(['activity', 'sweep']),
  sweepId: uuid.nullable(),
  outcome: z.enum(['changed', 'unchanged', 'skipped', 'failed']),
  addedTags: z.array(z.object({ name: z.string(), reason: z.string() })),
  removedTags: z.array(z.object({ name: z.string(), reason: z.string() })),
  details: z.array(
    z.object({
      field: z.string(),
      from: z.string().nullable(),
      to: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  /** What it said that was left alone, and why. */
  skipped: z.array(z.object({ what: z.string(), why: z.string() })),
  note: z.string().nullable(),
  createdAt: isoDateTime,
});
export type ContactAiReviewOut = z.infer<typeof ContactAiReviewOut>;
export const ContactAiReviewsOutput = z.object({
  items: z.array(ContactAiReviewOut),
  nextBefore: isoDateTime.nullable(),
});

export const ContactAiPreviewInput = z.object({
  workspaceId: uuid,
  /** Only the customers with this tag; left out, everybody. */
  onlyTagId: uuid.nullable().default(null),
});
export const ContactAiPreviewOutput = z.object({
  /** How many customers a pass would look at. */
  customers: z.number().int(),
  /** Every tag the business has, the ones a pass may use. */
  tags: z.array(TagRef),
  /** Workflows that start when a customer's tags change: a pass that tags many customers starts them for each. */
  tagWorkflows: z.array(z.object({ id: uuid, name: z.string() })),
});
