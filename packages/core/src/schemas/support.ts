/**
 * Milestone 13 schemas: the support desk (tickets, replies, drafts, saved replies), the staff who run it,
 * and the admin side (businesses, health, looking at a business read-only). Browser-safe.
 */
import { z } from 'zod';
import { PHONE_MODELS } from '../ai-team/config';
import { displayName, email, isoDateTime, uuid } from './common';

export const TicketStatusValue = z.enum(['new', 'open', 'waiting_on_customer', 'solved', 'closed']);
export type TicketStatusValue = z.infer<typeof TicketStatusValue>;
export const TicketPriorityValue = z.enum(['low', 'normal', 'high', 'urgent']);
export const TicketChannelValue = z.enum(['email', 'in_app', 'chat']);
export const StaffRoleValue = z.enum(['agent', 'lead', 'admin']);
export const StaffStatusValue = z.enum(['active', 'suspended']);

const body = z.string().trim().min(1, 'Write something first.').max(20000);
const subject = z.string().trim().max(200);
const limit = z.int().min(1).max(100).default(25);
const cursor = z.string().max(400).optional();

const Person = z.object({
  userId: uuid.nullable(),
  name: z.string(),
  email: z.string(),
});
const Business = z.object({
  workspaceId: uuid,
  name: z.string(),
  organizationId: uuid.nullable(),
});

