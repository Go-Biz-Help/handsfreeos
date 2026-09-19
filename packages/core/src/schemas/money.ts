/**
 * Money's commands and queries (M9): the catalogue, estimates, invoices, payments, the accounts they are paid
 * into, maintenance plans and the money settings. Browser-safe.
 *
 * The vocabularies here are `app.*`'s enums to the word — `invoice_purpose`, `money_origin`, `product_kind`,
 * `plan_interval`, `payment_provider`, `payment_environment`, `payment_connection_status`,
 * `subscription_status` and the disconnect reasons. The ones the pure core already owns (statuses, methods) are
 * re-used from `../money/status` rather than written out twice.
 */
import { z } from 'zod';
import { MoneySettings } from '../money/settings';
import {
  ESTIMATE_STATUSES,
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
} from '../money/status';
import { isoDateTime, uuid } from './common';

// ---------- vocabularies ----------

/** What a line is: a part, work done, or a charge like a call-out fee. */
export const PRODUCT_KINDS = ['product', 'service', 'fee'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** How often a plan bills; `intervalCount` multiplies it ("every 3 months" is month × 3). */
export const PLAN_INTERVALS = ['month', 'quarter', 'year'] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

/** What an invoice is for. A deposit is an invoice like any other, marked as one. */
export const INVOICE_PURPOSES = [
  'standard',
  'deposit',
  'balance',
  'setup_fee',
  'subscription',
  'quick',
] as const;
export type InvoicePurpose = (typeof INVOICE_PURPOSES)[number];

/** Where a document came from, for reporting and for the timeline. */
export const MONEY_ORIGINS = [
  'staff',
  'estimate',
  'booking',
  'subscription',
  'workflow',
  'assistant',
  /** A form asked for it (M15). */
  'form',
] as const;
export type MoneyOrigin = (typeof MONEY_ORIGINS)[number];

/** All five: the two that ship in M9, and the three that follow on the same seam. */
export const PAYMENT_PROVIDERS = ['stripe', 'square', 'paypal', 'nmi', 'authorize_net'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/** The two that can be connected today; the rest need a credential paste that isn't built yet. */
export const CONNECTABLE_PROVIDERS = ['stripe', 'square'] as const;

export const PAYMENT_ENVIRONMENTS = ['live', 'test'] as const;
export type PaymentEnvironment = (typeof PAYMENT_ENVIRONMENTS)[number];

export const PAYMENT_CONNECTION_STATUSES = [
  'pending',
  'active',
  'reauth_required',
  'error',
  'disconnected',
] as const;
export type PaymentConnectionStatus = (typeof PAYMENT_CONNECTION_STATUSES)[number];

/** Why a connection ended: a person, the provider, too many failures, or a reconnect of the same account. */
export const DISCONNECTED_REASONS = [
  'person',
  'revoked',
  'deauthorized',
  'failed',
  'replaced',
] as const;
export type DisconnectedReason = (typeof DISCONNECTED_REASONS)[number];

export const SUBSCRIPTION_STATUSES = [
  'draft',
  'active',
  'past_due',
  'paused',
  'cancelled',
  'unmanaged',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const productKind = z.enum(PRODUCT_KINDS);
export const planInterval = z.enum(PLAN_INTERVALS);
export const estimateStatus = z.enum(ESTIMATE_STATUSES);
export const invoiceStatus = z.enum(INVOICE_STATUSES);
export const invoicePurpose = z.enum(INVOICE_PURPOSES);
export const moneyOrigin = z.enum(MONEY_ORIGINS);
export const paymentProvider = z.enum(PAYMENT_PROVIDERS);
export const paymentEnvironment = z.enum(PAYMENT_ENVIRONMENTS);
export const paymentConnectionStatus = z.enum(PAYMENT_CONNECTION_STATUSES);
export const paymentMethod = z.enum(PAYMENT_METHODS);
export const paymentStatus = z.enum(PAYMENT_STATUSES);
export const refundStatus = z.enum(REFUND_STATUSES);
export const subscriptionStatus = z.enum(SUBSCRIPTION_STATUSES);
export const disconnectedReason = z.enum(DISCONNECTED_REASONS);

// ---------- shared field shapes ----------

/** A document total fits in a bigint long before a business does; the table's check is the same number. */
const MAX_CENTS = 100_000_000_000;
export const cents = z.int().min(0).max(MAX_CENTS);
/** A local date, `2026-09-25`: a due day and an expiry belong to the business's day, not to UTC. */
export const localDate = z.iso.date();
const name160 = z.string().trim().min(1, 'Enter a name.').max(160, 'Keep it under 160 characters.');
const description = z.string().trim().max(2_000, 'Keep it under 2,000 characters.').nullable();
const title = z.string().trim().min(1).max(200).nullable();
const notes = z.string().trim().max(5_000, 'Keep it under 5,000 characters.').nullable();
const reason500 = z.string().trim().max(500, 'Keep it under 500 characters.').nullable();
const providerId = z.string().trim().min(1).max(200);
const providerWord = z.string().trim().min(1).max(80);
const idempotencyKey = z.string().trim().min(8).max(100);

const inWorkspace = { workspaceId: uuid };

/** A percentage in basis points: 1,000 is 10%. */
export const basisPoints = z.int().min(0).max(10_000);

/** A discount or a deposit: none, a share of the document, or an amount. Never both at once. */
export const MoneyTerms = z.object({
  kind: z.enum(['none', 'percent', 'amount']).default('none'),
  percentBp: basisPoints.optional(),
  amountCents: cents.optional(),
});
export type MoneyTerms = z.infer<typeof MoneyTerms>;

/**
 * A discount or a deposit **as it was written**, so an editor gets back the shape the person chose rather than
 * having to guess it from the figure. Both numbers are always filled in — the one the kind doesn't use is 0 —
 * so nothing downstream has to handle an absent field.
 */
export const MoneyTermsOut = z.object({
  kind: z.enum(['none', 'percent', 'amount']),
  /** For 'percent', in basis points: 2,500 is 25%. 0 when it wasn't written as a percentage. */
  percentBp: basisPoints,
  /** For 'amount', in cents. 0 when it wasn't written as an amount. */
  amountCents: cents,
});
export type MoneyTermsOut = z.infer<typeof MoneyTermsOut>;

/** A line as it is written: what the product said at the moment it was added. */
export const MoneyLineInput = z.object({
  /** The catalogue row it came from; null for a line typed by hand. */
  productId: uuid.nullable().default(null),
  name: z.string().trim().min(1, 'Name the line.').max(200, 'Keep it under 200 characters.'),
  description: description.default(null),
  quantity: z
    .number()
    .gt(0, 'More than none.')
    .max(1_000_000)
    .refine((q) => Math.round(q * 1000) === q * 1000, {
      error: 'Three decimal places at most.',
    }),
  unitLabel: z.string().trim().min(1).max(40).default('each'),
  unitPriceCents: cents,
  taxable: z.boolean().default(true),
  /** Money off this line, before the document discount is shared out. */
  discountCents: cents.default(0),
});
export type MoneyLineInput = z.infer<typeof MoneyLineInput>;

export const MoneyLineOut = z.object({
  id: uuid,
  position: z.int(),
  productId: uuid.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  quantity: z.number(),
  unitLabel: z.string(),
  unitPriceCents: z.number(),
  taxable: z.boolean(),
  /** Money off this line, as it was written. Stored, so the editor gets back exactly what it sent. */
  discountCents: z.number(),
  /** Its share of the document discount, allocated pro rata before tax. Worked out as this is read. */
  allocatedCents: z.number(),
  /** `quantity × unit price`, rounded once. */
  amountCents: z.number(),
  /** `amount − its own discount − its share`: what tax is worked out on. */
  netCents: z.number(),
});

/** The totals block every document carries, as core worked it out and the database stored it. */
export const MoneyTotalsOut = z.object({
  subtotalCents: z.number(),
  discountCents: z.number(),
  discountPercentBp: z.number().nullable(),
  taxableBaseCents: z.number(),
  taxCents: z.number(),
  taxRateBp: z.number(),
  taxLabel: z.string().nullable(),
  totalCents: z.number(),
  currency: z.string(),
});

const personOut = z.object({
  id: uuid,
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});
const userOut = z.object({ id: uuid, fullName: z.string() });

// ---------- the catalogue ----------

export const ProductCreateInput = z.object({
  ...inWorkspace,
  name: name160,
  description: description.optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  kind: productKind.default('product'),
  unitPriceCents: cents.default(0),
  unitLabel: z.string().trim().min(1).max(40).default('each'),
  /** Left out, it follows the business's "new items are taxable" setting. */
  taxable: z.boolean().optional(),
  /** The bookable service this is the price of: one product per service. */
  serviceId: uuid.nullable().optional(),
});
export const ProductUpdateInput = z.object({
  ...inWorkspace,
  productId: uuid,
  name: name160.optional(),
  description: description.optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  kind: productKind.optional(),
  unitPriceCents: cents.optional(),
  unitLabel: z.string().trim().min(1).max(40).optional(),
  taxable: z.boolean().optional(),
  serviceId: uuid.nullable().optional(),
});
export const ProductArchiveInput = z.object({
  ...inWorkspace,
  productId: uuid,
  /** False puts it back in the catalogue. Nothing is ever deleted: old documents have to stay readable. */
  archived: z.boolean().default(true),
});
export const ProductOut = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  sku: z.string().nullable(),
  kind: productKind,
  unitPriceCents: z.number(),
  unitLabel: z.string(),
  taxable: z.boolean(),
  serviceId: uuid.nullable(),
  archivedAt: isoDateTime.nullable(),
});
export const ProductRefOutput = z.object({ productId: uuid, archived: z.boolean() });
export const ProductSaveOutput = z.object({
  productId: uuid,
  archived: z.boolean(),
  product: ProductOut,
  /** The fields that actually changed, for the audit log and the toast. */
  updated: z.array(z.string()).default([]),
});

export const PlanCreateInput = z.object({
  ...inWorkspace,
  name: name160,
  description: description.optional(),
  priceCents: cents.default(0),
  interval: planInterval.default('month'),
  intervalCount: z.int().min(1).max(36).default(1),
  taxable: z.boolean().optional(),
  /** The "what you get" lines the plan page prints. */
  includes: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
});
export const PlanUpdateInput = z.object({
  ...inWorkspace,
  planId: uuid,
  name: name160.optional(),
  description: description.optional(),
  priceCents: cents.optional(),
  interval: planInterval.optional(),
  intervalCount: z.int().min(1).max(36).optional(),
  taxable: z.boolean().optional(),
  includes: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
});
export const PlanArchiveInput = z.object({
  ...inWorkspace,
  planId: uuid,
  archived: z.boolean().default(true),
});
export const PlanOut = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  priceCents: z.number(),
  interval: planInterval,
  intervalCount: z.int(),
  taxable: z.boolean(),
  includes: z.array(z.string()),
  archivedAt: isoDateTime.nullable(),
});
export const PlanRefOutput = z.object({ planId: uuid, archived: z.boolean() });
export const PlanSaveOutput = z.object({
  planId: uuid,
  archived: z.boolean(),
  plan: PlanOut,
  updated: z.array(z.string()).default([]),
});

