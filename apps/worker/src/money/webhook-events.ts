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
 */
import {
  centsOf,
  isoOf,
  type PaymentEvent,
  type PaymentProviderName,
  type PaymentState,
  type RefundState,
} from '../payments/provider';

/** Neither provider sends anything near this; a bigger body is refused before it is read. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

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
  'charge.refunded': 'payment.refunded',
  'refund.updated': 'payment.refunded',
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
  return provider === 'stripe'
    ? (STRIPE_PAYMENT_STATE[status] ?? null)
    : (SQUARE_PAYMENT_STATE[status.toUpperCase()] ?? null);
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
}

export function paymentFactsOf(
  provider: PaymentProviderName,
  event: PaymentEvent,
): PaymentEventFacts {
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
  };
}

export interface RefundEventFacts {
  readonly providerRefundId: string | null;
  readonly providerPaymentId: string | null;
  readonly status: RefundState | null;
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

export function refundFactsOf(
  provider: PaymentProviderName,
  event: PaymentEvent,
): RefundEventFacts {
  const data = unwrap(event.data, 'refund');
  const money = isRecord(data['amount_money']) ? data['amount_money'] : null;
  const status = str(data['status']);
  // Stripe's `charge.refunded` carries the charge, not the refund: the refund's own id may not be there.
  const isRefundObject = str(data['object']) === 'refund' || !!data['payment_id'];
  return {
    providerRefundId: isRefundObject ? str(data['id']) : null,
    providerPaymentId: str(data['payment_intent']) ?? str(data['payment_id']),
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
  readonly providerPaymentId: string | null;
  readonly amountCents: number | null;
  readonly reason: string | null;
  readonly state: string | null;
}

export function disputeFactsOf(event: PaymentEvent): DisputeEventFacts {
  const data = unwrap(event.data, 'dispute');
  const money = isRecord(data['amount_money']) ? data['amount_money'] : null;
  return {
    providerPaymentId: str(data['payment_intent']) ?? str(data['payment_id']),
    amountCents: centsOf(money ? money['amount'] : data['amount']),
    reason: str(data['reason']),
    state: str(data['state']) ?? str(data['status']),
  };
}
