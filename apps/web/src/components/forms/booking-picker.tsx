'use client';
import { bookingDay, bookingLabel, isBookingAnswer, type BookingAnswer } from '@hfos/core';
import { Loader2 } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { formTimes, type FormTimes } from '@/lib/api/public-forms';
import { cn } from '@/lib/utils';

/**
 * Which form this is, for a question that reads from the worker (a "Book a time" question's open times). The
 * public page provides it; the editor's preview doesn't, so a booking question there shows what it will do.
 * `refresh` goes up when the times should be read again: a time that filled up while they were deciding.
 */
export const PublicFormContext = createContext<{
  readonly site: string;
  readonly slug: string;
  readonly refresh: number;
} | null>(null);

/**
 * A "Book a time" question: the next open times on its calendar as buttons, a day at a time, and the one they
 * pick as the answer. It's booked when the form is sent, with the calendar's own confirmation.
 */
export function BookingPicker({
  questionId,
  value,
  onChange,
}: {
  questionId: string;
  value: unknown;
  onChange: (answer: BookingAnswer) => void;
}) {
  const page = useContext(PublicFormContext);
  const [times, setTimes] = useState<FormTimes | null>(null);
  const [failed, setFailed] = useState(false);
  const picked = isBookingAnswer(value) ? value : null;

  useEffect(() => {
    if (!page) return;
    let live = true;
    setFailed(false);
    formTimes(page.site, page.slug, questionId)
      .then((t) => live && setTimes(t))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [page, questionId, page?.refresh]);

  if (!page)
    return (
      <p className="rounded-card border border-dashed border-border px-3 py-5 text-center text-[13px] text-text-3">
        The calendar’s open times show here on the form’s page. The one they pick is booked when
        they send it.
      </p>
    );
  if (failed)
    return (
      <p className="text-[13px] text-danger-text">
        We couldn’t load the times just now. Refresh the page to try again.
      </p>
    );
  if (!times)
    return (
      <p className="flex items-center gap-2 text-[13px] text-text-3">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
        Finding open times
      </p>
    );
  if (!times.open || !times.slots.length)
    return (
      <p
        className="rounded-card bg-card-2 px-3 py-5 text-center text-[13px] text-text-2"
        data-testid="no-times"
      >
        {times.open
          ? 'There are no open times right now. Check back soon, or contact the business to book.'
          : 'Times can’t be booked here just now. Contact the business to book.'}
      </p>
    );

  const days = new Map<string, FormTimes['slots'][number][]>();
  for (const slot of times.slots) {
    const day = bookingDay(slot.startsAt, times.timezone);
    days.set(day, [...(days.get(day) ?? []), slot]);
  }
  return (
    <div className="space-y-4" data-testid="booking-times">
      {[...days].map(([day, slots]) => (
        <div key={day}>
          <p className="mb-2 text-[13px] font-medium text-text-2">{day}</p>
          <div className="flex flex-wrap gap-2">
            {slots.map((slot) => {
              const label = bookingLabel(slot.startsAt, times.timezone);
              const chosen =
                picked?.startsAt === slot.startsAt && picked.sessionId === slot.sessionId;
              return (
                <button
                  key={`${slot.startsAt}:${slot.sessionId ?? ''}`}
                  type="button"
                  aria-pressed={chosen}
                  onClick={() =>
                    onChange({ startsAt: slot.startsAt, sessionId: slot.sessionId, label })
                  }
                  className={cn(
                    'rounded-control border px-3.5 py-2 text-left text-[14px] transition-colors',
                    chosen
                      ? 'border-accent bg-accent text-white'
                      : 'border-border text-text hover:bg-card-2',
                  )}
                  data-testid="booking-time"
                >
                  {label.split(' · ')[1]}
                  {slot.seatsLeft !== null ? (
                    <span
                      className={cn(
                        'block text-[11.5px]',
                        chosen ? 'text-white/80' : 'text-text-3',
                      )}
                    >
                      {slot.seatsLeft === 1 ? '1 seat left' : `${slot.seatsLeft} seats left`}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