export const TicketSummary = z.object({
  id: uuid,
  number: z.int(),
  subject: z.string(),
  status: TicketStatusValue,
  priority: TicketPriorityValue,
  channel: TicketChannelValue,
  requester: Person,
  business: Business.nullable(),
  assignee: Person.nullable(),
  tags: z.array(z.string()),
  /** The last thing either side said, so a queue can be read at a glance. */
  preview: z.string(),
  waitingSince: isoDateTime.nullable(),
  snoozeUntil: isoDateTime.nullable(),
  firstResponseAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type TicketSummary = z.infer<typeof TicketSummary>;

export const TicketMessage = z.object({
  id: uuid,
  author: z.enum(['customer', 'staff', 'ai', 'system']),
  internal: z.boolean(),
  authorName: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string().nullable(),
  attachments: z.array(z.object({ name: z.string(), contentType: z.string(), sizeBytes: z.int() })),
  createdAt: isoDateTime,
});

export const TicketEvent = z.object({
  id: uuid,
  kind: z.string(),
  actorName: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
});

export const TicketDraft = z.object({
  bodyText: z.string(),
  sources: z.array(z.object({ kind: z.string(), title: z.string(), id: z.string().nullable() })),
  model: z.string(),
  createdAt: isoDateTime,
  /** True once the conversation has moved on: shown greyed out rather than hidden. */
  stale: z.boolean(),
});

// ---------- looking at the queue ----------

export const TicketListInput = z.object({
  status: z.array(TicketStatusValue).max(5).optional(),
  /** 'mine' and 'unassigned' are what a queue is read by; a user id is for looking at someone else's. */
  assignee: z.union([z.enum(['mine', 'unassigned', 'anyone']), uuid]).default('anyone'),
  search: z.string().trim().max(200).optional(),
  workspaceId: uuid.optional(),
  /** Snoozed tickets are out of the queue until their time comes; this puts them back in view. */
  includeSnoozed: z.boolean().default(false),
  limit,
  cursor,
});
export const TicketListOutput = z.object({
  tickets: z.array(TicketSummary),
  nextCursor: z.string().nullable(),
});

export const TicketGetInput = z.object({ ticketId: uuid });
export const TicketGetOutput = z.object({
  ticket: TicketSummary,
  messages: z.array(TicketMessage),
  events: z.array(TicketEvent),
  draft: TicketDraft.nullable(),
  /** What we know about the business they are asking about, so nobody has to go and look it up. */
  business: z
    .object({
      workspaceId: uuid,
      name: z.string(),
      organizationName: z.string(),
      createdAt: isoDateTime,
      memberCount: z.int(),
      openTicketCount: z.int(),
    })
    .nullable(),
  /** Their other tickets, newest first. */
  alsoFrom: z.array(
    z.object({ id: uuid, number: z.int(), subject: z.string(), status: TicketStatusValue }),
  ),
});
export type TicketGetOutput = z.infer<typeof TicketGetOutput>;

export const QueueSummaryInput = z.object({});
export const QueueSummaryOutput = z.object({
  unanswered: z.int(),
  mine: z.int(),
  unassigned: z.int(),
  waitingOnCustomer: z.int(),
  solvedToday: z.int(),
  /** How long the oldest unanswered ticket has been waiting, in minutes. */
  oldestWaitingMinutes: z.int().nullable(),
});

// ---------- answering ----------

export const TicketReplyInput = z.object({
  ticketId: uuid,
  body,
  /** An internal note: staff read it, the customer never does. */
  internal: z.boolean().default(false),
  /** What the ticket becomes once this is sent. Left out, a reply waits on the customer. */
  status: TicketStatusValue.optional(),
});
export const TicketReplyOutput = z.object({
  messageId: uuid,
  status: TicketStatusValue,
});

export const TicketRefInput = z.object({ ticketId: uuid });
export const TicketWriteOutput = z.object({ ticketId: uuid });

export const TicketSetStatusInput = z.object({ ticketId: uuid, status: TicketStatusValue });
export const TicketAssignInput = z.object({ ticketId: uuid, assigneeUserId: uuid.nullable() });
export const TicketSnoozeInput = z.object({ ticketId: uuid, until: isoDateTime.nullable() });
export const TicketSetPriorityInput = z.object({ ticketId: uuid, priority: TicketPriorityValue });
export const TicketLinkBusinessInput = z.object({ ticketId: uuid, workspaceId: uuid.nullable() });
export const TicketMergeInput = z.object({ ticketId: uuid, intoTicketId: uuid });

// ---------- asking for help from inside HandsFreeOS ----------

export const SupportRequestInput = z.object({
  workspaceId: uuid,
  subject,
  body,
  /** What the screen already knows: the page, the app build, the last error. Never anything typed. */
  context: z
    .object({
      page: z.string().max(200).optional(),
      appVersion: z.string().max(40).optional(),
      platform: z.enum(['web', 'ios', 'android']).optional(),
      lastError: z.string().max(2000).optional(),
    })
    .default({}),
});
export const SupportRequestOutput = z.object({ ticketId: uuid, number: z.int() });

// ---------- saved replies ----------

export const CannedReply = z.object({
  id: uuid,
  title: z.string(),
  bodyText: z.string(),
  updatedAt: isoDateTime,
});
export const CannedReplyListInput = z.object({});
export const CannedReplyListOutput = z.object({ replies: z.array(CannedReply) });
export const CannedReplySaveInput = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(20000),
});
export const CannedReplySaveOutput = z.object({ id: uuid });
export const CannedReplyDeleteInput = z.object({ id: uuid });
export const CannedReplyDeleteOutput = z.object({ id: uuid });

// ---------- the people who answer ----------

export const StaffMember = z.object({
  userId: uuid,
  fullName: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: StaffRoleValue,
  status: StaffStatusValue,
  openTicketCount: z.int(),
  createdAt: isoDateTime,
});
export const StaffInvitation = z.object({
  id: uuid,
  email: z.string(),
  role: StaffRoleValue,
  invitedByName: z.string(),
  sentAt: isoDateTime.nullable(),
  expiresAt: isoDateTime,
  createdAt: isoDateTime,
});
export const StaffListInput = z.object({});
export const StaffListOutput = z.object({
  staff: z.array(StaffMember),
  invitations: z.array(StaffInvitation),
});

export const StaffInviteInput = z.object({ email, role: StaffRoleValue.default('agent') });
export const StaffInviteOutput = z.object({ invitationId: uuid });
export const StaffInvitationRefInput = z.object({ invitationId: uuid });
export const StaffInvitationWriteOutput = z.object({ invitationId: uuid });
export const StaffAcceptInput = z.object({ token: z.string().trim().min(10).max(200) });
export const StaffAcceptOutput = z.object({
  accepted: z.boolean(),
  role: StaffRoleValue.nullable(),
  /** Why not, when it did not work: unknown, already_accepted, revoked, expired, wrong_address. */
  reason: z.string().nullable(),
});
export const StaffSetRoleInput = z.object({
  userId: uuid,
  role: StaffRoleValue.optional(),
  status: StaffStatusValue.optional(),
});
export const StaffWriteOutput = z.object({ userId: uuid });
export const StaffRemoveInput = z.object({ userId: uuid });
export const StaffProfileInput = z.object({
  displayName: displayName.max(120),
  signature: z.string().trim().max(2000).default(''),
});

