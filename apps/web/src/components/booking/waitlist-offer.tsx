'use client';
/**
 * A waitlist offer (/w/<token>): the time that opened up, held for this customer until a set time, and
 * "Book this time". Loaded and claimed from the customer's own browser, so the worker's per-address limits
 * count per customer. States: holding it, booked (with the booking's change-or-cancel link), taken by
 * someone else first, run out, no offer open, and a link that doesn't work.
 */
import { CalendarClock, CalendarX, Check, Clock, Link2Off } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { ApiError } from '@/lib/api/errors';
import type { ManageView, PublicBusiness } from '@/lib/api/public-booking';
import { publicEnv } from '@/lib/env';
import { dayLong, dayShort, lengthLabel, localDate, seatsLabel, timeOf, timeRange } from './format';
import { CallButton, PublicFrame, PublicState } from './public-shell';

interface OfferView {
  readonly state: 'offered' | 'taken' | 'expired' | 'booked' | 'closed';
  readonly business: PublicBusiness;
  readonly calendar: { readonly name: string; readonly bookingPath: string | null };
  readonly offer: {
    readonly title: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly durationMinutes: number;
    readonly timezone: string;
    readonly timezoneLabel: string;
    readonly where: string | null;
    readonly seats: number;
  } | null;
  /** Until when it's held, while it is. */
  readonly expiresAt: string | null;
  /** The booking's change-or-cancel link, once claimed. */
  readonly manageToken: string | null;
}

type Claimed = ManageView & { readonly duplicate: boolean };

type ErrorBody = {
  error?: { code?: string; message?: string; rule?: string; details?: unknown };
} | null;