export const ProductListInput = z.object({
  ...inWorkspace,
  kind: productKind.optional(),
  includeArchived: z.boolean().default(false),
  search: z.string().trim().max(120).optional(),
});
export const ProductListOutput = z.object({ products: z.array(ProductOut) });
export const PlanListInput = z.object({
  ...inWorkspace,
  includeArchived: z.boolean().default(false),
});
export const PlanListOutput = z.object({ plans: z.array(PlanOut) });

// ---------- the accounts money is paid into ----------

export const PaymentConnectionConnectInput = z.object({
  ...inWorkspace,
  provider: z.enum(CONNECTABLE_PROVIDERS),
  environment: paymentEnvironment.default('live'),
  label: z.string().trim().min(1).max(60).nullable().optional(),
});
/** `state` goes to the worker's /oauth/<provider>/start once; only its hash is stored. */
export const PaymentConnectionConnectOutput = z.object({ connectionId: uuid, state: z.string() });

export const PaymentConnectionRefInput = z.object({ ...inWorkspace, connectionId: uuid });
export const PaymentConnectionSetLabelInput = z.object({
  ...inWorkspace,
  connectionId: uuid,
  label: z.string().trim().min(1, 'Name the account.').max(60).nullable(),
});
export const PaymentConnectionDisconnectInput = z.object({
  ...inWorkspace,
  connectionId: uuid,
  /**
   * Plans billing through this account keep billing at the provider after it is disconnected. Without this the
   * command refuses and lists them, so the business can cancel them first.
   */
  acknowledgeSubscriptions: z.boolean().default(false),
});

