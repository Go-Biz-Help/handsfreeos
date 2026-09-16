'use client';
/**
 * "You're booked": the last screen of the booking page, and the one a paid deposit lands on
 * (design/m5/Booking.dc.html and design/m9/Booking.dc.html). It is its own component because both the booking
 * flow and the deposit's own page at `/hold/<token>` end here, and a customer should never be able to tell
 * which of the two they came through.
 */
import { Check } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import {
  calendarFileUrl,
  type Booked,
  type Held,
  type PublicBusiness,
} from '@/lib/api/public-booking';
import { cn } from '@/lib/utils';
import { AddToCalendar } from './add-to-calendar';
import {
  dayLong,
  hoursLabel,
  joinNames,
  lengthLabel,
  money,
  seatsLabel,
  timeRange,
} from './format';
import { callPhrase } from './public-shell';

/** What a customer paid to hold this time, once it is theirs. */
function DepositPaid({ deposit, email }: { deposit: Held['deposit']; email: string | null }) {
  const card =
    deposit.cardBrand || deposit.cardLast4
      ? `${deposit.cardBrand ?? 'Card'}${deposit.cardLast4 ? ` •••• ${deposit.cardLast4}` : ''}`
      : deposit.method === 'ach'
        ? 'Bank transfer'
        : null;
  const settling = deposit.paidCents === 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-card border border-border bg-card px-4 py-3 shadow-1">
      <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
        {deposit.mode === 'full' ? 'Paid' : 'Deposit'}
      </span>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-text-2">{settling ? 'On its way' : 'Paid today'}</span>
        <span className="text-[15px] font-semibold" data-testid="deposit-paid">
          {money(deposit.amountCents)}
        </span>
      </div>
      {card ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-text-2">Paid by</span>
          <span className="text-[13px]">{card}</span>
        </div>
      ) : null}
      {deposit.dueAfterCents > 0 ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-text-2">Due after the visit</span>
          <span className="text-[13px]" data-testid="deposit-after">
            {money(deposit.dueAfterCents)}
          </span>
        </div>
      ) : null}
      <p className="mt-1 text-xs text-text-3">
        {settling
          ? 'Bank transfers take a day or two. We’ll email a receipt when it lands.'
          : email
            ? `A receipt is on its way to ${email}.`
            : 'A receipt has been written against this booking.'}
      </p>
    </div>
  );
}

export function BookedPanel({
  booked,
  tz,
  business,
  deposit,
  onRestart,
}: {
  booked: Booked;
  tz: string;
  business: PublicBusiness;
  /** Shown when this time was held with a deposit. */
  deposit?: Held['deposit'] | null;
  onRestart?: () => void;
}) {
  const b = booked.booking;
  const p = booked.policies;
  const cutoffs = [
    ...(p.cancel.allowed ? [p.cancel.cutoffHours] : []),
    ...(p.reschedule.allowed ? [p.reschedule.cutoffHours] : []),
  ];
  const email = booked.contact.email;
  const phone = booked.contact.phoneDisplay;
  const done =
    email && booked.contact.texts
      ? `We emailed the details to ${email} and texted ${phone}.`
      : email
        ? `We emailed the details to ${email}.`
        : booked.contact.texts
          ? `We texted the details to ${phone}.`
          : 'Add it to your calendar so it’s not forgotten.';
  const changeNote = cutoffs.length
    ? `${Math.min(...cutoffs) ? `Up to ${hoursLabel(Math.min(...cutoffs))} before.` : 'Up to the start time.'}${email ? ' The link is in your email too.' : booked.contact.texts ? ' The link is in your text too.' : ''}`
    : `To change it, please ${callPhrase(business)}.`;
  const summary: [string, string | null][] = [
    [
      'What',
      `${b.title} · ${b.kind === 'session' ? seatsLabel(b.seats) : lengthLabel(b.durationMinutes)}`,
    ],
    [
      'When',
      `${dayLong(b.startsAt, tz)}, ${timeRange(b.startsAt, b.endsAt, tz)} ${b.timezoneLabel}`,
    ],
    ['Where', b.where],
    ['Who', b.with.length ? `${joinNames(b.with)} from ${business.name}` : null],
  ];
  return (
    <div
      className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-4 px-4 pb-6 pt-6 md:pt-10"
      data-testid="booked"
    >
      <div className="flex flex-col items-center gap-1.5 text-center">
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success-text">
          <Check size={26} aria-hidden />
        </span>
        <h1 className="text-[22px] font-semibold">You’re booked</h1>
        <p className="text-[13px] text-text-2">{done}</p>
      </div>
      {deposit ? <DepositPaid deposit={deposit} email={email} /> : null}
      <dl className="rounded-card border border-border bg-card px-4 py-1 shadow-1">
        {summary
          .filter((r): r is [string, string] => !!r[1])
          .map(([k, v], i) => (
            <div
              key={k}
              className={cn('flex items-start gap-3 py-[9px]', i > 0 && 'border-t border-border')}
            >
              <dt className="mt-px w-11 flex-none text-xs text-text-3">{k}</dt>
              <dd className="text-[13px]" data-testid={`booked-${k.toLowerCase()}`}>
                {v}
              </dd>
            </div>
          ))}
      </dl>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium">Add to your calendar</span>
        <AddToCalendar
          entry={{
            title: `${b.title} with ${business.name}`,
            startsAt: b.startsAt,
            endsAt: b.endsAt,
            where: b.where,
            details: `Change or cancel: ${booked.manageUrl}`,
            icsUrl: calendarFileUrl(booked.manageToken),
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <ButtonLink
          href={`/m/${booked.manageToken}`}
          variant="secondary"
          size="lg"
          className="w-full"
        >
          Change or cancel
        </ButtonLink>
        <span className="text-center text-xs text-text-3">
          {changeNote}
          {deposit && deposit.paidCents > 0 && p.cancel.allowed
            ? ` Cancel in time and the ${deposit.mode === 'full' ? 'payment' : 'deposit'} comes back in full.`
            : ''}
        </span>
      </div>
      {onRestart ? (
        <button
          type="button"
          onClick={onRestart}
          className="self-center text-[13px] font-medium text-accent-text hover:underline"
        >
          Book something else
        </button>
      ) : null}
    </div>
  );
}
