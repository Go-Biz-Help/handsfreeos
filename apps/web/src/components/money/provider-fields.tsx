'use client';
/**
 * The payment provider's own fields, shown on our page once a customer presses Pay: Stripe's payment box, or
 * Square's card field. `design/m9/Invoice.dc.html` ("Paying by card") is the drawing this follows.
 *
 * The page keeps its own Pay button and calls `submit()` through the ref. What comes back is what phase two of
 * the worker's pay route needs, and nothing else: Stripe's intent once the browser has confirmed it, or the
 * one-time token Square minted from the card. The worker then reads the answer back from the provider, so the
 * page never decides on its own that anything was paid.
 *
 * - **Stripe** offers every way the business switched on in its own dashboard (decided in
 *   apps/worker/test/stripe-requests.test.ts: we never name the methods ourselves), with the one the customer
 *   picked on our page first. A card that needs the bank's own check opens it right here; only a bank that has
 *   to send the customer away comes back through the page's address, with `?payment=` on it.
 * - **Square** takes a card here. Its bank transfer needs Plaid's sign-in, which this page doesn't have, so a
 *   Square account picked for a bank transfer says so plainly instead of showing a dead form.
 *
 * A refusal the provider explains to the customer ("Your card was declined.") is shown under the fields in its
 * words, because those are written for the customer; anything else gets ours.
 */
import { CircleAlert } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {
  loadSquare,
  loadStripe,
  pageColours,
  type SquareCard,
  type StripeClient,
  type StripeElements,
  type StripePaymentElement,
} from '@/lib/payments/provider-scripts';

export type ProviderMethod = 'card' | 'ach';

/** What phase one handed back for the browser: public keys and the intent, never a secret of ours. */
export interface ProviderSession {
  readonly provider: string;
  readonly flow: 'client_confirm' | 'server_charge';
  readonly publishableKey: string;
  readonly accountId: string;
  readonly locationId: string | null;
  readonly clientSecret: string | null;
  readonly providerPaymentId: string | null;
  readonly amountCents: number;
  readonly method: ProviderMethod;
  /** Where a provider that has to send the customer away brings them back: decided by the worker. */
  readonly returnUrl: string;
}

/** What phase two names: the intent the browser confirmed, or the card's one-time token. */
export type ProviderAnswer =
  | { readonly kind: 'confirmed'; readonly providerPaymentId: string }
  | { readonly kind: 'tokenised'; readonly sourceToken: string; readonly method: ProviderMethod };

export interface ProviderFieldsHandle {
  /** Confirms (Stripe) or tokenises (Square). Null: nothing was sent, and the fields say what to fix. */
  submit(): Promise<ProviderAnswer | null>;
}

/** This page can show the provider's fields for this session (the stand-in serves its own page instead). */
export function canShowProviderFields(s: ProviderSession): boolean {
  if (!s.publishableKey) return false;
  if (s.provider === 'stripe')
    return s.flow === 'client_confirm' && !!s.clientSecret && !!s.providerPaymentId;
  if (s.provider === 'square') return s.flow === 'server_charge' && !!s.locationId;
  return false;
}

const NOT_REACHED =
  'We couldn’t reach the payment provider, so nothing was charged. Try again in a minute.';

/** The address a provider that sends the customer away brings them back to, naming the payment. */
function backTo(returnUrl: string, providerPaymentId: string): string {
  const url = new URL(returnUrl, window.location.href);
  url.searchParams.set('payment', providerPaymentId);
  return url.toString();
}

type Mounted =
  | { readonly kind: 'stripe'; readonly stripe: StripeClient; readonly elements: StripeElements }
  | { readonly kind: 'square'; readonly card: SquareCard };

