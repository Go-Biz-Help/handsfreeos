import { appointmentCount, fmtDateLong, weekdayShort } from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { MonthDay } from '@/calendar/use-calendar';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** Past three, a cell says how many more: every row of the grid has to stay the same height. */
const DOTS = 3;

/**
 * The month at a glance, as the web draws it on a phone: six whole weeks, a day number and a dot for each booking,
 * with a grey dot for busy time from this person's own calendar. It answers "what is this month like" rather than
 * "when exactly" — a cell is fifty-odd pixels wide — so the whole day hands itself to the day list when pressed.
 */
export function MonthGrid({
  days,
  onDay,
}: {
  days: readonly MonthDay[];
  onDay: (date: string) => void;
}) {
  const heads = days.slice(0, 7);
  return (
    <View className="border-y border-border bg-card" testID="calendar-month">
      <View className="flex-row border-b border-border bg-card-2">
        {heads.map((d) => (
          <View key={d.date} className="flex-1 py-1.5">
            <Text className="text-center text-[11.5px] font-semibold uppercase text-text-3">
              {weekdayShort(d.date)}
            </Text>
          </View>
        ))}
      </View>
      <View className="flex-row flex-wrap">
        {days.map((day, i) => {
          const shown = day.appointments.slice(0, DOTS);
          const rest = day.appointments.length - shown.length;
          return (
            <Pressable
              key={day.date}
              role="button"
              accessibilityLabel={[fmtDateLong(day.date), appointmentCount(day.appointments.length)]
                .filter(Boolean)
                .join(' · ')}
              testID={`month-day-${day.date}`}
              onPress={() => onDay(day.date)}
              className={cn(
                'min-h-[62px] w-[14.285%] items-center gap-1 border-b border-r border-border py-1.5',
                // No rule down the last column: the grid's own edge is already there.
                (i + 1) % 7 === 0 && 'border-r-0',
                !day.inMonth && 'bg-card-2',
              )}
            >
              <View
                className={cn(
                  'h-[22px] min-w-[22px] items-center justify-center rounded-full px-1',
                  day.today && 'bg-accent',
                )}
              >
                <Text
                  className={cn(
                    'text-[12.5px] font-semibold',
                    day.today ? 'text-white' : day.inMonth ? 'text-text' : 'text-text-3',
                  )}
                >
                  {Number(day.date.slice(8))}
                </Text>
              </View>
              <View className="h-[7px] flex-row items-center gap-[3px]">
                {day.busy ? (
                  <View className="size-[5px] rounded-full bg-border-strong" testID="month-busy" />
                ) : null}
                {shown.map((a) => (
                  <View
                    key={a.id}
                    className="size-[5px] rounded-full"
                    style={{ backgroundColor: a.calendarColor }}
                    testID={`month-dot-${a.id}`}
                  />
                ))}
                {rest > 0 ? (
                  <Text className="text-[9px] font-semibold text-text-3">+{rest}</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
