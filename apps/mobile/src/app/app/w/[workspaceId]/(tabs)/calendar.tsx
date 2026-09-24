import {
  addDays,
  addMonths,
  agendaEmptyWords,
  appointmentCount,
  dayHeadingShort,
  localDateOf,
  monthGridOf,
  weekOf,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, View } from 'react-native';

import {
  useAgendaDay,
  useAgendaMonth,
  useAgendaWeek,
  useCalendarRange,
  useCalendarZone,
  useNow,
  type PhoneAppointment,
  type WeekRow,
} from '@/calendar/use-calendar';
import {
  AgendaRow,
  BusyRow,
  DayHeadingRow,
  NowRow,
  TimeZoneProvider,
} from '@/components/calendar/agenda-row';
import { CalendarHeader, type CalendarView } from '@/components/calendar/calendar-header';
import { MonthGrid } from '@/components/calendar/month-grid';
import { NewAppointmentSheet } from '@/components/calendar/new-appointment';
import { CalendarDays, Plus } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';

/** A Calendar that can't draw shows why, and the other tabs still work. */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

/**
 * **Your day, your week and your month** (the canvas's Calendar): the week's date strip over the chosen day as a
 * list, Everyone or Just me, and the red line at the current time — the same three views the web shows at 390 px,
 * read from the phone's own copy so they are there with no signal.
 *
 * Day is one day's list. Week is all seven, each under its own heading, so a glance says which days are full. Month
 * is six whole weeks with a dot per booking, and a day hands itself back to Day when pressed. The arrows walk a week
 * at a time, or a month on the month view, and Today comes back from wherever you are.
 *
 * A time asked for from this phone that HandsFreeOS hasn't confirmed sits in its place on the day, marked "Not booked
 * yet": nobody else's calendar has it, so nobody should ring the customer about it.
 *
 * The lists are virtualized, so a day with fifty visits scrolls as smoothly as one with two.
 */
export default function Calendar() {
  const { business } = useBusiness();
  const { appt } = useLocalSearchParams<{ appt?: string }>();
  const timeZone = useCalendarZone();
  const now = useNow();
  const today = localDateOf(now, timeZone);
  const [view, setView] = React.useState<CalendarView>('day');
  const [date, setDate] = React.useState(today);
  const [mine, setMine] = React.useState(false);
  const [booking, setBooking] = React.useState(false);

  // Day and Week read the week around the date; Month reads its whole six-week grid, the way the web's page does.
  const days = React.useMemo(
    () => (view === 'month' ? monthGridOf(date) : weekOf(date)),
    [view, date],
  );
  const range = useCalendarRange(days, timeZone);
  const day = useAgendaDay(range, date, today, timeZone, mine, now);
  const week = useAgendaWeek(range, date, today, timeZone, mine, now);
  const month = useAgendaMonth(range, date, today, timeZone, mine, now);
  const empty = agendaEmptyWords(mine);

  // A notification or an email link (…/calendar?appt=<id>) opens the appointment itself.
  React.useEffect(() => {
    if (appt) router.push(businessHref(business.id, `calendar/${appt}`) as Href);
  }, [appt, business.id]);

  const open = React.useCallback(
    (a: PhoneAppointment) => router.push(businessHref(business.id, `calendar/${a.id}`) as Href),
    [business.id],
  );

  /** A day picked out of the month or the week list is a day to look at, so it opens the day view on it. */
  const openDay = React.useCallback((d: string) => {
    setDate(d);
    setView('day');
  }, []);

  const step = React.useCallback(
    (delta: number) =>
      setDate((d) => (view === 'month' ? addMonths(d, delta) : addDays(d, delta * 7))),
    [view],
  );

  const renderRow = React.useCallback(
    ({ item }: { item: WeekRow }) => {
      if (item.kind === 'day')
        return (
          <DayHeadingRow
            date={item.date}
            today={today}
            countWords={item.countWords}
            onPress={openDay}
          />
        );
      if (item.kind === 'now') return <NowRow at={item.at} />;
      if (item.kind === 'busy') return <BusyRow busy={item.busy} end={item.end} />;
      return <AgendaRow appt={item.appt as PhoneAppointment} now={now} onPress={open} />;
    },
    [now, open, openDay, today],
  );

  const nothingToday = view === 'day' && day.onDay.length === 0;
  return (
    <TimeZoneProvider value={timeZone}>
      <Screen title="Calendar" testID="calendar" scroll={false}>
        <CalendarHeader
          view={view}
          date={date}
          today={today}
          days={view === 'month' ? weekOf(date) : days}
          marked={day.marked}
          timeZone={timeZone}
          mine={mine}
          onView={setView}
          onStep={step}
          onToday={() => setDate(today)}
          onDate={setDate}
          onMine={setMine}
        />
        {view === 'month' ? (
          <MonthGrid days={month} onDay={openDay} />
        ) : view === 'week' ? (
          <FlatList
            data={week}
            keyExtractor={rowKey}
            renderItem={renderRow}
            initialNumToRender={12}
            windowSize={7}
            contentContainerClassName="pb-24"
            testID="agenda-week"
          />
        ) : (
          <>
            <View className="flex-row items-center justify-between px-4 pb-2 pt-3">
              <Text className="text-[13px] font-medium" testID="calendar-day-heading">
                {dayHeadingShort(date, today, mine)}
              </Text>
              <Text className="text-xs text-text-3" testID="calendar-day-count">
                {appointmentCount(day.onDay.length)}
              </Text>
            </View>
            {nothingToday ? (
              <View className="border-y border-border bg-card px-6 py-11" testID="calendar-empty">
                <View className="mb-3 size-11 items-center justify-center self-center rounded-full bg-card-2">
                  <Icon as={CalendarDays} className="size-5 text-text-3" />
                </View>
                <Text className="text-center text-[15px] font-semibold">{empty.title}</Text>
                <Text className="mt-1 text-center text-[13px] text-text-2">{empty.body}</Text>
                <Button
                  variant="secondary"
                  icon={Plus}
                  className="mt-3.5 self-center"
                  onPress={() => setBooking(true)}
                  testID="calendar-new-empty"
                >
                  {empty.action}
                </Button>
              </View>
            ) : (
              <FlatList
                data={day.rows}
                keyExtractor={rowKey}
                renderItem={renderRow}
                initialNumToRender={12}
                windowSize={7}
                className="border-t border-border"
                contentContainerClassName="pb-24"
                testID="agenda"
              />
            )}
          </>
        )}
        {nothingToday ? null : (
          // Round and icon-only, as the web's own phone layout draws it: a button with words on it covers the row
          // under it, and a day's last row is the one people reach for.
          <Button
            icon={Plus}
            accessibilityLabel={empty.action}
            className="absolute bottom-5 right-4 size-14 rounded-full px-0 shadow"
            onPress={() => setBooking(true)}
            testID="calendar-new"
          />
        )}
        <NewAppointmentSheet
          open={booking}
          onClose={() => setBooking(false)}
          date={date}
          timeZone={timeZone}
          person={null}
        />
      </Screen>
    </TimeZoneProvider>
  );
}

const rowKey = (row: WeekRow): string =>
  row.kind === 'day'
    ? `day-${row.date}`
    : row.kind === 'appt'
      ? row.appt.id
      : row.kind === 'busy'
        ? `busy-${row.at}`
        : 'now';
