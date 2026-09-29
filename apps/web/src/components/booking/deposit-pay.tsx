'use client';
/**
 * The last step when a calendar asks for money (design/m9/Booking.dc.html): what the visit costs, what is due
 * now, what is left for after, and then the provider's own fields.
 *
 * The rule the whole screen is built around, and says out loud: **your card is held, not charged, until the
 * time is confirmed. If the time goes while you are typing, nothing is taken.** So the button reads "Hold my
 * time and pay $X", and when a time does go the page says plainly that nothing was charged and offers other
 * times — with no invoice to chase and nothing for anyone to explain.
 *
 * Paying runs the worker's two phases (apps/worker/src/http/booking.ts). Phase one asks for a session and
 * hands back whatever the provider needs the browser to do — with the stand-in, a page to go to. The provider
 * sends the customer back to `/hold/<token>`, which names what it did, and phase two reads the answer back
 * from the provider rather than trusting anything in this page.
 */
import { CircleAlert, CreditCard, Landmark, Lock } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/errors';
import {
  payDeposit,
  type Held,
  type PayMethod,
  type PublicSlot,
  type RecordedPay,
} from '@/lib/api/public-booking';
import { cn } from '@/lib/utils';
import { dayShort, lengthLabel, money, timeOf, timeRange, joinNames, dayLong } from './format';
import { callPhrase } from './public-shell';

const METHODS: Record<PayMethod, { label: string; note: string; icon: typeof Landmark }> = {
  ach: { label: 'Bank transfer', note: 'Takes 1 to 3 business days.', icon: Landmark },
  card: {
    label: 'Card',
    note: 'Visa, Mastercard, Amex, Apple Pay and Google Pay.',
    icon: CreditCard,
  },
};

export const newClientId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The press this browser is in the middle of, kept across the trip to the provider. */
const pressKey = (token: string) => `hfos.hold.${token}`;

export function rememberPress(token: string, press: { clientId: string; method: PayMethod }): void {
  try {
    sessionStorage.setItem(pressKey(token), JSON.stringify(press));
  } catch {
    // A browser with storage turned off still pays; it just can't be told it already has.
  }
}

export function recallPress(token: string): { clientId: string; method: PayMethod } | null {
  try {
    const raw = sessionStorage.getItem(pressKey(token));
    const parsed = raw ? (JSON.parse(raw) as { clientId?: string; method?: string }) : null;
    return parsed?.clientId
      ? { clientId: parsed.clientId, method: parsed.method === 'ach' ? 'ach' : 'card' }
      : null;
  } catch {
    return null;
  }
}

export function forgetPress(token: string): void {
  try {
    sessionStorage.removeItem(pressKey(token));
  } catch {
    // Nothing to do: the worst case is one more "you already paid this" answer.
  }
}

/** What the provider sent the customer back with: an intent it confirmed, a card token, or nothing. */
export type Returned =
  | { kind: 'confirmed'; providerPaymentId: string }
  | { kind: 'tokenised'; sourceToken: string; method: PayMethod }
  | { kind: 'cancelled' }
  | null;

export function readReturn(search: string): Returned {
  const q = new URLSearchParams(search);
  const payment = q.get('payment');
  const sourceToken = q.get('token');
  if (payment === 'cancelled') return { kind: 'cancelled' };
  if (payment) return { kind: 'confirmed', providerPaymentId: payment };
  if (sourceToken)
    return { kind: 'tokenised', sourceToken, method: q.get('method') === 'ach' ? 'ach' : 'card' };
  return null;
}

function Row({ k, v, big }: { k: string; v: string; big?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-3 py-1.5',
        big && 'border-y border-border py-2.5',
      )}
    >
      <span className={cn('text-[13px] text-text-2', big && 'text-[15px] font-medium text-text-1')}>
        {k}
      </span>
      <span className={cn('text-[13px]', big && 'text-[17px] font-semibold')}>{v}</span>
    </div>
  );
}