// ---------- who am I ----------

export const PlatformMeInput = z.object({});
export const PlatformMeOutput = z.object({
  staff: z
    .object({
      userId: uuid,
      role: StaffRoleValue,
      displayName: z.string(),
      signature: z.string(),
      permissions: z.array(z.string()),
      /** The founder opens any business as its owner, in one click, and nobody is told. */
      founder: z.boolean(),
    })
    .nullable(),
});

// ---------- the businesses ----------

/** The plan a business is on (app.workspace_plans), or none yet. */
export const BusinessPlanValue = z.enum(['founding_free', 'founding_lifetime', 'monthly']);
export type BusinessPlanValue = z.infer<typeof BusinessPlanValue>;

/**
 * What needs a look, most serious first (private.admin_business_attention, where the rules live). The words are
 * core's: `deskBusinessFlags`.
 */
export const BusinessAttentionValue = z.enum([
  'being_deleted',
  'wallet_suspended',
  'card_declined',
  'balance_out',
  'plan_trouble',
  'texting_rejected',
  'connection_broken',
  'texting_waiting',
  'thin_margin',
  'gone_quiet',
  'setup_stalled',
]);
export type BusinessAttentionValue = z.infer<typeof BusinessAttentionValue>;

export const BusinessRow = z.object({
  workspaceId: uuid,
  name: z.string(),
  organizationId: uuid,
  organizationName: z.string(),
  industry: z.string(),
  timezone: z.string(),
  memberCount: z.int(),
  /** The last time anybody in the business did anything at all. */
  lastActiveAt: isoDateTime.nullable(),
  openTicketCount: z.int(),
  createdAt: isoDateTime,
  /**
   * The founding offer whose seat is on this workspace ("Founding Partner"), while it is. Null without one, and for
   * staff who don't manage founding seats.
   */
  foundingSeat: z.string().nullable(),
  plan: BusinessPlanValue.nullable(),
  /** What needs a look; empty when nothing does. */
  attention: z.array(BusinessAttentionValue),
});
export const BusinessListInput = z.object({
  search: z.string().trim().max(200).optional(),
  /** `attention` is only the businesses that need a look, newest first. */
  sort: z.enum(['newest', 'busiest', 'quietest', 'attention', 'name']).default('newest'),
  limit,
  cursor,
});
export const BusinessListOutput = z.object({
  businesses: z.array(BusinessRow),
  nextCursor: z.string().nullable(),
  totals: z.object({
    businesses: z.int(),
    newThisWeek: z.int(),
    activeThisWeek: z.int(),
  }),
});

export const BusinessGetInput = z.object({ workspaceId: uuid });

/** A model support can pick for a business's calls; null is the worker's own (VOICE_MODEL). */
export const PhoneModelValue = z.enum(PHONE_MODELS);

export const BusinessGetOutput = z.object({
  business: BusinessRow,
  /** The model its calls think with, when support picked one; null is the worker's VOICE_MODEL. */
  phoneModel: PhoneModelValue.nullable(),
  /** HandsFreeOS's own business (M19), which may use handsfreeos.com for its email. */
  isPlatform: z.boolean(),
  /** Add-ons still being built that staff handed this business to try (Real Estate, step 2). */
  addonGrants: z.array(
    z.object({
      addonId: z.string(),
      note: z.string().nullable(),
      grantedAt: isoDateTime,
    }),
  ),
  people: z.array(
    z.object({
      userId: uuid,
      fullName: z.string(),
      email: z.string(),
      role: z.string(),
      lastActiveAt: isoDateTime.nullable(),
    }),
  ),
  counts: z.object({
    people: z.int(),
    leads: z.int(),
    conversations: z.int(),
    appointments: z.int(),
    invoices: z.int(),
  }),
  tickets: z.array(
    z.object({
      id: uuid,
      number: z.int(),
      subject: z.string(),
      status: TicketStatusValue,
      createdAt: isoDateTime,
    }),
  ),
  /** What is set up, as a support person would ask it: can they text, email, take money, book. */
  setup: z.object({
    phone: z.boolean(),
    email: z.boolean(),
    payments: z.boolean(),
    calendar: z.boolean(),
    aiTeammate: z.boolean(),
  }),
});

