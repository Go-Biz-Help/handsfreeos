/**
 * The payment providers' own browser scripts, loaded only once a customer presses Pay and only for the provider
 * the business's account is with. Card numbers are typed into the provider's own fields (frames served from the
 * provider), so they go from the customer's browser straight to Stripe or Square and never touch HandsFreeOS.
 *
 * Both scripts have to come from the provider's own address: Stripe and Square refuse to be bundled, because
 * loading them from their servers is part of what keeps the card fields safe. So there is no package for either,
 * just the few calls the pay pages make, typed here.
 */

// ---------- Stripe.js ----------

export interface StripeError {
  /** `card_error` and `validation_error` carry a message written for the customer; the rest don't. */
  readonly type: string;
  readonly code?: string;
  readonly message?: string;
}

export interface StripePaymentElement {
  mount(el: HTMLElement): void;
  destroy(): void;
  on(event: 'ready', handler: () => void): void;
  on(event: 'loaderror', handler: (e: { error?: StripeError }) => void): void;
}

export interface StripeElements {
  create(
    kind: 'payment',
    options: {
      layout?: { type: 'tabs' | 'accordion' };
      paymentMethodOrder?: string[];
    },
  ): StripePaymentElement;
}

export interface StripeClient {
  elements(options: {
    clientSecret: string;
    appearance?: { theme?: 'stripe' | 'night' | 'flat'; variables?: Record<string, string> };
    loader?: 'auto' | 'always' | 'never';
  }): StripeElements;
  confirmPayment(options: {
    elements: StripeElements;
    confirmParams: { return_url: string };
    redirect: 'if_required';
  }): Promise<{ error?: StripeError; paymentIntent?: { id: string; status: string } }>;
}

type StripeFactory = (publishableKey: string, options?: { stripeAccount?: string }) => StripeClient;

// ---------- Square's Web Payments SDK ----------

export interface SquareTokenResult {
  readonly status: string;
  readonly token?: string;
  /** Field-by-field problems ("Card number is not valid."), written for the customer. */
  readonly errors?: readonly { readonly message?: string; readonly field?: string }[];
}

export interface SquareCard {
  attach(el: HTMLElement): Promise<void>;
  destroy(): Promise<boolean>;
  tokenize(verification?: Record<string, unknown>): Promise<SquareTokenResult>;
}

export interface SquarePayments {
  card(options?: { style?: Record<string, Record<string, string>> }): Promise<SquareCard>;
}

interface SquareGlobal {
  payments(applicationId: string, locationId: string): SquarePayments;
}

declare global {
  interface Window {
    Stripe?: StripeFactory;
    Square?: SquareGlobal;
    paypal?: PayPalNamespace;
  }
}

// ---------- PayPal ----------

/** What PayPal's buttons hand back once the buyer approved the order in PayPal's window. */
export interface PayPalApproval {
  readonly orderID: string;
}

export interface PayPalButtonsOptions {
  readonly style?: Readonly<Record<string, string | number | boolean>>;
  createOrder(): Promise<string>;
  onApprove(data: PayPalApproval): Promise<void>;
  onCancel?(): void;
  onError?(err: unknown): void;
}

export interface PayPalButtonsInstance {
  render(container: HTMLElement): Promise<void>;
  close?(): Promise<void>;
  isEligible?(): boolean;
}

export interface PayPalNamespace {
  Buttons(options: PayPalButtonsOptions): PayPalButtonsInstance;
}

/** What the worker hands the page for PayPal's buttons. Public, all of it. */
export interface PayPalScript {
  readonly clientId: string;
  readonly merchantId: string;
  readonly partnerAttributionId: string | null;
  readonly intent: 'capture' | 'authorize';
  readonly venmo: boolean;
  readonly payLater: boolean;
}

/** What the worker sends for PayPal's buttons on a customer's page. */
export interface PayPalButtonsConfig extends PayPalScript {
  readonly environment: 'live' | 'test';
  /** The stand-in serves its own page: a plain button goes there. */
  readonly standIn: boolean;
}

