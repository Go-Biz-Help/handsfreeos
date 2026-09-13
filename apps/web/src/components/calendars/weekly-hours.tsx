'use client';
import { minutesToClock, parseClock, type WeeklyHours } from '@hfos/core';
import { Plus, X } from 'lucide-react';
import { Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { clockLabel } from '@/lib/calendar/time';
import { cn } from '@/lib/utils';

const DAYS: readonly (readonly [number, string, string])[] = [
  [1, 'Mon', 'Monday'],
  [2, 'Tue', 'Tuesday'],
  [3, 'Wed', 'Wednesday'],
  [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'],
  [6, 'Sat', 'Saturday'],
  [0, 'Sun', 'Sunday'],
];
const STARTS = Array.from({ length: 96 }, (_, i) => i * 15);
const ENDS = Array.from({ length: 96 }, (_, i) => (i + 1) * 15);

type Window = WeeklyHours[number];

/** What's wrong with a day's hours, or null: an end before its start, or two stretches that overlap. */
export function dayProblem(windows: readonly Window[]): string | null {
  const sorted = [...windows].sort((a, b) => a.start.localeCompare(b.start));
  for (const w of sorted)
    if (parseClock(w.end) <= parseClock(w.start)) return 'Ends before it starts.';
  for (let i = 1; i < sorted.length; i++)
    if (parseClock(sorted[i]!.start) < parseClock(sorted[i - 1]!.end))
      return 'These hours overlap.';
  return null;
}

export function hoursProblem(value: WeeklyHours): string | null {
  for (const [day] of DAYS) {
    const problem = dayProblem(value.filter((h) => h.day === day));
    if (problem) return problem;
  }
  return null;
}

/**
 * Weekly hours, Monday first: a switch per day, one or more stretches (the + adds a second one, for a
 * lunch break), no stretch crossing midnight. Used for people, services, resources and calendars.
 */
export function WeeklyHoursEditor({
  value,
  onChange,
  disabled,
  idPrefix = 'hours',
}: {
  value: WeeklyHours;
  onChange: (next: WeeklyHours) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const setDay = (day: number, windows: Window[]) =>
    onChange(
      [...value.filter((h) => h.day !== day), ...windows].sort(
        (a, b) => a.day - b.day || a.start.localeCompare(b.start),
      ),
    );

  return (
    <div data-testid={`${idPrefix}-editor`}>
      {DAYS.map(([day, short, long]) => {
        const windows = value
          .filter((h) => h.day === day)
          .sort((a, b) => a.start.localeCompare(b.start));
        const on = windows.length > 0;
        const problem = dayProblem(windows);
        const update = (i: number, patch: Partial<Window>) =>
          setDay(
            day,
            windows.map((w, j) => (j === i ? { ...w, ...patch } : w)),
          );
        const addStretch = () => {
          const last = windows[windows.length - 1];
          const from = last ? Math.min(parseClock(last.end) + 60, 1380) : 540;
          const to = Math.min(from + 240, 1440);
          setDay(day, [...windows, { day, start: minutesToClock(from), end: minutesToClock(to) }]);
        };
        return (
          <div
            key={day}
            className="flex items-start gap-3 border-t border-border py-1.5 first:border-t-0"
            data-testid={`${idPrefix}-day-${short.toLowerCase()}`}
          >
            <Switch
              checked={on}
              disabled={disabled}
              label={`${long} ${on ? 'on' : 'off'}`}
              className="mt-[7px]"
              onChange={(next) => setDay(day, next ? [{ day, start: '09:00', end: '17:00' }] : [])}
            />
            <span className="mt-[6px] w-9 flex-none text-[13px] font-medium">{short}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              {on ? (
                windows.map((w, i) => (
                  <span key={`${w.start}-${i}`} className="flex flex-wrap items-center gap-1.5">
                    <Select
                      selectSize="sm"
                      className="h-[30px] w-[112px] text-[13px]"
                      aria-label={`${long} start${i ? ` ${i + 1}` : ''}`}
                      value={String(parseClock(w.start))}
                      disabled={disabled}
                      onChange={(e) => update(i, { start: minutesToClock(Number(e.target.value)) })}
                    >
                      {STARTS.map((m) => (
                        <option key={m} value={m}>
                          {clockLabel(m)}
                        </option>
                      ))}
                    </Select>
                    <span className="text-text-3">–</span>
                    <Select
                      selectSize="sm"
                      className="h-[30px] w-[112px] text-[13px]"
                      aria-label={`${long} end${i ? ` ${i + 1}` : ''}`}
                      value={String(parseClock(w.end))}
                      disabled={disabled}
                      onChange={(e) => update(i, { end: minutesToClock(Number(e.target.value)) })}
                    >
                      {ENDS.map((m) => (
                        <option key={m} value={m}>
                          {m === 1440 ? 'Midnight' : clockLabel(m)}
                        </option>
                      ))}
                    </Select>
                    {i > 0 ? (
                      <button
                        type="button"
                        aria-label={`Remove ${long} hours ${i + 1}`}
                        disabled={disabled}
                        onClick={() =>
                          setDay(
                            day,
                            windows.filter((_, j) => j !== i),
                          )
                        }
                        className="flex h-7 w-7 items-center justify-center rounded-control text-text-3 hover:bg-card-2 hover:text-text"
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </button>
                    ) : null}
                  </span>
                ))
              ) : (
                <span className="mt-[6px] text-[13px] text-text-3">Off</span>
              )}
              {problem ? (
                <span role="alert" className="text-xs text-danger-text">
                  {problem}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              title="Add hours"
              aria-label={`Add ${long} hours`}
              disabled={disabled || windows.length >= 6}
              onClick={addStretch}
              className={cn(
                'mt-[1px] flex h-7 w-7 flex-none items-center justify-center rounded-control text-text-2 hover:bg-card-2 hover:text-text disabled:opacity-40',
              )}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
