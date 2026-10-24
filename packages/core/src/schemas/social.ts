/**
 * Facebook Messenger and Instagram direct messages, and where the people writing them came from (20261025000200).
 *
 * No token is ever in a shape a browser sees. The worker seals them before any command hears of them, and only
 * the worker's own commands carry the sealed text.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const metaPlatform = z.enum(['facebook', 'instagram']);
export const socialChannel = z.enum(['messenger', 'instagram']);
/** Why a Page or account needs somebody: its sign-in stopped working, the app was removed, or Meta kept refusing. */
export const metaProblem = z.enum(['reauth', 'revoked', 'failed']);

const metaId = z.string().regex(/^[0-9]{1,40}$/, 'Not a Meta id.');
const scopedId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, 'Not a page-scoped id.');
const sealed = z.string().min(10).max(20000);

// ---------------------------------------------------------------------------------------------------- connecting

export const MetaConnectInput = z.object({ workspaceId: uuid });
export const MetaConnectOutput = z.object({ connectionId: uuid, state: z.string() });

/** The worker, once somebody signed in: whose sign-in it is and what they granted. The token comes sealed. */
export const MetaConnectionActivateInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  facebookUserId: metaId,
  facebookUserName: z.string().trim().min(1).max(200).nullable().default(null),
  scopes: z.array(z.string().max(120)).max(60).default([]),
  tokenEnc: sealed,
  tokenKeyId: z.string().min(1).max(64),
  /** Null: Facebook says it never expires (a system user's). */
  tokenExpiresAt: isoDateTime.nullable(),
});
export const MetaConnectionOutput = z.object({ connectionId: uuid });

export const MetaConnectionDisconnectInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  /** The worker's: the person removed the app on Facebook (revoked). People always disconnect as themselves. */
  reason: z.enum(['person', 'revoked', 'failed']).optional(),
  /**
   * The worker's: Facebook asked HandsFreeOS to delete what it knows about the person who signed in, so who they are
   * goes with their token. Works on a sign-in that's already disconnected too.
   */
  forget: z.boolean().optional(),
});
export const MetaConnectionDisconnectOutput = z.object({
  connectionId: uuid,
  /** The Pages and accounts that stopped with it. */
  accountIds: z.array(uuid),
});

/** The worker: a Page, or an Instagram account linked to it, that the person picked. The Page's token comes sealed. */
export const MetaAccountConnectInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  platform: metaPlatform,
  externalId: metaId,
  pageId: metaId,
  name: z.string().trim().min(1).max(200),
  username: z.string().trim().min(1).max(100).nullable().default(null),
  tokenEnc: sealed,
  tokenKeyId: z.string().min(1).max(64),
  humanAgent: z.boolean().default(false),
  /** Meta agreed to send its messages here. False when asking failed; the daily check asks again. */
  subscribed: z.boolean(),
});
export const MetaAccountConnectOutput = z.object({
  accountId: uuid,
  /** It was here before (disconnected, or needing attention) and now works again, threads and all. */
  reconnected: z.boolean(),
});

export const MetaAccountDisconnectInput = z.object({
  workspaceId: uuid,
  accountId: uuid,
  /** The worker's alone: the app was removed on Facebook, or another business connected it. */
  reason: z.enum(['person', 'revoked', 'failed', 'moved']).optional(),
});
export const MetaAccountOutput = z.object({ accountId: uuid, changed: z.boolean() });

export const MetaAccountFailInput = z.object({
  workspaceId: uuid,
  accountId: uuid,
  problem: metaProblem,
  /** What Meta said, kept for support. Never shown as it is: the screen words come from `problem`. */
  reason: z.string().max(2000),
});

export const MetaAccountRecoverInput = z.object({
  workspaceId: uuid,
  accountId: uuid,
  /** Meta agreed to send its messages here again. */
  subscribed: z.boolean().optional(),
  /** Whether Meta has approved the Human Agent tag for the app, as the worker is set up now. */
  humanAgent: z.boolean().optional(),
});

// ------------------------------------------------------------------------------------------------------ receiving