/** Worker: the business signed in at the provider and the account is connected. */
export const PaymentConnectionActivateInput = z.object({
  ...inWorkspace,
  connectionId: uuid,
  externalAccountId: providerId,
  /** Square takes money at a location; Stripe has none. */
  locationId: providerId.nullable().optional(),
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  scopes: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  /** What this account can do: card, bank transfer, subscriptions, refunds. */
  capabilities: z.record(z.string(), z.unknown()).default({}),
  /** Sealed by the worker; stored as is and never echoed. */
  tokenEnc: z.string().min(1).max(20_000),
  tokenKeyId: z.string().trim().min(1).max(100),
  tokenExpiresAt: isoDateTime.nullable().default(null),
  /** Square's token expires in 30 days, so the worker sets its own next refresh. */
  nextRefreshAt: isoDateTime.nullable().default(null),
});
export const PaymentConnectionFailInput = z.object({
  ...inWorkspace,
  connectionId: uuid,
  reason: z.enum(['reauth_required', 'error']),
  message: z.string().trim().min(1).max(2_000),
});
/** Worker: the provider ended it — Square's revoke, Stripe's deauthorize, or too many failures. */
export const PaymentConnectionRevokedInput = z.object({
  ...inWorkspace,
  connectionId: uuid,
  reason: z.enum(['revoked', 'deauthorized', 'failed', 'replaced']).default('revoked'),
  message: z.string().trim().min(1).max(2_000).nullable().default(null),
});

export const PaymentConnectionOut = z.object({
  id: uuid,
  provider: paymentProvider,
  environment: paymentEnvironment,
  status: paymentConnectionStatus,
  /** The provider's own id for the account. Never a token: those columns aren't granted to people at all. */
  externalAccountId: z.string().nullable(),
  locationId: z.string().nullable(),
  label: z.string().nullable(),
  displayName: z.string().nullable(),
  isDefault: z.boolean(),
  capabilities: z.record(z.string(), z.unknown()),
  tokenExpiresAt: isoDateTime.nullable(),
  failures: z.int(),
  lastError: z.string().nullable(),
  disconnectedReason: disconnectedReason.nullable(),
  connectedAt: isoDateTime.nullable(),
  disconnectedAt: isoDateTime.nullable(),
  /** Plans still billing through it: what a disconnect would leave unmanaged. */
  liveSubscriptions: z.int(),
});
export const PaymentConnectionStateOutput = z.object({
  connectionId: uuid,
  status: paymentConnectionStatus,
  isDefault: z.boolean(),
  changed: z.boolean(),
});
export const PaymentConnectionListInput = z.object({
  ...inWorkspace,
  environment: paymentEnvironment.optional(),
  includeDisconnected: z.boolean().default(false),
});
export const PaymentConnectionListOutput = z.object({
  connections: z.array(PaymentConnectionOut),
});

