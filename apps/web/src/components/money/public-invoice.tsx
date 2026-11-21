'use client';
/**
 * What a customer sees at `/i/<token>`: what they owe today, and the ways to pay it.
 * `design/m9/Invoice.dc.html` is the drawing this follows.
 *
 * Decisions of Chris's that this page keeps:
 * - **The big number is what is actually owed today** — a deposit, or anything else already paid, is taken off
 *   the top rather than left for the customer to work out.
 * - **Bank transfer is offered first and card second, and the page never says what either costs the business.**
 *   Nothing is added to what is owed, and there is no word about fees anywhere on it.
 * - **One press, one payment.** A `clientId` is minted per press and kept across the trip to the provider, so a
 *   retry, a doubled tap or a refreshed return page is answered with the payment it already made.
 *
 * Paying runs the worker's two phases (see `apps/worker/src/http/money.ts`). Phase one prepares and hands back
 * whatever the provider needs the browser to do. With Stripe and Square that is their own fields, shown right
 * here (`provider-fields.tsx`); with the stand-in, and any provider that serves its own page, it is a `hostedUrl`
 * to send the customer to, which sends them back here. Either way phase two names the intent the browser
 * confirmed, or the token minted from the card — so what the page shows is the provider's answer, never its own
 * guess. **A decline is a 200 with plain words**, not an error.
 *
 * PayPal's buttons (`paypal-buttons.tsx`) sit under the other ways to pay whenever the business has PayPal
 * connected, or alone when PayPal is the account this invoice is paid into. Each press of one is a phase one of
 * its own with `method: 'paypal'`, and PayPal's approval is phase two's order.
 */
import {
  dueWording,
  money,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_WORDS,
  type PaymentMethod,
} from '@hfos/core';
import {
  Landmark,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CreditCard,
  Hourglass,
  Link2Off,
  Lock,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError } from '@/lib/api/errors';
import {
  getInvoice,
  markInvoiceViewed,
  payInvoice,
  type PayMethod,
  type PublicBusiness,
  type PublicInvoiceView,
  type RecordedPay,
} from '@/lib/api/public-money';
import { cn } from '@/lib/utils';
import {
  canShowProviderFields,
  ProviderFields,
  type ProviderAnswer,
  type ProviderFieldsHandle,
  type ProviderMethod,
  type ProviderSession,
} from './provider-fields';
import { PayPalButtons, type PayPalStart } from './paypal-buttons';
import { joinParts, momentLong, momentShort, viewerZone } from './public-format';
import {
  callPhrase,
  DocumentCard,
  Hero,
  Honeypot,
  MoneyBody,
  MoneyFrame,
  NotesCard,
  OkBox,
  PageActions,
  PublicState,
  SectionLabel,
  TotalRow,
} from './public-shell';

type Failure =
  | { kind: 'stale'; business: PublicBusiness | null }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** The ways chosen on our page before Pay; PayPal's own buttons are chosen inside PayPal. */
type CardMethod = Exclude<PayMethod, 'paypal'>;
const cardMethodsOf = (methods: readonly PayMethod[]): CardMethod[] =>
  methods.filter((m): m is CardMethod => m !== 'paypal');

/** What each way of paying is called and what it is like. Never what it costs the business. */
const METHODS: Record<CardMethod, { label: string; note: string; icon: typeof Landmark }> = {
  ach: {
    label: PAYMENT_METHOD_LABELS.ach,
    note: 'Takes 1 to 3 business days.',
    icon: Landmark,
  },
  card: {
    label: PAYMENT_METHOD_LABELS.card,
    note: 'Instant. Visa, Mastercard, Amex, Apple Pay and Google Pay.',
    icon: CreditCard,
  },
};

/** The chosen way to pay, on the button that takes it. */
const PayIcon = ({ method }: { method: CardMethod }) => {
  const Icon = METHODS[method].icon;
  return <Icon size={17} aria-hidden />;
};

/** A payment recorded off the system is `cash`, `check` or `other`, so both maps are read by name. */
const methodLabel = (method: string): string =>
  PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method;
const methodWords = (method: string): string =>
  PAYMENT_METHOD_WORDS[method as PaymentMethod] ?? method;