/** What Meta said about the ad or link somebody came from, as it said it. */
export const SocialReferral = z.object({
  /** ADS, SHORTLINK, CUSTOMER_CHAT_PLUGIN … */
  source: z.string().max(60).nullable().default(null),
  /** OPEN_THREAD … */
  type: z.string().max(60).nullable().default(null),
  ref: z.string().max(500).nullable().default(null),
  adId: z
    .string()
    .regex(/^[0-9A-Za-z_-]{1,64}$/)
    .nullable()
    .default(null),
  adTitle: z.string().max(1000).nullable().default(null),
  photoUrl: z.string().max(2000).nullable().default(null),
  videoUrl: z.string().max(2000).nullable().default(null),
  postId: z.string().max(200).nullable().default(null),
  productId: z.string().max(200).nullable().default(null),
  refererUri: z.string().max(2000).nullable().default(null),
  /** The whole referral, so a field Meta adds later is already kept. */
  raw: z.record(z.string(), z.unknown()).default({}),
});
export type SocialReferral = z.infer<typeof SocialReferral>;

/** Something sent with the words: a photo, a voice message, a shared post. The worker copies what can be kept. */
export const SocialAttachmentIn = z.object({
  /** Meta's type: image, video, audio, file, sticker, share, story_mention, ig_reel … */
  type: z.string().min(1).max(40),
  url: z.string().max(4000).nullable().default(null),
  title: z.string().max(500).nullable().default(null),
});

export const SocialReceiveInput = z.object({
  workspaceId: uuid,
  accountId: uuid,
  /**
   * message: the customer wrote; echo: the business wrote, somewhere other than HandsFreeOS (Facebook's own inbox,
   * the Instagram app); postback: they tapped a button (Get Started); referral: they came back to the thread from
   * an ad or a link, without writing yet.
   */
  kind: z.enum(['message', 'echo', 'postback', 'referral']),
  /** The customer, as this Page or account knows them. For an echo, still the customer: whom it was sent to. */
  scopedId,
  /** Meta's id for the message. */
  mid: z.string().min(1).max(300).nullable().default(null),
  /** The stored webhook's own key: a touch with no message is kept once by it. */
  eventKey: z.string().min(1).max(300),
  text: z.string().max(20000).nullable().default(null),
  attachments: z.array(SocialAttachmentIn).max(20).default([]),
  /** Which message they answered (a reply in the thread, or to the business's story). */
  replyToMid: z.string().max(300).nullable().default(null),
  storyReply: z.boolean().default(false),
  /** The button a postback came from, as it was labelled. */
  postbackTitle: z.string().max(500).nullable().default(null),
  referral: SocialReferral.nullable().default(null),
  /** Their name and @handle, when Meta shares them. */
  profile: z
    .object({
      name: z.string().max(200).nullable().default(null),
      username: z.string().max(100).nullable().default(null),
    })
    .nullable()
    .default(null),
  occurredAt: isoDateTime,
});
export const SocialReceiveOutput = z.object({
  /** recorded; duplicate: Meta sent it twice; ignored: nothing to keep (the account is gone, or it was ours). */
  outcome: z.enum(['recorded', 'duplicate', 'ignored']),
  messageId: uuid.nullable(),
  conversationId: uuid.nullable(),
  personId: uuid.nullable(),
  contactId: uuid.nullable(),
  touchId: uuid.nullable(),
});

/** Messenger's delivery and read receipts (every message up to a moment), and Instagram's "Seen" (one message). */
export const SocialReceiptInput = z.object({
  workspaceId: uuid,
  accountId: uuid,
  scopedId,
  kind: z.enum(['delivered', 'read']),
  /** Every message the business sent before this moment. */
  watermark: isoDateTime.nullable().default(null),
  /** These messages, and every one sent before them. */
  mids: z.array(z.string().min(1).max(300)).max(100).default([]),
});
export const SocialReceiptOutput = z.object({ updated: z.number().int() });

/** The customer changed what they wrote, or took it back. */
export const SocialEditInput = z.object({
  workspaceId: uuid,
  accountId: uuid,
  mid: z.string().min(1).max(300),
  /** The newest words. Ignored when it was taken back. */
  text: z.string().max(20000).nullable().default(null),
  unsent: z.boolean().default(false),
  occurredAt: isoDateTime,
});
export const SocialEditOutput = z.object({ messageId: uuid.nullable() });

// ------------------------------------------------------------------------------------------------------------ ads

