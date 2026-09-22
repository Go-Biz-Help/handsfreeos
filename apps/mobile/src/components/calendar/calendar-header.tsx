import { fmtMonthYear, fmtWeekRangeShort, zoneLabel } from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronLeft, ChevronRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';

import { DayStrip } from './day-strip';

/**
 * The views a phone gets. Team and Resources are a column per person or per truck, which wants a screen wider than
 * this one, so the phone offers the three that are about one stretch of time — the same three the web shows at 390 px.
 */
export type CalendarView = 'day' | 'week' | 'month';

const VIEWS = [
  { value: 'day', label: 'Day', testID: 'calendar-view-day' },
  { value: 'week', label: 'Week', testID: 'calendar-view-week' },
  { value: 'month', label: 'Month', testID: 'calendar-view-month' },
] as const;

/**
 * Everything over the list: the month (or the week's dates) with an arrow either side, the business's zone, the
 * week's strip on the day view, then Today with Day, Week and Month, and Everyone or Just me.
 *
 * The strip stays second, right under the title, wherever the rest goes: it is what a thumb reaches for.
 */
export function CalendarHeader({
  view,
  date,
  today,
  days,
  marked,
  timeZone,
  mine,
  onView,
  onStep,
  onToday,
  onDate,
  onMine,
}: {
  view: CalendarView;
  date: string;
  today: string;
  /** The week behind the strip; the month view has its own grid under this. */
  days: readonly string[];
  marked: ReadonlySet<string>;
  timeZone: string;
  mine: boolean;
  onView: (view: CalendarView) => void;
  /** A week at a time, or a month of them on the month view. */
  onStep: (delta: number) => void;
  onToday: () => void;
  onDate: (date: string) => void;
  onMine: (mine: boolean) => void;
}) {
  const stepWord = view === 'month' ? 'month' : 'week';
  const title =
    view === 'week' && days.length
      ? fmtWeekRangeShort(days[0]!, days[days.length - 1]!)
      : fmtMonthYear(date);
  return (
    <View className="gap-2 border-b border-border bg-card px-3 pb-3 pt-2.5">
      <View className="flex-row items-center justify-between gap-2 px-1">
        <View className="min-w-0 flex-row items-center gap-0.5">
          <Step label={`Previous ${stepWord}`} testID="calendar-prev" onPress={() => onStep(-1)}>
            <Icon as={ChevronLeft} className="size-[18px] text-text-2" />
          </Step>
          <Text className="text-[15px] font-semibold" numberOfLines={1} testID="calendar-title">
            {title}
          </Text>
          <Step label={`Next ${stepWord}`} testID="calendar-next" onPress={() => onStep(1)}>
            <Icon as={ChevronRight} className="size-[18px] text-text-2" />
          </Step>
        </View>
        <Text className="text-xs text-text-3" testID="calendar-zone">
          {zoneLabel(timeZone)}
        </Text>
      </View>

      {/* The month is its own strip, and the week list names every day, so only the day view needs one. */}
      {view === 'day' ? (
        <DayStrip days={days} date={date} today={today} marked={marked} onDate={onDate} />
      ) : null}

      <View className="flex-row items-center gap-2">
        <Button variant="secondary" size="sm" onPress={onToday} testID="calendar-today">
          Today
        </Button>
        <Segmented<CalendarView>
          label="View"
          className="flex-1"
          value={view}
          onChange={onView}
          options={VIEWS}
        />
      </View>

      <Segmented<'all' | 'mine'>
        label="Whose day"
        value={mine ? 'mine' : 'all'}
        onChange={(v) => onMine(v === 'mine')}
        options={[
          { value: 'all', label: 'Everyone', testID: 'calendar-everyone' },
          { value: 'mine', label: 'Just me', testID: 'calendar-just-me' },
        ]}
      />
    </View>
  );
}

/** An arrow beside the title, with the 44 px of touch a thumb needs around its 32. */
function Step({
  label,
  testID,
  onPress,
  children,
}: {
  label: string;
  testID: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      className="size-8 items-center justify-center rounded-control active:bg-card-2"
    >
      {children}
    </Pressable>
  );
}
