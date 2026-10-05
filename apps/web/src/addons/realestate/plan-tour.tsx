'use client';
/**
 * Plan a tour (board 17, design/realestate/PlanTour.dc.html): the day and start, the calendar, the homes in the
 * order they'll be seen, and whether the clients are invited. Without a signed buyer agreement that covers the day
 * it's refused with the rule's own words; an owner or admin can let that one tour through with a reason, kept in
 * the deal's history with their name. The calendar's warnings (outside hours, someone busy) are shown to accept.
 */
import { localInstant, minutesToClock, TIME_OPTIONS, todayIn } from '@hfos/core';
import { defaultTourMinutes, MAX_TOUR_STOPS } from '@hfos/core/addons/realestate/tours';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import { street } from './buyer-bits';
import type { Home, TourList } from './types';

export interface CalendarChoice {
  readonly id: string;
  readonly name: string;
}

const LENGTHS = [30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480] as const;
const clockOf = (m: number) => {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${h % 12 || 12}:${String(mm).padStart(2, '0')}`;
};

export function PlanTourDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  timeZone,
  homes,
  agreement,
  canExcept,
  calendars,
  team,
  clients,
  firstHome,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
  homes: readonly Home[];
  agreement: TourList['agreement'];
  /** Owners and admins (Approve exceptions) may let a tour through. */
  canExcept: boolean;
  calendars: readonly CalendarChoice[];
  team: readonly { readonly userId: string; readonly name: string; readonly main: boolean }[];
  /** The clients' first names, for the invite line: "Linh and Tuan". */
  clients: string;
  /** A home to start with (from a home's own dialog). */
  firstHome?: string | null;
}) {
  const router = useRouter();
  const choosable = homes.filter((h) => h.status !== 'removed' && h.status !== 'passed');
  const [date, setDate] = useState(() => todayIn(timeZone));
  const [time, setTime] = useState(600);
  const [calendarId, setCalendarId] = useState('');
  const [agentId, setAgentId] = useState(team.find((t) => t.main)?.userId ?? '');
  const [picked, setPicked] = useState<string[]>([]);
  const [length, setLength] = useState<number | null>(null);
  const [invite, setInvite] = useState(true);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly { message: string }[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Fresh each time it opens, with the home it was opened from.
  const [shown, setShown] = useState(false);
  if (open && !shown) {
    setShown(true);
    setPicked(firstHome && choosable.some((h) => h.id === firstHome) ? [firstHome] : []);
    setRefusal(null);
    setWarnings(null);
    setErrors({});
    setReason('');
  }
  if (!open && shown) setShown(false);
  const blocked = refusal ?? (agreement.ok ? null : agreement.words);
  const minutes = length ?? defaultTourMinutes(Math.max(1, picked.length));
  const each = picked.length ? Math.floor(minutes / picked.length) : 0;
  const byId = useMemo(() => new Map(homes.map((h) => [h.id, h])), [homes]);
  const move = (i: number, by: -1 | 1) => {
    const next = [...picked];
    const [x] = next.splice(i, 1);
    next.splice(i + by, 0, x!);
    setPicked(next);
  };
  const submit = async () => {
    if (!picked.length) return setErrors({ homeIds: 'Pick at least one home.' });
    if (blocked && canExcept && !reason.trim())
      return setErrors({ reason: 'Say why this tour can go ahead without it.' });
    setBusy(true);
    setErrors({});
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/realestate.tour.plan', {
          body: {
            workspaceId,
            dealId,
            homeIds: picked,
            startsAt: new Date(localInstant(date, minutesToClock(time), timeZone)).toISOString(),
            durationMinutes: minutes,
            calendarId: calendarId || undefined,
            agentUserId: agentId || undefined,
            note: note.trim() || undefined,
            notifyClient: invite,
            acknowledgeWarnings: !!warnings,
            exception: blocked && canExcept ? { reason: reason.trim() } : undefined,
          },
        }),
      );
      toast.success(
        out.exception
          ? 'Planned, as an exception. It’s in the deal’s history with your name.'
          : 'Planned. It’s on the calendar.',
      );
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'needs_confirmation') {
        setWarnings((e.details as { warnings?: { message: string }[] })?.warnings ?? []);
      } else if (
        e instanceof ApiError &&
        (e.rule === 'buyer_agreement_needed' || e.rule === 'buyer_agreement_expired')
      ) {
        setRefusal(e.message);
      } else {
        const fe = fieldErrors(e);
        if (Object.keys(fe).length) setErrors(fe);
        toast.error(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Plan a tour"
        className="max-h-[92dvh] w-[min(680px,calc(100vw-32px))] overflow-y-auto"
      >
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          data-testid="plan-tour"
        >
          {blocked ? (
            <Callout tone="danger" data-testid="tour-refused">
              {blocked}
            </Callout>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="tour-date">Day and start</Label>
              <div className="flex gap-2">
                <Input
                  id="tour-date"
                  type="date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setRefusal(null);
                  }}
                  className="min-w-0 flex-1"
                />
                <Select
                  aria-label="Start time"
                  value={time}
                  onChange={(e) => setTime(Number(e.target.value))}
                  className="w-[120px]"
                >
                  {TIME_OPTIONS.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <Field label="Calendar" htmlFor="tour-calendar">
              <Select
                id="tour-calendar"
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
              >
                <option value="">The one for tours</option>
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {team.length > 1 ? (
              <Field label="Who leads it" htmlFor="tour-agent">
                <Select
                  id="tour-agent"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  {team.map((t) => (
                    <option key={t.userId} value={t.userId}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="How long" htmlFor="tour-length">
              <Select
                id="tour-length"
                value={length ?? ''}
                onChange={(e) => setLength(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Half an hour a home</option>
                {LENGTHS.map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} min` : `${m / 60} h`.replace('.5 h', ' h 30 min')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div>
            <Label>Homes, in order</Label>
            {picked.length ? (
              <ol className="space-y-1.5">
                {picked.map((id, i) => {
                  const h = byId.get(id);
                  const at = time + i * each;
                  return (
                    <li
                      key={id}
                      className="flex items-center gap-2 rounded-control border border-border px-3 py-2 text-[13.5px]"
                    >
                      <span className="w-4 text-text-3">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate font-semibold">
                        {h ? street(h.address) : 'A home'}
                      </span>
                      <span className="text-[12.5px] text-text-2">
                        {clockOf(at)} · {each} min
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Earlier"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Later"
                        disabled={i === picked.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Take it off the tour"
                        onClick={() => setPicked(picked.filter((x) => x !== id))}
                      >
                        <X className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {choosable.some((h) => !picked.includes(h.id)) && picked.length < MAX_TOUR_STOPS ? (
              <Select
                aria-label="Add a home"
                className="mt-2"
                value=""
                onChange={(e) => e.target.value && setPicked([...picked, e.target.value])}
                data-testid="tour-add-home"
              >
                <option value="">{picked.length ? 'Add another home…' : 'Pick a home…'}</option>
                {choosable
                  .filter((h) => !picked.includes(h.id))
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.address}
                    </option>
                  ))}
              </Select>
            ) : choosable.length === 0 ? (
              <Hint>Add the homes to see on the deal’s Homes page first.</Hint>
            ) : null}
            {errors.homeIds ? (
              <p role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
                {errors.homeIds}
              </p>
            ) : null}
          </div>
          {clients ? (
            <label className="flex items-center gap-2.5 text-[13.5px]">
              <Switch checked={invite} onChange={setInvite} label="Invite the clients" />
              Invite {clients}, with reminders
            </label>
          ) : null}
          <Field label="Note (optional)" htmlFor="tour-note" error={errors.note}>
            <Input id="tour-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {blocked && canExcept ? (
            <div className="rounded-menu bg-card-2 p-3.5">
              <Field
                label="Let this tour through as an exception"
                htmlFor="tour-reason"
                hint="Kept in the deal’s history with your name."
                error={errors.reason}
              >
                <Input
                  id="tour-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Signed on paper at the office; it’s being scanned today."
                  invalid={!!errors.reason}
                  data-testid="tour-reason"
                />
              </Field>
            </div>
          ) : null}
          {warnings ? (
            <Callout tone="warning">
              {warnings.length
                ? warnings.map((w) => w.message).join(' ')
                : 'The calendar has a warning about this time.'}{' '}
              Plan it anyway?
            </Callout>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={!!blocked && !canExcept}
              data-testid="tour-submit"
            >
              {blocked && canExcept
                ? 'Let it through and plan the tour'
                : warnings
                  ? 'Plan it anyway'
                  : 'Plan the tour'}
            </Button>
          </div>
          {blocked && !canExcept ? (
            <Hint className="-mt-2 text-right">
              Ask an owner or admin of this business if this tour has to go ahead before then.
            </Hint>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