export function ProviderFields({
  session,
  businessName,
  onReady,
  ref,
}: {
  session: ProviderSession;
  businessName: string;
  /** True once the customer can type: the page keeps its Pay button off until then. */
  onReady: (ready: boolean) => void;
  ref?: Ref<ProviderFieldsHandle>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mounted = useRef<Mounted | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  });
  const squareBank = session.provider === 'square' && session.method === 'ach';

  useEffect(() => {
    const el = box.current;
    if (!el || squareBank) return;
    let live = true;
    let stripeElement: StripePaymentElement | null = null;
    let squareCard: SquareCard | null = null;
    setState('loading');
    setMessage(null);
    ready.current(false);
    const colours = pageColours(el);

    const failed = () => {
      if (!live) return;
      setState('failed');
      setMessage(NOT_REACHED);
      ready.current(false);
    };

    if (session.provider === 'stripe' && session.clientSecret) {
      void loadStripe(session.publishableKey, session.accountId)
        .then((stripe) => {
          if (!live) return;
          const elements = stripe.elements({
            clientSecret: session.clientSecret!,
            loader: 'auto',
            appearance: {
              theme: colours.dark ? 'night' : 'stripe',
              variables: {
                colorPrimary: colours.accent,
                colorText: colours.text,
                colorBackground: colours.card,
                colorDanger: colours.danger,
                borderRadius: '8px',
              },
            },
          });
          stripeElement = elements.create('payment', {
            layout: { type: 'tabs' },
            // What they picked on our page leads; everything else the business takes is still there.
            paymentMethodOrder:
              session.method === 'ach' ? ['us_bank_account', 'card'] : ['card', 'us_bank_account'],
          });
          stripeElement.on('ready', () => {
            if (!live) return;
            setState('ready');
            ready.current(true);
          });
          stripeElement.on('loaderror', failed);
          stripeElement.mount(el);
          mounted.current = { kind: 'stripe', stripe, elements };
        })
        .catch(failed);
    } else if (session.provider === 'square' && session.locationId) {
      void loadSquare(session.publishableKey, session.locationId)
        .then((payments) =>
          payments.card({
            style: {
              input: { color: colours.text, backgroundColor: colours.card },
              'input::placeholder': { color: colours.muted },
              '.input-container': { borderColor: colours.border, borderRadius: '8px' },
              '.input-container.is-focus': { borderColor: colours.accent },
              '.input-container.is-error': { borderColor: colours.danger },
              '.message-text': { color: colours.muted },
              '.message-icon': { color: colours.muted },
              '.message-text.is-error': { color: colours.danger },
              '.message-icon.is-error': { color: colours.danger },
            },
          }),
        )
        .then(async (card) => {
          if (!live) {
            void card.destroy();
            return;
          }
          squareCard = card;
          await card.attach(el);
          if (!live) return;
          mounted.current = { kind: 'square', card };
          setState('ready');
          ready.current(true);
        })
        .catch(failed);
    } else {
      failed();
    }

    return () => {
      live = false;
      mounted.current = null;
      stripeElement?.destroy();
      if (squareCard) void squareCard.destroy();
    };
  }, [session, squareBank]);

  useImperativeHandle(
    ref,
    () => ({
      async submit(): Promise<ProviderAnswer | null> {
        const m = mounted.current;
        if (!m) return null;
        setMessage(null);
        if (m.kind === 'stripe') {
          const paymentId = session.providerPaymentId;
          if (!paymentId) return null;
          try {
            const { error, paymentIntent } = await m.stripe.confirmPayment({
              elements: m.elements,
              confirmParams: { return_url: backTo(session.returnUrl, paymentId) },
              redirect: 'if_required',
            });
            if (error) {
              // The box marks a field it can't take by itself; a refusal is the card's own words.
              if (error.type === 'card_error') setMessage(error.message ?? NOT_REACHED);
              else if (error.type !== 'validation_error') setMessage(NOT_REACHED);
              return null;
            }
            return { kind: 'confirmed', providerPaymentId: paymentIntent?.id ?? paymentId };
          } catch {
            setMessage(NOT_REACHED);
            return null;
          }
        }
        try {
          const result = await m.card.tokenize({
            // Square runs the bank's own check (3-D Secure) here when the card needs one.
            amount: (session.amountCents / 100).toFixed(2),
            currencyCode: 'USD',
            intent: 'CHARGE',
            customerInitiated: true,
            sellerKeyedIn: false,
            billingContact: {},
          });
          if (result.status === 'OK' && result.token)
            return { kind: 'tokenised', sourceToken: result.token, method: 'card' };
          setMessage(
            result.errors?.find((e) => e.message)?.message ??
              'Check the card details and try again.',
          );
          return null;
        } catch {
          setMessage(NOT_REACHED);
          return null;
        }
      },
    }),
    [session],
  );

  if (squareBank)
    return (
      <p
        role="alert"
        className="flex items-start gap-2 rounded-card bg-warning-soft p-3.5 text-[13.5px] leading-[1.5] text-warning-text"
        data-testid="provider-fields-bank-unavailable"
      >
        <CircleAlert size={18} className="mt-0.5 flex-none" aria-hidden />
        <span>
          Bank transfer can’t be taken on this page yet. Go back and pay by card, or contact{' '}
          {businessName}.
        </span>
      </p>
    );

  return (
    <div className="flex flex-col gap-2" data-testid="provider-fields" data-state={state}>
      <div ref={box} className={state === 'failed' ? 'hidden' : 'min-h-[120px]'} />
      {state === 'loading' ? (
        <p aria-live="polite" className="text-[13px] text-text-3">
          Opening the secure payment form…
        </p>
      ) : null}
      {message ? (
        <p
          role="alert"
          className="text-[13px] text-danger-text"
          data-testid="provider-fields-error"
        >
          {message}
        </p>
      ) : null}
      <p className="text-xs leading-[1.5] text-text-3">
        These fields come straight from our payment provider. {businessName} never sees your card or
        bank details, and neither does HandsFreeOS.
      </p>
    </div>
  );
}
