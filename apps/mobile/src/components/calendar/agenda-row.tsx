import {
  appointmentChips,
  busyFrom,
  BUSY_TITLE,
  fmtLength,
  fmtTime,
  isNotBookedYet,
  holdOf,
  holdWords,
  isPast,
  nowLabel,
  REQUESTED_LINE,
  rowTimeOf,
  subtitleOf,
  type BusyBlock,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronRight } from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { PhoneAppointment } from '@/calendar/use-calendar';

/** The business's zone, put in place by the Calendar screen so every row reads times the same way. */
const TimeZoneContext = React.createContext('UTC');
export const TimeZoneProvider = TimeZoneContext.Provider;
export const useTimeZone = () => React.useContext(TimeZoneContext);

/**
 * One row of the day, as the canvas draws it: the time and how long it takes down the left, the calendar's colour as a
 * rule, then what it is, who it is for and where, with the people going and any chips under it.
 *
 * A time nobody has been promised — held while a deposit is paid, or asked for from this phone with no signal — wears
 * a striped rule and says so in amber **above everything else on the row**, because the mistake it prevents is
 * somebody ringing the customer to confirm a visit that isn't booked.
 */
export function AgendaRow({
  appt,
  now,
  onPress,
}: {
  appt: PhoneAppointment;
  now: number;
  onPress: (appt: PhoneAppointment) => void;
}) {
  const timeZone = useTimeZone();
  const time = rowTimeOf(appt, timeZone);
  const hold = holdOf(appt, now);
  const unbooked = isNotBookedYet(appt, now);
  const subtitle = subtitleOf(appt);
  const chips = appointmentChips(appt);
  const faded = isPast(appt, now) || appt.status !== 'scheduled';
  // An iPhone reads a button as one thing, so everything that matters is in its label: the time, what it is, who it
  // is for, and — first among the things a person must not miss — that nobody has been promised this time.
  const notBooked = unbooked ? (hold ? holdWords(hold, timeZone) : REQUESTED_LINE) : null;
  const label = [time.at, time.length, appt.title, notBooked, subtitle].filter(Boolean).join(' · ');
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      testID={`agenda-appt-${appt.id}`}
      onPress={() => onPress(appt)}
      className="min-h-16 flex-row items-stretch gap-3 border-b border-border bg-card px-3.5 py-3 active:bg-card-2"
    >
      <View className="w-[66px] flex-none">
        <Text className="text-sm font-semibold leading-[19px]">{time.at}</Text>
        <Text className="text-[12.5px] text-text-3">{time.length}</Text>
      </View>
      <View
        className={cn('w-1 flex-none rounded-full', unbooked ? 'bg-warning-text/50' : '')}
        style={unbooked ? undefined : { backgroundColor: appt.calendarColor }}
      />
      <View className={cn('min-w-0 flex-1 gap-0.5', faded && 'opacity-60')}>
        <Text className="text-[15px] font-semibold" numberOfLines={1}>
          {appt.title}
        </Text>
        {unbooked ? (
          <Text
            className="text-[13px] font-medium text-warning-text"
            testID="agenda-not-booked"
            numberOfLines={2}
          >
            {notBooked}
          </Text>
        ) : null}
        {subtitle ? (
          <Text className="text-[13px] text-text-2" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <View className="mt-[5px] flex-row flex-wrap items-center gap-1.5">
          {appt.staff.length ? (
            <View className="flex-row pr-1">
              {appt.staff.map((s) => (
                <Avatar
                  key={s.userId}
                  name={s.fullName}
                  seed={s.userId}
                  size="sm"
                  className="-mr-1"
                />
              ))}
            </View>
          ) : null}
          {chips.map((chip) => (
            <View key={`${chip.kind}-${chip.label}`} className="rounded-full bg-card-2 px-2 py-0.5">
              <Text className="text-[11.5px] text-text-3">{chip.label}</Text>
            </View>
          ))}
        </View>
      </View>
      <Icon as={ChevronRight} className="size-4 flex-none self-center text-text-3" />
    </Pressable>
  );
}

/** Busy time from this person's own Google or Outlook calendar: when, how long, and where it came from. */
export function BusyRow({ busy, end }: { busy: BusyBlock; end: number }) {
  const timeZone = useTimeZone();
  return (
    <View className="min-h-16 flex-row items-stretch gap-3 border-b border-border bg-card px-3.5 py-3">
      <View className="w-[66px] flex-none">
        <Text className="text-sm font-semibold leading-[19px]">
          {fmtTime(busy.startsAt, timeZone)}
        </Text>
        <Text className="text-[12.5px] text-text-3">
          {fmtLength(Math.round((end - Date.parse(busy.startsAt)) / 60_000))}
        </Text>
      </View>
      <View className="w-1 flex-none rounded-full bg-border-strong" />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[15px] font-semibold text-text-2">{BUSY_TITLE}</Text>
        <Text className="text-[13px] text-text-3">{busyFrom(busy.provider)}</Text>
      </View>
    </View>
  );
}

/** The red line at the current time. */
export function NowRow({ at }: { at: number }) {
  const timeZone = useTimeZone();
  return (
    <View
      className="flex-row items-center gap-2 border-b border-border bg-card px-3.5 py-1.5"
      testID="agenda-now"
    >
      <Text className="text-xs font-semibold text-danger-text">{nowLabel(at, timeZone)}</Text>
      <View className="h-0.5 flex-1 rounded-full bg-danger" />
    </View>
  );
}
