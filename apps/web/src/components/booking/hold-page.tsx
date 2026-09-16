'use client';
/**
 * `/hold/<token>`: a time held while a customer pays the deposit that books it, and the page the payment
 * provider sends them back to (design/m9/Booking.dc.html).
 *
 * It is a page of its own rather than a step inside the booking flow because the customer leaves for the
 * provider and comes back: a step held only in React state would be gone. The address they come back with
 * carries what the provider did, and this page names that to the worker, which reads the answer back from the
 * provider rather than trusting anything here. **A decline is an answer, not an error**, and a time that went
 * while they were typing says so plainly — nothing was charged.
 */
import { CircleAlert, Clock, Link2Off } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import {
  getHold,
  payDeposit,
  type Held,
  type PublicBusiness,
  type PublicSlot,
  type RecordedPay,
} from '@/lib/api/public-booking';
import { BookedPanel } from './booked-panel';
import {
  DepositStep,
  forgetPress,
  newClientId,
  readReturn,
  recallPress,
  TimeWentPanel,
  type Returned,
} from './deposit-pay';
import { callPhrase, CallButton, PublicFrame, PublicState } from './public-shell';

type Failure =
  | { kind: 'stale'; business: PublicBusiness | null }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const failureOf = (e: unknown): Failure => {
  if (e instanceof ApiError && e.rule === 'manage_link_stale')
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

export function HoldPage({ token }: { token: string }) {
  const [hold, setHold] = useState<Held | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [lost, setLost] = useState<{ answer: RecordedPay; times: readonly PublicSlot[] } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const returned = useRef(false);
  /**
   * What the provider sent this browser back with, read once from the address before anything else runs. The
   * page is opened fresh by that redirect, so whether there is a payment to finish is settled at the first
   * render: the plain read below is skipped for one.
   */
  const [handoff] = useState<Returned>(() =>
    typeof window === 'undefined' ? null : readReturn(window.location.search),
  );
  const finishing = !!handoff && handoff.kind !== 'cancelled';

  const land = useCallback((answer: RecordedPay) => {
    setHold(answer.hold);
    if (answer.state === 'gone') setLost({ answer, times: answer.times ?? [] });
    else if (answer.payment?.status === 'failed')
      setNotice(answer.payment.failureMessage ?? 'That card was refused. Try another one.');
  }, []);

  useEffect(() => {
    if (finishing) return;
    let live = true;
    getHold(token)
      .then((v) => live && setHold(v))
      .catch((e: unknown) => live && setFailure(failureOf(e)));
    return () => {
      live = false;
    };
  }, [token, finishing]);

  /** Back from the provider: phase two names what it did, and the worker asks the provider itself. */
  useEffect(() => {
    if (returned.current) return;
    returned.current = true;
    const back = handoff;
    if (!back) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (back.kind === 'cancelled') {
      forgetPress(token);
      setNotice(
        'Payment cancelled — nothing was charged. Your time is still held for a few minutes.',
      );
      return;
    }
    const press = recallPress(token);
    void payDeposit(token, {
      clientId: press?.clientId ?? newClientId(),
      ...(back.kind === 'confirmed'
        ? { providerPaymentId: back.providerPaymentId }
        : { sourceToken: back.sourceToken, method: back.method }),
      website: '',
    })
      .then((answer) => {
        forgetPress(token);
        if (answer.stage === 'recorded') land(answer);
        window.scrollTo({ top: 0 });
      })
      .catch((e: unknown) => setFailure(failureOf(e)));
  }, [token, handoff, land]);

  if (failure?.kind === 'stale' || failure?.kind === 'missing')
    return (
      <PublicFrame business={failure.kind === 'stale' ? failure.business : null}>
        <PublicState
          tone="warning"
          icon={<Link2Off size={20} />}
          title={failure.kind === 'stale' ? 'This link is out of date' : 'This link doesn’t work'}
          testId="hold-link-bad"
        >
          Start again from the booking page, or give us a call and we’ll book you in.
        </PublicState>
      </PublicFrame>
    );

  if (failure?.kind === 'error')
    return (
      <PublicFrame business={hold?.business ?? null}>
        <PublicState
          tone="warning"
          icon={<CircleAlert size={20} />}
          title="Something went wrong"
          testId="hold-error"
          action={hold ? <CallButton business={hold.business} /> : undefined}
        >
          {failure.message}
        </PublicState>
      </PublicFrame>
    );

  if (!hold)
    return (
      <PublicFrame business={null}>
        <PublicState icon={<Clock size={20} />} title="Loading…" testId="hold-loading" />
      </PublicFrame>
    );

  const tz = hold.appointment.timezone;
  const restart = () => {
    window.location.assign(hold.calendar.bookingPath ?? '/');
  };

  if (lost)
    return (
      <PublicFrame business={hold.business}>
        <TimeWentPanel answer={lost.answer} tz={tz} times={lost.times} onRestart={restart} />
      </PublicFrame>
    );

  if (hold.state === 'booked' && hold.booked)
    return (
      <PublicFrame business={hold.business}>
        <BookedPanel booked={hold.booked} tz={tz} business={hold.business} deposit={hold.deposit} />
      </PublicFrame>
    );

  if (hold.state === 'gone')
    return (
      <PublicFrame business={hold.business}>
        <PublicState
          tone="warning"
          icon={<CircleAlert size={20} />}
          title="That time just went"
          testId="hold-gone"
          action={<CallButton business={hold.business} />}
        >
          Nothing was charged. Pick another time on the booking page, or {callPhrase(hold.business)}
          .
        </PublicState>
      </PublicFrame>
    );

  return (
    <PublicFrame business={hold.business}>
      <div className="relative mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-4 px-4 pt-4 md:pb-8 md:pt-8">
        <DepositStep
          hold={hold}
          tz={tz}
          notice={notice}
          onPaid={(answer) => land(answer)}
          onLost={(answer) => setLost({ answer, times: answer.times ?? [] })}
        />
      </div>
    </PublicFrame>
  );
}
