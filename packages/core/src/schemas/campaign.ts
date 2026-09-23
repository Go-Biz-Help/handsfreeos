/**
 * Automations' "Outreach campaigns" (stage 5): one text to a list of customers picked by tag or pipeline stage,
 * written per person by the AI from the owner's goal, approved on one screen, and sent a few an hour.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const CAMPAIGN_STATUSES = [
  'drafting',
  'review',
  'sending',
  'paused',
  'done',
  'cancelled',
] as const;
export const campaignStatus = z.enum(CAMPAIGN_STATUSES);
export type CampaignStatus = z.infer<typeof campaignStatus>;

export const RECIPIENT_STATUSES = [
  'drafting',
  'ready',
  'skipped',
  'removed',
  'approved',
  'sent',
  'failed',
] as const;
export const recipientStatus = z.enum(RECIPIENT_STATUSES);

/** Why someone picked isn't sent to. */
export const SKIP_REASONS = [
  'no_phone',
  'not_opted_in',
  'texted_recently',
  'in_conversation',
  'booked_soon',
  'no_draft',
  'not_sent',
] as const;
export const skipReason = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof skipReason>;

/** How many texts an hour, and the default. */
export const CAMPAIGN_PER_HOUR_MAX = 200;
export const CAMPAIGN_PER_HOUR_DEFAULT = 20;
export const perHour = z
  .int()
  .min(1, 'At least 1 an hour.')
  .max(CAMPAIGN_PER_HOUR_MAX, `At most ${CAMPAIGN_PER_HOUR_MAX} an hour.`);
/** The longest text a draft may be (three text segments). */
export const CAMPAIGN_DRAFT_MAX = 480;

export const CampaignAudience = z
  .object({
    tagIds: z.array(uuid).max(20).default([]),
    stageIds: z.array(uuid).max(20).default([]),
  })
  .refine((a) => a.tagIds.length + a.stageIds.length > 0, {
    message: 'Pick at least one tag or stage.',
  });
export type CampaignAudience = z.infer<typeof CampaignAudience>;

// ---------- commands ----------

export const CampaignCreateInput = z.object({
  workspaceId: uuid,
  name: z.string().trim().min(1, 'Name it.').max(120),
  goal: z.string().trim().min(1, 'Say what it’s for.').max(500),
  audience: CampaignAudience,
  perHour: perHour.default(CAMPAIGN_PER_HOUR_DEFAULT),
  /** An offer from Knowledge → Offers the texts are about: the AI gets its details and end date. */
  offerId: uuid.nullable().default(null),
});
export const CampaignCreateOutput = z.object({
  campaignId: uuid,
  /** People it will write to, and people left out. */
  recipients: z.number().int(),
  skipped: z.number().int(),
});

export const CampaignRef = z.object({ workspaceId: uuid, campaignId: uuid });
export const CampaignStateOutput = z.object({ campaignId: uuid, status: campaignStatus });

export const CampaignUpdateDraftInput = z.object({
  workspaceId: uuid,
  recipientId: uuid,
  draft: z.string().trim().min(1, 'Write something.').max(CAMPAIGN_DRAFT_MAX),
});
export const CampaignRecipientRef = z.object({ workspaceId: uuid, recipientId: uuid });
export const CampaignRecipientOutput = z.object({ recipientId: uuid, status: recipientStatus });

export const CampaignSetPaceInput = z.object({
  workspaceId: uuid,
  campaignId: uuid,
  perHour,
});

// ---------- queries ----------

export const CampaignPreviewInput = z.object({ workspaceId: uuid, audience: CampaignAudience });
export const CampaignPreviewOutput = z.object({
  /** Who it would write to. */
  recipients: z.number().int(),
  /** Who's left out, by reason. */
  skipped: z.record(z.string(), z.number().int()),
});

export const CampaignCounts = z.object({
  total: z.number().int(),
  drafting: z.number().int(),
  ready: z.number().int(),
  approved: z.number().int(),
  sent: z.number().int(),
  skipped: z.number().int(),
  removed: z.number().int(),
  failed: z.number().int(),
});

export const CampaignSummary = z.object({
  id: uuid,
  name: z.string(),
  goal: z.string(),
  status: campaignStatus,
  perHour: z.number().int(),
  counts: CampaignCounts,
  /** The offer it's about, if any. */
  offer: z.object({ id: uuid, name: z.string() }).nullable(),
  createdAt: isoDateTime,
  approvedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
});

export const CampaignListInput = z.object({ workspaceId: uuid });
export const CampaignListOutput = z.object({ items: z.array(CampaignSummary) });

export const CampaignRecipientOut = z.object({
  id: uuid,
  personId: uuid,
  name: z.string(),
  phone: z.string().nullable(),
  status: recipientStatus,
  skipReason: z.string().nullable(),
  draft: z.string().nullable(),
  edited: z.boolean(),
  sentAt: isoDateTime.nullable(),
  error: z.string().nullable(),
});

export const CampaignGetOutput = z.object({
  campaign: CampaignSummary.extend({
    audience: z.object({ tagIds: z.array(uuid), stageIds: z.array(uuid) }),
  }),
  recipients: z.array(CampaignRecipientOut),
  /** When the next text goes, while it sends. */
  nextSendAt: isoDateTime.nullable(),
});