const CANNOT_PAY: Record<'withdrawn' | 'paid' | 'no_account', string> = {
  withdrawn: 'This invoice was withdrawn.',
  paid: 'This invoice is already paid.',
  no_account: 'We can’t take a payment on this invoice right now.',
};

const failureOf = (e: unknown): Failure => {
  if (e instanceof ApiError && e.rule === 'money_link_stale')
    return {
      kind: 'stale',
      business: (e.details as { business?: PublicBusiness } | undefined)?.business ?? null,
    };
  if (e instanceof ApiError && e.status === 404) return { kind: 'missing' };
  return {
    kind: 'error',
    message: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.',
  };
};

const newClientId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The press this browser is in the middle of, kept across the trip to the provider. */
interface Press {
  readonly clientId: string;
  readonly method: PayMethod;
}

const pressKey = (token: string) => `hfos.pay.${token}`;

function rememberPress(token: string, press: Press): void {
  try {
    sessionStorage.setItem(pressKey(token), JSON.stringify(press));
  } catch {
    // A browser with storage turned off still pays; it just can't be told it already has.
  }
}

function recallPress(token: string): Press | null {
  try {
    const raw = sessionStorage.getItem(pressKey(token));
    const parsed = raw ? (JSON.parse(raw) as Partial<Press>) : null;
    return parsed?.clientId
      ? { clientId: parsed.clientId, method: parsed.method === 'ach' ? 'ach' : 'card' }
      : null;
  } catch {
    return null;
  }
}

const forgetPress = (token: string): void => {
  try {
    sessionStorage.removeItem(pressKey(token));
  } catch {
    // Nothing to do: the worst case is one more "you already paid this" answer.
  }
};

/**
 * What the provider sent the customer back with: an intent it confirmed, a card token, nothing (they gave up),
 * or a refusal (Stripe's `redirect_status=failed`, when the bank's own check said no).
 */
type Returned = ProviderAnswer | { kind: 'cancelled' } | { kind: 'refused' } | null;

function readReturn(search: string): Returned {
  const q = new URLSearchParams(search);
  const payment = q.get('payment');
  const sourceToken = q.get('token');
  if (payment === 'cancelled') return { kind: 'cancelled' };
  if (q.get('redirect_status') === 'failed') return { kind: 'refused' };
  if (payment) return { kind: 'confirmed', providerPaymentId: payment };
  if (sourceToken)
    return { kind: 'tokenised', sourceToken, method: q.get('method') === 'ach' ? 'ach' : 'card' };
  return null;
}

