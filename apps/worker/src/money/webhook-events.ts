/**
 * Reading a provider's event: our own name for what it means, and the few facts a processor acts on.
 *
 * The signature and the envelope are the provider adapters' (`webhooks.verify` / `webhooks.parse`,
 * payments/provider.ts). What is left is the part that has to know both providers' vocabularies, and it lives
 * here so the routes stay about HTTP and the processors stay about our own tables.
 *
 * Two shapes of the same event have to be read: **Square nests the object under its type** —
 * `data.object.payment`, `data.object.refund` — while the stand-in (and Stripe, which never nests) send it
 * flat. `unwrap` accepts either, so the same processor reads a real Square webhook and a stand-in one.
 *
 * PayPal (the PayPal plan, part 2) is read on its own: its events carry the capture, refund or dispute itself as
 * `resource`, money as a decimal string ("12.34"), and a vocabulary of its own (`PAYMENT.CAPTURE.COMPLETED`).
 */
import {
  centsOf,
  centsOfDecimal,
  isoOf,
  type PaymentEvent,
  type PaymentProviderName,
  type PaymentState,
  type RefundState,
} from '../payments/provider';

/** No provider sends anything near this; a bigger body is refused before it is read. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

/**
 * The headers each provider signs with, handed to its own `webhooks.verify`: Stripe's one, Square's one, and
 * PayPal's five (which certificate, which delivery, when, the algorithm and the signature).
 */
export const WEBHOOK_SIGNATURE_HEADERS = [
  'stripe-signature',
  'x-square-hmacsha256-signature',
  'paypal-transmission-id',
  'paypal-transmission-time',
  'paypal-transmission-sig',
  'paypal-cert-url',
  'paypal-auth-algo',
] as const;

/**
 * What an event means, in our words. `provider:kind` is the processor key, and the kind is what the
 * `webhook_deliveries` row is stored under, so the table reads in our vocabulary and not in two of theirs.
 */
export const PAYMENT_EVENT_KINDS = [
  'payment.succeeded',
  'payment.processing',
  'payment.failed',
  'payment.refunded',
  'payment.disputed',
  /** A plan's cycle billed (or didn't). */
  'invoice.paid',
  'invoice.payment_failed',
  'subscription.changed',
  'account.updated',
  'payment_connection.revoked',
] as const;
export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

type Data = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Data =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/** Square's `data.object.payment`, or the object itself when it isn't nested. */
export function unwrap(data: Data, key: string): Data {
  const nested = data[key];
  return isRecord(nested) ? nested : data;
}

// ---- What an event is called here ----

const STRIPE_KINDS: Readonly<Record<string, PaymentEventKind>> = {
  'payment_intent.succeeded': 'payment.succeeded',
  'payment_intent.processing': 'payment.processing',
  // A card held for a deposit: money is set aside, nothing is taken.
  'payment_intent.amount_capturable_updated': 'payment.processing',
  'payment_intent.payment_failed': 'payment.failed',
  'payment_intent.canceled': 'payment.failed',
  // A refund's own events carry it, with its id: one made in Stripe's dashboard is kept from them (decision 19 of
  // the partners plan). `charge.refunded` is about the charge, and is read only to be passed over.
  'refund.created': 'payment.refunded',
  'refund.updated': 'payment.refunded',
  'refund.failed': 'payment.refunded',
  'charge.refunded': 'payment.refunded',
  'charge.refund.updated': 'payment.refunded',
  'charge.dispute.created': 'payment.disputed',
  'charge.dispute.updated': 'payment.disputed',
  'charge.dispute.closed': 'payment.disputed',
  'invoice.paid': 'invoice.paid',
  'invoice.payment_succeeded': 'invoice.paid',
  'invoice.payment_failed': 'invoice.payment_failed',
  'customer.subscription.created': 'subscription.changed',
  'customer.subscription.updated': 'subscription.changed',
  'customer.subscription.paused': 'subscription.changed',
  'customer.subscription.resumed': 'subscription.changed',
  'customer.subscription.deleted': 'subscription.changed',
  'account.updated': 'account.updated',
  'capability.updated': 'account.updated',
  'account.application.deauthorized': 'payment_connection.revoked',
};

