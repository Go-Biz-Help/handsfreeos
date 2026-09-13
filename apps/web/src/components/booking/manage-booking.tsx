'use client';
/**
 * Change or cancel a booking from its short link (/m/<token>). Loaded from the customer's browser, so the
 * worker's per-address limits count per customer. Shows the canvas's states: booked (Reschedule, Cancel
 * it, and the rules in plain words), cancelled, past, a link that is out of date, and one that doesn't work.
 */
import { addDays, localDateOf } from '@hfos/core';
import {
  CalendarCheck,
  CalendarClock,
  CalendarX,
  Check,
  CircleAlert,
  Info,
  Link2Off,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api/errors';
import {
  calendarFileUrl,
  cancelBooking,
  getManage,
  getManageTimes,
  rescheduleBooking,
  type ManageView,
  type PublicBusiness,
  type PublicSlot,
} from '@/lib/api/public-booking';
import { AddToCalendar } from './add-to-calendar';
import { dayLong, dayShort, hoursLabel, joinNames, seatsLabel, timeOf, timeRange } from './format';
import { callPhrase, CallButton, PublicFrame, PublicState } from './public-shell';
import { TimePicker } from './time-picker';

type Failure =
  | { kind: 'stale'; business: PublicBusiness | null }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const MOVE_REASON: Record<string, string> = {
  not_allowed: 'This booking can’t be moved online.',
  cutoff: 'It’s too close to the start to move it online.',
  limit: 'It was already moved as many times as allowed online.',
  calendar_off: 'Online changes are paused right now.',
};
const CANCEL_REASON: Record<string, string> = {
  not_allowed: 'This booking can’t be cancelled online.',
  cutoff: 'It’s too close to the start to cancel it online.',
};

/** The rules in plain words (the canvas's "You can move or cancel until ..."). */
function rulesText(view: ManageView): string {
  const tz = view.appointment.timezone;
  const { reschedule: r, cancel: c } = view.policies;
  const at = (iso: string) => `${dayShort(iso, tz)} at ${timeOf(iso, tz)}`;
  const parts: string[] = [];
  if (r.allowed && c.allowed && r.until === c.until)
    parts.push(
      `You can move or cancel until ${at(r.until)}${r.cutoffHours ? `, ${hoursLabel(r.cutoffHours)} before` : ''}.`,
    );
  else {
    parts.push(
      r.allowed ? `You can move it until ${at(r.until)}.` : MOVE_REASON[r.reason ?? 'not_allowed']!,
    );
    parts.push(
      c.allowed
        ? `You can cancel until ${at(c.until)}.`
        : CANCEL_REASON[c.reason ?? 'not_allowed']!,
    );
  }
  parts.push(
    r.allowed || c.allowed
      ? `After that, please ${callPhrase(view.business)}.`
      : `Please ${callPhrase(view.business)} to change it.`,
  );
  if (r.allowed)
    parts.push(`You can move it ${r.movesLeft} more ${r.movesLeft === 1 ? 'time' : 'times'}.`);
  return parts.join(' ');
}

export function ManageBooking({ token: initialToken }: { token: string }) {
  const router = useRouter();
  const [token, setToken] = useState(initialToken);
  const [view, setView] = useState<ManageView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>('view');
  const [slot, setSlot] = useState<PublicSlot | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const toFailure = (e: unknown): Failure => {
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

  useEffect(() => {
    let live = true;
    getManage(initialToken)
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setFailure(toFailure(e)));
    return () => {
      live = false;
    };
  }, [initialToken]);

  const load = useCallback((from: string, to: string) => getManageTimes(token, from, to), [token]);

  /** After a change: the page shows the new state; a moved seat's new link replaces the address. */
  const applied = (next: ManageView, message: string) => {
    setView(next);
    setMode('view');
    setSlot(null);
    setError(null);
    setNotice(message);
    if (next.manageToken !== token) {
      setToken(next.manageToken);
      router.replace(`/m/${next.manageToken}`);
    }
    window.scrollTo({ top: 0 });
  };

  const failedChange = async (e: unknown) => {
    if (e instanceof ApiError && (e.status === 410 || e.status === 404)) {
      setFailure(toFailure(e));
      return;
    }
    if (e instanceof ApiError && (e.rule === 'slot_taken' || e.rule === 'resource_full')) {
      setSlot(null);
      // A full bed or room says so in its own words ("No Red light bed is free then.").
      setError(
        e.rule === 'resource_full'
          ? `${e.message} Pick another time.`
          : 'That time was just taken. Pick another time.',
      );
      return;
    }
    setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    // The rules may have changed under us (a cutoff passed): show the page as it is now.
    try {
      setView(await getManage(token));
    } catch {
      // Keep what's on screen.
    }
  };

  async function move() {
    if (!slot || busy) return;
    setBusy(true);
    try {
      const next = await rescheduleBooking(token, {
        startsAt: slot.startsAt,
        sessionId: slot.sessionId,
      });
      const a = next.appointment;
      applied(
        next,
        `Moved to ${dayLong(a.startsAt, a.timezone)}, ${timeRange(a.startsAt, a.endsAt, a.timezone)}.`,
      );
    } catch (e) {
      await failedChange(e);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (busy) return;
    setBusy(true);
    try {
      applied(await cancelBooking(token, reason.trim() || null), 'Your appointment is cancelled.');
    } catch (e) {
      await failedChange(e);
    } finally {
      setBusy(false);
    }
  }

  if (failure?.kind === 'stale')
    return (
      <PublicFrame business={failure.business}>
        <PublicState
          tone="warning"
          icon={<CircleAlert size={20} />}
          title="This link is out of date"
          testId="link-stale"
        >
          Your appointment changed after we sent it. Use the newest text or email from us
          {failure.business ? `, or ${callPhrase(failure.business)}` : ''}.
        </PublicState>
      </PublicFrame>
    );
  if (failure)
    return (
      <PublicFrame business={null}>
        <PublicState
          icon={<Link2Off size={20} />}
          title={failure.kind === 'missing' ? 'This link doesn’t work' : 'We couldn’t open this'}
          testId="link-missing"
        >
          {failure.kind === 'missing'
            ? 'Check that it matches the one we sent you, or contact the business.'
            : failure.message}
        </PublicState>
      </PublicFrame>
    );
  if (!view)
    return (
      <PublicFrame business={null}>
        <p aria-live="polite" className="mx-auto mt-16 text-[13px] text-text-3">
          Opening your appointment…
        </p>
      </PublicFrame>
    );

  const a = view.appointment;
  const tz = a.timezone;
  const bookAgain = view.calendar.bookingPath ? (
    <ButtonLink href={view.calendar.bookingPath} variant="primary" size="sm">
      Book again
    </ButtonLink>
  ) : (
    <CallButton business={view.business} />
  );

  if (view.state !== 'booked')
    return (
      <PublicFrame business={view.business}>
        {notice ? (
          <p
            role="status"
            className="mx-auto mt-6 flex w-full max-w-[480px] items-center gap-2 px-6 text-[13px] text-success-text"
          >
            <Check size={15} aria-hidden />
            {notice}
          </p>
        ) : null}
        <PublicState
          icon={view.state === 'cancelled' ? <CalendarX size={20} /> : <CalendarCheck size={20} />}
          title={
            view.state === 'cancelled'
              ? 'This appointment is cancelled'
              : 'This appointment has passed'
          }
          action={bookAgain}
          testId={`manage-${view.state}`}
        >
          {a.title} on {dayShort(a.startsAt, tz)} at {timeOf(a.startsAt, tz)}.
        </PublicState>
      </PublicFrame>
    );

  const { reschedule: r, cancel: c } = view.policies;
  const today = localDateOf(Date.now(), tz);
  const details = [
    a.timezoneLabel,
    a.where,
    a.with.length ? `with ${joinNames(a.with)}` : null,
    a.kind === 'session' ? seatsLabel(a.seats) : null,
  ].filter(Boolean);

  return (
    <PublicFrame business={view.business}>
      <div
        className={`mx-auto flex w-full flex-1 flex-col gap-3.5 px-4 pb-8 pt-5 md:pt-10 ${mode === 'reschedule' ? 'max-w-[860px]' : 'max-w-[560px]'}`}
        data-testid="manage-booked"
      >
        {notice ? (
          <p role="status" className="flex items-center gap-2 text-[13px] text-success-text">
            <Check size={15} aria-hidden />
            {notice}
          </p>
        ) : null}
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
            Your appointment
          </span>
          <h1 className="text-lg font-semibold">{a.title}</h1>
          <p className="text-[13px]" data-testid="manage-when">
            {dayLong(a.startsAt, tz)} · {timeRange(a.startsAt, a.endsAt, tz)}
          </p>
          <p className="text-xs text-text-3">{details.join(' · ')}</p>
        </div>

        {mode === 'view' ? (
          <>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={!r.allowed}
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  setMode('reschedule');
                }}
              >
                <CalendarClock size={16} aria-hidden />
                Reschedule
              </Button>
              <Button
                variant="secondary"
                className="flex-1 text-danger-text"
                disabled={!c.allowed}
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  setMode('cancel');
                }}
              >
                <CalendarX size={16} aria-hidden />
                Cancel it
              </Button>
            </div>
            <div className="flex items-start gap-2.5 rounded-[10px] bg-accent-soft px-3 py-2.5 text-[13px] text-accent-text">
              <Info size={16} className="mt-0.5 flex-none" aria-hidden />
              <span data-testid="manage-rules">{rulesText(view)}</span>
            </div>
            {view.policies.text ? (
              <p className="whitespace-pre-line text-xs text-text-3">{view.policies.text}</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-[13px] text-danger-text">
                {error}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium">Add to your calendar</span>
              <AddToCalendar
                entry={{
                  title: `${a.title} with ${view.business.name}`,
                  startsAt: a.startsAt,
                  endsAt: a.endsAt,
                  where: a.where,
                  details: `Change or cancel: ${view.manageUrl}`,
                  icsUrl: calendarFileUrl(token),
                }}
              />
            </div>
          </>
        ) : mode === 'cancel' ? (
          <div
            className="flex flex-col gap-3 rounded-card border border-border bg-card p-4 shadow-1"
            data-testid="cancel-confirm"
          >
            <h2 className="text-[15px] font-semibold">Cancel this appointment?</h2>
            <p className="text-[13px] text-text-2">
              {view.business.name} will be told. You can’t undo this online.
            </p>
            <div>
              <Label htmlFor="cancel-reason">
                Anything you’d like to tell us?{' '}
                <span className="font-normal text-text-3">Optional</span>
              </Label>
              <Textarea
                id="cancel-reason"
                className="min-h-16"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-[13px] text-danger-text">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                variant="danger"
                className="flex-1"
                loading={busy}
                onClick={() => void cancel()}
              >
                Yes, cancel it
              </Button>
              <Button variant="ghost" className="flex-1" onClick={() => setMode('view')}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="reschedule">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Pick a new time</h2>
              <button
                type="button"
                className="text-[13px] font-medium text-accent-text hover:underline"
                onClick={() => {
                  setMode('view');
                  setSlot(null);
                  setError(null);
                }}
              >
                Keep the current time
              </button>
            </div>
            {error ? (
              <p role="alert" className="text-[13px] text-danger-text">
                {error}
              </p>
            ) : null}
            <TimePicker
              timezone={tz}
              timezoneLabel={a.timezoneLabel}
              minDate={today}
              maxDate={addDays(today, 60)}
              load={load}
              loadKey={token}
              selected={slot}
              onSelect={(s) => {
                setSlot(s);
                setError(null);
              }}
              footer={
                <Button
                  className="w-full"
                  disabled={!slot}
                  loading={busy}
                  onClick={() => void move()}
                >
                  {slot
                    ? `Move to ${dayShort(slot.startsAt, tz)} at ${timeOf(slot.startsAt, tz)}`
                    : 'Pick a time'}
                </Button>
              }
            />
            <div className="sticky bottom-0 -mx-4 border-t border-border bg-card px-4 py-2.5 md:hidden">
              <Button
                size="lg"
                className="w-full"
                disabled={!slot}
                loading={busy}
                onClick={() => void move()}
              >
                {slot
                  ? `Move to ${dayShort(slot.startsAt, tz)} at ${timeOf(slot.startsAt, tz)}`
                  : 'Pick a time'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </PublicFrame>
  );
}