export function PublicInvoice({ token }: { token: string }) {
  const [view, setView] = useState<PublicInvoiceView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [method, setMethod] = useState<CardMethod | null>(null);
  const [outcome, setOutcome] = useState<RecordedPay['payment'] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [website, setWebsite] = useState('');
  /** Phase one's answer while the provider's own fields are on the page, and whether they can be typed in. */
  const [fields, setFields] = useState<ProviderSession | null>(null);
  const [fieldsReady, setFieldsReady] = useState(false);
  const fieldsRef = useRef<ProviderFieldsHandle>(null);
  const opened = useRef(false);
  const returned = useRef(false);
  /**
   * What the provider sent this browser back with, read once from the address before anything else runs. The
   * page is opened fresh by that redirect, so whether there is a payment to finish is settled at the first
   * render: the plain read below is skipped for one, and the answer to phase two is the only view shown.
   */
  const [handoff] = useState<Returned>(() =>
    typeof window === 'undefined' ? null : readReturn(window.location.search),
  );
  const finishing = !!handoff && handoff.kind !== 'cancelled' && handoff.kind !== 'refused';

  const show = useCallback((next: PublicInvoiceView) => {
    setView(next);
    const ways = cardMethodsOf(next.pay.methods);
    setMethod((m) => (m && ways.includes(m) ? m : (ways[0] ?? null)));
  }, []);

  const failedPay = useCallback(
    async (e: unknown) => {
      if (e instanceof ApiError && (e.status === 410 || e.status === 404)) {
        setFailure(failureOf(e));
        return;
      }
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
      try {
        setView(await getInvoice(token));
      } catch {
        // Keep what's on screen.
      }
    },
    [token],
  );

  useEffect(() => {
    // Finishing a payment reads the invoice back with its answer: one read, and never a stale one over it.
    if (finishing) return;
    let live = true;
    getInvoice(token)
      .then((v) => live && show(v))
      .catch((e: unknown) => live && setFailure(failureOf(e)));
    return () => {
      live = false;
    };
  }, [token, show, finishing]);

  // "They opened it", once, as a POST: a GET must never change anything and mail scanners open links.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void markInvoiceViewed(token).catch(() => {
      // Only the business's news.
    });
  }, [token]);

  /**
   * Back from the provider. The address carries what it did; phase two names that to the worker, which reads
   * the answer back from the provider rather than trusting anything in this page.
   */
  /**
   * Phase two: name what the provider did, from its fields on this page or from the address it sent the customer
   * back to. The worker reads the answer back from the provider rather than trusting anything in this page.
   */
  const finish = useCallback(
    (back: ProviderAnswer) => {
      const press = recallPress(token);
      setBusy(true);
      return payInvoice(token, {
        clientId: press?.clientId ?? newClientId(),
        ...(back.kind === 'confirmed'
          ? { providerPaymentId: back.providerPaymentId }
          : { sourceToken: back.sourceToken, method: back.method }),
        website: '',
      })
        .then((answer) => {
          forgetPress(token);
          setFields(null);
          if (answer.stage === 'recorded') {
            setOutcome(answer.payment);
            // Taken nowhere yet: a bank that wants one more step (Stripe emails how), or a box left unfinished.
            if (answer.payment.status === 'requires_payment')
              setNotice(
                'That payment isn’t finished yet, so nothing was charged. If your bank asked for one more step, finish it there, or try again.',
              );
          }
          show(answer.invoice);
          window.scrollTo({ top: 0 });
        })
        .catch((e: unknown) => void failedPay(e))
        .finally(() => setBusy(false));
    },
    [token, show, failedPay],
  );

  useEffect(() => {
    if (returned.current) return;
    returned.current = true;
    const back = handoff;
    if (!back) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (back.kind === 'cancelled' || back.kind === 'refused') {
      forgetPress(token);
      setNotice(
        back.kind === 'refused'
          ? 'That payment didn’t go through, so nothing was charged. Try again, or pick another way to pay.'
          : 'Payment cancelled — nothing was charged.',
      );
      return;
    }
    void finish(back);
  }, [token, finish, handoff]);

  /** Phase one: ask for a session and go wherever the provider collects the money. */
  async function pay() {
    if (busy || !method) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setOutcome(null);
    const press: Press = { clientId: newClientId(), method };
    rememberPress(token, press);
    try {
      const answer = await payInvoice(token, {
        clientId: press.clientId,
        method: press.method,
        website,
      });
      if (answer.stage === 'recorded') {
        // The same press answered again, or a provider that charges in one go.
        forgetPress(token);
        setOutcome(answer.payment);
        show(answer.invoice);
        setBusy(false);
        window.scrollTo({ top: 0 });
        return;
      }
      if (answer.payment.hostedUrl) {
        window.location.assign(answer.payment.hostedUrl);
        return;
      }
      const session: ProviderSession = {
        provider: answer.payment.provider ?? answer.invoice.pay.session?.provider ?? '',
        flow: answer.payment.flow,
        publishableKey: answer.payment.publishableKey,
        accountId: answer.payment.accountId,
        locationId: answer.payment.locationId,
        clientSecret: answer.payment.clientSecret,
        providerPaymentId: answer.payment.providerPaymentId,
        amountCents: answer.payment.amountCents,
        method: answer.payment.method as ProviderMethod,
        returnUrl: answer.payment.returnUrl,
      };
      if (canShowProviderFields(session)) {
        // The provider's own fields, right here; the press is kept for phase two.
        show(answer.invoice);
        setFieldsReady(false);
        setFields(session);
        setBusy(false);
        return;
      }
      // Nowhere to send them and no fields of the provider's to show: say so plainly and leave Pay pressable.
      forgetPress(token);
      show(answer.invoice);
      setError(
        `We couldn’t open the payment form just now. Try again in a minute, or ${callPhrase(
          answer.invoice.business,
        )}.`,
      );
      setBusy(false);
    } catch (e) {
      forgetPress(token);
      await failedPay(e);
      setBusy(false);
    }
  }

  /**
   * A press of one of PayPal's buttons: phase one for PayPal's account, which answers with the order PayPal's
   * window approves (or, with the stand-in, the page to go to). Null when there is nothing to open, and the page
   * already says why.
   */
  async function startPayPal(): Promise<PayPalStart> {
    if (busy) return null;
    setError(null);
    setNotice(null);
    setOutcome(null);
    const press: Press = { clientId: newClientId(), method: 'paypal' };
    rememberPress(token, press);
    try {
      const answer = await payInvoice(token, {
        clientId: press.clientId,
        method: 'paypal',
        website,
      });
      if (answer.stage === 'recorded') {
        forgetPress(token);
        setOutcome(answer.payment);
        show(answer.invoice);
        window.scrollTo({ top: 0 });
        return null;
      }
      if (answer.payment.hostedUrl) return { hostedUrl: answer.payment.hostedUrl };
      if (answer.payment.providerPaymentId) return { orderId: answer.payment.providerPaymentId };
      forgetPress(token);
      setError(
        `We couldn’t open PayPal just now. Try again in a minute, or ${callPhrase(
          answer.invoice.business,
        )}.`,
      );
      return null;
    } catch (e) {
      forgetPress(token);
      await failedPay(e);
      return null;
    }
  }

  /** The footer's Pay, once the fields are filled in: confirm or tokenise there, then phase two. */
  async function confirmFields() {
    if (busy || !fields || !fieldsRef.current) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setOutcome(null);
    const answer = await fieldsRef.current.submit();
    if (!answer) {
      setBusy(false);
      return;
    }
    await finish(answer);
  }

  /** Back to the ways to pay, maybe with the other one picked. Nothing was taken: the press is dropped. */
  function leaveFields(next: CardMethod | null) {
    forgetPress(token);
    setFields(null);
    setFieldsReady(false);
    setError(null);
    if (next) setMethod(next);
  }

  if (failure?.kind === 'stale')
    return (
      <MoneyFrame business={failure.business} testId="invoice-page">
        <PublicState
          tone="warning"
          icon={<CircleAlert size={20} />}
          title="This link is out of date"
          testId="link-stale"
        >
          We sent a newer copy of this invoice. Open the newest text or email from us
          {failure.business ? `, or ${callPhrase(failure.business)}` : ''}.
        </PublicState>
      </MoneyFrame>
    );
  if (failure)
    return (
      <MoneyFrame business={null} testId="invoice-page">
        <PublicState
          icon={<Link2Off size={20} />}
          title={failure.kind === 'missing' ? 'This link doesn’t work' : 'We couldn’t open this'}
          testId="link-missing"
        >
          {failure.kind === 'missing'
            ? 'Check that it matches the one we sent you, or contact the business.'
            : failure.message}
        </PublicState>
      </MoneyFrame>
    );
  if (!view)
    return (
      <MoneyFrame business={null} testId="invoice-page">
        <p aria-live="polite" className="mx-auto mt-16 text-[13px] text-text-3">
          Opening your invoice…
        </p>
      </MoneyFrame>
    );

  const { business, invoice, payments, refunds, pay: payBlock } = view;
  const cardMethods = cardMethodsOf(payBlock.methods);
  const payPal = payBlock.payPal ?? null;

  if (view.state === 'void')
    return (
      <MoneyFrame business={business} testId="invoice-page">
        <PublicState
          icon={<CircleSlash size={20} />}
          title="This invoice was withdrawn"
          action={<PageActions business={business} />}
          testId="invoice-withdrawn"
        >
          {business.name} has taken this invoice back, so there is nothing to pay. Please{' '}
          {callPhrase(business)} if you were expecting one.
        </PublicState>
      </MoneyFrame>
    );

  const settled = payments.filter((p) => p.status === 'succeeded');
  const settling = payments.filter((p) => p.status === 'processing');
  const settlingCents = settling.reduce((sum, p) => sum + p.amountCents, 0);
  const owed = invoice.balanceCents;
  /** What isn't even on its way: a bank transfer already sent is money the customer has done their part of. */
  const owedNow = Math.max(0, owed - settlingCents);
  /**
   * A refund gives money back and never puts it back on the bill, so a paid invoice stays paid however much went
   * back: its balance stays at nothing and the worker offers no payment on it. Refunded in full, the page leads
   * with the money going back rather than a thank-you for a payment they no longer made; partly refunded, the
   * receipt still leads and the refund sits under it. Either way there is no Pay button — the balance says so,
   * and `paidUp` is kept as a guard in case a state ever arrives that the balance doesn't.
   */
  const refundedInFull = view.state === 'refunded';
  const paidUp =
    view.state === 'paid' || refundedInFull || view.state === 'partly_refunded' || owed <= 0;
  const canPay = payBlock.canPay && !paidUp && owedNow > 0 && !!method;
  const failed = outcome?.status === 'failed';
  /** The day the last of it went back: the figure on its own leaves a customer guessing. */
  const lastRefundAt = refunds.reduce<string | null>((last, r) => r.refundedAt ?? last, null);

  const extras = (
    <>
      {settled.map((p, i) => (
        <TotalRow
          key={`paid-${i}`}
          label={`Paid ${momentShort(p.receivedAt ?? p.createdAt)} · ${methodWords(p.method)}`}
          value={money(p.amountCents)}
          credit
          testId="money-paid"
        />
      ))}
      {settling.map((p, i) => (
        <TotalRow
          key={`settling-${i}`}
          label={`${methodLabel(p.method)} on its way`}
          value={money(p.amountCents)}
          testId="money-settling"
        />
      ))}
      {/* Keyed on the arithmetic, not on the state, so it always says what the ledger says. */}
      <TotalRow
        label={owed <= 0 ? 'Nothing left to pay' : 'Amount due'}
        value={money(Math.max(0, owed))}
        big
        testId="money-due"
      />
      {/* Under what is due, not inside it: money given back never goes back on the bill. */}
      {invoice.amountRefundedCents > 0 ? (
        <TotalRow
          label="Refunded to you"
          value={money(invoice.amountRefundedCents)}
          testId="money-refunded"
        />
      ) : null}
    </>
  );

  // Core's own words: "Due Fri, Oct 2", "Due today", "3 days overdue".
  const dueLabel = invoice.dueOn ? dueWording(invoice.dueOn, Date.now(), viewerZone()) : null;

  return (
    <MoneyFrame
      business={business}
      testId="invoice-page"
      footer={
        canPay && fields ? (
          <>
            <Button
              size="lg"
              className="w-full"
              loading={busy}
              disabled={!fieldsReady}
              onClick={() => void confirmFields()}
              data-testid="pay-confirm"
            >
              <Lock size={17} aria-hidden />
              {`Pay ${money(fields.amountCents)}`}
            </Button>
            <p className="text-center text-xs text-text-3">
              One press, one payment. Pressing twice can’t charge you twice.
            </p>
          </>
        ) : canPay ? (
          <>
            <Button
              size="lg"
              className="w-full"
              loading={busy}
              onClick={() => void pay()}
              data-testid="pay"
            >
              {method ? <PayIcon method={method} /> : null}
              {cardMethods.length > 1
                ? `Pay ${money(owedNow)} by ${PAYMENT_METHOD_WORDS[method]}`
                : `Pay ${money(owedNow)}`}
            </Button>
            <p className="text-center text-xs text-text-3">
              One press, one payment. Pressing twice can’t charge you twice.
            </p>
          </>
        ) : null
      }
    >
      <MoneyBody testId="invoice-body">
        {refundedInFull ? (
          <div
            className="flex items-start gap-2.5 rounded-card border border-border bg-card p-3.5 text-[13.5px] leading-[1.5] text-text"
            data-testid="invoice-refunded"
            data-print="card"
          >
            <Undo2 size={19} className="mt-px flex-none text-text-2" aria-hidden />
            <span className="min-w-0 flex-1">
              <b className="font-semibold">Refunded.</b> {money(invoice.amountRefundedCents)} went
              back to you{lastRefundAt ? ` on ${momentShort(lastRefundAt)}` : ''}.
            </span>
          </div>
        ) : paidUp ? (
          <OkBox icon={<CircleCheck size={19} />} testId="invoice-paid">
            <b className="font-semibold">
              Paid in full. Thank you
              {view.customer.name ? `, ${view.customer.name.split(' ')[0]}` : ''}.
            </b>
            {invoice.paidAt ? <br /> : null}
            {invoice.paidAt ? `${momentLong(invoice.paidAt)}.` : null}
            {view.customer.email ? ` A receipt is on its way to ${view.customer.email}.` : ''}
          </OkBox>
        ) : settlingCents > 0 ? (
          <div
            className="flex items-start gap-2.5 rounded-card bg-accent-soft p-3.5 text-[13.5px] leading-[1.5] text-accent-text"
            data-testid="invoice-settling"
            data-print="card"
          >
            <Hourglass size={19} className="mt-px flex-none" aria-hidden />
            <span className="min-w-0 flex-1">
              <b className="font-semibold">
                {money(settlingCents)} is on its way by bank transfer.
              </b>{' '}
              Bank transfers take 1 to 3 business days. Nothing here is overdue while it’s
              travelling, and we’ll email a receipt when it lands.
            </span>
          </div>
        ) : null}

        {failed ? (
          <div
            className="flex items-start gap-2.5 rounded-card bg-danger-soft p-3.5 text-[13.5px] leading-[1.5] text-danger-text"
            role="alert"
            data-testid="pay-declined"
          >
            <CircleAlert size={19} className="mt-px flex-none" aria-hidden />
            <span className="min-w-0 flex-1">
              {outcome?.failureMessage ?? 'That payment didn’t go through.'} Nothing was charged.
            </span>
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="text-[13px] text-text-2" data-testid="pay-notice">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[13px] text-danger-text" data-testid="pay-error">
            {error}
          </p>
        ) : null}

        {/* Once it's paid the receipt leads, as the canvas has it, and the big number would only repeat it. */}
        {paidUp ? null : (
          <Hero
            step={joinParts('Invoice', invoice.number)}
            amount={owed}
            sub={joinParts(dueLabel, invoice.title)}
            testId="invoice-hero"
          />
        )}

        {paidUp ? (
          <Card className="px-4 py-4 sm:px-[18px]" data-testid="invoice-receipt" data-print="card">
            <SectionLabel>Receipt</SectionLabel>
            {settled.map((p, i) => (
              <TotalRow
                key={`receipt-${i}`}
                label={`${methodLabel(p.method)} · ${momentShort(p.receivedAt ?? p.createdAt)}`}
                value={money(p.amountCents)}
              />
            ))}
            <TotalRow
              label="Paid for this job"
              value={money(invoice.amountPaidCents)}
              big
              testId="receipt-total"
            />
            {invoice.amountRefundedCents > 0 ? (
              <>
                <TotalRow
                  label="Refunded to you"
                  value={money(invoice.amountRefundedCents)}
                  credit
                  testId="receipt-refund"
                />
                <p className="mt-1 text-xs leading-[1.5] text-text-3">
                  Sent back the way you paid. It can take a few days to show up.
                </p>
              </>
            ) : null}
            {invoice.number ? (
              <TotalRow label="Reference" value={invoice.number} testId="receipt-reference" />
            ) : null}
          </Card>
        ) : payBlock.canPay && owedNow > 0 && fields ? (
          <div className="flex flex-col gap-2.5" data-testid="pay-fields" data-print="hide">
            <h2 className="text-[15px] font-semibold">
              {fields.method === 'ach' ? 'Pay by bank transfer' : 'Pay by card'}
            </h2>
            {(() => {
              const other = cardMethods.find((m) => m !== fields.method) ?? null;
              return (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  disabled={busy}
                  onClick={() => leaveFields(other)}
                  data-testid="pay-fields-back"
                >
                  <ChevronLeft size={16} aria-hidden />
                  {other ? `${METHODS[other].label} instead` : 'Back'}
                </Button>
              );
            })()}
            <ProviderFields
              ref={fieldsRef}
              session={fields}
              businessName={business.name}
              onReady={setFieldsReady}
            />
          </div>
        ) : payBlock.canPay && owedNow > 0 ? (
          <div className="flex flex-col gap-2.5" data-testid="pay-methods" data-print="hide">
            <h2 className="text-[15px] font-semibold">How would you like to pay?</h2>
            <div
              role="radiogroup"
              aria-label="How would you like to pay?"
              className={cn('flex flex-col gap-2.5', cardMethods.length ? null : 'hidden')}
            >
              {cardMethods.map((m) => {
                const spec = METHODS[m];
                const Icon = spec.icon;
                const on = method === m;
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setMethod(m)}
                    data-testid={`pay-method-${m}`}
                    data-on={on ? 'yes' : 'no'}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-card border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                      on
                        ? 'border-accent bg-accent-soft ring-1 ring-accent'
                        : 'border-border-strong bg-card hover:bg-card-2',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'inline-flex h-[38px] w-[38px] flex-none items-center justify-center rounded-menu',
                        on ? 'bg-card text-accent-text' : 'bg-card-2 text-text-2',
                      )}
                    >
                      <Icon size={18} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[15px] font-semibold leading-[1.3]">{spec.label}</span>
                      <span className="mt-px text-[12.5px] leading-[1.4] text-text-2">
                        {spec.note}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        'mt-2.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
                        on ? 'border-accent' : 'border-border-strong',
                      )}
                    >
                      {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {payPal ? (
              <>
                {cardMethods.length ? (
                  <p
                    className="flex items-center gap-3 text-xs font-medium text-text-3 before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
                    aria-hidden
                  >
                    or
                  </p>
                ) : null}
                <PayPalButtons
                  config={payPal}
                  disabled={busy}
                  start={startPayPal}
                  approved={(orderId) =>
                    void finish({ kind: 'confirmed', providerPaymentId: orderId })
                  }
                  cancelled={() => {
                    forgetPress(token);
                    setNotice('Payment cancelled — nothing was charged.');
                  }}
                  failed={(message) => {
                    forgetPress(token);
                    setError(message);
                  }}
                />
              </>
            ) : null}
            <div className="relative">
              <Honeypot id="pay-website" value={website} onChange={setWebsite} />
            </div>
          </div>
        ) : payBlock.reason === 'outside' ? (
          <div
            className="flex items-start gap-2.5 rounded-card bg-card-2 p-3.5 text-[13.5px] leading-[1.5] text-text-2"
            data-testid="pay-outside"
            data-print="hide"
          >
            <Landmark size={19} className="mt-px flex-none" aria-hidden />
            <span className="min-w-0 flex-1">
              <b className="font-semibold">
                {business.name} takes payment for this invoice directly.
              </b>{' '}
              It isn’t paid online. If you’re not sure how to pay, {callPhrase(business)}.
            </span>
          </div>
        ) : payBlock.reason && payBlock.reason !== 'paid' ? (
          <div
            className="flex items-start gap-2.5 rounded-card bg-warning-soft p-3.5 text-[13.5px] leading-[1.5] text-warning-text"
            data-testid="pay-blocked"
            data-print="hide"
          >
            <CircleAlert size={19} className="mt-px flex-none" aria-hidden />
            <span className="min-w-0 flex-1">
              <b className="font-semibold">{CANNOT_PAY[payBlock.reason]}</b> Please{' '}
              {callPhrase(business)} and we’ll sort it out.
            </span>
          </div>
        ) : null}

        <DocumentCard
          number={invoice.number}
          title={invoice.title}
          when={invoice.sentAt ? `Sent ${momentShort(invoice.sentAt)}` : null}
          lines={invoice.lines}
          totals={invoice.totals}
          extra={extras}
        />
        {invoice.notes?.trim() ? <NotesCard notes={invoice.notes} business={business} /> : null}
        <PageActions business={business} />
      </MoneyBody>
    </MoneyFrame>
  );
}
