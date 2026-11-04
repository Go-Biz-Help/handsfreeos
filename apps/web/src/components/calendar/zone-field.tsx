'use client';
import { moreZoneChoices, US_TIME_ZONES, zoneChoices, zoneNote, type ZoneChoice } from '@hfos/core';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A time zone select's options: a zone already in play from outside the US first (the calendar's, the one picked),
 * then the US zones, then every other zone under More time zones, by place. `first` adds a row above them all, such
 * as "Same as the business".
 */
export function ZoneOptions({
  calendarZone,
  value,
  first,
}: {
  calendarZone: string;
  value: string;
  first?: ZoneChoice;
}) {
  const top = zoneChoices(calendarZone, value);
  const shown = new Set(top.map((z) => z.id));
  const isUs = (id: string) => US_TIME_ZONES.some((z) => z.id === id);
  const option = (z: ZoneChoice) => (
    <option key={z.id} value={z.id}>
      {z.label}
    </option>
  );
  return (
    <>
      {first ? option(first) : null}
      {top.filter((z) => !isUs(z.id)).map(option)}
      <optgroup label="United States">{top.filter((z) => isUs(z.id)).map(option)}</optgroup>
      <optgroup label="More time zones">
        {moreZoneChoices()
          .filter((z) => !shown.has(z.id))
          .map(option)}
      </optgroup>
    </>
  );
}

/**
 * Time zone, under the Date and Start of a time being set (Book, Reschedule, New webinar): the time above is read on
 * this zone's clock. It starts on the calendar's zone; on another one the line beside it says where the time lands on
 * the calendar, which keeps showing the business's zone (core `zone-pick.ts`). Laid out on the same three columns as
 * the Date, Start and Length row above it, so the pick sits under Date.
 */
export function ZoneField({
  id,
  value,
  onChange,
  calendarZone,
  at,
  testId,
}: {
  id: string;
  value: string;
  onChange: (zone: string) => void;
  /** The zone the calendar shows, which the pick starts on. */
  calendarZone: string;
  /** The moment the date and time above make, for the line beside the pick. */
  at: number;
  testId: string;
}) {
  const note = zoneNote(at, value, calendarZone);
  return (
    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] items-end gap-2.5">
      <Field label="Time zone" htmlFor={id} className="min-w-0">
        <Select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        >
          <ZoneOptions calendarZone={calendarZone} value={value} />
        </Select>
      </Field>
      <p
        aria-live="polite"
        className={cn(
          'col-span-2 pb-2.5 text-[12.5px] leading-[1.45]',
          note ? 'font-medium text-text-2' : 'text-text-3',
        )}
        data-testid={`${testId}-note`}
      >
        {note ?? 'Your calendar’s zone. Pick another to set the time on its clock.'}
      </p>
    </div>
  );
}

/**
 * Time zone under a task's due time, a lead's next action or Snooze until (owner's pick 1a, 2026-11-03): the date and
 * time above are read on this zone's clock. It starts on the business's zone, which those times are shown in, not on
 * this computer's; on another one the line under it says where the time lands for the business.
 */
export function ZonePick({
  id,
  value,
  onChange,
  businessZone,
  at,
  testId,
  className,
}: {
  id: string;
  value: string;
  onChange: (zone: string) => void;
  /** The business's zone (`useBusinessZone`), which the pick starts on. */
  businessZone: string;
  /** The moment the date and time above make, or null while they don't make one yet. */
  at: number | null;
  testId: string;
  className?: string;
}) {
  const note = at === null ? null : zoneNote(at, value, businessZone, 'for the business');
  return (
    <Field label="Time zone" htmlFor={id} className={className}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        <ZoneOptions calendarZone={businessZone} value={value} />
      </Select>
      <p
        aria-live="polite"
        className={cn(
          'mt-1.5 text-[12.5px] leading-[1.45]',
          note ? 'font-medium text-text-2' : 'text-text-3',
        )}
        data-testid={`${testId}-note`}
      >
        {note ?? 'Your business’s zone. Pick another to set the time on its clock.'}
      </p>
    </Field>
  );
}
