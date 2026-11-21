/**
 * Which connected account a customer's page pays into, shared by the invoice page (http/money.ts) and the
 * booking deposit step (booking/deposit.ts), so the two never disagree.
 *
 * - **The main account** is the one the invoice or the calendar names, else the business's default. Only a
 *   connection that is signed in, usable and able to take money counts; anything else reads to the customer as
 *   "we can't take a payment right now", never as a provider error.
 * - **PayPal's buttons** (PayPal plan, pick 3a) sit beside the main account's fields whenever the business has a
 *   working PayPal account open to everyone who bills. One kept to some people takes only what is made out to
 *   it, and something made out to an account that is its people's alone ("only theirs") never pays into
 *   anything else. When the main account is PayPal, its buttons are the whole page.
 */
import type { PaymentConnectionRow, PaymentServices } from './index';
import { paymentConnectionUsable } from './index';
import {
  isPaymentProvider,
  type PaymentCapabilities,
  type PaymentMethodKind,
  type PaymentProviderName,
} from './provider';

/** Public keys only: never a secret key, and never Square's access token. */
export interface PaySession {
  readonly provider: PaymentProviderName;
  readonly flow: 'client_confirm' | 'server_charge';
  /** Stripe's `pk_…`, Square's application id, PayPal's client id. Public, and safe on a customer's page. */
  readonly publishableKey: string;
  /** Stripe: the connected account. Square: the merchant. PayPal: the business's merchant id. */
  readonly accountId: string;
  /** Square: the location the Web Payments SDK charges at. */
  readonly locationId: string | null;
}

export interface PayableAccount {
  readonly connection: PaymentConnectionRow;
  readonly session: PaySession;
  readonly methods: readonly PaymentMethodKind[];
}

/** The account a page pays into, and the PayPal account whose buttons sit beside it (the same one when it is PayPal). */
export interface PayableAccounts {
  readonly main: PayableAccount | null;
  readonly payPal: PayableAccount | null;
}

/** Everything PayPal's buttons need on a customer's page. Public, all of it. */
export interface PayPalButtons {
  readonly clientId: string;
  readonly merchantId: string;
  readonly partnerAttributionId: string | null;
  readonly environment: 'live' | 'test';
  readonly intent: 'capture' | 'authorize';
  readonly venmo: boolean;
  readonly payLater: boolean;
  /** The stand-in serves its own page (development and tests): the page shows a plain button that goes there. */
  readonly standIn: boolean;
}

interface WaysToPay {
  readonly bankTransfer: boolean;
}

/** One account as a customer's page can use it, or null when it can't take money right now. */
export function payableOf(
  payments: Pick<PaymentServices, 'providers'>,
  row: PaymentConnectionRow,
  settings: WaysToPay,
): PayableAccount | null {
  if (!paymentConnectionUsable(row)) return null;
  if (!isPaymentProvider(row.provider)) return null;
  const provider = payments.providers[row.provider];
  if (!provider?.configured) return null;
  const caps = (row.capabilities ?? {}) as Partial<PaymentCapabilities>;
  const methods: PaymentMethodKind[] = [];
  // PayPal's buttons are one way in: the customer picks PayPal, Venmo, Pay Later or a card inside them.
  if (row.provider === 'paypal') {
    if (caps.card === true) methods.push('paypal');
  } else {
    // Bank transfer leads: it is the cheap rail, and the business can switch it off.
    if (settings.bankTransfer && caps.bankTransfer === true) methods.push('ach');
    if (caps.card === true) methods.push('card');
  }
  if (!methods.length) return null;
  return {
    connection: row,
    methods,
    session: {
      provider: row.provider,
      flow: provider.flow,
      publishableKey: provider.publishableKey,
      accountId: row.externalAccountId ?? '',
      locationId: row.locationId,
    },
  };
}

/** The main account and PayPal's, from every connection the business has (see the file's header). */
export function payableAccounts(
  payments: Pick<PaymentServices, 'providers'>,
  list: readonly PaymentConnectionRow[],
  connectionId: string | null,
  settings: WaysToPay,
): PayableAccounts {
  const named = connectionId ? list.find((c) => c.id === connectionId) : undefined;
  const chosen = connectionId
    ? named
    : (list.find((c) => c.isDefault && paymentConnectionUsable(c)) ??
      list.find((c) => paymentConnectionUsable(c)));
  const main = chosen ? payableOf(payments, chosen, settings) : null;
  if (main?.session.provider === 'paypal') return { main, payPal: main };
  const payPalRow =
    named?.usedBy === 'only_theirs'
      ? undefined
      : list.find(
          (c) => c.provider === 'paypal' && c.usedBy === 'everyone' && paymentConnectionUsable(c),
        );
  return { main, payPal: payPalRow ? payableOf(payments, payPalRow, settings) : null };
}

/**
 * What PayPal's buttons need on the page: our client id, the business's PayPal merchant id, our partner code,
 * and which of its extra buttons the business left on. A deposit is held, not taken, and PayPal holds only from
 * a PayPal account or a card, so Venmo and Pay Later stay off then.
 */
export function payPalButtonsOf(
  payments: Pick<PaymentServices, 'providers' | 'fake'>,
  a: PayableAccount | null,
  settings: { readonly venmo: boolean; readonly payLater: boolean },
  hold = false,
): PayPalButtons | null {
  if (!a || a.session.provider !== 'paypal') return null;
  return {
    clientId: a.session.publishableKey,
    merchantId: a.session.accountId,
    partnerAttributionId: payments.providers.paypal?.partnerAttributionId ?? null,
    environment: a.connection.environment === 'live' ? 'live' : 'test',
    intent: hold ? 'authorize' : 'capture',
    venmo: settings.venmo && !hold,
    payLater: settings.payLater && !hold,
    standIn: !!payments.fake,
  };
}

/** The account a second press is read back through: the one its payment row was started in. */
export function accountOfStarted(
  accounts: PayableAccounts,
  connectionId: string | null,
): PayableAccount | null {
  return (
    [accounts.main, accounts.payPal].find((a) => a && a.connection.id === connectionId) ?? null
  );
}
