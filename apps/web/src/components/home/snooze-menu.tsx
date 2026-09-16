'use client';
import { addDays, localDateOf, localInstant } from '@hfos/core';
import { AlarmClock, CalendarClock, CalendarDays, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { AttentionItem } from '@/lib/api/types';
import { zoneLabel } from '@/lib/calendar/time';
import { SheetRow } from './attention-bits';
import { useAttentionEnv } from './attention-context';
import { SNOOZE_MAX_DAYS, snoozeChoices, type SnoozeChoice } from './attention-words';

const ICONS: Readonly<Record<SnoozeChoice['key'], LucideIcon>> = {
  hour: AlarmClock,
  evening: Moon,
  tomorrow: Sun,
  next_week: CalendarDays,
};

/** The choices as of the moment the menu opened (it mounts on open). */
function useChoices(): SnoozeChoice[] {
  const { timeZone } = useAttentionEnv();
  const [choices] = useState(() => snoozeChoices(timeZone, Date.now()));
  return choices;
}

/** Snooze in the ⋯ menu: 1 hour, This evening, Tomorrow morning, Next week, Pick a time. */
export function SnoozeMenuItems({ item }: { item: AttentionItem }) {
  const env = useAttentionEnv();
  const choices = useChoices();
  return (
    <>
      {choices.map((c) => {
        const Icon = ICONS[c.key];
        return (
          <DropdownMenuItem
            key={c.key}
            data-testid={`snooze-${c.key}`}
            onSelect={() => env.act.snooze(item, c.until)}
          >
            <Icon className="h-4 w-4 text-text-2" strokeWidth={1.5} />
            <span>{c.label}</span>
            <span className="ml-auto pl-3 text-xs text-text-3">{c.hint}</span>
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuItem data-testid="snooze-pick" onSelect={() => env.act.pickTime(item)}>
        <CalendarClock className="h-4 w-4 text-text-2" strokeWidth={1.5} />
        <span>Pick a time…</span>
        <span className="ml-auto pl-3 text-xs text-text-3">Up to 30 days</span>
      </DropdownMenuItem>
    </>
  );
}

/** The same choices as 52 px rows in a phone's bottom sheet. */
export function SnoozeRows({
  onPick,
  onPickTime,
}: {
  onPick: (until: number) => void;
  onPickTime: () => void;
}) {
  const choices = useChoices();
  return (
    <>
      {choices.map((c) => (
        <SheetRow
          key={c.key}
          icon={ICONS[c.key]}
          label={c.label}
          hint={c.hint}
          onClick={() => onPick(c.until)}
          testId={`snooze-${c.key}`}
        />
      ))}
      <SheetRow
        icon={CalendarClock}
        label="Pick a time…"
        hint="Up to 30 days"
        onClick={onPickTime}
        testId="snooze-pick"
      />
    </>
  );
}

/** "Snooze until": a day and a time in the business's time zone, up to 30 days ahead. */
export function PickTimeDialog({
  item,
  open,
  onOpenChange,
}: {
  item: AttentionItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const env = useAttentionEnv();
  const [bounds] = useState(() => {
    const today = localDateOf(Date.now(), env.timeZone);
    return { min: today, max: addDays(today, SNOOZE_MAX_DAYS), tomorrow: addDays(today, 1) };
  });
  const [date, setDate] = useState(bounds.tomorrow);
  const [time, setTime] = useState('09:00');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!date || !time) return setError('Pick a day and a time.');
    const until = localInstant(date, time, env.timeZone);
    const now = Date.now();
    if (!(until > now)) return setError('Pick a time later than now.');
    if (until > now + SNOOZE_MAX_DAYS * 86_400_000) return setError('Snooze for 30 days at most.');
    onOpenChange(false);
    env.act.snooze(item, until);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Snooze until"
        description={item.title}
        className="w-[min(360px,calc(100vw-32px))] p-5"
      >
        <form onSubmit={submit} noValidate data-testid="snooze-pick-form">
          <div className="mt-3.5 grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-2.5">
            <Field label="Day" htmlFor="snooze-day">
              <Input
                id="snooze-day"
                type="date"
                value={date}
                min={bounds.min}
                max={bounds.max}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Time" htmlFor="snooze-time">
              <Input
                id="snooze-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </Field>
          </div>
          {error ? (
            <p role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
              {error}
            </p>
          ) : (
            <p className="mt-1.5 text-[12.5px] text-text-3">
              Up to 30 days, {zoneLabel(env.timeZone)}.
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" data-testid="snooze-pick-save">
              Snooze
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
