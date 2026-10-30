'use client';
import {
  isWebinarCalendar,
  localInstant,
  minutesToClock,
  todayIn,
  WEBINAR_REPEATS,
  webinarRepeatDefault,
  webinarRepeatLabel,
  webinarRepeatMax,
  type CalendarConfig,
  type WebinarRepeat,
} from '@hfos/core';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { seatsLabel } from '@/components/booking/format';
import { useCan } from '@/components/shell/workspace-shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { CalendarSummary } from '@/lib/api/types';
import { fmtAt, fmtLength, timeOptionsWith, zoneLabel } from '@/lib/calendar/time';
import { calendarConfig } from './config-cache';

/** The most people a webinar holds at once (WEBINAR_MAX_PEOPLE), and so the most seats it takes. */
const MAX_SEATS = 500;
const LENGTHS = [30, 45, 60, 90, 120, 180];

export interface ScheduledWebinar {
  readonly appointmentId: string;
  readonly startsAt: string;
}

/**
 * New webinar: a name, the date and time, how long, who presents, the seats, and whether it repeats (every week,
 * every 2 weeks or every month). It goes on the business's webinar calendar; when there's none, webinar.schedule
 * makes one ("Webinars", with you presenting), so nobody has to set a calendar up first.
 */
export function WebinarDialog({
  open,
  onOpenChange,
  workspaceId,
  timeZone,
  people,
  myUserId,
  calendars,
  date: startDate,
  onScheduled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  timeZone: string;
  people: readonly { userId: string; fullName: string }[];
  myUserId: string;
  calendars: readonly CalendarSummary[];
  date?: string | null;
  onScheduled: (result: ScheduledWebinar) => void;
}) {
  const canManage = useCan('calendars.manage');
  /** The business's webinar calendars with their settings, active ones first; null while they load. */
  const [found, setFound] = useState<{ id: string; name: string; config: CalendarConfig }[] | null>(
    null,
  );
  const [calendarId, setCalendarId] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(startDate ?? todayIn(timeZone));
  const [time, setTime] = useState(12 * 60);
  const [duration, setDuration] = useState<number | null>(null);
  const [userId, setUserId] = useState('');
  const [seats, setSeats] = useState<number | null>(null);
  const [repeat, setRepeat] = useState<WebinarRepeat>('none');
  const [times, setTimes] = useState<number | null>(null);
  /** A 409 needs_confirmation: what to look at before Publish anyway. */
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sessions calendars carry the Event label; the webinar ones among them have a HandsFreeOS video place.
  const sessionsKey = calendars
    .filter((c) => c.status !== 'archived' && c.labels.tags.includes('event'))
    .map((c) => c.id)
    .join();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const wanted = calendars.filter((c) => sessionsKey.split(',').includes(c.id));
    void Promise.all(
      wanted.map((c) =>
        calendarConfig(workspaceId, c.id).then((config) => ({ id: c.id, name: c.name, config })),
      ),
    )
      .then((list) => {
        if (cancelled) return;
        const active = new Set(wanted.filter((c) => c.status === 'active').map((c) => c.id));
        const webinars = list
          .filter((c) => isWebinarCalendar(c.config))
          .sort((a, b) => Number(active.has(b.id)) - Number(active.has(a.id)));
        setFound(webinars);
        setCalendarId((current) =>
          webinars.some((c) => c.id === current) ? current : (webinars[0]?.id ?? ''),
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
    // `calendars` is read through the sessions calendars' ids (sessionsKey).
  }, [open, workspaceId, sessionsKey]);

  const current = found?.find((c) => c.id === calendarId) ?? null;
  const none = found !== null && found.length === 0;
  const team = current?.config.team.members.map((m) => m.userId) ?? [];
  const nameOf = (id: string) => people.find((p) => p.userId === id)?.fullName ?? 'Someone';
  const host =
    userId && team.includes(userId)
      ? userId
      : team.includes(myUserId)
        ? myUserId
        : team.length === 1
          ? team[0]!
          : '';
  const length = duration ?? current?.config.durations.minutes[0] ?? 60;
  const lengths = [...new Set([...LENGTHS, length])].sort((a, b) => a - b);
  const seatCount = Math.min(MAX_SEATS, seats ?? current?.config.capacity.seats ?? MAX_SEATS);
  const every = repeat === 'none' ? null : repeat;
  const count = every ? Math.min(times ?? webinarRepeatDefault(every), webinarRepeatMax(every)) : 1;
  const blocked = none && !canManage;

  const change =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setWarning(null);
      setError(null);
    };

  async function schedule() {
    if (!title.trim()) return setError('Give the webinar a name people will see.');
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/webinar.schedule', {
          body: {
            workspaceId,
            ...(calendarId ? { calendarId } : {}),
            title: title.trim(),
            startsAt: new Date(localInstant(date, minutesToClock(time), timeZone)).toISOString(),
            durationMinutes: length,
            ...(host ? { userIds: [host] } : {}),
            seats: seatCount,
            repeat,
            ...(every ? { times: count } : {}),
            acknowledgeWarnings: !!warning,
          },
        }),
      );
      const booked = out.appointmentIds.length;
      const startsAt = new Date(localInstant(date, minutesToClock(time), timeZone)).toISOString();
      const what =
        booked === 1
          ? `${title.trim()} for ${fmtAt(startsAt, timeZone)}`
          : `${booked} dates of ${title.trim()}, from ${fmtAt(startsAt, timeZone)}`;
      const skipped = out.skipped.length
        ? ` ${out.skipped.length === 1 ? '1 date didn’t fit' : `${out.skipped.length} dates didn’t fit`}: ${out.skipped[0]!.reason}`
        : '';
      const made = out.calendarMade ? ` It’s on a new ${out.calendarName} calendar.` : '';
      toast.success(`Scheduled ${what}, with ${seatsLabel(seatCount)}.${made}${skipped}`);
      setWarning(null);
      onScheduled({ appointmentId: out.appointmentIds[0]!, startsAt });
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'needs_confirmation') setWarning(e.message);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New webinar"
        className="max-h-[92vh] w-[min(540px,calc(100vw-24px))] overflow-y-auto"
      >
        <div className="mt-3.5 flex flex-col gap-2.5" data-testid="webinar-dialog">
          <Field label="Webinar name" htmlFor="webinar-title">
            <Input
              id="webinar-title"
              value={title}
              maxLength={200}
              placeholder="Live demo"
              onChange={(e) => change(setTitle)(e.target.value)}
              data-testid="webinar-title"
            />
          </Field>
          {found && found.length > 1 ? (
            <Field label="Calendar" htmlFor="webinar-calendar">
              <Select
                id="webinar-calendar"
                value={calendarId}
                onChange={(e) => {
                  setSeats(null);
                  setDuration(null);
                  change(setCalendarId)(e.target.value);
                }}
              >
                {found.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2.5">
            <Field label="Date" htmlFor="webinar-date" className="min-w-0">
              <Input
                id="webinar-date"
                type="date"
                value={date}
                onChange={(e) => e.target.value && change(setDate)(e.target.value)}
              />
            </Field>
            <Field label="Start" htmlFor="webinar-start" className="min-w-0">
              <Select
                id="webinar-start"
                value={String(time)}
                onChange={(e) => change(setTime)(Number(e.target.value))}
              >
                {timeOptionsWith(time).map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Length" htmlFor="webinar-length" className="min-w-0">
              <Select
                id="webinar-length"
                value={String(length)}
                onChange={(e) => change(setDuration)(Number(e.target.value))}
              >
                {lengths.map((m) => (
                  <option key={m} value={m}>
                    {fmtLength(m)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-2.5">
            <Field label="Presenter" htmlFor="webinar-host" className="min-w-0">
              <Select
                id="webinar-host"
                value={none ? myUserId : host}
                disabled={none || team.length < 2}
                onChange={(e) => change(setUserId)(e.target.value)}
              >
                {none ? (
                  <option value={myUserId}>{nameOf(myUserId)}</option>
                ) : (
                  <>
                    {host ? null : <option value="">Let the calendar choose</option>}
                    {team.map((u) => (
                      <option key={u} value={u}>
                        {nameOf(u)}
                      </option>
                    ))}
                  </>
                )}
              </Select>
            </Field>
            <Field label="Seats" htmlFor="webinar-seats" className="min-w-0">
              <Input
                id="webinar-seats"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_SEATS}
                value={String(seatCount)}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (n >= 1) change(setSeats)(Math.min(MAX_SEATS, n));
                }}
                data-testid="webinar-seats"
              />
            </Field>
          </div>
          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-2.5">
            <Field label="Repeats" htmlFor="webinar-repeat" className="min-w-0">
              <Select
                id="webinar-repeat"
                value={repeat}
                onChange={(e) => change(setRepeat)(e.target.value as WebinarRepeat)}
                data-testid="webinar-repeat"
              >
                {WEBINAR_REPEATS.map((k) => (
                  <option key={k} value={k}>
                    {webinarRepeatLabel(k, date)}
                  </option>
                ))}
              </Select>
            </Field>
            {every ? (
              <Field label="How many" htmlFor="webinar-times" className="min-w-0">
                <Select
                  id="webinar-times"
                  value={String(count)}
                  onChange={(e) => change(setTimes)(Number(e.target.value))}
                  data-testid="webinar-times"
                >
                  {Array.from({ length: webinarRepeatMax(every) - 1 }, (_, i) => i + 2).map((n) => (
                    <option key={n} value={n}>
                      {n} webinars
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          <p className="text-[12.5px] leading-[1.45] text-text-3" data-testid="webinar-where">
            {blocked
              ? 'This business has no webinar calendar yet. Ask an owner or admin to schedule the first webinar, or to add a Webinar calendar in Settings → Calendars.'
              : none
                ? 'It runs on HandsFreeOS video. A Webinars calendar is made for it, with you presenting, and people save a seat from your booking page or the webinar’s own link.'
                : `It runs on HandsFreeOS video${current && found!.length === 1 ? `, on ${current.name}` : ''}. People save a seat from your booking page or the webinar’s own link.`}{' '}
            Times are {zoneLabel(timeZone)}.
          </p>
          {warning ? (
            <div
              className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] leading-[1.45] text-warning-text"
              data-testid="webinar-warning"
            >
              <AlertTriangle className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
              <span>{warning}</span>
            </div>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text"
            >
              <CircleAlert className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={found === null || blocked}
            onClick={() => void schedule()}
            data-testid="webinar-schedule"
          >
            {warning ? 'Publish anyway' : every ? `Schedule ${count} webinars` : 'Schedule webinar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
