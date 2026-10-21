'use client';
import { localInstant, minutesToClock, type WeeklyHours } from '@hfos/core';
import { CalendarOff, Globe, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { hoursProblem, WeeklyHoursEditor } from '@/components/calendars/weekly-hours';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  CalendarConnection,
  MeetingConnection,
  TeamSchedule,
  TimeOffSpan,
} from '@/lib/api/types';
import {
  dateOf,
  fmtMonthDay,
  fmtRange,
  fmtTime,
  TIME_OPTIONS,
  todayIn,
  zoneLabel,
} from '@/lib/calendar/time';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CalendarConnectionCard } from './calendar-connection-card';
import { MeetingConnectionCard } from './meeting-connection-card';
import { SettingAnchor } from './setting-anchor';

const RESULT: Record<string, { tone: 'success' | 'info' | 'error'; text: string }> = {
  connected: {
    tone: 'success',
    text: 'Connected. Your busy times are checked from now on, and appointments show there as events.',
  },
  cancelled: { tone: 'info', text: 'Sign-in cancelled. Nothing was connected.' },
  missing_permissions: {
    tone: 'error',
    text: 'Some permissions were left unticked, so it didn’t connect. Try again and allow everything asked.',
  },
  failed: { tone: 'error', text: 'That calendar didn’t connect. Try again in a minute.' },
};

/** A time zone chip: "Central Time". */
export function ZoneChip({ timeZone }: { timeZone: string }) {
  return (
    <span
      className="inline-flex h-[26px] flex-none items-center gap-1.5 whitespace-nowrap rounded-[6px] bg-card-2 px-2.5 text-xs font-medium text-text-2"
      data-testid="zone-chip"
      title={timeZone}
    >
      <Globe className="h-3.5 w-3.5" strokeWidth={1.5} />
      {zoneLabel(timeZone)}
    </span>
  );
}

/** "Oct 12–16 · All day", "Oct 12 · 9:00 AM–1:00 PM". */
export function timeOffLabel(t: TimeOffSpan, timeZone: string): string {
  if (t.allDay) {
    const a = dateOf(t.startsAt, timeZone);
    const b = dateOf(Date.parse(t.endsAt) - 1, timeZone);
    if (a === b) return `${fmtMonthDay(a)} · All day`;
    const sameMonth = a.slice(0, 7) === b.slice(0, 7);
    return `${fmtMonthDay(a)}–${sameMonth ? Number(b.slice(8)) : fmtMonthDay(b)} · All day`;
  }
  const a = dateOf(t.startsAt, timeZone);
  const b = dateOf(t.endsAt, timeZone);
  if (a === b) return `${fmtMonthDay(a)} · ${fmtRange(t.startsAt, t.endsAt, timeZone)}`;
  return `${fmtMonthDay(a)}, ${fmtTime(t.startsAt, timeZone)} – ${fmtMonthDay(b)}, ${fmtTime(t.endsAt, timeZone)}`;
}

/**
 * Settings → My calendar: weekly hours with breaks, time off, and the Google or Outlook connection. Owners
 * and admins see the same page for a teammate (without connecting on their behalf).
 */