// ---------- one business at a glance ----------

export const BusinessGlanceInput = z.object({ workspaceId: uuid });

const connection = z.object({ provider: z.string(), status: z.string() });

/**
 * Everything the quick look shows beyond `platform.business.get` and `platform.wallet.get`
 * (private.admin_business_glance). Counts and states only: never a message, a customer's name or a card number.
 */
export const BusinessGlanceOutput = z.object({
  attention: z.array(BusinessAttentionValue),
  deletionRequestedAt: isoDateTime.nullable(),
  plan: z
    .object({
      plan: BusinessPlanValue,
      status: z.enum(['active', 'grace', 'past_due', 'canceled']),
      priceCents: z.int(),
      /** The end of the year paid for, on a yearly founding seat. */
      periodEnd: isoDateTime.nullable(),
      graceEndsAt: isoDateTime.nullable(),
      canceledAt: isoDateTime.nullable(),
      renewalStoppedAt: isoDateTime.nullable(),
      renewalProblem: z.string().nullable(),
      renewalFailedAt: isoDateTime.nullable(),
    })
    .nullable(),
  /** Events a day for the last 30 days, oldest first, ending today in the business's own time zone. */
  activity: z.array(z.int()),
  /** The last 30 days. */
  traffic: z.object({ texts: z.int(), calls: z.int(), emails: z.int(), aiReplies: z.int() }),
  /** Money their own customers paid them, through their invoices. None of it is ours. */
  theirMoney: z.object({
    collected30dCents: z.int(),
    refunded30dCents: z.int(),
    openInvoices: z.int(),
    openInvoiceCents: z.int(),
    overdueInvoices: z.int(),
    openDisputes: z.int(),
  }),
  setup: z.object({
    /** Their numbers, the default first. */
    numbers: z.array(z.string()),
    /** Texting registration, summed over its parts. Null when they never started one. */
    registration: z
      .object({
        state: z.enum(['approved', 'waiting', 'rejected', 'draft']),
        /** When the oldest part still waiting went to the carriers. */
        since: isoDateTime.nullable(),
        reason: z.string().nullable(),
      })
      .nullable(),
    emailDomain: z.object({ domain: z.string(), status: z.string() }).nullable(),
    emailAddresses: z.int(),
    mailboxes: z.array(connection),
    payments: z.array(connection),
    calendarConnections: z.array(connection),
    calendars: z.int(),
    bookingPage: z.object({ slug: z.string(), enabled: z.boolean() }).nullable(),
    aiTeammate: z.enum(['off', 'training', 'automatic']).nullable(),
    meta: z.string().nullable(),
    gettingStarted: z.enum(['finished', 'started', 'not_started', 'off']),
  }),
  more: z.object({
    /** The move from another system that made this business, if one did. */
    cameFrom: z
      .object({ source: z.string(), status: z.string(), at: isoDateTime.nullable() })
      .nullable(),
    /** Add-ons switched on. */
    addons: z.array(z.string()),
    mainOffer: z.object({ liveVersion: z.int().nullable(), revision: z.int() }).nullable(),
    /** The last time they were asked to let support into their records, and what they said. */
    supportAccess: z
      .object({
        status: z.enum(['requested', 'active', 'declined', 'ended']),
        expiresAt: isoDateTime.nullable(),
      })
      .nullable(),
    /** The last time somebody at HandsFreeOS looked at the business as one of its people. */
    lastViewedAs: isoDateTime.nullable(),
  }),
  problemReports: z.object({
    open: z.int(),
    recent: z.array(
      z.object({
        id: uuid,
        area: z.string().nullable(),
        note: z.string().nullable(),
        createdAt: isoDateTime,
        handled: z.boolean(),
      }),
    ),
  }),
});
export type BusinessGlance = z.infer<typeof BusinessGlanceOutput>;