const SQUARE_KINDS: Readonly<Record<string, PaymentEventKind>> = {
  'refund.created': 'payment.refunded',
  'refund.updated': 'payment.refunded',
  'dispute.created': 'payment.disputed',
  // Square's current names for a dispute moving on. A subscription made today can only pick these.
  'dispute.state.updated': 'payment.disputed',
  'dispute.evidence.created': 'payment.disputed',
  // The names those had before. Square no longer offers them, but reading them costs nothing.
  'dispute.state.changed': 'payment.disputed',
  'dispute.evidence.added': 'payment.disputed',
  'invoice.payment_made': 'invoice.paid',
  'subscription.created': 'subscription.changed',
  'subscription.updated': 'subscription.changed',
  'merchant.updated': 'account.updated',
  'location.updated': 'account.updated',
  'oauth.authorization.revoked': 'payment_connection.revoked',
};

/**
 * PayPal's names. A capture is the money; an authorization is a booking deposit's hold. A reversal is PayPal
 * taking the money back from the seller (a chargeback it settled, a payment it found was unauthorised), which for
 * the invoice is money given back, so it is read as a refund.
 */
const PAYPAL_KINDS: Readonly<Record<string, PaymentEventKind>> = {
  'PAYMENT.CAPTURE.COMPLETED': 'payment.succeeded',
  'PAYMENT.CAPTURE.PENDING': 'payment.processing',
  'PAYMENT.CAPTURE.DECLINED': 'payment.failed',
  'PAYMENT.CAPTURE.DENIED': 'payment.failed',
  'PAYMENT.CAPTURE.REFUNDED': 'payment.refunded',
  'PAYMENT.CAPTURE.REVERSED': 'payment.refunded',
  'PAYMENT.AUTHORIZATION.CREATED': 'payment.processing',
  'PAYMENT.AUTHORIZATION.VOIDED': 'payment.failed',
  'CUSTOMER.DISPUTE.CREATED': 'payment.disputed',
  'CUSTOMER.DISPUTE.UPDATED': 'payment.disputed',
  'CUSTOMER.DISPUTE.RESOLVED': 'payment.disputed',
  'CUSTOMER.MERCHANT-INTEGRATION.CAPABILITY-UPDATED': 'account.updated',
  'CUSTOMER.MERCHANT-INTEGRATION.SELLER-EMAIL-CONFIRMED': 'account.updated',
  'MERCHANT.PARTNER-CONSENT.REVOKED': 'payment_connection.revoked',
};

/** A PayPal capture's or authorization's status, in our words. */
const PAYPAL_PAYMENT_STATE: Readonly<Record<string, PaymentState>> = {
  COMPLETED: 'succeeded',
  PENDING: 'processing',
  // An authorization: the money is set aside, not taken.
  CREATED: 'processing',
  DECLINED: 'failed',
  DENIED: 'failed',
  FAILED: 'failed',
  VOIDED: 'failed',
  EXPIRED: 'failed',
};

/**
 * Square has no "payment failed" event and no separate "succeeded" one: every payment event is
 * `payment.created` or `payment.updated`, and where the money actually is has to be read off the object.
 */
const SQUARE_PAYMENT_STATE: Readonly<Record<string, PaymentState>> = {
  COMPLETED: 'succeeded',
  APPROVED: 'processing',
  PENDING: 'processing',
  FAILED: 'failed',
  CANCELED: 'failed',
};

const STRIPE_PAYMENT_STATE: Readonly<Record<string, PaymentState>> = {
  succeeded: 'succeeded',
  processing: 'processing',
  requires_capture: 'processing',
  requires_action: 'processing',
  requires_confirmation: 'requires_payment',
  requires_payment_method: 'requires_payment',
  canceled: 'failed',
};

/** Our name for this event, or null when it is one we don't act on (a 200 and a drop). */
export function paymentKindOf(
  provider: PaymentProviderName,
  event: PaymentEvent,
): PaymentEventKind | null {
  if (provider === 'stripe') return STRIPE_KINDS[event.type] ?? null;
  if (provider === 'paypal') return PAYPAL_KINDS[event.type] ?? null;
  const known = SQUARE_KINDS[event.type];
  if (known) return known;
  if (event.type !== 'payment.created' && event.type !== 'payment.updated') return null;
  const state = paymentStateOf(provider, event);
  return state === 'succeeded'
    ? 'payment.succeeded'
    : state === 'failed'
      ? 'payment.failed'
      : 'payment.processing';
}

// ---- The facts a processor acts on ----