/** The worker, having asked Meta's Marketing API about an ad. */
export const AdResolveInput = z.object({
  workspaceId: uuid,
  adId: uuid,
  outcome: z.enum(['resolved', 'no_access', 'not_found', 'failed']),
  /** Why, when Meta didn't answer: kept for support. */
  error: z.string().max(2000).nullable().default(null),
  /** When to ask again; null never (resolved, or not there). */
  retryAt: isoDateTime.nullable().default(null),
  details: z
    .object({
      name: z.string().max(400).nullable(),
      adAccountId: z.string().max(64).nullable(),
      adsetId: z.string().max(64).nullable(),
      adsetName: z.string().max(400).nullable(),
      campaignId: z.string().max(64).nullable(),
      campaignName: z.string().max(400).nullable(),
      campaignObjective: z.string().max(100).nullable(),
      creativeId: z.string().max(64).nullable(),
      creativeName: z.string().max(400).nullable(),
      creativeTitle: z.string().max(1000).nullable(),
      creativeBody: z.string().max(4000).nullable(),
      creativeThumbnailUrl: z.string().max(2000).nullable(),
      creativeLink: z.string().max(2000).nullable(),
      callToAction: z.string().max(100).nullable(),
      effectiveStatus: z.string().max(60).nullable(),
      platforms: z.array(z.string().max(40)).max(10),
      raw: z.record(z.string(), z.unknown()),
    })
    .nullable()
    .default(null),
});
export const AdResolveOutput = z.object({ adId: uuid, status: z.string() });

// ----------------------------------------------------------------------------------------------------- lead ads

/**
 * The worker: somebody sent a lead ad's form (funnels). Meta's webhook named the lead and the worker read it with the
 * Page's token; every answer, consent box and the form's own words come as Meta gave them.
 */
export const MetaLeadReceiveInput = z.object({
  workspaceId: uuid,
  /** The Page, or the Instagram account linked to it, whose token read the lead. */
  accountId: uuid,
  leadgenId: metaId,
  form: z.object({
    id: metaId,
    /** Null when Meta wouldn't say: the name kept from before stays. */
    name: z.string().trim().max(300).nullable().default(null),
    /** The form's own tick boxes and their words. Null when Meta wouldn't say: the ones kept from before count. */
    consentBoxes: z
      .array(z.object({ key: z.string().max(200), text: z.string().max(2000) }))
      .max(20)
      .nullable()
      .default(null),
    /** Its questions' words, by Meta's name for each. */
    questions: z
      .array(z.object({ key: z.string().max(200), label: z.string().max(500) }))
      .max(100)
      .default([]),
  }),
  /** Where they saw the ad. */
  platform: metaPlatform,
  /** Null for a form shared without an ad. */
  adId: z
    .string()
    .regex(/^[0-9A-Za-z_-]{1,64}$/)
    .nullable()
    .default(null),
  organic: z.boolean().default(false),
  createdAt: isoDateTime,
  answers: z
    .array(
      z.object({
        name: z.string().max(200),
        values: z.array(z.string().max(2000)).max(20),
      }),
    )
    .max(100),
  consents: z
    .array(z.object({ key: z.string().max(200), checked: z.boolean() }))
    .max(20)
    .default([]),
});
export const MetaLeadReceiveOutput = z.object({
  outcome: z.enum(['opened', 'matched', 'refused']),
  personId: uuid.nullable(),
  leadId: uuid.nullable(),
  /** Meta said this lead before: nothing was done twice. */
  duplicate: z.boolean(),
  refusedReason: z.enum(['turned_off', 'no_contact', 'over_limit']).nullable(),
  /** They ticked a box about texts. */
  smsConsent: z.boolean(),
});

/** The worker: what reading a Page's leads found. `checked` marks the hourly look done. */
export const MetaLeadsAccessInput = z.object({
  workspaceId: uuid,
  accountId: uuid,
  access: z.enum(['ok', 'not_allowed', 'blocked']).optional(),
  checked: z.boolean().optional(),
});
export const MetaLeadsAccessOutput = z.object({ accountId: uuid, changed: z.boolean() });

// -------------------------------------------------------------------------------------------------------- reading