// ---------- estimates ----------

const documentHeader = {
  personId: uuid,
  leadId: uuid.nullable().optional(),
  assigneeUserId: uuid.nullable().optional(),
  title: title.optional(),
  notes: notes.optional(),
  lines: z.array(MoneyLineInput).max(200, 'That is a lot of lines.').default([]),
  discount: MoneyTerms.optional(),
};

export const EstimateCreateInput = z.object({
  ...inWorkspace,
  ...documentHeader,
  /** What is asked for up front if they accept. Left out, the business's default deposit is used. */
  deposit: MoneyTerms.optional(),
  /** When it stops being good. Left out, sending works it out from the business's settings. */
  expiresOn: localDate.nullable().optional(),
});
export const EstimateUpdateInput = z.object({
  ...inWorkspace,
  estimateId: uuid,
  ...documentHeader,
  deposit: MoneyTerms.optional(),
  expiresOn: localDate.nullable().optional(),
  /**
   * The revision the editor loaded. Someone else's save in between is refused rather than overwritten
   * (`document_conflict`), as the calendar builder does.
   */
  baseRevision: z.int().min(1),
});
export const EstimateRefInput = z.object({ ...inWorkspace, estimateId: uuid });
export const EstimateSendInput = z.object({
  ...inWorkspace,
  estimateId: uuid,
  /** How the customer is told. The worker sends it; this records what was asked for. */
  channels: z
    .array(z.enum(['sms', 'email']))
    .max(2)
    .default(['email']),
  message: z.string().trim().max(2_000).nullable().default(null),
});
export const EstimateVoidInput = z.object({
  ...inWorkspace,
  estimateId: uuid,
  reason: reason500.optional(),
});
export const EstimateMarkAcceptedInput = z.object({
  ...inWorkspace,
  estimateId: uuid,
  /** Who said yes, as they gave it on the phone. Any non-empty name is taken. */
  name: z.string().trim().min(1, 'Who said yes?').max(120),
  note: reason500.optional(),
});
export const EstimateConvertInput = z.object({
  ...inWorkspace,
  estimateId: uuid,
  /**
   * 'standard' copies every line and carries the deposit through as what to ask for first. 'deposit' raises
   * the deposit on its own, as a one-line invoice, for a business that bills it before the work.
   */
  purpose: z.enum(['standard', 'deposit']).default('standard'),
  dueOn: localDate.nullable().optional(),
  connectionId: uuid.nullable().optional(),
});
export const EstimateConvertOutput = z.object({
  estimateId: uuid,
  invoiceId: uuid,
  purpose: invoicePurpose,
  totalCents: z.number(),
  /** What the estimate asked for up front, carried through so the invoice page can offer it first. */
  depositCents: z.number(),
});

/** Worker: what the customer did on /e/<token>. */
export const EstimateAcceptOnlineInput = z.object({
  ...inWorkspace,
  estimateId: uuid,
  /** Whatever they typed. People type "Maria L." — a hard match turns an approval into a support call. */
  name: z.string().trim().min(1, 'Type your name.').max(120),
  /** The exact words shown above the Approve button, kept with the acceptance. */
  wording: z.string().trim().min(1).max(1_000),
});
export const EstimateDeclineOnlineInput = z.object({
  ...inWorkspace,
  estimateId: uuid,
  name: z.string().trim().min(1).max(120).nullable().default(null),
  reason: z.string().trim().max(1_000).nullable().default(null),
});
export const DocumentRecordViewInput = z.object({
  ...inWorkspace,
  documentId: uuid,
});
export const DocumentViewOutput = z.object({
  documentId: uuid,
  firstViewedAt: isoDateTime.nullable(),
  lastViewedAt: isoDateTime,
  changed: z.boolean(),
});

export const EstimateStateOutput = z.object({
  estimateId: uuid,
  status: estimateStatus,
  number: z.string().nullable(),
  /** The newest revision of the document, for the editor's next save. */
  revision: z.int(),
  totalCents: z.number(),
  changed: z.boolean(),
});
export const EstimateAcceptedOutput = z.object({
  estimateId: uuid,
  status: estimateStatus,
  acceptedAt: isoDateTime,
  acceptedName: z.string(),
  acceptedVia: z.enum(['link', 'staff']),
  /** A hash of the lines and the totals exactly as they were accepted. */
  acceptedHash: z.string(),
  wording: z.string(),
});