// ---------- one business's usage balance ----------

/** `agency`: its agency pays for what it uses, and it never hears of a balance. */
export const WalletStageValue = z.enum(['off', 'warn', 'enforce', 'agency']);

export const AdminWalletGetInput = z.object({ workspaceId: uuid });

/**
 * What the support desk sees of a business's balance — **including what it cost us**, which is the one place
 * in the product that number appears. A customer is shown the price; staff answering "why was I charged 2c for
 * that text" need both sides of it.
 */
export const AdminWalletGetOutput = z.object({
  /** False for a business that has never spent anything and has never been moved along. */
  opened: z.boolean(),
  stage: WalletStageValue,
  balanceCents: z.int(),
  autoTopup: z.boolean(),
  floorCents: z.int(),
  topupCents: z.int(),
  hasCard: z.boolean(),
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  suspendedAt: isoDateTime.nullable(),
  suspendedReason: z.string().nullable(),
  declinesInRow: z.int(),
  escalationStep: z.int(),
  spent30dCents: z.int(),
  /** What those 30 days cost HandsFreeOS. Never leaves /admin. */
  cost30dCents: z.int(),
  toppedUp30dCents: z.int(),
});

export const WalletSetStageInput = z.object({
  workspaceId: uuid,
  stage: WalletStageValue,
  /** Why, in a few words. Stored on the event: a rollout is a series of decisions somebody made. */
  reason: z.string().trim().min(3).max(300),
});

export const WalletSetStageOutput = z.object({
  workspaceId: uuid,
  was: WalletStageValue,
  stage: WalletStageValue,
  /** False when it was already there, so a double-click is visibly a no-op rather than a second decision. */
  changed: z.boolean(),
});

export const PhoneModelSetInput = z.object({
  workspaceId: uuid,
  /** Null puts it back on the worker's VOICE_MODEL. */
  model: PhoneModelValue.nullable(),
});

export const PhoneModelSetOutput = z.object({
  workspaceId: uuid,
  was: PhoneModelValue.nullable(),
  model: PhoneModelValue.nullable(),
  /** False when it was already that, so a double-click is visibly a no-op. */
  changed: z.boolean(),
});

/** Marking HandsFreeOS's own business, the one that may use handsfreeos.com for its email (M19). */
export const OwnBusinessSetInput = z.object({ workspaceId: uuid, on: z.boolean() });

export const OwnBusinessSetOutput = z.object({
  workspaceId: uuid,
  was: z.boolean(),
  on: z.boolean(),
  /** False when it was already that, so a double-click is visibly a no-op. */
  changed: z.boolean(),
});

// ---------- which AI answers ----------

/** auto follows the worker's checks; claude and openai keep it there whatever the checks say. */
export const AiProviderModeValue = z.enum(['auto', 'claude', 'openai']);
export type AiProviderModeValue = z.infer<typeof AiProviderModeValue>;
export const AiProviderValue = z.enum(['claude', 'openai']);
/** Why the checks moved it to OpenAI: Claude's status page said so, or Claude's answers kept failing. */
export const AiProviderReasonValue = z.enum(['status', 'errors']);

export const AiProviderGetInput = z.object({});
export const AiProviderGetOutput = z.object({
  mode: AiProviderModeValue,
  /** Who the worker's checks chose, which is who answers while the mode is auto. */
  active: AiProviderValue,
  /** Who is answering right now: the one support picked, or `active` on auto. */
  answering: AiProviderValue,
  /** Null while on Claude. */
  reason: AiProviderReasonValue.nullable(),
  /** What Claude's status page last said about the Claude API (operational, degraded_performance, …). */
  claudeStatus: z.string().nullable(),
  /** Checks in a row that found Claude well, while on OpenAI: two bring it back. */
  goodChecks: z.int(),
  checkedAt: isoDateTime.nullable(),
  switchedAt: isoDateTime.nullable(),
  modeSetAt: isoDateTime.nullable(),
  /** The person who last pressed the switch, by the name support knows them by. */
  modeSetBy: z.string().nullable(),
});