export function MyCalendar({
  workspaceId,
  person,
  connection,
  meeting,
  isSelf,
  canManage,
  result,
  meetingResult,
}: {
  workspaceId: string;
  person: TeamSchedule;
  connection: CalendarConnection | null;
  meeting: MeetingConnection | null;
  isSelf: boolean;
  canManage: boolean;
  result: string | null;
  meetingResult: string | null;
}) {
  const router = useRouter();
  useLiveRefresh(['schedule', 'calendar_connection', 'meeting_connection']);
  const tz = person.timezone;
  const firstName = person.fullName.split(/\s+/)[0] || person.fullName;

  const told = useRef(false);
  useEffect(() => {
    if (!result || told.current) return;
    told.current = true;
    const r = RESULT[result] ?? RESULT.failed!;
    if (r.tone === 'success') toast.success(r.text);
    else if (r.tone === 'error') toast.error(r.text);
    else toast(r.text);
    router.replace(`/app/w/${workspaceId}/settings/my-calendar`, { scroll: false });
  }, [result, router, workspaceId]);

  // Local edits to the weekly hours, reset whenever the saved hours change.
  const savedKey = JSON.stringify(person.weekly);
  const [hours, setHours] = useState({ key: savedKey, value: person.weekly as WeeklyHours });
  const current = hours.key === savedKey ? hours : { key: savedKey, value: person.weekly };
  const dirty = JSON.stringify(current.value) !== savedKey;
  const problem = hoursProblem(current.value);
  const [saving, setSaving] = useState(false);

  async function saveHours() {
    setSaving(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/schedule.set', {
          body: {
            workspaceId,
            ownerKind: 'user',
            ownerId: person.userId,
            weekly: current.value,
          },
        }),
      );
      toast.success(isSelf ? 'Your hours are saved.' : `${firstName}’s hours are saved.`);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const [adding, setAdding] = useState(false);
  const timeOff = [...person.timeOff].sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  async function removeTimeOff(t: TimeOffSpan) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/time_off.remove', {
          body: { workspaceId, exceptionId: t.id },
        }),
      );
      toast.success('Time off removed.');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Card className="p-5 md:px-6 md:py-5" data-testid="my-calendar">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {isSelf ? 'My calendar' : `${person.fullName}’s calendar`}
          </h2>
          <p className="mt-1 text-[13px] text-text-2">
            {isSelf
              ? 'Your hours, time off and calendar connection. Everyone sets their own.'
              : `Their hours and time off. Only ${firstName} can connect their Google or Outlook calendar.`}
          </p>
        </div>
        <ZoneChip timeZone={tz} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <SettingAnchor
          as="section"
          row
          setting="my_calendar.weekly_hours"
          aria-labelledby="weekly-hours"
        >
          <div id="weekly-hours" className="mb-1 text-[13px] font-medium">
            Weekly hours
          </div>
          <WeeklyHoursEditor
            value={current.value}
            onChange={(value) => setHours({ key: savedKey, value })}
            idPrefix="my-hours"
          />
          <p className="mt-1.5 text-[12.5px] text-text-3">
            {person.defaultHours && !dirty ? 'No hours saved yet, so weekdays 9 to 5 apply. ' : ''}
            Customers can only book inside these hours. Use + for a lunch break.
          </p>
          {dirty ? (
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHours({ key: savedKey, value: person.weekly })}
              >
                Undo
              </Button>
              <Button
                size="sm"
                loading={saving}
                disabled={!!problem}
                onClick={() => void saveHours()}
                data-testid="hours-save"
              >
                Save hours
              </Button>
            </div>
          ) : null}
        </SettingAnchor>

        <div className="flex flex-col gap-4">
          <SettingAnchor as="section" row setting="my_calendar.time_off" data-testid="time-off">
            <div className="mb-0.5 flex items-center justify-between">
              <span className="text-[13px] font-medium">Time off</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAdding(true)}
                data-testid="time-off-add"
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                Add time off
              </Button>
            </div>
            {timeOff.length === 0 ? (
              <p className="border-t border-border py-3 text-[13px] text-text-3">
                No time off in the next 60 days.
              </p>
            ) : (
              <ul>
                {timeOff.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center gap-2.5 border-t border-border py-2"
                    data-testid="time-off-row"
                  >
                    <CalendarOff className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[13px] font-medium">{timeOffLabel(t, tz)}</span>
                      <span className="truncate text-xs text-text-3">
                        {[t.kind === 'available' ? 'Extra open time' : null, t.note]
                          .filter(Boolean)
                          .join(' · ') || 'Time off'}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove time off ${timeOffLabel(t, tz)}`}
                      onClick={() => void removeTimeOff(t)}
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </SettingAnchor>

          <SettingAnchor as="section" row setting="my_calendar.connection">
            <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              Calendar connection
            </div>
            <CalendarConnectionCard
              workspaceId={workspaceId}
              connection={connection}
              isSelf={isSelf}
              canManage={canManage}
              firstName={firstName}
            />
          </SettingAnchor>

          <SettingAnchor as="section" row setting="my_calendar.video">
            <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              Video meetings
            </div>
            <MeetingConnectionCard
              workspaceId={workspaceId}
              connection={meeting}
              isSelf={isSelf}
              canManage={canManage}
              firstName={firstName}
              result={meetingResult}
            />
          </SettingAnchor>
        </div>
      </div>

      <AddTimeOffDialog
        workspaceId={workspaceId}
        userId={person.userId}
        timeZone={tz}
        open={adding}
        onOpenChange={setAdding}
      />
    </Card>
  );
}

function AddTimeOffDialog({
  workspaceId,
  userId,
  timeZone,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  userId: string;
  timeZone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const today = todayIn(timeZone);
  const [allDay, setAllDay] = useState(true);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [start, setStart] = useState(9 * 60);
  const [end, setEnd] = useState(12 * 60);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const invalid = allDay ? !from || !to || to < from : !from || end <= start;

  async function save() {
    setBusy(true);
    try {
      const when = allDay
        ? { startDate: from, endDate: to }
        : {
            startsAt: new Date(localInstant(from, minutesToClock(start), timeZone)).toISOString(),
            endsAt: new Date(localInstant(from, minutesToClock(end), timeZone)).toISOString(),
          };
      unwrap(
        await apiBrowser().POST('/v1/commands/time_off.add', {
          body: {
            workspaceId,
            ownerKind: 'user',
            ownerId: userId,
            kind: 'unavailable',
            ...when,
            note: note.trim() || null,
          },
        }),
      );
      toast.success('Time off added. Nobody can book those times.');
      onOpenChange(false);
      setNote('');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add time off"
        description={`Nobody can book these times. Times are ${zoneLabel(timeZone)}.`}
      >
        <div className="mt-4 flex flex-col gap-3.5">
          <label className="flex items-center justify-between gap-3 text-[13px] font-medium">
            All day
            <Switch checked={allDay} onChange={setAllDay} label="All day" />
          </label>
          {allDay ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="From" htmlFor="off-from">
                <Input
                  id="off-from"
                  type="date"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    if (e.target.value > to) setTo(e.target.value);
                  }}
                />
              </Field>
              <Field label="To" htmlFor="off-to">
                <Input
                  id="off-to"
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-3">
              <Field label="Date" htmlFor="off-date">
                <Input
                  id="off-date"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field label="From" htmlFor="off-start">
                <Select
                  id="off-start"
                  value={String(start)}
                  onChange={(e) => setStart(Number(e.target.value))}
                >
                  {TIME_OPTIONS.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To" htmlFor="off-end">
                <Select
                  id="off-end"
                  value={String(end)}
                  onChange={(e) => setEnd(Number(e.target.value))}
                >
                  {TIME_OPTIONS.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          <Field label="Note (optional)" htmlFor="off-note">
            <Input
              id="off-note"
              value={note}
              maxLength={500}
              placeholder="Vacation"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={invalid}
            onClick={() => void save()}
            data-testid="time-off-save"
          >
            Add time off
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
