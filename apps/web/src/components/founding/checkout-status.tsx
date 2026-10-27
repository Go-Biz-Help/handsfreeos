'use client';

/**
 * Where a founding spot's payment has got to (0093), for the person paying.
 *
 * Two jobs. On the way out it waits for the worker to make Stripe's page and then sends them there. On the way
 * back it waits for **Stripe's own event** to turn the spot on — being sent back to this page proves nothing,
 * since anybody can type its address, so the page only ever reads what the database says.
 *
 * A refused renewal, paid with another card from Settings → Usage & balance, comes through here too: then "done" is
 * the month or year having moved on. A spot the business bought itself from the plan page (20261027012700) goes on
 * to the setup when it's done, and back to the plan page when it didn't go through.
 */
import { CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ButtonLink } from '@/components/ui/button';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { foundingPlanHref } from '@/lib/founding-plan';
import { WORKSPACE_COOKIE } from '@/lib/workspace-cookie';

type Status = Ok<'/v1/queries/founding.checkout_status'>;

/** "Oct 19, 2027". */
const longDay = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : 'a year from today';

/** How often, and for how long, before saying it is taking longer than it should. */
const EVERY_MS = 1500;
const PATIENCE = 40;

const Note = ({
  tone,
  icon,
  children,
  testId,
}: {
  tone: 'wait' | 'good' | 'warn';
  icon: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) => (
  <div
    data-testid={testId}
    className={`mt-6 flex gap-3 rounded-menu px-4 py-3.5 text-[13.5px] leading-relaxed ${
      tone === 'good'
        ? 'bg-success-soft text-success-text'
        : tone === 'warn'
          ? 'bg-warning-soft text-warning-text'
          : 'bg-card-2 text-text-2'
    }`}
  >
    {icon}
    <span>{children}</span>
  </div>
);

export function CheckoutStatus({
  initial,
  back,
}: {
  initial: Status;
  /** Where Stripe sent them back from: the page after paying, the page after giving up, or neither. */
  back: 'paid' | 'cancel' | null;
}) {
  const [s, setS] = useState(initial);
  const [asked, setAsked] = useState(0);
  const [leaving, setLeaving] = useState(false);

  const waiting =
    s.status === 'pending' ||
    (s.status === 'open' && back === 'paid') ||
    (s.status === 'paid' && !s.seatActive && !s.problem);

  useEffect(() => {
    if (!waiting || asked >= PATIENCE) return;
    const t = setTimeout(async () => {
      try {
        const next = unwrap(
          await apiBrowser().POST('/v1/queries/founding.checkout_status', {
            body: { checkoutId: s.checkoutId },
          }),
        );
        setS(next);
      } catch {
        // A blip: the next round asks again.
      }
      setAsked((n) => n + 1);
    }, EVERY_MS);
    return () => clearTimeout(t);
  }, [waiting, asked, s.checkoutId]);

  // On the way out, straight to Stripe the moment the page exists.
  useEffect(() => {
    if (s.status === 'open' && s.url && back === null && !leaving) {
      setLeaving(true);
      window.location.assign(s.url);
    }
  }, [s.status, s.url, back, leaving]);

  const spinner = (
    <Loader2 className="h-[18px] w-[18px] flex-none animate-spin" strokeWidth={1.5} />
  );
  const period = s.billing === 'monthly' ? 'month' : 'year';
  const remember = () => {
    document.cookie = `${WORKSPACE_COOKIE}=${s.workspaceId}; path=/; max-age=31536000; samesite=lax`;
  };
  const clock = <Clock className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />;

  if (s.seatActive)
    return (
      <>
        <Note
          tone="good"
          testId="checkout-done"
          icon={<CheckCircle2 className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />}
        >
          {s.renewal
            ? `Paid: your ${s.offerName} spot is renewed through ${longDay(s.paidThrough)}. This card is the one charged next ${period}.`
            : s.billing === 'yearly' || s.billing === 'monthly'
              ? `Paid, and it’s yours: ${s.offerName}, through ${longDay(s.paidThrough)}. It renews each ${period} on this card; you can stop that any time in Settings → Usage & balance.`
              : `Paid, and it’s yours: ${s.offerName}, for as long as HandsFreeOS exists.`}{' '}
          A receipt is on its way from Stripe.
        </Note>
        {s.selfServe ? (
          <ButtonLink
            href={`/onboarding/${s.workspaceId}`}
            variant="primary"
            size="lg"
            className="mt-5 w-full"
            data-testid="checkout-set-up"
            onClick={remember}
          >
            Carry on setting up
          </ButtonLink>
        ) : (
          <ButtonLink
            href={`/app/w/${s.workspaceId}`}
            variant="primary"
            size="lg"
            className="mt-5 w-full"
            onClick={remember}
          >
            Open your workspace
          </ButtonLink>
        )}
      </>
    );

  if (s.status === 'paid')
    return s.problem ? (
      <Note tone="warn" testId="checkout-stranded" icon={clock}>
        Your payment went through, but we couldn’t turn the spot on by ourselves. We’ve been told
        and will sort it out with you — you won’t be charged again.
      </Note>
    ) : (
      <Note tone="wait" testId="checkout-finishing" icon={spinner}>
        {s.renewal
          ? 'Payment received. Renewing your spot…'
          : 'Payment received. Turning your spot on…'}
      </Note>
    );

  if (s.status === 'expired' || s.status === 'failed')
    return (
      <>
        <Note tone="warn" testId={`checkout-${s.status}`} icon={clock}>
          {s.problem || 'This payment didn’t go through, and nothing was taken.'}{' '}
          {s.renewal
            ? 'Press Pay with another card in Settings → Usage & balance to try again. Your spot stays on meanwhile.'
            : s.selfServe
              ? 'Pick your spot again to start over.'
              : 'Open your claim link again to start over.'}
        </Note>
        {s.selfServe && !s.renewal ? (
          <ButtonLink
            href={foundingPlanHref(s.workspaceId)}
            variant="primary"
            size="lg"
            className="mt-5 w-full"
            data-testid="checkout-pick-again"
          >
            Pick your spot
          </ButtonLink>
        ) : null}
      </>
    );

  if (asked >= PATIENCE)
    return (
      <Note tone="warn" testId="checkout-slow" icon={clock}>
        This is taking longer than it should. Refresh this page in a minute — nothing is lost, and
        you won’t be charged twice.
      </Note>
    );

  if (s.status === 'pending')
    return (
      <Note tone="wait" testId="checkout-preparing" icon={spinner}>
        Getting your secure payment page ready…
      </Note>
    );

  // Open: waiting on Stripe's word, back from giving up, or on the way there.
  if (back === 'paid')
    return (
      <Note tone="wait" testId="checkout-confirming" icon={spinner}>
        Checking with Stripe…
      </Note>
    );
  if (back === 'cancel')
    return (
      <>
        <Note tone="warn" testId="checkout-cancelled" icon={clock}>
          You didn’t finish paying, and nothing was taken.{' '}
          {s.renewal
            ? 'Your spot stays on meanwhile.'
            : s.selfServe
              ? 'Your spot is held for you for an hour.'
              : 'Your seat is still held for you.'}
        </Note>
        {s.url ? (
          <ButtonLink href={s.url} variant="primary" size="lg" className="mt-5 w-full">
            Go back to paying
          </ButtonLink>
        ) : null}
        {s.selfServe && !s.renewal ? (
          <ButtonLink
            href={foundingPlanHref(s.workspaceId)}
            variant="secondary"
            size="lg"
            className="mt-2.5 w-full"
            data-testid="checkout-pick-other"
          >
            Pick a different spot
          </ButtonLink>
        ) : null}
      </>
    );
  return (
    <>
      <Note tone="wait" testId="checkout-leaving" icon={spinner}>
        Taking you to Stripe’s secure page…
      </Note>
      {s.url ? (
        <ButtonLink href={s.url} variant="secondary" size="lg" className="mt-5 w-full">
          Go now
        </ButtonLink>
      ) : null}
    </>
  );
}