const offerPath = (token: string) => `/public/waitlist/${encodeURIComponent(token)}`;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, {
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      ...init,
    });
  } catch {
    throw new ApiError(
      0,
      'internal',
      'We couldn’t reach the booking service. Check your connection and try again.',
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

const getOffer = (token: string) => call<OfferView>(offerPath(token));
const claimOffer = (token: string) =>
  call<Claimed>(`${offerPath(token)}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

const messageOf = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';

/** "23 minutes left", "1 minute left", "less than a minute left". */
function leftLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute left';
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;
}

export function WaitlistOffer({ token }: { token: string }) {
  const [view, setView] = useState<OfferView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState<Claimed | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setView(await getOffer(token));
      setNow(Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(messageOf(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // The countdown, and a fresh look once the hold runs out.
  const holding = view?.state === 'offered' && !!view.expiresAt;
  useEffect(() => {
    if (!holding) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [holding]);
  const left = view?.expiresAt ? Date.parse(view.expiresAt) - now : 0;
  useEffect(() => {
    if (holding && left <= 0) void load();
  }, [holding, left, load]);

  async function claim() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setClaimed(await claimOffer(token));
    } catch (e) {
      // Someone else was faster (or took the last bed or room), the hold ran out, or the offer closed:
      // show the page as it is now.
      if (
        e instanceof ApiError &&
        (e.rule === 'slot_taken' ||
          e.rule === 'resource_full' ||
          e.rule === 'offer_expired' ||
          e.rule === 'offer_not_active')
      )
        await load();
      else setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (missing)
    return (
      <PublicFrame business={null}>
        <PublicState
          icon={<Link2Off size={20} />}
          title="This link doesn’t work"
          testId="link-missing"
        >
          Check that it matches the one we sent you, or contact the business.
        </PublicState>
      </PublicFrame>
    );
  if (!view)
    return (
      <PublicFrame business={null}>
        {error ? (
          <PublicState icon={<Link2Off size={20} />} title="We couldn’t open this">
            {error}
          </PublicState>
        ) : (
          <p aria-live="polite" className="mx-auto mt-16 text-[13px] text-text-3">
            Opening your offer…
          </p>
        )}
      </PublicFrame>
    );

  const o = view.offer;
  const tz = o?.timezone ?? claimed?.appointment.timezone ?? 'UTC';
  const otherTimes = view.calendar.bookingPath ? (
    <ButtonLink href={view.calendar.bookingPath} variant="primary" size="sm">
      See other times
    </ButtonLink>
  ) : (
    <CallButton business={view.business} />
  );

  if (claimed || view.state === 'booked') {
    const a = claimed?.appointment;
    const title = a?.title ?? o?.title ?? view.calendar.name;
    const startsAt = a?.startsAt ?? o?.startsAt ?? null;
    const endsAt = a?.endsAt ?? o?.endsAt ?? null;
    const manage = claimed?.manageToken ?? view.manageToken;
    return (
      <PublicFrame business={claimed?.business ?? view.business}>
        <div
          className="mx-auto flex w-full max-w-[560px] flex-1 flex-col items-center gap-2 px-4 pb-8 pt-8 text-center md:pt-12"
          data-testid="offer-booked"
        >
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success-text">
            <Check size={26} aria-hidden />
          </span>
          <h1 className="text-[22px] font-semibold">You’re booked</h1>
          {startsAt && endsAt ? (
            <p className="text-[13px]" data-testid="offer-booked-when">
              {title} · {dayLong(startsAt, tz)}, {timeRange(startsAt, endsAt, tz)}
            </p>
          ) : null}
          <p className="text-xs text-text-3">Your confirmation is on its way.</p>
          {manage ? (
            <ButtonLink href={`/m/${manage}`} variant="secondary" size="sm" className="mt-2">
              Change or cancel
            </ButtonLink>
          ) : null}
        </div>
      </PublicFrame>
    );
  }

  if (view.state === 'taken')
    return (
      <PublicFrame business={view.business}>
        <PublicState
          tone="warning"
          icon={<CalendarX size={20} />}
          title="Someone else booked this time"
          action={otherTimes}
          testId="offer-taken"
        >
          You’re still on the waitlist, and we’ll let you know when another time opens.
        </PublicState>
      </PublicFrame>
    );
  if (view.state === 'expired')
    return (
      <PublicFrame business={view.business}>
        <PublicState
          icon={<Clock size={20} />}
          title="This offer ran out"
          action={otherTimes}
          testId="offer-expired"
        >
          We held{' '}
          {o
            ? `${o.title} on ${dayShort(o.startsAt, tz)} at ${timeOf(o.startsAt, tz)}`
            : 'this time'}{' '}
          for a while, then offered it to the next person.
        </PublicState>
      </PublicFrame>
    );
  if (view.state === 'closed' || !o || !view.expiresAt)
    return (
      <PublicFrame business={view.business}>
        <PublicState
          icon={<CalendarClock size={20} />}
          title="This offer isn’t open anymore"
          action={otherTimes}
          testId="offer-closed"
        >
          We’ll let you know if another time opens.
        </PublicState>
      </PublicFrame>
    );

  const until =
    localDate(view.expiresAt, tz) === localDate(new Date(now).toISOString(), tz)
      ? timeOf(view.expiresAt, tz)
      : `${dayShort(view.expiresAt, tz)} at ${timeOf(view.expiresAt, tz)}`;
  const details = [
    o.timezoneLabel,
    o.where,
    o.seats > 1 ? seatsLabel(o.seats) : lengthLabel(o.durationMinutes),
  ].filter(Boolean);

  return (
    <PublicFrame business={view.business}>
      <div
        className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-3.5 px-4 pb-8 pt-5 md:pt-10"
        data-testid="offer-open"
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
            A time opened up
          </span>
          <h1 className="text-lg font-semibold">{o.title}</h1>
          <p className="text-[13px]" data-testid="offer-when">
            {dayLong(o.startsAt, tz)} · {timeRange(o.startsAt, o.endsAt, tz)}
          </p>
          <p className="text-xs text-text-3">{details.join(' · ')}</p>
        </div>
        <div className="flex items-start gap-2.5 rounded-[10px] bg-accent-soft px-3 py-2.5 text-[13px] text-accent-text">
          <Clock size={16} className="mt-0.5 flex-none" aria-hidden />
          <span data-testid="offer-hold">
            We’re holding it for you until {until} ({leftLabel(left)}).
          </span>
        </div>
        {error ? (
          <p role="alert" className="text-[13px] text-danger-text">
            {error}
          </p>
        ) : null}
        <Button size="lg" className="w-full" loading={busy} onClick={() => void claim()}>
          Book this time
        </Button>
        <p className="text-xs text-text-3">
          If you don’t want it, there’s nothing to do. We’ll offer it to the next person after that.
        </p>
      </div>
    </PublicFrame>
  );
}
