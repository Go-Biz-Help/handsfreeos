/**
 * Automations' "Outreach campaigns" (stage 5): one text to a list of customers picked by tag or pipeline stage,
 * written per person by the AI from the owner's goal, approved on one screen, and sent a few an hour.
 *
 * Or one email (email campaigns): the AI drafts one subject and body, the owner changes it, and only
 * {first_name} changes per person. Every email carries an unsubscribe link and the business's address.
 *
 * Or calls (AI outbound calls): the AI teammate rings each person who agreed to calls in writing. The AI writes
 * one opening line for them all ("about our fall tune-up, which is $89 this month"), the owner changes it, and it
 * finishes "I'm calling …" on every call. A call campaign can keep adding people (AI calls, part 4): anyone who later
 * gets one of its tags or reaches one of its stages, and agrees to calls in writing, joins and is called at its
 * pace, until it's stopped.
 */
import { z } from 'zod';
import { aiCallOutcome, aiCallStatus } from './ai-call';
import { isoDateTime, uuid } from './common';
import { requiredEmail } from './message';

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

/** Texts, one email, or calls. */
export const CAMPAIGN_CHANNELS = ['sms', 'email', 'call'] as const;
export const campaignChannel = z.enum(CAMPAIGN_CHANNELS);
export type CampaignChannel = z.infer<typeof campaignChannel>;

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
  // Email campaigns.
  'no_email',
  'unsubscribed',
  'email_stopped',
  'emailed_recently',
  // Call campaigns.
  'no_call_consent',
  'called_recently',
  // No yes, and the phone company says the number isn't a business landline (AI calls, part 5).
  'not_business_landline',
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
/** An email campaign's subject and body. */
export const CAMPAIGN_EMAIL_SUBJECT_MAX = 150;
export const CAMPAIGN_EMAIL_BODY_MAX = 8000;
/** A call campaign's opening line: it finishes "I'm calling …". */
export const CAMPAIGN_CALL_OPENING_MAX = 200;
/** The one placeholder an email campaign fills per person. */
export const FIRST_NAME_PLACEHOLDER = '{first_name}';

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
  /** Texts (the default), one email, or calls. */
  channel: campaignChannel.default('sms'),
  /**
   * The exact words to send instead of the AI writing them (Real Estate round three: a listing's words, already read
   * for fair housing): the text everyone gets, or the email's subject and body. Never for calls.
   */
  words: z
    .object({
      text: z.string().trim().min(1, 'Write the text.').max(CAMPAIGN_DRAFT_MAX).optional(),
      subject: z
        .string()
        .trim()
        .min(1, 'Write a subject.')
        .max(CAMPAIGN_EMAIL_SUBJECT_MAX)
        .optional(),
      body: z.string().trim().min(1, 'Write something.').max(CAMPAIGN_EMAIL_BODY_MAX).optional(),
    })
    .nullable()
    .default(null),
  /**
   * A call campaign only: keep adding anyone who later gets one of the tags or reaches one of the stages and agrees
   * to calls in writing, until it's stopped. It may start with nobody to call yet.
   */
  keepAdding: z.boolean().default(false),
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
export const CampaignUpdateEmailInput = z.object({
  workspaceId: uuid,
  campaignId: uuid,
  subject: z.string().trim().min(1, 'Write a subject.').max(CAMPAIGN_EMAIL_SUBJECT_MAX),
  body: z.string().trim().min(1, 'Write something.').max(CAMPAIGN_EMAIL_BODY_MAX),
});
export const CampaignUpdateCallInput = z.object({
  workspaceId: uuid,
  campaignId: uuid,
  opening: z
    .string()
    .trim()
    .min(1, 'Say what it’s calling about.')
    .max(CAMPAIGN_CALL_OPENING_MAX, `Keep it under ${CAMPAIGN_CALL_OPENING_MAX} characters.`),
});
export const CampaignRecipientRef = z.object({ workspaceId: uuid, recipientId: uuid });
export const CampaignRecipientOutput = z.object({ recipientId: uuid, status: recipientStatus });

export const CampaignSetPaceInput = z.object({
  workspaceId: uuid,
  campaignId: uuid,
  perHour,
});
export const CampaignSetKeepAddingInput = z.object({
  workspaceId: uuid,
  campaignId: uuid,
  /** On: anyone who later fits and agrees to calls joins. Off: it finishes once everyone it has is called. */
  on: z.boolean(),
});

/** Worker: someone asked for no more campaign email (the page's button, their mail app's, or Postmark's). */
export const EMAIL_UNSUBSCRIBE_SOURCES = ['link', 'one_click', 'postmark'] as const;
export const EmailUnsubscribeRecordInput = z.object({
  workspaceId: uuid,
  address: requiredEmail,
  campaignId: uuid.nullable().default(null),
  source: z.enum(EMAIL_UNSUBSCRIBE_SOURCES),
});
export const EmailUnsubscribeRecordOutput = z.object({
  /** False when they had unsubscribed already. */
  created: z.boolean(),
});

// ---------- queries ----------

export const CampaignPreviewInput = z.object({
  workspaceId: uuid,
  audience: CampaignAudience,
  channel: campaignChannel.default('sms'),
});
export const CampaignPreviewOutput = z.object({
  /** Who it would write to. */
  recipients: z.number().int(),
  /** Who's left out, by reason. */
  skipped: z.record(z.string(), z.number().int()),
  /** Email: the address every email shows, or null when the business hasn't given one (it can't send then). */
  postalAddress: z.string().nullable(),
  /**
   * Calls: of those it would call, how many have no yes and are called only if the phone company says their number
   * is a business landline (with Call business landlines without a yes on).
   */
  landlineChecks: z.number().int().default(0),
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
  channel: campaignChannel,
  status: campaignStatus,
  /** Why HandsFreeOS paused it (`email_campaigns_not_ready`, `texting_not_ready`, …); null when a person did. */
  pausedReason: z.string().nullable(),
  perHour: z.number().int(),
  /** A call campaign that keeps adding anyone who later fits and agrees to calls (false for the others). */
  keepAdding: z.boolean(),
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
  email: z.string().nullable(),
  status: recipientStatus,
  skipReason: z.string().nullable(),
  draft: z.string().nullable(),
  edited: z.boolean(),
  sentAt: isoDateTime.nullable(),
  error: z.string().nullable(),
  /** A call campaign: how this person's call went (null for texts and email, and before it's made). */
  call: z
    .object({
      status: aiCallStatus,
      outcome: aiCallOutcome.nullable(),
      summary: z.string().nullable(),
    })
    .nullable(),
});

export const CampaignGetOutput = z.object({
  campaign: CampaignSummary.extend({
    audience: z.object({ tagIds: z.array(uuid), stageIds: z.array(uuid) }),
    /** An email campaign's one email (null for texts, and while the AI writes it). */
    email: z
      .object({
        subject: z.string().nullable(),
        body: z.string().nullable(),
        edited: z.boolean(),
        /** The business's address, shown under every email. */
        postalAddress: z.string().nullable(),
      })
      .nullable(),
    /** A call campaign's opening line (null for texts and email, and while the AI writes it). */
    call: z
      .object({
        opening: z.string().nullable(),
        edited: z.boolean(),
      })
      .nullable(),
  }),
  recipients: z.array(CampaignRecipientOut),
  /** When the next text goes, while it sends. */
  nextSendAt: isoDateTime.nullable(),
});
