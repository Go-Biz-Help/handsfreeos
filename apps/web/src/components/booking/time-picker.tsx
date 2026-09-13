'use client';
/**
 * Pick a day, then a time: a week strip on phones and a month on computers, times grouped into Morning and
 * Afternoon, always in the business's time zone. Open times are fetched 30 days at a time as the customer
 * moves forward; a change of inputs (`loadKey`) starts over at the first day with times.
 */
import { addDays, daysBetween, localDateOf, startOfLocalDay, weekdayOf } from '@hfos/core';
import { ChevronLeft, ChevronRight, Globe, Sun, Sunset } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/api/errors';
import type { OpenTimes, PublicSlot } from '@/lib/api/public-booking';
import { cn } from '@/lib/utils';
import { dateLong, isMorning, localDate, monthTitle, timeOf, WEEKDAY_SHORT } from './format';

/** 30 local days stay under the worker's 31-day limit even across a daylight-saving change. */
const CHUNK = 30;

export function TimePicker({
  timezone,
  timezoneLabel,
  minDate,
  maxDate,
  load,
  loadKey,
  selected,
  onSelect,
  onEmpty,
  footer,
}: {
  timezone: string;
  timezoneLabel: string;
  /** First and last local dates that can be booked. */
  minDate: string;
  maxDate: string;
  load: (from: string, to: string) => Promise<OpenTimes>;
  /** Changes when what is asked for changes (service, length, ZIP...): start over. */
  loadKey: string;
  selected: PublicSlot | null;
  onSelect: (slot: PublicSlot) => void;
  /** Nothing open anywhere up to maxDate. */
  onEmpty?: () => void;
  /** Under the times on computers (the Continue button). */
  footer?: ReactNode;
}) {
  const [byDate, setByDate] = useState<Record<string, PublicSlot[]>>({});
  /** Dates before this are fetched (from minDate). */
  const [fetchedUntil, setFetchedUntil] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [stripStart, setStripStart] = useState(minDate);
  const [month, setMonth] = useState(minDate.slice(0, 7));
  const generation = useRef(0);
  const latest = useRef({ load, selected, onEmpty, byDate, fetchedUntil });
  latest.current = { load, selected, onEmpty, byDate, fetchedUntil };
  const today = useMemo(() => localDateOf(Date.now(), timezone), [timezone]);

  async function fetchChunk(from: string): Promise<{
    until: string;
    found: Record<string, PublicSlot[]>;
  }> {
    const days = Math.min(CHUNK, daysBetween(from, maxDate) + 1);
    const out = await latest.current.load(
      new Date(startOfLocalDay(from, timezone)).toISOString(),
      new Date(startOfLocalDay(addDays(from, days), timezone)).toISOString(),
    );
    const found: Record<string, PublicSlot[]> = {};
    for (const s of out.slots) (found[localDate(s.startsAt, timezone)] ??= []).push(s);
    return { until: addDays(from, days), found };
  }

  const stripFor = (date: string) => (daysBetween(minDate, date) < 7 ? minDate : date);

  // New inputs: fetch forward until a day has times (the one already picked, when coming back).
  useEffect(() => {
    const gen = ++generation.current;
    setByDate({});
    setFetchedUntil(null);
    setError(null);
    setLoading(true);
    const wanted = latest.current.selected
      ? localDate(latest.current.selected.startsAt, timezone)
      : null;
    void (async () => {
      let from = minDate;
      let merged: Record<string, PublicSlot[]> = {};
      try {
        while (daysBetween(from, maxDate) >= 0) {
          const { until, found } = await fetchChunk(from);
          if (gen !== generation.current) return;
          merged = { ...merged, ...found };
          setByDate(merged);
          setFetchedUntil(until);
          from = until;
          const target =
            wanted && wanted < until && merged[wanted] ? wanted : Object.keys(merged).sort()[0];
          if (target) {
            setDay(target);
            setStripStart(stripFor(target));
            setMonth(target.slice(0, 7));
            return;
          }
        }
        latest.current.onEmpty?.();
      } catch (e) {
        if (gen === generation.current) setError(errorMessage(e));
      } finally {
        if (gen === generation.current) setLoading(false);
      }
    })();
  }, [loadKey, minDate, maxDate, timezone]);

  /** Fetches forward until `date` is covered (moving the strip or the month ahead). */
  async function ensure(date: string) {
    const target = daysBetween(date, maxDate) < 0 ? maxDate : date;
    let from = latest.current.fetchedUntil;
    if (!from || target < from) return;
    const gen = generation.current;
    setLoading(true);
    try {
      let merged = latest.current.byDate;
      while (from <= target && daysBetween(from, maxDate) >= 0) {
        const { until, found } = await fetchChunk(from);
        if (gen !== generation.current) return;
        merged = { ...merged, ...found };
        setByDate(merged);
        setFetchedUntil(until);
        from = until;
      }
    } catch (e) {
      if (gen === generation.current) setError(errorMessage(e));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }

  const fetched = (d: string) => !!fetchedUntil && d < fetchedUntil;
  const inRange = (d: string) => d >= minDate && d <= maxDate;
  const hasTimes = (d: string) => (byDate[d]?.length ?? 0) > 0;

  const stripDays = Array.from({ length: 7 }, (_, i) => addDays(stripStart, i)).filter(
    (d) => d <= maxDate,
  );
  const moveStrip = (by: number) => {
    const next = addDays(stripStart, by);
    const start = next < minDate ? minDate : next;
    setStripStart(start);
    void ensure(addDays(start, 6));
  };

  const monthStart = `${month}-01`;
  const lead = weekdayOf(monthStart);
  let monthDays = 28;
  while (addDays(monthStart, monthDays).startsWith(month)) monthDays += 1;
  // Whole weeks: the days before the 1st and after the last are shown faded.
  const cells = Array.from({ length: Math.ceil((lead + monthDays) / 7) * 7 }, (_, i) =>
    addDays(monthStart, i - lead),
  );
  const moveMonth = (by: number) => {
    const next = addDays(`${month}-15`, by * 30).slice(0, 7);
    setMonth(next);
    void ensure(addDays(`${next}-01`, 31));
  };

  const times = day ? (byDate[day] ?? []) : [];
  const morning = times.filter((s) => isMorning(s.startsAt, timezone));
  const afternoon = times.filter((s) => !isMorning(s.startsAt, timezone));
  const pick = (d: string) => {
    if (!inRange(d) || (fetched(d) && !hasTimes(d))) return;
    setDay(d);
    void ensure(d);
  };

  const slotButton = (s: PublicSlot) => {
    const on = selected?.startsAt === s.startsAt && selected.sessionId === s.sessionId;
    return (
      <button
        key={`${s.startsAt}:${s.sessionId ?? ''}`}
        type="button"
        data-testid="slot"
        aria-pressed={on}
        onClick={() => onSelect(s)}
        className={cn(
          'inline-flex h-11 items-center justify-center whitespace-nowrap rounded-control border px-1.5 text-[14.5px] font-medium transition-colors md:h-9',
          on
            ? 'border-accent bg-accent text-white'
            : 'border-border-strong bg-card text-text hover:border-accent',
        )}
      >
        {timeOf(s.startsAt, timezone)}
      </button>
    );
  };

  const group = (label: string, icon: ReactNode, list: PublicSlot[], empty: string) => (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 text-[13px] font-medium">
        {icon}
        {label}
      </span>
      {list.length ? (
        <div className="grid grid-cols-3 gap-2">{list.map(slotButton)}</div>
      ) : (
        <span className="text-[13px] text-text-3">{empty}</span>
      )}
    </div>
  );

  const arrow = (dir: -1 | 1, disabled: boolean, onClick: () => void, label: string) => (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full text-text-2 hover:bg-card-2 disabled:cursor-not-allowed disabled:opacity-40 md:h-8 md:w-8 md:rounded-control"
    >
      {dir < 0 ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Phones: this week. */}
      <div className="flex flex-col gap-1.5 md:hidden">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-semibold">{monthTitle(day ?? stripStart)}</span>
          <span className="flex">
            {arrow(-1, stripStart <= minDate, () => moveStrip(-7), 'Earlier')}
            {arrow(1, addDays(stripStart, 7) > maxDate, () => moveStrip(7), 'Later')}
          </span>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {stripDays.map((d) => {
            const on = d === day;
            const closed = fetched(d) && !hasTimes(d);
            return (
              <button
                key={d}
                type="button"
                data-testid="day"
                aria-label={dateLong(d)}
                aria-pressed={on}
                disabled={!inRange(d)}
                onClick={() => pick(d)}
                className={cn(
                  'flex min-h-[58px] flex-col items-center gap-[3px] rounded-[10px] pb-1.5 pt-[7px] transition-colors',
                  on ? 'bg-accent text-white' : 'text-text',
                  closed && 'cursor-default',
                )}
              >
                <span
                  className={cn('text-[11px] font-medium', on ? 'text-white/85' : 'text-text-3')}
                >
                  {WEEKDAY_SHORT[weekdayOf(d)]}
                </span>
                <span
                  className={cn(
                    'text-base font-semibold leading-[1.1]',
                    !on && d === today && 'text-accent-text',
                    !on && closed && 'font-medium text-text-3',
                  )}
                >
                  {Number(d.slice(8))}
                </span>
                <span
                  className={cn(
                    'h-[5px] w-[5px] rounded-full',
                    hasTimes(d) ? (on ? 'bg-white' : 'bg-accent') : 'bg-transparent',
                  )}
                />
              </button>
            );
          })}
        </div>
      </div>

      <div className="md:grid md:grid-cols-[290px_minmax(0,1fr)] md:gap-7">
        {/* Computers: the month. */}
        <div className="hidden flex-col gap-2 md:flex">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-semibold">{monthTitle(monthStart)}</span>
            <span className="flex">
              {arrow(-1, monthStart <= minDate, () => moveMonth(-1), 'Earlier')}
              {arrow(
                1,
                addDays(monthStart, 31).slice(0, 7) > maxDate.slice(0, 7),
                () => moveMonth(1),
                'Later',
              )}
            </span>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
              <span key={i} className="text-center text-xs font-semibold text-text-3">
                {w}
              </span>
            ))}
            {cells.map((d) => {
              const inMonth = d.startsWith(month);
              const open = inRange(d) && hasTimes(d);
              const on = d === day;
              return (
                <button
                  key={d}
                  type="button"
                  aria-label={dateLong(d)}
                  aria-pressed={on}
                  disabled={!open}
                  onClick={() => pick(d)}
                  className={cn(
                    'inline-flex h-[34px] items-center justify-center rounded-control text-[13.5px]',
                    on
                      ? 'bg-accent font-semibold text-white'
                      : open
                        ? 'bg-accent-soft font-semibold text-text hover:bg-accent-soft-2'
                        : 'cursor-default text-text-3',
                    !inMonth && 'opacity-45',
                    !on && d === today && 'shadow-[inset_0_0_0_1.5px_var(--accent)]',
                  )}
                >
                  {Number(d.slice(8))}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <p className="flex items-center gap-1.5 text-xs text-text-3">
            <Globe size={14} aria-hidden />
            Times in {timezoneLabel}
          </p>
          {day ? (
            <h2 className="hidden text-[15px] font-semibold md:block">{dateLong(day)}</h2>
          ) : null}
          {error ? (
            <p role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          ) : null}
          {loading && !times.length ? (
            <p aria-live="polite" className="text-[13px] text-text-3">
              Finding open times…
            </p>
          ) : day ? (
            <>
              {group(
                'Morning',
                <Sun size={15} aria-hidden />,
                morning,
                day === today ? 'No morning times left today.' : 'No morning times.',
              )}
              {group(
                'Afternoon',
                <Sunset size={15} aria-hidden />,
                afternoon,
                'No afternoon times.',
              )}
            </>
          ) : null}
          {footer ? <div className="mt-auto hidden pt-2 md:block">{footer}</div> : null}
        </div>
      </div>
    </div>
  );
}