export const AiProviderSetModeInput = z.object({ mode: AiProviderModeValue });

export const AiProviderSetModeOutput = z.object({
  was: AiProviderModeValue,
  mode: AiProviderModeValue,
  /** False when it was already that, so a double-click is visibly a no-op. */
  changed: z.boolean(),
});

// ---------- is anything broken ----------

export const HealthSummaryInput = z.object({
  /** How far back to look. A support person asks about today; a Monday morning asks about the weekend. */
  hours: z.int().min(1).max(168).default(24),
});
const HealthCount = z.object({
  label: z.string(),
  count: z.int(),
  /** The business it happened in most, when one stands out. */
  worstBusiness: z.string().nullable(),
});
export const HealthSummaryOutput = z.object({
  since: isoDateTime,
  failedJobs: HealthCount,
  failedDeliveries: HealthCount,
  emailBounces: HealthCount,
  failedTexts: HealthCount,
  paymentFailures: HealthCount,
  /** Calls whose words never arrived. One is ordinary; a rising number is the transcriber. */
  lostTranscripts: HealthCount,
  /**
   * The usage wallets in trouble (M16). `drifting` is the silent one: the cached balance is what every
   * spending gate reads, so a wallet that disagrees with its own ledger means every gate is lying.
   */
  wallets: z.object({
    suspended: z.int(),
    declines: z.int(),
    drifting: z.int(),
    negative: z.int(),
    unreconciledDays: z.int(),
  }),
  /** Work waiting longer than it should be. */
  outboxBacklog: z.int(),
  oldestPendingMinutes: z.int().nullable(),
  recent: z.array(
    z.object({
      kind: z.string(),
      at: isoDateTime,
      business: z.string().nullable(),
      detail: z.string(),
    }),
  ),
});

// ---------- looking at a business ----------

export const ViewAsStartInput = z.object({
  workspaceId: uuid,
  /** Why, in a few words: support must say, and the business reads it. The founder needn't. */
  reason: z.string().trim().max(500).optional(),
  ticketId: uuid.optional(),
  /** How long a look stays open. It ends by itself either way; the founder's session doesn't. */
  minutes: z.int().min(5).max(240).default(60),
});
export const ViewAsSession = z.object({
  id: uuid,
  workspaceId: uuid,
  businessName: z.string(),
  /** Null on the founder's sessions, which need no reason. */
  reason: z.string().nullable(),
  startedAt: isoDateTime,
  /** Null on the founder's sessions, which last until they leave. */
  expiresAt: isoDateTime.nullable(),
  /** The founder working in the business as its owner: they can change things, and the business isn't told. */
  acting: z.boolean(),
});
export const ViewAsStartOutput = z.object({ session: ViewAsSession });
export const ViewAsEndInput = z.object({ sessionId: uuid.optional() });
export const ViewAsEndOutput = z.object({ ended: z.boolean() });
export const ViewAsCurrentInput = z.object({});
export const ViewAsCurrentOutput = z.object({ session: ViewAsSession.nullable() });

// ---------- the usage rate card (M16) ----------

export const RateCardGetInput = z.object({
  /** How far back the margin column measures. */
  days: z.int().min(1).max(365).default(30),
});

export const RateCardGetOutput = z.object({
  version: z.int(),
  since: isoDateTime,
  lines: z.array(
    z.object({
      key: z.string(),
      unit: z.string(),
      /** What we pay, in micro-dollars: a text segment is 10900. Staff only. */
      costMicros: z.int(),
      markupBp: z.int(),
      minChargeCents: z.int(),
      roundUpTo: z.string(),
      /** What one of these charges a business today. */
      unitPriceCents: z.int(),
      notes: z.string(),
      /**
       * What actually happened over the period, or null where nothing did. This is the column that proves the
       * markup: a realised figure under 1.2 on any line is money going out quietly.
       */
      realised: z
        .object({
          events: z.int(),
          chargedCents: z.int(),
          costCents: z.int(),
          markup: z.number(),
        })
        .nullable(),
    }),
  ),
});