/** Where a payment event says the money is, in our own states. */
export function paymentStateOf(
  provider: PaymentProviderName,
  event: PaymentEvent,
): PaymentState | null {
  const data = unwrap(event.data, 'payment');
  const status = str(data['status']);
  if (!status) return null;
  if (provider === 'paypal') return PAYPAL_PAYMENT_STATE[status.toUpperCase()] ?? null;
  return provider === 'stripe'
    ? (STRIPE_PAYMENT_STATE[status] ?? null)
    : (SQUARE_PAYMENT_STATE[status.toUpperCase()] ?? null);
}

/** PayPal's money: `{ currency_code, value: "12.34" }`. */
const payPalCents = (money: unknown): number | null =>
  isRecord(money) ? centsOfDecimal(money['value']) : null;

/** The order (and a deposit's hold) a PayPal capture came from: `supplementary_data.related_ids`. */
function payPalRelatedIds(data: Data): string[] {
  const supplementary = isRecord(data['supplementary_data']) ? data['supplementary_data'] : {};
  const related = isRecord(supplementary['related_ids']) ? supplementary['related_ids'] : {};
  return [str(related['order_id']), str(related['authorization_id'])].filter(
    (id): id is string => !!id && id !== str(data['id']),
  );
}

/** The capture a PayPal refund gives back, from its `up` link (`…/v2/payments/captures/<id>`). */
function payPalCaptureOf(data: Data): string | null {
  const links = Array.isArray(data['links']) ? data['links'] : [];
  for (const link of links) {
    if (!isRecord(link) || link['rel'] !== 'up') continue;
    const m = /\/v2\/payments\/captures\/([^/?#]+)/.exec(String(link['href'] ?? ''));
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

export interface PaymentEventFacts {
  /** The provider's id for the payment: how the row we already wrote is found again. */
  readonly providerPaymentId: string | null;
  readonly status: PaymentState | null;
  /** The provider's own word for it, kept beside ours. */
  readonly providerStatus: string | null;
  readonly amountCents: number | null;
  /** The invoice we told the provider about: Stripe's metadata, Square's `reference_id`. */
  readonly invoiceId: string | null;
  readonly failureCode: string | null;
  readonly receivedAt: string | null;
  /**
   * Other ids the same payment went by, which the row may still hold. PayPal's capture names the order it took
   * (and a deposit's hold), and its event can arrive before our own call has kept the capture's id.
   */
  readonly relatedIds: readonly string[];
}

export function paymentFactsOf(
  provider: PaymentProviderName,
  event: PaymentEvent,
): PaymentEventFacts {
  if (provider === 'paypal') {
    const data = event.data;
    return {
      // The capture's (or the hold's) own id: what the row holds once the order was taken.
      providerPaymentId: str(data['id']),
      status: paymentStateOf(provider, event),
      providerStatus: str(data['status']),
      amountCents: payPalCents(data['amount']),
      // Ours, put on the order as `custom_id`.
      invoiceId: str(data['custom_id']),
      failureCode: isRecord(data['status_details']) ? str(data['status_details']['reason']) : null,
      receivedAt: isoOf(data['update_time']) ?? isoOf(data['create_time']) ?? event.createdAt,
      relatedIds: payPalRelatedIds(data),
    };
  }
  const data = unwrap(event.data, 'payment');
  const metadata = isRecord(data['metadata']) ? data['metadata'] : {};
  const money = isRecord(data['amount_money']) ? data['amount_money'] : null;
  const error = isRecord(data['last_payment_error']) ? data['last_payment_error'] : null;
  const card = isRecord(data['card_details']) ? data['card_details'] : null;
  const cardErrors = Array.isArray(card?.['errors']) ? (card['errors'] as unknown[]) : [];
  const firstCardError = isRecord(cardErrors[0]) ? cardErrors[0] : null;
  return {
    providerPaymentId: str(data['id']),
    status: paymentStateOf(provider, event),
    providerStatus: str(data['status']),
    amountCents: centsOf(money ? money['amount'] : data['amount']),
    invoiceId: str(metadata['invoiceId']) ?? str(data['reference_id']),
    failureCode: str(error?.['code']) ?? str(firstCardError?.['code']) ?? str(data['failure_code']),
    receivedAt: isoOf(data['created_at']) ?? event.createdAt,
    relatedIds: [],
  };
}

export interface RefundEventFacts {
  /** The event carries the refund itself, with its own id; Stripe's `charge.refunded` carries the charge. */
  readonly isRefund: boolean;
  readonly providerRefundId: string | null;
  readonly providerPaymentId: string | null;
  readonly status: RefundState | null;
  /** The provider's own word for it, kept beside ours. */
  readonly providerStatus: string | null;
  readonly amountCents: number | null;
  readonly refundedAt: string | null;
}

const STRIPE_REFUND_STATE: Readonly<Record<string, RefundState>> = {
  succeeded: 'succeeded',
  pending: 'pending',
  failed: 'failed',
  canceled: 'failed',
  requires_action: 'pending',
};

const SQUARE_REFUND_STATE: Readonly<Record<string, RefundState>> = {
  COMPLETED: 'succeeded',
  PENDING: 'pending',
  REJECTED: 'failed',
  FAILED: 'failed',
};

const PAYPAL_REFUND_STATE: Readonly<Record<string, RefundState>> = {
  COMPLETED: 'succeeded',
  PENDING: 'pending',
  FAILED: 'failed',
  CANCELLED: 'failed',
};

export function refundFactsOf(
  provider: PaymentProviderName,
  event: PaymentEvent,
): RefundEventFacts {
  if (provider === 'paypal') {
    const data = event.data;
    const status = str(data['status']);
    return {
      isRefund: true,
      providerRefundId: str(data['id']),
      providerPaymentId: payPalCaptureOf(data),
      providerStatus: status,
      // A reversal carries no status of its own: the money is already back with the buyer.
      status: status ? (PAYPAL_REFUND_STATE[status.toUpperCase()] ?? null) : 'succeeded',
      amountCents: payPalCents(data['amount']),
      refundedAt: isoOf(data['create_time']) ?? event.createdAt,
    };
  }
  const data = unwrap(event.data, 'refund');
  const money = isRecord(data['amount_money']) ? data['amount_money'] : null;
  const status = str(data['status']);
  // Stripe's `charge.refunded` carries the charge, not the refund: the refund's own id may not be there.
  const isRefundObject = str(data['object']) === 'refund' || !!data['payment_id'];
  return {
    isRefund: isRefundObject,
    providerRefundId: isRefundObject ? str(data['id']) : null,
    providerPaymentId: str(data['payment_intent']) ?? str(data['payment_id']),
    providerStatus: status,
    status: status
      ? provider === 'stripe'
        ? (STRIPE_REFUND_STATE[status] ?? null)
        : (SQUARE_REFUND_STATE[status.toUpperCase()] ?? null)
      : // A `charge.refunded` with no status of its own is money already given back.
        'succeeded',
    amountCents: centsOf(money ? money['amount'] : (data['amount'] ?? data['amount_refunded'])),
    refundedAt: event.createdAt,
  };
}

export interface SubscriptionEventFacts {
  readonly providerSubscriptionId: string | null;
  readonly providerStatus: string | null;
  /** The payment the cycle took, when the event names one. */
  readonly providerPaymentId: string | null;
  readonly amountPaidCents: number | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAt: string | null;
}

/**
 * Whose plan this is. A cycle's event is about the invoice it raised and names its plan in `subscription`,
 * which is an id at Stripe and (nested) an object at Square; a plan's own event is the plan itself.
 */
function subscriptionIdOf(data: Data): string | null {
  const named = data['subscription'];
  if (typeof named === 'string' && named.trim() !== '') return named.trim();
  if (isRecord(named)) return str(named['id']);
  return str(data['subscription_id']) ?? str(data['id']);
}

export function subscriptionFactsOf(event: PaymentEvent): SubscriptionEventFacts {
  const data = unwrap(event.data, 'subscription');
  return {
    providerSubscriptionId: subscriptionIdOf(data),
    providerStatus: str(data['status']),
    providerPaymentId: str(data['payment_intent']) ?? str(data['payment_id']),
    amountPaidCents: centsOf(data['amount_paid']),
    currentPeriodStart: isoOf(data['current_period_start']) ?? isoOf(data['charged_through_date']),
    currentPeriodEnd: isoOf(data['current_period_end']) ?? isoOf(data['canceled_date']),
    cancelAt: isoOf(data['cancel_at']),
  };
}

/** What a plan's provider status means for us. Square says `ACTIVE`; Stripe says `active`. */
export function subscriptionOutcomeOf(
  providerStatus: string | null,
): 'activated' | 'failed' | 'ended' | null {
  switch ((providerStatus ?? '').toLowerCase()) {
    case 'active':
    case 'trialing':
      return 'activated';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'deactivated':
      return 'failed';
    case 'canceled':
    case 'cancelled':
    case 'incomplete_expired':
      return 'ended';
    default:
      return null;
  }
}

/** A dispute, as much of it as both providers agree on. */
export interface DisputeEventFacts {
  /** The provider's own id for the dispute: Stripe's `dp_…`, Square's dispute id. */
  readonly providerDisputeId: string | null;
  readonly providerPaymentId: string | null;
  readonly amountCents: number | null;
  readonly reason: string | null;
  /** The provider's own word for where it stands. */
  readonly state: string | null;
  /** Where it stands in our words (`payment.record_dispute`). */
  readonly status: 'open' | 'won' | 'lost' | 'closed';
  /** When the business's answer is due at the provider. */
  readonly respondBy: string | null;
}

/**
 * What a provider's dispute state means here. Stripe says `needs_response`, `under_review`, `won`, `lost`, and
 * `warning_*` for an inquiry that comes before one; Square says `EVIDENCE_REQUIRED`, `PROCESSING`, `WON`, `LOST`,
 * `ACCEPTED` (the seller let it go) and `INQUIRY_*`. Anything not settled, or not said, is still open.
 */
const DISPUTE_SETTLED: Readonly<Record<string, 'won' | 'lost' | 'closed'>> = {
  won: 'won',
  lost: 'lost',
  accepted: 'lost',
  warning_closed: 'closed',
  inquiry_closed: 'closed',
  prevented: 'closed',
};

/**
 * PayPal's settled disputes say how in `dispute_outcome.outcome_code`. A buyer who gave up, or a claim PayPal
 * turned down, leaves the money with the seller.
 */
const PAYPAL_DISPUTE_OUTCOME: Readonly<Record<string, 'won' | 'lost' | 'closed'>> = {
  RESOLVED_SELLER_FAVOUR: 'won',
  DENIED: 'won',
  CANCELED_BY_BUYER: 'won',
  RESOLVED_BUYER_FAVOUR: 'lost',
  ACCEPTED: 'lost',
  RESOLVED_WITH_PAYOUT: 'closed',
};

export function disputeFactsOf(
  event: PaymentEvent,
  provider?: PaymentProviderName,
): DisputeEventFacts {
  if (provider === 'paypal') {
    const data = event.data;
    const disputed = Array.isArray(data['disputed_transactions'])
      ? data['disputed_transactions'].find(isRecord)
      : undefined;
    const outcome = isRecord(data['dispute_outcome'])
      ? str(data['dispute_outcome']['outcome_code'])
      : null;
    const state = str(data['status']);
    return {
      providerDisputeId: str(data['dispute_id']),
      // The seller's side of the payment is the capture we took.
      providerPaymentId: disputed ? str(disputed['seller_transaction_id']) : null,
      amountCents: payPalCents(data['dispute_amount']),
      reason: str(data['reason']),
      state,
      status:
        (outcome && PAYPAL_DISPUTE_OUTCOME[outcome.toUpperCase()]) ||
        (state?.toUpperCase() === 'RESOLVED' ? 'closed' : 'open'),
      respondBy: isoOf(data['seller_response_due_date']),
    };
  }
  const data = unwrap(event.data, 'dispute');
  const money = isRecord(data['amount_money']) ? data['amount_money'] : null;
  // Square keeps the payment one level down, in `disputed_payment`; Stripe names it on the dispute itself.
  const disputed = isRecord(data['disputed_payment']) ? data['disputed_payment'] : {};
  const evidence = isRecord(data['evidence_details']) ? data['evidence_details'] : {};
  const state = str(data['state']) ?? str(data['status']);
  return {
    providerDisputeId: str(data['id']) ?? str(data['dispute_id']),
    providerPaymentId:
      str(data['payment_intent']) ?? str(disputed['payment_id']) ?? str(data['payment_id']),
    amountCents: centsOf(money ? money['amount'] : data['amount']),
    reason: str(data['reason']),
    state,
    status: (state && DISPUTE_SETTLED[state.toLowerCase()]) || 'open',
    respondBy: isoOf(evidence['due_by']) ?? isoOf(data['due_at']),
  };
}