/**
 * PayPal's script for the business's own PayPal account: our client id (a sandbox one serves the sandbox), the
 * business's merchant id so the money lands with them, and our partner code. Venmo and Pay Later are asked for
 * or turned away as the business set them in Settings → Payments.
 */
export function payPalScriptUrl(s: PayPalScript): string {
  const q = new URLSearchParams({
    'client-id': s.clientId,
    'merchant-id': s.merchantId,
    currency: 'USD',
    intent: s.intent,
    components: 'buttons',
  });
  const enable = [s.venmo ? 'venmo' : null, s.payLater ? 'paylater' : null].filter(Boolean);
  const disable = [s.venmo ? null : 'venmo', s.payLater ? null : 'paylater'].filter(Boolean);
  if (enable.length) q.set('enable-funding', enable.join(','));
  if (disable.length) q.set('disable-funding', disable.join(','));
  return `https://www.paypal.com/sdk/js?${q.toString()}`;
}

/** PayPal's buttons. One page shows one PayPal account, so the script loads once with its settings. */
export async function loadPayPal(s: PayPalScript): Promise<PayPalNamespace> {
  const src = payPalScriptUrl(s);
  if (!window.paypal)
    await loadScript(
      src,
      s.partnerAttributionId ? { partnerAttributionId: s.partnerAttributionId } : {},
    );
  if (!window.paypal) throw new Error('PayPal loaded without paypal');
  return window.paypal;
}

// ---------- loading ----------

const STRIPE_SCRIPT = 'https://js.stripe.com/v3/';
/** Square serves its sandbox from a different address; a sandbox application id says which one it is. */
const SQUARE_SCRIPT = {
  live: 'https://web.squarecdn.com/v1/square.js',
  sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js',
} as const;

const loading = new Map<string, Promise<void>>();

function loadScript(
  src: string,
  data: { readonly partnerAttributionId?: string } = {},
): Promise<void> {
  const known = loading.get(src);
  if (known) return known;
  const next = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    // PayPal reads who the partner is from its script tag.
    if (data.partnerAttributionId)
      script.setAttribute('data-partner-attribution-id', data.partnerAttributionId);
    script.onload = () => resolve();
    script.onerror = () => {
      // A failed load can be tried again on the next press.
      loading.delete(src);
      script.remove();
      reject(new Error(`${src} did not load`));
    };
    document.head.appendChild(script);
  });
  loading.set(src, next);
  return next;
}

/** Stripe.js, signed in as the business's own account so the payment lands in their balance. */
export async function loadStripe(publishableKey: string, accountId: string): Promise<StripeClient> {
  if (!window.Stripe) await loadScript(STRIPE_SCRIPT);
  if (!window.Stripe) throw new Error('Stripe.js loaded without Stripe');
  return window.Stripe(publishableKey, accountId ? { stripeAccount: accountId } : undefined);
}

/** Square's payments for the business's own location. */
export async function loadSquare(
  applicationId: string,
  locationId: string,
): Promise<SquarePayments> {
  const src = applicationId.startsWith('sandbox-') ? SQUARE_SCRIPT.sandbox : SQUARE_SCRIPT.live;
  if (!window.Square) await loadScript(src);
  if (!window.Square) throw new Error('Square loaded without Square');
  return window.Square.payments(applicationId, locationId);
}

/** The colours the page is drawn in where the fields sit, so the provider's fields look like part of it. */
export function pageColours(el: HTMLElement): {
  dark: boolean;
  accent: string;
  text: string;
  muted: string;
  card: string;
  border: string;
  danger: string;
} {
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const theme = document.documentElement.getAttribute('data-theme');
  const dark = theme
    ? theme === 'dark'
    : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  return {
    dark,
    accent: read('--accent', '#2d69d8'),
    text: read('--text', dark ? '#f2f4f8' : '#191d25'),
    muted: read('--text-3', dark ? '#8a909a' : '#676c75'),
    card: read('--card', dark ? '#191d25' : '#ffffff'),
    border: read('--border-strong', dark ? '#3a4049' : '#d2d6dd'),
    danger: read('--danger-text', dark ? '#ffaaa3' : '#862726'),
  };
}