export const MetaAccountListInput = z.object({ workspaceId: uuid });
export const MetaAccountRow = z.object({
  id: uuid,
  platform: metaPlatform,
  externalId: z.string(),
  pageId: z.string(),
  name: z.string(),
  username: z.string().nullable(),
  status: z.enum(['active', 'needs_attention', 'disconnected']),
  problem: metaProblem.nullable(),
  /** Meta is sending this one's messages here. */
  subscribed: z.boolean(),
  humanAgent: z.boolean(),
  connectedAt: isoDateTime,
  connectionId: uuid.nullable(),
  /** Its threads, for "37 conversations". */
  conversations: z.number().int(),
  /** Lead ads: whether its leads can be read, the last one, and the forms seen so far. */
  leadsAccess: z.enum(['unknown', 'ok', 'not_allowed', 'blocked']),
  lastLeadAt: isoDateTime.nullable(),
  leadForms: z.array(z.object({ name: z.string(), lastLeadAt: isoDateTime.nullable() })),
});
export const MetaConnectionRow = z.object({
  id: uuid,
  status: z.enum(['pending', 'connected', 'needs_attention', 'disconnected']),
  facebookUserName: z.string().nullable(),
  /** Whoever pressed Connect, in HandsFreeOS. */
  connectedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  connectedAt: isoDateTime.nullable(),
  /** Null: never. */
  tokenExpiresAt: isoDateTime.nullable(),
  /** The sign-in may read the business's ads, so ads show their campaign. */
  readsAds: z.boolean(),
  /** The sign-in may read its Pages' lead ad forms. */
  readsLeads: z.boolean(),
  lastError: z.string().nullable(),
});
export const MetaAccountListOutput = z.object({
  accounts: z.array(MetaAccountRow),
  connections: z.array(MetaConnectionRow),
});

/** Where somebody came from: by customer, or by thread. */
export const AttributionListInput = z
  .object({
    workspaceId: uuid,
    personId: uuid.optional(),
    conversationId: uuid.optional(),
    limit: z.int().min(1).max(100).default(25),
  })
  .refine((v) => !!v.personId !== !!v.conversationId, {
    message: 'Ask about one customer or one conversation.',
    path: ['personId'],
  });
export const AttributionAd = z.object({
  /** The ad's own id at Meta. */
  externalId: z.string(),
  status: z.enum(['pending', 'resolved', 'no_access', 'not_found', 'failed']),
  name: z.string().nullable(),
  adsetId: z.string().nullable(),
  adsetName: z.string().nullable(),
  campaignId: z.string().nullable(),
  campaignName: z.string().nullable(),
  campaignObjective: z.string().nullable(),
  creativeId: z.string().nullable(),
  creativeName: z.string().nullable(),
  creativeTitle: z.string().nullable(),
  creativeBody: z.string().nullable(),
  creativeThumbnailUrl: z.string().nullable(),
  callToAction: z.string().nullable(),
  /** Where the ad ran, as far as its creative says. */
  platforms: z.array(z.string()),
});
export const AttributionTouchRow = z.object({
  id: uuid,
  touchedAt: isoDateTime,
  /** lead_form: they sent a lead ad's form (funnels). */
  kind: z.enum(['started', 'returned', 'lead_form']),
  platform: metaPlatform,
  channel: socialChannel,
  source: z.string().nullable(),
  referralType: z.string().nullable(),
  ref: z.string().nullable(),
  adId: z.string().nullable(),
  adTitle: z.string().nullable(),
  adPhotoUrl: z.string().nullable(),
  postId: z.string().nullable(),
  refererUri: z.string().nullable(),
  conversationId: uuid.nullable(),
  personId: uuid.nullable(),
  leadId: uuid.nullable(),
  /** The Page or Instagram account it came to. */
  accountName: z.string().nullable(),
  /** The lead ad form they sent, for a lead_form touch. */
  formName: z.string().nullable(),
  ad: AttributionAd.nullable(),
});
export const AttributionListOutput = z.object({
  /** Newest first. */
  touches: z.array(AttributionTouchRow),
  /** The first and the newest: what "came from" and "came back from" say. */
  first: uuid.nullable(),
  latest: uuid.nullable(),
  total: z.number().int(),
});
export type AttributionTouchRow = z.infer<typeof AttributionTouchRow>;