/** The visit, so nobody pays for a time they can't see. */
function VisitCard({ hold, tz, business }: { hold: Held; tz: string; business: string }) {
  const a = hold.appointment;
  const lines: [string, string | null][] = [
    ['What', `${a.title} · ${lengthLabel(a.durationMinutes)}`],
    [
      'When',
      `${dayLong(a.startsAt, tz)}, ${timeRange(a.startsAt, a.endsAt, tz)} ${a.timezoneLabel}`,
    ],
    ['Where', a.where],
    ['Who', a.with.length ? `${joinNames(a.with)} from ${business}` : null],
  ];
  return (
    <dl className="rounded-card border border-border bg-card px-4 py-1 shadow-1">
      <span className="sr-only">Your visit</span>
      {lines
        .filter((r): r is [string, string] => !!r[1])
        .map(([k, v], i) => (
          <div
            key={k}
            className={cn('flex items-start gap-3 py-[9px]', i > 0 && 'border-t border-border')}
          >
            <dt className="mt-px w-11 flex-none text-xs text-text-3">{k}</dt>
            <dd className="text-[13px]">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function DepositStep({
  hold,
  tz,
  onPaid,
  onLost,
  onBack,
  stepLabel,
  notice,
}: {
  hold: Held;
  tz: string;
  /** The deposit landed and the time is theirs. */
  onPaid: (answer: RecordedPay) => void;
  /** The time went while they were paying: nothing was charged. */
  onLost: (answer: RecordedPay) => void;
  onBack?: () => void;
  stepLabel?: string;
  notice?: string | null;
}) {
  const [method, setMethod] = useState<PayMethod>(hold.pay.methods[0] ?? 'card');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = hold.deposit;
  const full = d.mode === 'full';

  async function pay() {
    if (busy || !hold.pay.canPay) return;
    setBusy(true);
    setError(null);
    const press = { clientId: newClientId(), method };
    rememberPress(hold.holdToken, press);
    try {
      const answer = await payDeposit(hold.holdToken, { ...press, website: '' });
      if (answer.stage === 'prepared') {
        if (answer.payment.hostedUrl) {
          window.location.assign(answer.payment.hostedUrl);
          return;
        }
        // Nowhere to send them and no fields of the provider's to show: say so rather than a dead button.
        forgetPress(hold.holdToken);
        setError(
          `We couldn’t open the payment form just now. Try again in a minute, or ${callPhrase(hold.business)}.`,
        );
        setBusy(false);
        return;
      }
      forgetPress(hold.holdToken);
      setBusy(false);
      if (answer.state === 'gone') onLost(answer);
      else if (answer.payment && answer.payment.status === 'failed')
        setError(answer.payment.failureMessage ?? 'That card was refused. Try another one.');
      else onPaid(answer);
    } catch (e) {
      forgetPress(hold.holdToken);
      setBusy(false);
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-3.5" data-testid="deposit-step">
      <div className="flex flex-col gap-0.5">
        <div className="flex min-h-6 items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
            {stepLabel ?? 'Last step'}
          </span>
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex min-h-6 items-center gap-0.5 text-xs font-medium text-accent-text hover:underline"
            >
              Back
            </button>
          ) : null}
        </div>
        <h1 className="text-lg font-semibold tracking-[-0.005em]">
          {full
            ? `${money(d.amountCents)} is due to book`
            : `A ${money(d.amountCents)} deposit is due to book`}
        </h1>
        <p className="text-[13px] text-text-2">
          {full ? 'It covers the whole visit.' : 'It comes off the price of the visit.'}
        </p>
      </div>

      {notice ? (
        <p
          role="status"
          className="rounded-[10px] bg-accent-soft px-3 py-2.5 text-[13px] text-accent-text"
          data-testid="deposit-notice"
        >
          {notice}
        </p>
      ) : null}

      <VisitCard hold={hold} tz={tz} business={hold.business.name} />

      <div className="rounded-card border border-border bg-card px-4 py-2 shadow-1">
        {d.priceCents > 0 ? <Row k={d.what} v={money(d.priceCents)} /> : null}
        <Row k={full ? 'Due now' : 'Deposit due now'} v={money(d.amountCents)} big />
        {d.dueAfterCents > 0 ? <Row k="Due after the visit" v={money(d.dueAfterCents)} /> : null}
      </div>

      {hold.pay.methods.length > 1 ? (
        <div role="radiogroup" aria-label="How to pay" className="flex flex-col gap-2">
          {hold.pay.methods.map((m) => {
            const Icon = METHODS[m].icon;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                data-testid={`pay-method-${m}`}
                onClick={() => setMethod(m)}
                className={cn(
                  'flex min-h-[54px] w-full items-center gap-3 rounded-[10px] border px-3.5 py-3 text-left transition-colors',
                  method === m
                    ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
                    : 'border-border-strong bg-card hover:bg-card-2',
                )}
              >
                <Icon size={18} aria-hidden className="flex-none text-text-2" />
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="text-[15px] font-medium">{METHODS[m].label}</span>
                  <span className="text-xs text-text-2">{METHODS[m].note}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {hold.pay.canPay ? null : (
        <p role="alert" className="text-[13px] text-danger-text" data-testid="deposit-blocked">
          {hold.pay.reason === 'gone'
            ? 'That time has gone.'
            : hold.pay.reason === 'paid'
              ? 'This is already paid.'
              : `We can’t take payments online right now. To keep this time, ${callPhrase(hold.business)}.`}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-[13px] text-danger-text" data-testid="deposit-error">
          {error}
        </p>
      ) : null}

      <div className="sticky bottom-0 z-10 -mx-4 mt-auto flex flex-col gap-2 border-t border-border bg-card px-4 py-2.5 md:static md:mx-0 md:mt-2 md:border-0 md:bg-transparent md:p-0">
        <Button
          type="button"
          size="lg"
          className="w-full"
          loading={busy}
          disabled={!hold.pay.canPay}
          onClick={() => void pay()}
          data-testid="pay-deposit"
        >
          <Lock size={16} aria-hidden />
          Hold my time and pay {money(d.amountCents)}
        </Button>
        <p className="text-center text-xs text-text-3">
          {method === 'card'
            ? 'Your card is held, not charged, until the time is confirmed. If the time goes while you’re typing, nothing is taken.'
            : 'A bank transfer can’t be held the way a card can. If the time goes, we send the whole amount back at once.'}
        </p>
        <p className="text-center text-xs text-text-3">
          Your card details go straight to our payment provider. {hold.business.name} never sees
          them.
        </p>
      </div>
    </div>
  );
}

/** The time went while they were paying, as the canvas draws it: nothing charged, and other times. */
export function TimeWentPanel({
  answer,
  tz,
  times,
  onPick,
  onRestart,
}: {
  answer: RecordedPay;
  tz: string;
  times: readonly PublicSlot[];
  onPick?: (slot: PublicSlot) => void;
  onRestart: () => void;
}) {
  const refunded = answer.payment?.refunded === true;
  const when = answer.hold.appointment.startsAt;
  return (
    <div
      className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-4 px-4 pb-6 pt-6 md:pt-10"
      data-testid="time-went"
    >
      <div
        role="alert"
        className="flex items-start gap-2.5 rounded-[10px] bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-text"
      >
        <CircleAlert size={18} className="mt-0.5 flex-none" aria-hidden />
        <span className="flex flex-col gap-1">
          <strong className="text-[15px] font-semibold">That time just went.</strong>
          <span>
            {`Someone booked ${timeOf(when, tz)} on ${dayShort(when, tz).split(',')[0]} while you were typing. `}
            <strong className="font-semibold">Nothing was charged.</strong>{' '}
            {refunded
              ? 'Your bank transfer is on its way back in full — it takes a day or two to land.'
              : 'The hold on your card is already released.'}
          </span>
        </span>
      </div>
      {times.length ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-[15px] font-semibold">Other times</h2>
          {times.slice(0, 4).map((s) => (
            <button
              key={`${s.startsAt}:${s.sessionId ?? ''}`}
              type="button"
              data-testid="other-time"
              onClick={() => onPick?.(s)}
              className="flex min-h-[48px] w-full items-center gap-3 rounded-[10px] border border-border-strong bg-card px-3.5 py-3 text-left text-[15px] font-medium hover:border-accent"
            >
              {`${dayShort(s.startsAt, tz)} · ${timeOf(s.startsAt, tz)}`}
            </button>
          ))}
        </div>
      ) : null}
      <p className="text-xs text-text-3">
        A bank transfer can’t be held the way a card can. If a time goes after a bank deposit
        starts, we send the whole amount back at once, without anyone asking.
      </p>
      <Button size="lg" className="w-full" onClick={onRestart} data-testid="pick-another">
        Pick another time
      </Button>
    </div>
  );
}