export const EstimateSummaryOut = z.object({
  id: uuid,
  publicRef: z.string(),
  number: z.string().nullable(),
  status: estimateStatus,
  /** What it reads as right now: 'viewed' for a sent one the customer opened, 'expired' past its date. */
  state: z.string(),
  title: z.string().nullable(),
  person: personOut,
  leadId: uuid.nullable(),
  assignee: userOut.nullable(),
  totals: MoneyTotalsOut,
  /** What was asked for up front, as the person wrote it: "25%" stays a percentage across a reload. */
  deposit: MoneyTermsOut,
  /** And what that comes to on this total, which is the figure every screen shows. */
  depositCents: z.number(),
  expiresOn: localDate.nullable(),
  sentAt: isoDateTime.nullable(),
  firstViewedAt: isoDateTime.nullable(),
  acceptedAt: isoDateTime.nullable(),
  declinedAt: isoDateTime.nullable(),
  voidedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export const EstimateListInput = z.object({
  ...inWorkspace,
  status: z.array(estimateStatus).max(ESTIMATE_STATUSES.length).optional(),
  personId: uuid.optional(),
  leadId: uuid.optional(),
  /** Open ones only: sent and still unanswered. */
  openOnly: z.boolean().default(false),
  search: z.string().trim().max(120).optional(),
  limit: z.int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});
export const EstimateListOutput = z.object({
  estimates: z.array(EstimateSummaryOut),
  nextCursor: z.string().nullable(),
});
export const EstimateGetInput = z.object({ ...inWorkspace, estimateId: uuid });
export const EstimateGetOutput = z.object({
  estimate: EstimateSummaryOut.extend({
    notes: z.string().nullable(),
    revision: z.int(),
    linkVersion: z.int(),
    acceptedName: z.string().nullable(),
    acceptedVia: z.enum(['link', 'staff']).nullable(),
    acceptedBy: userOut.nullable(),
    acceptedWording: z.string().nullable(),
    declinedReason: z.string().nullable(),
    voidReason: z.string().nullable(),
    lines: z.array(MoneyLineOut),
  }),
  /** The invoices raised from it, newest first. */
  invoices: z.array(
    z.object({
      id: uuid,
      number: z.string().nullable(),
      status: invoiceStatus,
      /** What it reads as on screen, as `InvoiceSummaryOut.state` does: a refunded invoice is stored as paid. */
      state: z.string(),
      purpose: invoicePurpose,
      totalCents: z.number(),
      balanceCents: z.number(),
    }),
  ),
});

// ---------- invoices ----------

export const InvoiceCreateInput = z.object({
  ...inWorkspace,
  ...documentHeader,
  purpose: invoicePurpose.default('standard'),
  origin: moneyOrigin.default('staff'),
  estimateId: uuid.nullable().optional(),
  /** The booking this is for: the seat, so a deposit and a balance both point at one visit. */
  attendeeId: uuid.nullable().optional(),
  subscriptionId: uuid.nullable().optional(),
  /** Which connected account it is paid into; left out, the business's default is used. */
  connectionId: uuid.nullable().optional(),
  dueOn: localDate.nullable().optional(),
  /** The wording shown ("Net 15"). Left out, the business's terms are used. */
  terms: z.string().trim().max(2_000).nullable().optional(),
});
export const InvoiceUpdateInput = z.object({
  ...inWorkspace,
  invoiceId: uuid,
  ...documentHeader,
  connectionId: uuid.nullable().optional(),
  dueOn: localDate.nullable().optional(),
  terms: z.string().trim().max(2_000).nullable().optional(),
  baseRevision: z.int().min(1),
});
export const InvoiceRefInput = z.object({ ...inWorkspace, invoiceId: uuid });
export const InvoiceSendInput = z.object({
  ...inWorkspace,
  invoiceId: uuid,
  channels: z
    .array(z.enum(['sms', 'email']))
    .max(2)
    .default(['email']),
  message: z.string().trim().max(2_000).nullable().default(null),
});
export const InvoiceVoidInput = z.object({
  ...inWorkspace,
  invoiceId: uuid,
  reason: reason500.optional(),
});
export const InvoiceStateOutput = z.object({
  invoiceId: uuid,
  status: invoiceStatus,
  number: z.string().nullable(),
  revision: z.int(),
  totalCents: z.number(),
  balanceCents: z.number(),
  dueOn: localDate.nullable(),
  changed: z.boolean(),
});

/** A person records cash, a cheque, or money taken some other way off the system. */
export const InvoiceRecordCashPaymentInput = z.object({
  ...inWorkspace,
  invoiceId: uuid,
  amountCents: cents.min(1, 'How much was paid?'),
  method: z.enum(['cash', 'check', 'other']).default('cash'),
  /** When it was taken, if it wasn't just now. */
  receivedAt: isoDateTime.optional(),
  reference: z.string().trim().max(120).nullable().optional(),
});

/** Worker: what a provider said about a payment. Its status only ever moves forward. */
export const InvoiceRecordPaymentInput = z.object({
  ...inWorkspace,
  invoiceId: uuid,
  /** The row to advance; left out, it is found by the provider's id or the idempotency key, or created. */
  paymentId: uuid.optional(),
  amountCents: cents.min(1),
  method: paymentMethod,
  provider: paymentProvider,
  connectionId: uuid.nullable().default(null),
  providerPaymentId: providerId.nullable().default(null),
  /** The provider's own word for where it is ('requires_capture', 'pending'), kept beside ours. */
  providerStatus: providerWord.nullable().default(null),
  status: paymentStatus,
  failureCode: providerWord.nullable().default(null),
  feeCents: cents.nullable().default(null),
  netCents: cents.nullable().default(null),
  receivedAt: isoDateTime.nullable().default(null),
  /** What the card was, where the provider said so: "Visa", "4242". Never the number. */
  cardBrand: z.string().trim().min(1).max(40).nullable().default(null),
  cardLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Four digits.')
    .nullable()
    .default(null),
  idempotencyKey: idempotencyKey.nullable().default(null),
});
export const PaymentStateOutput = z.object({
  paymentId: uuid,
  invoiceId: uuid,
  status: paymentStatus,
  amountCents: z.number(),
  /** What the invoice says once the roll-up has recounted it. */
  invoiceStatus,
  invoiceBalanceCents: z.number(),
  changed: z.boolean(),
});

/** Worker: the overdue job. It skips an invoice with a payment on its way. */
export const InvoiceMarkOverdueInput = z.object({ ...inWorkspace, invoiceId: uuid });
export const InvoiceOverdueOutput = z.object({
  invoiceId: uuid,
  status: invoiceStatus,
  changed: z.boolean(),
  /** Why it was left alone: settling, nothing owed, no due date, or not late yet. */
  skipped: z.string().nullable(),
});

export const InvoiceSummaryOut = z.object({
  id: uuid,
  publicRef: z.string(),
  number: z.string().nullable(),
  status: invoiceStatus,
  /**
   * 'paying' while a bank transfer settles, 'overdue' once it is late, 'viewed' when they opened it, and
   * 'refunded' or 'partly_refunded' once money paid on it went back (it stays paid: a refund never reopens it).
   */
  state: z.string(),
  purpose: invoicePurpose,
  origin: moneyOrigin,
  title: z.string().nullable(),
  person: personOut,
  leadId: uuid.nullable(),
  attendeeId: uuid.nullable(),
  estimateId: uuid.nullable(),
  subscriptionId: uuid.nullable(),
  connectionId: uuid.nullable(),
  assignee: userOut.nullable(),
  totals: MoneyTotalsOut,
  amountPaidCents: z.number(),
  amountRefundedCents: z.number(),
  balanceCents: z.number(),
  dueOn: localDate.nullable(),
  terms: z.string().nullable(),
  sentAt: isoDateTime.nullable(),
  firstViewedAt: isoDateTime.nullable(),
  paidAt: isoDateTime.nullable(),
  voidedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export const InvoiceListInput = z.object({
  ...inWorkspace,
  status: z.array(invoiceStatus).max(INVOICE_STATUSES.length).optional(),
  purpose: z.array(invoicePurpose).max(INVOICE_PURPOSES.length).optional(),
  personId: uuid.optional(),
  leadId: uuid.optional(),
  attendeeId: uuid.optional(),
  subscriptionId: uuid.optional(),
  /** Money still expected: sent, partly paid or overdue. */
  openOnly: z.boolean().default(false),
  search: z.string().trim().max(120).optional(),
  limit: z.int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});
export const InvoiceListOutput = z.object({
  invoices: z.array(InvoiceSummaryOut),
  nextCursor: z.string().nullable(),
});

export const PaymentOut = z.object({
  id: uuid,
  invoiceId: uuid,
  amountCents: z.number(),
  method: paymentMethod,
  provider: paymentProvider.nullable(),
  connectionId: uuid.nullable(),
  status: paymentStatus,
  providerStatus: z.string().nullable(),
  failureCode: z.string().nullable(),
  feeCents: z.number().nullable(),
  netCents: z.number().nullable(),
  receivedAt: isoDateTime.nullable(),
  recordedBy: userOut.nullable(),
  refundedCents: z.number(),
  /** What the card was, where the provider said so: "Visa", "4242". Never the number, and null for anything else. */
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  createdAt: isoDateTime,
});
export const RefundOut = z.object({
  id: uuid,
  paymentId: uuid,
  invoiceId: uuid,
  amountCents: z.number(),
  reason: z.string().nullable(),
  status: refundStatus,
  failureCode: z.string().nullable(),
  refundedAt: isoDateTime.nullable(),
  requestedBy: userOut.nullable(),
  createdAt: isoDateTime,
});

export const InvoiceGetInput = z.object({ ...inWorkspace, invoiceId: uuid });
export const InvoiceGetOutput = z.object({
  invoice: InvoiceSummaryOut.extend({
    notes: z.string().nullable(),
    revision: z.int(),
    linkVersion: z.int(),
    voidReason: z.string().nullable(),
    lines: z.array(MoneyLineOut),
  }),
  payments: z.array(PaymentOut),
  refunds: z.array(RefundOut),
});

export const PaymentListInput = z.object({
  ...inWorkspace,
  invoiceId: uuid.optional(),
  personId: uuid.optional(),
  status: z.array(paymentStatus).max(PAYMENT_STATUSES.length).optional(),
  method: z.array(paymentMethod).max(PAYMENT_METHODS.length).optional(),
  /** Only what actually landed, for "what did we collect?". */
  succeededOnly: z.boolean().default(false),
  since: isoDateTime.optional(),
  limit: z.int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});
export const PaymentListOutput = z.object({
  payments: z.array(
    PaymentOut.extend({ person: personOut.nullable(), invoiceNumber: z.string().nullable() }),
  ),
  nextCursor: z.string().nullable(),
});

// ---------- refunds ----------

export const PaymentRefundInput = z.object({
  ...inWorkspace,
  paymentId: uuid,
  /** Left out, everything still refundable on that payment. */
  amountCents: cents.min(1).optional(),
  reason: reason500.optional(),
  idempotencyKey: idempotencyKey.optional(),
});
export const RefundStateOutput = z.object({
  refundId: uuid,
  paymentId: uuid,
  invoiceId: uuid,
  amountCents: z.number(),
  status: refundStatus,
  /** True for cash or a cheque: there is no provider to call, so the worker settles it at once. */
  manual: z.boolean(),
});
/** Worker: what the provider said about a refund. */
export const PaymentRecordRefundInput = z.object({
  ...inWorkspace,
  refundId: uuid,
  status: refundStatus,
  providerRefundId: providerId.nullable().default(null),
  providerStatus: providerWord.nullable().default(null),
  failureCode: providerWord.nullable().default(null),
  refundedAt: isoDateTime.nullable().default(null),
});

// ---------- subscriptions ----------

export const SubscriptionStartInput = z.object({
  ...inWorkspace,
  personId: uuid,
  /** The catalogue plan it is sold from; its price and what it includes are copied onto the subscription. */
  planId: uuid.nullable().optional(),
  /** Without a catalogue plan, the plan as sold. */
  planName: name160.optional(),
  priceCents: cents.optional(),
  interval: planInterval.optional(),
  intervalCount: z.int().min(1).max(36).optional(),
  taxable: z.boolean().optional(),
  includes: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  leadId: uuid.nullable().optional(),
  connectionId: uuid.nullable().optional(),
  startedOn: localDate.nullable().optional(),
});
export const SubscriptionRefInput = z.object({ ...inWorkspace, subscriptionId: uuid });
/**
 * Which connected account a plan bills through. Only before it exists at a provider, or after the account it
 * billed through went away — a plan the provider already holds cannot be moved to another account.
 */
export const SubscriptionSetConnectionInput = z.object({
  ...inWorkspace,
  subscriptionId: uuid,
  connectionId: uuid.nullable(),
});
/**
 * Ask the customer for a card. A plan bills at the provider, and neither provider will bill a customer they
 * have no card for — so a plan starts waiting, the customer gets their own link, and they put one on it.
 */
export const SubscriptionRequestCardInput = z.object({
  ...inWorkspace,
  subscriptionId: uuid,
  /** How the link goes out; none means "just give me the link to send myself". */
  channels: z
    .array(z.enum(['sms', 'email']))
    .max(2)
    .default([]),
  message: z.string().trim().max(2_000).nullable().default(null),
});
export const SubscriptionCardOutput = z.object({
  subscriptionId: uuid,
  status: subscriptionStatus,
  /** Set while it waits on them; null the moment a card lands. */
  cardRequestedAt: isoDateTime.nullable(),
  hasCard: z.boolean(),
  changed: z.boolean(),
});

/** Worker: the customer put a card on their plan, and this is what the provider handed back. */
export const SubscriptionRecordCardInput = z.object({
  ...inWorkspace,
  subscriptionId: uuid,
  provider: paymentProvider,
  connectionId: uuid.nullable().default(null),
  /** The provider's customer, so the plan is created against the same one the card is on. */
  customerRef: z.string().trim().min(1).max(200),
  /** The provider's token for the card. Never a number. */
  methodToken: z.string().trim().min(1).max(4_000),
  cardBrand: z.string().trim().min(1).max(40).nullable().default(null),
  cardLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Four digits.')
    .nullable()
    .default(null),
  cardExpiryMonth: z.int().min(1).max(12).nullable().default(null),
  cardExpiryYear: z.int().min(2000).max(2100).nullable().default(null),
});

export const SubscriptionCancelInput = z.object({
  ...inWorkspace,
  subscriptionId: uuid,
  reason: reason500.optional(),
});
export const SubscriptionStateOutput = z.object({
  subscriptionId: uuid,
  status: subscriptionStatus,
  nextBillingOn: localDate.nullable(),
  changed: z.boolean(),
});

/** Worker: the provider billed a cycle, activated the plan, or a card failed. */
export const SubscriptionRecordCycleInput = z.object({
  ...inWorkspace,
  subscriptionId: uuid,
  outcome: z.enum(['activated', 'billed', 'failed', 'ended', 'unmanaged']),
  /** Which provider is holding the plan, once one does. Set with the first answer and never changed after. */
  provider: paymentProvider.nullable().default(null),
  externalSubscriptionId: providerId.nullable().default(null),
  /** The invoice the cycle raised, when it raised one. */
  invoiceId: uuid.nullable().default(null),
  currentPeriodStart: localDate.nullable().default(null),
  currentPeriodEnd: localDate.nullable().default(null),
  nextBillingOn: localDate.nullable().default(null),
  endedOn: localDate.nullable().default(null),
  message: z.string().trim().min(1).max(2_000).nullable().default(null),
});

export const SubscriptionOut = z.object({
  id: uuid,
  publicRef: z.string(),
  status: subscriptionStatus,
  planId: uuid.nullable(),
  planName: z.string(),
  priceCents: z.number(),
  interval: planInterval,
  intervalCount: z.int(),
  taxable: z.boolean(),
  includes: z.array(z.string()),
  person: personOut,
  leadId: uuid.nullable(),
  connectionId: uuid.nullable(),
  provider: paymentProvider.nullable(),
  /** The provider's own id for the plan ("sub_1P4kR2"), which is what it is called at their end. Not a secret. */
  externalSubscriptionId: z.string().nullable(),
  /** The card the provider bills, as much of it as anyone may ever see. Never the number, and never the token. */
  hasCard: z.boolean(),
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  cardExpiryMonth: z.int().nullable(),
  cardExpiryYear: z.int().nullable(),
  /** Set while the plan is waiting on the customer to put a card on it. */
  cardRequestedAt: isoDateTime.nullable(),
  startedOn: localDate.nullable(),
  currentPeriodStart: localDate.nullable(),
  currentPeriodEnd: localDate.nullable(),
  nextBillingOn: localDate.nullable(),
  pausedAt: isoDateTime.nullable(),
  cancelledAt: isoDateTime.nullable(),
  cancelReason: z.string().nullable(),
  endedOn: localDate.nullable(),
  failedCycles: z.int(),
  lastError: z.string().nullable(),
  createdAt: isoDateTime,
});
export const SubscriptionListInput = z.object({
  ...inWorkspace,
  status: z.array(subscriptionStatus).max(SUBSCRIPTION_STATUSES.length).optional(),
  personId: uuid.optional(),
  planId: uuid.optional(),
  limit: z.int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});
export const SubscriptionListOutput = z.object({
  subscriptions: z.array(SubscriptionOut),
  nextCursor: z.string().nullable(),
});
export const SubscriptionGetInput = z.object({ ...inWorkspace, subscriptionId: uuid });
export const SubscriptionGetOutput = z.object({
  subscription: SubscriptionOut,
  /** The invoices its cycles raised, newest first. */
  invoices: z.array(
    z.object({
      id: uuid,
      number: z.string().nullable(),
      status: invoiceStatus,
      /** What it reads as on screen, as `InvoiceSummaryOut.state` does: a refunded invoice is stored as paid. */
      state: z.string(),
      totalCents: z.number(),
      balanceCents: z.number(),
      dueOn: localDate.nullable(),
      createdAt: isoDateTime,
    }),
  ),
});

// ---------- settings ----------

export const MoneySaveSettingsInput = z.object({ ...inWorkspace, settings: MoneySettings });
export const MoneySaveSettingsOutput = z.object({
  workspaceId: uuid,
  settings: MoneySettings,
  /** What the next estimate and invoice will be numbered, from the counters the save mirrored. */
  nextEstimateNumber: z.string(),
  nextInvoiceNumber: z.string(),
  changed: z.boolean(),
});
export const MoneySettingsGetInput = z.object({ ...inWorkspace });
export const MoneySettingsGetOutput = z.object({
  settings: MoneySettings,
  nextEstimateNumber: z.string(),
  nextInvoiceNumber: z.string(),
});

// ---------- summaries and panels ----------

export const MoneySummaryInput = z.object({
  ...inWorkspace,
  /** How far back "collected" reaches; 30 days by default. */
  days: z.int().min(1).max(365).default(30),
});
export const MoneySummaryOutput = z.object({
  now: isoDateTime,
  /** Sent, partly paid and overdue invoices: what the business is owed. */
  outstandingCents: z.number(),
  outstandingCount: z.int(),
  overdueCents: z.number(),
  overdueCount: z.int(),
  /** Owed, but a payment is on its way. */
  settlingCents: z.number(),
  /** Payments that succeeded in the window, less refunds in the same window. */
  collectedCents: z.number(),
  refundedCents: z.number(),
  /** Estimates out and unanswered. */
  quotedCents: z.number(),
  quotedCount: z.int(),
  /** Plans billing, and what they come to each month. */
  activePlans: z.int(),
  monthlyRecurringCents: z.number(),
});

export const MoneyForRecordInput = z.object({
  ...inWorkspace,
  recordType: z.enum(['lead', 'person', 'appointment']),
  recordId: uuid,
});
export const MoneyForRecordOutput = z.object({
  estimates: z.array(EstimateSummaryOut),
  invoices: z.array(InvoiceSummaryOut),
  subscriptions: z.array(SubscriptionOut),
  /** What this record's invoices still come to, and what has been collected against them. */
  balanceCents: z.number(),
  collectedCents: z.number(),
  quotedCents: z.number(),
});
