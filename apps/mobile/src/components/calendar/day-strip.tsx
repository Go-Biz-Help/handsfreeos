import { fmtMonthYear, weekdayShort, zoneLabel } from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The week over the day (the canvas's "September 2026 · Central Time", then Sun–Sat). The chosen day is filled, today
 * is coloured, and a day with anything on it carries a dot — the same strip the web's agenda draws at 390 px.
 *
 * Each day is 58 px tall inside a 44 px-wide column, so a thumb never misses.
 */
export function DayStrip({
  days,
  date,
  today,
  marked,
  timeZone,
  onDate,
}: {
  days: readonly string[];
  date: string;
  today: string;
  marked: ReadonlySet<string>;
  timeZone: string;
  onDate: (date: string) => void;
}) {
  return (
    <View className="gap-2 border-b border-border bg-card px-3 pb-3 pt-2.5">
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-[15px] font-semibold">{fmtMonthYear(date)}</Text>
        <Text className="text-xs text-text-3" testID="calendar-zone">
          {zoneLabel(timeZone)}
        </Text>
      </View>
      <View className="flex-row gap-1">
        {days.map((d) => {
          const on = d === date;
          return (
            <Pressable
              key={d}
              role="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${weekdayShort(d)} ${Number(d.slice(8))}`}
              testID={`agenda-day-${d}`}
              onPress={() => onDate(d)}
              className={cn(
                'min-h-[58px] flex-1 items-center gap-[3px] rounded-menu pb-1.5 pt-[7px]',
                on && 'bg-accent',
              )}
            >
              <Text className={cn('text-[11px] font-medium', on ? 'text-white/85' : 'text-text-3')}>
                {weekdayShort(d)}
              </Text>
              <Text
                className={cn(
                  'text-base font-semibold leading-[18px]',
                  on ? 'text-white' : d === today ? 'text-accent-text' : 'text-text',
                )}
              >
                {Number(d.slice(8))}
              </Text>
              <View
                className={cn(
                  'size-[5px] rounded-full',
                  marked.has(d) ? (on ? 'bg-white' : 'bg-accent') : 'bg-transparent',
                )}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
