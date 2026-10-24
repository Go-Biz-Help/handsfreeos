import { z } from 'zod';
import { uuid } from './common';

/**
 * The ways a stranger reaches a business by themselves (M14 slice A), a message to its Facebook Page or Instagram
 * account (20261025000200), and a lead ad's form or an applicant Indeed emailed about (funnels).
 */
export const IntakeChannelKind = z.enum([
  'text',
  'call',
  'email',
  'messenger',
  'instagram',
  'facebook_lead_ad',
  'indeed',
]);

/** Forms on a business's own website, and services that send leads over (M14 slice B). */
export const IntakeKeyedKind = z.enum(['website_form', 'api']);

export const IntakeSourceUpdateInput = z.object({
  workspaceId: uuid,
  /** A channel, by which one it is; a form or a connected app, by its id. */
  kind: IntakeChannelKind.optional(),
  sourceId: uuid.optional(),
  /** What its customers and leads are filed under. */
  name: z.string().trim().min(1).max(60).optional(),
  /** Off: a stranger on this channel is a conversation and nothing else, the way it was before M14. */
  active: z.boolean().optional(),
  /** Off: the customer record is still made, but no lead opens. */
  createLead: z.boolean().optional(),
  /** Null: the business's default pipeline and its first open stage. */
  pipelineId: uuid.nullable().optional(),
  /** Left out with a pipeline: its first open stage. */
  stageId: uuid.nullable().optional(),
  dailyCap: z.number().int().min(1).max(1000).optional(),
  /** A form's sites, as they would be typed; the www twin is added for you. */
  allowedOrigins: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
  /** Where a plain HTML form's sender goes afterwards. Null answers with JSON instead. */
  redirectUrl: z.string().trim().max(2000).nullable().optional(),
});
export const IntakeSourceUpdateOutput = z.object({
  kind: z.union([IntakeChannelKind, IntakeKeyedKind]),
  sourceId: uuid.nullable(),
  /** The fields that changed. */
  updated: z.array(z.string()),
  /** A form's sites as they were stored. */
  allowedOrigins: z.array(z.string()),
});

export const IntakeSourceCreateInput = z.object({
  workspaceId: uuid,
  kind: IntakeKeyedKind,
  name: z.string().trim().min(1).max(60),
  createLead: z.boolean().default(true),
  pipelineId: uuid.nullable().optional(),
  stageId: uuid.nullable().optional(),
  dailyCap: z.number().int().min(1).max(1000).default(50),
  allowedOrigins: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  redirectUrl: z.string().trim().max(2000).nullable().optional(),
});
export const IntakeSourceCreateOutput = z.object({
  sourceId: uuid,
  /** A form's key, for the page's HTML. */
  publicKey: z.string().nullable(),
  /** A connected app's key. Shown this once and never again. */
  secret: z.string().nullable(),
  allowedOrigins: z.array(z.string()),
});

export const IntakeSourceRefInput = z.object({ workspaceId: uuid, sourceId: uuid });
export const IntakeSourceKeyOutput = z.object({
  sourceId: uuid,
  publicKey: z.string().nullable(),
  secret: z.string().nullable(),
});
export const IntakeSourceArchiveOutput = z.object({ sourceId: uuid, archived: z.boolean() });

export const IntakeSourceView = z.object({
  kind: z.union([IntakeChannelKind, IntakeKeyedKind]),
  /** Null for a channel that has no row yet; every form and key has one. */
  sourceId: uuid.nullable(),
  name: z.string(),
  active: z.boolean(),
  createLead: z.boolean(),
  pipelineId: uuid.nullable(),
  stageId: uuid.nullable(),
  dailyCap: z.number().int(),
  /** How many leads it has opened today, and when the last one came in. */
  todayCount: z.number().int(),
  lastIntakeAt: z.string().nullable(),
  /** Forms and keys only. */
  publicKey: z.string().nullable(),
  secretHint: z.string().nullable(),
  allowedOrigins: z.array(z.string()),
  redirectUrl: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type IntakeSourceViewShape = z.infer<typeof IntakeSourceView>;

export const IntakeListInput = z.object({ workspaceId: uuid });
export const IntakeListOutput = z.object({
  sources: z.array(IntakeSourceView),
  /** The pipelines and stages a channel's leads can be pointed at. */
  pipelines: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      stages: z.array(z.object({ id: uuid, name: z.string(), kind: z.string() })),
    }),
  ),
});

/** What a form or a connected app sent. The worker has checked the key; the business's rules are next. */
export const IntakePayloadInput = z.object({
  name: z.string().trim().max(160).nullable().optional(),
  firstName: z.string().trim().max(80).nullable().optional(),
  lastName: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().max(320).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
  title: z.string().trim().max(160).nullable().optional(),
  valueCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  address: z
    .object({
      line1: z.string().trim().max(200).nullable().optional(),
      line2: z.string().trim().max(200).nullable().optional(),
      city: z.string().trim().max(100).nullable().optional(),
      state: z.string().trim().max(100).nullable().optional(),
      postalCode: z.string().trim().max(20).nullable().optional(),
    })
    .nullable()
    .optional(),
  /** Everything else that was posted, up to 30 fields. */
  extra: z.record(z.string().max(80), z.string().max(2000)).optional(),
});

export const IntakeSubmitInput = z.object({
  workspaceId: uuid,
  sourceId: uuid,
  /** The sender's own id for this submission, or one the worker made from what it sent. */
  dedupeKey: z.string().trim().min(1).max(200),
  payload: IntakePayloadInput,
  occurredAt: z.string().datetime().optional(),
});
/**
 * The worker: Indeed emailed the business about somebody who applied (funnels), and the AI (or, without it, the
 * email's own shapes) read who. The email's Message-ID keeps it to one lead.
 */
export const IndeedApplicantReceiveInput = z.object({
  workspaceId: uuid,
  /** The email's Message-ID, or the mail service's own id for it. */
  emailKey: z.string().trim().min(1).max(998),
  occurredAt: z.string().datetime().optional(),
  applicant: z.object({
    name: z.string().trim().max(160).nullable(),
    /** Often Indeed's relay for them, which reaches them all the same. */
    email: z.string().trim().max(320).nullable(),
    phone: z.string().trim().max(40).nullable(),
    job: z.string().trim().max(160).nullable(),
    location: z.string().trim().max(160).nullable(),
  }),
});
export const IntakeSubmitOutput = z.object({
  outcome: z.enum(['opened', 'matched', 'refused']),
  personId: uuid.nullable(),
  leadId: uuid.nullable(),
  submissionId: uuid,
  /** The sender had already sent this one: the same answer comes back, and nothing opened twice. */
  duplicate: z.boolean(),
  refusedReason: z.enum(['turned_off', 'no_contact', 'over_limit']).nullable(),
});
