/**
 * The customer's money pages (`/e/<token>` and `/i/<token>`) talking to the worker's `/public` routes. No
 * session: the customer is signed out and the token in the address is the whole of the permission, so every
 * call is made from the customer's own browser — the worker's per-address limits then count per customer, not
 * per server — and every one is `no-store` with `no-referrer`, so the token never sits in a cache or leaves in
 * a Referer header.
 *
 * Modelled on `public-booking.ts`, and the same rule holds: **anything that changes something is a POST**,
 * including "this was opened", because mail scanners follow links.
 */
import { publicEnv } from '../env';
import { ApiError } from './errors';
import type { PublicBusiness } from './public-booking';

export type { PublicBusiness };

/** Never cached, and the token never travels on as a referrer. */
const PRIVATE: RequestInit = { cache: 'no-store', referrerPolicy: 'no-referrer' };

type ErrorBody = {
  error?: { code?: string; message?: string; rule?: string; details?: unknown };
} | null;

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, init);
  } catch {
    throw new ApiError(
      0,
      'internal',
      'We couldn’t reach us just now. Check your connection and try again.',
    );
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as ErrorBody)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'internal',
      err?.message ?? 'Something went wrong. Please try again.',
      err?.rule,
      err?.details,
    );
  }
  return json as T;
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, {
    ...PRIVATE,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const seg = encodeURIComponent;
const estimatePath = (token: string) => `/public/estimate/${seg(token)}`;
const invoicePath = (token: string) => `/public/invoice/${seg(token)}`;

// ---- What a document looks like to the person who was sent it ----

export interface PublicCustomer {
  readonly name: string;
  readonly email: string | null;
  /** Already formatted for reading: "(713) 555-0100". */
  readonly phone: string | null;
}

export interface MoneyTotals {
  readonly subtotalCents: number;
  readonly discountCents: number;
  /** What the tax was worked out on — only the taxable lines, after discounts. */
  readonly taxableBaseCents: number;
  readonly taxCents: number;
  readonly taxRateBp: number;
  readonly taxLabel: string | null;
  readonly totalCents: number;
  readonly currency: string;
}

export interface PublicMoneyLine {
  readonly id: string;
  readonly position: number;
  readonly productId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly quantity: number;
  readonly unitLabel: string;
  readonly unitPriceCents: number;
  readonly taxable: boolean;
  /** Money off this line as it was written. */
  readonly discountCents: number;
  /** Its share of the discount on the whole document. */
  readonly allocatedCents: number;
  readonly amountCents: number;
  readonly netCents: number;
}

/** `draft` never reaches a customer: the worker answers a draft's link as "this link doesn't work". */
export type PublicEstimateState = 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'void';

/** Why an estimate can't be answered any more, in the worker's words rather than the page's guess. */
export type EstimateBlockedReason = 'expired' | 'withdrawn' | 'answered';

export interface EstimateAnswer {
  readonly canAccept: boolean;
  readonly canDecline: boolean;
  readonly reason: EstimateBlockedReason | null;
  /**
   * The sentence above Approve, **word for word what is stored with the acceptance**. Rendered as it arrives:
   * what the business can show a year later has to be what was on screen.
   */
  readonly wording: string;
  readonly nameLabel: string;
  readonly acceptLabel: string;
  readonly declineLabel: string;
  readonly acceptedAt: string | null;
  readonly acceptedName: string | null;
  readonly acceptedVia: string | null;
  readonly declinedAt: string | null;
  readonly declinedReason: string | null;
}

export interface PublicEstimateView {
  readonly state: PublicEstimateState;
  readonly business: PublicBusiness;
  readonly customer: PublicCustomer;
  readonly estimate: {
    readonly number: string | null;
    readonly title: string | null;
    readonly notes: string | null;
    readonly currency: string;
    readonly lines: readonly PublicMoneyLine[];
    readonly totals: MoneyTotals;
    /** What is asked for up front if they approve; 0 when nothing is. */
    readonly depositCents: number;
    /** The business-local day it stops being good ('YYYY-MM-DD'), and that day's closing instant. */
    readonly expiresOn: string | null;
    readonly expiresAt: string | null;
    readonly sentAt: string | null;
  };
  readonly answer: EstimateAnswer;
}

export interface PublicInvoiceView {
  readonly state: 'sent' | 'viewed' | 'partly_paid' | 'paid' | 'overdue' | 'paying' | 'void';
  readonly business: PublicBusiness;
  readonly customer: PublicCustomer;
  readonly invoice: {
    readonly number: string | null;
    readonly title: string | null;
    readonly notes: string | null;
    readonly currency: string;
    readonly lines: readonly PublicMoneyLine[];
    readonly totals: MoneyTotals;
    readonly dueOn: string | null;
    readonly terms: string | null;
    readonly sentAt: string | null;
    readonly paidAt: string | null;
    readonly amountPaidCents: number;
    readonly amountRefundedCents: number;
    /** What is still owed today — the deposit and anything else paid is already off it. */
    readonly balanceCents: number;
  };
  /** What has been paid so far, settled or still on its way. Never a fee, a provider id or who took it. */
  readonly payments: readonly {
    readonly amountCents: number;
    readonly method: string;
    readonly status: 'processing' | 'succeeded';
    readonly receivedAt: string | null;
    readonly createdAt: string;
  }[];
  readonly pay: {
    readonly canPay: boolean;
    readonly reason: 'withdrawn' | 'paid' | 'no_account' | null;
    readonly amountCents: number;
    readonly payLabel: string;
    /** In the order they are offered: bank transfer leads when the business takes one. */
    readonly methods: readonly PayMethod[];
    readonly session: PaySession | null;
  };
}

export type PayMethod = 'card' | 'ach';

/** Public keys only — a publishable key and the account it belongs to. Never a secret, never a token. */
export interface PaySession {
  readonly provider: 'stripe' | 'square';
  readonly flow: 'client_confirm' | 'server_charge';
  readonly publishableKey: string;
  readonly accountId: string;
  readonly locationId: string | null;
}

export type PaymentState = 'requires_payment' | 'processing' | 'succeeded' | 'failed';

/** Phase one: what the browser needs to collect a card or a bank account at the provider. */
export interface PreparedPay {
  readonly stage: 'prepared';
  readonly payment: {
    readonly paymentId: string | null;
    readonly status: 'requires_payment';
    readonly amountCents: number;
    readonly method: PayMethod;
    readonly flow: 'client_confirm' | 'server_charge';
    readonly publishableKey: string;
    readonly accountId: string;
    readonly locationId: string | null;
    readonly clientSecret: string | null;
    readonly providerPaymentId: string | null;
    readonly methods: readonly PayMethod[];
    /** The provider's own page, where it serves one; null when its fields run inside this page. */
    readonly hostedUrl: string | null;
    /** Always this invoice's own address, decided by the worker and never by this page. */
    readonly returnUrl: string;
  };
  readonly invoice: PublicInvoiceView;
}

/** Phase two: what actually happened. A decline arrives here, not as an error. */
export interface RecordedPay {
  readonly stage: 'recorded';
  readonly payment: {
    readonly paymentId: string;
    readonly status: PaymentState;
    readonly amountCents: number;
    readonly method: PayMethod;
    readonly failureMessage: string | null;
    readonly failureCode: string | null;
    readonly receivedAt: string | null;
    /** The same press answered again: the payment it already made, not a second one. */
    readonly repeat?: boolean;
  };
  readonly invoice: PublicInvoiceView;
}

export type PayAnswer = PreparedPay | RecordedPay;

export interface PayRequest {
  /** One per Pay press, kept across the trip to the provider: a retry answers, it never charges twice. */
  readonly clientId: string;
  readonly method?: PayMethod;
  /** Square: the one-time token the browser minted from the card. */
  readonly sourceToken?: string | null;
  /** Stripe: the intent the browser has just confirmed, read back from the provider. */
  readonly providerPaymentId?: string | null;
  readonly website?: string;
}

// ---- The calls ----

export const getEstimate = (token: string) =>
  call<PublicEstimateView>(estimatePath(token), PRIVATE);

/** "This was opened." A POST because a GET must never change anything and scanners open links. */
export const markEstimateViewed = (token: string) =>
  post<{ firstViewedAt: string | null; changed: boolean }>(`${estimatePath(token)}/viewed`, {});

export const acceptEstimate = (token: string, body: { name: string; website?: string }) =>
  post<PublicEstimateView & { accepted: { at: string; name: string } }>(
    `${estimatePath(token)}/accept`,
    body,
  );

export const declineEstimate = (
  token: string,
  body: { name?: string | null; reason?: string | null; website?: string },
) => post<PublicEstimateView>(`${estimatePath(token)}/decline`, body);

export const getInvoice = (token: string) => call<PublicInvoiceView>(invoicePath(token), PRIVATE);

export const markInvoiceViewed = (token: string) =>
  post<{ firstViewedAt: string | null; changed: boolean }>(`${invoicePath(token)}/viewed`, {});

export const payInvoice = (token: string, body: PayRequest) =>
  post<PayAnswer>(`${invoicePath(token)}/pay`, body);
